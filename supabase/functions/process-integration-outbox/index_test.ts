import { assert, assertEquals, responseJson } from "../_shared/test_helpers.ts";
import type {
  ClaimedDelivery,
  DeliveryResult,
} from "../_shared/integration_delivery.ts";
import { createHandler } from "./index.ts";

const workerSecret = "a-secure-worker-secret-with-more-than-32-characters";
const credentialKeys = JSON.stringify({
  1: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
});

function request(body: unknown = { mode: "process" }, secret = workerSecret) {
  return new Request("https://functions.test/process-integration-outbox", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-dominion-worker-key": secret,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function claimedDelivery(): ClaimedDelivery {
  return {
    delivery_id: "10000000-0000-4000-8000-000000000001",
    crew_id: "20000000-0000-4000-8000-000000000002",
    destination_id: "30000000-0000-4000-8000-000000000003",
    provider: "slack",
    provider_workspace_id: "workspace-1",
    provider_destination_id: "channel-1",
    event_type: "check_in.committed",
    payload: { text: "A member checked in." },
    attempt_number: 1,
    max_attempts: 5,
    credential_ciphertext: "AA==",
    credential_nonce: "AAAAAAAAAAAAAAAA",
    credential_key_version: 1,
  };
}

function environment(name: string) {
  return {
    INTEGRATION_WORKER_SECRET: workerSecret,
    INTEGRATION_CREDENTIAL_KEYS: credentialKeys,
  }[name];
}

function adminRpc(
  values: Record<string, unknown>,
  calls: Array<{ name: string; args: Record<string, unknown> }> = [],
) {
  return {
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const value = values[name];
      if (value instanceof Error) return { data: null, error: value };
      return { data: value ?? null, error: null };
    },
  };
}

const logger = {
  info: (_value: unknown) => undefined,
  error: (_value: unknown) => undefined,
};

function workerHandler(
  values: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  calls: Array<{ name: string; args: Record<string, unknown> }> = [],
) {
  return createHandler({
    env: environment,
    createAdminClient: () => adminRpc(values, calls) as any,
    decryptProviderCredential: async () => ({ accessToken: "provider-token" }),
    sendProviderMessage: async () => ({
      outcome: "delivered",
      httpStatus: 200,
      responseMetadata: { provider: "slack" },
    }),
    randomUuid: () => "40000000-0000-4000-8000-000000000004",
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    logger,
    ...overrides,
  } as any);
}

Deno.test("worker rejects unsupported methods and unauthenticated callers", async () => {
  const method = await createHandler({ env: environment } as any)(
    new Request("https://functions.test", { method: "GET" }),
  );
  assertEquals(method.status, 405);

  const unauthorized = await workerHandler({})(request({}, "wrong-secret"));
  assertEquals(unauthorized.status, 401);
  assertEquals((await responseJson(unauthorized)).error, "Not authorized.");
});

Deno.test("health mode returns server-side queue signals without loading credentials", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await workerHandler({
    integration_delivery_health: { queued: 2, processing: 1 },
  }, {
    env: (name: string) =>
      name === "INTEGRATION_WORKER_SECRET" ? workerSecret : undefined,
  }, calls)(request({ mode: "health" }));

  assertEquals(response.status, 200);
  assertEquals((await responseJson(response)).health, {
    queued: 2,
    processing: 1,
  });
  assertEquals(calls.map((call) => call.name), ["integration_delivery_health"]);
});

Deno.test("worker releases stale locks, delivers a claimed batch, and settles it", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const response = await workerHandler({
    release_stale_outbound_deliveries: 1,
    claim_outbound_deliveries: [claimedDelivery()],
    settle_outbound_delivery: "delivered",
    integration_delivery_health: { queued: 0, processing: 0 },
  }, {
    logger: {
      info: (value: string) => logs.push(value),
      error: () => undefined,
    },
  }, calls)(request({ mode: "process", batchSize: 10 }));

  assertEquals(response.status, 200);
  const body = await responseJson(response);
  assertEquals(body.releasedStale, 1);
  assertEquals(body.claimed, 1);
  assertEquals(body.delivered, 1);
  assertEquals(body.retried, 0);
  assertEquals(body.deadLettered, 0);
  assertEquals(calls.map((call) => call.name), [
    "release_stale_outbound_deliveries",
    "claim_outbound_deliveries",
    "settle_outbound_delivery",
    "integration_delivery_health",
  ]);
  const settle = calls.find((call) => call.name === "settle_outbound_delivery");
  assertEquals(settle?.args.target_delivery_id, claimedDelivery().delivery_id);
  assertEquals(settle?.args.target_started_at, "2026-07-19T12:00:00.000Z");
  assert(!logs.join(" ").includes("provider-token"));
  assert(!logs.join(" ").includes("A member checked in"));
});

Deno.test("database-enforced final outcome is reflected in dead-letter counts", async () => {
  const retry: DeliveryResult = {
    outcome: "retry",
    httpStatus: 503,
    errorCode: "provider_unavailable",
    errorSummary: "slack temporarily rejected the delivery.",
    responseMetadata: { provider: "slack" },
  };
  const response = await workerHandler({
    release_stale_outbound_deliveries: 0,
    claim_outbound_deliveries: [claimedDelivery()],
    settle_outbound_delivery: "dead_letter",
    integration_delivery_health: {},
  }, { sendProviderMessage: async () => retry })(request());

  const body = await responseJson(response);
  assertEquals(body.claimed, 1);
  assertEquals(body.retried, 0);
  assertEquals(body.deadLettered, 1);
});

Deno.test("credential failures dead-letter without invoking a provider", async () => {
  let sent = false;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await workerHandler({
    release_stale_outbound_deliveries: 0,
    claim_outbound_deliveries: [claimedDelivery()],
    settle_outbound_delivery: "dead_letter",
    integration_delivery_health: {},
  }, {
    decryptProviderCredential: async () => {
      throw new Error("ciphertext detail");
    },
    sendProviderMessage: async () => {
      sent = true;
      throw new Error("should not send");
    },
  }, calls)(request());

  assertEquals(response.status, 200);
  assertEquals(sent, false);
  const settle = calls.find((call) => call.name === "settle_outbound_delivery");
  assertEquals(settle?.args.target_error_code, "credential_decryption_failed");
  assert(!JSON.stringify(settle).includes("ciphertext detail"));
});

Deno.test("maintenance releases stale work and applies retention", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await workerHandler(
    {
      release_stale_outbound_deliveries: 2,
      purge_integration_delivery_history: {
        redactedPayloads: 3,
        redactedAttempts: 4,
        deletedDeliveries: 5,
      },
      integration_delivery_health: { queued: 0 },
    },
    {},
    calls,
  )(request({ mode: "maintenance" }));

  assertEquals(response.status, 200);
  assertEquals(calls.map((call) => call.name), [
    "release_stale_outbound_deliveries",
    "purge_integration_delivery_history",
    "integration_delivery_health",
  ]);
  assertEquals((await responseJson(response)).releasedStale, 2);
});

Deno.test("synthetic mode queues an idempotent diagnostic message before processing", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await workerHandler(
    {
      release_stale_outbound_deliveries: 0,
      enqueue_outbound_delivery: "50000000-0000-4000-8000-000000000005",
      claim_outbound_deliveries: [],
      integration_delivery_health: { queued: 1 },
    },
    {},
    calls,
  )(request({
    mode: "synthetic",
    crewId: "20000000-0000-4000-8000-000000000002",
    destinationId: "30000000-0000-4000-8000-000000000003",
    idempotencyKey: "synthetic:test:1",
    text: "Synthetic staging delivery",
  }));

  assertEquals(response.status, 200);
  assertEquals(
    (await responseJson(response)).syntheticDeliveryId,
    "50000000-0000-4000-8000-000000000005",
  );
  const enqueue = calls.find((call) =>
    call.name === "enqueue_outbound_delivery"
  );
  assertEquals(enqueue?.args.target_event_type, "synthetic.delivery");
  assertEquals(enqueue?.args.target_payload, {
    text: "Synthetic staging delivery",
  });
  assertEquals(enqueue?.args.target_max_attempts, 3);
});

Deno.test("worker returns redacted server errors", async () => {
  const errors: string[] = [];
  const response = await workerHandler({
    release_stale_outbound_deliveries: new Error("database password leaked"),
  }, {
    logger: {
      info: () => undefined,
      error: (value: string) => errors.push(value),
    },
  })(request());

  assertEquals(response.status, 500);
  assertEquals(
    (await responseJson(response)).error,
    "Integration delivery worker failed.",
  );
  assert(!errors.join(" ").includes("database password"));
});
