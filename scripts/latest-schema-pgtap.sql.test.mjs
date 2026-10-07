import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createOriginal77FullchainFixture, ISOLATED_RPC_INTEGRATIONS } from './fixtures/original77-fullchain-fixture.mjs';
import { POST71_REVIEWED_MIGRATIONS, verifyPost71ReleaseSources } from './verify-post71-release-plan.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256 } from './verify-repeatable-challenge-cutover-plan.mjs';

// Audit the registered latest-schema pgTAP tests in an owned, network-disabled,
// tmpfs cluster. The historical helper remains pinned to its original70 prefix.
// Provider shapes below only support SQL fixtures; native Supabase Auth/Storage,
// advisors, and the normal CI database runner remain separate required gates.
const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
const testsDirectory = new URL('../supabase/tests/database/', import.meta.url);
const names = (await readdir(testsDirectory)).filter(name => /\.(?:sql|pg)$/.test(name)).sort();
const digest = source => createHash('sha256').update(source).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let fixture, reviewedSources;

async function readReviewedMigrationSources() {
  const migrationFilenames = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
  const entries = await Promise.all(migrationFilenames.map(async name =>
    [name, await readFile(new URL(name, migrationsDirectory))]));
  const migrationSourceHashes = Object.fromEntries(entries.map(([name, source]) => [name, digest(source)]));
  // Pin all frozen71 bytes and exactly the two reviewed additions before any
  // fixture resource exists; no arbitrary later suffix is accepted or replayed.
  verifyPost71ReleaseSources({ migrationFilenames, migrationSourceHashes });
  assert.equal(migrationSourceHashes[REPEATABLE_CHALLENGE_MIGRATION_FILENAME], REPEATABLE_CHALLENGE_MIGRATION_SHA256);
  return { sources: Object.fromEntries(entries), hashes: migrationSourceHashes };
}

before(async () => {
  reviewedSources = await readReviewedMigrationSources();
  const source = reviewedSources.sources[REPEATABLE_CHALLENGE_MIGRATION_FILENAME].toString('utf8');
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  // pgTAP functions are callable after tests SET ROLE, as in the native stack.
  // Application/private privileges still come only from the actual migrations.
  fixture.query('grant usage on schema extensions, auth, storage to anon, authenticated, service_role;');
  fixture.query(`alter table auth.users
    add column instance_id uuid, add column aud text, add column role text,
    add column encrypted_password text, add column raw_app_meta_data jsonb;
    alter table storage.objects add column metadata jsonb;
    grant select,insert,update,delete on storage.objects to authenticated,service_role;
    create table auth.identities (
      id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
      provider_id text not null, identity_data jsonb, provider text not null,
      last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
      unique(provider_id,provider));
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
    $$;
    begin; set local check_function_bodies=on; set local search_path=public,extensions;
    ${source}
    insert into supabase_migrations.schema_migrations(version,name,statements)
      values('20261001001245','repeatable_challenge_instances_v2',array[${quote(source)}]);
    commit;`);
  for (const { filename } of POST71_REVIEWED_MIGRATIONS) {
    const body = reviewedSources.sources[filename].toString('utf8');
    fixture.query(`begin; set local check_function_bodies=on; set local search_path=public,extensions;
      ${body}
      insert into supabase_migrations.schema_migrations(version,name,statements)
        values(${quote(filename.slice(0, 14))},${quote(filename.slice(15, -4))},array[${quote(body)}]::text[]);
      commit;`);
  }
  const seed = await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8');
  fixture.query(`begin;set local search_path=public,extensions;${seed}commit;`);
});
after(async () => {
  try {
    if (reviewedSources) assert.deepEqual((await readReviewedMigrationSources()).hashes, reviewedSources.hashes,
      'Migration changed during latest-schema pgTAP audit.');
  }
  finally { fixture?.close(); }
});

for (const name of names) test(`latest-schema pgTAP: ${name}`, async () => {
  const source = await readFile(new URL(name, testsDirectory), 'utf8');
  // Fixture construction may use privileged historical rows, but every runtime
  // assertion retains the SQL file's explicit anon/authenticated/service role.
  // All migrations above still execute as the NOSUPERUSER application owner.
  const output = fixture.queryAsBootstrap(source);
  const plans = [...output.matchAll(/^1\.\.(\d+)$/gm)];
  const assertions = [...output.matchAll(/^(?:not )?ok \d+\b/gm)];
  assert.equal(plans.length, 1, `Missing unique pgTAP plan in ${name}:\n${output}`);
  assert.equal(assertions.length, Number(plans[0][1]), `pgTAP plan mismatch in ${name}:\n${output}`);
  const failures = output.split('\n').filter(line => /^(?:not ok |Bail out!|#)/.test(line)).join('\n');
  assert.equal(failures, '', `pgTAP failure in ${name}:\n${failures}`);
});

// The historical activation-backfill script intentionally resets an earlier
// native Supabase checkpoint; it stays in the native CI gate, never this helper.
for (const name of ISOLATED_RPC_INTEGRATIONS) test(`latest-schema RPC concurrency: ${name}`, async () => {
  const output = await fixture.runIsolatedIntegration(name);
  assert(output.length > 0, `Missing completion evidence for ${name}.`);
});
