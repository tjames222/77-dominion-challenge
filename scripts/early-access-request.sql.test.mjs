import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

// Never accepts a hosted URL or an existing container. The complete cluster is
// private temporary memory, with no published ports and no Docker network.
const container = `77dc-early-access-sql-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const actorId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
let created = false;
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
function rejects(sql, code) {
  return `do $test$ begin begin ${sql} exception when sqlstate '${code}' then return; end; raise exception 'Expected ${code}'; end $test$;`;
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
    create schema auth; create schema private; create schema extensions;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key);
    insert into supabase_migrations.schema_migrations values ('20260913023402');
    grant usage on schema auth, private, public to service_role;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean default false);
    grant select on auth.users to service_role;
    insert into auth.users values ('${actorId}', 'sam@example.com', now(), false), ('${otherId}', 'other@example.com', now(), false);`);
  const migration = await readFile(new URL('../supabase/migrations/20260913023402_early_access_request_intake.sql', import.meta.url), 'utf8');
  query(`begin; ${migration} commit;`);
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
  assert.match(result.stdout, /1\.\.22/);
  assert.doesNotMatch(result.stdout, /not ok|Looks like you failed/);
  assert.equal((result.stdout.match(/^ok \d+ /gm) || []).length, 22);
});
