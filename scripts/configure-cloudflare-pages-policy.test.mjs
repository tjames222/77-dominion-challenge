import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLOUDFLARE_BUILD_PINS,
  CLOUDFLARE_PAGES_API_ORIGIN,
  CLOUDFLARE_PAGES_PROJECT,
  CLOUDFLARE_PREVIEW_MOCK_FLAGS,
  CLOUDFLARE_PRODUCTION_FLAGS,
  cloudflarePagesPolicyErrors,
  cloudflarePagesPolicyPatch,
  configureCloudflarePagesPolicy,
} from './configure-cloudflare-pages-policy.mjs';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';
import { DEVELOP_LIVE_CONNECTION_VARIABLES } from './validate-frontend-env.mjs';

const accountId = 'a'.repeat(32);
const apiToken = 'cloudflare-token-that-must-never-be-logged';
const activeToken = Object.freeze({
  id: 'b'.repeat(32),
  status: 'active',
});
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const productionEnvironment = Object.freeze({
  projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
  supabaseUrl: `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`,
  publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz012345',
});

function appliedEnvironment(environmentPatch) {
  return Object.fromEntries(
    Object.entries(environmentPatch).filter(([, value]) => value !== null),
  );
}

function response(result, overrides = {}) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async json() {
      return { success: true, result };
    },
    ...overrides,
  };
}

function validProject() {
  const patch = cloudflarePagesPolicyPatch(productionEnvironment);
  return {
    name: CLOUDFLARE_PAGES_PROJECT,
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
        env_vars: appliedEnvironment(patch.deployment_configs.production.env_vars),
      },
      preview: {
        env_vars: appliedEnvironment(patch.deployment_configs.preview.env_vars),
      },
    },
  };
}

test('policy patch disables only automatic production and restricts previews to develop mocks', () => {
  const patch = cloudflarePagesPolicyPatch(productionEnvironment);
  assert.equal(patch.production_branch, 'main');
  assert.deepEqual(patch.source, {
    type: 'github',
    config: {
      deployments_enabled: true,
      production_branch: 'main',
      production_deployments_enabled: false,
      preview_deployment_setting: 'custom',
      preview_branch_includes: ['develop'],
      preview_branch_excludes: [],
    },
  });
  for (const [name, value] of Object.entries({
    ...CLOUDFLARE_BUILD_PINS,
    ...CLOUDFLARE_PREVIEW_MOCK_FLAGS,
  })) {
    assert.deepEqual(patch.deployment_configs.preview.env_vars[name], {
      type: 'plain_text',
      value,
    });
  }
  for (const name of DEVELOP_LIVE_CONNECTION_VARIABLES) {
    assert.equal(patch.deployment_configs.preview.env_vars[name], null);
  }
  assert.equal(patch.deployment_configs.preview.env_vars.VITE_ENABLE_E2E_FIXTURES, null);

  const expectedProductionValues = {
    ...CLOUDFLARE_BUILD_PINS,
    ...CLOUDFLARE_PRODUCTION_FLAGS,
    SUPABASE_PROJECT_REF: productionEnvironment.projectRef,
    VITE_SUPABASE_URL: productionEnvironment.supabaseUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: productionEnvironment.publishableKey,
  };
  for (const [name, value] of Object.entries(expectedProductionValues)) {
    assert.deepEqual(patch.deployment_configs.production.env_vars[name], {
      type: 'plain_text',
      value,
    });
  }
  for (const name of [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_MEMBERSHIP_PRICE_ID',
    'BILLING_ENABLED',
    'VITE_ENABLE_E2E_FIXTURES',
  ]) {
    assert.equal(patch.deployment_configs.production.env_vars[name], null);
  }
});

test('configuration PATCHes the fixed project and then GET-verifies it', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === `${productionEnvironment.supabaseUrl}/auth/v1/settings`) {
      return response({});
    }
    if (url.endsWith('/user/tokens/verify')) {
      return response(activeToken);
    }
    return response(options.method === 'PATCH' ? {} : validProject());
  };

  await assert.doesNotReject(configureCloudflarePagesPolicy({
    accountId,
    apiToken,
    ...productionEnvironment,
    fetchImpl,
  }));

  const expectedUrl = `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${accountId}`
    + `/pages/projects/${CLOUDFLARE_PAGES_PROJECT}`;
  assert.equal(calls.length, 5);
  assert.equal(
    calls[0].url,
    `${productionEnvironment.supabaseUrl}/auth/v1/settings`,
  );
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.apikey, productionEnvironment.publishableKey);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.equal(
    calls[1].url,
    `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/user/tokens/verify`,
  );
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${apiToken}`);
  assert.equal(Object.hasOwn(calls[1].options, 'body'), false);
  assert.equal(calls[2].url, expectedUrl);
  assert.equal(calls[2].options.method, 'GET');
  assert.equal(calls[2].options.redirect, 'error');
  assert.equal(calls[2].options.headers.Authorization, `Bearer ${apiToken}`);
  assert.equal(Object.hasOwn(calls[2].options, 'body'), false);
  assert.equal(calls[3].url, expectedUrl);
  assert.equal(calls[3].options.method, 'PATCH');
  assert.equal(calls[3].options.redirect, 'error');
  assert.equal(calls[3].options.headers.Authorization, `Bearer ${apiToken}`);
  assert.deepEqual(
    JSON.parse(calls[3].options.body),
    cloudflarePagesPolicyPatch(productionEnvironment),
  );
  assert.equal(calls[4].url, expectedUrl);
  assert.equal(calls[4].options.method, 'GET');
  assert.equal(calls[4].options.redirect, 'error');
  assert.equal(Object.hasOwn(calls[4].options, 'body'), false);
});

test('account-owned tokens use the account verification endpoint', async () => {
  const accountToken = `cfat_${'c'.repeat(48)}`;
  const calls = [];
  await assert.doesNotReject(configureCloudflarePagesPolicy({
    accountId,
    apiToken: accountToken,
    ...productionEnvironment,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth/v1/settings')) return response({});
      if (url.endsWith('/tokens/verify')) return response(activeToken);
      return response(options.method === 'PATCH' ? {} : validProject());
    },
  }));

  assert.equal(
    calls[1].url,
    `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${accountId}/tokens/verify`,
  );
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${accountToken}`);
  assert.equal(
    calls.some(({ url }) => url.endsWith('/user/tokens/verify')),
    false,
  );
});

test('verification rejects production auto deploys, widened previews, and live preview values', () => {
  const project = validProject();
  project.source.config.production_deployments_enabled = true;
  project.source.config.preview_branch_includes = ['develop', 'feature/*'];
  project.deployment_configs.preview.env_vars.VITE_SUPABASE_URL = {
    type: 'plain_text',
    value: 'https://example.supabase.co',
  };

  assert.deepEqual(cloudflarePagesPolicyErrors(project, productionEnvironment), [
    'automatic production deployments must be disabled',
    'preview branch includes must contain only develop',
    'VITE_SUPABASE_URL must be absent from the preview environment',
  ]);
});

test('verification requires exact plaintext mock flags', () => {
  const project = validProject();
  project.deployment_configs.preview.env_vars.VITE_ENABLE_MOCKS = {
    type: 'secret_text',
    value: 'true',
  };
  delete project.deployment_configs.preview.env_vars.VITE_ENABLE_PUBLIC_SIGNUP;

  assert.deepEqual(cloudflarePagesPolicyErrors(project, productionEnvironment), [
    'VITE_ENABLE_MOCKS must be the approved plaintext mock value',
    'VITE_ENABLE_PUBLIC_SIGNUP must be the approved plaintext mock value',
  ]);
});

test('HTTP failures discard the response body and never expose it or the token', async () => {
  const secretResponse = 'secret response body that must never be logged';
  let bodyCancelled = false;
  let bodyRead = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/auth/v1/settings')) return response({});
    if (url.endsWith('/user/tokens/verify')) return response(activeToken);
    if (options.method === 'GET') return response(validProject());
    return response({}, {
      ok: false,
      status: 403,
      body: {
        async cancel() {
          bodyCancelled = true;
        },
      },
      async json() {
        bodyRead = true;
        throw new Error(secretResponse);
      },
    });
  };

  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken,
      ...productionEnvironment,
      fetchImpl,
    }),
    (error) => {
      assert.equal(
        error.message,
        'Cloudflare API token can read the reviewed Pages project but cannot update it. '
          + 'Add Account > Cloudflare Pages > Edit (Pages Write) for the exact account to the token.',
      );
      assert.equal(error.message.includes(apiToken), false);
      assert.equal(error.message.includes(secretResponse), false);
      return true;
    },
  );
  assert.equal(bodyCancelled, true);
  assert.equal(bodyRead, false);
});

test('an active token reports account scoping or Pages-read failures before mutation', async () => {
  const calls = [];
  let bodyCancelled = false;
  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken,
      ...productionEnvironment,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/auth/v1/settings')) return response({});
        if (url.endsWith('/user/tokens/verify')) return response(activeToken);
        return response({}, {
          ok: false,
          status: 403,
          body: {
            async cancel() {
              bodyCancelled = true;
            },
          },
        });
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        'Cloudflare API token is active but cannot read the reviewed Pages project from the configured account. '
          + 'Confirm the token is scoped to the same account and has Account > Cloudflare Pages > Read or Edit.',
      );
      assert.equal(error.message.includes(apiToken), false);
      return true;
    },
  );
  assert.equal(bodyCancelled, true);
  assert.equal(calls.length, 3);
  assert.equal(calls.some(({ options }) => options.method === 'PATCH'), false);
});

test('a disabled token fails before Pages project access', async () => {
  const calls = [];
  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken,
      ...productionEnvironment,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/auth/v1/settings')) return response({});
        return response({ ...activeToken, status: 'disabled' });
      },
    }),
    /Cloudflare API token is not active/u,
  );
  assert.equal(calls.length, 2);
});

test('redirects fail closed before their response body is read', async () => {
  let bodyRead = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/auth/v1/settings')) return response({});
    if (url.endsWith('/user/tokens/verify')) return response(activeToken);
    if (options.method === 'GET') return response(validProject());
    return response({}, {
      redirected: true,
      async json() {
        bodyRead = true;
        return { success: true, result: {} };
      },
    });
  };

  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken,
      ...productionEnvironment,
      fetchImpl,
    }),
    /redirected/u,
  );
  assert.equal(bodyRead, false);
});

test('Cloudflare application errors do not echo API error details', async () => {
  const secretResponse = 'sensitive Cloudflare API diagnostic';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/auth/v1/settings')) return response({});
    if (url.endsWith('/user/tokens/verify')) return response(activeToken);
    if (options.method === 'GET') return response(validProject());
    return response({}, {
      async json() {
        return {
          success: false,
          errors: [{ message: secretResponse }],
          result: null,
        };
      },
    });
  };

  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken,
      ...productionEnvironment,
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.message, 'Cloudflare returned an unsuccessful Pages project update response.');
      assert.equal(error.message.includes(secretResponse), false);
      return true;
    },
  );
});

test('invalid credentials fail before a request is made', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return response({});
  };

  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId: 'wrong',
      apiToken,
      ...productionEnvironment,
      fetchImpl,
    }),
    /32-character hexadecimal/u,
  );
  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken: '',
      ...productionEnvironment,
      fetchImpl,
    }),
    /CLOUDFLARE_API_TOKEN is required/u,
  );
  assert.equal(called, false);
});

test('verification requires exact production wiring and rejects Stripe or E2E values', () => {
  const project = validProject();
  project.deployment_configs.production.env_vars.VITE_SUPABASE_URL.value =
    'https://wrong-project.supabase.co';
  project.deployment_configs.production.env_vars.STRIPE_SECRET_KEY = {
    type: 'secret_text',
    value: '',
  };
  project.deployment_configs.production.env_vars.VITE_ENABLE_E2E_FIXTURES = {
    type: 'plain_text',
    value: 'false',
  };

  assert.deepEqual(cloudflarePagesPolicyErrors(project, productionEnvironment), [
    'VITE_SUPABASE_URL must be the approved plaintext production value',
    'STRIPE_SECRET_KEY must be absent from the production environment',
    'VITE_ENABLE_E2E_FIXTURES must be absent from the production environment',
  ]);
});

test('production Supabase ref, URL, and public key identity fail before Cloudflare', async () => {
  const jwtPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const legacyServiceRoleKey = `${jwtPart({ alg: 'HS256', typ: 'JWT' })}`
    + `.${jwtPart({ role: 'service_role', ref: productionEnvironment.projectRef })}`
    + `.${'s'.repeat(43)}`;
  const legacyWrongProjectAnonKey = `${jwtPart({ alg: 'HS256', typ: 'JWT' })}`
    + `.${jwtPart({ role: 'anon', ref: 'wrongprojectref00000' })}`
    + `.${'s'.repeat(43)}`;
  for (const invalidEnvironment of [
    { ...productionEnvironment, projectRef: 'short' },
    { ...productionEnvironment, supabaseUrl: `http://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co` },
    { ...productionEnvironment, publishableKey: 'sb_secret_never-accept-server-key' },
    { ...productionEnvironment, publishableKey: legacyServiceRoleKey },
    { ...productionEnvironment, publishableKey: legacyWrongProjectAnonKey },
  ]) {
    let called = false;
    await assert.rejects(
      configureCloudflarePagesPolicy({
        accountId,
        apiToken,
        ...invalidEnvironment,
        fetchImpl: async () => {
          called = true;
        },
      }),
      /Cloudflare production frontend configuration is invalid/u,
    );
    assert.equal(called, false);
  }
});

test('wrong-project keys, redirects, and network timeouts fail before Cloudflare mutation', async () => {
  for (const [proofResponse, message] of [
    [response({}, { ok: false, status: 401 }), /not accepted by the reviewed project/u],
    [response({}, { redirected: true, status: 302 }), /not accepted by the reviewed project/u],
  ]) {
    const calls = [];
    await assert.rejects(
      configureCloudflarePagesPolicy({
        accountId,
        apiToken,
        ...productionEnvironment,
        fetchImpl: async (url) => {
          calls.push(url);
          return proofResponse;
        },
      }),
      message,
    );
    assert.deepEqual(calls, [
      `${productionEnvironment.supabaseUrl}/auth/v1/settings`,
    ]);
  }

  const calls = [];
  await assert.rejects(
    configureCloudflarePagesPolicy({
      accountId,
      apiToken,
      ...productionEnvironment,
      fetchImpl: async (url) => {
        calls.push(url);
        throw new DOMException('timed out', 'TimeoutError');
      },
    }),
    /Unable to verify the production Supabase publishable key/u,
  );
  assert.deepEqual(calls, [
    `${productionEnvironment.supabaseUrl}/auth/v1/settings`,
  ]);
});

test('every protected release gates hosted work on the exact Cloudflare policy', () => {
  const deploy = readFileSync(
    `${repositoryRoot}.github/workflows/deploy.yml`,
    'utf8',
  );
  const standalone = readFileSync(
    `${repositoryRoot}.github/workflows/cloudflare-pages-policy.yml`,
    'utf8',
  );
  const policyStart = deploy.indexOf('  cloudflare-policy:');
  const canaryStart = deploy.indexOf('  canary-policy:');
  const compatibilityStart = deploy.indexOf('  compatibility-guards:');
  const rollbackStart = deploy.indexOf('  frontend-rollback-history:');
  const backendStart = deploy.indexOf('  backend:');
  const frontendStart = deploy.indexOf('  frontend:');
  assert.ok(
    policyStart !== -1
      && policyStart < canaryStart
      && canaryStart < compatibilityStart
      && compatibilityStart < rollbackStart
      && rollbackStart < backendStart
      && backendStart < frontendStart,
  );

  const policyJob = deploy.slice(policyStart, canaryStart);
  assert.match(policyJob, /needs: validation/u);
  assert.match(policyJob, /environment: production/u);
  assert.match(policyJob, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.match(policyJob, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
  for (const name of [
    'SUPABASE_PROJECT_REF',
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
  ]) {
    assert.match(policyJob, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
    assert.match(standalone, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
  }
  assert.match(policyJob, /node scripts\/configure-cloudflare-pages-policy\.mjs/u);

  for (const [start, end] of [
    [compatibilityStart, rollbackStart],
    [rollbackStart, backendStart],
    [backendStart, frontendStart],
  ]) {
    assert.match(deploy.slice(start, end), /- cloudflare-policy/u);
  }
  assert.match(
    deploy.slice(frontendStart),
    /- cloudflare-policy[\s\S]*needs\.cloudflare-policy\.result == 'success'/u,
  );
});
