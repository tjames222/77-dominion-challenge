// Server-only delivery adapter. The caller must load an immutable, persisted
// feedback job; this is not an authenticated intake or a browser API.
const ENDPOINT = "https://api.linear.app/graphql";
export const FEEDBACK_LINEAR_MAX_DESCRIPTION = 65536;
export const FEEDBACK_LINEAR_MAX_REQUEST_BYTES = 131072;
export const FEEDBACK_LINEAR_TEAM = "f61599d3-1342-430f-855e-2d3bc574a94b";
export const FEEDBACK_LINEAR_PROJECT = "d9c1d9b7-b35b-4da5-9a9e-be384e06bd2b";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fields = "id url description team { id } project { id }";
const lookupQuery = `query FeedbackDelivery($id: ID!) {
  issues(first: 2, includeArchived: true, filter: { id: { eq: $id } }) {
    nodes { ${fields} }
  }
}`;
const createQuery =
  `mutation FeedbackDeliveryCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${fields} } }
}`;

export type FeedbackLinearJob = {
  // Generated once by the durable outbox, never regenerated on transport retry.
  issueId: string;
  feedbackId: string;
  title: string;
  description: string;
  priority: 0 | 1 | 2 | 3 | 4;
  // Resolved from the operator-approved existing taxonomy, never client input.
  labelIds: readonly string[];
};

export type FeedbackLinearOutcome =
  | { state: "delivered"; issueId: string; issueUrl: string }
  | {
    state: "retryable" | "uncertain" | "needs_review";
    code:
      | "lookup_unavailable"
      | "dispatch_not_owned"
      | "dispatch_unconfirmed"
      | "delivery_unconfirmed"
      | "receipt_mismatch";
  };

type Options = {
  apiKey: string;
  // Once a send might have started, reconciliation must not create again.
  mode: "create" | "reconcile";
  // Must atomically persist the dispatched state under the current worker lease
  // BEFORE resolving true. A crash after this fence requires reconciliation.
  markDispatched: (signal: AbortSignal) => Promise<boolean>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateJob(job: FeedbackLinearJob, options: Options) {
  if (
    !job || !UUID.test(job.issueId) || !UUID.test(job.feedbackId) ||
    typeof job.title !== "string" || job.title.trim().length === 0 ||
    job.title.length > 160 || /[\r\n\u0000]/.test(job.title) ||
    typeof job.description !== "string" || !job.description.trim() ||
    job.description.length > FEEDBACK_LINEAR_MAX_DESCRIPTION ||
    job.description.includes("\u0000") ||
    !Number.isInteger(job.priority) || job.priority < 0 || job.priority > 4 ||
    !Array.isArray(job.labelIds) || job.labelIds.length === 0 ||
    job.labelIds.length > 8 || job.labelIds.some((id) => !UUID.test(id)) ||
    new Set(job.labelIds).size !== job.labelIds.length ||
    typeof options.apiKey !== "string" || !options.apiKey.trim() ||
    /[\r\n]/.test(options.apiKey) ||
    !["create", "reconcile"].includes(options.mode) ||
    typeof options.markDispatched !== "function"
  ) throw new TypeError("Invalid feedback delivery configuration.");
}

async function deliveryMarker(job: FeedbackLinearJob) {
  const bytes = new TextEncoder().encode(JSON.stringify([
    "dominion-feedback-linear-v1",
    job.feedbackId,
    job.issueId,
    FEEDBACK_LINEAR_TEAM,
    FEEDBACK_LINEAR_PROJECT,
    job.title,
    job.description,
    job.priority,
    [...job.labelIds].sort(),
  ]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `Dominion feedback receipt: ${job.feedbackId}\nDelivery fingerprint: ${hex}`;
}

function receipt(
  value: unknown,
  job: FeedbackLinearJob,
  marker: string,
): FeedbackLinearOutcome {
  const issue = record(value);
  let url: URL;
  try {
    url = new URL(typeof issue?.url === "string" ? issue.url : "");
  } catch {
    return { state: "needs_review", code: "receipt_mismatch" };
  }
  if (
    issue?.id !== job.issueId ||
    record(issue.team)?.id !== FEEDBACK_LINEAR_TEAM ||
    record(issue.project)?.id !== FEEDBACK_LINEAR_PROJECT ||
    typeof issue.description !== "string" ||
    !issue.description.endsWith(`\n\n${marker}`) ||
    url.origin !== "https://linear.app" || url.username || url.password ||
    url.search || url.hash ||
    !/^\/[^/]+\/issue\/[^/]+(?:\/[^/]+)?$/.test(url.pathname)
  ) return { state: "needs_review", code: "receipt_mismatch" };
  return { state: "delivered", issueId: job.issueId, issueUrl: url.href };
}

function untilAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function graphql(
  query: string,
  variables: Record<string, unknown>,
  options: Options,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 10000);
  try {
    if (controller.signal.aborted) return null;
    const response = await untilAbort(
      (options.fetcher || fetch)(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: options.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      }),
      controller.signal,
    );
    if (!response?.ok || !response.body || controller.signal.aborted) {
      return null;
    }
    // Bound even a chunked response. Neither raw provider bodies nor errors are
    // returned or logged; they can contain user text and credentials.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await untilAbort(reader.read(), controller.signal);
        if (!chunk) return null;
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 131072) {
          return null;
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const payload = record(JSON.parse(body));
    // An HTTP 200 with GraphQL errors is not successful delivery evidence.
    if (
      !payload || (payload.errors !== undefined &&
        (!Array.isArray(payload.errors) || payload.errors.length !== 0))
    ) return null;
    return record(payload.data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function findIssue(job: FeedbackLinearJob, options: Options) {
  const data = await graphql(lookupQuery, { id: job.issueId }, options);
  const nodes = record(data?.issues)?.nodes;
  if (!Array.isArray(nodes) || nodes.length > 1) return undefined;
  if (nodes.length === 0) return null;
  return record(nodes[0]) || undefined;
}

function dispatchFence(options: Options): Promise<boolean | null> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let finished = false;
    const finish = (result: boolean | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
      resolve(result);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, 10000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) return finish(null);
    Promise.resolve().then(() => options.markDispatched(controller.signal))
      .then((value) =>
        finish(value === true ? true : value === false ? false : null)
      )
      .catch(() => finish(null));
  });
}

export async function deliverFeedbackIssue(
  job: FeedbackLinearJob,
  options: Options,
): Promise<FeedbackLinearOutcome> {
  validateJob(job, options);
  job = { ...job, labelIds: [...job.labelIds] };
  options = { ...options };
  const marker = await deliveryMarker(job);
  const createVariables = {
    input: {
      id: job.issueId,
      teamId: FEEDBACK_LINEAR_TEAM,
      projectId: FEEDBACK_LINEAR_PROJECT,
      title: job.title,
      description: `${job.description}\n\n${marker}`,
      priority: job.priority,
      labelIds: [...job.labelIds],
      useDefaultTemplate: false,
    },
  };
  if (
    new TextEncoder().encode(
      JSON.stringify({ query: createQuery, variables: createVariables }),
    ).byteLength > FEEDBACK_LINEAR_MAX_REQUEST_BYTES
  ) throw new TypeError("Invalid feedback delivery configuration.");
  const existing = await findIssue(job, options);
  if (existing === undefined) {
    return { state: "retryable", code: "lookup_unavailable" };
  }
  if (existing !== null) return receipt(existing, job, marker);
  if (options.mode === "reconcile") {
    return { state: "uncertain", code: "delivery_unconfirmed" };
  }
  const owned = await dispatchFence(options);
  if (owned === null || options.signal?.aborted) {
    return { state: "uncertain", code: "dispatch_unconfirmed" };
  }
  if (owned !== true) {
    return { state: "retryable", code: "dispatch_not_owned" };
  }
  const data = await graphql(createQuery, createVariables, options);
  const created = record(data?.issueCreate);
  if (created?.success === true && created.issue) {
    return receipt(created.issue, job, marker);
  }
  // A timeout, malformed response or error can follow a successful mutation.
  // Reconcile the ORIGINAL UUID; never generate another one or blindly resend.
  const recovered = await findIssue(job, options);
  return recovered === undefined || recovered === null
    ? { state: "uncertain", code: "delivery_unconfirmed" }
    : receipt(recovered, job, marker);
}
