import { createAdminClient } from "../_shared/supabase.ts";
import { type EnvReader, readEnv } from "../_shared/http.ts";
import {
  deliverFeedbackIssue,
  type FeedbackLinearJob,
} from "../_shared/feedback_linear.ts";
import {
  deliverTransactionalEmail,
  type TransactionalEmailDispatchReceipt,
  transactionalEmailFingerprint,
  type TransactionalEmailMessage,
} from "../_shared/transactional_email.ts";
import {
  renderFeedbackLinearJob,
  renderFeedbackSupportEmail,
} from "../_shared/feedback_event_renderer.ts";
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";

type Rpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
type Dependencies = {
  env: EnvReader;
  rpc: Rpc;
  fetcher: typeof fetch;
  randomUuid: () => string;
  rpcTimeoutMs: number;
  now: () => number;
};
type RecordValue = Record<string, unknown>;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is RecordValue =>
  Boolean(
    value && typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
const exact = (value: unknown, keys: string[]): value is RecordValue =>
  record(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
class DatabaseUnavailable extends Error {
  constructor() {
    super("Feedback database request unavailable.");
  }
}
function immutable(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (
    record(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string")
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, immutable(entry)]),
      ),
    );
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  throw new Error("Invalid feedback binding.");
}
function configuredSender(value: string) {
  const mailbox =
    /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}) <([^<>]+)>$/.exec(value)?.[2] ||
    value;
  return mailbox.length <= 254 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
      .test(mailbox);
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "Pragma": "no-cache",
    },
  });
}
async function equalSecret(a: string, b: string) {
  if (a.length < 32 || a.length > 512 || !b || b.length > 512) return false;
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [left, right] = (await Promise.all([digest(a), digest(b)])).map(
    (value) => new Uint8Array(value),
  );
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
async function linearFingerprint(payload: unknown) {
  const bytes = new TextEncoder().encode(canonical(payload));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
async function boundedRpc(
  dependencies: Dependencies,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () =>
      reject(new Error("Feedback database request unavailable."));
  });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(abort, dependencies.rpcTimeoutMs);
  try {
    if (controller.signal.aborted) {
      throw new Error("Feedback database request unavailable.");
    }
    return await Promise.race([
      dependencies.rpc(name, args, controller.signal),
      cancelled,
    ]);
  } catch {
    throw new DatabaseUnavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}
function claim(value: unknown, provider: string) {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Invalid feedback claim.");
  }
  if (!value.length) return null;
  const job = value[0];
  if (
    !exact(job, [
      "deliveryId",
      "provider",
      "firstDispatchedAt",
      "payload",
      "bindingFingerprint",
      "feedback",
      "linear",
    ]) ||
    typeof job.deliveryId !== "string" || !uuid.test(job.deliveryId) ||
    job.provider !== provider ||
    !(job.firstDispatchedAt === null ||
      (typeof job.firstDispatchedAt === "string" &&
        Number.isFinite(Date.parse(job.firstDispatchedAt)))) ||
    !(job.payload === null || record(job.payload)) ||
    (job.payload === null) !== (job.bindingFingerprint === null) ||
    (job.firstDispatchedAt !== null && job.payload === null) ||
    !(job.bindingFingerprint === null ||
      (typeof job.bindingFingerprint === "string" &&
        hash.test(job.bindingFingerprint)))
  ) throw new Error("Invalid feedback claim.");
  return immutable(job) as RecordValue;
}

async function processProvider(
  provider: "linear" | "email",
  worker: string,
  dependencies: Dependencies,
  signal: AbortSignal,
) {
  const raw = await boundedRpc(
    dependencies,
    "claim_early_access_feedback_deliveries",
    {
      target_worker_token: worker,
      target_provider: provider,
      target_batch_size: 1,
    },
    signal,
  );
  const job = claim(raw, provider);
  if (!job) return "empty";
  const common = {
    target_delivery_id: job.deliveryId,
    target_worker_token: worker,
  };
  let outcome: {
    state: string;
    code?: string;
    issueId?: string;
    issueUrl?: string;
    emailId?: string;
  };
  try {
    // Validate canonical source even when consuming a previously frozen payload.
    const renderedLinear = renderFeedbackLinearJob(job.feedback as never);
    let payload: RecordValue;
    let fingerprint: string;
    const idempotencyKey = `dominion-feedback/${job.deliveryId}`;
    if (provider === "linear") {
      payload = job.payload === null
        ? { job: renderedLinear }
        : job.payload as RecordValue;
      if (
        !exact(payload, ["job"]) || !record(payload.job) ||
        payload.job.feedbackId !== renderedLinear.feedbackId ||
        payload.job.issueId !== renderedLinear.issueId
      ) throw new Error("Invalid feedback binding.");
      fingerprint = await linearFingerprint(payload);
    } else {
      payload = job.payload === null
        ? {
          message: renderFeedbackSupportEmail(job.feedback as never, {
            from: dependencies.env("TRANSACTIONAL_EMAIL_FROM") || "",
            linear: job.linear as never,
          }),
        }
        : job.payload as RecordValue;
      if (
        !exact(payload, ["message"]) || !record(payload.message) ||
        payload.message.to !== SUPPORT_EMAIL ||
        payload.message.from !== dependencies.env("TRANSACTIONAL_EMAIL_FROM")
      ) throw new Error("Invalid feedback binding.");
      fingerprint = await transactionalEmailFingerprint({
        deliveryId: job.deliveryId as string,
        idempotencyKey,
        message: payload.message as TransactionalEmailMessage,
      });
    }
    if (
      job.bindingFingerprint !== null && job.bindingFingerprint !== fingerprint
    ) throw new Error("Invalid feedback binding.");
    payload = immutable(payload) as RecordValue;
    const bound = await boundedRpc(
      dependencies,
      "bind_early_access_feedback_delivery",
      {
        ...common,
        target_payload: payload,
        target_binding_fingerprint: fingerprint,
      },
      signal,
    );
    if (bound !== true) return "lease_lost";
    if (provider === "linear") {
      outcome = await deliverFeedbackIssue(payload.job as FeedbackLinearJob, {
        apiKey: dependencies.env("LINEAR_FEEDBACK_API_KEY") || "",
        fetcher: dependencies.fetcher,
        signal,
        mode: job.firstDispatchedAt === null ? "create" : "reconcile",
        markDispatched: async (signal) => {
          const receipt = await boundedRpc(
            dependencies,
            "mark_early_access_feedback_dispatched",
            {
              ...common,
              target_binding_fingerprint: fingerprint,
            },
            signal,
          );
          if (receipt === null) return false;
          const verified = exact(receipt, [
            "deliveryId",
            "idempotencyKey",
            "bindingFingerprint",
            "firstDispatchedAt",
          ]) &&
            receipt.deliveryId === job.deliveryId &&
            receipt.idempotencyKey === idempotencyKey &&
            receipt.bindingFingerprint === fingerprint &&
            typeof receipt.firstDispatchedAt === "string" &&
            Number.isFinite(Date.parse(receipt.firstDispatchedAt));
          if (!verified) throw new DatabaseUnavailable();
          return true;
        },
      });
    } else {
      outcome = await deliverTransactionalEmail({
        deliveryId: job.deliveryId as string,
        idempotencyKey,
        bindingFingerprint: fingerprint,
        firstDispatchedAt: job.firstDispatchedAt as string | null,
        message: payload.message as TransactionalEmailMessage,
      }, {
        apiKey: dependencies.env("RESEND_API_KEY") || "",
        fetcher: dependencies.fetcher,
        signal,
        now: dependencies.now,
        markDispatched: async (_binding, signal) =>
          await boundedRpc(
            dependencies,
            "mark_early_access_feedback_dispatched",
            {
              ...common,
              target_binding_fingerprint: fingerprint,
            },
            signal,
          ) as TransactionalEmailDispatchReceipt | null,
      });
    }
  } catch (error) {
    // Validation failures stay visible for an operator. Never include payloads,
    // auth values, provider bodies, email addresses or exception strings in logs.
    outcome = error instanceof DatabaseUnavailable
      ? { state: "uncertain", code: "worker_database_unavailable" }
      : { state: "needs_review", code: "worker_delivery_unavailable" };
  }
  const settled = await boundedRpc(
    dependencies,
    "settle_early_access_feedback_delivery",
    {
      ...common,
      target_outcome: outcome.state,
      target_code: outcome.code || null,
      target_receipt_id: outcome.issueId || outcome.emailId || null,
      target_issue_url: outcome.issueUrl || null,
    },
    signal,
  );
  return settled === true ? outcome.state : "lease_lost";
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: readEnv,
    fetcher: fetch,
    randomUuid: () => crypto.randomUUID(),
    rpcTimeoutMs: 10000,
    now: Date.now,
    rpc: async (name, args, signal) => {
      const { data, error } = await createAdminClient().rpc(name, args)
        .abortSignal(signal);
      if (error) throw new Error("Feedback database request unavailable.");
      return data;
    },
    ...overrides,
  };
  if (
    !Number.isInteger(dependencies.rpcTimeoutMs) ||
    dependencies.rpcTimeoutMs < 1 || dependencies.rpcTimeoutMs > 10000
  ) throw new TypeError("Invalid feedback worker configuration.");
  return async (request: Request) => {
    if (request.method !== "POST") {
      return response({ error: "Method not allowed." }, 405);
    }
    if (
      !await equalSecret(
        dependencies.env("FEEDBACK_WORKER_SECRET") || "",
        request.headers.get("x-dominion-worker-key") || "",
      )
    ) return response({ error: "Unauthorized." }, 401);
    // No browser/user-selected delivery IDs, destinations, bodies or redrives.
    // One item per provider bounds each invocation, with separate durable retry.
    const settings: Record<string, string> = {
      LINEAR_FEEDBACK_API_KEY: dependencies.env("LINEAR_FEEDBACK_API_KEY") ||
        "",
      RESEND_API_KEY: dependencies.env("RESEND_API_KEY") || "",
      TRANSACTIONAL_EMAIL_FROM: dependencies.env("TRANSACTIONAL_EMAIL_FROM") ||
        "",
    };
    if (
      !/^[\x21-\x7e]{1,512}$/.test(settings.LINEAR_FEEDBACK_API_KEY) ||
      !/^re_[A-Za-z0-9_-]{1,250}$/.test(settings.RESEND_API_KEY) ||
      !configuredSender(settings.TRANSACTIONAL_EMAIL_FROM)
    ) {
      return response({ error: "Feedback delivery is not configured." }, 503);
    }
    try {
      const worker = dependencies.randomUuid();
      if (typeof worker !== "string" || !uuid.test(worker)) {
        throw new Error("Worker identity unavailable.");
      }
      const configured = {
        ...dependencies,
        env: (name: string) => settings[name],
      };
      const results: Record<string, string> = {};
      for (const provider of ["linear", "email"] as const) {
        try {
          results[provider] = await processProvider(
            provider,
            worker,
            configured,
            request.signal,
          );
        } catch {
          results[provider] = "unavailable";
        }
      }
      return response(
        results,
        Object.values(results).includes("unavailable") ? 503 : 200,
      );
    } catch {
      return response({ error: "Feedback delivery worker unavailable." }, 503);
    }
  };
}
export const handler = createHandler();
if (import.meta.main) Deno.serve(handler);
