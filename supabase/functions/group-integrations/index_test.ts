import { HttpError } from "../_shared/http.ts";
import {
  assert,
  assertEquals,
  request,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

const crewId = "20000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000001";
const destinationId = "30000000-0000-4000-8000-000000000003";
const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));

function env(name: string) {
  return {
    INTEGRATION_OAUTH_STATE_SECRET:
      "state-secret-with-more-than-thirty-two-characters",
    INTEGRATION_CREDENTIAL_KEYS: JSON.stringify({ 1: keyBase64 }),
    SUPABASE_URL: "https://project.supabase.co",
    SLACK_CLIENT_ID: "slack-client",
    PUBLIC_SITE_URL: "http://localhost:5173",
  }[name];
}

type Call = { name: string; args: Record<string, unknown> };

function rpcClient(values: Record<string, unknown>, calls: Call[]) {
  return {
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const value = values[name];
      if (value instanceof Error) return { data: null, error: value };
      return { data: value ?? null, error: null };
    },
  };
}

const pending = {
  pending_id: "40000000-0000-4000-8000-000000000004",
  provider: "slack",
  crew_id: crewId,
  provider_workspace_id: "T1",
  provider_workspace_name: "Test Workspace",
  credential_ciphertext: "\\x" + "01".repeat(17),
  credential_nonce: "\\x" + "02".repeat(12),
  credential_key_version: 1,
  credential_fingerprint: "a".repeat(64),
  scopes: ["chat:write"],
};

const secret = {
  destination_id: destinationId,
  crew_id: crewId,
  provider: "slack",
  provider_workspace_id: "T1",
  provider_destination_id: "C1",
  status: "active",
  credential_ciphertext: "\\x" + "01".repeat(17),
  credential_nonce: "\\x" + "02".repeat(12),
  credential_key_version: 1,
  credential_fingerprint: "a".repeat(64),
  revoke_safe: true,
};

function integrationHandler(
  values: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
  calls: Call[] = [],
) {
  const merged = {
    list_crew_integration_destinations: [],
    get_pending_integration_connection: [pending],
    prepare_integration_destination_id: destinationId,
    complete_pending_integration_connection: destinationId,
    get_integration_destination_secret: [secret],
    mark_integration_destination_health: true,
    disconnect_integration_destination: true,
    create_integration_oauth_state: true,
    ...values,
  };
  return createHandler({
    env,
    requireUser: async () => ({ id: userId }),
    createAdminClient: () => rpcClient(merged, calls) as any,
    createUserClient: () => rpcClient(merged, calls) as any,
    createIntegrationOAuthState: async () => ({
      state: "signed-state",
      nonceHash: "b".repeat(64),
      expiresAt: new Date("2026-07-19T12:10:00.000Z"),
    }),
    providerAuthorizationUrl: () =>
      "https://slack.com/oauth/v2/authorize?state=signed-state",
    listProviderChannels:
      async () => [{ id: "C1", name: "updates", kind: "private" }],
    requireProviderChannel: async () => ({
      id: "C1",
      name: "updates",
      kind: "private",
    }),
    decryptProviderCredential: async () => ({ accessToken: "provider-token" }),
    encryptProviderCredential: async () => ({
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(17).fill(1))),
      nonce: btoa(String.fromCharCode(...new Uint8Array(12).fill(2))),
      keyVersion: 1,
    }),
    sendProviderMessage: async () => ({
      outcome: "delivered",
      httpStatus: 200,
      responseMetadata: { provider: "slack" },
    }),
    revokeProviderCredential: async () => true,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    logger: { error: () => undefined },
    ...overrides,
  } as any);
}

Deno.test("connection handler supports preflight and requires authentication", async () => {
  assertEquals((await integrationHandler()(request("OPTIONS"))).status, 200);
  assertEquals((await integrationHandler()(request("GET"))).status, 405);
  const unauthorized = await integrationHandler({}, {
    requireUser: async () => {
      throw new HttpError("Not authenticated.", 401);
    },
  })(request("POST", { action: "list", crewId }));
  assertEquals(unauthorized.status, 401);
  assertEquals((await responseJson(unauthorized)).error, "Not authenticated.");
});

Deno.test("members receive only sanitized connection status", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler(
    {
      list_crew_integration_destinations: [{
        destination_id: destinationId,
        provider: "slack",
        workspace_id: "T1",
        workspace_name: "Test Workspace",
        channel_id: "C1",
        channel_name: "updates",
        status: "active",
        last_verified_at: "2026-07-19T12:00:00Z",
        last_tested_at: null,
        last_delivered_at: null,
        health_code: null,
        can_manage: false,
      }],
    },
    {},
    calls,
  )(request("POST", { action: "list", crewId }));
  assertEquals(response.status, 200);
  const destinations = (await responseJson(response)).destinations as Array<
    Record<string, unknown>
  >;
  assertEquals(destinations[0].workspaceName, "Test Workspace");
  assertEquals(destinations[0].canManage, false);
  assert(!JSON.stringify(destinations).includes("credential"));
  assertEquals(calls[0].name, "list_crew_integration_destinations");
});

Deno.test("begin binds signed state to the authenticated group admin", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler({}, {}, calls)(request("POST", {
    action: "begin",
    crewId,
    provider: "slack",
  }));
  assertEquals(response.status, 200);
  assert(
    String((await responseJson(response)).authorizationUrl).startsWith(
      "https://slack.com/",
    ),
  );
  const stateCall = calls.find((call) =>
    call.name === "create_integration_oauth_state"
  );
  assertEquals(stateCall?.args.target_user_id, userId);
  assertEquals(stateCall?.args.target_crew_id, crewId);
  assertEquals(stateCall?.args.target_nonce_hash, "b".repeat(64));
});

Deno.test("pending channel discovery never returns provider credentials", async () => {
  const response = await integrationHandler()(request("POST", {
    action: "channels",
    setupToken: "setup-token-with-enough-entropy-123456",
  }));
  assertEquals(response.status, 200);
  const body = await responseJson(response);
  assertEquals(body.workspace, { id: "T1", name: "Test Workspace" });
  assertEquals(body.channels, [{ id: "C1", name: "updates", kind: "private" }]);
  assert(!JSON.stringify(body).includes("provider-token"));
  assert(!JSON.stringify(body).includes("credential"));
});

Deno.test("confirm validates the channel and re-encrypts for the stable destination ID", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler({}, {}, calls)(request("POST", {
    action: "confirm",
    setupToken: "setup-token-with-enough-entropy-123456",
    channelId: "C1",
  }));
  assertEquals(response.status, 200);
  assertEquals((await responseJson(response)).destination, {
    id: destinationId,
    crewId,
    provider: "slack",
  });
  const complete = calls.find((call) =>
    call.name === "complete_pending_integration_connection"
  );
  assertEquals(complete?.args.target_destination_id, destinationId);
  assertEquals(complete?.args.target_provider_destination_id, "C1");
  assert(String(complete?.args.target_credential_ciphertext).startsWith("\\x"));
  assert(!JSON.stringify(complete).includes("provider-token"));
});

Deno.test("test message records healthy state after provider delivery", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler({}, {}, calls)(request("POST", {
    action: "test",
    destinationId,
  }));
  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    delivered: true,
    status: "active",
  });
  const health = calls.find((call) =>
    call.name === "mark_integration_destination_health"
  );
  assertEquals(health?.args.target_healthy, true);
});

Deno.test("revoked or missing provider destinations transition to needs attention", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler({}, {
    sendProviderMessage: async () => ({
      outcome: "dead_letter",
      errorCode: "provider_authorization_failed",
      errorSummary: "provider rejected",
      responseMetadata: { provider: "slack" },
    }),
  }, calls)(request("POST", { action: "test", destinationId }));
  assertEquals(response.status, 409);
  const health = calls.find((call) =>
    call.name === "mark_integration_destination_health"
  );
  assertEquals(health?.args.target_healthy, false);
  assertEquals(health?.args.target_error_code, "provider_authorization_failed");
});

Deno.test("temporary provider errors do not force a reconnect", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler({}, {
    sendProviderMessage: async () => ({
      outcome: "retry",
      errorCode: "provider_unavailable",
      errorSummary: "temporary",
      responseMetadata: { provider: "slack" },
    }),
  }, calls)(request("POST", { action: "test", destinationId }));
  assertEquals(response.status, 503);
  assertEquals(
    calls.some((call) => call.name === "mark_integration_destination_health"),
    false,
  );
});

Deno.test("disconnect revokes when safe and always disables local delivery", async () => {
  const calls: Call[] = [];
  let revokedToken = "";
  const response = await integrationHandler({}, {
    revokeProviderCredential: async (_provider: string, value: string) => {
      revokedToken = value;
      return true;
    },
  }, calls)(request("POST", { action: "disconnect", destinationId }));
  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    disconnected: true,
    providerRevoked: true,
  });
  assertEquals(revokedToken, "provider-token");
  assertEquals(calls.at(-1)?.name, "disconnect_integration_destination");
});

Deno.test("disconnect fails closed locally when provider revocation is unavailable", async () => {
  const calls: Call[] = [];
  const response = await integrationHandler({}, {
    revokeProviderCredential: async () => {
      throw new Error("provider raw error");
    },
  }, calls)(request("POST", { action: "disconnect", destinationId }));
  assertEquals(response.status, 200);
  assertEquals((await responseJson(response)).providerRevoked, false);
  assertEquals(calls.at(-1)?.name, "disconnect_integration_destination");
});

Deno.test("input and server failures are redacted", async () => {
  const invalid = await integrationHandler()(request("POST", {
    action: "begin",
    crewId,
    provider: "webhook",
  }));
  assertEquals(invalid.status, 400);

  const logs: string[] = [];
  const failure = await integrationHandler({
    create_integration_oauth_state: new Error("database credential leaked"),
  }, {
    logger: { error: (value: string) => logs.push(value) },
  })(request("POST", { action: "begin", crewId, provider: "slack" }));
  assertEquals(failure.status, 500);
  assertEquals(
    (await responseJson(failure)).error,
    "Unable to manage the group integration.",
  );
  assert(!logs.join(" ").includes("database credential"));
});
