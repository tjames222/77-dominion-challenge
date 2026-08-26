import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
  frontendEnvironmentErrors as rawFrontendEnvironmentErrors,
} from '../../scripts/validate-frontend-env.mjs';
import {
  PREVIEW_AUTH_OWNER_STORAGE_KEY,
  assertPreviewAuthEmail,
  bindPreviewAuthOwner,
  clearPreviewAuthOwner,
  previewAuthUser,
  readPreviewAuthOwner,
  shouldCreateSupabaseClient,
  shouldUseSupabaseAuthentication,
} from './preview-auth-runtime.mjs';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');
const frontendEnvironmentErrors = (environment) => rawFrontendEnvironmentErrors({
  VITE_ENABLE_BILLING: 'false',
  VITE_ENABLE_PUBLIC_SIGNUP: 'false',
  ...environment,
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe('dev authentication runtime', () => {
  test('constructs Supabase only for production or the explicit local Auth fixture', () => {
    assert.equal(shouldCreateSupabaseClient({ configured: false }), false);
    assert.equal(shouldCreateSupabaseClient({
      configured: true,
      productionBuild: false,
    }), false);
    assert.equal(shouldCreateSupabaseClient({
      configured: true,
      mocksEnabled: true,
      productionBuild: false,
    }), false);
    assert.equal(shouldCreateSupabaseClient({
      configured: true,
      mocksEnabled: true,
      productionBuild: false,
      localHybridEnabled: true,
    }), true);
    assert.equal(shouldCreateSupabaseClient({
      configured: true,
      mocksEnabled: false,
      productionBuild: true,
    }), false);
    assert.equal(shouldCreateSupabaseClient({
      configured: true,
      mocksEnabled: false,
      productionBuild: true,
      productionConnectionsEnabled: true,
    }), true);
    assert.equal(shouldCreateSupabaseClient({
      configured: true,
      mocksEnabled: true,
      productionBuild: true,
      productionConnectionsEnabled: true,
      localHybridEnabled: true,
    }), false);
  });

  test('selects real Auth for production or an explicitly enabled local hybrid test only', () => {
    assert.equal(shouldUseSupabaseAuthentication({ configured: false }), false);
    assert.equal(shouldUseSupabaseAuthentication({ configured: true, localDemo: false }), true);
    assert.equal(shouldUseSupabaseAuthentication({
      configured: true,
      localDemo: true,
      mocksEnabled: true,
      productionBuild: true,
    }), false);
    assert.equal(shouldUseSupabaseAuthentication({
      configured: true,
      localDemo: true,
      mocksEnabled: true,
    }), false);
    assert.equal(shouldUseSupabaseAuthentication({
      configured: true,
      localDemo: true,
      mocksEnabled: true,
      localHybridEnabled: true,
    }), true);
  });

  test('binds preview data to immutable Auth UUIDs instead of email identities', () => {
    const storage = memoryStorage({
      'dominion:mockUserId': 'legacy-email-owner',
      [PREVIEW_AUTH_OWNER_STORAGE_KEY]: 'stale-owner',
    });

    bindPreviewAuthOwner(storage, 'auth-user-a');
    assert.equal(readPreviewAuthOwner(storage), 'auth-user-a');
    assert.equal(storage.getItem('dominion:mockUserId'), null);

    const renamed = previewAuthUser({
      id: 'auth-user-a',
      email: 'renamed@example.test',
      user_metadata: { name: 'Auth Name' },
    }, { profile: { name: 'Saved Preview Name', avatarUrl: 'data:image/png;base64,abc' } });
    assert.deepEqual(renamed, {
      userId: 'auth-user-a',
      name: 'Saved Preview Name',
      email: 'renamed@example.test',
      avatarUrl: 'data:image/png;base64,abc',
      authenticated: true,
    });

    bindPreviewAuthOwner(storage, 'auth-user-b');
    assert.equal(readPreviewAuthOwner(storage), 'auth-user-b');
    clearPreviewAuthOwner(storage);
    assert.equal(readPreviewAuthOwner(storage), '');
  });

  test('keeps the verified Auth email immutable in a hybrid preview profile', () => {
    assert.equal(
      assertPreviewAuthEmail('Member@Example.test', ' member@example.TEST '),
      'Member@Example.test',
    );
    assert.throws(
      () => assertPreviewAuthEmail('member@example.test', 'other@example.test'),
      /sign-in email outside the dev preview/,
    );
  });

  test('keeps application tables mocked and gates redirect overrides to hybrid signup', async () => {
    const [api, auth, envExample] = await Promise.all([
      read('./api.js'),
      read('./auth.js'),
      read('../../.env.example'),
    ]);
    assert.match(api, /const ALLOW_SUPABASE_CLIENT = shouldCreateSupabaseClient\(\{/);
    assert.match(api, /productionBuild: import\.meta\.env\.PROD/);
    assert.match(api, /productionConnectionsEnabled: ENABLE_PRODUCTION_CONNECTIONS/);
    assert.match(api, /export const supabase = ALLOW_SUPABASE_CLIENT/);
    assert.doesNotMatch(api, /isSupabaseConfigured\(\) && \(!ENABLE_MOCKS/);
    assert.match(api, /data\.session\?\.access_token && hasSupabaseAuth\(\)/g);
    assert.match(api, /!isHybridAuthPreview\(\) \|\| typeof window === 'undefined'/);
    assert.match(auth, /if \(hasSupabaseAuthentication\(\)\)/);
    assert.match(envExample, /^VITE_ENABLE_MOCKS=true$/m);
    assert.match(envExample, /^VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS=false$/m);
    assert.match(envExample, /^VITE_ENABLE_PRODUCTION_CONNECTIONS=false$/m);
    assert.match(envExample, /^VITE_ENABLE_BILLING=false$/m);
    assert.match(envExample, /^VITE_ENABLE_PUBLIC_SIGNUP=false$/m);
  });

  test('keeps reward fulfillment fixtures inside the local browser E2E boundary', async () => {
    const api = await read('./api.js');
    assert.match(
      api,
      /const ENABLE_E2E_FIXTURES = Boolean\([\s\S]*?import\.meta\.env\.DEV[\s\S]*?ENABLE_MOCKS[\s\S]*?VITE_ENABLE_E2E_FIXTURES/,
    );
    assert.match(
      api,
      /const e2eRewardFixturesEnabled = \(\) => \([\s\S]*?ENABLE_E2E_FIXTURES[\s\S]*?globalThis\.__DOMINION_E2E__\?\.enabled === true/,
    );
    assert.match(api, /const fixtureByReward = e2eRewardFixturesEnabled\(\)/);
  });
});

describe('Cloudflare frontend environment gate', () => {
  test('requires both production-canary flags to be exactly false on canonical branches', () => {
    assert.deepEqual(rawFrontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
    }), [
      'VITE_ENABLE_BILLING must be false on develop',
      'VITE_ENABLE_PUBLIC_SIGNUP must be false on develop',
    ]);

    assert.deepEqual(rawFrontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_SUPABASE_URL: 'https://production-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'production-project',
    }), [
      'VITE_ENABLE_BILLING must be false on main',
      'VITE_ENABLE_PUBLIC_SIGNUP must be false on main',
    ]);

    assert.deepEqual(rawFrontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_ENABLE_BILLING: 'true',
      VITE_ENABLE_PUBLIC_SIGNUP: 'true',
      VITE_SUPABASE_URL: 'https://production-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'production-project',
    }), [
      'VITE_ENABLE_BILLING must be false on main',
      'VITE_ENABLE_PUBLIC_SIGNUP must be false on main',
    ]);

    for (const nonExactFalse of ['FALSE', ' false', 'false ']) {
      assert.deepEqual(rawFrontendEnvironmentErrors({
        CF_PAGES: 'true',
        CF_PAGES_BRANCH: 'main',
        VITE_ENABLE_MOCKS: 'false',
        VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
        VITE_ENABLE_BILLING: nonExactFalse,
        VITE_ENABLE_PUBLIC_SIGNUP: nonExactFalse,
        VITE_SUPABASE_URL: 'https://production-project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
        SUPABASE_PROJECT_REF: 'production-project',
      }), [
        'VITE_ENABLE_BILLING must be false on main',
        'VITE_ENABLE_PUBLIC_SIGNUP must be false on main',
      ]);
    }
  });

  test('accepts canonical develop without any hosted connection', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
    }), []);
  });

  test('keeps browser fixture flags available to non-Cloudflare local tests', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_E2E_FIXTURES: 'true',
    }), []);
  });

  test('rejects browser fixture flags on every Cloudflare branch', () => {
    const cases = [
      {
        CF_PAGES: 'true',
        CF_PAGES_BRANCH: 'develop',
        VITE_ENABLE_MOCKS: 'true',
        VITE_ENABLE_E2E_FIXTURES: 'true',
      },
      {
        CF_PAGES: 'true',
        CF_PAGES_BRANCH: 'feature/reward-review',
        VITE_ENABLE_MOCKS: 'true',
        VITE_ENABLE_E2E_FIXTURES: 'true',
      },
      {
        CF_PAGES: 'true',
        CF_PAGES_BRANCH: 'main',
        VITE_ENABLE_MOCKS: 'false',
        VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
        VITE_ENABLE_E2E_FIXTURES: 'true',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
        SUPABASE_PROJECT_REF: 'project',
      },
    ];

    for (const environment of cases) {
      assert.deepEqual(frontendEnvironmentErrors(environment), [
        'VITE_ENABLE_E2E_FIXTURES must be unset for Cloudflare builds',
      ]);
    }
  });

  test('requires product mocks on canonical develop', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'false',
    }), ['VITE_ENABLE_MOCKS must be true on develop']);
  });

  test('requires the same explicit boolean spelling consumed by the runtime', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: '1',
    }), ['VITE_ENABLE_MOCKS must be true on develop']);

    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: '1',
      VITE_SUPABASE_URL: 'https://production-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'production-project',
    }), ['VITE_ENABLE_PRODUCTION_CONNECTIONS must be true on main']);
  });

  test('rejects hybrid Supabase Auth on canonical develop', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'true',
    }), ['VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS must be false on develop']);
  });

  test('rejects the production connection opt-in on canonical develop', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
    }), ['VITE_ENABLE_PRODUCTION_CONNECTIONS must be false on develop']);
  });

  test('rejects every live backend or provider value on canonical develop', () => {
    const forbiddenNames = [
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
      'VITE_SUPABASE_ANON_KEY',
      'VITE_YOUVERSION_VERSE_URL',
      'VITE_YOUVERSION_APP_URL',
      'VITE_YOUVERSION_PRAYER_URL',
      'VITE_APPLE_FITNESS_URL',
      'VITE_WALK_ALARM_URL',
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_DB_PASSWORD',
      'SUPABASE_DB_URL',
      'SUPABASE_PROJECT_REF',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_MEMBERSHIP_PRICE_ID',
      'BILLING_ENABLED',
      'INTEGRATION_WORKER_SECRET',
      'INTEGRATION_CREDENTIAL_KEYS',
      'INTEGRATION_OAUTH_STATE_SECRET',
      'RETIRED_COMMUNITY_WORKER_SECRET',
      'RETIRED_COMMUNITY_DR_HMAC_SECRET',
      'PROFILE_PHOTO_WORKER_SECRET',
      'SLACK_CLIENT_ID',
      'SLACK_CLIENT_SECRET',
      'SLACK_SIGNING_SECRET',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_BOT_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'PUBLIC_SITE_URL',
      'PUBLIC_SHARE_URL',
      'PUBLIC_ALLOWED_SITE_URLS',
      'ALLOWED_SITE_ORIGINS',
    ];

    for (const name of forbiddenNames) {
      assert.deepEqual(frontendEnvironmentErrors({
        CF_PAGES: 'true',
        CF_PAGES_BRANCH: 'develop',
        VITE_ENABLE_MOCKS: 'true',
        [name]: 'configured-value',
      }), [`${name} must be unset on develop`], name);
    }
  });

  test('rejects enabled provider connections on canonical develop', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_GROUP_INTEGRATIONS: 'true',
    }), ['VITE_ENABLE_GROUP_INTEGRATIONS must be false on develop']);
  });

  test('rejects mocks on main even when Supabase is configured', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'project',
    }), ['VITE_ENABLE_MOCKS must be false on main']);
  });

  test('rejects the local hybrid-Auth override on main', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'true',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'project',
    }), ['VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS must be false on main']);
  });

  test('allows an intentional pure-mock feature preview without Supabase', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'epic/example',
      VITE_ENABLE_MOCKS: 'true',
    }), []);
  });

  test('requires valid hosted configuration only for main', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'YOUR_PUBLISHABLE_KEY',
      SUPABASE_PROJECT_REF: 'project',
    }), [
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ]);
  });

  test('requires the protected production connection opt-in on main', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_SUPABASE_URL: 'https://production-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'production-project',
    }), ['VITE_ENABLE_PRODUCTION_CONNECTIONS must be true on main']);
  });

  test('accepts real Supabase wiring with mocks disabled on main', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_SUPABASE_URL: 'https://production-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'production-project',
    }), []);
  });

  test('requires main to target the same Supabase project as migrations', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_SUPABASE_URL: 'https://frontend-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      SUPABASE_PROJECT_REF: 'migration-project',
    }), ['VITE_SUPABASE_URL must match SUPABASE_PROJECT_REF']);
  });
});
