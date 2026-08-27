import { pathToFileURL } from 'node:url';
import { CLOUDFLARE_PREVIEW_MOCK_FLAGS } from './normalize-cloudflare-frontend-env.mjs';
import { DEVELOP_LIVE_CONNECTION_VARIABLES } from './validate-frontend-env.mjs';

export const CLOUDFLARE_PAGES_PROJECT = '77-dominion-challenge';
export const CLOUDFLARE_PAGES_API_ORIGIN = 'https://api.cloudflare.com';
export { CLOUDFLARE_PREVIEW_MOCK_FLAGS };

const PREVIEW_FORBIDDEN_VARIABLES = Object.freeze([
  ...DEVELOP_LIVE_CONNECTION_VARIABLES,
  'VITE_ENABLE_E2E_FIXTURES',
]);

function exactStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function previewEnvironmentPatch() {
  const envVars = {};
  for (const [name, value] of Object.entries(CLOUDFLARE_PREVIEW_MOCK_FLAGS)) {
    envVars[name] = { type: 'plain_text', value };
  }
  for (const name of PREVIEW_FORBIDDEN_VARIABLES) {
    envVars[name] = null;
  }
  return envVars;
}

export function cloudflarePagesPolicyPatch() {
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
      preview: {
        env_vars: previewEnvironmentPatch(),
      },
    },
  };
}

export function cloudflarePagesPolicyErrors(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return ['Cloudflare returned an invalid Pages project'];
  }

  const errors = [];
  const source = project.source;
  const sourceConfig = source?.config;
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

  if (!previewEnv || typeof previewEnv !== 'object' || Array.isArray(previewEnv)) {
    errors.push('preview environment variables are missing');
  } else {
    for (const [name, expectedValue] of Object.entries(CLOUDFLARE_PREVIEW_MOCK_FLAGS)) {
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
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  const normalizedToken = String(apiToken || '').trim();

  if (!/^[a-f0-9]{32}$/iu.test(normalizedAccountId)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.');
  }
  if (!normalizedToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to configure the Pages project.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch-compatible runtime is required to configure the Pages project.');
  }

  const url = `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${normalizedAccountId}`
    + `/pages/projects/${CLOUDFLARE_PAGES_PROJECT}`;

  await cloudflareRequest({
    fetchImpl,
    url,
    token: normalizedToken,
    method: 'PATCH',
    body: cloudflarePagesPolicyPatch(),
  });
  const project = await cloudflareRequest({
    fetchImpl,
    url,
    token: normalizedToken,
    method: 'GET',
  });

  const errors = cloudflarePagesPolicyErrors(project);
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
