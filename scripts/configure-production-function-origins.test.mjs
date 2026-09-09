import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  configureProductionFunctionOrigins,
  verifyProductionDomainPages,
} from "./configure-production-function-origins.mjs";
import {
  PRODUCTION_ALLOWED_SITE_URLS,
  PRODUCTION_SITE_ORIGINS,
  PRODUCTION_SITE_URL,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from "./production-auth-canary-policy.mjs";

const token = "test-only-management-token";
const secretsUrl = `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/secrets`;
const html = "<!doctype html><title>77-Day Dominion Challenge</title>";
const settings = {
  accessToken: token,
  projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
  publicSiteUrl: PRODUCTION_SITE_URL,
  allowedSiteUrls: PRODUCTION_ALLOWED_SITE_URLS,
};

function harness({ inventory = [], override } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const custom = await override?.(url, options);
    if (custom) return custom;
    if (url === secretsUrl) {
      if (options.method === "GET") return Response.json(inventory);
      assert.equal(options.method, "POST");
      return Response.json({}, { status: 201 });
    }
    if (url.includes("/functions/v1/share-snapshot")) {
      if (options.method === "GET") return new Response(`<a href="${PRODUCTION_SITE_URL}">Visit Dominion</a>`, { status: 404 });
      assert.equal(options.method, "OPTIONS");
      const origin = options.headers.Origin;
      const allowed = PRODUCTION_SITE_ORIGINS.includes(origin);
      return new Response(allowed ? "ok" : "origin not allowed", {
        status: allowed ? 200 : 403,
        headers: {
          ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }
    assert.equal(options.method, "GET");
    if (url.endsWith(".html")) return new Response(null, { status: 308, headers: { location: new URL(url).pathname.replace(/\.html$/, "") } });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  return { calls, fetchImpl };
}

test("only two fixed origin secrets are written after all public route and canonical redirect checks", async () => {
  const { calls, fetchImpl } = harness({ inventory: [{ name: "STRIPE_SECRET_KEY", value: "never-log-me" }] });
  assert.equal(await configureProductionFunctionOrigins({ ...settings, fetchImpl }), true);
  assert.equal(calls.length, 25);
  assert.equal(calls[15].url, secretsUrl);
  const write = calls[16];
  assert.equal(write.url, secretsUrl);
  assert.deepEqual(JSON.parse(write.options.body), [
    { name: "PUBLIC_SITE_URL", value: PRODUCTION_SITE_URL },
    { name: "PUBLIC_ALLOWED_SITE_URLS", value: PRODUCTION_ALLOWED_SITE_URLS },
  ]);
  for (const { url, options } of calls) {
    assert.equal(options.redirect, url.endsWith(".html") ? "manual" : "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url === secretsUrl) assert.equal(options.headers.Authorization, `Bearer ${token}`);
    else assert.ok(!JSON.stringify(options).includes(token));
  }
  assert.ok(calls.filter(({ options }) => options.method === "POST").every(({ url }) => url === secretsUrl));
});

test("legacy origin alias is aligned only when it already exists", async () => {
  const { calls, fetchImpl } = harness({ inventory: [{ name: "ALLOWED_SITE_ORIGINS" }, { name: "OTHER_SECRET" }] });
  await configureProductionFunctionOrigins({ ...settings, fetchImpl });
  assert.deepEqual(JSON.parse(calls[16].options.body).map(({ name }) => name), ["PUBLIC_SITE_URL", "PUBLIC_ALLOWED_SITE_URLS", "ALLOWED_SITE_ORIGINS"]);
  assert.equal(JSON.parse(calls[16].options.body)[2].value, PRODUCTION_ALLOWED_SITE_URLS);
});

test("wrong project, variables, token, or runtime fail before all requests", async () => {
  for (const invalid of [
    { projectRef: "another-project" },
    { publicSiteUrl: "https://untrusted.invalid" },
    { allowedSiteUrls: "https://*.77dominion.com" },
    { accessToken: "" },
    { accessToken: " token" },
    { accessToken: "token\n" },
    { fetchImpl: null },
  ]) {
    const { calls, fetchImpl } = harness();
    await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl, ...invalid }));
    assert.equal(calls.length, 0);
  }
});

test("wrong-site pages, bad TLS/network, bad type, bad title and redirects prevent configuration writes", async () => {
  for (const replacement of [
    () => new Response(`${html}different`, { headers: { "content-type": "text/html" } }),
    () => new Response(html, { headers: { "content-type": "text/plain" } }),
    () => new Response("<title>Unrelated</title>", { headers: { "content-type": "text/html" } }),
    () => new Response(null, { status: 301 }),
    () => { throw new Error(`network included ${token}`); },
  ]) {
    const { calls, fetchImpl } = harness({ override: (url) => url.startsWith(PRODUCTION_SITE_URL) ? replacement() : undefined });
    await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), (error) => !error.message.includes(token));
    assert.ok(calls.every(({ url }) => url !== secretsUrl));
  }
});

test("public verification is read-only and requires exact existing release bytes", async () => {
  const { calls, fetchImpl } = harness();
  await verifyProductionDomainPages({ fetchImpl });
  assert.equal(calls.length, 15);
  assert.ok(calls.every(({ options }) => options.method === "GET" && options.headers === undefined));
});

test("secret inventory errors prevent any write and do not leak response details", async () => {
  for (const response of [
    new Response(token, { status: 403 }),
    new Response(token, { status: 200 }),
    Response.json({ unexpected: token }),
    Response.json([{ value: token }]),
  ]) {
    const { calls, fetchImpl } = harness({ override: (url) => url === secretsUrl ? response : undefined });
    await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), (error) => !error.message.includes(token));
    assert.ok(calls.every(({ options }) => options.method !== "POST"));
  }
});

test("secret update failures do not continue or leak bodies", async () => {
  const { calls, fetchImpl } = harness({ override: (url, options) => url === secretsUrl && options.method === "POST" ? new Response(token, { status: 403 }) : undefined });
  await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), /origin update failed \(HTTP 403\)/);
  assert.equal(calls.length, 17);
});

test("CORS validation rejects blocked custom origins, wildcards, and missing headers", async () => {
  for (const response of [
    new Response("origin not allowed", { status: 403 }),
    new Response("ok", { headers: { "access-control-allow-origin": "*" } }),
    new Response("ok", { headers: { "access-control-allow-origin": PRODUCTION_SITE_URL } }),
  ]) {
    const { fetchImpl } = harness({ override: (_url, options) => options.method === "OPTIONS" ? response : undefined });
    await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), /Sharing preflight/);
  }
});

test("a previously allowed untrusted origin cannot survive the update unnoticed", async () => {
  const { fetchImpl } = harness({ override: (_url, options) => options.headers?.Origin === "https://untrusted.invalid" ? new Response("ok", { headers: { "access-control-allow-origin": "https://untrusted.invalid" } }) : undefined });
  await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), /Sharing preflight for https:\/\/untrusted.invalid failed/);
});

test("HTML callback redirects may not escape the exact approved origin or path", async () => {
  for (const location of ["https://untrusted.invalid/reset-password", "/login?next=evil", "/other", "//untrusted.invalid/login"]) {
    const { calls, fetchImpl } = harness({ override: (url) => url.endsWith(".html") ? new Response(null, { status: 308, headers: { location } }) : undefined });
    await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), /HTML redirect must stay/);
    assert.ok(calls.every(({ url }) => url !== secretsUrl));
  }
});

test("public share destination must reflect the new canonical origin", async () => {
  const { fetchImpl } = harness({ override: (url, options) => url.includes("/functions/") && options.method === "GET" ? new Response('<a href="https://77-dominion-live.pages.dev">Visit</a>', { status: 404 }) : undefined });
  await assert.rejects(configureProductionFunctionOrigins({ ...settings, fetchImpl }), /Public share destination does not use/);
});

test("the protected configuration workflow verifies pages and origins before changing Auth", async () => {
  const workflow = await readFile(new URL("../.github/workflows/configure-production-auth-canary.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: production-release/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /PUBLIC_ALLOWED_SITE_URLS: \$\{\{ vars.PUBLIC_ALLOWED_SITE_URLS \}\}/);
  assert.ok(workflow.indexOf("node scripts/configure-production-function-origins.mjs") < workflow.indexOf("node scripts/configure-production-auth-canary.mjs"));
  assert.doesNotMatch(workflow, /supabase db|functions deploy|secrets list|service_role|STRIPE_SECRET/);
});
