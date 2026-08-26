import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
  isCloudflarePreviewEnvironment,
  normalizeCloudflareFrontendEnvironment,
} from '../../scripts/normalize-cloudflare-frontend-env.mjs';
import {
  FRONTEND_BUILD_STEPS,
  runFrontendBuild,
} from '../../scripts/build-frontend.mjs';
import {
  DEVELOP_LIVE_CONNECTION_VARIABLES,
  frontendEnvironmentErrors,
} from '../../scripts/validate-frontend-env.mjs';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

const inheritedLiveEnvironment = () => Object.fromEntries(
  DEVELOP_LIVE_CONNECTION_VARIABLES.map((name) => [name, `sentinel-${name}`]),
);

describe('Cloudflare frontend build environment normalization', () => {
  for (const branch of ['develop', 'feature/reward-review']) {
    test(`forces the ${branch} Cloudflare build to use pure browser mocks`, () => {
      const input = {
        CF_PAGES: 'true',
        CF_PAGES_BRANCH: branch,
        VITE_ENABLE_MOCKS: 'false',
        VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'true',
        VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
        VITE_ENABLE_GROUP_INTEGRATIONS: 'true',
        VITE_ENABLE_BILLING: 'true',
        VITE_ENABLE_PUBLIC_SIGNUP: 'true',
        VITE_ENABLE_E2E_FIXTURES: 'true',
        KEEP_UNRELATED_VALUE: 'preserved',
        ...inheritedLiveEnvironment(),
      };

      const normalized = normalizeCloudflareFrontendEnvironment(input);

      assert.equal(normalized.VITE_ENABLE_MOCKS, 'true');
      assert.equal(normalized.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS, 'false');
      assert.equal(normalized.VITE_ENABLE_PRODUCTION_CONNECTIONS, 'false');
      assert.equal(normalized.VITE_ENABLE_GROUP_INTEGRATIONS, 'false');
      assert.equal(normalized.VITE_ENABLE_BILLING, 'false');
      assert.equal(normalized.VITE_ENABLE_PUBLIC_SIGNUP, 'false');
      assert.equal(normalized.VITE_ENABLE_E2E_FIXTURES, undefined);
      assert.equal(normalized.KEEP_UNRELATED_VALUE, 'preserved');
      for (const name of DEVELOP_LIVE_CONNECTION_VARIABLES) {
        assert.equal(normalized[name], undefined, name);
      }
      assert.deepEqual(frontendEnvironmentErrors(normalized), []);

      // The normalizer is pure; diagnostics can still inspect the inherited
      // environment after the build has received its sanitized copy.
      assert.equal(input.VITE_SUPABASE_URL, 'sentinel-VITE_SUPABASE_URL');
      assert.equal(input.VITE_ENABLE_PRODUCTION_CONNECTIONS, 'true');
    });
  }

  test('leaves the fail-closed main environment unchanged', () => {
    const environment = {
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_ENABLE_BILLING: 'false',
      VITE_ENABLE_PUBLIC_SIGNUP: 'false',
      VITE_SUPABASE_URL: 'https://production-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'production-project',
    };

    assert.deepEqual(
      normalizeCloudflareFrontendEnvironment(environment),
      environment,
    );
    assert.equal(isCloudflarePreviewEnvironment(environment), false);
  });

  test('leaves a non-Cloudflare local environment unchanged', () => {
    const environment = {
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_E2E_FIXTURES: 'true',
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
    };

    assert.deepEqual(
      normalizeCloudflareFrontendEnvironment(environment),
      environment,
    );
    assert.equal(isCloudflarePreviewEnvironment(environment), false);
  });

  test('passes the same sanitized environment to every build step', () => {
    const calls = [];
    const environment = {
      CF_PAGES: 'yes',
      CF_PAGES_BRANCH: 'feature/new-dashboard',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_E2E_FIXTURES: 'true',
      ...inheritedLiveEnvironment(),
    };

    const status = runFrontendBuild(environment, (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    });

    assert.equal(status, 0);
    assert.equal(calls.length, FRONTEND_BUILD_STEPS.length);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.command, FRONTEND_BUILD_STEPS[index].command);
      assert.deepEqual(call.args, FRONTEND_BUILD_STEPS[index].args);
      assert.equal(call.options.stdio, 'inherit');
      assert.equal(call.options.env.VITE_ENABLE_MOCKS, 'true');
      assert.equal(call.options.env.VITE_ENABLE_BILLING, 'false');
      assert.equal(call.options.env.VITE_ENABLE_PUBLIC_SIGNUP, 'false');
      assert.equal(call.options.env.VITE_ENABLE_E2E_FIXTURES, undefined);
      for (const name of DEVELOP_LIVE_CONNECTION_VARIABLES) {
        assert.equal(call.options.env[name], undefined, name);
      }
    }
  });

  test('routes the package build through the sanitizing wrapper', async () => {
    const packageJson = JSON.parse(await read('../../package.json'));
    const wrapper = await read('../../scripts/build-frontend.mjs');
    const viteConfig = await read('../../vite.config.mjs');

    assert.equal(packageJson.scripts.build, 'node scripts/build-frontend.mjs');
    assert.match(wrapper, /normalizeCloudflareFrontendEnvironment\(environment\)/);
    assert.match(wrapper, /validate-frontend-env\.mjs/);
    assert.match(wrapper, /vite['"], args: Object\.freeze\(\['build'\]\)/);
    assert.match(wrapper, /verify-build-assets\.mjs/);
    assert.match(viteConfig, /isCloudflarePreview \? \{ envDir: false \} : \{\}/);
  });
});
