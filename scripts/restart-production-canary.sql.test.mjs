import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { buildRestartCanaryQuery, restartPreflightQuery, entitlementsFingerprintExpression,
  verifyRestartPreflightResponse } from './restart-production-canary.mjs';
import { PRIOR_PRODUCTION_CANARY_RELEASE_SHA } from './production-canary-restart-proof.mjs';
import { grantVerificationQuery, verifyGrantResponse } from './manage-production-canary-entitlement.mjs';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';

// Own disposable cluster only: no URL, hosted credentials, existing containers,
// ports or volumes accepted. Match the pinned production backup restore image.
const identity = randomUUID();
const container = `77dc-restart-sql-${identity}`;
const ownerLabel = 'dominion.restart-sql-fixture';
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const releaseSha = 'a'.repeat(40), ownerId = '10000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const dummyHash = 'f'.repeat(64);
let created = false, fixture, inventoryTables;
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}
function sql(query) {
  const result = docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'], query);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function jsonQuery(query) {
  return `select row_to_json(result) from (${query.trim().replace(/;$/u, '').replaceAll('$1', `'${releaseSha}'`)}) result;`;
}
const saveFingerprint = `create temp table saved_checkpoint as select ${entitlementsFingerprintExpression} as sha256;`;
function executeSaved(statement = buildRestartCanaryQuery(releaseSha, dummyHash)) {
  // psql executes the actual exported fixed SQL after replacing only the valid
  // 64-hex binding, just as the runtime does; no rewritten SQL implementation.
  return `select replace($fixture_source$${statement}$fixture_source$, '${dummyHash}', (select sha256 from saved_checkpoint)) \\gexec\n`;
}
function expectFailure(statement, message) {
  return `do $fixture_failure$ declare rejected boolean := false; begin
    begin ${statement} exception when others then
      if position('${message}' in sqlerrm) = 0 then raise; end if; rejected := true;
    end;
    if not rejected then raise exception 'Expected restart guard to reject.'; end if;
  end $fixture_failure$;`;
}
before(async () => {
  const baseline = await readFile(new URL('../supabase/migrations/20260707170000_baseline.sql', import.meta.url), 'utf8');
  const tables = ['profiles', 'billing_customers', 'subscriptions', 'entitlements'].map(table => {
    const match = baseline.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`, 'u'));
    assert.ok(match); return match[0];
  }).join('\n');
  const updateFunction = baseline.match(/create or replace function public\.set_updated_at\(\)[\s\S]*?\n\$\$;/u)?.[0];
  const updateTrigger = baseline.match(/create trigger set_entitlements_updated_at[\s\S]*?public\.set_updated_at\(\);/u)?.[0];
  assert.ok(updateFunction); assert.ok(updateTrigger);
  const inventory = await readFile(new URL('./free-backup-inventory.sql', import.meta.url), 'utf8');
  inventoryTables = inventory.match(/SELECT format\([\s\S]*?\\gexec/u)?.[0];
  assert.ok(inventoryTables);
  fixture = `begin;
    set local timezone = 'UTC'; set local datestyle = 'ISO, MDY';
    create schema auth; create table auth.users (id uuid primary key, is_anonymous boolean not null default false);
    create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key);
    ${tables}
    ${updateFunction}
    ${updateTrigger}
    insert into supabase_migrations.schema_migrations values ${reconciledHistoryVersions.map(v => `('${v}')`).join(',')};
    insert into auth.users values ('${ownerId}', false);
    insert into public.profiles (user_id) values ('${ownerId}');
    insert into public.entitlements (user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at, metadata, created_at, updated_at)
    values ('${ownerId}', 'membership_active', 'revoked', 'production_canary', '30000000-0000-4000-8000-000000000003',
      '2020-02-29T12:34:56.123456Z', '2020-02-29T14:34:56.123456Z',
      jsonb_build_object('release_sha', '${PRIOR_PRODUCTION_CANARY_RELEASE_SHA}'), '2020-02-29T12:34:56.123456Z', '2020-02-29T14:34:56.123456Z');`;
  const started = docker(['run', '--detach', '--name', container, '--label', `${ownerLabel}=${identity}`,
    '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', image, '-c',
    'initdb -D /tmp/restart-pgdata -A trust && exec postgres -D /tmp/restart-pgdata -k /tmp -h ""']);
  assert.equal(started.status, 0, started.error?.message ?? started.stderr); created = true;
  for (let i = 0; i < 100; i++) {
    if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Isolated restart PostgreSQL did not become ready.');
});
after(() => {
  if (!created) return;
  const owned = docker(['inspect', '--format', `{{index .Config.Labels "${ownerLabel}"}}`, container]);
  assert.equal(owned.status, 0); assert.equal(owned.stdout.trim(), identity);
  const removed = docker(['rm', '--force', container]);
  assert.equal(removed.status, 0, removed.error?.message ?? removed.stderr);
});

test('actual PG17 inventory fingerprint is identical under ISO MDY/DMY/YMD and exact backup serialization', () => {
  const rows = sql(`${fixture}
    ${jsonQuery(restartPreflightQuery)}
    set local datestyle = 'ISO, DMY'; ${jsonQuery(restartPreflightQuery)}
    set local datestyle = 'ISO, YMD'; ${jsonQuery(restartPreflightQuery)}
    ${inventoryTables}
    rollback;`);
  const a = verifyRestartPreflightResponse([rows[0]]), b = verifyRestartPreflightResponse([rows[1]]), c = verifyRestartPreflightResponse([rows[2]]);
  assert.deepEqual(a, b); assert.deepEqual(a, c);
  const archived = rows.find(row => row.kind === 'table' && row.schema === 'public' && row.name === 'entitlements');
  assert.deepEqual(a, { count: archived.count, sha256: archived.sha256 });
});
test('actual fixed SQL replaces only the archived slot, preserves created_at/user/key, and verifies strict 2h grant', () => {
  const rows = sql(`${fixture}
    ${saveFingerprint}
    select row_to_json(e) from public.entitlements e;
    ${executeSaved()}
    ${jsonQuery(grantVerificationQuery)}
    select row_to_json(e) from public.entitlements e;
    rollback;`);
  const [old, verified, current] = rows; verifyGrantResponse([verified]);
  for (const key of ['user_id', 'entitlement_key', 'created_at']) assert.deepEqual(current[key], old[key]);
  assert.equal(current.status, 'active'); assert.equal(current.source_type, 'production_canary');
  assert.notEqual(current.source_id, old.source_id);
  assert.match(current.source_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(current.metadata, { release_sha: releaseSha });
  assert.equal(Date.parse(current.ends_at) - Date.parse(current.starts_at), 7_200_000);
  assert.ok(Date.parse(current.updated_at) <= Date.parse(current.starts_at), 'baseline trigger uses transaction time, grant uses clock time');
});
test('actual read-only preflight rejects non-UTC and non-ISO serialization settings', () => {
  const rows = sql(`${fixture}
    set local timezone = 'America/Los_Angeles'; ${jsonQuery(restartPreflightQuery)}
    set local timezone = 'UTC'; set local datestyle = 'SQL, MDY'; ${jsonQuery(restartPreflightQuery)}
    rollback;`);
  for (const row of rows) { assert.equal(row.serialization_settings_match, false); assert.throws(() => verifyRestartPreflightResponse([row])); }
});
test('actual locked SQL rejects zero or extra total entitlement rows', () => {
  for (const change of ['delete from public.entitlements;',
    "alter table public.entitlements drop constraint entitlements_entitlement_key_check; insert into public.entitlements select user_id,'synthetic_extra_key',status,source_type,source_id,starts_at,ends_at,metadata,created_at,updated_at from public.entitlements;"]) {
    const rows = sql(`${fixture} ${change} ${saveFingerprint}
      select json_build_object('count',count(*),'hash',${entitlementsFingerprintExpression}) from public.entitlements;
      ${executeSaved(expectFailure(buildRestartCanaryQuery(releaseSha, dummyHash), 'exact revoked prior-release checkpoint'))}
      select json_build_object('count',count(*),'hash',${entitlementsFingerprintExpression}) from public.entitlements; rollback;`);
    assert.deepEqual(rows[1], rows[0]);
  }
});
for (const [name, change] of [
  ['missing history', 'delete from supabase_migrations.schema_migrations;'],
  ['advanced history', "insert into supabase_migrations.schema_migrations values ('20990101000000');"],
  ['second nonanonymous user', `insert into auth.users values ('${otherId}', false);`],
  ['additional anonymous user', `insert into auth.users values ('${otherId}', true);`],
  ['missing profile', 'delete from public.profiles;'],
  ['billing customer', `insert into public.billing_customers(user_id,stripe_customer_id) values ('${ownerId}','cus_synthetic');`],
  ['subscription', `insert into public.subscriptions(user_id,product_key,status,stripe_subscription_id) values ('${ownerId}','dominion_membership','inactive','sub_synthetic');`],
  ['purchases table', 'create table public.purchases(id integer);'],
  ['unrevoked old grant', "update public.entitlements set status='active';"],
  ['wrong prior SHA', `update public.entitlements set metadata=jsonb_build_object('release_sha','${'b'.repeat(40)}');`],
  ['spent earlier 8779421 grant', "update public.entitlements set metadata=jsonb_build_object('release_sha','877942113f1d18e73f2e51e6b467915b37b0c67b');"],
  ['spent earlier 0507c5e grant', "update public.entitlements set metadata=jsonb_build_object('release_sha','0507c5e3b63d03f5e8ce7781aad463134d992871');"],
  ['extra metadata', "update public.entitlements set metadata=metadata || '{\"extra\":true}'::jsonb;"],
  ['wrong source', "update public.entitlements set source_type='stripe';"],
  ['noncanonical source UUID', "update public.entitlements set source_id='not-a-uuid';"],
  ['missing start', 'update public.entitlements set starts_at=null;'],
  ['missing end', 'update public.entitlements set ends_at=null;'],
  ['zero duration', 'update public.entitlements set ends_at=starts_at;'],
  ['overlong duration', "update public.entitlements set ends_at=starts_at+interval '2 hours 1 second';"],
  ['future old expiry', "update public.entitlements set starts_at=clock_timestamp(),ends_at=clock_timestamp()+interval '1 hour';"],
]) {
  test(`actual locked SQL rejects ${name} and leaves entitlement unchanged`, () => {
    const rows = sql(`${fixture} ${change} ${saveFingerprint}
      select row_to_json(e) from public.entitlements e;
      ${executeSaved(expectFailure(buildRestartCanaryQuery(releaseSha, dummyHash), 'exact revoked prior-release checkpoint'))}
      select row_to_json(e) from public.entitlements e; rollback;`);
    assert.deepEqual(rows[1], rows[0]);
  });
}
test('actual SQL CAS catches a changed otherwise-valid row after preflight without overwriting it', () => {
  const rows = sql(`${fixture} ${saveFingerprint}
    update public.entitlements set created_at=created_at+interval '1 microsecond';
    select row_to_json(e) from public.entitlements e;
    ${executeSaved(expectFailure(buildRestartCanaryQuery(releaseSha, dummyHash), 'checkpoint changed after recovery verification'))}
    select row_to_json(e) from public.entitlements e; rollback;`);
  assert.deepEqual(rows[1], rows[0]);
});
test('actual SQL cannot replay, renew or reactivate the new release even after revocation', () => {
  const rows = sql(`${fixture} ${saveFingerprint} ${executeSaved()}
    ${executeSaved(expectFailure(buildRestartCanaryQuery(releaseSha, dummyHash), 'exact revoked prior-release checkpoint'))}
    ${jsonQuery(grantVerificationQuery)}
    update public.entitlements set status='revoked', starts_at='2020-02-29T12:34:56Z', ends_at='2020-02-29T13:34:56Z';
    update saved_checkpoint set sha256=${entitlementsFingerprintExpression};
    ${executeSaved(expectFailure(buildRestartCanaryQuery(releaseSha, dummyHash), 'exact revoked prior-release checkpoint'))}
    select json_build_object('status',status,'release_sha',metadata->>'release_sha') from public.entitlements; rollback;`);
  verifyGrantResponse([rows[0]]); assert.deepEqual(rows[1], { status: 'revoked', release_sha: releaseSha });
});
test('actual SQL rowcount guard rolls back a suppressed update', () => {
  const rows = sql(`${fixture} ${saveFingerprint}
    create function pg_temp.suppress_restart() returns trigger language plpgsql as $$ begin return null; end $$;
    create trigger suppress_restart before update on public.entitlements for each row execute function pg_temp.suppress_restart();
    select row_to_json(e) from public.entitlements e;
    ${executeSaved(expectFailure(buildRestartCanaryQuery(releaseSha, dummyHash), 'exactly one audited canary replacement'))}
    select row_to_json(e) from public.entitlements e; rollback;`);
  assert.deepEqual(rows[1], rows[0]);
});
