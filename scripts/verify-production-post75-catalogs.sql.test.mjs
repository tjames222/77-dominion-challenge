import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';
import { verifyPost73ReleaseSources } from './verify-post73-release-plan.mjs';
import { POST75_CATALOGS, assertPost75CatalogsReady } from './verify-production-post75-catalogs.mjs';
import { INBOX_CATALOG_QUERY, INBOX_CATALOG_FIELDS } from './verify-production-account-request-inbox.mjs';
import { ORIGINAL77_CATALOG_QUERY, ORIGINAL77_CATALOG_FIELDS } from './verify-production-original77.mjs';
import { REPEATABLE_CHALLENGE_CATALOG_QUERY, REPEATABLE_CHALLENGE_CATALOG_FIELDS } from './verify-production-repeatable-challenge.mjs';
import { CLEANUP_CATALOG_QUERY, CLEANUP_CATALOG_FIELDS } from './verify-production-admin-cleanup-health.mjs';

// Owned socket-only/network-none/tmpfs fixture; no hosted provider, credential,
// existing cluster, app RPC, Auth session, persistent mount or image pull.
// Source pins are checked before a fixture is created, and again after cleanup.
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const migration75 = '20261013091749_site_admin_profile_name_correction.sql';
const migration75Hash = 'd57754f5d0d072a8ada239e6a6d34483c3dd226fa131b208c5a17336bad7af7f';
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const trim = sql => sql.trim().replace(/;$/u, '');
const oldContracts = [
  { name: 'account_request_inbox', query: INBOX_CATALOG_QUERY, fields: INBOX_CATALOG_FIELDS },
  { name: 'original77', query: ORIGINAL77_CATALOG_QUERY, fields: ORIGINAL77_CATALOG_FIELDS },
  { name: 'repeatable_challenge', query: REPEATABLE_CHALLENGE_CATALOG_QUERY, fields: REPEATABLE_CHALLENGE_CATALOG_FIELDS },
  { name: 'admin_cleanup_health', query: CLEANUP_CATALOG_QUERY, fields: CLEANUP_CATALOG_FIELDS },
];
let fixture; let sources; let old74;
async function reviewedSources() {
  const names = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
  assert.equal(names.length, 75); assert.equal(names.at(-1), migration75);
  const pairs = await Promise.all(names.map(async name => [name, await readFile(new URL(name, migrationDirectory), 'utf8')]));
  const hashes = Object.fromEntries(pairs.map(([name, body]) => [name, sha(body)]));
  verifyPost73ReleaseSources({ migrationFilenames: names.slice(0, 74), migrationSourceHashes: hashes });
  assert.equal(hashes[migration75], migration75Hash);
  return { pairs, hashes };
}
function read(contracts = POST75_CATALOGS, mutation = '') {
  const sql = contracts.map(contract => `select jsonb_build_object('catalog',${quote(contract.name)},'proof',row_to_json(proof)) from (${trim(contract.query)})proof;`).join('\n');
  const output = fixture.query(`begin${mutation ? '' : ' read only'};${mutation}\n${sql}rollback;`);
  return Object.fromEntries(output.split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line); return [row.catalog, row.proof];
  }));
}
function expect(contracts, rows, { writable = false, history = true, overrides = {} } = {}) {
  assert.deepEqual(rows, Object.fromEntries(contracts.map(contract => [contract.name,
    Object.fromEntries(contract.fields.map(field => [field,
      Object.hasOwn(overrides[contract.name] || {}, field) ? overrides[contract.name][field]
        : field === 'exact_migration_history_ok' ? history
          : field === 'read_only_pinned_server_ok' ? !writable : true]))])));
}
function drift(sql, overrides) { expect(POST75_CATALOGS, read(POST75_CATALOGS, sql), { writable: true, overrides }); }

before(async () => {
  assert.equal(assertPost75CatalogsReady(), true);
  sources = await reviewedSources();
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  for (const [name, body] of sources.pairs.slice(70)) {
    if (name === migration75) { old74 = read(oldContracts); expect(oldContracts, old74); }
    fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;${body}
      insert into supabase_migrations.schema_migrations(version,name,statements) values(
        ${quote(name.slice(0, 14))},${quote(name.slice(15, -4))},array[${quote(body)}]::text[]);commit;`);
  }
});
after(async () => {
  try { if (sources) assert.deepEqual((await reviewedSources()).hashes, sources.hashes); }
  finally { fixture?.close(); }
});

test('non-superuser exact74→75 replay passes all53 catalog Booleans, preserving every frozen74 gate', () => {
  assert.equal(fixture.query("select rolsuper from pg_roles where rolname='postgres';"), 'f');
  expect(POST75_CATALOGS, read());
  expect(oldContracts, read(oldContracts), { history: false,
    overrides: { repeatable_challenge: { repeatable_trigger_contracts_ok: false } } });
});

test('new copies reject exact74, missing old entry, extra future suffix, and name/version drift for every catalog', () => {
  for (const sql of [
    "delete from supabase_migrations.schema_migrations where version='20261013091749';",
    "delete from supabase_migrations.schema_migrations where version='20261007055555';",
    "insert into supabase_migrations.schema_migrations(version,name,statements) values('20261014000000','unreviewed',array[]::text[]);",
    "update supabase_migrations.schema_migrations set name='unreviewed' where version='20260929000950';",
    "update supabase_migrations.schema_migrations set name='unreviewed' where version='20261013091749';",
    "update supabase_migrations.schema_migrations set version='20261013091748' where version='20261013091749';",
  ]) expect(POST75_CATALOGS, read(POST75_CATALOGS, sql), { writable: true, history: false });
});

test('inbox RPC privilege drift remains rejected by unchanged catalog predicates', () => {
  drift('grant execute on function public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb) to anon;',
    { account_request_inbox: { inbox_rpc_catalog_ok: false } });
});

test('shared Admin guard drift fails all three consuming catalog checks', () => {
  drift('alter function private.require_site_admin(text,uuid,boolean) cost 101;', {
    account_request_inbox: { existing_admin_guards_ok: false },
    admin_cleanup_health: { existing_admin_guards_ok: false },
    admin_profile_name: { functions_catalog_ok: false },
  });
});

test('existing challenge initializer remains part of the full reviewed trigger aggregate', () => {
  drift('alter table public.profiles disable trigger z_bind_initial_instance_after_activation;',
    { repeatable_challenge: { repeatable_trigger_contracts_ok: false, repeatable_initializer_binding_ok: false } });
});

test('new version trigger is fully included in both the existing challenge aggregate and new name contract', () => {
  drift('alter table public.profiles disable trigger sync_site_admin_profile_name_version;', {
    repeatable_challenge: { repeatable_trigger_contracts_ok: false },
    admin_profile_name: { profile_version_trigger_ok: false },
  });
  drift('create trigger unexpected_version_copy after insert on public.profiles for each row execute function private.sync_site_admin_profile_name_version();', {
    repeatable_challenge: { repeatable_trigger_contracts_ok: false },
    admin_profile_name: { profile_version_trigger_ok: false },
  });
});

test('cleanup index, service-health privileges and registry structure still fail closed', () => {
  drift('alter index private.profile_photo_objects_cleanup_eligible_idx rename to unexpected_cleanup_index;',
    { admin_cleanup_health: { cleanup_indexes_ok: false } });
  drift('grant execute on function public.profile_photo_cleanup_monitor_health() to authenticated;',
    { admin_cleanup_health: { service_health_preserved_ok: false } });
  drift('alter table private.profile_photo_objects add column unexpected text;',
    { admin_cleanup_health: { registry_columns_grants_ok: false } });
});

test('intentional audit-helper replacements use their new pins, not historical helper bodies or widened ACLs', () => {
  drift('alter function private.site_admin_audit_payload(bigint) cost 101;',
    { admin_profile_name: { functions_catalog_ok: false } });
  drift('grant execute on function public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb) to anon;',
    { admin_profile_name: { functions_catalog_ok: false } });
});

test('metadata-only audit shape, immutable trigger and private sidecar privileges cannot drift', () => {
  drift('alter table private.site_admin_audit add column raw_name text;',
    { admin_profile_name: { audit_structure_ok: false } });
  drift('alter table private.site_admin_audit disable trigger site_admin_audit_immutable;',
    { admin_profile_name: { audit_immutable_trigger_ok: false } });
  drift('grant select on private.site_admin_profile_name_versions to authenticated;',
    { admin_profile_name: { sidecar_privileges_ok: false } });
});

test('every mutation rolls back to the same exact75 positive contract without repairing fixtures', () => {
  expect(POST75_CATALOGS, read());
});
