import { pathToFileURL } from 'node:url';
import { CLOUDFLARE_PREVIEW_MOCK_FLAGS } from './normalize-cloudflare-frontend-env.mjs';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';
import { DEVELOP_LIVE_CONNECTION_VARIABLES } from './validate-frontend-env.mjs';

export const CLOUDFLARE_PAGES_PROJECT = '77-dominion-challenge';
export const CLOUDFLARE_PAGES_API_ORIGIN = 'https://api.cloudflare.com';
export { CLOUDFLARE_PREVIEW_MOCK_FLAGS };

export const CLOUDFLARE_BUILD_PINS = Object.freeze({
  NODE_VERSION: '22',
  PNPM_VERSION: '10.17.1',
});

export const CLOUDFLARE_PRODUCTION_FLAGS = Object.freeze({
  VITE_ENABLE_MOCKS: 'false',
  VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false',
  VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
  VITE_ENABLE_GROUP_INTEGRATIONS: 'false',
  VITE_ENABLE_BILLING: 'false',
  VITE_ENABLE_PUBLIC_SIGNUP: 'false',
});

const PRODUCTION_LIVE_VARIABLES = Object.freeze([
  'SUPABASE_PROJECT_REF',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
]);

const PREVIEW_FORBIDDEN_VARIABLES = Object.freeze([
  ...DEVELOP_LIVE_CONNECTION_VARIABLES,
  'VITE_ENABLE_E2E_FIXTURES',
]);

const PRODUCTION_FORBIDDEN_VARIABLES = Object.freeze([
  ...new Set([
    ...DEVELOP_LIVE_CONNECTION_VARIABLES.filter((name) =>
      !PRODUCTION_LIVE_VARIABLES.includes(name)
    ),
    'VITE_ENABLE_E2E_FIXTURES',
  ]),
]);

function exactStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function previewEnvironmentPatch() {
  const envVars = {};
  for (const [name, value] of Object.entries({
    ...CLOUDFLARE_BUILD_PINS,
    ...CLOUDFLARE_PREVIEW_MOCK_FLAGS,
  })) {
    envVars[name] = { type: 'plain_text', value };
  }
  for (const name of PREVIEW_FORBIDDEN_VARIABLES) {
    envVars[name] = null;
  }
  return envVars;
}

function plainTextVariables(values) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      { type: 'plain_text', value },
    ]),
  );
}

function productionEnvironmentPatch(productionEnvironment) {
  const envVars = plainTextVariables({
    ...CLOUDFLARE_BUILD_PINS,
    ...CLOUDFLARE_PRODUCTION_FLAGS,
    SUPABASE_PROJECT_REF: productionEnvironment.projectRef,
    VITE_SUPABASE_URL: productionEnvironment.supabaseUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: productionEnvironment.publishableKey,
  });
  for (const name of PRODUCTION_FORBIDDEN_VARIABLES) {
    envVars[name] = null;
  }
  return envVars;
}

function normalizedProductionEnvironment({
  projectRef,
  supabaseUrl,
  publishableKey,
} = {}) {
  return {
    projectRef: String(projectRef || '').trim(),
    supabaseUrl: String(supabaseUrl || '').trim(),
    publishableKey: String(publishableKey || '').trim(),
  };
}

function productionEnvironmentErrors(productionEnvironment) {
  const errors = [];
  if (productionEnvironment.projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    errors.push(`SUPABASE_PROJECT_REF must be the reviewed production project ${PRODUCTION_SUPABASE_PROJECT_REF}`);
  }
  if (
    productionEnvironment.supabaseUrl
      !== `https://${productionEnvironment.projectRef}.supabase.co`
  ) {
    errors.push('VITE_SUPABASE_URL must exactly match SUPABASE_PROJECT_REF');
  }
  const publishableKey = productionEnvironment.publishableKey;
  const newPublishableKey = /^sb_publishable_[A-Za-z0-9_-]{20,}$/u.test(
    publishableKey,
  );
  let legacyAnonKey = false;
  if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/u.test(publishableKey)) {
    try {
      const payload = JSON.parse(
        Buffer.from(publishableKey.split('.')[1], 'base64url').toString('utf8'),
      );
      legacyAnonKey = Boolean(
        payload
        && typeof payload === 'object'
        && !Array.isArray(payload)
        && payload.role === 'anon'
        && payload.ref === productionEnvironment.projectRef,
      );
    } catch {
      legacyAnonKey = false;
    }
  }
  if (!newPublishableKey && !legacyAnonKey) {
    errors.push('VITE_SUPABASE_PUBLISHABLE_KEY must have a publishable-key or legacy anon-JWT shape');
  }
  return errors;
}

async function verifySupabasePublishableKey({
  fetchImpl,
  productionEnvironment,
}) {
  let response;
  try {
    response = await fetchImpl(
      `${productionEnvironment.supabaseUrl}/auth/v1/settings`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          apikey: productionEnvironment.publishableKey,
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error('Unable to verify the production Supabase publishable key.');
  }
  if (
    response?.redirected
    || (response?.status >= 300 && response?.status < 400)
    || response?.status !== 200
    || response?.ok !== true
  ) {
    await cancelResponseBody(response);
    throw new Error('The production Supabase publishable key was not accepted by the reviewed project.');
  }
  await cancelResponseBody(response);
}

export function cloudflarePagesPolicyPatch(productionEnvironmentInput) {
  const productionEnvironment = normalizedProductionEnvironment(
    productionEnvironmentInput,
  );
  return {
    production_branch: 'main',
    source: {
      type: 'github',
      config: {
        deployments_enabled: true,
        production_branch: 'main',
        production_deployments_enabled: false,
        preview_deployment_setting: 'custom',
        preview_branch_includes: ['develop'],
        preview_branch_excludes: [],
      },
    },
    deployment_configs: {
      production: {
        env_vars: productionEnvironmentPatch(productionEnvironment),
      },
      preview: {
        env_vars: previewEnvironmentPatch(),
      },
    },
  };
}

export function cloudflarePagesPolicyErrors(project, productionEnvironmentInput) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return ['Cloudflare returned an invalid Pages project'];
  }

  const errors = [];
  const source = project.source;
  const sourceConfig = source?.config;
  const productionEnvironment = normalizedProductionEnvironment(
    productionEnvironmentInput,
  );
  const productionEnv = project.deployment_configs?.production?.env_vars;
  const previewEnv = project.deployment_configs?.preview?.env_vars;

  if (project.name !== CLOUDFLARE_PAGES_PROJECT) {
    errors.push('Pages project name does not match the approved project');
  }
  if (project.production_branch !== 'main') {
    errors.push('production_branch must be main');
  }
  if (source?.type !== 'github') {
    errors.push('Pages source must remain GitHub');
  }
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) {
    errors.push('Pages source configuration is missing');
  } else {
    if (sourceConfig.deployments_enabled === false) {
      errors.push('Git deployments must remain enabled for the develop preview');
    }
    if (sourceConfig.production_branch !== 'main') {
      errors.push('source production_branch must be main');
    }
    if (sourceConfig.production_deployments_enabled !== false) {
      errors.push('automatic production deployments must be disabled');
    }
    if (sourceConfig.preview_deployment_setting !== 'custom') {
      errors.push('preview deployment setting must be custom');
    }
    if (!exactStringArray(sourceConfig.preview_branch_includes, ['develop'])) {
      errors.push('preview branch includes must contain only develop');
    }
    if (!exactStringArray(sourceConfig.preview_branch_excludes, [])) {
      errors.push('preview branch excludes must be empty');
    }
  }

  if (!productionEnv || typeof productionEnv !== 'object' || Array.isArray(productionEnv)) {
    errors.push('production environment variables are missing');
  } else {
    const expectedProductionValues = {
      ...CLOUDFLARE_BUILD_PINS,
      ...CLOUDFLARE_PRODUCTION_FLAGS,
      SUPABASE_PROJECT_REF: productionEnvironment.projectRef,
      VITE_SUPABASE_URL: productionEnvironment.supabaseUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: productionEnvironment.publishableKey,
    };
    for (const [name, expectedValue] of Object.entries(expectedProductionValues)) {
      const entry = productionEnv[name];
      if (
        !entry
        || typeof entry !== 'object'
        || entry.type !== 'plain_text'
        || entry.value !== expectedValue
      ) {
        errors.push(`${name} must be the approved plaintext production value`);
      }
    }
    const approvedProductionNames = new Set(Object.keys(expectedProductionValues));
    for (const name of Object.keys(productionEnv)) {
      if (!approvedProductionNames.has(name)) {
        errors.push(`${name} must be absent from the production environment`);
      }
    }
  }

  if (!previewEnv || typeof previewEnv !== 'object' || Array.isArray(previewEnv)) {
    errors.push('preview environment variables are missing');
  } else {
    const expectedPreviewValues = {
      ...CLOUDFLARE_BUILD_PINS,
      ...CLOUDFLARE_PREVIEW_MOCK_FLAGS,
    };
    for (const [name, expectedValue] of Object.entries(expectedPreviewValues)) {
      const entry = previewEnv[name];
      if (
        !entry
        || typeof entry !== 'object'
        || entry.type !== 'plain_text'
        || entry.value !== expectedValue
      ) {
        errors.push(`${name} must be the approved plaintext mock value`);
      }
    }
    for (const name of PREVIEW_FORBIDDEN_VARIABLES) {
      if (Object.hasOwn(previewEnv, name)) {
        errors.push(`${name} must be absent from the preview environment`);
      }
    }
    const approvedPreviewNames = new Set(Object.keys(expectedPreviewValues));
    for (const name of Object.keys(previewEnv)) {
      if (!approvedPreviewNames.has(name) && !PREVIEW_FORBIDDEN_VARIABLES.includes(name)) {
        errors.push(`${name} must be absent from the preview environment`);
      }
    }
  }

  return errors;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response body is deliberately ignored on every failed request.
  }
}

async function readCloudflareResult(response, operation) {
  if (response?.redirected || (response?.status >= 300 && response?.status < 400)) {
    await cancelResponseBody(response);
    throw new Error(`Cloudflare refused the ${operation} request because it redirected.`);
  }
  if (!response?.ok) {
    await cancelResponseBody(response);
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    throw new Error(`Cloudflare Pages project ${operation} failed${status}.`);
  }

  const contentType = response.headers?.get?.('content-type');
  if (typeof contentType === 'string' && !contentType.toLowerCase().includes('application/json')) {
    await cancelResponseBody(response);
    throw new Error(`Cloudflare returned a non-JSON ${operation} response.`);
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`Cloudflare returned an invalid ${operation} response.`);
  }
  if (
    !envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || envelope.success !== true
    || !envelope.result
    || typeof envelope.result !== 'object'
    || Array.isArray(envelope.result)
  ) {
    throw new Error(`Cloudflare returned an unsuccessful ${operation} response.`);
  }
  return envelope.result;
}

async function cloudflareRequest({ fetchImpl, url, token, method, body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Unable to reach Cloudflare for the Pages project ${method === 'GET' ? 'verification' : 'update'}.`);
  }
  return readCloudflareResult(response, method === 'GET' ? 'verification' : 'update');
}

export async function configureCloudflarePagesPolicy({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  supabaseUrl = process.env.VITE_SUPABASE_URL,
  publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  const normalizedToken = String(apiToken || '').trim();
  const productionEnvironment = normalizedProductionEnvironment({
    projectRef,
    supabaseUrl,
    publishableKey,
  });

  if (!/^[a-f0-9]{32}$/iu.test(normalizedAccountId)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.');
  }
  if (!normalizedToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to configure the Pages project.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch-compatible runtime is required to configure the Pages project.');
  }
  const environmentErrors = productionEnvironmentErrors(productionEnvironment);
  if (environmentErrors.length) {
    throw new Error(`Cloudflare production frontend configuration is invalid: ${environmentErrors.join(', ')}.`);
  }

  const url = `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${normalizedAccountId}`
    + `/pages/projects/${CLOUDFLARE_PAGES_PROJECT}`;

  await verifySupabasePublishableKey({
    fetchImpl,
    productionEnvironment,
  });
  await cloudflareRequest({
    fetchImpl,
    url,
    token: normalizedToken,
    method: 'PATCH',
    body: cloudflarePagesPolicyPatch(productionEnvironment),
  });
  const project = await cloudflareRequest({
    fetchImpl,
    url,
    token: normalizedToken,
    method: 'GET',
  });

  const errors = cloudflarePagesPolicyErrors(project, productionEnvironment);
  if (errors.length) {
    throw new Error(`Cloudflare Pages project policy verification failed: ${errors.join('; ')}.`);
  }
  return true;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    await configureCloudflarePagesPolicy();
    console.log('Cloudflare Pages production and develop-preview policy is configured and verified.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloudflare Pages policy configuration failed.');
    process.exitCode = 1;
  }
}
