import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

// Destructive fixture setup is confined to this owned, network-none, tmpfs DB.
const container = `77dc-admin-sql-${randomUUID()}`;
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const third = '10000000-0000-4000-8000-000000000003';
const factor = '20000000-0000-4000-8000-000000000001';
const otherFactor = '20000000-0000-4000-8000-000000000002';
const session = '30000000-0000-4000-8000-000000000001';
const approval = '40000000-0000-4000-8000-000000000001';
let created = false;
let migration;
const command = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
const literal = (value) => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
function docker(args, input) { return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }); }
function query(sql) {
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
function parallel(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', command); let output = ''; let error = '';
    child.stdout.on('data', (v) => { output += v; }); child.stderr.on('data', (v) => { error += v; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, output, error })); child.stdin.end(sql);
  });
}
function asActor(sql, { id = actor, sid = session, aal = 'aal2', origin = 'https://77dominion.com', age = 0, claims = {} } = {}) {
  const jwt = { sub: id, role: 'authenticated', session_id: sid, aal,
    amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - age }], ...claims };
  return `set request.jwt.claims=${literal(JSON.stringify(jwt))}; set request.headers=${literal(JSON.stringify({ origin }))}; set role authenticated; ${sql}`;
}
function denied(sql, state = '42501', message = '') {
  return `do $test$ begin begin ${sql} exception when sqlstate '${state}' then ${message ? `if sqlerrm<>${literal(message)} then raise; end if;` : ''} return; end; raise exception 'Expected denial'; end $test$;`;
}
const context = (id = actor) => `select public.get_site_admin_context('${id}');`;
const enroll = (id = actor, fid = factor) => `insert into auth.mfa_factors(id,user_id,factor_type,status) values('${fid}','${id}','totp','verified');`;
const signIn = (id = actor, sid = session, fid = factor, age = 0) => `insert into auth.sessions(id,user_id,factor_id,aal) values('${sid}','${id}','${fid}','aal2'); insert into auth.mfa_amr_claims(session_id,authentication_method,created_at,updated_at) values('${sid}','totp',clock_timestamp()-interval '${age} seconds',clock_timestamp()-interval '${age} seconds');`;
const bootstrap = () => `select private.bootstrap_site_admin('${actor}','${approval}','production');`;
function ready() { query(enroll() + bootstrap() + signIn()); }
function assign({ target = other, role = 'site_admin', revision = 0, request = randomUUID(), correlation = randomUUID(), reason = 'approved_role_change' } = {}) {
  return `select public.site_admin_assign_role('${actor}',${literal(target)},${literal(role)},${revision},'${request}','${correlation}',${literal(reason)});`;
}

before(async () => {
  migration = await readFile(new URL('../supabase/migrations/20260913062841_site_admin_foundation.sql', import.meta.url), 'utf8');
  const started = docker(['run', '--detach', '--name', container, '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', 'public.ecr.aws/supabase/postgres:17.6.1.141', '-c', 'initdb -D /tmp/admin-pgdata -A trust && exec postgres -D /tmp/admin-pgdata -k /tmp -h ""']);
  assert.equal(started.status, 0, started.stderr); created = true;
  for (let n = 0; n < 100; n += 1) {
    if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  query('create role anon; create role authenticated; create role service_role bypassrls; create schema extensions;');
});
beforeEach(() => {
  query(`drop schema if exists auth cascade; drop schema if exists private cascade; drop schema public cascade; create schema public; create schema auth;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz);
    create table auth.mfa_factors(id uuid primary key,user_id uuid not null references auth.users on delete cascade,factor_type text,status text);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users on delete cascade,factor_id uuid references auth.mfa_factors on delete set null,aal text,not_after timestamptz);
    create table auth.mfa_amr_claims(session_id uuid references auth.sessions on delete cascade,authentication_method text,created_at timestamptz,updated_at timestamptz,unique(session_id,authentication_method));
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    insert into auth.users(id) values('${actor}'),('${other}'),('${third}');
    create table public.fixture_crew_roles(user_id uuid,role text);insert into public.fixture_crew_roles values('${actor}','owner'),('${other}','admin');
    create table public.fixture_entitlements(user_id uuid,source text);insert into public.fixture_entitlements values('${actor}','stripe');
    create table public.fixture_journal(user_id uuid,body text);insert into public.fixture_journal values('${other}','PRIVATE JOURNAL SENTINEL');
    alter table public.fixture_journal enable row level security;create policy own on public.fixture_journal for select to authenticated using(user_id=(select auth.uid()));grant select on public.fixture_journal to authenticated;
    begin;${migration}commit;`);
});
after(() => { if (created) { const removed = docker(['rm', '--force', container]); assert.equal(removed.status, 0, removed.stderr); } });

test('baseline platform copy restores the real Auth dump without later application triggers', async () => {
  const rehearsal = await readFile(new URL('./rehearse-baseline-reconciliation.sh', import.meta.url), 'utf8');
  const filter = rehearsal.match(/\| awk '([\s\S]*?)\n      '/)?.[1];
  assert.ok(filter);
  const dump = docker(['exec', container, 'pg_dump', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--schema=auth', '--no-owner', '--no-privileges']);
  assert.equal(dump.status, 0, dump.stderr);
  assert.match(dump.stdout, /CREATE TRIGGER initialize_site_member/);
  assert.match(dump.stdout, /CREATE TRIGGER guard_final_site_admin_auth/);
  assert.match(dump.stdout, /CREATE TRIGGER guard_final_site_admin_factor/);
  const filtered = spawnSync('awk', [filter], { input: dump.stdout, encoding: 'utf8' });
  assert.equal(filtered.status, 0, filtered.stderr);
  const database = `platform_copy_${randomUUID().replaceAll('-', '')}`;
  query(`create database ${database} template template0;`);
  try {
    const restored = docker([...command.slice(0, -1), database], filtered.stdout);
    assert.equal(restored.status, 0, restored.stderr);
    const verified = docker([...command.slice(0, -1), database], "select json_build_object('users',to_regclass('auth.users') is not null,'factors',to_regclass('auth.mfa_factors') is not null,'private',to_regnamespace('private') is not null,'rows',(select count(*) from auth.users));");
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout.trim()), { users: true, factors: true, private: false, rows: 0 });
  } finally { query(`drop database ${database};`); }
});

test('existing/new accounts default to member without changing crew, Stripe or private content', () => {
  query(`insert into auth.users(id) values('${randomUUID()}');`);
  assert.deepEqual(query("select jsonb_build_object('count',count(*),'allMembers',bool_and(role_key='member')) from private.site_user_roles;"), [{ count: 4, allMembers: true }]);
  assert.deepEqual(query("select to_jsonb(array_agg(role order by role)) from public.fixture_crew_roles;select to_jsonb(source) from public.fixture_entitlements;"), [['admin', 'owner'], 'stripe']);
  query(enroll() + signIn());
  const [result] = query(asActor(context(), { claims: { user_metadata: { role: 'site_admin' }, app_metadata: { site_admin: true } } }));
  assert.deepEqual(result, { schemaVersion: 1, actorId: actor, role: 'member', adminReady: false });
  query(asActor(denied(`perform * from private.site_user_roles;`) + denied(`perform * from private.site_admin_audit;`) + denied(assign().replace('select ', 'perform '), 'PT403')));
});

test('bootstrap is operator-only, explicit-environment, verified TOTP, repeat-safe and never auto-applied', () => {
  query(denied(`perform private.bootstrap_site_admin('${actor}','${approval}','production');`, '42501', 'admin_bootstrap_verified_mfa_required'));
  query(enroll() + signIn());
  for (const role of ['anon', 'authenticated', 'service_role']) query(`set role ${role};${denied(`perform private.bootstrap_site_admin('${actor}','${approval}','production');`)}`);
  query(denied(`perform private.bootstrap_site_admin('${actor}','${approval}','preview');`, '22023', 'admin_environment_mismatch'));
  assert.equal(query(bootstrap())[0].applied, true);
  assert.equal(query(bootstrap())[0].alreadyApplied, true);
  query(denied(`perform private.bootstrap_site_admin('${other}','${randomUUID()}','production');`, '42501', 'admin_bootstrap_already_used'));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_admin_audit;'), [1]);
  const [blocked] = query(asActor(context())); assert.equal(blocked.reason, 'reauthentication_required'); assert.equal(blocked.permissions, undefined);
});

test('readiness requires a real active verified account and live session even before role disclosure', () => {
  ready();
  for (const options of [{ id: other }, { origin: 'https://attacker.example' }, { sid: randomUUID() }, { claims: { role: 'service_role' } }]) {
    const code = options.origin ? 'PT403' : 'PT401'; query(asActor(denied(context().replace('select ', 'perform '), code), options));
  }
  for (const change of ["is_anonymous=true", 'email_confirmed_at=null', "banned_until=now()+interval '1 day'", 'deleted_at=now()']) {
    // A second usable admin permits lifecycle fixture changes; never bypass the guard.
    query(enroll(other, otherFactor) + `update private.site_user_roles set role_key='site_admin' where user_id='${other}';`);
    query(`update auth.users set ${change} where id='${actor}';`);
    query(asActor(denied(context().replace('select ', 'perform '), 'PT401')));
    query(`update auth.users set is_anonymous=false,email_confirmed_at=now(),banned_until=null,deleted_at=null where id='${actor}';delete from auth.mfa_factors where id='${otherFactor}';update private.site_user_roles set role_key='member' where user_id='${other}';`);
  }
  query(`delete from auth.sessions where id='${session}';`);
  query(asActor(denied(context().replace('select ', 'perform '), 'PT401')));
});

test('AAL1 discloses no permissions; AAL2 reads are separate from ten-minute TOTP step-up writes', () => {
  ready();
  const [aal1] = query(asActor(context(), { aal: 'aal1' })); assert.equal(aal1.reason, 'mfa_required'); assert.equal(aal1.permissions, undefined);
  const [fresh] = query(asActor(context())); assert.equal(fresh.adminReady, true); assert.equal(fresh.stepUpRequired, false); assert.equal(fresh.permissions.length, 8);
  const [old] = query(asActor(context(), { age: 601 })); assert.equal(old.adminReady, true); assert.equal(old.stepUpRequired, true);
  query(asActor(denied(assign().replace('select ', 'perform '), 'PT403'), { age: 601, claims: { iat: Math.floor(Date.now() / 1000) } }));
  query(`update auth.mfa_amr_claims set updated_at=now()-interval '11 minutes';`);
  query(asActor(denied(assign().replace('select ', 'perform '), 'PT403')));
  query(`update auth.mfa_amr_claims set updated_at=now();update auth.sessions set aal='aal1';`);
  assert.equal(query(asActor(context()))[0].adminReady, false);
});

test('same-session verified TOTP cannot be replaced by another account factor or malformed JWT AMR', () => {
  ready(); query(enroll(other, otherFactor));
  query(`update auth.sessions set factor_id='${otherFactor}';`);
  assert.equal(query(asActor(context()))[0].adminReady, false);
  query(`update auth.sessions set factor_id='${factor}';`);
  for (const amr of [{ method: 'totp' }, [{ method: 'totp', timestamp: '999999999999999999999999999' }], [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }]]) {
    query(asActor(denied(assign().replace('select ', 'perform '), 'PT403'), { claims: { amr } }));
  }
});

test('role changes are revision-checked, audited once, idempotent, and block every preexisting target session', async () => {
  ready(); query(enroll(other, otherFactor) + signIn(other, randomUUID(), otherFactor));
  const request = randomUUID(); const correlation = randomUUID(); const sql = asActor(assign({ request, correlation }));
  const attempts = await Promise.all([parallel(sql), parallel(sql)]);
  for (const attempt of attempts) { assert.equal(attempt.code, 0, attempt.error); assert.equal(JSON.parse(attempt.output).revision, 1); }
  assert.deepEqual(query("select to_jsonb(count(*)) from private.site_admin_audit where action='roles.assign';"), [1]);
  query(asActor(denied(assign({ request, correlation, role: 'member' }).replace('select ', 'perform '), '22023', 'admin_idempotency_conflict')));
  assert.deepEqual(query(asActor(assign({ revision: 0 })))[0], { ok: false, errorCode: 'revision_conflict' });
  const [row] = query(`select jsonb_build_object('blocked',count(*)) from private.site_admin_session_blocks where user_id='${other}';`); assert.equal(row.blocked, 1);
});

test('self-actions, missing target MFA and invalid inputs fail safely without persisting raw text', () => {
  ready();
  assert.equal(query(asActor(assign({ target: actor, revision: 1, role: 'member' })))[0].errorCode, 'self_action_forbidden');
  assert.equal(query(asActor(assign()))[0].errorCode, 'target_mfa_required');
  assert.equal(query(asActor(assign({ reason: 'SECRET PRIVATE JOURNAL SENTINEL', role: 'UNTRUSTED BODY' })))[0].errorCode, 'invalid_input');
  assert.deepEqual(query("select to_jsonb(bool_or(row_to_json(a)::text like '%SENTINEL%' or row_to_json(a)::text like '%UNTRUSTED%')) from private.site_admin_audit a;select to_jsonb(bool_or(row_to_json(a)::text like '%SENTINEL%' or row_to_json(a)::text like '%UNTRUSTED%')) from private.site_admin_role_requests a;"), [false, false]);
  assert.deepEqual(query(asActor('select to_jsonb(count(*)) from public.fixture_journal;')), [0]);
});

test('final administrator cannot be demoted, deleted, suspended or lose its only verified TOTP', () => {
  ready();
  for (const sql of [`update private.site_user_roles set role_key='member' where user_id='${actor}';`, `delete from private.site_user_roles where user_id='${actor}';`, `delete from auth.users where id='${actor}';`, `update auth.users set banned_until=now()+interval '1 day' where id='${actor}';`, `update auth.users set deleted_at=now() where id='${actor}';`, `delete from auth.mfa_factors where id='${factor}';`, `update auth.mfa_factors set status='unverified' where id='${factor}';`, `update auth.mfa_factors set user_id='${other}' where id='${factor}';`]) query(denied(sql, '42501', 'admin_final_recovery_path'));
  for (const change of ['email_confirmed_at=null', 'is_anonymous=true']) query(denied(`update auth.users set ${change} where id='${actor}';`, '42501', 'admin_final_recovery_path'));
  const replacement = randomUUID(); query(enroll(actor, replacement) + `delete from auth.mfa_factors where id='${factor}';`);
  query(enroll(other, otherFactor) + `delete from auth.mfa_factors where id='${otherFactor}';delete from auth.users where id='${other}';`);
});

test('simultaneous removal of two usable admins cannot remove both recovery paths', async () => {
  ready(); query(enroll(other, otherFactor) + `update private.site_user_roles set role_key='site_admin' where user_id='${other}';`);
  const results = await Promise.all([actor, other].map((id) => parallel(`begin;update private.site_user_roles set role_key='member' where user_id='${id}';select pg_sleep(0.05);commit;`)));
  assert.equal(results.filter((r) => r.code === 0).length, 1); assert.equal(results.filter((r) => r.error.includes('admin_final_recovery_path')).length, 1);
  assert.deepEqual(query("select to_jsonb(count(*)) from private.site_user_roles where role_key='site_admin';"), [1]);
});

test('simultaneous removal of both admins\' final TOTP factors preserves one usable recovery path', async () => {
  ready(); query(enroll(other, otherFactor) + `update private.site_user_roles set role_key='site_admin' where user_id='${other}';`);
  const results = await Promise.all([factor, otherFactor].map((id) => parallel(`begin;delete from auth.mfa_factors where id='${id}';select pg_sleep(0.05);commit;`)));
  assert.equal(results.filter((r) => r.code === 0).length, 1); assert.equal(results.filter((r) => r.error.includes('admin_final_recovery_path')).length, 1);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_user_roles where private.site_admin_is_usable(user_id);'), [1]);
});

test('mixed role demotion and Auth deletion serialize across the same recovery boundary', async () => {
  ready(); query(enroll(other, otherFactor) + `update private.site_user_roles set role_key='site_admin' where user_id='${other}';`);
  const results = await Promise.all([
    parallel(`begin;update private.site_user_roles set role_key='member' where user_id='${actor}';select pg_sleep(0.05);commit;`),
    parallel(`begin;delete from auth.users where id='${other}';select pg_sleep(0.05);commit;`),
  ]);
  assert.equal(results.filter((r) => r.code === 0).length, 1); assert.equal(results.filter((r) => r.error.includes('admin_final_recovery_path')).length, 1);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_user_roles where private.site_admin_is_usable(user_id);'), [1]);
});

test('canonical revocation defeats a still-AAL2 JWT; no admin may read or modify the audit directly', () => {
  ready(); query(enroll(other, otherFactor) + `update private.site_user_roles set role_key='site_admin' where user_id='${other}';update private.site_user_roles set role_key='member' where user_id='${actor}';`);
  query(asActor(denied(assign().replace('select ', 'perform '), 'PT403')));
  assert.equal(query(asActor(context()))[0].role, 'member');
  for (const table of ['site_admin_audit', 'site_admin_bootstrap_receipt']) {
    for (const sql of [`update private.${table} set environment='local';`, `delete from private.${table};`, `truncate private.${table};`]) query(denied(sql, '42501', 'admin_immutable_record'));
  }
});

test('an audit persistence error rolls the role and session-block mutation back atomically', () => {
  ready(); query(enroll(other, otherFactor));
  query("create function private.fixture_reject_audit() returns trigger language plpgsql as $$begin raise exception 'fixture audit unavailable';end$$;create trigger fixture_reject_audit before insert on private.site_admin_audit for each row execute function private.fixture_reject_audit();");
  const result = docker(command, asActor(assign())); assert.notEqual(result.status, 0); assert.match(result.stderr, /fixture audit unavailable/);
  assert.deepEqual(query(`select to_jsonb(role_key) from private.site_user_roles where user_id='${other}';select to_jsonb(count(*)) from private.site_admin_role_requests;select to_jsonb(count(*)) from private.site_admin_session_blocks;`), ['member', 0, 0]);
});

test('mutation budget permits at most 20 attempts/minute and prevents unbounded rejected-write growth', () => {
  ready();
  for (let n = 0; n < 20; n += 1) assert.equal(query(asActor(assign()))[0].errorCode, 'target_mfa_required');
  for (let n = 0; n < 3; n += 1) assert.equal(query(asActor(assign()))[0].errorCode, 'rate_limited');
  assert.deepEqual(query("select to_jsonb(count(*)) from private.site_admin_audit where action='roles.assign';select to_jsonb(count(*)) from private.site_admin_role_requests;"), [20, 20]);
});

test('the hourly budget is independent of the per-minute budget', () => {
  ready();
  query(`insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,before_role,after_role,request_id,correlation_id,environment,occurred_at,outcome,error_code)
    select '${actor}','${other}','roles.assign','roles.manage','approved_role_change','member','member',gen_random_uuid(),gen_random_uuid(),'production',clock_timestamp()-interval '2 minutes','failure','target_mfa_required' from generate_series(1,100);`);
  assert.equal(query(asActor(assign()))[0].errorCode, 'rate_limited');
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_admin_role_requests;'), [0]);
});

test('context success is explicitly private/no-store and session expiry fails closed', () => {
  ready();
  const rows = query(asActor(`begin;${context()}select current_setting('response.headers')::jsonb;commit;`));
  assert.deepEqual(rows[1], [{ 'Cache-Control': 'private, no-store' }, { Pragma: 'no-cache' }]);
  query(`update auth.sessions set not_after=now()-interval '1 second';`);
  query(asActor(denied(context().replace('select ', 'perform '), 'PT401')));
});

test('the registered pgTAP foundation executes all 30 structural assertions', async () => {
  const sql = await readFile(new URL('../supabase/tests/database/240_site_admin_foundation.sql', import.meta.url), 'utf8');
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /^not ok/m); assert.match(result.stdout, /1\.\.30/);
});

test('canonical schema-drift Auth dependencies replay the foundation without fabricating readiness', async () => {
  const providerFixture = await readFile(new URL('./fixtures/schema-drift-provider.sql', import.meta.url), 'utf8');
  const authDependencies = providerFixture.match(/create schema auth;[\s\S]*?(?=create schema storage;)/)?.[0];
  assert.ok(authDependencies, 'the canonical fixture must retain its Auth dependency section');
  query(`drop schema private cascade;drop schema auth cascade;drop schema public cascade;create schema public;
    ${authDependencies}grant usage on schema public,auth to authenticated;begin;${migration}commit;
    insert into auth.users(id,email,email_confirmed_at)values('${actor}','fixture@example.invalid',now());`);
  assert.deepEqual(query(`select to_jsonb(role_key) from private.site_user_roles where user_id='${actor}';select to_jsonb(count(*)) from auth.sessions;select to_jsonb(count(*)) from auth.mfa_factors;`), ['member', 0, 0]);
  // A token-shaped setting alone cannot make an absent Auth session live.
  query(asActor(denied(context().replace('select ', 'perform '), 'PT401')));
});
