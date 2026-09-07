import { pathToFileURL } from "node:url";

export const billingFunctions = Object.freeze([
  "cancel-membership",
  "create-checkout-session",
  "create-customer-portal-session",
]);
export const billingUnavailableMessage = "Billing is temporarily unavailable.";
export const billingGuardTimeoutMs = 15_000;
export const billingGuardMaxBodyBytes = 4_096;

function fail(message) {
  throw new Error(`Production billing guard verification failed: ${message}`);
}

function requireEnvironment(env) {
  const projectRef = env.SUPABASE_PROJECT_REF;
  if (typeof projectRef !== "string" || !/^[a-z0-9]{20}$/u.test(projectRef)) {
    fail("SUPABASE_PROJECT_REF is missing or malformed");
  }
  const supabaseUrl = `https://${projectRef}.supabase.co`;
  if (![supabaseUrl, `${supabaseUrl}/`].includes(env.VITE_SUPABASE_URL)) {
    fail("VITE_SUPABASE_URL must match the selected hosted project exactly");
  }
  if (env.BILLING_ENABLED !== "false") {
    fail("BILLING_ENABLED must be exactly false for this disabled-billing release");
  }
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof publishableKey !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/u.test(publishableKey)) {
    fail("VITE_SUPABASE_PUBLISHABLE_KEY must be a publishable API key, never a secret or user token");
  }
  let site;
  try {
    site = new URL(env.PUBLIC_SITE_URL);
  } catch {
    fail("PUBLIC_SITE_URL must be an HTTPS origin");
  }
  if (site.protocol !== "https:" || ![site.origin, `${site.origin}/`].includes(env.PUBLIC_SITE_URL)) {
    fail("PUBLIC_SITE_URL must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return { supabaseUrl, publishableKey, siteOrigin: site.origin };
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Do not inspect or expose remote content when reporting a status failure.
  }
}

async function readBoundedJson(response, label) {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    await discardBody(response);
    fail(`${label} did not return JSON`);
  }
  const reader = response.body?.getReader();
  if (!reader) fail(`${label} returned no JSON body`);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > billingGuardMaxBodyBytes) {
        await reader.cancel();
        fail(`${label} exceeded the response size limit`);
      }
      chunks.push(value);
    }
  } catch {
    // Never propagate a response/transport exception that may contain remote data.
    fail(`${label} body could not be read within the bounded response policy`);
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

export async function verifyProductionBillingGuards({
  env = process.env,
  fetchImplementation = globalThis.fetch,
} = {}) {
  const { supabaseUrl, publishableKey, siteOrigin } = requireEnvironment(env);
  if (typeof fetchImplementation !== "function") fail("a fetch implementation is required");

  // A publishable apikey is a gateway credential, not a signed-in user. Supabase
  // accepts it with verify_jwt=true for migration compatibility. Test the gateway
  // WITHOUT that key, then separately prove the disabled handler's exact contract.
  // https://supabase.com/docs/guides/functions/auth-headers
  const cases = [
    { name: "no-credentials", headers: {}, expectedStatus: 401 },
    { name: "invalid-bearer", headers: { Authorization: "Bearer deliberately-invalid-billing-smoke-token" }, expectedStatus: 401 },
    { name: "publishable-key-only", headers: { apikey: publishableKey }, expectedStatus: 503 },
  ];
  const verified = [];
  for (const functionName of billingFunctions) {
    for (const requestCase of cases) {
      const label = `${functionName}/${requestCase.name}`;
      let response;
      try {
        response = await fetchImplementation(`${supabaseUrl}/functions/v1/${functionName}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: siteOrigin,
            ...requestCase.headers,
          },
          body: "{}",
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(billingGuardTimeoutMs),
        });
      } catch {
        fail(`${label} request failed or timed out`);
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await discardBody(response);
        fail(`${label} returned a forbidden redirect`);
      }
      if (response.status !== requestCase.expectedStatus) {
        await discardBody(response);
        fail(`${label} expected HTTP ${requestCase.expectedStatus}; received HTTP ${response.status}`);
      }
      if (requestCase.name === "publishable-key-only") {
        const body = await readBoundedJson(response, label);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || body.error !== billingUnavailableMessage) {
          fail(`${label} did not match the exact disabled-billing response`);
        }
      } else {
        await discardBody(response);
      }
      verified.push({ function: functionName, case: requestCase.name, status: response.status });
    }
  }
  return { billingEnabled: false, verified };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) fail("this helper accepts environment inputs only");
    console.log(JSON.stringify(await verifyProductionBillingGuards()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
