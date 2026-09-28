import {
  assert,
  assertEquals,
  request,
  responseJson,
} from "../_shared/test_helpers.ts";
import { type EnvReader, HttpError } from "../_shared/http.ts";
import { openEarlyAccessInvitation } from "../_shared/early_access_invitation.ts";
import { createHandler, createInvitationUserRpc } from "./index.ts";

const actor = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000002";
const operationId = "30000000-0000-4000-8000-000000000003";
const correlationId = "40000000-0000-4000-8000-000000000004";
const generationId = "50000000-0000-4000-8000-000000000005";
const deliveryId = "60000000-0000-4000-8000-000000000006";
const intent = {
  action: "approve",
  expectedActorId: actor,
  requestId,
  expectedRevision: "7",
  operationId,
  correlationId,
};
const key = new Uint8Array(32).fill(42);
const encodedKey = btoa(String.fromCharCode(...key)).replace(/\+/g, "-")
  .replace(/\//g, "_").replace(/=+$/, "");
const settings: Record<string, string> = {
  PUBLIC_SITE_URL: "http://localhost:5173",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "public-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "never-use-service-key",
  EARLY_ACCESS_INVITATION_KEY: encodedKey,
  EARLY_ACCESS_INVITATION_KEY_VERSION: "1",
  TRANSACTIONAL_EMAIL_FROM: "Dominion <noreply@mail.77dominion.com>",
};
const env: EnvReader = (name: string) => settings[name];
const success = { ok: true, requestId, status: "approved", revision: "8" };
const detail = {
  schemaVersion: 1,
  actorId: actor,
  item: { id: requestId, email: "member@example.com", revision: "7" },
};
type Call = {
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
};
function fixture(options: {
  rpc?: (call: Call) => Promise<unknown>;
  env?: typeof env;
  timeout?: number;
} = {}) {
  const calls: Call[] = [];
  let created = 0;
  let uuids = 0;
  const handler = createHandler({
    env: options.env || env,
    now: () => Date.parse("2026-09-27T23:00:00.000Z"),
    randomUuid: () => ++uuids % 2 ? generationId : deliveryId,
    bodyTimeoutMs: options.timeout || 100,
    rpcTimeoutMs: options.timeout || 100,
    createRpc: (req) => {
      created++;
      assertEquals(req.headers.get("authorization"), "Bearer test-token");
      assertEquals(req.headers.get("origin"), "http://localhost:5173");
      return async (name, args, signal) => {
        const call = { name, args, signal };
        calls.push(call);
        if (options.rpc) return await options.rpc(call);
        return name === "site_admin_get_early_access_request" ? detail : {
          ...success,
          status: args.target_action === "revoke" ? "revoked" : "approved",
        };
      };
    },
  });
  return { handler, calls, created: () => created };
}

Deno.test("approve binds the canonical recipient, encrypts once, and returns only a receipt", async () => {
  const f = fixture();
  const result = await f.handler(request("POST", intent));
  assertEquals(result.status, 200);
  assertEquals(await responseJson(result), success);
  assertEquals(result.headers.get("cache-control"), "private, no-store");
  assertEquals(result.headers.get("referrer-policy"), "no-referrer");
  assertEquals(f.calls.map((call) => call.name), [
    "site_admin_get_early_access_request",
    "site_admin_write_early_access_invitation",
  ]);
  const args = f.calls[1].args;
  assertEquals(args.target_expected_actor_id, actor);
  assertEquals(args.target_expected_revision, "7");
  assertEquals(args.target_operation_id, operationId);
  assertEquals(args.target_correlation_id, correlationId);
  const binding = args.target_binding as Parameters<
    typeof openEarlyAccessInvitation
  >[1];
  assertEquals(binding, {
    requestId,
    generationId,
    deliveryId,
    recipient: "member@example.com",
    issuedAt: "2026-09-27T23:00:00.000Z",
    expiresAt: "2026-10-04T23:00:00.000Z",
    from: settings.TRANSACTIONAL_EMAIL_FROM,
  });
  const content = await openEarlyAccessInvitation(
    args.target_envelope as Parameters<typeof openEarlyAccessInvitation>[0],
    binding,
    { keyVersion: 1, key },
    {
      tokenDigest: String(args.target_token_digest),
      contentFingerprint: String(args.target_content_fingerprint),
      idempotencyKey: String(args.target_idempotency_key),
    },
  );
  assertEquals(content.message.to, binding.recipient);
  assert(
    content.message.text.includes(
      "https://77dominion.com/early-access-invite.html#token=",
    ),
  );
  assert(!JSON.stringify(args).includes("#token="));
});

Deno.test("resend uses the same writer; revoke needs no email/key/read and sends no material", async () => {
  const resend = fixture();
  assertEquals(
    (await resend.handler(request("POST", { ...intent, action: "resend" })))
      .status,
    200,
  );
  assertEquals(resend.calls[1].args.target_action, "resend");
  const revoke = fixture({
    env: (name) => name.startsWith("EARLY_ACCESS_") ? undefined : env(name),
  });
  const response = await revoke.handler(
    request("POST", { ...intent, action: "revoke" }),
  );
  assertEquals(await responseJson(response), { ...success, status: "revoked" });
  assertEquals(revoke.calls.length, 1);
  for (
    const name of [
      "target_binding",
      "target_envelope",
      "target_token_digest",
      "target_content_fingerprint",
      "target_idempotency_key",
    ]
  ) {
    assertEquals(revoke.calls[0].args[name], null);
  }
});

Deno.test("caller may provide only intent, never a mailbox, token, grant, sender, or ciphertext", async () => {
  for (
    const body of [
      { ...intent, recipient: "attacker@example.com" },
      { ...intent, token: "secret" },
      { ...intent, envelope: {} },
      { ...intent, from: "attacker@example.com" },
      { ...intent, userId: actor },
      { ...intent, grant: true },
      { ...intent, action: "accept" },
      { ...intent, expectedRevision: 7 },
      { ...intent, expectedRevision: "01" },
      { ...intent, expectedRevision: "9223372036854775808" },
      { ...intent, requestId: "not-a-uuid" },
      { ...intent, expectedActorId: null },
      null,
      [],
      {},
    ]
  ) {
    const f = fixture();
    assertEquals((await f.handler(request("POST", body))).status, 400);
    assertEquals(f.created(), 0);
  }
});

Deno.test("methods, bearer, and exact allowed Origin are checked before RPC", async () => {
  for (
    const [method, headers, status] of [
      ["GET", {}, 405],
      ["OPTIONS", {}, 200],
      ["POST", { Origin: "https://attacker.example" }, 403],
      ["POST", { Origin: "http://localhost:5173/path" }, 403],
      ["POST", { Origin: "null" }, 403],
      ["POST", { Origin: "" }, 403],
      ["POST", { Authorization: "" }, 401],
      ["POST", { Authorization: "Bearer one, two" }, 401],
      ["POST", { "Content-Type": "text/plain" }, 415],
    ] as const
  ) {
    const f = fixture();
    const response = await f.handler(
      request(method, method === "POST" ? intent : undefined, headers),
    );
    assertEquals(response.status, status);
    assertEquals(f.created(), 0);
    assertEquals(response.headers.get("cache-control"), "private, no-store");
  }
});

Deno.test("bounded bodies reject excess, malformed UTF8/JSON, and stalled streams", async () => {
  for (
    const [body, headers, status] of [
      ["x".repeat(2049), {}, 413],
      ["{bad", {}, 400],
      [JSON.stringify(intent), { "Content-Length": "9999" }, 413],
      [JSON.stringify(intent), { "Content-Length": "invalid" }, 400],
      [new Uint8Array([255]), {}, 400],
    ] as const
  ) {
    const f = fixture();
    const response = await f.handler(
      new Request("https://edge.example", {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...headers,
        },
        body,
      }),
    );
    assertEquals(response.status, status);
    assertEquals(f.created(), 0);
  }
  let cancelled = false;
  const f = fixture({ timeout: 10 });
  const response = await f.handler(
    new Request("https://edge.example", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  assertEquals(response.status, 408);
  assertEquals(cancelled, true);
  assertEquals(f.created(), 0);
});

Deno.test("unsafe canonical reads/config never write, even when the caller supplied a valid intent", async () => {
  for (
    const altered of [
      null,
      { ...detail, actorId: operationId },
      { ...detail, item: { ...detail.item, id: operationId } },
      { ...detail, item: { ...detail.item, email: "Member@example.com" } },
      {
        ...detail,
        item: {
          ...detail.item,
          email: "member@example.com\r\nBcc:evil@example.com",
        },
      },
    ]
  ) {
    const f = fixture({ rpc: async () => altered });
    assertEquals((await f.handler(request("POST", intent))).status, 503);
    assertEquals(f.calls.length, 1);
  }
  for (
    const [name, value] of [
      ["EARLY_ACCESS_INVITATION_KEY", ""],
      ["EARLY_ACCESS_INVITATION_KEY", "a".repeat(43)],
      ["EARLY_ACCESS_INVITATION_KEY_VERSION", "0"],
      ["EARLY_ACCESS_INVITATION_KEY_VERSION", "2147483648"],
      ["TRANSACTIONAL_EMAIL_FROM", "Dominion <noreply@other.example>"],
    ]
  ) {
    const f = fixture({ env: (key) => key === name ? value : env(key) });
    assertEquals((await f.handler(request("POST", intent))).status, 503);
    assertEquals(f.calls.length, 1);
  }
});

Deno.test("SQL remains authority on conflict/retry; changed revisions are not pre-rejected", async () => {
  const f = fixture({
    rpc: async (call) =>
      call.name === "site_admin_get_early_access_request"
        ? { ...detail, item: { ...detail.item, revision: "8" } }
        : success,
  });
  assertEquals(
    await responseJson(await f.handler(request("POST", intent))),
    success,
  );
  assertEquals(f.calls[1].args.target_expected_revision, "7");
  const conflict = fixture({
    rpc: async (call) =>
      call.name === "site_admin_get_early_access_request"
        ? detail
        : { ok: false, errorCode: "revision_conflict" },
  });
  assertEquals(
    await responseJson(await conflict.handler(request("POST", intent))),
    { ok: false, errorCode: "revision_conflict" },
  );
});

Deno.test("database exceptions and unexpected receipts cannot expose native tokens or ciphertext", async () => {
  for (
    const result of [
      { ...success, token: "credential-sentinel" },
      { ...success, requestId: actor },
      { ok: false, errorCode: "credential-sentinel" },
      { ...success, revision: "-1" },
    ]
  ) {
    const f = fixture({
      rpc: async (call) =>
        call.name === "site_admin_get_early_access_request" ? detail : result,
    });
    const response = await f.handler(request("POST", intent));
    assertEquals(response.status, 503);
    assert(!(await response.text()).includes("credential-sentinel"));
  }
  const f = fixture({
    rpc: async () => {
      throw new Error("credential-sentinel");
    },
  });
  const response = await f.handler(request("POST", intent));
  assertEquals(response.status, 503);
  assert(!(await response.text()).includes("credential-sentinel"));
});

Deno.test("RPC deadlines/abort stop continuation; unknown write results remain retryable with same operation", async () => {
  for (
    const stalled of [
      "site_admin_get_early_access_request",
      "site_admin_write_early_access_invitation",
    ]
  ) {
    const f = fixture({
      timeout: 10,
      rpc: async (call) => {
        if (call.name === stalled) return await new Promise(() => {});
        return detail;
      },
    });
    const response = await f.handler(request("POST", intent));
    assertEquals(response.status, 503);
    assert(f.calls.at(-1)!.signal.aborted);
    assertEquals(
      f.calls.length,
      stalled === "site_admin_get_early_access_request" ? 1 : 2,
    );
  }
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const response = await f.handler(
    new Request(request("POST", intent), { signal: controller.signal }),
  );
  assertEquals(response.status, 408);
  assertEquals(f.created(), 0);
});

Deno.test("RPC getters, symbol fields, and non-plain receipts cannot change validated response fields", async () => {
  let reads = 0;
  const unstable = {
    ...success,
    get requestId() {
      return ++reads === 1 ? requestId : "CANARY_PRIVATE";
    },
  };
  for (
    const value of [
      unstable,
      { ...success, [Symbol("hidden")]: "CANARY_PRIVATE" },
      Object.assign(new Date(), success),
      { ...success, revision: "9" },
    ]
  ) {
    const f = fixture({
      rpc: async (call) =>
        call.name === "site_admin_get_early_access_request" ? detail : value,
    });
    const response = await f.handler(request("POST", intent));
    assertEquals(response.status, 503);
    assert(!(await response.text()).includes("CANARY_PRIVATE"));
  }
  assertEquals(reads, 0);
  const f = fixture({
    rpc: async () => ({
      ...detail,
      get item() {
        throw new Error("CANARY_PRIVATE");
      },
    }),
  });
  const response = await f.handler(request("POST", intent));
  assertEquals(response.status, 503);
  assert(!(await response.text()).includes("CANARY_PRIVATE"));
});

Deno.test("real Supabase SDK sends original bearer, Origin and only the anon apikey", async () => {
  const seen: string[] = [];
  const rpc = createInvitationUserRpc(
    request("POST", intent),
    env,
    async (input, init) => {
      const req = new Request(input, init);
      seen.push(req.url);
      assertEquals(req.headers.get("authorization"), "Bearer test-token");
      assertEquals(req.headers.get("origin"), "http://localhost:5173");
      assertEquals(req.headers.get("apikey"), "public-anon-key");
      assert(!(await req.clone().text()).includes("never-use-service-key"));
      return new Response(JSON.stringify(success), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  assertEquals(
    await rpc("site_admin_write_early_access_invitation", {
      target_expected_actor_id: actor,
    }, new AbortController().signal),
    success,
  );
  assertEquals(seen, [
    "https://project.supabase.co/rest/v1/rpc/site_admin_write_early_access_invitation",
  ]);
});

Deno.test("SDK errors are mapped through a fixed allowlist without reflecting provider data", async () => {
  for (
    const [code, message, status] of [
      ["PT401", "credential-sentinel", 401],
      ["PT403", "credential-sentinel", 403],
      ["42501", "credential-sentinel", 403],
      ["PT404", "credential-sentinel", 404],
      ["22023", "admin_idempotency_conflict", 409],
      ["XX000", "credential-sentinel", 503],
    ] as const
  ) {
    const rpc = createInvitationUserRpc(
      request("POST", intent),
      env,
      async () =>
        new Response(
          JSON.stringify({
            code,
            message,
            details: "credential-sentinel",
            hint: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );
    let caught: unknown;
    try {
      await rpc("test", {}, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof HttpError);
    assertEquals(caught.status, status);
    assert(!caught.message.includes("credential-sentinel"));
  }
});
