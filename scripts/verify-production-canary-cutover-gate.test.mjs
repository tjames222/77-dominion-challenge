import assert from "node:assert/strict";
import test from "node:test";
import {
  canaryCutoverGateQuery,
  createCanaryCutoverAttestation,
  verifyCanaryCutoverAttestation,
  verifyCanaryCutoverGateResponse,
  verifyProductionCanaryCutoverGate,
} from "./verify-production-canary-cutover-gate.mjs";

const exactAggregate = Object.freeze({
  active_membership_count: "1",
  billing_customer_count: "0",
  canary_grant_fingerprint: "d".repeat(64),
  legacy_purchases_table: null,
  matching_canary_count: "1",
  membership_count: "1",
  production_canary_count: "1",
  subscription_count: "0",
});

test("accepts only one exact release-bound canary and zero billing state", () => {
  assert.deepEqual(verifyCanaryCutoverGateResponse([exactAggregate]), {
    verified: true,
    grantFingerprint: "d".repeat(64),
  });
});

test("fails closed on missing, multiple, malformed, or unexpected aggregate rows", () => {
  for (const response of [
    [],
    [exactAggregate, exactAggregate],
    [{ ...exactAggregate, unexpected: "0" }],
    [{ ...exactAggregate, matching_canary_count: 1 }],
  ]) {
    assert.throws(
      () => verifyCanaryCutoverGateResponse(response),
      /exactly one aggregate row|unexpected aggregate shape|exactly one active membership/u,
    );
  }
});

test("fails closed on billing evidence, legacy purchases, or another active membership", () => {
  for (const row of [
    { ...exactAggregate, billing_customer_count: "1" },
    { ...exactAggregate, subscription_count: "1" },
    { ...exactAggregate, legacy_purchases_table: "public.purchases" },
    { ...exactAggregate, active_membership_count: "2" },
    { ...exactAggregate, matching_canary_count: "0" },
    { ...exactAggregate, membership_count: "2" },
    { ...exactAggregate, production_canary_count: "2" },
    { ...exactAggregate, canary_grant_fingerprint: "not-a-sha256" },
  ]) {
    assert.throws(
      () => verifyCanaryCutoverGateResponse([row]),
      /globally empty|removed public\.purchases|exactly one active membership|SHA-256 digest/u,
    );
  }
});

test("uses a parameterized read-only query without returning UUIDs or rows", async () => {
  const calls = [];
  const releaseSha = "a".repeat(40);
  assert.deepEqual(
    await verifyProductionCanaryCutoverGate({
      projectRef: "abc123def456ghi789jk",
      accessToken: "test-token-never-printed",
      releaseSha,
      fetchImplementation: async (...arguments_) => {
        calls.push(arguments_);
        return { status: 201, redirected: false, json: async () => [exactAggregate] };
      },
    }),
    { verified: true, grantFingerprint: "d".repeat(64) },
  );

  const [, options] = calls[0];
  assert.deepEqual(JSON.parse(options.body), {
    query: canaryCutoverGateQuery,
    parameters: [releaseSha],
  });
  assert.match(canaryCutoverGateQuery, /from public\.entitlements/u);
  assert.match(canaryCutoverGateQuery, /source_type = 'production_canary'/u);
  assert.match(canaryCutoverGateQuery, /interval '2 hours'/u);
  assert.match(canaryCutoverGateQuery, /metadata ->> 'release_sha' = \$1/u);
  assert.match(canaryCutoverGateQuery, /from auth\.users canary_user/u);
  assert.match(canaryCutoverGateQuery, /canary_user\.is_anonymous is false/u);
  assert.match(canaryCutoverGateQuery, /extensions\.digest/u);
  assert.match(canaryCutoverGateQuery, /entitlement\.created_at/u);
  assert.match(canaryCutoverGateQuery, /entitlement\.updated_at/u);
  assert.doesNotMatch(canaryCutoverGateQuery, /select\s+user_id|select\s+source_id/iu);
});

test("binds the compatibility attestation to the exact release and canary row", () => {
  const releaseSha = "a".repeat(40);
  const grantFingerprint = "b".repeat(64);
  const attestationKey = "protected-test-key-that-is-not-production";
  const attestation = createCanaryCutoverAttestation({
    releaseSha,
    grantFingerprint,
    attestationKey,
  });
  assert.deepEqual(Object.keys(attestation).sort(), [
    "grantHmacSha256",
    "releaseSha",
    "version",
  ]);
  assert.match(attestation.grantHmacSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(verifyCanaryCutoverAttestation({
    value: attestation,
    releaseSha,
    grantFingerprint,
    attestationKey,
  }), { verified: true });

  for (const changed of [
    { releaseSha: "c".repeat(40), grantFingerprint },
    { releaseSha, grantFingerprint: "c".repeat(64) },
  ]) {
    assert.throws(
      () => verifyCanaryCutoverAttestation({
        value: attestation,
        ...changed,
        attestationKey,
      }),
      /invalid envelope|does not match/u,
    );
  }
  assert.throws(
    () => verifyCanaryCutoverAttestation({
      value: { ...attestation, unexpected: true },
      releaseSha,
      grantFingerprint,
      attestationKey,
    }),
    /invalid envelope/u,
  );
});

test("rejects an unbound or noncanonical release identifier before any request", async () => {
  let called = false;
  await assert.rejects(
    () => verifyProductionCanaryCutoverGate({
      projectRef: "abc123def456ghi789jk",
      accessToken: "test-token-never-printed",
      releaseSha: "main",
      fetchImplementation: async () => {
        called = true;
      },
    }),
    /40 lowercase hexadecimal/u,
  );
  assert.equal(called, false);
});
