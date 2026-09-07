import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  billingFunctions,
  billingGuardMaxBodyBytes,
  billingGuardTimeoutMs,
  billingUnavailableMessage,
  verifyProductionBillingGuards,
} from "./verify-production-billing-guards.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/billing-gateway-responses.json", import.meta.url), "utf8"));
const env = Object.freeze({
  SUPABASE_PROJECT_REF: "a".repeat(20),
  VITE_SUPABASE_URL: `https://${"a".repeat(20)}.supabase.co`,
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture-never-log-this-key",
  BILLING_ENABLED: "false",
  PUBLIC_SITE_URL: "https://77-dominion-live.pages.dev",
});
const privateRemoteData = "REMOTE-CONTENT-MUST-NEVER-BE-LOGGED";

function jsonResponse(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...extra,
  });
}

function fixtureFor(request) {
  if (request.headers.apikey) return fixtures.disabledBilling;
  if (request.headers.Authorization) return fixtures.invalidBearer;
  return fixtures.noCredentials;
}

function gateway({ change = () => null } = {}) {
  const calls = [];
  const fetchImplementation = async (url, request) => {
    calls.push({ url, request });
    const changed = change({ url, request, index: calls.length - 1 });
    if (changed) return changed;
    const fixture = fixtureFor(request);
    return jsonResponse(fixture.body, fixture.status);
  };
  return { calls, fetchImplementation };
}

test("all three deployed billing functions retain independent 401/401/exact-503 probes", async () => {
  const mock = gateway();
  const result = await verifyProductionBillingGuards({ env, ...mock });
  assert.deepEqual(result, {
    billingEnabled: false,
    verified: billingFunctions.flatMap((name) => [
      { function: name, case: "no-credentials", status: 401 },
      { function: name, case: "invalid-bearer", status: 401 },
      { function: name, case: "publishable-key-only", status: 503 },
    ]),
  });
  assert.equal(mock.calls.length, 9);
  for (const [index, { url, request }] of mock.calls.entries()) {
    assert.equal(url, `${env.VITE_SUPABASE_URL}/functions/v1/${billingFunctions[Math.floor(index / 3)]}`);
    assert.equal(request.method, "POST");
    assert.equal(request.body, "{}");
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.signal.aborted, false);
    const expectedHeaders = { "Content-Type": "application/json", Origin: env.PUBLIC_SITE_URL };
    if (index % 3 === 1) expectedHeaders.Authorization = "Bearer deliberately-invalid-billing-smoke-token";
    if (index % 3 === 2) expectedHeaders.apikey = env.VITE_SUPABASE_PUBLISHABLE_KEY;
    assert.deepEqual(request.headers, expectedHeaders);
  }
  assert.equal(billingGuardTimeoutMs, 15_000);
  assert.equal(billingGuardMaxBodyBytes, 4_096);
  assert.doesNotMatch(JSON.stringify(result), /sb_publishable_|REMOTE-CONTENT|Authorization|Bearer/u);
});

test("an origin's optional final slash is normalized without changing the selected host", async () => {
  const mock = gateway();
  await verifyProductionBillingGuards({ env: { ...env, VITE_SUPABASE_URL: `${env.VITE_SUPABASE_URL}/`, PUBLIC_SITE_URL: `${env.PUBLIC_SITE_URL}/` }, ...mock });
  assert.equal(mock.calls[0].url, `${env.VITE_SUPABASE_URL}/functions/v1/cancel-membership`);
  assert.equal(mock.calls[0].request.headers.Origin, env.PUBLIC_SITE_URL);
});

for (const [name, changes] of [
  ["missing project", { SUPABASE_PROJECT_REF: undefined }],
  ["project injection", { SUPABASE_PROJECT_REF: "wrong.example/secret" }],
  ["wrong project URL", { VITE_SUPABASE_URL: "https://example.com" }],
  ["URL credentials", { VITE_SUPABASE_URL: `https://user:password@${"a".repeat(20)}.supabase.co` }],
  ["URL query", { VITE_SUPABASE_URL: `${env.VITE_SUPABASE_URL}?leak=1` }],
  ["billing enabled", { BILLING_ENABLED: "true" }],
  ["missing billing flag", { BILLING_ENABLED: undefined }],
  ["secret key", { VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_must-not-be-sent" }],
  ["user token", { VITE_SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJub25lIn0.e30." }],
  ["key header injection", { VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a\r\nAuthorization: secret" }],
  ["missing key", { VITE_SUPABASE_PUBLISHABLE_KEY: undefined }],
  ["HTTP site", { PUBLIC_SITE_URL: "http://example.com" }],
  ["site credentials", { PUBLIC_SITE_URL: "https://user:password@example.com" }],
  ["site path", { PUBLIC_SITE_URL: "https://example.com/another" }],
  ["site query", { PUBLIC_SITE_URL: "https://example.com?secret=1" }],
  ["site fragment", { PUBLIC_SITE_URL: "https://example.com#secret" }],
]) {
  test(`${name} fails before any network request`, async () => {
    const mock = gateway();
    await assert.rejects(verifyProductionBillingGuards({ env: { ...env, ...changes }, ...mock }), /Production billing guard verification failed/u);
    assert.equal(mock.calls.length, 0);
  });
}

for (const index of [0, 1, 2]) {
  test(`a status mismatch in probe ${index + 1} fails closed without retry or response leakage`, async () => {
    const mock = gateway({ change: (call) => call.index === index ? jsonResponse({ error: privateRemoteData }, 200) : null });
    await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), (error) => {
      assert.match(error.message, /expected HTTP (?:401|503); received HTTP 200/u);
      assert.ok(!error.message.includes(privateRemoteData));
      assert.ok(!error.message.includes(env.VITE_SUPABASE_PUBLISHABLE_KEY));
      return true;
    });
    assert.equal(mock.calls.length, index + 1);
  });
}

test("JWT verification disabled at the gateway cannot masquerade as passing authentication guards", async () => {
  const mock = gateway({ change: () => jsonResponse(fixtures.disabledBilling.body, 503) });
  await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /no-credentials expected HTTP 401; received HTTP 503/u);
  assert.equal(mock.calls.length, 1);
});

test("the public API key case is not treated as an unauthenticated 401 gateway probe", async () => {
  const mock = gateway({ change: ({ index }) => index === 2 ? jsonResponse(fixtures.noCredentials.body, 401) : null });
  await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /publishable-key-only expected HTTP 503; received HTTP 401/u);
  assert.equal(mock.calls.length, 3);
});

for (const body of [
  null, [], "unavailable", 503, {}, { error: "Some other failure" },
  { error: billingUnavailableMessage, unexpected: privateRemoteData },
]) {
  test(`disabled billing rejects noncanonical JSON ${JSON.stringify(body)}`, async () => {
    const mock = gateway({ change: ({ index }) => index === 2 ? jsonResponse(body, 503) : null });
    await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /did not match the exact disabled-billing response/u);
    assert.equal(mock.calls.length, 3);
  });
}

test("invalid JSON is rejected without reflecting its contents", async () => {
  const mock = gateway({ change: ({ index }) => index === 2 ? new Response(privateRemoteData, { status: 503, headers: { "Content-Type": "application/json" } }) : null });
  await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /returned invalid JSON$/u);
});

test("a non-JSON 503 is not accepted as the disabled-billing response", async () => {
  const mock = gateway({ change: ({ index }) => index === 2 ? new Response(privateRemoteData, { status: 503 }) : null });
  await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /did not return JSON$/u);
});

test("missing and oversized JSON bodies fail closed with cancellation", async () => {
  for (const missing of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(billingGuardMaxBodyBytes + 1)); },
      cancel() { cancelled = true; },
    });
    const mock = gateway({ change: ({ index }) => index === 2 ? new Response(missing ? null : stream, { status: 503, headers: { "Content-Type": "application/json" } }) : null });
    await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), missing ? /returned no JSON body$/u : /bounded response policy$/u);
    if (!missing) assert.equal(cancelled, true);
    else await stream.cancel();
  }
});

test("remote stream errors are not reflected in verification errors", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error(privateRemoteData)); } });
  const mock = gateway({ change: ({ index }) => index === 2 ? new Response(body, { status: 503, headers: { "Content-Type": "application/json" } }) : null });
  await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /body could not be read within the bounded response policy$/u);
});

test("transport failures and timeouts have bounded safe errors and no retry", async () => {
  for (const error of [new Error(privateRemoteData), new DOMException(privateRemoteData, "TimeoutError")]) {
    let calls = 0;
    await assert.rejects(verifyProductionBillingGuards({ env, fetchImplementation: async () => { calls += 1; throw error; } }), /no-credentials request failed or timed out$/u);
    assert.equal(calls, 1);
  }
});

test("redirect statuses and already-followed redirect responses are always rejected", async () => {
  for (const response of [
    new Response(privateRemoteData, { status: 302, headers: { Location: "https://untrusted.example" } }),
    { ...jsonResponse(null, 401), status: 401, redirected: true, body: null },
  ]) {
    const mock = gateway({ change: () => response });
    await assert.rejects(verifyProductionBillingGuards({ env, ...mock }), /returned a forbidden redirect$/u);
    assert.equal(mock.calls.length, 1);
  }
});

test("both release paths run the same strict helper after deployment with JWT verification explicitly enabled", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  const compatibilityStart = workflow.indexOf("\n  compatibility-guards:");
  const rollbackStart = workflow.indexOf("\n  frontend-rollback-history:");
  const backendStart = workflow.indexOf("\n  backend:");
  const frontendStart = workflow.indexOf("\n  frontend:");
  assert.ok(compatibilityStart >= 0 && rollbackStart > compatibilityStart);
  assert.ok(backendStart > rollbackStart && frontendStart > backendStart);
  for (const job of [
    workflow.slice(compatibilityStart, rollbackStart),
    workflow.slice(backendStart, frontendStart),
  ]) {
    assert.equal(job.match(/node scripts\/verify-production-billing-guards\.mjs/gu)?.length, 1);
    assert.match(job, /BILLING_ENABLED: "false"/u);
    for (const name of billingFunctions) {
      const deploy = `supabase functions deploy ${name} --project-ref "$SUPABASE_PROJECT_REF"`;
      assert.ok(job.indexOf(deploy) >= 0);
      assert.ok(job.indexOf(deploy) < job.indexOf("node scripts/verify-production-billing-guards.mjs"));
      assert.doesNotMatch(job, new RegExp(`functions deploy ${name}[^\\n]*--no-verify-jwt`, "u"));
      assert.match(config, new RegExp(`\\[functions\\.${name}\\]\\s+verify_jwt = true(?:\\s|$)`, "u"));
    }
    assert.doesNotMatch(job, /billing_status/u);
  }
  assert.match(config, /\[functions\.stripe-webhook\]\s+verify_jwt = false/u);
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(ci, /pnpm run test:production-billing-guards/u);
  assert.equal(pkg.scripts["test:production-billing-guards"], "node --test scripts/verify-production-billing-guards.test.mjs");
});

test("the disabled response fixture matches the unchanged handler contract before user/Stripe work", () => {
  const billing = readFileSync(new URL("../supabase/functions/_shared/billing.ts", import.meta.url), "utf8");
  assert.ok(billing.includes(`billingUnavailableMessage = "${billingUnavailableMessage}"`));
  assert.deepEqual(fixtures.disabledBilling, { status: 503, body: { error: billingUnavailableMessage } });
  for (const name of billingFunctions) {
    const handler = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
    const guardCall = handler.indexOf("const unavailableResponse = billingUnavailableResponse(");
    const guardReturn = handler.indexOf("if (unavailableResponse) return unavailableResponse;");
    const requireUser = handler.indexOf("await dependencies.requireUser(req)");
    assert.ok(guardCall >= 0 && guardReturn > guardCall && requireUser > guardReturn);
  }
});

test("the CLI rejects arguments without logging their values or making a network request", () => {
  const result = spawnSync(process.execPath, [new URL("./verify-production-billing-guards.mjs", import.meta.url).pathname, privateRemoteData], { env: {}, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Production billing guard verification failed: this helper accepts environment inputs only");
});
