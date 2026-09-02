const AUTH_CONFIG_BASE_URL = "https://api.supabase.com/v1/projects";
const REQUEST_TIMEOUT_MS = 20_000;

export const PRODUCTION_SUPABASE_PROJECT_REF = "mimolwojppbtsbvtqwpo";
export const PRODUCTION_SITE_URL = "https://77-dominion-live.pages.dev";
export const PRODUCTION_RECOVERY_REDIRECT_URL =
  `${PRODUCTION_SITE_URL}/reset-password.html`;

export const CLOSED_AUTH_CONFIG_PATCH = Object.freeze({
  disable_signup: true,
  external_anonymous_users_enabled: false,
  site_url: PRODUCTION_SITE_URL,
  uri_allow_list: PRODUCTION_RECOVERY_REDIRECT_URL,
});

function requireAccessToken(accessToken) {
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken !== accessToken.trim() ||
    /[\u0000-\u001f\u007f]/u.test(accessToken)
  ) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN must be a non-empty token without surrounding whitespace.",
    );
  }
}

function requireProductionProjectRef(projectRef) {
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new Error(
      `SUPABASE_PROJECT_REF must be the reviewed production project ${PRODUCTION_SUPABASE_PROJECT_REF}.`,
    );
  }
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "A Fetch-compatible runtime is required for the Auth canary policy.",
    );
  }
}

function authConfigUrl(projectRef) {
  return `${AUTH_CONFIG_BASE_URL}/${encodeURIComponent(projectRef)}/config/auth`;
}

function safeHttpStatus(response) {
  const status = response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? ` (HTTP ${status})`
    : "";
}

function requestOptions(method, accessToken, signal) {
  const options = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(method === "PATCH" ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
    redirect: "error",
  };

  if (method === "PATCH") {
    options.body = JSON.stringify(CLOSED_AUTH_CONFIG_PATCH);
  }
  if (signal !== undefined) {
    options.signal = signal;
  }

  return options;
}

async function requestAuthConfig({
  accessToken,
  fetchImpl,
  method,
  projectRef,
  signalFactory,
  stage,
}) {
  let response;
  try {
    response = await fetchImpl(
      authConfigUrl(projectRef),
      requestOptions(method, accessToken, signalFactory()),
    );
  } catch {
    throw new Error(`Supabase Auth configuration ${stage} request failed.`);
  }

  // The documented Management API contract returns 200 for both operations.
  // `redirect: "error"` rejects redirects in native fetch; the explicit flag
  // also keeps injected test/fallback Fetch implementations fail-closed.
  if (response?.status !== 200 || response.redirected === true) {
    throw new Error(
      `Supabase Auth configuration ${stage} failed${safeHttpStatus(response)}.`,
    );
  }

  return response;
}

export function productionAuthCanaryErrors(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["Supabase returned an invalid Auth configuration response"];
  }

  const errors = [];
  if (config.disable_signup !== true) {
    errors.push("Supabase Auth disable_signup must be true");
  }
  if (config.external_anonymous_users_enabled !== false) {
    errors.push(
      "Supabase Auth external_anonymous_users_enabled must be false",
    );
  }
  if (config.site_url !== PRODUCTION_SITE_URL) {
    errors.push("Supabase Auth site_url must be the reviewed production origin");
  }
  if (config.uri_allow_list !== PRODUCTION_RECOVERY_REDIRECT_URL) {
    errors.push(
      "Supabase Auth uri_allow_list must contain only the reviewed recovery redirect",
    );
  }
  return errors;
}

function validateInputs({ accessToken, fetchImpl, projectRef }) {
  requireAccessToken(accessToken);
  requireProductionProjectRef(projectRef);
  requireFetch(fetchImpl);
}

function defaultSignalFactory() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export async function verifyProductionAuthCanary({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  fetchImpl = globalThis.fetch,
  signalFactory = defaultSignalFactory,
} = {}) {
  validateInputs({ accessToken, fetchImpl, projectRef });
  if (typeof signalFactory !== "function") {
    throw new Error("An Auth policy request signal factory is required.");
  }

  const response = await requestAuthConfig({
    accessToken,
    fetchImpl,
    method: "GET",
    projectRef,
    signalFactory,
    stage: "verification",
  });

  let config;
  try {
    config = await response.json();
  } catch {
    throw new Error("Supabase returned an invalid Auth configuration response.");
  }

  const errors = productionAuthCanaryErrors(config);
  if (errors.length > 0) {
    throw new Error(`Production canary is not closed: ${errors.join("; ")}.`);
  }

  return true;
}

export async function configureProductionAuthCanary({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  fetchImpl = globalThis.fetch,
  signalFactory = defaultSignalFactory,
} = {}) {
  validateInputs({ accessToken, fetchImpl, projectRef });
  if (typeof signalFactory !== "function") {
    throw new Error("An Auth policy request signal factory is required.");
  }

  await requestAuthConfig({
    accessToken,
    fetchImpl,
    method: "PATCH",
    projectRef,
    signalFactory,
    stage: "update",
  });

  return verifyProductionAuthCanary({
    accessToken,
    projectRef,
    fetchImpl,
    signalFactory,
  });
}
