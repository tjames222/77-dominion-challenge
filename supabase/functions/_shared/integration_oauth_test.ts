import { assert, assertEquals } from "./test_helpers.ts";
import {
  base64ToPostgresBytea,
  createIntegrationOAuthState,
  createOpaqueToken,
  currentCredentialKeyVersion,
  integrationStateSecret,
  publicSiteUrl,
  sha256Hex,
  verifyIntegrationOAuthState,
} from "./integration_oauth.ts";

const secret = "oauth-state-secret-that-is-longer-than-thirty-two-characters";

async function rejects(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("Expected promise to reject.");
}

Deno.test("OAuth state is signed, provider-bound, expiring, and hash-addressable", async () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const created = await createIntegrationOAuthState(
    "slack",
    secret,
    now,
    "deterministic-nonce-with-enough-entropy-123456",
  );
  const verified = await verifyIntegrationOAuthState(
    created.state,
    "slack",
    secret,
    new Date("2026-07-19T12:05:00.000Z"),
  );
  assertEquals(verified.nonceHash, created.nonceHash);
  assertEquals(verified.payload.provider, "slack");
  assertEquals(created.expiresAt.toISOString(), "2026-07-19T12:10:00.000Z");
  assertEquals(
    created.nonceHash,
    await sha256Hex("deterministic-nonce-with-enough-entropy-123456"),
  );
});

Deno.test("OAuth state rejects tampering, another provider, and expiry", async () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const created = await createIntegrationOAuthState(
    "slack",
    secret,
    now,
    "deterministic-nonce-with-enough-entropy-123456",
  );
  await rejects(() =>
    verifyIntegrationOAuthState(`${created.state}x`, "slack", secret, now)
  );
  await rejects(() =>
    verifyIntegrationOAuthState(created.state, "discord", secret, now)
  );
  await rejects(() =>
    verifyIntegrationOAuthState(
      created.state,
      "slack",
      secret,
      new Date("2026-07-19T12:11:00.000Z"),
    )
  );
});

Deno.test("opaque setup tokens use URL-safe entropy", () => {
  const value = createOpaqueToken();
  assert(value.length >= 40);
  assert(/^[A-Za-z0-9_-]+$/.test(value));
});

Deno.test("credential helpers choose the newest key and encode bytea", () => {
  assertEquals(
    currentCredentialKeyVersion(
      new Map([
        [1, new Uint8Array(32)],
        [4, new Uint8Array(32)],
        [2, new Uint8Array(32)],
      ]),
    ),
    4,
  );
  assertEquals(base64ToPostgresBytea("AAH+/w=="), "\\x0001feff");
});

Deno.test("integration secrets and public callback origins fail closed", () => {
  assertEquals(
    integrationStateSecret((name) =>
      name === "INTEGRATION_OAUTH_STATE_SECRET" ? secret : undefined
    ),
    secret,
  );
  assertEquals(
    publicSiteUrl((name) =>
      name === "PUBLIC_SITE_URL" ? "https://app.example.com/path" : undefined
    ),
    "https://app.example.com",
  );
  assertEquals(
    publicSiteUrl((name) =>
      name === "PUBLIC_SITE_URL" ? "http://127.0.0.1:5173" : undefined
    ),
    "http://127.0.0.1:5173",
  );

  let failed = false;
  try {
    publicSiteUrl((name) =>
      name === "PUBLIC_SITE_URL" ? "http://example.com" : undefined
    );
  } catch {
    failed = true;
  }
  assert(failed);
});
