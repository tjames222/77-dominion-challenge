import assert from "node:assert/strict";
import test from "node:test";
import {
  canaryCutoverGateQuery,
  verifyCanaryCutoverGateResponse,
  verifyProductionCanaryCutoverGate,
} from "./verify-production-canary-cutover-gate.mjs";

const exactAggregate = Object.freeze({
  active_membership_count: "1",
  billing_customer_count: "0",
  legacy_purchases_table: null,
  matching_canary_count: "1",
  membership_count: "1",
  production_canary_count: "1",
  subscription_count: "0",
});

test("accepts only one exact release-bound canary and zero billing state", () => {
  assert.deepEqual(verifyCanaryCutoverGateResponse([exactAggregate]), {
    verified: true,
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
  ]) {
    assert.throws(
      () => verifyCanaryCutoverGateResponse([row]),
      /globally empty|removed public\.purchases|exactly one active membership/u,
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
    { verified: true },
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
  assert.doesNotMatch(canaryCutoverGateQuery, /select\s+user_id|select\s+source_id/iu);
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
