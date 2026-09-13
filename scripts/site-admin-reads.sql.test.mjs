import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

const container = `77dc-admin-reads-${randomUUID()}`;
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const session = '30000000-0000-4000-8000-000000000001';
const factor = '20000000-0000-4000-8000-000000000001';
const secret = 'PRIVATE_SECRET_SENTINEL';
let created = false; let foundation; let migration; let authOwnership;
const migrationRole = 'fixture_migration';
const command = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
const literal = (v) => v === null ? 'null' : `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => v === null ? 'null' : `${literal(JSON.stringify(v))}::jsonb`;
function docker(args, input) { return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); }
function query(sql) { const r = docker(command, sql); assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse); }
function parallel(sql) { return new Promise((resolve, reject) => {
  const child = spawn('docker', command); let output = ''; let error = '';
  child.stdout.on('data', (v) => { output += v; }); child.stderr.on('data', (v) => { error += v; });
  child.on('error', reject); child.on('close', (code) => resolve({ code, output, error })); child.stdin.end(sql);
}); }
function asActor(sql, { id = actor, sid = session, aal = 'aal2', origin = 'https://77dominion.com', claims = {} } = {}) {
  return `set request.jwt.claims=${literal(JSON.stringify({ sub: id, session_id: sid, role: 'authenticated', aal, ...claims }))};set request.headers=${literal(JSON.stringify({ origin }))};set role authenticated;${sql}`;
}
function denied(sql, state = 'PT403', message = '') { return `do $t$ begin begin ${sql.replace(/^select /, 'perform ')} exception when sqlstate '${state}' then ${message ? `if sqlerrm<>${literal(message)} then raise;end if;` : ''} return;end;raise exception 'Expected denial';end $t$;`; }
const users = ({ expected = actor, limit = 25, search = '', status = 'all', role = 'all', sort = 'newest', cursor = null } = {}) => `select public.site_admin_list_users('${expected}',${limit},${literal(search)},${literal(status)},${literal(role)},${literal(sort)},${json(cursor)});`;
const detail = (id = other, expected = actor) => `select public.site_admin_get_user('${expected}','${id}');`;
const audits = ({ expected = actor, limit = 25, target = null, action = 'all', outcome = 'all', cursor = null } = {}) => `select public.site_admin_list_audit('${expected}',${limit},${literal(target)},${literal(action)},${literal(outcome)},${json(cursor)});`;
const auditDetail = (id = '1', expected = actor) => `select public.site_admin_get_audit_event('${expected}',${literal(id)});`;
const auditRow = (n = 1) => `insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,before_role,after_role,request_id,correlation_id,environment,outcome,error_code)
  select '${actor}','${other}','roles.assign','roles.manage','approved_role_change','member','member',gen_random_uuid(),gen_random_uuid(),'production',case when n%2=0 then 'success' else 'failure' end,case when n%2=0 then null else 'revision_conflict' end from generate_series(1,${n}) n;`;

before(async () => {
  foundation = await readFile(new URL('../supabase/migrations/20260913062841_site_admin_foundation.sql', import.meta.url), 'utf8');
  migration = await readFile(new URL('../supabase/migrations/20260913065057_site_admin_read_apis.sql', import.meta.url), 'utf8');
  const r = docker(['run', '--detach', '--name', container, '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', 'public.ecr.aws/supabase/postgres:17.6.1.141', '-c', 'initdb -D /tmp/read-pgdata -A trust && exec postgres -D /tmp/read-pgdata -k /tmp -h ""']);
  assert.equal(r.status, 0, r.stderr); created = true;
  for (let n = 0; n < 100; n += 1) { if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  query(`create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;
    create role supabase_auth_admin nologin nosuperuser nocreatedb nocreaterole;
    create role ${migrationRole} nologin nosuperuser nocreatedb nocreaterole nobypassrls;
    grant create on database postgres to ${migrationRole};`);
});
beforeEach(() => {
  // Only this owned, network-none, tmpfs fixture is rebuilt. Never a hosted DB.
  query(`drop schema if exists auth cascade;drop schema if exists private cascade;drop schema public cascade;create schema public;create schema auth;
    grant usage on schema public,auth to anon,authenticated,service_role,${migrationRole};
    grant usage on schema auth to supabase_auth_admin;
    grant create on schema public to ${migrationRole};
    create table auth.users(id uuid primary key,email text,created_at timestamptz,last_sign_in_at timestamptz,email_confirmed_at timestamptz default now(),is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz,encrypted_password text default '${secret}',raw_user_meta_data jsonb default '{"secret":"${secret}"}');
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_type text,status text,secret text default '${secret}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_id uuid,aal text,not_after timestamptz);
    create table auth.mfa_amr_claims(session_id uuid,authentication_method text,updated_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    insert into auth.users(id,email,created_at) values('${actor}','admin@example.invalid','2026-01-02'),('${other}','member@example.invalid','2026-01-01');
    -- Model the hosted boundary: the application migration role has table ACLs,
    -- not ownership or superuser. Provider Auth owns its four relations.
    alter table auth.users owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;
    alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger,maintain on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to ${migrationRole};
    set role ${migrationRole};
    create table public.profiles(user_id uuid primary key,name text,challenge_activation_status text,challenge_participation_mode text,challenge_start_date date,challenge_activation_review_required boolean,challenge_activation_updated_at timestamptz,avatar_url text default '${secret}');
    insert into public.profiles(user_id,name,challenge_activation_status,challenge_participation_mode) values('${actor}','Administrator','not_started',null),('${other}','Member','scheduled','solo');
    create table public.user_game_stats(user_id uuid primary key,total_points integer,current_app_streak integer,current_full_day_streak integer,last_seen_date date,updated_at timestamptz);
    create table public.crews(id uuid primary key,name text,description text default '${secret}');
    create table public.crew_members(user_id uuid unique,crew_id uuid,role text);
    insert into public.crews values('40000000-0000-4000-8000-000000000001','Crew','${secret}');insert into public.crew_members values('${other}','40000000-0000-4000-8000-000000000001','owner');
    create table public.account_lifecycle_requests(id uuid primary key default gen_random_uuid(),user_id uuid,request_type text,status text,requested_at timestamptz default now(),operator_note text default '${secret}');
    create table public.subscriptions(id uuid primary key default gen_random_uuid(),user_id uuid,product_key text,status text,current_period_end timestamptz,cancel_at_period_end boolean,updated_at timestamptz,stripe_customer_id text default '${secret}',stripe_subscription_id text default '${secret}');
    create table public.fixture_journal(user_id uuid,body text);insert into public.fixture_journal values('${other}','${secret}');
    alter table public.fixture_journal enable row level security;create policy own on public.fixture_journal for select to authenticated using(user_id=(select auth.uid()));grant select on public.fixture_journal to authenticated;
    begin;${foundation}commit;reset role;`);
  authOwnership = query("select jsonb_agg(jsonb_build_array(relname,relowner,relacl::text) order by relname) from pg_class where oid in ('auth.users'::regclass,'auth.sessions'::regclass,'auth.mfa_factors'::regclass,'auth.mfa_amr_claims'::regclass);");
  query(`set role ${migrationRole};begin;${migration}commit;reset role;
    insert into auth.mfa_factors(id,user_id,factor_type,status) values('${factor}','${actor}','totp','verified');
    select private.bootstrap_site_admin('${actor}','50000000-0000-4000-8000-000000000001','production');
    insert into auth.sessions values('${session}','${actor}','${factor}','aal2',null);`);
});
after(() => { if (created) { const r = docker(['rm', '--force', container]); assert.equal(r.status, 0, r.stderr); } });

test('provider-owned Auth rejects the original index DDL while the exact corrected migration runs without ownership escalation', () => {
  query(`set role ${migrationRole};${denied("create index forbidden_auth_index on auth.users(created_at,id);", '42501', 'must be owner of table users')}`);
  assert.deepEqual(query(`select jsonb_build_object('superuser',rolsuper,'bypass',rolbypassrls) from pg_roles where rolname='${migrationRole}';
    select to_jsonb(pg_get_userbyid(relowner)) from pg_class where oid='auth.users'::regclass;
    select to_jsonb(pg_get_userbyid(relowner)) from pg_class where oid='private.site_admin_user_directory'::regclass;`),
  [{ superuser: false, bypass: false }, 'supabase_auth_admin', migrationRole]);
  assert.deepEqual(query("select to_jsonb(count(*)) from pg_indexes where schemaname='auth' and indexname like 'site_admin_%';"), [0]);
  assert.deepEqual(query("select jsonb_agg(jsonb_build_array(relname,relowner,relacl::text) order by relname) from pg_class where oid in ('auth.users'::regclass,'auth.sessions'::regclass,'auth.mfa_factors'::regclass,'auth.mfa_amr_claims'::regclass);"), authOwnership);
  assert.doesNotMatch(migration, /alter\s+(?:table\s+auth\.|role\s)|set\s+(?:local\s+)?role\s|grant\s+[^;]*\bon\s+auth\./i);
});

test('private search projection is backfilled exactly and synchronizes provider INSERT/UPDATE/DELETE in the same transaction', () => {
  assert.deepEqual(query('select jsonb_agg(jsonb_build_array(user_id,email,created_at) order by user_id) from private.site_admin_user_directory;'),
    query('select jsonb_agg(jsonb_build_array(id,lower(email),created_at) order by id) from auth.users;'));
  const id = randomUUID();
  query(`set role supabase_auth_admin;insert into auth.users(id,email,created_at) values('${id}','MiXeD@example.invalid',null);`);
  assert.deepEqual(query(`select jsonb_build_array(email,created_at) from private.site_admin_user_directory where user_id='${id}';`), [['mixed@example.invalid', null]]);
  query(`set role supabase_auth_admin;update auth.users set email='New@example.invalid',created_at='2026-02-01' where id='${id}';`);
  assert.deepEqual(query(`select jsonb_build_array(email,created_at) from private.site_admin_user_directory where user_id='${id}';`), [['new@example.invalid', '2026-02-01T00:00:00+00:00']]);
  assert.deepEqual(query(asActor(users({ search: 'NEW@' })))[0].items.map((v) => v.id), [id]);
  query(`set role supabase_auth_admin;begin;update auth.users set email='rollback@example.invalid' where id='${id}';rollback;`);
  assert.deepEqual(query(`select jsonb_build_array(u.email,d.email) from auth.users u join private.site_admin_user_directory d on d.user_id=u.id where u.id='${id}';`), [['New@example.invalid', 'new@example.invalid']]);
  query(`set role supabase_auth_admin;delete from auth.users where id='${id}';`);
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.site_admin_user_directory where user_id='${id}';`), [0]);
});

test('projection has no client/service grants and stale operator-corrupted entries cannot create false account matches', () => {
  for (const role of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
    query(`set role ${role};${denied('select * from private.site_admin_user_directory;', '42501')}`);
    query(`set role ${role};${denied('select private.sync_site_admin_user_directory();', '42501')}`);
  }
  assert.deepEqual(query("select to_jsonb(relrowsecurity) from pg_class where oid='private.site_admin_user_directory'::regclass;"), [true]);
  query(`update private.site_admin_user_directory set email='forged@example.invalid' where user_id='${other}';`);
  assert.deepEqual(query(asActor(users({ search: 'forged@' })))[0].items, []);
  assert.deepEqual(query(asActor(users({ search: 'Member' })))[0].items, []);
  // Direct detail remains canonical; a search projection never owns identity.
  assert.equal(query(asActor(detail()))[0].item.email, 'member@example.invalid');
  query(`update private.site_admin_user_directory set email='member@example.invalid',created_at='2099-01-01' where user_id='${other}';`);
  assert.deepEqual(query(asActor(users({ search: 'member@' })))[0].items, []);
});

test('a projection write failure rolls the provider Auth INSERT and UPDATE back atomically', () => {
  query("create function private.fixture_reject_directory() returns trigger language plpgsql as $$begin raise exception 'fixture directory unavailable';end$$;create trigger fixture_reject_directory before insert or update on private.site_admin_user_directory for each row execute function private.fixture_reject_directory();");
  const id = randomUUID();
  for (const sql of [`insert into auth.users(id,email) values('${id}','rollback@example.invalid');`, `update auth.users set email='rollback@example.invalid' where id='${other}';`]) {
    const result = docker(command, `set role supabase_auth_admin;${sql}`);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /fixture directory unavailable/);
  }
  assert.deepEqual(query(`select to_jsonb(count(*)) from auth.users where id='${id}';select to_jsonb(email) from auth.users where id='${other}';`), [0, 'member@example.invalid']);
  assert.deepEqual(query(`select to_jsonb(email) from private.site_admin_user_directory where user_id='${other}';`), ['member@example.invalid']);
});

test('locked backfill includes concurrent provider writes without a synchronization gap', async () => {
  // Recreate only this fixture's unreleased search projection to exercise the
  // exact migration prefix with an Auth writer already holding its row lock.
  query(`drop trigger sync_site_admin_user_directory on auth.users;drop function private.sync_site_admin_user_directory();drop table private.site_admin_user_directory;`);
  const prefix = migration.slice(0, migration.indexOf('create index site_admin_profiles_name_prefix_idx'));
  const writer = parallel(`set role supabase_auth_admin;begin;update auth.users set email='concurrent@example.invalid' where id='${other}';select pg_sleep(0.2);commit;`);
  // Wait for actual lock evidence rather than relying on a sleep to order work.
  let locked = false;
  for (let n = 0; n < 100; n += 1) {
    [locked] = query("select to_jsonb(exists(select 1 from pg_locks where relation='auth.users'::regclass and mode='RowExclusiveLock' and granted));");
    if (locked) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(locked);
  const replay = parallel(`set role ${migrationRole};begin;${prefix}commit;`);
  for (const result of await Promise.all([writer, replay])) assert.equal(result.code, 0, result.error);
  assert.deepEqual(query(`select jsonb_build_array(u.email,d.email) from auth.users u join private.site_admin_user_directory d on d.user_id=u.id where u.id='${other}';`), [['concurrent@example.invalid', 'concurrent@example.invalid']]);
  query(`set role supabase_auth_admin;update auth.users set email='after@example.invalid' where id='${other}';`);
  assert.equal(query(asActor(users({ search: 'after@' })))[0].items[0].id, other);
});

test('an Auth insert waiting behind the migration lock runs through the installed synchronization trigger', async () => {
  query('drop trigger sync_site_admin_user_directory on auth.users;drop function private.sync_site_admin_user_directory();drop table private.site_admin_user_directory;');
  const prefix = migration.slice(0, migration.indexOf('create index site_admin_profiles_name_prefix_idx'));
  const paused = prefix.replace('lock table auth.users in share row exclusive mode;',
    'lock table auth.users in share row exclusive mode;select pg_sleep(0.5);');
  const replay = parallel(`set role ${migrationRole};begin;${paused}commit;`);
  let locked = false;
  for (let n = 0; n < 100; n += 1) {
    [locked] = query("select to_jsonb(exists(select 1 from pg_locks where relation='auth.users'::regclass and mode='ShareRowExclusiveLock' and granted));");
    if (locked) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(locked);
  const id = randomUUID();
  const writer = parallel(`set role supabase_auth_admin;insert into auth.users(id,email,created_at) values('${id}','during@example.invalid','2026-03-01');`);
  for (const result of await Promise.all([replay, writer])) assert.equal(result.code, 0, result.error);
  assert.deepEqual(query(`select jsonb_build_array(email,created_at) from private.site_admin_user_directory where user_id='${id}';`), [['during@example.invalid', '2026-03-01T00:00:00+00:00']]);
});

test('the real Auth-only pg_dump restores after excluding exactly the four later application triggers', async () => {
  const rehearsal = await readFile(new URL('./rehearse-baseline-reconciliation.sh', import.meta.url), 'utf8');
  const filter = rehearsal.match(/\| awk '([\s\S]*?)\n      '/)?.[1]; assert.ok(filter);
  const dump = docker(['exec', container, 'pg_dump', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--schema=auth', '--no-owner', '--no-privileges']);
  assert.equal(dump.status, 0, dump.stderr); assert.match(dump.stdout, /CREATE TRIGGER sync_site_admin_user_directory/);
  const filtered = spawnSync('awk', [filter], { input: dump.stdout, encoding: 'utf8' }); assert.equal(filtered.status, 0, filtered.stderr);
  const database = `platform_copy_${randomUUID().replaceAll('-', '')}`; query(`create database ${database} template template0;`);
  try {
    const restored = docker([...command.slice(0, -1), database], filtered.stdout); assert.equal(restored.status, 0, restored.stderr);
    const verified = docker([...command.slice(0, -1), database], "select json_build_object('users',to_regclass('auth.users') is not null,'private',to_regnamespace('private') is not null,'rows',(select count(*) from auth.users));");
    assert.equal(verified.status, 0, verified.stderr); assert.deepEqual(JSON.parse(verified.stdout.trim()), { users: true, private: false, rows: 0 });
  } finally { query(`drop database ${database};`); }
});

test('all reads reject anonymous, member/crew owner, metadata spoofing, wrong actor, wrong Origin and AAL1', () => {
  const memberSession = randomUUID(); query(`insert into auth.sessions values('${memberSession}','${other}',null,'aal1',null);`);
  const calls = (id = actor) => [users({ expected: id }), detail(other, id), audits({ expected: id }), auditDetail('1', id)];
  for (const sql of calls()) {
    query(`set role anon;${denied(sql, '42501')}`);
    query(asActor(denied(sql, 'PT401'), { id: other, sid: memberSession }));
    query(asActor(denied(sql), { origin: 'https://attacker.example' }));
    query(asActor(denied(sql), { aal: 'aal1' }));
  }
  for (const sql of calls(other)) query(asActor(denied(sql), { id: other, sid: memberSession, claims: { user_metadata: { site_admin: true }, app_metadata: { role: 'site_admin' } } }));
});

test('permission revocation and session logout immediately reject every new request', () => {
  query("delete from private.site_role_permissions where permission_key='users.read';");
  query(asActor(denied(users()) + denied(detail())));
  assert.equal(query(asActor(audits()))[0].items.length, 1);
  query("delete from private.site_role_permissions where permission_key='audit.read';");
  query(asActor(denied(audits()) + denied(auditDetail())));
  query(`delete from auth.sessions where id='${session}';`);
  for (const sql of [users(), detail(), audits(), auditDetail()]) query(asActor(denied(sql, 'PT401')));
});

test('a revoked canonical role defeats an unchanged AAL2 admin token on all four reads', () => {
  query(`insert into auth.mfa_factors(id,user_id,factor_type,status) values('${randomUUID()}','${other}','totp','verified');
    update private.site_user_roles set role_key='site_admin' where user_id='${other}';
    update private.site_user_roles set role_key='member' where user_id='${actor}';`);
  for (const sql of [users(), detail(), audits(), auditDetail()]) query(asActor(denied(sql), { claims: { app_metadata: { role: 'site_admin' } } }));
});

test('account serializers are allowlisted, bounded, dated and exclude private content and billing identifiers', () => {
  query(`update public.profiles set name=repeat('A',200) where user_id='${other}';
    insert into public.user_game_stats values('${other}',49,7,3,'2026-01-07','2026-01-07T12:00:00Z');
    insert into public.subscriptions(user_id,product_key,status,updated_at)values('${other}','dominion_membership','active','2026-01-01'),('${other}','dominion_membership','canceled','2026-01-02');
    insert into public.account_lifecycle_requests(user_id,request_type,status) values('${other}','account_deletion','in_progress');`);
  const [payload] = query(asActor(detail()));
  assert.equal(payload.item.name.length, 120); assert.equal(payload.item.subscriptionSnapshot.status, 'canceled');
  assert.equal(payload.item.deletionRequestStatus, 'in_progress'); assert.equal(payload.item.statsSnapshot.storedAppStreak, 7);
  assert.equal(payload.item.activationSnapshot.storedStatus, 'scheduled'); assert.equal(payload.item.crew.role, 'owner');
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_SECRET|metadata|avatar|stripe_|operator_note|password/);
  assert.equal(payload.item.effectiveAccess, undefined); assert.equal(payload.item.currentDay, undefined);
  assert.deepEqual(query(asActor('select to_jsonb(count(*)) from public.fixture_journal;')), [0]);
  query(asActor(denied('select private.site_admin_user_payload(null);', '42501')));
});

test('exact keyset pages preserve tied dates, null dates, both sort directions and final-page shape', () => {
  const ids = Array.from({ length: 13 }, () => randomUUID()).sort();
  query(`insert into auth.users(id,email,created_at) values ${ids.map((id, i) => `('${id}','test${i}@example.invalid',${i === 0 ? 'null' : "'2026-01-01'"})`).join(',')};`);
  const expected = query("select to_jsonb(id) from auth.users order by coalesce(created_at,'1970-01-01T00:00:00Z'::timestamptz),id;");
  for (const sort of ['oldest', 'newest']) {
    const actual = []; let cursor = null;
    do { const [page] = query(asActor(users({ sort, limit: 4, cursor }))); assert.ok(page.items.length <= 4); actual.push(...page.items.map((v) => v.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(actual, sort === 'oldest' ? expected : [...expected].reverse());
  }
});

test('prefix search treats wildcard characters literally and uses canonical Auth email instead of metadata', () => {
  query(`update public.profiles set name='50%_Complete' where user_id='${other}';`);
  for (const search of ['50%_', ' MEMBER@EXAMPLE.']) assert.deepEqual(query(asActor(users({ search })))[0].items.map((r) => r.id), [other]);
  assert.deepEqual(query(asActor(users({ search: '%' })))[0].items, []);
  assert.deepEqual(query(asActor(users({ search: secret })))[0].items, []);
});

test('account filters distinguish actual suspension, deleted records, role and only active deletion requests', () => {
  query(`update auth.users set email_confirmed_at=null,banned_until=now()+interval '1 day' where id='${other}';
    insert into public.account_lifecycle_requests(user_id,request_type,status)values('${other}','account_deletion','fulfilled');`);
  for (const status of ['suspended', 'unconfirmed']) assert.deepEqual(query(asActor(users({ status })))[0].items.map((r) => r.id), [other]);
  assert.deepEqual(query(asActor(users({ status: 'suspended', role: 'member', search: 'MEMBER@' })))[0].items.map((r) => r.id), [other]);
  assert.deepEqual(query(asActor(users({ status: 'suspended', role: 'site_admin' })))[0].items, []);
  assert.deepEqual(query(asActor(users({ status: 'deletion_pending' })))[0].items, []);
  query(`insert into public.account_lifecycle_requests(user_id,request_type,status)values('${other}','account_deletion','requested');`);
  assert.deepEqual(query(asActor(users({ status: 'deletion_pending' })))[0].items.map((r) => r.id), [other]);
  assert.deepEqual(query(asActor(users({ role: 'site_admin' })))[0].items.map((r) => r.id), [actor]);
  query(`update auth.users set deleted_at=now() where id='${other}';`);
  assert.deepEqual(query(asActor(users({ status: 'deleted' })))[0].items.map((r) => r.id), [other]);
});

test('cursor is actor/query/sort-bound and malformed data gets stable non-echoing errors', () => {
  const [first] = query(asActor(users({ limit: 1 })));
  for (const cursor of [[], {}, { ...first.nextCursor, stamp: secret }, { ...first.nextCursor, id: secret }, { ...first.nextCursor, actorId: other }, { ...first.nextCursor, extra: secret }, { ...first.nextCursor, v: '1' }, { ...first.nextCursor, stamp: 'a'.repeat(2000) }]) query(asActor(denied(users({ cursor }), '22023', 'admin_invalid_cursor')));
  for (const change of [{ search: 'Member' }, { sort: 'oldest' }, { role: 'member' }]) query(asActor(denied(users({ ...change, cursor: first.nextCursor }), '22023', 'admin_invalid_cursor')));
  for (const bad of [{ limit: 51 }, { limit: 0 }, { search: 'a'.repeat(81) }, { sort: 'created_at;drop table auth.users' }, { status: 'active' }]) query(asActor(denied(users(bad), '22023', 'admin_invalid_input')));
});

test('audit list/detail paginate exact string identities and expose only redacted existing ledger fields', () => {
  query("alter sequence private.site_admin_audit_sequence_id_seq restart with 9007199254740993;" + auditRow(8));
  const expected = query('select to_jsonb(sequence_id::text) from private.site_admin_audit order by sequence_id desc;');
  const actual = []; let cursor = null;
  do { const [page] = query(asActor(audits({ limit: 3, cursor }))); actual.push(...page.items.map((r) => r.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(actual, expected); assert.equal(actual[0], '9007199254741000');
  const [entry] = query(asActor(auditDetail(actual[0]))); assert.equal(entry.item.id, actual[0]);
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_SECRET|signature|digest|metadata|password/);
  assert.equal(query(asActor(audits({ outcome: 'failure', action: 'roles.assign', target: other })))[0].items.length, 4);
  query(asActor(denied('select private.site_admin_audit_payload(1);', '42501')));
});

test('audit cursor/detail reject overflow and query mismatch without raw cast diagnostics', () => {
  query(auditRow(2)); const [page] = query(asActor(audits({ limit: 1 })));
  for (const cursor of [{ ...page.nextCursor, id: '9999999999999999999' }, { ...page.nextCursor, id: secret }, { ...page.nextCursor, actorId: other }, { ...page.nextCursor, id: '1'.repeat(2000) }, []]) query(asActor(denied(audits({ cursor }), '22023', 'admin_invalid_cursor')));
  query(asActor(denied(audits({ cursor: page.nextCursor, outcome: 'failure' }), '22023', 'admin_invalid_cursor')));
  for (const id of ['9999999999999999999', secret, '0']) query(asActor(denied(auditDetail(id), '22023', 'admin_invalid_input')));
  query(asActor(denied(auditDetail('99999'), 'PT404', 'admin_record_not_found') + denied(detail(randomUUID()), 'PT404', 'admin_record_not_found')));
});

test('all successful read outputs are no-store, and read operations do not append audits', () => {
  for (const sql of [users(), detail(), audits(), auditDetail()]) {
    const values = query(asActor(`begin;${sql}select current_setting('response.headers')::jsonb;commit;`));
    assert.deepEqual(values[1], [{ 'Cache-Control': 'private, no-store' }, { Pragma: 'no-cache' }]);
  }
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_admin_audit;'), [1]);
});

test('EXPLAIN shows indexes in the actual public account-list query shape, not only isolated predicates', () => {
  query(`insert into auth.users(id,email,created_at) select gen_random_uuid(),'seed'||n||'@example.invalid','2026-01-01'::timestamptz+n*interval '1 second' from generate_series(1,3000)n;
    insert into public.profiles(user_id,name) select id,email from auth.users where email like 'seed%';analyze auth.users;analyze public.profiles;analyze private.site_admin_user_directory;`);
  const statements = [
    ["select user_id from private.site_admin_user_directory where (coalesce(created_at,'1970-01-01T00:00:00Z'::timestamptz),user_id)>('2026-01-01','00000000-0000-0000-0000-000000000000') order by coalesce(created_at,'1970-01-01T00:00:00Z'::timestamptz),user_id limit 51", 'site_admin_users_created_id_idx'],
    ["select user_id from private.site_admin_user_directory where email like 'seed299%'", 'site_admin_users_email_prefix_idx'],
    ["select user_id from public.profiles where lower(name) like 'seed299%'", 'site_admin_profiles_name_prefix_idx'],
  ];
  for (const [sql, index] of statements) { const r = docker(command, `explain (format json) ${sql};`); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(index)); }
  // Use the exact SQL text passed to EXECUTE by site_admin_list_users, including
  // its role join, filter predicates, UNION prefix candidates and 50+1 limit.
  const actualQuery = migration.match(/\$query\$([\s\S]*?)\$query\$/)?.[1].replaceAll('%1$s', 'desc').replaceAll('%2$s', '<');
  assert.ok(actualQuery, 'read migration must retain the executable list-query boundary');
  const prepare = `prepare actual_user_list(text,text,text,text,timestamptz,uuid,integer) as ${actualQuery};`;
  const prefixPlan = docker(command, `${prepare}explain (format json) execute actual_user_list('seed299','seed299%','all','all',null,null,51);`);
  assert.equal(prefixPlan.status, 0, prefixPlan.stderr);
  assert.match(prefixPlan.stdout, /site_admin_users_email_prefix_idx/);
  assert.match(prefixPlan.stdout, /site_admin_profiles_name_prefix_idx/);
  const cursorPlan = docker(command, `${prepare}explain (format json) execute actual_user_list('','%','all','all','2026-01-01T00:49:00Z','00000000-0000-0000-0000-000000000000',51);`);
  assert.equal(cursorPlan.status, 0, cursorPlan.stderr); assert.match(cursorPlan.stdout, /site_admin_users_created_id_idx/);
});

test('the registered read-API pgTAP file executes all 28 assertions', async () => {
  const sql = await readFile(new URL('../supabase/tests/database/250_site_admin_reads.sql', import.meta.url), 'utf8');
  const result = docker(command, sql); assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^not ok/m); assert.match(result.stdout, /1\.\.28/);
});
