import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  PRODUCTION_ALLOWED_SITE_URLS,
  PRODUCTION_SITE_ORIGINS,
  PRODUCTION_SITE_URL,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from "./production-auth-canary-policy.mjs";

const PAGES_ORIGIN = "https://77-dominion-live.pages.dev";
const SECRETS_URL = `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/secrets`;
const SHARE_URL = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co/functions/v1/share-snapshot`;
const BLOCKED_ORIGINS = [
  "https://untrusted.invalid",
  "https://develop.77-dominion-live.pages.dev",
  "https://77-dominion-challenge.pages.dev",
  "http://localhost:5173",
];

async function request(fetchImpl, url, options, expectedStatus, stage) {
  let response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      ...options,
    });
  } catch {
    throw new Error(`${stage} request failed.`);
  }
  if (response?.status !== expectedStatus || response.redirected === true) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : "";
    throw new Error(`${stage} failed${status}.`);
  }
  return response;
}

async function readText(response, stage) {
  try {
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error();
    return body;
  } catch {
    throw new Error(`${stage} returned an invalid body.`);
  }
}

// Public TLS and byte-identity checks precede every configuration write. They
// never carry the Management API token and never open an existing share token.
export async function verifyProductionDomainPages({ fetchImpl = globalThis.fetch } = {}) {
  for (const route of ["/", "/login", "/reset-password"]) {
    let expectedDigest;
    for (const origin of [PAGES_ORIGIN, ...PRODUCTION_SITE_ORIGINS.filter((value) => value !== PAGES_ORIGIN)]) {
      const stage = `Production domain check for ${origin}${route}`;
      if (route !== "/") {
        // Pages canonicalizes .html links. Check the exact callback redirect
        // ourselves; never follow arbitrary locations or forward credentials.
        const redirectResponse = await request(fetchImpl, `${origin}${route}.html`, {
          method: "GET", redirect: "manual",
        }, 308, `${stage} HTML redirect`);
        let destination;
        try { destination = new URL(redirectResponse.headers.get("location"), `${origin}${route}.html`).href; } catch { /* fail closed below */ }
        if (destination !== `${origin}${route}`) throw new Error(`${stage} HTML redirect must stay on the exact approved route and origin.`);
        await redirectResponse.body?.cancel();
      }
      const response = await request(fetchImpl, `${origin}${route}`, { method: "GET" }, 200, stage);
      if (!/^text\/html(?:;|$)/i.test(response.headers.get("content-type") || "")) {
        throw new Error(`${stage} did not return HTML.`);
      }
      const body = await readText(response, stage);
      if (!/<title>[\s\S]*Dominion[\s\S]*<\/title>/i.test(body)) {
        throw new Error(`${stage} did not return the Dominion page.`);
      }
      const digest = createHash("sha256").update(body).digest("hex");
      if (expectedDigest === undefined) expectedDigest = digest;
      else if (digest !== expectedDigest) throw new Error(`${stage} differs from the existing production page.`);
    }
  }
  return true;
}

export async function verifyProductionFunctionOrigins({ fetchImpl = globalThis.fetch } = {}) {
  for (const origin of [...PRODUCTION_SITE_ORIGINS, ...BLOCKED_ORIGINS]) {
    const allowed = PRODUCTION_SITE_ORIGINS.includes(origin);
    const stage = `Sharing preflight for ${origin}`;
    const response = await request(fetchImpl, SHARE_URL, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,x-client-info,apikey,content-type",
      },
    }, allowed ? 200 : 403, stage);
    const returnedOrigin = response.headers.get("access-control-allow-origin");
    if (returnedOrigin !== (allowed ? origin : null)) throw new Error(`${stage} returned an unexpected allowed origin.`);
    if (allowed) {
      const methods = (response.headers.get("access-control-allow-methods") || "").split(",").map((value) => value.trim());
      const headers = (response.headers.get("access-control-allow-headers") || "").toLowerCase().split(",").map((value) => value.trim());
      if (!methods.includes("POST") || !["authorization", "x-client-info", "apikey", "content-type"].every((value) => headers.includes(value))) {
        throw new Error(`${stage} is missing required browser permissions.`);
      }
    }
  }
  const response = await request(fetchImpl, SHARE_URL, { method: "GET" }, 404, "Public share destination verification");
  const body = await readText(response, "Public share destination verification");
  if (!body.includes(`href="${PRODUCTION_SITE_URL}"`)) throw new Error("Public share destination does not use the approved production domain.");
  return true;
}

export async function configureProductionFunctionOrigins({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  publicSiteUrl = process.env.PUBLIC_SITE_URL,
  allowedSiteUrls = process.env.PUBLIC_ALLOWED_SITE_URLS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) throw new Error("SUPABASE_PROJECT_REF must remain the reviewed production project.");
  if (publicSiteUrl !== PRODUCTION_SITE_URL || allowedSiteUrls !== PRODUCTION_ALLOWED_SITE_URLS) {
    throw new Error("GitHub production URL variables must match the exact reviewed custom-domain policy.");
  }
  if (typeof accessToken !== "string" || !accessToken || accessToken !== accessToken.trim() || /[\u0000-\u001f\u007f]/u.test(accessToken)) {
    throw new Error("SUPABASE_ACCESS_TOKEN must be a non-empty token without surrounding whitespace.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible runtime is required.");
  await verifyProductionDomainPages({ fetchImpl });
  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}` };
  const inventoryResponse = await request(fetchImpl, SECRETS_URL, { method: "GET", headers }, 200, "Function secret-name inventory");
  let inventory;
  try { inventory = await inventoryResponse.json(); } catch { throw new Error("Function secret-name inventory returned invalid JSON."); }
  if (!Array.isArray(inventory) || inventory.some((item) => !item || typeof item.name !== "string")) {
    throw new Error("Function secret-name inventory returned an invalid shape.");
  }
  const secrets = [
    { name: "PUBLIC_SITE_URL", value: PRODUCTION_SITE_URL },
    { name: "PUBLIC_ALLOWED_SITE_URLS", value: PRODUCTION_ALLOWED_SITE_URLS },
  ];
  // A historical alias is unioned by the CORS helper. Align it only if present;
  // preserve every unrelated secret, including billing and provider settings.
  if (inventory.some((item) => item.name === "ALLOWED_SITE_ORIGINS")) {
    secrets.push({ name: "ALLOWED_SITE_ORIGINS", value: PRODUCTION_ALLOWED_SITE_URLS });
  }
  await request(fetchImpl, SECRETS_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(secrets),
  }, 201, "Production function origin update");
  await verifyProductionFunctionOrigins({ fetchImpl });
  return true;
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : "")) {
  try {
    await configureProductionFunctionOrigins();
    console.log("Existing production domains and exact sharing origins are configured and verified.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production domain configuration failed.");
    process.exitCode = 1;
  }
}
