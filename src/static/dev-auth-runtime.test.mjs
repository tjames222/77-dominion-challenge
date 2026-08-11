import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { frontendEnvironmentErrors } from '../../scripts/validate-frontend-env.mjs';
import {
  PREVIEW_AUTH_OWNER_STORAGE_KEY,
  assertPreviewAuthEmail,
  bindPreviewAuthOwner,
  clearPreviewAuthOwner,
  previewAuthUser,
  readPreviewAuthOwner,
  shouldUseSupabaseAuthentication,
} from './preview-auth-runtime.mjs';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe('dev authentication runtime', () => {
  test('selects real Auth only for production-built mock previews or explicit local hybrid tests', () => {
    assert.equal(shouldUseSupabaseAuthentication({ configured: false }), false);
    assert.equal(shouldUseSupabaseAuthentication({ configured: true, localDemo: false }), true);
    assert.equal(shouldUseSupabaseAuthentication({
      configured: true,
      localDemo: true,
      mocksEnabled: true,
      productionBuild: true,
    }), true);
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
    const [api, auth] = await Promise.all([read('./api.js'), read('./auth.js')]);
    assert.match(api, /export const supabase = isSupabaseConfigured\(\)\s*\? createClient/);
    assert.doesNotMatch(api, /isSupabaseConfigured\(\) && !ENABLE_MOCKS/);
    assert.match(api, /data\.session\?\.access_token && hasSupabaseAuth\(\)/g);
    assert.match(api, /!isHybridAuthPreview\(\) \|\| typeof window === 'undefined'/);
    assert.match(auth, /if \(hasSupabaseAuthentication\(\)\)/);
  });
});

describe('Cloudflare frontend environment gate', () => {
  test('rejects canonical develop without real Auth configuration', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
    }), [
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ]);
  });

  test('requires product mocks on canonical develop', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'false',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    }), ['VITE_ENABLE_MOCKS must be true on develop']);
  });

  test('rejects mocks on main even when Supabase is configured', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'true',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    }), ['VITE_ENABLE_MOCKS must be false on main']);
  });

  test('allows an intentional pure-mock feature preview without Supabase', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'epic/example',
      VITE_ENABLE_MOCKS: 'true',
    }), []);
  });

  test('accepts configured canonical environments and rejects placeholders', () => {
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: 'true',
      CF_PAGES_BRANCH: 'develop',
      VITE_ENABLE_MOCKS: 'true',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    }), []);
    assert.deepEqual(frontendEnvironmentErrors({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'main',
      VITE_ENABLE_MOCKS: 'false',
      VITE_SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'YOUR_PUBLISHABLE_KEY',
    }), [
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ]);
  });
});
