import { assert, assertEquals } from "./test_helpers.ts";
import {
  type ClaimedDelivery,
  decodePostgresBytes,
  decryptProviderCredential,
  encryptProviderCredential,
  parseCredentialKeys,
  redactIntegrationMetadata,
  safeDeliveryLog,
  sendProviderMessage,
} from "./integration_delivery.ts";

const rawKey = new Uint8Array(32).fill(7);
const keyBase64 = btoa(String.fromCharCode(...rawKey));

function delivery(
  provider: "slack" | "discord" = "slack",
): ClaimedDelivery {
  return {
    delivery_id: "10000000-0000-4000-8000-000000000001",
    crew_id: "20000000-0000-4000-8000-000000000002",
    destination_id: "30000000-0000-4000-8000-000000000003",
    provider,
    provider_workspace_id: "workspace-1",
    provider_destination_id: "channel-1",
    event_type: "synthetic.delivery",
    payload: { text: "Keep the standard." },
    attempt_number: 1,
    max_attempts: 5,
    credential_ciphertext: new Uint8Array(17),
    credential_nonce: new Uint8Array(12),
    credential_key_version: 1,
  };
}

async function rejects(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("Expected promise to reject.");
}

Deno.test("credential keys are versioned and exactly 256 bits", () => {
  const keys = parseCredentialKeys(JSON.stringify({ 1: keyBase64 }));
  assertEquals(keys.get(1), rawKey);
  let failed = false;
  try {
    parseCredentialKeys(JSON.stringify({ 1: btoa("short") }));
  } catch {
    failed = true;
  }
  assert(failed);
});

Deno.test("provider credentials round-trip with destination-bound AES-GCM", async () => {
  const keys = new Map([[1, rawKey]]);
  const source = delivery();
  const encrypted = await encryptProviderCredential(
    { accessToken: "test-provider-token" },
    source.destination_id,
    source.provider,
    1,
    keys,
    new Uint8Array(12).fill(3),
  );
  const credential = await decryptProviderCredential({
    ...source,
    credential_ciphertext: encrypted.ciphertext,
    credential_nonce: encrypted.nonce,
  }, keys);
  assertEquals(credential, { accessToken: "test-provider-token" });

  await rejects(() =>
    decryptProviderCredential({
      ...source,
      destination_id: "40000000-0000-4000-8000-000000000004",
      credential_ciphertext: encrypted.ciphertext,
      credential_nonce: encrypted.nonce,
    }, keys)
  );
});

Deno.test("PostgreSQL bytea and base64 values decode without ambiguity", () => {
  assertEquals(
    decodePostgresBytes("\\x0001feff"),
    new Uint8Array([0, 1, 254, 255]),
  );
  assertEquals(
    decodePostgresBytes("AAH+/w=="),
    new Uint8Array([0, 1, 254, 255]),
  );
});

Deno.test("Slack delivery uses the channel contract without returning content", async () => {
  let requestBody: Record<string, unknown> = {};
  let authorization = "";
  const fetcher =
    (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") || "";
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ ok: true, ts: "secret-provider-body" }),
        {
          status: 200,
          headers: { "x-slack-req-id": "req-1" },
        },
      );
    }) as typeof fetch;

  const result = await sendProviderMessage(
    delivery("slack"),
    { accessToken: "slack-token" },
    fetcher,
  );
  assertEquals(authorization, "Bearer slack-token");
  assertEquals(requestBody, {
    channel: "channel-1",
    text: "Keep the standard.",
  });
  assertEquals(result, {
    outcome: "delivered",
    httpStatus: 200,
    providerRequestId: "req-1",
    responseMetadata: { provider: "slack" },
  });
  assert(!JSON.stringify(result).includes("secret-provider-body"));
});

Deno.test("Slack API failures distinguish retries from authorization failures", async () => {
  const rateLimited = await sendProviderMessage(
    delivery("slack"),
    { accessToken: "token" },
    (async () =>
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 200,
        headers: { "retry-after": "45" },
      })) as typeof fetch,
  );
  assertEquals(rateLimited.outcome, "retry");
  assertEquals(rateLimited.errorCode, "provider_unavailable");

  const invalidAuth = await sendProviderMessage(
    delivery("slack"),
    { accessToken: "token" },
    (async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
      })) as typeof fetch,
  );
  assertEquals(invalidAuth.outcome, "dead_letter");
  assertEquals(invalidAuth.errorCode, "provider_authorization_failed");
});

Deno.test("Discord delivery targets the selected channel with bot authentication", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  let authorization = "";
  const result = await sendProviderMessage(
    delivery("discord"),
    { accessToken: "discord-token" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization") || "";
      return new Response(null, {
        status: 204,
        headers: { "x-request-id": "req-2" },
      });
    }) as typeof fetch,
  );
  assert(url.endsWith("/channels/channel-1/messages"));
  assertEquals(body, { content: "Keep the standard." });
  assertEquals(authorization, "Bot discord-token");
  assertEquals(result.outcome, "delivered");
});

Deno.test("provider HTTP status maps to bounded retry or dead letter behavior", async () => {
  const unavailable = await sendProviderMessage(
    delivery("discord"),
    { accessToken: "token" },
    (async () => new Response(null, { status: 503 })) as typeof fetch,
  );
  assertEquals(unavailable.outcome, "retry");
  assertEquals(unavailable.errorCode, "provider_unavailable");

  const missing = await sendProviderMessage(
    delivery("discord"),
    { accessToken: "token" },
    (async () => new Response(null, { status: 404 })) as typeof fetch,
  );
  assertEquals(missing.outcome, "dead_letter");
  assertEquals(missing.errorCode, "provider_destination_missing");
});

Deno.test("network failures retry and invalid payloads dead-letter", async () => {
  const network = await sendProviderMessage(
    delivery(),
    { accessToken: "token" },
    (async () => {
      throw new Error("provider response leaked here");
    }) as typeof fetch,
  );
  assertEquals(network.outcome, "retry");
  assert(!JSON.stringify(network).includes("leaked"));

  const invalid = delivery("discord");
  invalid.payload = { text: "" };
  const invalidResult = await sendProviderMessage(
    invalid,
    { accessToken: "token" },
    (() => Promise.reject(new Error("should not matter"))) as typeof fetch,
  );
  assertEquals(invalidResult.outcome, "dead_letter");
  assertEquals(invalidResult.errorCode, "invalid_delivery_payload");
});

Deno.test("structured metadata and logs redact sensitive fields", () => {
  assertEquals(
    redactIntegrationMetadata({
      provider: "slack",
      token: "secret",
      nested: { Authorization: "secret", status: 429 },
      list: [{ body: "secret", code: "rate_limited" }],
    }),
    {
      provider: "slack",
      token: "[redacted]",
      nested: { Authorization: "[redacted]", status: 429 },
      list: [{ body: "[redacted]", code: "rate_limited" }],
    },
  );

  const log = safeDeliveryLog("settled", delivery(), {
    outcome: "retry",
    errorCode: "provider_unavailable",
    responseMetadata: { token: "never-log" },
  });
  assertEquals(log, {
    event: "settled",
    deliveryId: "10000000-0000-4000-8000-000000000001",
    crewId: "20000000-0000-4000-8000-000000000002",
    provider: "slack",
    attemptNumber: 1,
    outcome: "retry",
    httpStatus: undefined,
    errorCode: "provider_unavailable",
  });
  assert(!JSON.stringify(log).includes("never-log"));
});
