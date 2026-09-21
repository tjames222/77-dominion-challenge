import { assert, assertEquals } from "./test_helpers.ts";
import {
  deliverFeedbackIssue,
  FEEDBACK_LINEAR_PROJECT,
  FEEDBACK_LINEAR_TEAM,
  type FeedbackLinearJob,
} from "./feedback_linear.ts";

const job: FeedbackLinearJob = {
  issueId: "00000000-0000-4000-8000-000000000001",
  feedbackId: "00000000-0000-4000-8000-000000000002",
  title: "[Bug] Navigation overlaps a button",
  description: "Original feedback\n\n```text\nPlease keep this verbatim.\n```",
  priority: 3,
  labelIds: ["00000000-0000-4000-8000-000000000003"],
};
const apiKey = "synthetic-key-never-a-real-credential";
const issueUrl = "https://linear.app/bbac/issue/FOU-9999/synthetic-feedback";
const json = (data: unknown) => new Response(JSON.stringify({ data }));

function provider() {
  const state = {
    issue: null as Record<string, unknown> | null,
    calls: [] as Array<{ query: string; variables: Record<string, unknown> }>,
    creates: 0,
    fences: 0,
    loseReply: false,
    acceptCreate: true,
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assertEquals(url, "https://api.linear.app/graphql");
    assertEquals(init?.redirect, "error");
    assertEquals(new Headers(init?.headers).get("Authorization"), apiKey);
    const body = JSON.parse(String(init?.body));
    state.calls.push(body);
    if (body.query.startsWith("query")) {
      assert(body.query.includes("includeArchived: true"));
      assertEquals(body.variables.id, job.issueId);
      return json({ issues: { nodes: state.issue ? [state.issue] : [] } });
    }
    state.creates++;
    assertEquals(state.fences, 1);
    const input = body.variables.input;
    assertEquals(input.id, job.issueId);
    assertEquals(input.teamId, FEEDBACK_LINEAR_TEAM);
    assertEquals(input.projectId, FEEDBACK_LINEAR_PROJECT);
    assertEquals(input.useDefaultTemplate, false);
    if (state.acceptCreate) {
      state.issue = {
        id: input.id,
        url: issueUrl,
        description: input.description,
        team: { id: input.teamId },
        project: { id: input.projectId },
      };
    }
    if (state.loseReply) throw new Error("PRIVATE_PROVIDER_ERROR_SENTINEL");
    return json({ issueCreate: { success: true, issue: state.issue } });
  }) as typeof fetch;
  const options = {
    apiKey,
    mode: "create" as "create" | "reconcile",
    fetcher,
    markDispatched: () => {
      state.fences++;
      return Promise.resolve(true);
    },
  };
  return { state, options };
}

Deno.test("Linear feedback uses fixed project, persisted ID and a durable dispatch fence", async () => {
  const { state, options } = provider();
  assertEquals(await deliverFeedbackIssue(job, options), {
    state: "delivered",
    issueId: job.issueId,
    issueUrl,
  });
  assertEquals(state.creates, 1);
  assertEquals(state.fences, 1);
  assertEquals(state.calls.length, 2);
  const input = state.calls[1].variables.input as Record<string, unknown>;
  assertEquals(input.labelIds, job.labelIds);
  assert(String(input.description).startsWith(job.description + "\n\n"));
  assert(
    String(input.description).includes(
      `Dominion feedback receipt: ${job.feedbackId}`,
    ),
  );
  assert(/Delivery fingerprint: [a-f0-9]{64}$/.test(String(input.description)));
  options.mode = "reconcile";
  assertEquals((await deliverFeedbackIssue(job, options)).state, "delivered");
  assertEquals(state.creates, 1);
  assertEquals(state.fences, 1);
});

Deno.test("accepted mutation with lost reply recovers the original issue without a second create", async () => {
  const { state, options } = provider();
  state.loseReply = true;
  assertEquals((await deliverFeedbackIssue(job, options)).state, "delivered");
  assertEquals(state.creates, 1);
  assertEquals(state.calls.length, 3);
});

Deno.test("unknown send with no visible receipt remains uncertain and reconciliation never sends", async () => {
  const { state, options } = provider();
  state.loseReply = true;
  state.acceptCreate = false;
  assertEquals(await deliverFeedbackIssue(job, options), {
    state: "uncertain",
    code: "delivery_unconfirmed",
  });
  options.mode = "reconcile";
  assertEquals(await deliverFeedbackIssue(job, options), {
    state: "uncertain",
    code: "delivery_unconfirmed",
  });
  assertEquals(state.creates, 1);
  assertEquals(state.fences, 1);
});

Deno.test("a GraphQL partial error is not successful lookup evidence", async () => {
  let fenced = false;
  const outcome = await deliverFeedbackIssue(job, {
    apiKey,
    mode: "create",
    markDispatched: () => {
      fenced = true;
      return Promise.resolve(true);
    },
    fetcher: () =>
      Promise.resolve(
        new Response(JSON.stringify({
          data: { issues: { nodes: [] } },
          errors: [{ message: "PRIVATE_PROVIDER_ERROR_SENTINEL" }],
        })),
      ),
  });
  assertEquals(outcome, { state: "retryable", code: "lookup_unavailable" });
  assertEquals(fenced, false);
  assert(!JSON.stringify(outcome).includes("PRIVATE_PROVIDER_ERROR_SENTINEL"));
});

Deno.test("lost or refused dispatch-fence replies never send to Linear", async () => {
  for (const throws of [false, true]) {
    const { state, options } = provider();
    options.markDispatched = () =>
      throws
        ? Promise.reject(new Error("DATABASE_SECRET_SENTINEL"))
        : Promise.resolve(false);
    assertEquals(await deliverFeedbackIssue(job, options), {
      state: throws ? "uncertain" : "retryable",
      code: throws ? "dispatch_unconfirmed" : "dispatch_not_owned",
    });
    assertEquals(state.creates, 0);
  }
});

Deno.test("reconciliation rejects wrong identity, destination, marker and unsafe URLs", async () => {
  const { state, options } = provider();
  await deliverFeedbackIssue(job, options);
  const valid = { ...state.issue };
  options.mode = "reconcile";
  const bad = [
    { id: job.feedbackId },
    { team: { id: job.feedbackId } },
    { project: { id: job.feedbackId } },
    { description: job.description },
    { description: String(valid.description) + " edited marker" },
    { url: "http://linear.app/bbac/issue/FOU-9999" },
    { url: "https://linear.app.attacker.invalid/bbac/issue/FOU-9999" },
    { url: "https://secret@linear.app/bbac/issue/FOU-9999" },
    { url: "https://linear.app/bbac/issue/FOU-9999?token=secret" },
    { url: "https://linear.app/settings" },
  ];
  for (const change of bad) {
    state.issue = { ...valid, ...change };
    assertEquals(await deliverFeedbackIssue(job, options), {
      state: "needs_review",
      code: "receipt_mismatch",
    });
  }
  assertEquals(state.creates, 1);
});

Deno.test("changing an already-delivered payload does not create or overwrite another issue", async () => {
  const { state, options } = provider();
  await deliverFeedbackIssue(job, options);
  assertEquals(
    await deliverFeedbackIssue({ ...job, description: "Changed" }, options),
    {
      state: "needs_review",
      code: "receipt_mismatch",
    },
  );
  assertEquals(state.creates, 1);
});

Deno.test("job and options are snapshotted before asynchronous work", async () => {
  const { state, options } = provider();
  const mutable = { ...job, labelIds: [...job.labelIds] };
  const pending = deliverFeedbackIssue(mutable, options);
  mutable.title = "Changed after dispatch";
  mutable.description = "Different feedback";
  mutable.labelIds[0] = job.feedbackId;
  options.mode = "reconcile";
  options.apiKey = "different-key";
  assertEquals((await pending).state, "delivered");
  const input = state.calls[1].variables.input as Record<string, unknown>;
  assertEquals(input.title, job.title);
  assertEquals(input.labelIds, job.labelIds);
});

Deno.test("abort before dispatch performs neither lookup nor creation", async () => {
  const { state, options } = provider();
  const controller = new AbortController();
  controller.abort();
  assertEquals(
    await deliverFeedbackIssue(job, { ...options, signal: controller.signal }),
    {
      state: "retryable",
      code: "lookup_unavailable",
    },
  );
  assertEquals(state.calls.length, 0);
  assertEquals(state.fences, 0);
});

Deno.test("invalid job/configuration fails before any network call", async () => {
  const variants: Array<Partial<FeedbackLinearJob>> = [
    { issueId: "caller-supplied-route" },
    { feedbackId: "" },
    { title: "\nheader injection" },
    { title: "x".repeat(161) },
    { description: " " },
    { description: "x".repeat(20001) },
    { priority: 8 as 0 },
    { labelIds: [] },
    { labelIds: [job.issueId, job.issueId] },
  ];
  for (const variant of variants) {
    const { state, options } = provider();
    let failed = false;
    try {
      await deliverFeedbackIssue({ ...job, ...variant }, options);
    } catch (error) {
      assert(error instanceof TypeError);
      assertEquals(error.message, "Invalid feedback delivery configuration.");
      failed = true;
    }
    assert(failed);
    assertEquals(state.calls.length, 0);
  }
});

Deno.test("oversized, invalid and unavailable provider responses remain safe", async () => {
  for (
    const response of [
      new Response("x".repeat(131073)),
      new Response("<html>not JSON</html>"),
      new Response("private provider body", { status: 429 }),
      json({ issues: { nodes: [{}, {}] } }),
      json({ issues: { nodes: [null] } }),
      json({ issues: { nodes: [false] } }),
      json({ issues: { nodes: ["not an issue"] } }),
      json({ issues: {} }),
    ]
  ) {
    const { state, options } = provider();
    options.fetcher = () => Promise.resolve(response);
    assertEquals(await deliverFeedbackIssue(job, options), {
      state: "retryable",
      code: "lookup_unavailable",
    });
    assertEquals(state.fences, 0);
  }
});

Deno.test("only the boolean true authorizes dispatch and malformed fence replies are uncertain", async () => {
  const { state, options } = provider();
  options.markDispatched = () => Promise.resolve("false" as unknown as boolean);
  assertEquals(await deliverFeedbackIssue(job, options), {
    state: "uncertain",
    code: "dispatch_unconfirmed",
  });
  assertEquals(state.creates, 0);
});

Deno.test("abort during dispatch persistence fences a late successful callback", async () => {
  const { state, options } = provider();
  const controller = new AbortController();
  let complete: (value: boolean) => void = () => {};
  options.markDispatched = () => {
    controller.abort();
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  assertEquals(
    await deliverFeedbackIssue(job, { ...options, signal: controller.signal }),
    {
      state: "uncertain",
      code: "dispatch_unconfirmed",
    },
  );
  complete(true);
  await Promise.resolve();
  assertEquals(state.creates, 0);
});

Deno.test("dispatch persistence has a bounded deadline even if the callback never resolves", async () => {
  const { state, options } = provider();
  options.markDispatched = () => new Promise(() => {});
  assertEquals(await deliverFeedbackIssue(job, options), {
    state: "uncertain",
    code: "dispatch_unconfirmed",
  });
  assertEquals(state.creates, 0);
});

Deno.test("abort bounds a stalled chunked response without exposing partial provider data", async () => {
  const { state, options } = provider();
  const controller = new AbortController();
  let cancelled = false;
  options.fetcher = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode("PRIVATE_PROVIDER_SENTINEL"),
            );
            setTimeout(() => controller.abort(), 5);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
  const result = await deliverFeedbackIssue(job, {
    ...options,
    signal: controller.signal,
  });
  assertEquals(result, { state: "retryable", code: "lookup_unavailable" });
  assertEquals(state.fences, 0);
  assert(!JSON.stringify(result).includes("PRIVATE_PROVIDER_SENTINEL"));
  assertEquals(cancelled, true);
});

Deno.test("unavailable reconciliation never reaches a dispatch fence", async () => {
  const { state, options } = provider();
  options.mode = "reconcile";
  options.fetcher = () =>
    Promise.reject(new Error("PRIVATE_PROVIDER_SENTINEL"));
  assertEquals(await deliverFeedbackIssue(job, options), {
    state: "retryable",
    code: "lookup_unavailable",
  });
  assertEquals(state.fences, 0);
  assertEquals(state.creates, 0);
});

Deno.test("stage deadlines bound stalled fetch and chunked body without caller intervention", async () => {
  await Promise.all(["fetch", "body"].map(async (stage) => {
    const { state, options } = provider();
    let cancelled = false;
    options.fetcher = () =>
      stage === "fetch" ? new Promise(() => {}) : Promise.resolve(
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"data":'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    assertEquals(await deliverFeedbackIssue(job, options), {
      state: "retryable",
      code: "lookup_unavailable",
    });
    assertEquals(state.fences, 0);
    if (stage === "body") assertEquals(cancelled, true);
  }));
});
