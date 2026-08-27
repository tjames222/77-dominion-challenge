import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUDFLARE_PAGES_API_ORIGIN,
  CLOUDFLARE_PAGES_PROJECT,
  CLOUDFLARE_PREVIEW_MOCK_FLAGS,
  cloudflarePagesPolicyErrors,
  cloudflarePagesPolicyPatch,
  configureCloudflarePagesPolicy,
} from './configure-cloudflare-pages-policy.mjs';
import { DEVELOP_LIVE_CONNECTION_VARIABLES } from './validate-frontend-env.mjs';

const accountId = 'a'.repeat(32);
const apiToken = 'cloudflare-token-that-must-never-be-logged';

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
      preview: {
        env_vars: Object.fromEntries(
          Object.entries(CLOUDFLARE_PREVIEW_MOCK_FLAGS).map(([name, value]) => [
            name,
            { type: 'plain_text', value },
          ]),
        ),
      },
    },
  };
}

test('policy patch disables only automatic production and restricts previews to develop mocks', () => {
  const patch = cloudflarePagesPolicyPatch();
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
  for (const [name, value] of Object.entries(CLOUDFLARE_PREVIEW_MOCK_FLAGS)) {
    assert.deepEqual(patch.deployment_configs.preview.env_vars[name], {
      type: 'plain_text',
      value,
    });
  }
  for (const name of DEVELOP_LIVE_CONNECTION_VARIABLES) {
    assert.equal(patch.deployment_configs.preview.env_vars[name], null);
  }
  assert.equal(patch.deployment_configs.preview.env_vars.VITE_ENABLE_E2E_FIXTURES, null);
});

test('configuration PATCHes the fixed project and then GET-verifies it', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(options.method === 'PATCH' ? {} : validProject());
  };

  await assert.doesNotReject(configureCloudflarePagesPolicy({
    accountId,
    apiToken,
    fetchImpl,
  }));

  const expectedUrl = `${CLOUDFLARE_PAGES_API_ORIGIN}/client/v4/accounts/${accountId}`
    + `/pages/projects/${CLOUDFLARE_PAGES_PROJECT}`;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, expectedUrl);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${apiToken}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), cloudflarePagesPolicyPatch());
  assert.equal(calls[1].url, expectedUrl);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(Object.hasOwn(calls[1].options, 'body'), false);
});

test('verification rejects production auto deploys, widened previews, and live preview values', () => {
  const project = validProject();
  project.source.config.production_deployments_enabled = true;
  project.source.config.preview_branch_includes = ['develop', 'feature/*'];
  project.deployment_configs.preview.env_vars.VITE_SUPABASE_URL = {
    type: 'plain_text',
    value: 'https://example.supabase.co',
  };

  assert.deepEqual(cloudflarePagesPolicyErrors(project), [
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

  assert.deepEqual(cloudflarePagesPolicyErrors(project), [
    'VITE_ENABLE_MOCKS must be the approved plaintext mock value',
    'VITE_ENABLE_PUBLIC_SIGNUP must be the approved plaintext mock value',
  ]);
});

test('HTTP failures discard the response body and never expose it or the token', async () => {
  const secretResponse = 'secret response body that must never be logged';
  let bodyCancelled = false;
  let bodyRead = false;
  const fetchImpl = async () => response({}, {
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

  await assert.rejects(
    configureCloudflarePagesPolicy({ accountId, apiToken, fetchImpl }),
    (error) => {
      assert.equal(error.message, 'Cloudflare Pages project update failed (HTTP 403).');
      assert.equal(error.message.includes(apiToken), false);
      assert.equal(error.message.includes(secretResponse), false);
      return true;
    },
  );
  assert.equal(bodyCancelled, true);
  assert.equal(bodyRead, false);
});

test('redirects fail closed before their response body is read', async () => {
  let bodyRead = false;
  const fetchImpl = async () => response({}, {
    redirected: true,
    async json() {
      bodyRead = true;
      return { success: true, result: {} };
    },
  });

  await assert.rejects(
    configureCloudflarePagesPolicy({ accountId, apiToken, fetchImpl }),
    /redirected/u,
  );
  assert.equal(bodyRead, false);
});

test('Cloudflare application errors do not echo API error details', async () => {
  const secretResponse = 'sensitive Cloudflare API diagnostic';
  const fetchImpl = async () => response({}, {
    async json() {
      return {
        success: false,
        errors: [{ message: secretResponse }],
        result: null,
      };
    },
  });

  await assert.rejects(
    configureCloudflarePagesPolicy({ accountId, apiToken, fetchImpl }),
    (error) => {
      assert.equal(error.message, 'Cloudflare returned an unsuccessful update response.');
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
    configureCloudflarePagesPolicy({ accountId: 'wrong', apiToken, fetchImpl }),
    /32-character hexadecimal/u,
  );
  await assert.rejects(
    configureCloudflarePagesPolicy({ accountId, apiToken: '', fetchImpl }),
    /CLOUDFLARE_API_TOKEN is required/u,
  );
  assert.equal(called, false);
});
