import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Never accepts a hosted URL or an existing container. The complete cluster is
// private temporary memory, with no published ports and no Docker network.
const container = `77dc-early-access-sql-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const actorId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
let created = false; let migration; let authOwnership; let authSchemaOwnership;
const migrationRole = 'fixture_migration';
const helperCall = (id = actorId, email = 'sam@example.com') => `select to_json(private.early_access_verified_identity_matches(${id ? `'${id}'` : 'null'},${email ? `'${email}'` : 'null'}));`;
const command = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
}
function query(sql) {
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function call(email = 'sam@example.com', id = null, name = 'Sam Example') {
  return `select public.submit_early_access_request_service('${name}', '${email}', ${id ? `'${id}'::uuid` : 'null'});`;
}
function rejects(sql, code, message = '') {
  return `do $test$ begin begin ${sql} exception when sqlstate '${code}' then ${message ? `if sqlerrm <> '${message}' then raise; end if;` : ''} return; end; raise exception 'Expected ${code}'; end $test$;`;
}
function parallelQuery(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output, error }));
    child.stdin.end(sql);
  });
}

before(async () => {
  const started = docker(['run', '--detach', '--name', container, '--network', 'none', '--user', 'postgres',
    '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', image, '-c',
    'initdb -D /tmp/early-access-pgdata -A trust && exec postgres -D /tmp/early-access-pgdata -k /tmp -h ""']);
  assert.equal(started.status, 0, started.stderr || started.error?.message);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'Owned PostgreSQL fixture did not become ready');
  query(`create role anon; create role authenticated; create role service_role bypassrls;
    create role supabase_admin nologin nosuperuser nocreatedb nocreaterole;
    create role supabase_auth_admin nologin nosuperuser nocreatedb nocreaterole;
    create role ${migrationRole} nologin nosuperuser nocreatedb nocreaterole nobypassrls;
    -- Match provider schema ownership/usage. Foreign-key checks execute as the
    -- referenced table owner, who must be able to resolve its own Auth table.
    create schema auth authorization supabase_admin;
    create schema private authorization ${migrationRole}; create schema extensions;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key);
    insert into supabase_migrations.schema_migrations values ('20260913023402');
    grant usage on schema auth, private, public to service_role,${migrationRole};
    grant usage on schema auth to supabase_auth_admin;
    grant usage,create on schema public to ${migrationRole};
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean default false,
      deleted_at timestamptz,banned_until timestamptz,encrypted_password text default 'PRIVATE_AUTH_SENTINEL',raw_user_meta_data jsonb default '{"private":"PRIVATE_AUTH_SENTINEL"}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'sub','')::uuid$$;
    insert into auth.users(id,email,email_confirmed_at) values ('${actorId}', 'sam@example.com', now()), ('${otherId}', 'other@example.com', now());
    alter table auth.users owner to supabase_auth_admin;
    grant select,references on auth.users to ${migrationRole};`);
  [authOwnership] = query("select json_build_array(relowner,relacl::text) from pg_class where oid='auth.users'::regclass;");
  [authSchemaOwnership] = query("select json_build_array(nspowner,nspacl::text) from pg_namespace where nspname='auth';");
  migration = await readFile(new URL('../supabase/migrations/20260913023402_early_access_request_intake.sql', import.meta.url), 'utf8');
  query(`set role ${migrationRole};begin; ${migration} commit;`);
});
beforeEach(() => query('truncate private.early_access_requests, private.early_access_intake_attempts;'));
after(() => {
  if (created) {
    const removed = docker(['rm', '--force', container]);
    assert.equal(removed.status, 0, removed.stderr || removed.error?.message);
  }
});

test('real PostgreSQL stores normalized anonymous input and never creates accounts', () => {
  const rows = query(`set role service_role; ${call(' SAM@EXAMPLE.COM ', null, ' Sam Example ')} reset role;
    select row_to_json(r) from private.early_access_requests r;
    select json_build_object('users', count(*)) from auth.users;`);
  assert.deepEqual(rows[0], { received: true });
  assert.equal(rows[1].name, 'Sam Example');
  assert.equal(rows[1].email, 'sam@example.com');
  assert.equal(rows[1].user_id, null);
  assert.equal(rows[1].status, 'pending');
  assert.deepEqual(rows[1].answers, {});
  assert.equal(rows[1].form_version, 1);
  assert.ok(Date.parse(rows[1].created_at));
  assert.deepEqual(rows[2], { users: 2 });
});

test('the original signed-in RPC fails under true service privileges while anonymous intake succeeds', () => {
  const originalCheck = `if p_user_id is not null and not exists (
    select 1 from auth.users where id = p_user_id
      and lower(email) = v_email and email_confirmed_at is not null
      and not coalesce(is_anonymous, false)
  ) then`;
  const correctedCheck = 'if p_user_id is not null and not private.early_access_verified_identity_matches(p_user_id, v_email) then';
  assert.ok(migration.includes(correctedCheck));
  const legacyRpc = migration.slice(migration.indexOf('create function public.submit_early_access_request_service('))
    .replace('create function public.', 'create or replace function public.').replace(correctedCheck, originalCheck);
  // Restore the old body only inside this rolled-back, owned fixture transaction.
  const result = query(`begin;set role ${migrationRole};${legacyRpc}reset role;
    set role service_role;${call()}${rejects(call('sam@example.com', actorId), '42501', 'permission denied for table users')}rollback;`);
  assert.deepEqual(result, [{ received: true }]);
  assert.deepEqual(query(`set role service_role;${call('sam@example.com', actorId)}`), [{ received: true }]);
});

test('migration retains provider Auth ownership/ACLs and the service role cannot read any Auth rows', () => {
  assert.deepEqual(query("select json_build_array(relowner,relacl::text) from pg_class where oid='auth.users'::regclass;"), [authOwnership]);
  assert.deepEqual(query("select json_build_array(nspowner,nspacl::text) from pg_namespace where nspname='auth';"), [authSchemaOwnership]);
  assert.deepEqual(query("select json_build_object('owner',pg_get_userbyid(nspowner),'ownerUsage',has_schema_privilege('supabase_auth_admin',oid,'usage')) from pg_namespace where nspname='auth';"),
    [{ owner: 'supabase_admin', ownerUsage: true }]);
  assert.deepEqual(query(`select json_build_object('owner',pg_get_userbyid(relowner),'serviceRead',has_table_privilege('service_role',oid,'select')) from pg_class where oid='auth.users'::regclass;
    select json_build_object('superuser',rolsuper,'bypass',rolbypassrls) from pg_roles where rolname='${migrationRole}';`),
  [{ owner: 'supabase_auth_admin', serviceRead: false }, { superuser: false, bypass: false }]);
  query(`set role service_role;${rejects('select * from auth.users;', '42501')}`);
  assert.doesNotMatch(migration, /grant\s+[^;]*\bon\s+auth\./i);
});

test('private helper returns only a boolean and rejects user context, wrong accounts and unhealthy identities', () => {
  assert.deepEqual(query(`set role service_role;${helperCall()}${helperCall(otherId)}${helperCall(null)}${helperCall(actorId, null)}`), [true, false, false, false]);
  assert.deepEqual(query(helperCall()), [false], 'privileged SQL without the service request context is not an applicant');
  for (const role of ['anon', 'authenticated']) {
    query(`set role ${role};${rejects(helperCall(), '42501')}`);
  }
  query(`set request.jwt.claims='{"sub":"${actorId}","role":"service_role"}';set role service_role;
    ${rejects(call('sam@example.com', actorId), '42501', 'Verified account mismatch.')}`);
  for (const change of ['email_confirmed_at=null', 'is_anonymous=true', 'deleted_at=now()', "banned_until=now()+interval '1 day'"]) {
    query(`begin;update auth.users set ${change} where id='${actorId}';set role service_role;
      ${rejects(call('sam@example.com', actorId), '42501', 'Verified account mismatch.')}rollback;`);
  }
  assert.deepEqual(query(`begin;update auth.users set banned_until=now()-interval '1 day' where id='${actorId}';set role service_role;${helperCall()}rollback;`), [true]);
  assert.deepEqual(query(`set role service_role;${helperCall(randomUUID())}`), [false]);
});

test('verified duplicate links an anonymous request without replacing its name or status', () => {
  query(call());
  const rows = query(`set role service_role; ${call('sam@example.com', actorId, 'Changed Name')} ${call('sam@example.com', actorId)} reset role;
    select json_build_object('count', count(*), 'user', min(user_id::text), 'name', min(name)) from private.early_access_requests;`);
  assert.deepEqual(rows, [{ received: true }, { received: true }, { count: 1, user: actorId, name: 'Sam Example' }]);
});

test('verified account identity cannot be forged and one pending request survives an email change', () => {
  query(`set role service_role; ${rejects(call('sam@example.com', otherId), '42501')} ${call('sam@example.com', actorId)} reset role;`);
  const rows = query(`begin; update auth.users set email = 'changed@example.com' where id = '${actorId}';
    set role service_role; ${call('changed@example.com', actorId)} reset role;
    select json_build_object('count', count(*)) from private.early_access_requests; rollback;`);
  assert.deepEqual(rows, [{ received: true }, { count: 1 }]);
  query(`begin; update auth.users set email_confirmed_at = null where id = '${actorId}';
    set role service_role; ${rejects(call('sam@example.com', actorId), '42501')} rollback;`);
});

test('private tables and RPC reject browser roles and the function remains INVOKER', () => {
  for (const role of ['anon', 'authenticated']) {
    query(`set role ${role}; ${rejects(call(), '42501')} ${rejects('select * from private.early_access_requests;', '42501')} reset role;`);
  }
  const rows = query(`select json_build_object('invoker', not prosecdef, 'search_path', proconfig @> array['search_path=""']) from pg_proc where proname = 'submit_early_access_request_service';
    select json_build_object('rls', bool_and(relrowsecurity)) from pg_class where oid in ('private.early_access_requests'::regclass, 'private.early_access_intake_attempts'::regclass);`);
  assert.equal(rows[0].invoker, true);
  assert.equal(rows[1].rls, true);
  query(`set role service_role; ${rejects("update private.early_access_requests set status = 'approved';", '42501')} reset role;`);
  query(`set role service_role; ${rejects("insert into private.early_access_requests(name,email,status) values ('Forged','forged@example.com','approved');", '42501')} reset role;`);
});

test('new and existing emails get the same minute-budget response and no extra rows', () => {
  query(call());
  query(`insert into private.early_access_intake_attempts(attempted_at) select clock_timestamp() from generate_series(1,19);`);
  query(`set role service_role; ${rejects(call(), 'P0001')} ${rejects(call('new@example.com'), 'P0001')} reset role;`);
  const rows = query(`select json_build_object('requests', count(*)) from private.early_access_requests;
    select json_build_object('attempts', count(*)) from private.early_access_intake_attempts;`);
  assert.deepEqual(rows, [{ requests: 1 }, { attempts: 20 }]);
});

test('hour budget includes duplicates and expired PII-free counters are reclaimed', () => {
  query(`insert into private.early_access_intake_attempts(attempted_at) select now() - interval '2 minutes' from generate_series(1,100);
    set role service_role; ${rejects(call(), 'P0001')} reset role;
    update private.early_access_intake_attempts set attempted_at = now() - interval '2 hours';`);
  const rows = query(`set role service_role; ${call()} reset role;
    select json_build_object('attempts', count(*)) from private.early_access_intake_attempts;`);
  assert.deepEqual(rows, [{ received: true }, { attempts: 1 }]);
});

test('all existing review statuses return the same generic receipt', () => {
  for (const status of ['pending', 'approved', 'invited', 'accepted', 'denied', 'expired', 'revoked']) {
    query(`truncate private.early_access_requests, private.early_access_intake_attempts;
      insert into private.early_access_requests(name,email,status) values ('Original','sam@example.com','${status}');`);
    assert.deepEqual(query(`set role service_role; ${call()} reset role;`), [{ received: true }]);
    assert.deepEqual(query('select json_build_object(\'status\',status,\'count\',count(*) over()) from private.early_access_requests;'), [{ status, count: 1 }]);
  }
});

test('concurrent unique intake obeys the atomic 20-per-minute cap', async () => {
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => parallelQuery(`set role service_role; ${call(`person${index}@example.com`)}`)));
  assert.equal(results.filter((result) => result.code === 0).length, 20);
  assert.equal(results.filter((result) => result.error.includes('EARLY_ACCESS_RATE_LIMIT')).length, 4);
  assert.deepEqual(query('select json_build_object(\'count\',count(*)) from private.early_access_requests;'), [{ count: 20 }]);
});

test('concurrent duplicate submissions leave one request and consume the shared budget', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => parallelQuery(`set role service_role; ${call()}`)));
  assert.equal(results.every((result) => result.code === 0), true);
  assert.deepEqual(query(`select json_build_object('requests',count(*)) from private.early_access_requests;
    select json_build_object('attempts',count(*)) from private.early_access_intake_attempts;`), [{ requests: 1 }, { attempts: 8 }]);
});

test('canonical pgTAP intake contract passes on the exact migration', async () => {
  const sql = await readFile(new URL('../supabase/tests/database/210_early_access_requests.sql', import.meta.url), 'utf8');
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /1\.\.34/);
  assert.doesNotMatch(result.stdout, /not ok|Looks like you failed/);
  assert.equal((result.stdout.match(/^ok \d+ /gm) || []).length, 34);
});

test('schema-drift provider fixture loads the canonical intake and current Auth dependency shapes', async () => {
  // This additional database is inside the same UUID-named, network-none tmpfs
  // cluster. It cannot target a hosted database or an existing local stack.
  const database = 'schema_drift_fixture';
  const fixture = await readFile(new URL('./fixtures/schema-drift-provider.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(fixture.replace(/^\s*--.*$/gm, ''), /\b(?:grant|revoke|alter\s+(?:role|user)|owner\s+to)\b[^;]*;/i);
  query(`create database ${database} template template0;`);
  const fixtureCommand = [...command.slice(0, -1), database];
  const run = (sql) => docker(fixtureCommand, sql);
  let result = run(fixture);
  assert.equal(result.status, 0, result.stderr || result.error?.message);

  result = run(`select json_build_object(
    'emailType',format_type(a.atttypid,a.atttypmod),
    'anonymousNotNull',(select attnotnull from pg_attribute where attrelid='auth.users'::regclass and attname='is_anonymous'),
    'metadataNullable',(select not attnotnull from pg_attribute where attrelid='auth.users'::regclass and attname='raw_user_meta_data'),
    'serviceRead',has_table_privilege('service_role','auth.users','select'),
    'owner',pg_get_userbyid(c.relowner))
    from pg_attribute a join pg_class c on c.oid=a.attrelid
    where a.attrelid='auth.users'::regclass and a.attname='email';
    -- Parse the exact fields needed by intake and combined Admin/Daily Action.
    select u.id,u.email,u.email_confirmed_at,u.is_anonymous,u.deleted_at,u.banned_until,
      u.created_at,u.last_sign_in_at,s.id,s.user_id,s.factor_id,s.aal,s.not_after,
      f.id,f.user_id,f.factor_type,f.status,a.session_id,a.authentication_method,a.updated_at
    from auth.users u join auth.sessions s on s.user_id=u.id
    join auth.mfa_factors f on f.id=s.factor_id
    join auth.mfa_amr_claims a on a.session_id=s.id where false;
    select json_build_object('aal',enum_range(null::auth.aal_level),
      'type',enum_range(null::auth.factor_type),'status',enum_range(null::auth.factor_status));`);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), [
    { emailType: 'character varying(255)', anonymousNotNull: true, metadataNullable: true, serviceRead: false, owner: 'postgres' },
    { aal: ['aal1', 'aal2', 'aal3'], type: ['totp', 'webauthn', 'phone'], status: ['unverified', 'verified'] },
  ]);

  // Stream only reviewed SQL into the owned tmpfs. This also works with a
  // remote Docker daemon, without exposing .env/config state or account data.
  const sqlDirectory = '/tmp/schema-drift-canonical';
  const archive = spawnSync('tar', ['-C', fileURLToPath(new URL('../supabase', import.meta.url)),
    '-cf', '-', 'schema.sql', 'migrations'], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr?.toString() || archive.error?.message);
  const directory = docker(['exec', container, 'mkdir', sqlDirectory]);
  assert.equal(directory.status, 0, directory.stderr || directory.error?.message);
  const copied = docker(['exec', '-i', container, 'tar', '-C', sqlDirectory, '-xf', '-'], archive.stdout);
  assert.equal(copied.status, 0, copied.stderr || copied.error?.message);

  // Reproduce CI's former missing-column failure using the actual canonical loader.
  // Disconnect rolls back this intentionally failing transaction.
  result = run(`begin;set local search_path=public,extensions;
    alter table auth.users drop column email_confirmed_at;
    \\i ${sqlDirectory}/schema.sql\ncommit;`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /column u\.email_confirmed_at does not exist/);

  result = run(`begin;set local search_path=public,extensions;
    \\i ${sqlDirectory}/schema.sql\ncommit;
    select json_build_object('identityHelper',to_regprocedure('private.early_access_verified_identity_matches(uuid,text)') is not null,
      'serviceRead',has_table_privilege('service_role','auth.users','select'),
      'authRows',(select count(*) from auth.users));`);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)),
    { identityHelper: true, serviceRead: false, authRows: 0 });
});
