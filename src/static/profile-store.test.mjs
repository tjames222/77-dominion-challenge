import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_PROFILE_COLUMNS,
  PROFILE_COLUMNS,
  buildProfilePatch,
  ensureProfileRecord,
  isMissingProfilePhotoSchemaError,
  readProfileRecord,
} from './profile-store.mjs';

const profile = (overrides = {}) => ({
  user_id: '10000000-0000-4000-8000-000000000001',
  name: 'Canonical Name',
  email: 'canonical@example.com',
  updated_at: '2026-07-22T00:00:00Z',
  ...overrides,
});

function profileClient({ reads, insertError = null }) {
  const calls = [];
  let readIndex = 0;
  return {
    calls,
    from(table) {
      assert.equal(table, 'profiles');
      return {
        select(columns) {
          calls.push(['select', columns]);
          return {
            eq(column, value) {
              calls.push(['eq', column, value]);
              return {
                async maybeSingle() {
                  const result = reads[readIndex];
                  readIndex += 1;
                  return result;
                },
              };
            },
          };
        },
        async insert(row) {
          calls.push(['insert', row]);
          return { error: insertError };
        },
      };
    },
  };
}

test('only an exact missing avatar column error uses the legacy projection', async () => {
  const missing = { code: '42703', message: 'column profiles.avatar_url does not exist' };
  assert.equal(isMissingProfilePhotoSchemaError(missing), true);
  assert.equal(isMissingProfilePhotoSchemaError({ code: '42501', message: missing.message }), false);
  assert.equal(isMissingProfilePhotoSchemaError({ code: '42703', message: 'column profiles.email does not exist' }), false);

  const canonical = profile();
  const client = profileClient({ reads: [{ data: null, error: missing }, { data: canonical, error: null }] });
  const result = await readProfileRecord(client, canonical.user_id);
  assert.equal(result.profilePhotoAvailable, false);
  assert.equal(result.data.avatar_url, '');
  assert.deepEqual(client.calls.filter(([kind]) => kind === 'select'), [
    ['select', PROFILE_COLUMNS],
    ['select', LEGACY_PROFILE_COLUMNS],
  ]);
});

test('unrelated profile read failures are not masked by compatibility fallback', async () => {
  const denied = { code: '42501', message: 'permission denied for profiles' };
  const client = profileClient({ reads: [{ data: null, error: denied }] });
  await assert.rejects(readProfileRecord(client, profile().user_id), (error) => error === denied);
  assert.equal(client.calls.filter(([kind]) => kind === 'select').length, 1);
});

test('ensuring an existing profile never rewrites canonical fields from auth metadata', async () => {
  const canonical = profile();
  const client = profileClient({ reads: [{ data: canonical, error: null }] });
  const result = await ensureProfileRecord(client, profile({
    name: 'Stale Auth Name',
    email: 'stale-auth@example.com',
  }));
  assert.equal(result.data.name, 'Canonical Name');
  assert.equal(client.calls.some(([kind]) => kind === 'insert'), false);
});

test('a duplicate create race rereads and preserves the winning profile', async () => {
  const winner = profile({ name: 'Concurrent Winner' });
  const client = profileClient({
    reads: [{ data: null, error: null }, { data: winner, error: null }],
    insertError: { code: '23505', message: 'duplicate key' },
  });
  const result = await ensureProfileRecord(client, profile({ name: 'Losing Seed' }));
  assert.equal(result.data.name, 'Concurrent Winner');
  assert.equal(client.calls.filter(([kind]) => kind === 'insert').length, 1);
});

test('challenge-date synchronization is a true partial update', () => {
  assert.deepEqual(buildProfilePatch({ challengeStartDate: '2026-08-01' }), {
    challenge_start_date: '2026-08-01',
  });
  assert.deepEqual(buildProfilePatch({ challengeStartDate: '' }), {
    challenge_start_date: null,
  });
  assert.deepEqual(buildProfilePatch({
    avatarOnly: true,
    name: 'Do not write',
    email: 'do-not-write@example.com',
  }, {
    nextName: 'Do not write',
    nextEmail: 'do-not-write@example.com',
  }), {});
});
