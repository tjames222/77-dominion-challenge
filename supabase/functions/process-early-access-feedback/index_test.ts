import { assert, assertEquals } from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";
import { transactionalEmailFingerprint } from "../_shared/transactional_email.ts";
import { renderFeedbackSupportEmail } from "../_shared/feedback_event_renderer.ts";
import {
  FEEDBACK_LINEAR_PROJECT,
  FEEDBACK_LINEAR_TEAM,
} from "../_shared/feedback_linear.ts";
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";

const secret = "fixture-worker-secret-at-least-32-characters";
const workerId = "44444444-4444-4444-8444-444444444444";
const feedbackId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const linearId = "55555555-5555-4555-8555-555555555555";
const emailDeliveryId = "66666666-6666-4666-8666-666666666666";
const emailReceiptId = "77777777-7777-4777-8777-777777777777";
const issueUrl = "https://linear.app/bbac/issue/FOU-9999/fixture-feedback";
const sender = "Dominion <support@example.test>";
const clock = Date.parse("2026-09-22T00:00:00.000Z");
type Value = Record<string, unknown>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function feedback() {
  return {
    schemaVersion: 1 as const,
    feedbackId,
    issueId,
    actorId,
    reporterEmail: "PRIVATE_REPORTER@example.test",
    submittedAt: "2026-09-21T12:00:00.000Z",
    cohort: "early_access_v1" as const,
    input: {
      type: "bug" as const,
      description: "PRIVATE_ORIGINAL_FEEDBACK",
      expectedBehavior: "Desired",
      impact: "minor" as const,
      contactAllowed: false,
    },
    context: {
      route: "private-journal.html",
      theme: "dark",
      viewport: { width: 390, height: 844 },
      buildSha: "a".repeat(40),
      browser: "safari",
      platform: "ios",
    },
  };
}
function job(provider: "linear" | "email") {
  return {
    deliveryId: provider === "linear" ? linearId : emailDeliveryId,
    provider,
    firstDispatchedAt: null as string | null,
    payload: null as Value | null,
    bindingFingerprint: null as string | null,
    feedback: feedback(),
    linear: { state: "pending" } as Value,
  };
}
type Job = ReturnType<typeof job>;
function request(body: unknown = {}, key = secret, signal?: AbortSignal) {
  return new Request(
    "https://functions.example.test/process-early-access-feedback",
    {
      method: "POST",
      headers: {
        "x-dominion-worker-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    },
  );
}
function fixture() {
  const state = {
    jobs: {
      linear: job("linear") as Job | null,
      email: job("email") as Job | null,
    },
    calls: [] as { name: string; args: Value }[],
    order: [] as string[],
    sends: [] as { url: string; body: string; headers: Headers }[],
    settlements: [] as Value[],
    issue: null as Value | null,
    env: {
      FEEDBACK_WORKER_SECRET: secret,
      LINEAR_FEEDBACK_API_KEY: "lin_fixture_only",
      RESEND_API_KEY: "re_fixture_only",
      TRANSACTIONAL_EMAIL_FROM: sender,
    } as Record<string, string | undefined>,
    failLinear: false,
    loseEmailResponse: false,
    rpcHook: null as
      | ((
        name: string,
        args: Value,
        signal: AbortSignal,
      ) => unknown | Promise<unknown>)
      | null,
    fetchHook: null as
      | ((url: string, init: RequestInit) => Response | Promise<Response>)
      | null,
  };
  function delivery(args: Value) {
    const current = Object.values(state.jobs).find((value) =>
      value?.deliveryId === args.target_delivery_id
    );
    assert(current);
    return current;
  }
  const rpc = async (name: string, args: Value, signal: AbortSignal) => {
    state.calls.push({ name, args: copy(args) });
    state.order.push(name);
    assert(!signal.aborted);
    assertEquals(args.target_worker_token, workerId);
    if (state.rpcHook) return await state.rpcHook(name, args, signal);
    return normalRpc(name, args);
  };
  function normalRpc(name: string, args: Value): unknown {
    if (name === "claim_early_access_feedback_deliveries") {
      assertEquals(args.target_batch_size, 1);
      const current = state.jobs[args.target_provider as "linear" | "email"];
      return current ? [copy(current)] : [];
    }
    const current = delivery(args);
    if (name === "bind_early_access_feedback_delivery") {
      current.payload = copy(args.target_payload as Value);
      current.bindingFingerprint = String(args.target_binding_fingerprint);
      return true;
    }
    if (name === "mark_early_access_feedback_dispatched") {
      assert(current.payload);
      assertEquals(args.target_binding_fingerprint, current.bindingFingerprint);
      current.firstDispatchedAt ||= new Date(clock).toISOString();
      return {
        deliveryId: current.deliveryId,
        idempotencyKey: `dominion-feedback/${current.deliveryId}`,
        bindingFingerprint: current.bindingFingerprint,
        firstDispatchedAt: current.firstDispatchedAt,
      };
    }
    if (name === "settle_early_access_feedback_delivery") {
      state.settlements.push(copy(args));
      if (
        current.provider === "linear" && args.target_outcome === "delivered" &&
        state.jobs.email
      ) {
        state.jobs.email.linear = {
          state: "delivered",
          issueId: args.target_receipt_id,
          issueUrl: args.target_issue_url,
        };
      }
      return true;
    }
    throw new Error("Unexpected RPC");
  }
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    assert(init);
    assertEquals(init.redirect, "error");
    const body = String(init.body);
    state.order.push(
      target === "https://api.linear.app/graphql"
        ? JSON.parse(body).query.startsWith("query")
          ? "linear_lookup"
          : "linear_create"
        : "email_post",
    );
    state.sends.push({ url: target, body, headers: new Headers(init.headers) });
    if (state.fetchHook) return await state.fetchHook(target, init);
    return normalFetch(target, init);
  }) as typeof fetch;
  function normalFetch(url: string, init: RequestInit) {
    const parsed = JSON.parse(String(init.body));
    if (url === "https://api.linear.app/graphql") {
      if (state.failLinear) {
        return new Response("PRIVATE_PROVIDER_ERROR", { status: 503 });
      }
      if (parsed.query.startsWith("query")) {
        return new Response(
          JSON.stringify({
            data: { issues: { nodes: state.issue ? [state.issue] : [] } },
          }),
        );
      }
      const input = parsed.variables.input;
      assert(state.jobs.linear?.firstDispatchedAt);
      assertEquals(input.teamId, FEEDBACK_LINEAR_TEAM);
      assertEquals(input.projectId, FEEDBACK_LINEAR_PROJECT);
      state.issue = {
        id: input.id,
        url: issueUrl,
        description: input.description,
        team: { id: input.teamId },
        project: { id: input.projectId },
      };
      return new Response(
        JSON.stringify({
          data: { issueCreate: { success: true, issue: state.issue } },
        }),
      );
    }
    assertEquals(url, "https://api.resend.com/emails");
    assert(state.jobs.email?.firstDispatchedAt);
    assertEquals(parsed.to, SUPPORT_EMAIL);
    assertEquals(parsed.from, sender);
    if (state.loseEmailResponse) throw new Error("PRIVATE_LOST_EMAIL_RESPONSE");
    return new Response(JSON.stringify({ id: emailReceiptId }));
  }
  function handler(extra: Parameters<typeof createHandler>[0] = {}) {
    return createHandler({
      env: (name) => state.env[name],
      randomUuid: () => workerId,
      rpc,
      fetcher,
      now: () => clock,
      ...extra,
    });
  }
  return { state, handler, normalRpc, normalFetch };
}
async function safeResponse(response: Response) {
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  assertEquals(response.headers.get("Pragma"), "no-cache");
  const text = await response.text();
  for (
    const privateValue of [
      secret,
      "re_fixture",
      "lin_fixture",
      "PRIVATE_",
      actorId,
      feedbackId,
      sender,
      SUPPORT_EMAIL,
    ]
  ) assert(!text.includes(privateValue));
  return JSON.parse(text);
}

Deno.test("feedback worker authenticates method and shared secret before touching jobs", async () => {
  const { state, handler } = fixture();
  const run = handler();
  assertEquals(
    (await run(new Request("https://functions.example.test"))).status,
    405,
  );
  for (const key of ["", "wrong", "x".repeat(513)]) {
    const response = await run(request({}, key));
    assertEquals(response.status, 401);
    await safeResponse(response);
  }
  assertEquals(state.calls.length, 0);
  assertEquals(state.sends.length, 0);
});

Deno.test("missing or malformed global provider configuration fails before any claim", async () => {
  for (
    const [key, value] of [
      ["LINEAR_FEEDBACK_API_KEY", undefined],
      ["RESEND_API_KEY", undefined],
      ["TRANSACTIONAL_EMAIL_FROM", undefined],
      ["LINEAR_FEEDBACK_API_KEY", " key "],
      ["RESEND_API_KEY", "bad"],
      ["TRANSACTIONAL_EMAIL_FROM", "invalid"],
    ]
  ) {
    const { state, handler } = fixture();
    state.env[key!] = value;
    const response = await handler()(request());
    assertEquals(response.status, 503);
    await safeResponse(response);
    assertEquals(state.calls.length, 0);
    assertEquals(state.sends.length, 0);
  }
});

Deno.test("worker binds and fences both deliveries before effects and settles exact receipts", async () => {
  const { state, handler } = fixture();
  const response = await handler()(
    request({
      deliveryId: "caller-id",
      to: "attacker@example.test",
      mode: "redrive",
      provider: "arbitrary",
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await safeResponse(response), {
    linear: "delivered",
    email: "accepted",
  });
  assertEquals(state.order, [
    "claim_early_access_feedback_deliveries",
    "bind_early_access_feedback_delivery",
    "linear_lookup",
    "mark_early_access_feedback_dispatched",
    "linear_create",
    "settle_early_access_feedback_delivery",
    "claim_early_access_feedback_deliveries",
    "bind_early_access_feedback_delivery",
    "mark_early_access_feedback_dispatched",
    "email_post",
    "settle_early_access_feedback_delivery",
  ]);
  assertEquals(
    state.settlements.map((value) => ({
      outcome: value.target_outcome,
      receipt: value.target_receipt_id,
      url: value.target_issue_url,
    })),
    [
      { outcome: "delivered", receipt: issueId, url: issueUrl },
      { outcome: "accepted", receipt: emailReceiptId, url: null },
    ],
  );
  assert(!JSON.stringify(state.calls).includes("attacker@example.test"));
  assert(
    state.sends.find((value) => value.url === "https://api.resend.com/emails")
      ?.body.includes(issueUrl),
  );
});

Deno.test("provider lookup failure still sends the support notification with pending Linear status", async () => {
  const { state, handler } = fixture();
  state.failLinear = true;
  const response = await handler()(request());
  assertEquals(await safeResponse(response), {
    linear: "retryable",
    email: "accepted",
  });
  const body = JSON.parse(
    state.sends.find((value) => value.url === "https://api.resend.com/emails")!
      .body,
  );
  assert(body.text.includes("Linear delivery: Pending"));
  assert(!body.text.includes(issueUrl));
  assertEquals(
    state.calls.filter((value) =>
      value.name === "mark_early_access_feedback_dispatched"
    ).length,
    1,
  );
});

Deno.test("unknown email retries reuse frozen original body after Linear changes from pending to delivered", async () => {
  const { state, handler } = fixture();
  const run = handler();
  state.failLinear = true;
  state.loseEmailResponse = true;
  assertEquals(await safeResponse(await run(request())), {
    linear: "retryable",
    email: "uncertain",
  });
  const firstEmail = state.sends.find((value) =>
    value.url === "https://api.resend.com/emails"
  )!;
  const firstFingerprint = state.jobs.email!.bindingFingerprint;
  state.failLinear = false;
  state.loseEmailResponse = false;
  assertEquals(await safeResponse(await run(request())), {
    linear: "delivered",
    email: "accepted",
  });
  const emailSends = state.sends.filter((value) =>
    value.url === "https://api.resend.com/emails"
  );
  assertEquals(emailSends.length, 2);
  assertEquals(emailSends[1].body, firstEmail.body);
  assertEquals(
    emailSends[1].headers.get("Idempotency-Key"),
    firstEmail.headers.get("Idempotency-Key"),
  );
  assertEquals(state.jobs.email!.bindingFingerprint, firstFingerprint);
  assert(
    JSON.parse(emailSends[1].body).text.includes("Linear delivery: Pending"),
  );
});

Deno.test("a matching email fingerprint does not authorize an arbitrary frozen destination or sender", async () => {
  for (
    const patch of [{ to: "attacker@example.test" }, {
      from: "attacker@example.test",
    }]
  ) {
    const { state, handler } = fixture();
    state.jobs.linear = null;
    const current = state.jobs.email!;
    const message = {
      ...renderFeedbackSupportEmail(feedback(), {
        from: sender,
        linear: { state: "pending" },
      }),
      ...patch,
    };
    current.payload = { message };
    current.bindingFingerprint = await transactionalEmailFingerprint({
      deliveryId: emailDeliveryId,
      idempotencyKey: `dominion-feedback/${emailDeliveryId}`,
      message,
    });
    assertEquals(await safeResponse(await handler()(request())), {
      linear: "empty",
      email: "needs_review",
    });
    assertEquals(state.sends.length, 0);
    assertEquals(
      state.settlements[0].target_code,
      "worker_delivery_unavailable",
    );
  }
});

Deno.test("bind lease loss cannot reach a provider or settle another worker's job", async () => {
  const { state, handler, normalRpc } = fixture();
  state.rpcHook = (name, args) =>
    name === "bind_early_access_feedback_delivery"
      ? false
      : normalRpc(name, args);
  assertEquals(await safeResponse(await handler()(request())), {
    linear: "lease_lost",
    email: "lease_lost",
  });
  assertEquals(state.sends.length, 0);
  assertEquals(state.settlements.length, 0);
});

Deno.test("transient bind database failures settle as uncertain without sending", async () => {
  const { state, handler, normalRpc } = fixture();
  state.rpcHook = (name, args) => {
    if (name === "bind_early_access_feedback_delivery") {
      throw new Error("PRIVATE_DATABASE_ERROR");
    }
    return normalRpc(name, args);
  };
  assertEquals(await safeResponse(await handler()(request())), {
    linear: "uncertain",
    email: "uncertain",
  });
  assertEquals(state.sends.length, 0);
  assertEquals(state.settlements.map((value) => value.target_code), [
    "worker_database_unavailable",
    "worker_database_unavailable",
  ]);
});

Deno.test("database failure in one provider does not prevent independent email progress", async () => {
  const { state, handler, normalRpc } = fixture();
  state.rpcHook = (name, args) => {
    if (
      name === "claim_early_access_feedback_deliveries" &&
      args.target_provider === "linear"
    ) throw new Error("PRIVATE_DATABASE_ERROR");
    return normalRpc(name, args);
  };
  const response = await handler()(request());
  assertEquals(response.status, 503);
  assertEquals(await safeResponse(response), {
    linear: "unavailable",
    email: "accepted",
  });
});

Deno.test("malformed Linear dispatch receipt is uncertain and never authorizes mutation", async () => {
  const { state, handler, normalRpc } = fixture();
  state.jobs.email = null;
  state.rpcHook = (name, args) =>
    name === "mark_early_access_feedback_dispatched"
      ? { private: "PRIVATE_DATABASE_ERROR" }
      : normalRpc(name, args);
  assertEquals(await safeResponse(await handler()(request())), {
    linear: "uncertain",
    email: "empty",
  });
  assertEquals(
    state.order.filter((value) => value === "linear_create").length,
    0,
  );
  assertEquals(state.settlements[0].target_code, "dispatch_unconfirmed");
});

Deno.test("unknown Linear send is reconciliation-only on retry, never a second create", async () => {
  const { state, handler, normalFetch } = fixture();
  state.jobs.email = null;
  let creates = 0;
  state.fetchHook = (url, init) => {
    const parsed = JSON.parse(String(init.body));
    if (parsed.query.startsWith("mutation")) {
      creates++;
      throw new Error("PRIVATE_LOST_LINEAR_REPLY");
    }
    return normalFetch(url, init);
  };
  const run = handler();
  assertEquals(await safeResponse(await run(request())), {
    linear: "uncertain",
    email: "empty",
  });
  assertEquals(await safeResponse(await run(request())), {
    linear: "uncertain",
    email: "empty",
  });
  assertEquals(creates, 1);
  assertEquals(
    state.calls.filter((value) =>
      value.name === "mark_early_access_feedback_dispatched"
    ).length,
    1,
  );
});

Deno.test("settlement lease loss never claims success and does not rewrite a receipt", async () => {
  const { state, handler, normalRpc } = fixture();
  state.rpcHook = (name, args) =>
    name === "settle_early_access_feedback_delivery"
      ? false
      : normalRpc(name, args);
  assertEquals(await safeResponse(await handler()(request())), {
    linear: "lease_lost",
    email: "lease_lost",
  });
  assertEquals(
    state.calls.filter((value) =>
      value.name === "settle_early_access_feedback_delivery"
    ).length,
    2,
  );
});

Deno.test("bounded claim timeout ignores a late claim and makes no provider request", async () => {
  const { state, handler, normalRpc } = fixture();
  state.jobs.email = null;
  let resolve!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  state.rpcHook = (name, args, receivedSignal) => {
    if (
      name === "claim_early_access_feedback_deliveries" &&
      args.target_provider === "linear"
    ) {
      signal = receivedSignal;
      return new Promise((yes) => {
        resolve = yes;
      });
    }
    return normalRpc(name, args);
  };
  const response = await handler({ rpcTimeoutMs: 5 })(request());
  assertEquals(response.status, 503);
  assertEquals(await safeResponse(response), {
    linear: "unavailable",
    email: "empty",
  });
  assert(signal?.aborted);
  resolve([job("linear")]);
  await Promise.resolve();
  assertEquals(state.sends.length, 0);
});

Deno.test("request abort before any claim and abort during binding never reach providers", async () => {
  for (const before of [true, false]) {
    const { state, handler, normalRpc } = fixture();
    const controller = new AbortController();
    if (before) controller.abort();
    else {state.rpcHook = (name, args) => {
        if (name === "bind_early_access_feedback_delivery") controller.abort();
        return normalRpc(name, args);
      };}
    const response = await handler()(request({}, secret, controller.signal));
    assertEquals(response.status, 503);
    await safeResponse(response);
    assertEquals(state.sends.length, 0);
    if (before) assertEquals(state.calls.length, 0);
  }
});

Deno.test("malformed claims, context and stored fingerprint fail closed without exposing private data", async () => {
  for (
    const patch of [
      { provider: "other" },
      { deliveryId: "bad" },
      { extra: "PRIVATE" },
      { firstDispatchedAt: new Date(clock).toISOString() },
      { feedback: { ...feedback(), user_metadata: { earlyAccess: true } } },
      { payload: { job: {} }, bindingFingerprint: "a".repeat(64) },
    ]
  ) {
    const { state, handler, normalRpc } = fixture();
    state.jobs.email = null;
    state.rpcHook = (name, args) =>
      name === "claim_early_access_feedback_deliveries" &&
        args.target_provider === "linear"
        ? [{ ...job("linear"), ...patch }]
        : normalRpc(name, args);
    await safeResponse(await handler()(request()));
    assertEquals(state.sends.length, 0);
  }
});

Deno.test("configuration is snapshotted per invocation and payload snapshots are immutable", async () => {
  const { state, handler, normalRpc } = fixture();
  state.jobs.linear = null;
  state.rpcHook = (name, args) => {
    if (name === "bind_early_access_feedback_delivery") {
      assert(Object.isFrozen(args.target_payload));
      assert(Object.isFrozen((args.target_payload as Value).message));
      state.env.RESEND_API_KEY = "re_changed_later";
      state.env.TRANSACTIONAL_EMAIL_FROM = "other@example.test";
    }
    return normalRpc(name, args);
  };
  assertEquals(await safeResponse(await handler()(request())), {
    linear: "empty",
    email: "accepted",
  });
  assertEquals(
    state.sends[0].headers.get("Authorization"),
    "Bearer re_fixture_only",
  );
});

Deno.test("RPC deadline and worker identity injection are bounded", async () => {
  for (const rpcTimeoutMs of [0, -1, NaN, Infinity, 10001]) {
    let failed = false;
    try {
      fixture().handler({ rpcTimeoutMs });
    } catch {
      failed = true;
    }
    assert(failed);
  }
  const { state, handler } = fixture();
  const response = await handler({ randomUuid: () => "bad" })(request());
  assertEquals(response.status, 503);
  await safeResponse(response);
  assertEquals(state.calls.length, 0);
});
