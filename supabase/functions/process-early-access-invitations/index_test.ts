import { assert, assertEquals } from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";
import { createEarlyAccessInvitation } from "../_shared/early_access_invitation.ts";
import { TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS } from "../_shared/transactional_email.ts";
import {
  EARLY_ACCESS_AUTH_ORIGIN,
  EARLY_ACCESS_AUTH_REDIRECT,
} from "../_shared/early_access_recovery_mail.ts";

type Value = Record<string, unknown>;
// Setup is gated independently from the already-supported app-mail worker.
const secret = "invitation-worker-test-secret-at-least-32-characters";
const sender = "Dominion <noreply@mail.77dominion.com>";
const requestId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const deliveryId = "33333333-3333-4333-8333-333333333333";
const workerId = "44444444-4444-4444-8444-444444444444";
const receiptId = "55555555-5555-4555-8555-555555555555";
const issuedAt = "2026-09-27T12:00:00.000Z";
const clock = Date.parse(issuedAt) + 1000;
const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const encodedKey = btoa(String.fromCharCode(...key)).replace(/\+/g, "-")
  .replace(/\//g, "_").replace(/=+$/, "");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

Deno.test("native bootstrap runtime gate requires exact enabled flag, project and reviewed TTL", async () => {
  for (
    const patch of [
      { EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: "yes" },
      { EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: "true" },
      {
        EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: "true",
        SUPABASE_URL: EARLY_ACCESS_AUTH_ORIGIN,
        EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: "60",
      },
      {
        EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: "true",
        SUPABASE_URL: "https://other.supabase.co",
        EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: "3600",
      },
    ]
  ) {
    const f = await fixture();
    Object.assign(f.state.env, patch);
    assertEquals((await f.handler()(request())).status, 503);
    assertEquals(f.state.calls, []);
    assertEquals(f.state.sends, []);
  }
});
Deno.test("enabled native setup checks each server-owned queue before app invitations", async () => {
  const f = await fixture();
  Object.assign(f.state.env, {
    EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: "true",
    SUPABASE_URL: EARLY_ACCESS_AUTH_ORIGIN,
    EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: "3600",
  });
  f.state.rpcHook = async () => [];
  const result = await f.handler({
    auth: () => {
      throw new Error("No native calls for empty queues");
    },
  })(request({ email: "attacker@example.com" }));
  assertEquals(result.status, 200);
  assertEquals(await result.json(), {
    bootstrap: "empty",
    setupEmail: "empty",
    email: "empty",
  });
  assertEquals(f.state.calls.map((call) => call.name), [
    "claim_early_access_account_bootstraps",
    "claim_early_access_account_setup_deliveries",
    "claim_early_access_invitation_deliveries",
  ]);
});

Deno.test("native bootstrap real SDK factory pins service bearer, project, UUID and abortable requests", async () => {
  for (const reconcile of [false, true]) {
    const f = await fixture();
    const reservedUserId = "66666666-6666-4666-8666-666666666666";
    const email = "new_native@example.test";
    const nativeToken = "a".repeat(64);
    const user = {
      id: reservedUserId,
      email,
      aud: "authenticated",
      role: "authenticated",
      is_anonymous: false,
      email_confirmed_at: null,
      confirmed_at: null,
      identities: [{
        user_id: reservedUserId,
        provider: "email",
        identity_data: { email },
      }],
    };
    Object.assign(f.state.env, {
      EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: "true",
      SUPABASE_URL: EARLY_ACCESS_AUTH_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: "service_fixture_only",
      EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: "3600",
    });
    const nativeCalls: string[] = [];
    f.state.rpcHook = (name, args) => {
      if (name === "claim_early_access_account_bootstraps") {
        return [{
          requestId,
          generationId,
          reservedUserId,
          deliveryId,
          recipient: email,
          invitationExpiresAt: "2026-10-04T12:00:00.000Z",
        }];
      }
      if (name === "start_early_access_account_bootstrap") return true;
      if (name === "persist_early_access_account_setup") {
        assertEquals(
          (args.target_binding as Value).reservedUserId,
          reservedUserId,
        );
        assert(!JSON.stringify(args).includes(nativeToken));
        return true;
      }
      if (
        name === "claim_early_access_account_setup_deliveries" ||
        name === "claim_early_access_invitation_deliveries"
      ) return [];
      throw new Error("Unexpected setup RPC");
    };
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      nativeCalls.push(`${init?.method} ${url.pathname}`);
      assertEquals(url.origin, EARLY_ACCESS_AUTH_ORIGIN);
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("Authorization"), "Bearer service_fixture_only");
      assertEquals(headers.get("apikey"), "service_fixture_only");
      assert(init?.signal instanceof AbortSignal && !init.signal.aborted);
      assertEquals(init?.redirect, "error");
      assertEquals(init?.cache, "no-store");
      if (url.pathname === "/auth/v1/admin/users") {
        assertEquals(JSON.parse(String(init?.body)), {
          id: reservedUserId,
          email,
          email_confirm: false,
        });
        return reconcile
          ? new Response(
            JSON.stringify({
              message: "Create unavailable",
              code: "email_exists",
            }),
            { status: 422 },
          )
          : new Response(JSON.stringify(user));
      }
      if (url.pathname === `/auth/v1/admin/users/${reservedUserId}`) {
        return new Response(JSON.stringify(user));
      }
      assertEquals(url.pathname, "/auth/v1/admin/generate_link");
      const body = JSON.parse(String(init?.body));
      assertEquals(body.type, "recovery");
      assertEquals(body.email, email);
      assertEquals(
        url.searchParams.get("redirect_to"),
        EARLY_ACCESS_AUTH_REDIRECT,
      );
      return new Response(JSON.stringify({
        ...user,
        action_link:
          `${EARLY_ACCESS_AUTH_ORIGIN}/auth/v1/verify?token=${nativeToken}&type=recovery&redirect_to=${
            encodeURIComponent(EARLY_ACCESS_AUTH_REDIRECT)
          }`,
        hashed_token: nativeToken,
        verification_type: "recovery",
        redirect_to: EARLY_ACCESS_AUTH_REDIRECT,
        email_otp: "123456",
      }));
    }) as typeof fetch;
    const result = await f.handler({ fetcher })(request());
    assertEquals(result.status, 200);
    assertEquals(await result.json(), {
      bootstrap: "prepared",
      setupEmail: "empty",
      email: "empty",
    });
    assertEquals(nativeCalls, [
      "POST /auth/v1/admin/users",
      ...(reconcile ? [`GET /auth/v1/admin/users/${reservedUserId}`] : []),
      "POST /auth/v1/admin/generate_link",
    ]);
  }
});
function request(body: unknown = {}, supplied = secret, signal?: AbortSignal) {
  return new Request(
    "https://functions.example.test/process-early-access-invitations",
    {
      method: "POST",
      headers: {
        "x-dominion-worker-key": supplied,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    },
  );
}
async function fixture() {
  const binding = {
    requestId,
    generationId,
    deliveryId,
    recipient: "private_invitee@example.test",
    issuedAt,
    expiresAt: "2026-10-04T12:00:00.000Z",
    from: sender,
  };
  const sealed = await createEarlyAccessInvitation(binding, {
    keyVersion: 1,
    key,
  });
  const job = {
    deliveryId,
    binding,
    ...sealed,
    firstDispatchedAt: null as string | null,
  };
  const state = {
    job: copy(job) as typeof job | null,
    calls: [] as { name: string; args: Value }[],
    order: [] as string[],
    sends: [] as { url: string; body: string; headers: Headers }[],
    settlements: [] as Value[],
    env: {
      EARLY_ACCESS_INVITATION_WORKER_SECRET: secret,
      EARLY_ACCESS_INVITATION_KEY: encodedKey,
      EARLY_ACCESS_INVITATION_KEY_VERSION: "1",
      RESEND_API_KEY: "re_fixture_only",
      TRANSACTIONAL_EMAIL_FROM: sender,
    } as Record<string, string | undefined>,
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
  function normalRpc(name: string, args: Value): unknown {
    if (name === "claim_early_access_invitation_deliveries") {
      assertEquals(args, {
        target_worker_token: workerId,
        target_batch_size: 1,
      });
      return state.job ? [copy(state.job)] : [];
    }
    assert(state.job);
    assertEquals(args.target_delivery_id, deliveryId);
    if (name === "mark_early_access_invitation_dispatched") {
      assertEquals(args, {
        target_delivery_id: deliveryId,
        target_worker_token: workerId,
        target_content_fingerprint: state.job.contentFingerprint,
        target_token_digest: state.job.tokenDigest,
      });
      state.job.firstDispatchedAt ||= new Date(clock).toISOString();
      return {
        deliveryId,
        idempotencyKey: state.job.idempotencyKey,
        bindingFingerprint: state.job.contentFingerprint,
        firstDispatchedAt: state.job.firstDispatchedAt,
      };
    }
    if (name === "settle_early_access_invitation_delivery") {
      state.settlements.push(copy(args));
      return true;
    }
    throw new Error("Unexpected RPC");
  }
  function handler(extra: Parameters<typeof createHandler>[0] = {}) {
    return createHandler({
      env: (name) => state.env[name],
      now: () => clock,
      randomUuid: () => workerId,
      rpc: async (name, args, signal) => {
        assert(!signal.aborted);
        assertEquals(args.target_worker_token, workerId);
        state.calls.push({ name, args: copy(args) });
        state.order.push(name);
        if (state.rpcHook) return await state.rpcHook(name, args, signal);
        return normalRpc(name, args);
      },
      fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
        assert(init);
        state.order.push("email_post");
        state.sends.push({
          url: String(url),
          body: String(init.body),
          headers: new Headers(init.headers),
        });
        assert(state.job?.firstDispatchedAt);
        assertEquals(url, "https://api.resend.com/emails");
        assertEquals(init.method, "POST");
        assertEquals(init.redirect, "error");
        if (state.fetchHook) return await state.fetchHook(String(url), init);
        return new Response(JSON.stringify({ id: receiptId }));
      }) as typeof fetch,
      ...extra,
    });
  }
  return { state, handler, normalRpc };
}
async function safeResponse(response: Response) {
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  assertEquals(response.headers.get("Pragma"), "no-cache");
  assertEquals(response.headers.get("Referrer-Policy"), "no-referrer");
  assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  const text = await response.text();
  for (
    const privateValue of [
      secret,
      encodedKey,
      "re_fixture",
      "PRIVATE_",
      "private_invitee",
      sender,
      requestId,
      generationId,
      deliveryId,
      receiptId,
      "#token=",
      "ciphertext",
    ]
  ) assert(!text.includes(privateValue));
  return JSON.parse(text);
}

Deno.test("invitation worker requires POST and dedicated secret before any claim", async () => {
  const { state, handler } = await fixture();
  const run = handler();
  assertEquals(
    (await run(new Request("https://functions.example.test"))).status,
    405,
  );
  for (const supplied of ["", "wrong", "x".repeat(513)]) {
    const response = await run(request({}, supplied));
    assertEquals(response.status, 401);
    await safeResponse(response);
  }
  state.env.EARLY_ACCESS_INVITATION_WORKER_SECRET = undefined;
  state.env.FEEDBACK_WORKER_SECRET = secret;
  assertEquals((await run(request())).status, 401);
  assertEquals(state.calls.length, 0);
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation worker rejects malformed runtime configuration before claiming", async () => {
  for (
    const [name, value] of [
      ["RESEND_API_KEY", undefined],
      ["RESEND_API_KEY", "bad"],
      ["RESEND_API_KEY", "re_secret\n"],
      ["TRANSACTIONAL_EMAIL_FROM", undefined],
      ["TRANSACTIONAL_EMAIL_FROM", "Dominion <noreply@77dominion.com>"],
      ["TRANSACTIONAL_EMAIL_FROM", "noreply@mail.77dominion.com.evil.test"],
      [
        "TRANSACTIONAL_EMAIL_FROM",
        "x@mail.77dominion.com\r\nBcc:evil@example.test",
      ],
      ["EARLY_ACCESS_INVITATION_KEY", undefined],
      ["EARLY_ACCESS_INVITATION_KEY", "A".repeat(42)],
      ["EARLY_ACCESS_INVITATION_KEY", "A".repeat(42) + "B"],
      ["EARLY_ACCESS_INVITATION_KEY", encodedKey + "="],
      ["EARLY_ACCESS_INVITATION_KEY_VERSION", undefined],
      ["EARLY_ACCESS_INVITATION_KEY_VERSION", "01"],
      ["EARLY_ACCESS_INVITATION_KEY_VERSION", "0"],
      ["EARLY_ACCESS_INVITATION_KEY_VERSION", "2147483648"],
    ]
  ) {
    const { state, handler } = await fixture();
    state.env[name!] = value;
    const response = await handler()(request());
    assertEquals(response.status, 503);
    await safeResponse(response);
    assertEquals(state.calls.length, 0);
    assertEquals(state.sends.length, 0);
  }
});

Deno.test("invitation worker decrypts, fences, POSTs then settles one exact email", async () => {
  const { state, handler } = await fixture();
  const response = await handler()(request({
    deliveryId: "attacker-id",
    recipient: "evil@example.test",
    token: "stolen",
    mode: "redrive",
  }));
  assertEquals(response.status, 200);
  assertEquals(await safeResponse(response), { email: "accepted" });
  assertEquals(state.order, [
    "claim_early_access_invitation_deliveries",
    "mark_early_access_invitation_dispatched",
    "email_post",
    "settle_early_access_invitation_delivery",
  ]);
  assertEquals(state.sends.length, 1);
  const send = state.sends[0];
  assertEquals(send.headers.get("Authorization"), "Bearer re_fixture_only");
  assertEquals(send.headers.get("Idempotency-Key"), state.job!.idempotencyKey);
  const message = JSON.parse(send.body);
  assertEquals(message.from, sender);
  assertEquals(message.to, "private_invitee@example.test");
  assert(message.text.includes(`&generation=${generationId}`));
  assertEquals(state.settlements, [{
    target_delivery_id: deliveryId,
    target_worker_token: workerId,
    target_outcome: "accepted",
    target_code: null,
    target_receipt_id: receiptId,
  }]);
  assert(!JSON.stringify(state.calls).includes("evil@example.test"));
  assert(!JSON.stringify(state.calls).includes("#token="));
});

Deno.test("invitation empty claim causes no decryption, fence, send or settlement", async () => {
  const { state, handler } = await fixture();
  state.job = null;
  assertEquals(await safeResponse(await handler()(request())), {
    email: "empty",
  });
  assertEquals(state.calls.length, 1);
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation unaddressable or multiple claims fail safely without effects", async () => {
  for (
    const bad of [null, {}, [null], [{ deliveryId }], [{ deliveryId: "bad" }]]
  ) {
    const { state, handler } = await fixture();
    state.rpcHook = () => bad;
    const response = await handler()(request());
    assertEquals(response.status, 503);
    await safeResponse(response);
    assertEquals(state.calls.length, 1);
    assertEquals(state.sends.length, 0);
  }
  const { state, handler } = await fixture();
  state.rpcHook = () => [copy(state.job), copy(state.job)];
  assertEquals((await handler()(request())).status, 503);
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation invalid sealed claim is terminally reviewable before mark or POST", async () => {
  for (
    const mutate of [
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.tokenDigest = "a".repeat(64);
      },
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.contentFingerprint = "a".repeat(64);
      },
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.envelope = { ...job.envelope, nonce: "A".repeat(16) };
      },
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.binding.recipient = "evil@example.test";
      },
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.binding.deliveryId = generationId;
      },
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.firstDispatchedAt = "not-a-date";
      },
      (
        job: NonNullable<Awaited<ReturnType<typeof fixture>>["state"]["job"]>,
      ) => {
        job.firstDispatchedAt = "2026-02-30T12:00:00Z";
      },
    ]
  ) {
    const { state, handler } = await fixture();
    mutate(state.job!);
    assertEquals(await safeResponse(await handler()(request())), {
      email: "needs_review",
    });
    assertEquals(state.calls.map((item) => item.name), [
      "claim_early_access_invitation_deliveries",
      "settle_early_access_invitation_delivery",
    ]);
    assertEquals(
      state.settlements[0].target_code,
      "worker_delivery_unavailable",
    );
    assertEquals(state.sends.length, 0);
  }
});

Deno.test("invitation stored sender cannot drift with runtime configuration", async () => {
  const { state, handler } = await fixture();
  state.env.TRANSACTIONAL_EMAIL_FROM = "Other <noreply@mail.77dominion.com>";
  assertEquals(await safeResponse(await handler()(request())), {
    email: "needs_review",
  });
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation wrong runtime key or key version never dispatches", async () => {
  for (
    const change of [
      { EARLY_ACCESS_INVITATION_KEY: "A".repeat(43) },
      { EARLY_ACCESS_INVITATION_KEY_VERSION: "2" },
    ]
  ) {
    const { state, handler } = await fixture();
    Object.assign(state.env, change);
    assertEquals(await safeResponse(await handler()(request())), {
      email: "needs_review",
    });
    assertEquals(state.sends.length, 0);
  }
});

Deno.test("invitation lease, current-generation or quota denial never POSTs", async () => {
  const { state, handler, normalRpc } = await fixture();
  state.rpcHook = (name, args) =>
    name === "mark_early_access_invitation_dispatched"
      ? null
      : normalRpc(name, args);
  assertEquals(await safeResponse(await handler()(request())), {
    email: "retryable",
  });
  assertEquals(state.settlements[0].target_code, "dispatch_not_owned");
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation unknown dispatch result stays uncertain with no POST", async () => {
  const { state, handler, normalRpc } = await fixture();
  state.rpcHook = (name, args) => {
    if (name === "mark_early_access_invitation_dispatched") {
      throw new Error("PRIVATE_DATABASE_SECRET");
    }
    return normalRpc(name, args);
  };
  assertEquals(await safeResponse(await handler()(request())), {
    email: "uncertain",
  });
  assertEquals(state.settlements[0].target_code, "dispatch_unconfirmed");
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation mismatched dispatch receipts never POST", async () => {
  for (
    const patch of [
      { deliveryId: generationId },
      { bindingFingerprint: "a".repeat(64) },
      { idempotencyKey: "new-key" },
      { firstDispatchedAt: "not-a-date" },
      { extra: "PRIVATE_" },
    ]
  ) {
    const { state, handler, normalRpc } = await fixture();
    state.rpcHook = (name, args) => {
      const value = normalRpc(name, args);
      return name === "mark_early_access_invitation_dispatched"
        ? { ...value as Value, ...patch }
        : value;
    };
    assertEquals(await safeResponse(await handler()(request())), {
      email: "needs_review",
    });
    assertEquals(state.settlements[0].target_code, "dispatch_receipt_mismatch");
    assertEquals(state.sends.length, 0);
  }
});

Deno.test("invitation lost provider response retries byte-identical payload and original dispatch time", async () => {
  const { state, handler } = await fixture();
  state.fetchHook = () => {
    throw new Error("PRIVATE_PROVIDER_SECRET");
  };
  assertEquals(await safeResponse(await handler()(request())), {
    email: "uncertain",
  });
  const first = state.job!.firstDispatchedAt;
  assert(first);
  const body = state.sends[0].body;
  state.fetchHook = null;
  assertEquals(await safeResponse(await handler()(request())), {
    email: "accepted",
  });
  assertEquals(state.job!.firstDispatchedAt, first);
  assertEquals(state.sends[1].body, body);
  assertEquals(
    state.sends[1].headers.get("Idempotency-Key"),
    state.sends[0].headers.get("Idempotency-Key"),
  );
});

Deno.test("invitation conservative retry-window expiry prevents both mark and POST", async () => {
  const { state, handler } = await fixture();
  state.job!.firstDispatchedAt = new Date(
    clock - TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS,
  ).toISOString();
  assertEquals(await safeResponse(await handler()(request())), {
    email: "needs_review",
  });
  assertEquals(state.settlements[0].target_code, "retry_window_expired");
  assertEquals(state.sends.length, 0);
  assert(
    !state.calls.some((call) =>
      call.name === "mark_early_access_invitation_dispatched"
    ),
  );
});

Deno.test("invitation claim/config snapshots cannot change across async dispatch", async () => {
  const { state, handler, normalRpc } = await fixture();
  state.rpcHook = (name, args) => {
    if (name === "mark_early_access_invitation_dispatched") {
      const receipt = normalRpc(name, args);
      state.env.RESEND_API_KEY = "re_replaced";
      state.env.TRANSACTIONAL_EMAIL_FROM = "Other <evil@mail.77dominion.com>";
      state.job!.binding.recipient = "evil@example.test";
      state.job!.envelope = { ...state.job!.envelope, ciphertext: "broken" };
      return receipt;
    }
    return normalRpc(name, args);
  };
  assertEquals(await safeResponse(await handler()(request())), {
    email: "accepted",
  });
  assertEquals(
    JSON.parse(state.sends[0].body).to,
    "private_invitee@example.test",
  );
  assertEquals(
    state.sends[0].headers.get("Authorization"),
    "Bearer re_fixture_only",
  );
});

Deno.test("invitation provider outcomes settle only safe fixed codes", async () => {
  for (
    const [status, name, outcome, code] of [
      [429, "rate_limit_exceeded", "retryable", "rate_limited"],
      [429, "daily_quota_exceeded", "needs_review", "daily_quota_exceeded"],
      [429, "monthly_quota_exceeded", "needs_review", "monthly_quota_exceeded"],
      [
        409,
        "invalid_idempotent_request",
        "needs_review",
        "idempotency_conflict",
      ],
      [500, "anything", "uncertain", "request_unconfirmed"],
    ] as const
  ) {
    const { state, handler } = await fixture();
    state.fetchHook = () =>
      new Response(JSON.stringify({ name, message: "PRIVATE_PROVIDER_BODY" }), {
        status,
      });
    assertEquals(await safeResponse(await handler()(request())), {
      email: outcome,
    });
    assertEquals(state.settlements[0].target_code, code);
    assertEquals(state.settlements[0].target_receipt_id, null);
  }
});

Deno.test("invitation lost settlement reports unavailable without claiming success", async () => {
  for (const result of [false, "true", undefined]) {
    const { state, handler, normalRpc } = await fixture();
    state.rpcHook = (name, args) =>
      name === "settle_early_access_invitation_delivery"
        ? result
        : normalRpc(name, args);
    const response = await handler()(request());
    assertEquals(response.status, result === false ? 200 : 503);
    assertEquals(await safeResponse(response), {
      email: result === false ? "lease_lost" : "unavailable",
    });
    assertEquals(state.sends.length, 1);
  }
});

Deno.test("invitation stalled claim and pre-aborted request have no later effects", async () => {
  const { state, handler } = await fixture();
  const controller = new AbortController();
  controller.abort();
  assertEquals(
    (await handler()(request({}, secret, controller.signal))).status,
    503,
  );
  assertEquals(state.calls.length, 0);
  state.rpcHook = () => new Promise(() => {});
  const response = await handler({ rpcTimeoutMs: 2 })(request());
  assertEquals(response.status, 503);
  await safeResponse(response);
  assertEquals(state.sends.length, 0);
});

Deno.test("invitation stalled fence times out without POST and records uncertain outcome", async () => {
  const { state, handler, normalRpc } = await fixture();
  state.rpcHook = (name, args) =>
    name === "mark_early_access_invitation_dispatched"
      ? new Promise(() => {})
      : normalRpc(name, args);
  assertEquals(
    await safeResponse(
      await handler({ rpcTimeoutMs: 2, emailTimeoutMs: 5 })(request()),
    ),
    { email: "uncertain" },
  );
  assertEquals(state.sends.length, 0);
  assertEquals(state.settlements[0].target_code, "dispatch_unconfirmed");
});

Deno.test("invitation stalled provider times out after durable dispatch and remains uncertain", async () => {
  const { state, handler } = await fixture();
  state.fetchHook = () => new Promise(() => {});
  assertEquals(
    await safeResponse(await handler({ emailTimeoutMs: 2 })(request())),
    { email: "uncertain" },
  );
  assert(state.job!.firstDispatchedAt);
  assertEquals(state.settlements[0].target_code, "request_unconfirmed");
});

Deno.test("invitation worker validates bounded timeout and generated worker identity", async () => {
  const { state, handler } = await fixture();
  for (const invalid of [0, -1, 1.1, 10001, NaN]) {
    for (const name of ["rpcTimeoutMs", "emailTimeoutMs"]) {
      let error: unknown;
      try {
        handler({ [name]: invalid });
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof TypeError);
      assertEquals(error.message, "Invalid invitation worker configuration.");
    }
  }
  const response = await handler({ randomUuid: () => "PRIVATE_BAD_ID" })(
    request(),
  );
  assertEquals(response.status, 503);
  await safeResponse(response);
  assertEquals(state.calls.length, 0);
});

Deno.test("invitation real service SDK uses configured service credentials, not caller bearer", async () => {
  const { state } = await fixture();
  state.env.SUPABASE_URL = "https://project.example.test";
  state.env.SUPABASE_SERVICE_ROLE_KEY = "service_fixture_only";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assertEquals(
      String(input),
      "https://project.example.test/rest/v1/rpc/claim_early_access_invitation_deliveries",
    );
    assertEquals(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assertEquals(headers.get("Authorization"), "Bearer service_fixture_only");
    assertEquals(headers.get("apikey"), "service_fixture_only");
    assertEquals(JSON.parse(String(init?.body)), {
      target_worker_token: workerId,
      target_batch_size: 1,
    });
    return Promise.resolve(
      new Response("[]", { headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  try {
    const run = createHandler({
      env: (name) => state.env[name],
      randomUuid: () => workerId,
    });
    const input = request();
    input.headers.set(
      "Authorization",
      "Bearer caller_token_must_not_reach_postgrest",
    );
    assertEquals(await safeResponse(await run(input)), { email: "empty" });
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("invitation abort after durable fence prevents POST and cannot report success", async () => {
  const { state, handler, normalRpc } = await fixture();
  const controller = new AbortController();
  state.rpcHook = (name, args) => {
    const result = normalRpc(name, args);
    if (name === "mark_early_access_invitation_dispatched") controller.abort();
    return result;
  };
  const response = await handler()(request({}, secret, controller.signal));
  assertEquals(response.status, 503);
  assertEquals(await safeResponse(response), { email: "unavailable" });
  assert(state.job!.firstDispatchedAt);
  assertEquals(state.sends.length, 0);
  assertEquals(state.settlements.length, 0);
});
