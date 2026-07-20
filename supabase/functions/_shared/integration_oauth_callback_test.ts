import { assert, assertEquals } from "./test_helpers.ts";
import { createOAuthCallbackHandler } from "./integration_oauth_callback.ts";

const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

function env(name: string) {
  return {
    PUBLIC_SITE_URL: "https://app.example.com",
    INTEGRATION_OAUTH_STATE_SECRET:
      "state-secret-with-more-than-thirty-two-characters",
    INTEGRATION_CREDENTIAL_KEYS: JSON.stringify({ 1: keyBase64 }),
  }[name];
}

function admin(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  values: Record<string, unknown> = {},
) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const value = values[name];
      if (value instanceof Error) return { data: null, error: value };
      return { data: value ?? true, error: null };
    },
  };
}

function handler(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  values: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return createOAuthCallbackHandler("slack", {
    env,
    createAdminClient: () =>
      admin(calls, {
        consume_integration_oauth_state: [{
          user_id: "10000000-0000-4000-8000-000000000001",
          crew_id: "20000000-0000-4000-8000-000000000002",
          return_path: "/community.html",
        }],
        create_pending_integration_connection:
          "30000000-0000-4000-8000-000000000003",
        ...values,
      }) as any,
    verifyIntegrationOAuthState: async () => ({
      payload: { provider: "slack" },
      nonceHash: "a".repeat(64),
    }),
    exchangeProviderCode: async () => ({
      accessToken: "provider-access-token",
      workspaceId: "T1",
      workspaceName: "Test Workspace",
      scopes: ["chat:write"],
    }),
    encryptProviderCredential: async () => ({
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(17).fill(1))),
      nonce: btoa(String.fromCharCode(...new Uint8Array(12).fill(2))),
      keyVersion: 1,
    }),
    createOpaqueToken: () => "setup-token-with-enough-entropy-123456789",
    randomUuid: () => "30000000-0000-4000-8000-000000000003",
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    logger: { error: () => undefined },
    ...overrides,
  } as any);
}

Deno.test("OAuth callback rejects unsupported methods", async () => {
  const response = await handler([])(
    new Request("https://function.test?state=s&code=c", { method: "POST" }),
  );
  assertEquals(response.status, 405);
});

Deno.test("successful callback consumes state and stores only encrypted pending credentials", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handler(calls)(
    new Request("https://function.test?state=signed-state&code=temporary-code"),
  );
  assertEquals(response.status, 302);
  const location = new URL(response.headers.get("location") || "");
  assertEquals(location.origin, "https://app.example.com");
  assertEquals(location.pathname, "/community.html");
  const fragment = new URLSearchParams(location.hash.slice(1));
  assertEquals(
    fragment.get("integration-setup"),
    "setup-token-with-enough-entropy-123456789",
  );
  assertEquals(fragment.get("provider"), "slack");
  assert(!location.toString().includes("provider-access-token"));
  assert(!location.toString().includes("temporary-code"));

  assertEquals(calls.map((call) => call.name), [
    "consume_integration_oauth_state",
    "create_pending_integration_connection",
  ]);
  const pending = calls[1].args;
  assertEquals(pending.target_workspace_id, "T1");
  assert(String(pending.target_credential_ciphertext).startsWith("\\x"));
  assert(!JSON.stringify(pending).includes("provider-access-token"));
});

Deno.test("provider denial still consumes non-replayable state", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let exchanged = false;
  const response = await handler(calls, {}, {
    exchangeProviderCode: async () => {
      exchanged = true;
      throw new Error("must not exchange");
    },
  })(
    new Request("https://function.test?state=signed-state&error=access_denied"),
  );

  assertEquals(response.status, 302);
  const location = new URL(response.headers.get("location") || "");
  assertEquals(
    new URLSearchParams(location.hash.slice(1)).get("integration-error"),
    "authorization_denied",
  );
  assertEquals(exchanged, false);
  assertEquals(calls.map((call) => call.name), [
    "consume_integration_oauth_state",
  ]);
});

Deno.test("callback replay and persistence failures return a redacted restart state", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const response = await handler(calls, {
    consume_integration_oauth_state: new Error("raw database detail"),
  }, {
    logger: { error: (value: string) => logs.push(value) },
  })(new Request("https://function.test?state=replayed&code=temporary-code"));

  assertEquals(response.status, 302);
  const location = new URL(response.headers.get("location") || "");
  assertEquals(
    new URLSearchParams(location.hash.slice(1)).get("integration-error"),
    "authorization_failed",
  );
  assert(!location.toString().includes("database"));
  assert(!logs.join(" ").includes("raw database detail"));
});
