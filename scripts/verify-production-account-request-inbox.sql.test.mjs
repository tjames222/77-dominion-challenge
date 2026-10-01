import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';

// Definition/catalog-only fixture. Existing site-admin-account-requests.sql.test.mjs
// remains the independent behavioral/Auth test. No real actors or guards are used.
// Every mutation below is confined to this owned, network-none, tmpfs database.
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const label = `77dc-inbox-checkpoint-${randomUUID()}`;
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const migrationFiles = [
  '20260813163428_add_account_lifecycle_requests.sql',
  '20260913062841_site_admin_foundation.sql',
  '20260929000950_site_admin_account_requests_inbox.sql',
];
const signature = 'public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb)';
const allTrue = Array(11).fill('t').join('|');
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
let container;
let checkpoint;
let rpcDefinition;
let history;

function docker(args, input) {
  return spawnSync('docker', args, {
    input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
}

function ownedContainer() {
  assert.match(container || '', /^[a-f0-9]{64}$/);
  const result = docker(['inspect', container, '--format',
    '{{index .Config.Labels "77dc.inbox-checkpoint"}}|{{.Name}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}']);
  assert.equal(result.status, 0, 'Could not verify ownership of the local checkpoint fixture.');
  assert.equal(result.stdout.trim(), `${label}|/${label}|none|true`);
  return container;
}

function sql(query) {
  const result = docker(['exec', '-i', ownedContainer(), 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-h', '/fixture', '-U', 'postgres', '-d', 'postgres'], query);
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Local checkpoint query failed.');
  return result.stdout.trim();
}

function readOnlyCheckpoint(searchPath = 'public', { asReadOnlyRole = false } = {}) {
  return sql(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL search_path=${literal(searchPath)};
    SET LOCAL timezone='America/Los_Angeles'; SET LOCAL datestyle='SQL, DMY';
    ${asReadOnlyRole ? 'SET LOCAL ROLE supabase_read_only_user;' : ''}
    ${checkpoint}
    ROLLBACK;`);
}

function driftProbe(mutation, falseColumns) {
  const expected = Array(11).fill('t');
  // The raw query is unchanged. The fixture's enclosing transaction must be
  // read-write for local synthetic DDL, so its read-only boolean is false too.
  for (const position of [1, ...falseColumns]) expected[position] = 'f';
  const result = sql(`BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE;
    SET LOCAL check_function_bodies=false;
    ${mutation}
    ${checkpoint}
    ROLLBACK;`);
  assert.equal(result, expected.join('|'));
  assert.equal(readOnlyCheckpoint(), allTrue, 'Synthetic catalog changes must roll back completely.');
}

before(async () => {
  checkpoint = await readFile(new URL('./verify-production-account-request-inbox.sql', import.meta.url), 'utf8');
  const names = (await readdir(migrationDirectory)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  history = names.map(name => ({ version: name.slice(0, 14), name: name.slice(15, -4) }));
  assert.equal(history.length, 71, 'This release checkpoint is pinned to exactly 71 source migrations.');
  assert.equal(new Set(history.map(row => row.version)).size, 71);
  assert.equal(createHash('sha256').update(history.map(row => row.version).join(',')).digest('hex'),
    'e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26');
  assert.deepEqual(history.at(-1), { version: '20261001001245', name: 'repeatable_challenge_instances_v2' });
  const migrations = await Promise.all(migrationFiles.map(file => readFile(new URL(file, migrationDirectory), 'utf8')));
  const inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Pinned PostgreSQL image must already be cached; this test never downloads images.');
  const imageId = inspected.stdout.trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const launched = docker(['run', '--detach', '--pull', 'never', '--name', label,
    '--label', `77dc.inbox-checkpoint=${label}`, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--user', '100:101', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/fixture:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=384m',
    '--entrypoint', 'bash', imageId, '-c',
    'set -euo pipefail;umask 077;initdb --username=postgres --auth=trust --no-locale --encoding=UTF8 -D /fixture/data >/dev/null;exec postgres -D /fixture/data -k /fixture -h "" -c max_worker_processes=0']);
  assert.equal(launched.status, 0, 'Could not create the owned local checkpoint fixture.');
  container = launched.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (docker(['exec', ownedContainer(), 'pg_isready', '-h', '/fixture', '-U', 'postgres']).status === 0) {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Owned checkpoint fixture did not become ready.');
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_read_only_user NOLOGIN BYPASSRLS;
    GRANT pg_read_all_data TO supabase_read_only_user;
    CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text NOT NULL);
    INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES
      ${history.map(row => `(${literal(row.version)},${literal(row.name)})`).join(',')};
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,created_at timestamptz,email_confirmed_at timestamptz,
      is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
    CREATE TABLE auth.mfa_factors(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),factor_type text,status text);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),factor_id uuid,aal text,not_after timestamptz);
    CREATE TABLE auth.mfa_amr_claims(session_id uuid,authentication_method text,updated_at timestamptz);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{}'::jsonb$$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN new.updated_at=now();RETURN new;END$$;
    SET check_function_bodies=false;
    BEGIN;${migrations.join('\n')}COMMIT;`);
  rpcDefinition = JSON.parse(sql(`SET search_path=pg_catalog;
    SELECT pg_catalog.to_jsonb(pg_catalog.pg_get_functiondef(${literal(signature)}::pg_catalog.regprocedure));`));
  assert.equal(sql("SELECT current_setting('server_version_num');"), '170006');
  assert.equal(sql('SELECT (SELECT count(*) FROM auth.users),(SELECT count(*) FROM public.account_lifecycle_requests);'), '0|0');
});

after(() => {
  if (container) {
    const result = docker(['rm', '--force', ownedContainer()]);
    assert.equal(result.status, 0, 'Owned checkpoint fixture cleanup failed.');
  }
});

for (const searchPath of ['public', '', 'private']) {
  test(`source-fixed checkpoint returns exactly eleven true booleans from initial search_path ${JSON.stringify(searchPath)}`, () => {
    assert.equal(readOnlyCheckpoint(searchPath), allTrue);
  });
}

test('catalog-only checkpoint works as a local Supabase-style read-only role without admin execution privileges', () => {
  assert.equal(readOnlyCheckpoint('', { asReadOnlyRole: true }), allTrue);
});

test('a changed RPC body is rejected without invoking the RPC', () => {
  const changed = rpcDefinition.replace('\nAS $function$\n', '\nAS $function$\n-- Synthetic checkpoint drift only.\n');
  assert.notEqual(changed, rpcDefinition);
  driftProbe(`${changed};`, [2]);
});

test('a broadened RPC execution ACL is rejected', () => {
  driftProbe(`GRANT EXECUTE ON FUNCTION ${signature} TO anon;`, [2]);
});

test('a reordered admin index is rejected', () => {
  driftProbe(`DROP INDEX public.account_lifecycle_requests_admin_bucket_idx;
    CREATE INDEX account_lifecycle_requests_admin_bucket_idx
    ON public.account_lifecycle_requests(request_type,status,id,requested_at);`, [4, 5]);
});

test('missing historical prefix row is rejected', () => {
  driftProbe(`DELETE FROM supabase_migrations.schema_migrations WHERE version=${literal(history[0].version)};`, [0]);
});

test('extra migration history is rejected', () => {
  driftProbe("INSERT INTO supabase_migrations.schema_migrations VALUES('20260929000951','unexpected');", [0]);
});

test('changed prefix version at the same count is rejected', () => {
  driftProbe(`UPDATE supabase_migrations.schema_migrations SET version='20260101000000' WHERE version=${literal(history[0].version)};`, [0]);
});

test('wrong final migration name is rejected', () => {
  driftProbe("UPDATE supabase_migrations.schema_migrations SET name='wrong_inbox_name' WHERE version='20260929000950';", [0]);
});

test('removing the inbox migration cannot satisfy the original77 checkpoint', () => {
  driftProbe("DELETE FROM supabase_migrations.schema_migrations WHERE version='20260929000950';", [0]);
});

for (const lastVersion of ['20260927233055', '20260929000950', '20260930152825', '20260930160740', '20260930161218']) {
  test(`earlier history through ${lastVersion} cannot satisfy the exact71 checkpoint`, () => {
    driftProbe(`DELETE FROM supabase_migrations.schema_migrations WHERE version>${literal(lastVersion)};`, [0]);
  });
}

for (const version of ['20260930152825', '20260930160740', '20260930161218', '20261001001245']) {
  test(`incorrect reviewed suffix migration name for ${version} is rejected`, () => {
    driftProbe(`UPDATE supabase_migrations.schema_migrations SET name='wrong_original77_name' WHERE version=${literal(version)};`, [0]);
  });
}

test('lost FORCE RLS is rejected', () => {
  driftProbe('ALTER TABLE public.account_lifecycle_requests NO FORCE ROW LEVEL SECURITY;', [6]);
});

test('broadened member policy is rejected', () => {
  driftProbe('ALTER POLICY "Members can read own account requests" ON public.account_lifecycle_requests USING(true);', [9]);
});

test('definition-only fixture still has no actors or account requests after all rollback probes', () => {
  assert.equal(sql('SELECT (SELECT count(*) FROM auth.users),(SELECT count(*) FROM auth.sessions),\n'
    + '(SELECT count(*) FROM public.account_lifecycle_requests);'), '0|0|0');
});
