import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';
import { verifyPost74ReleaseSources } from './verify-post74-release-plan.mjs';
import { POST75_CATALOGS, assertPost75CatalogsReady } from './verify-production-post75-catalogs.mjs';
import { POST76_CATALOGS, assertPost76CatalogsReady } from './verify-production-post76-catalogs.mjs';
import { ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS, assertActivationReviewPreflightReady } from './verify-admin-activation-review-index-preflight.mjs';

// Owned socket-only/network-none/tmpfs PG17.6 fixture. Actual immutable first75
// and reviewed76 run unchanged as NOSUPERUSER postgres, no hosted access,
// provider credential, existing cluster, native account, pull or persistent mount.
const directory = new URL('../supabase/migrations/', import.meta.url);
const migration = '20261018013111_site_admin_activation_review_health.sql';
const migrationHash = '3f7f90d3943aa4121f5e6867b003b40546fbb4d3f297c87261ae3810ba7ee1db';
const sourceTable = 'private.challenge_activation_migration_reviews';
const signature = 'public.site_admin_get_activation_review_health(uuid)';
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const trim = value => value.trim().replace(/;$/u, '');
const preflight = { name: 'preflight', query: ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, fields: ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS };
let fixture, sources;
const pending = new Set();
async function reviewedSources() {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort().slice(0, 76);
  assert.equal(names.length, 76); assert.equal(names.at(-1), migration);
  const pairs = await Promise.all(names.map(async name => [name, await readFile(new URL(name, directory), 'utf8')]));
  const hashes = Object.fromEntries(pairs.map(([name, body]) => [name, sha(body)]));
  verifyPost74ReleaseSources({ migrationFilenames: names.slice(0, 75), migrationSourceHashes: hashes });
  assert.equal(hashes[migration], migrationHash); return { pairs, hashes };
}
function receipts(contracts) {
  return contracts.map(contract => `select jsonb_build_object('catalog',${quote(contract.name)},'proof',row_to_json(proof))from(${trim(contract.query)})proof;`).join('\n');
}
function parse(output) { return Object.fromEntries(output.split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.catalog, row.proof]; })); }
function read(contracts = POST76_CATALOGS, mutation = '', bootstrap = false) {
  return parse(fixture[bootstrap ? 'queryAsBootstrap' : 'query'](`begin${mutation ? '' : ' read only'};${mutation}\n${receipts(contracts)}rollback;`));
}
function expect(contracts, rows, { writable = false, history = true, overrides = {} } = {}) {
  assert.deepEqual(rows, Object.fromEntries(contracts.map(contract => [contract.name,
    Object.fromEntries(contract.fields.map(field => [field,
      Object.hasOwn(overrides[contract.name] || {}, field) ? overrides[contract.name][field]
        : ['exact_migration_history_ok', 'exact_pre_migration_history_ok'].includes(field) ? history
          : field === 'read_only_pinned_server_ok' ? !writable : true]))])));
}
function preDrift(sql, changed, bootstrap = false) {
  expect([preflight], read([preflight], sql, bootstrap), { writable: true, overrides: { preflight: Object.fromEntries(changed.map(name => [name, false])) } });
}
function drift(sql, overrides) { expect(POST76_CATALOGS, read(POST76_CATALOGS, sql), { writable: true, overrides }); }
function asyncQuery(sql) {
  const promise = fixture.queryAsync(sql); pending.add(promise);
  promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
}
async function waitForLock(mode, granted) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (fixture.query(`select exists(select 1 from pg_locks where relation='${sourceTable}'::regclass and mode=${quote(mode)} and granted=${granted});`) === 't') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Owned fixture ${mode} granted=${granted} not observed`);
}
before(async () => {
  assert.equal(assertPost75CatalogsReady(), true); assert.equal(assertPost76CatalogsReady(), true); assert.equal(assertActivationReviewPreflightReady(), true);
  sources = await reviewedSources(); fixture = await createOriginal77FullchainFixture({ through: 70 });
  for (const [name, body] of sources.pairs.slice(70, 75)) {
    fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;${body}
      insert into supabase_migrations.schema_migrations(version,name,statements)values(${quote(name.slice(0,14))},${quote(name.slice(15,-4))},array[${quote(body)}]);commit;`);
  }
});
after(async () => {
  await Promise.allSettled([...pending]);
  try { if (sources) assert.deepEqual((await reviewedSources()).hashes, sources.hashes); }
  finally { fixture?.close(); }
});

test('actual exact75 passes all53 preserved gates and ten catalog-only index preflight fields', () => {
  assert.equal(fixture.query("select rolsuper from pg_roles where rolname='postgres';"), 'f');
  expect(POST75_CATALOGS, read(POST75_CATALOGS)); expect([preflight], read([preflight]));
});
test('preflight rejects history, table shape, default, RLS and private privilege drift independently', () => {
  for (const sql of ["delete from supabase_migrations.schema_migrations where version='20261013091749';",
    "update supabase_migrations.schema_migrations set name='unreviewed' where version='20260804200019';"])
    expect([preflight], read([preflight], sql), { writable: true, history: false });
  for (const sql of [`alter table ${sourceTable} add column unexpected text;`, `alter table ${sourceTable} alter column created_at set default now();`,
    `alter table ${sourceTable} disable row level security;`, `alter table ${sourceTable} force row level security;`,
    `create policy unexpected on ${sourceTable} using(true);`]) preDrift(sql, ['review_table_shape_ok']);
  for (const sql of [`grant select on ${sourceTable} to authenticated;`, `grant select(user_id) on ${sourceTable} to anon;`,
    `revoke update on ${sourceTable} from service_role;`, `grant delete on ${sourceTable} to service_role;`]) preDrift(sql, ['review_table_privileges_ok']);
});
test('preflight rejects source constraint and pkey changes, name overloads and proposed-index collisions', () => {
  preDrift(`alter table ${sourceTable} drop constraint challenge_activation_migration_reviews_reasons_check;`, ['review_constraints_ok']);
  preDrift('alter index private.challenge_activation_migration_reviews_pkey rename to unexpected_pkey;', ['review_constraints_ok', 'existing_pkey_ok']);
  preDrift('create function public.site_admin_get_activation_review_health(text)returns jsonb language sql as $$select null::jsonb$$;', ['new_objects_absent_ok']);
  preDrift('create function private.site_admin_get_activation_review_health()returns jsonb language sql as $$select null::jsonb$$;', ['new_objects_absent_ok']);
  preDrift(`create index challenge_activation_reviews_unresolved_created_idx on ${sourceTable}(resolved_at);`, ['existing_pkey_ok', 'new_objects_absent_ok']);
});
test('preflight enforces known0..100000 and permits unknown only while heap is physically empty', () => {
  for (const reltuples of [0, 100000, -1]) expect([preflight], read([preflight], `update pg_class set reltuples=${reltuples} where oid='${sourceTable}'::regclass;`, true), { writable: true });
  for (const reltuples of [-2, 100001, "'NaN'::real", "'Infinity'::real"]) preDrift(`update pg_class set reltuples=${reltuples} where oid='${sourceTable}'::regclass;`, ['review_estimate_within_bound_ok'], true);
  // Uncommitted synthetic rows still allocate a heap. No ANALYZE or data scan
  // is added to the source preflight; reltuples=-1 must no longer pass it.
  preDrift(`insert into auth.users(id,email)values('70000000-0000-4000-8000-000000000099','fixture@example.invalid');
    insert into ${sourceTable}(user_id,reasons,evidence)values('70000000-0000-4000-8000-000000000099',array['synthetic'],'{}');
    update pg_class set reltuples=-1 where oid='${sourceTable}'::regclass;`, ['review_estimate_within_bound_ok'], true);
  // Rollback does not truncate allocated pages. This fixture-only reset is
  // outside the source query, before the next empty-source positive check.
  fixture.query(`truncate ${sourceTable};`);
});
test('preflight rejects a conflicting source writer and every queued lock including an otherwise-compatible mode', async () => {
  const holder = asyncQuery(`begin;set local lock_timeout='2s';lock table ${sourceTable} in row exclusive mode;select pg_sleep(2);rollback;`);
  await waitForLock('RowExclusiveLock', true);
  expect([preflight], read([preflight]), { overrides: { preflight: { no_conflicting_review_locks_ok: false } } }); await holder;
  // This transaction excludes only its own held lock. A second backend queues
  // RowShareLock (normally compatible with CREATE INDEX SHARE), which must be
  // denied because it is queued. No source query lock acquisition is added.
  const observer = asyncQuery(`begin;set local statement_timeout='8s';lock table ${sourceTable} in exclusive mode;select pg_sleep(2);${receipts([preflight])}rollback;`);
  await waitForLock('ExclusiveLock', true);
  const queued = asyncQuery(`begin;set local lock_timeout='6s';lock table ${sourceTable} in row share mode;rollback;`);
  await waitForLock('RowShareLock', false);
  expect([preflight], parse(await observer), { writable: true, overrides: { preflight: { no_conflicting_review_locks_ok: false } } }); await queued;
});
test('unchanged non-superuser75 to76 replay preserves all53 old gates and passes all61 new ones', () => {
  const [name, body] = sources.pairs.at(-1); expect([preflight], read([preflight])); expect(POST75_CATALOGS, read(POST75_CATALOGS));
  fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;${body}
    insert into supabase_migrations.schema_migrations(version,name,statements)values(${quote(name.slice(0,14))},${quote(name.slice(15,-4))},array[${quote(body)}]);commit;`);
  expect(POST76_CATALOGS, read()); expect(POST75_CATALOGS, read(POST75_CATALOGS), { history: false });
  expect([preflight], read([preflight]), { history: false, overrides: { preflight: { existing_pkey_ok: false, new_objects_absent_ok: false } } });
});
test('all six catalogs reject missing, extra or changed history versions and names', () => {
  for (const sql of ["delete from supabase_migrations.schema_migrations where version='20261018013111';",
    "delete from supabase_migrations.schema_migrations where version='20260804200019';",
    "insert into supabase_migrations.schema_migrations(version,name,statements)values('20261019000000','unreviewed',array[]::text[]);",
    "update supabase_migrations.schema_migrations set name='unreviewed' where version='20261018013111';",
    "update supabase_migrations.schema_migrations set version='20261018013110' where version='20261018013111';"])
    expect(POST76_CATALOGS, read(POST76_CATALOGS, sql), { writable: true, history: false });
});
test('new RPC signature, definition, config, owner metadata and exact ACL fail closed', () => {
  for (const sql of [`alter function ${signature} cost 101;`, `alter function ${signature} set timezone='America/Los_Angeles';`,
    `alter function ${signature} security invoker;`, `alter function ${signature} volatile;`,
    `grant execute on function ${signature} to anon;`, `grant execute on function ${signature} to service_role;`,
    `revoke execute on function ${signature} from authenticated;`,
    'create function public.site_admin_get_activation_review_health(text)returns jsonb language sql as $$select null::jsonb$$;'])
    drift(sql, { admin_activation_review_health: { activation_review_rpc_catalog_ok: false } });
});
test('new index and complete source table/ACL/constraints remain exact after activation', () => {
  drift('alter index private.challenge_activation_reviews_unresolved_created_idx rename to unexpected_review_index;', { admin_activation_review_health: { review_indexes_ok: false } });
  drift(`create index unexpected_review_index on ${sourceTable}(resolved_at);`, { admin_activation_review_health: { review_indexes_ok: false } });
  drift(`alter table ${sourceTable} add column unexpected text;`, { admin_activation_review_health: { review_table_shape_ok: false } });
  drift(`alter table ${sourceTable} alter column created_at set default now();`, { admin_activation_review_health: { review_table_shape_ok: false } });
  drift(`alter table ${sourceTable} drop constraint challenge_activation_migration_reviews_check;`, { admin_activation_review_health: { review_constraints_ok: false } });
  for (const sql of [`grant select on ${sourceTable} to authenticated;`, `revoke select on ${sourceTable} from service_role;`, `grant delete on ${sourceTable} to service_role;`])
    drift(sql, { admin_activation_review_health: { review_table_privileges_ok: false } });
});
test('shared Admin guard drift fails old consumers and new aggregate endpoint attestation together', () => {
  drift('alter function private.require_site_admin(text,uuid,boolean) cost 101;', {
    account_request_inbox: { existing_admin_guards_ok: false }, admin_cleanup_health: { existing_admin_guards_ok: false },
    admin_profile_name: { functions_catalog_ok: false }, admin_activation_review_health: { existing_admin_guards_ok: false },
  });
});
test('all old function/index/trigger/ACL checks remain live after76, with no predicate exclusions', () => {
  drift('grant execute on function public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb) to anon;', { account_request_inbox: { inbox_rpc_catalog_ok: false } });
  drift('alter table public.profiles disable trigger z_bind_initial_instance_after_activation;', { repeatable_challenge: { repeatable_trigger_contracts_ok: false, repeatable_initializer_binding_ok: false } });
  drift('alter table public.profiles disable trigger sync_site_admin_profile_name_version;', { repeatable_challenge: { repeatable_trigger_contracts_ok: false }, admin_profile_name: { profile_version_trigger_ok: false } });
  drift('alter index private.profile_photo_objects_cleanup_eligible_idx rename to unexpected_cleanup_index;', { admin_cleanup_health: { cleanup_indexes_ok: false } });
  drift('grant execute on function public.profile_photo_cleanup_monitor_health() to authenticated;', { admin_cleanup_health: { service_health_preserved_ok: false } });
  drift('alter function private.site_admin_audit_payload(bigint) cost 101;', { admin_profile_name: { functions_catalog_ok: false } });
  drift('alter table private.site_admin_audit disable trigger site_admin_audit_immutable;', { admin_profile_name: { audit_immutable_trigger_ok: false } });
  drift('grant select on private.site_admin_profile_name_versions to authenticated;', { admin_profile_name: { sidecar_privileges_ok: false } });
});
test('catalog deparse is fixed despite caller search_path/timezone and all drift rolls back', () => {
  const result = parse(fixture.query(`begin read only;set local search_path=public,private;set local timezone='Pacific/Kiritimati';set local datestyle='SQL, DMY';${receipts(POST76_CATALOGS)}rollback;`));
  expect(POST76_CATALOGS, result); expect(POST76_CATALOGS, read());
});
