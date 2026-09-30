import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

test('unchanged local share pgTAP passes against all70 real application migrations and canonical check-ins', async () => {
  const fixture = await createOriginal77FullchainFixture();
  try {
    // Extra structural provider fields used only by the repository's unchanged
    // synthetic development seed. No Auth/Storage service is simulated here.
    fixture.queryAsBootstrap(`create extension pgtap with schema extensions;
      grant usage on schema extensions to anon,authenticated;
      alter table auth.users add column instance_id uuid,add column aud text,
        add column role text,add column encrypted_password text,add column raw_app_meta_data jsonb;
      create table auth.identities(id uuid primary key,user_id uuid,provider_id text,
        identity_data jsonb,provider text,last_sign_in_at timestamptz,created_at timestamptz,
        updated_at timestamptz,unique(provider_id,provider));
      alter table auth.identities owner to postgres;`);
    fixture.query(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
    // The test driver may SET ROLE; member assertions inside the unchanged SQL
    // run as authenticated, and SECURITY DEFINER functions retain postgres.
    const output = fixture.queryAsBootstrap(await readFile(new URL('../supabase/tests/database/035_public_share_snapshots.sql', import.meta.url), 'utf8'));
    assert.doesNotMatch(output, /^not ok\b|^Bail out!|^# Looks like/m, output);
    assert.match(output, /^1\.\.43$/m, 'The full declared share assertion plan must run.');
    assert.equal(output.split('\n').filter(line => /^ok \d+\b/.test(line)).length, 43, output);
    assert.equal(fixture.query('select count(*) from private.original_77_completion_events;'), '0',
      'The share test rolls back and cannot create a completion event.');
  } finally { fixture.close(); }
});
