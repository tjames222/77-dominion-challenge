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

function normalizedProjectName(value) {
  const projectName = String(value || '');
  if (
    projectName.length < 1
    || projectName.length > 58
    || projectName !== projectName.trim()
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(projectName)
  ) {
    throw new Error(
      'CLOUDFLARE_PAGES_PROJECT must be a lowercase Pages project name of 1-58 letters, numbers, or hyphens.',
    );
  }
  return projectName;
}

function normalizedCreatePermission(value) {
  const permission = String(value || '');
  if (!permission) return false;
  if (permission === 'true') return true;
  if (permission === 'false') return false;
  throw new Error('CLOUDFLARE_ALLOW_PROJECT_CREATE must be exactly true or false.');
}

export function cloudflarePagesPolicyPatch(
  productionEnvironmentInput,
  { sourceType = 'github' } = {},
) {
  if (sourceType !== 'github' && sourceType !== null) {
    throw new Error('Cloudflare Pages project source must be GitHub or Direct Upload.');
  }
  const productionEnvironment = normalizedProductionEnvironment(
    productionEnvironmentInput,
  );
  return {
    production_branch: 'main',
    ...(sourceType === 'github'
      ? {
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
      }
      : {}),
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

export function cloudflarePagesPolicyErrors(
  project,
  productionEnvironmentInput,
  {
    projectName = CLOUDFLARE_PAGES_PROJECT,
    expectedSourceType = 'github',
  } = {},
) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return ['Cloudflare returned an invalid Pages project'];
  }

  const errors = [];
  const source = project.source;
  const sourceConfig = source?.config;
  const expectedProjectName = normalizedProjectName(projectName);
  const productionEnvironment = normalizedProductionEnvironment(
    productionEnvironmentInput,
  );
  const productionEnv = project.deployment_configs?.production?.env_vars;
  const previewEnv = project.deployment_configs?.preview?.env_vars;

  if (project.name !== expectedProjectName) {
    errors.push('Pages project name does not match the approved project');
  }
  if (project.production_branch !== 'main') {
    errors.push('production_branch must be main');
  }
  if (!Object.hasOwn(project, 'source')) {
    errors.push('Pages source field is missing');
  } else if (expectedSourceType === null && source !== null) {
    errors.push('Pages source must remain absent for Direct Upload');
  } else if (expectedSourceType === 'github' && source?.type !== 'github') {
    errors.push('Pages source must remain GitHub');
  }
  if (source?.type === 'github' && (
    !sourceConfig
    || typeof sourceConfig !== 'object'
    || Array.isArray(sourceConfig)
  )) {
    errors.push('Pages source configuration is missing');
  } else if (source?.type === 'github') {
    if (sourceConfig.deployments_enabled !== true) {
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
    throw new Error(`Cloudflare ${operation} failed${status}.`);
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

async function cloudflareRequest({
  fetchImpl,
  url,
  token,
  method,
  operation,
  body,
}) {
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
    throw new Error(`Unable to reach Cloudflare for the ${operation}.`);
  }
  return readCloudflareResult(response, operation);
}

function cloudflareTokenVerificationUrl({ accountId, apiToken }) {
  if (apiToken.startsWith('cfat_')) {
    return `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${accountId}/tokens/verify`;
  }
  return `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/user/tokens/verify`;
}

export async function configureCloudflarePagesPolicy({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  projectName = CLOUDFLARE_PAGES_PROJECT,
  allowProjectCreate = 'false',
  projectRef = process.env.SUPABASE_PROJECT_REF,
  supabaseUrl = process.env.VITE_SUPABASE_URL,
  publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  const normalizedToken = String(apiToken || '').trim();
  const normalizedPagesProject = normalizedProjectName(projectName);
  const mayCreateProject = normalizedCreatePermission(allowProjectCreate);
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

  const projectsUrl = `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${normalizedAccountId}`
    + '/pages/projects';
  const url = `${projectsUrl}/${normalizedPagesProject}`;
  const tokenVerificationUrl = cloudflareTokenVerificationUrl({
    accountId: normalizedAccountId,
    apiToken: normalizedToken,
  });

  await verifySupabasePublishableKey({
    fetchImpl,
    productionEnvironment,
  });

  const token = await cloudflareRequest({
    fetchImpl,
    url: tokenVerificationUrl,
    token: normalizedToken,
    method: 'GET',
    operation: 'API token verification',
  });
  if (token.status !== 'active') {
    throw new Error('Cloudflare API token is not active.');
  }

  let existingProject;
  try {
    existingProject = await cloudflareRequest({
      fetchImpl,
      url,
      token: normalizedToken,
      method: 'GET',
      operation: 'Pages project access preflight',
    });
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'Cloudflare Pages project access preflight failed (HTTP 403).'
    ) {
      throw new Error(
        'Cloudflare API token is active but cannot read the reviewed Pages project from the configured account. '
        + 'Confirm the token is scoped to the same account and has Account > Cloudflare Pages > Read or Edit.',
      );
    }
    if (
      error instanceof Error
      && error.message === 'Cloudflare Pages project access preflight failed (HTTP 404).'
    ) {
      if (!mayCreateProject) {
        throw new Error(
          'The reviewed Cloudflare Pages project does not exist in the configured account. '
          + 'Creation is disabled unless CLOUDFLARE_ALLOW_PROJECT_CREATE is exactly true.',
        );
      }
      existingProject = await cloudflareRequest({
        fetchImpl,
        url: projectsUrl,
        token: normalizedToken,
        method: 'POST',
        operation: 'Pages Direct Upload project creation',
        body: {
          name: normalizedPagesProject,
          production_branch: 'main',
        },
      });
    } else {
      throw error;
    }
  }
  if (existingProject.name !== normalizedPagesProject) {
    throw new Error('Cloudflare returned the wrong Pages project during the access preflight.');
  }
  if (!Object.hasOwn(existingProject, 'source')) {
    throw new Error('Cloudflare returned a Pages project without an explicit source contract.');
  }

  const sourceType = existingProject.source == null ? null : existingProject.source?.type;
  if (sourceType !== null && sourceType !== 'github') {
    throw new Error('Cloudflare Pages project source must be GitHub or Direct Upload.');
  }

  try {
    await cloudflareRequest({
      fetchImpl,
      url,
      token: normalizedToken,
      method: 'PATCH',
      operation: 'Pages project update',
      body: cloudflarePagesPolicyPatch(productionEnvironment, { sourceType }),
    });
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'Cloudflare Pages project update failed (HTTP 403).'
    ) {
      throw new Error(
        'Cloudflare API token can read the reviewed Pages project but cannot update it. '
        + 'Add Account > Cloudflare Pages > Edit (Pages Write) for the exact account to the token.',
      );
    }
    throw error;
  }
  const project = await cloudflareRequest({
    fetchImpl,
    url,
    token: normalizedToken,
    method: 'GET',
    operation: 'Pages project verification',
  });

  const errors = cloudflarePagesPolicyErrors(project, productionEnvironment, {
    projectName: normalizedPagesProject,
    expectedSourceType: sourceType,
  });
  if (errors.length) {
    throw new Error(`Cloudflare Pages project policy verification failed: ${errors.join('; ')}.`);
  }
  return true;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    await configureCloudflarePagesPolicy({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      projectName: process.env.CLOUDFLARE_PAGES_PROJECT ?? '',
      allowProjectCreate: process.env.CLOUDFLARE_ALLOW_PROJECT_CREATE,
      projectRef: process.env.SUPABASE_PROJECT_REF,
      supabaseUrl: process.env.VITE_SUPABASE_URL,
      publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
    console.log('Cloudflare Pages production and develop-preview policy is configured and verified.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloudflare Pages policy configuration failed.');
    process.exitCode = 1;
  }
}
