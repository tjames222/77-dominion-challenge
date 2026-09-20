import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

const container = `77dc-early-access-admin-${randomUUID()}`;
const actor = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const factor = '20000000-0000-4000-8000-000000000001';
const session = '30000000-0000-4000-8000-000000000001';
const request = '40000000-0000-4000-8000-000000000001';
const legacy = '40000000-0000-4000-8000-000000000002';
const secret = 'PRIVATE_CONTENT_SENTINEL';
let created = false; let intake; let foundation; let directory; let migration; let legacyAudit;
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
function asActor(sql, { id = actor, sid = session, aal = 'aal2', origin = 'https://77dominion.com', age = 0, claims = {} } = {}) {
  return `set request.jwt.claims=${literal(JSON.stringify({ sub: id, session_id: sid, role: 'authenticated', aal,
    amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - age }], ...claims }))};
    set request.headers=${literal(JSON.stringify({ origin }))};set role authenticated;${sql}`;
}
function denied(sql, state = 'PT403', message = '') { return `do $t$ begin begin ${sql.replace(/^select /, 'perform ')}
  exception when sqlstate '${state}' then ${message ? `if sqlerrm<>${literal(message)} then raise;end if;` : ''} return;end;raise exception 'Expected denial';end $t$;`; }
const list = ({ expected = actor, limit = 25, search = '', status = 'all', sort = 'newest', cursor = null } = {}) =>
  `select public.site_admin_list_early_access_requests('${expected}',${literal(limit)},${literal(search)},${literal(status)},${literal(sort)},${json(cursor)});`;
const detail = (id = request, expected = actor) => `select public.site_admin_get_early_access_request('${expected}',${literal(id)});`;
const history = ({ id = request, expected = actor, limit = 25, cursor = null } = {}) =>
  `select public.site_admin_list_early_access_history('${expected}',${literal(id)},${literal(limit)},${json(cursor)});`;
const deny = ({ id = request, expected = actor, revision = 0, operation = randomUUID(), correlation = randomUUID() } = {}) =>
  `select public.site_admin_deny_early_access_request('${expected}',${literal(id)},${literal(revision)},${literal(operation)},${literal(correlation)});`;
const roleAttempt = (operation = randomUUID()) => `select public.site_admin_assign_role('${actor}','${member}','site_admin',0,'${operation}','${randomUUID()}','approved_role_change');`;
const auditSeed = (count, age = '0 minutes') => `insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,before_role,after_role,request_id,correlation_id,environment,occurred_at,outcome,error_code)
  select '${actor}','${member}','roles.assign','roles.manage','approved_role_change','member','member',gen_random_uuid(),gen_random_uuid(),'production',clock_timestamp()-interval '${age}','failure','target_mfa_required' from generate_series(1,${count});`;

before(async () => {
  intake = await readFile(new URL('../supabase/migrations/20260913023402_early_access_request_intake.sql', import.meta.url), 'utf8');
  foundation = await readFile(new URL('../supabase/migrations/20260913062841_site_admin_foundation.sql', import.meta.url), 'utf8');
  const readApis = await readFile(new URL('../supabase/migrations/20260913065057_site_admin_read_apis.sql', import.meta.url), 'utf8');
  directory = readApis.slice(0, readApis.indexOf('create index site_admin_profiles_name_prefix_idx'));
  migration = await readFile(new URL('../supabase/migrations/20260913082358_early_access_admin_review.sql', import.meta.url), 'utf8');
  const r = docker(['run', '--detach', '--name', container, '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', 'public.ecr.aws/supabase/postgres:17.6.1.141', '-c', 'initdb -D /tmp/early-admin-pgdata -A trust && exec postgres -D /tmp/early-admin-pgdata -k /tmp -h ""']);
  assert.equal(r.status, 0, r.stderr); created = true;
  for (let n = 0; n < 100; n += 1) { if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  query(`create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;
    create role supabase_auth_admin nologin nosuperuser nocreatedb nocreaterole;
    create role ${migrationRole} nologin nosuperuser nocreatedb nocreaterole nobypassrls;
    grant create on database postgres to ${migrationRole};`);
});
beforeEach(() => {
  // Destructive setup is confined to this owned, network-none, tmpfs fixture.
  query(`drop schema if exists auth cascade;drop schema if exists private cascade;drop schema public cascade;create schema public;create schema auth;
    grant usage on schema public,auth to anon,authenticated,service_role,${migrationRole};
    grant usage on schema auth to supabase_auth_admin;
    grant create on schema public to ${migrationRole};
    create table auth.users(id uuid primary key,email text,created_at timestamptz,email_confirmed_at timestamptz default now(),is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz,encrypted_password text default '${secret}',raw_user_meta_data jsonb default '{"secret":"${secret}"}');
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_type text,status text,secret text default '${secret}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_id uuid,aal text,not_after timestamptz);
    create table auth.mfa_amr_claims(session_id uuid,authentication_method text,updated_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    insert into auth.users(id,email) values('${actor}','admin@example.invalid'),('${member}','member@example.invalid');
    alter table auth.users owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;
    alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger,maintain on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to ${migrationRole};
    set role ${migrationRole};create schema private;grant usage on schema private to service_role;
    create table public.crew_members(user_id uuid,role text);insert into public.crew_members values('${member}','admin');
    create table public.fixture_journal(user_id uuid,body text);insert into public.fixture_journal values('${member}','${secret}');
    alter table public.fixture_journal enable row level security;create policy own on public.fixture_journal for select to authenticated using(user_id=(select auth.uid()));grant select on public.fixture_journal to authenticated;
    begin;${intake}${foundation}${directory}commit;reset role;
    insert into auth.mfa_factors(id,user_id,factor_type,status) values('${factor}','${actor}','totp','verified');
    select private.bootstrap_site_admin('${actor}','50000000-0000-4000-8000-000000000001','production');
    insert into auth.sessions values('${session}','${actor}','${factor}','aal2',null);
    insert into auth.mfa_amr_claims values('${session}','totp',clock_timestamp());
    insert into private.early_access_requests(id,name,email,user_id,answers,created_at,updated_at,status) values
      ('${request}','Member','member@example.invalid','${member}','{"private":"${secret}"}','2026-01-01','2026-01-01','pending'),
      ('${legacy}','Legacy Invite','legacy@example.invalid',null,'{}','2026-01-02','2026-01-02','invited');`);
  [legacyAudit] = query('select to_jsonb(a) from private.site_admin_audit a;');
  query(`set role ${migrationRole};begin;${migration}commit;`);
});
after(() => { if (created) { const r = docker(['rm', '--force', container]); assert.equal(r.status, 0, r.stderr); } });

test('migration preserves the exact legacy audit record, request status and truthful unknown delivery timestamps', () => {
  const [record] = query("select to_jsonb(a)-'early_access_request_id'-'before_request_status'-'after_request_status' from private.site_admin_audit a;");
  assert.deepEqual(record, legacyAudit);
  const [payload] = query(asActor(detail(legacy)));
  assert.equal(payload.item.status, 'invited'); assert.equal(payload.item.revision, '0');
  for (const key of ['invitationSentAt', 'invitationExpiresAt', 'acceptedAt']) assert.equal(payload.item[key], null);
  assert.equal(payload.item.requestedAt, '2026-01-02T00:00:00+00:00');
  assert.deepEqual(query(asActor(history({ id: legacy })))[0].items, []);
});

test('all boundaries deny anonymous, crew admin, metadata spoof, wrong actor, wrong Origin and AAL1 before reading payload', () => {
  const sid = randomUUID(); query(`insert into auth.sessions values('${sid}','${member}',null,'aal1',null);`);
  const calls = (expected = actor) => [list({ expected }), detail(request, expected), history({ expected }), deny({ expected })];
  for (const sql of calls()) {
    query(`set role anon;${denied(sql, '42501')}`);
    query(`set role service_role;${denied(sql, '42501')}`);
    query(asActor(denied(sql, 'PT401'), { id: member, sid }));
    query(asActor(denied(sql), { origin: 'https://attacker.example' }));
    query(asActor(denied(sql), { aal: 'aal1' }));
  }
  for (const sql of calls(member)) query(asActor(denied(sql), { id: member, sid,
    claims: { app_metadata: { role: 'site_admin' }, user_metadata: { site_admin: true } } }));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_admin_audit;'), [1]);
});

test('canonical permissions and healthy live same-actor session are rechecked on every request', () => {
  query("delete from private.site_role_permissions where permission_key='operations.read';");
  for (const sql of [list(), detail(), history()]) query(asActor(denied(sql)));
  query("delete from private.site_role_permissions where permission_key='operations.manage';");
  query(asActor(denied(deny())));
  query(`delete from auth.sessions where id='${session}';`);
  for (const sql of [list(), detail(), history(), deny()]) query(asActor(denied(sql, 'PT401')));
});

test('a permission revoked while denial waits on the lifecycle lock is rechecked before any mutation', async () => {
  const blocker = parallel("begin;select pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));delete from private.site_role_permissions where permission_key='operations.manage';select pg_sleep(0.5);commit;");
  let locked = false;
  for (let n = 0; n < 100; n += 1) {
    [locked] = query("select to_jsonb(exists(select 1 from pg_locks where locktype='advisory' and granted));");
    if (locked) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(locked);
  const waiting = parallel(asActor(denied(deny(), 'PT403')));
  for (const result of await Promise.all([blocker, waiting])) assert.equal(result.code, 0, result.error);
  assert.deepEqual(query(`select jsonb_build_array(status,revision) from private.early_access_requests where id='${request}';
    select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';`), [['pending', 0], 0]);
});

test('a concurrent real role revocation blocks the old actor before its waiting denial can mutate', async () => {
  const otherFactor = randomUUID(); const otherSession = randomUUID();
  query(`insert into auth.mfa_factors values('${otherFactor}','${member}','totp','verified','${secret}');
    update private.site_user_roles set role_key='site_admin' where user_id='${member}';
    insert into auth.sessions values('${otherSession}','${member}','${otherFactor}','aal2',null);
    insert into auth.mfa_amr_claims values('${otherSession}','totp',clock_timestamp());`);
  const [revision] = query(`select to_jsonb(revision) from private.site_user_roles where user_id='${actor}';`);
  const roleWrite = `select public.site_admin_assign_role('${member}','${actor}','member',${revision},'${randomUUID()}','${randomUUID()}','approved_role_change');`;
  const revocation = parallel(asActor(`set application_name='early-admin-role-revoke';begin;${roleWrite}select pg_sleep(0.8);commit;`, { id: member, sid: otherSession }));
  let waitingOnCommit = false;
  for (let n = 0; n < 60; n += 1) {
    [waitingOnCommit] = query("select to_jsonb(exists(select 1 from pg_stat_activity where application_name='early-admin-role-revoke' and wait_event='PgSleep'));");
    if (waitingOnCommit) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(waitingOnCommit, 'The real role writer must hold the shared lifecycle lock before denial starts.');
  const denial = parallel(asActor(denied(deny(), 'PT403')));
  for (const result of await Promise.all([revocation, denial])) assert.equal(result.code, 0, result.error);
  assert.deepEqual(query(`select jsonb_build_array(status,revision) from private.early_access_requests where id='${request}';
    select to_jsonb(role_key) from private.site_user_roles where user_id='${actor}';
    select to_jsonb(count(*)) from private.site_admin_audit where action='early_access.deny';
    select to_jsonb(count(*)) from private.site_admin_audit where action='roles.assign';`), [['pending', 0], 'member', 0, 1]);
});

test('revoked role defeats an old AAL2 token; factor/session freshness is required only for writes', () => {
  query(`update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '11 minutes';`);
  assert.equal(query(asActor(list(), { age: 660 }))[0].items.length, 2);
  query(asActor(denied(deny())));
  query(`update auth.mfa_amr_claims set updated_at=clock_timestamp();`);
  query(asActor(denied(deny()), { age: 660 }));
  query(`insert into auth.mfa_factors values('${randomUUID()}','${member}','totp','verified','${secret}');
    update private.site_user_roles set role_key='site_admin' where user_id='${member}';
    update private.site_user_roles set role_key='member' where user_id='${actor}';`);
  for (const sql of [list(), detail(), history(), deny()]) query(asActor(denied(sql), { claims: { app_metadata: { role: 'site_admin' } } }));
});

test('serializer uses exact canonical account/email matches, never the intake link, and excludes private content', () => {
  let item = query(asActor(detail()))[0].item;
  assert.deepEqual(item.account, { status: 'confirmed', userId: member });
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE_CONTENT|answers|metadata|password|secret|user_id/);
  query(`update auth.users set email='changed@example.invalid' where id='${member}';`);
  assert.deepEqual(query(asActor(detail()))[0].item.account, { status: 'none', userId: null });
  const match = randomUUID(); query(`insert into auth.users(id,email,email_confirmed_at) values('${match}','MEMBER@example.invalid',null);`);
  assert.deepEqual(query(asActor(detail()))[0].item.account, { status: 'unconfirmed', userId: match });
  query(`update auth.users set banned_until=now()+interval '1 day' where id='${match}';`);
  assert.equal(query(asActor(detail()))[0].item.account.status, 'suspended');
  query(`update auth.users set deleted_at=now() where id='${match}';`);
  assert.equal(query(asActor(detail()))[0].item.account.status, 'deleted');
  query(`insert into auth.users(id,email) values('${randomUUID()}','member@example.invalid');`);
  assert.deepEqual(query(asActor(detail()))[0].item.account, { status: 'ambiguous', userId: null });
  query(asActor(denied('select private.site_admin_early_access_payload(null);', '42501')));
  assert.deepEqual(query(asActor('select to_jsonb(count(*)) from public.fixture_journal;')), [0]);
});

test('server keyset pagination preserves tied timestamps in both directions and applies every status filter', () => {
  const statuses = ['pending', 'approved', 'invited', 'accepted', 'denied', 'expired', 'revoked'];
  query(`insert into private.early_access_requests(name,email,status,created_at) values ${statuses.flatMap((status) => [0, 1].map((n) => `('${status}${n}','${status}${n}@example.invalid','${status}','2026-01-01')`)).join(',')};`);
  for (const status of ['all', ...statuses]) for (const sort of ['oldest', 'newest']) {
    const expected = query(`select to_jsonb(id) from private.early_access_requests ${status === 'all' ? '' : `where status='${status}'`} order by created_at,id;`);
    const actual = []; let cursor = null;
    do { const [page] = query(asActor(list({ limit: 3, cursor, status, sort }))); assert.ok(page.items.length <= 3); actual.push(...page.items.map((v) => v.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(actual, sort === 'oldest' ? expected : [...expected].reverse());
  }
});

test('search is literal, trimmed case-insensitive prefix with status filtering and no raw answer matching', () => {
  query(`update private.early_access_requests set name='50%_Complete' where id='${request}';`);
  for (const search of ['50%_', ' MEMBER@']) assert.deepEqual(query(asActor(list({ search, status: 'pending' })))[0].items.map((v) => v.id), [request]);
  for (const search of ['%', '_', secret]) assert.deepEqual(query(asActor(list({ search })))[0].items, []);
  assert.deepEqual(query(asActor(list({ search: 'member@', status: 'denied' })))[0].items, []);
});

test('cursor parsing is actor/query/sort-bound, bounded, finite and non-echoing', () => {
  const cursor = query(asActor(list({ limit: 1 })))[0].nextCursor;
  for (const bad of [[], {}, { ...cursor, stamp: secret }, { ...cursor, stamp: 'infinity' }, { ...cursor, id: secret }, { ...cursor, actorId: member }, { ...cursor, extra: true }, { ...cursor, v: '1' }, { ...cursor, stamp: 'x'.repeat(2000) }]) query(asActor(denied(list({ cursor: bad }), '22023', 'admin_invalid_cursor')));
  for (const change of [{ search: 'Member' }, { status: 'pending' }, { sort: 'oldest' }]) query(asActor(denied(list({ ...change, cursor }), '22023', 'admin_invalid_cursor')));
  for (const bad of [{ limit: 51 }, { limit: 0 }, { limit: null }, { search: 'a'.repeat(81) }, { search: '\n' }, { sort: 'drop table' }, { status: 'sent' }]) query(asActor(denied(list(bad), '22023', 'admin_invalid_input')));
  query(asActor(denied(detail(null), '22023', 'admin_invalid_input') + denied(detail(randomUUID()), 'PT404', 'admin_record_not_found')));
});

test('denial is revision-checked, concurrent exact retries are idempotent and no Auth/access state is changed', async () => {
  const operation = randomUUID(); const correlation = randomUUID(); const sql = asActor(deny({ operation, correlation }));
  const beforeAuth = query('select jsonb_agg(to_jsonb(u) order by id) from auth.users u;select jsonb_agg(to_jsonb(r) order by user_id) from private.site_user_roles r;');
  for (const r of await Promise.all([parallel(sql), parallel(sql)])) { assert.equal(r.code, 0, r.error); assert.deepEqual(JSON.parse(r.output), { ok: true, requestId: request, status: 'denied', revision: '1' }); }
  assert.deepEqual(query('select jsonb_agg(to_jsonb(u) order by id) from auth.users u;select jsonb_agg(to_jsonb(r) order by user_id) from private.site_user_roles r;'), beforeAuth);
  assert.deepEqual(query("select to_jsonb(count(*)) from private.site_admin_audit where action='early_access.deny';select to_jsonb(count(*)) from private.site_admin_role_requests;"), [1, 1]);
  query(asActor(denied(deny({ operation, correlation, revision: 1 }), '22023', 'admin_idempotency_conflict')));
  assert.deepEqual(query(asActor(deny()))[0], { ok: false, errorCode: 'revision_conflict' });
  assert.deepEqual(query(asActor(deny({ revision: 1 })))[0], { ok: false, errorCode: 'invalid_state' });
  assert.equal(query(asActor(detail()))[0].item.invitationSentAt, null);
});

test('simultaneous distinct denial operations cannot both transition the same revision', async () => {
  const attempts = await Promise.all([parallel(asActor(deny())), parallel(asActor(deny()))]);
  for (const attempt of attempts) assert.equal(attempt.code, 0, attempt.error);
  const outcomes = attempts.map((r) => JSON.parse(r.output));
  assert.equal(outcomes.filter((v) => v.ok).length, 1); assert.equal(outcomes.filter((v) => v.errorCode === 'revision_conflict').length, 1);
  assert.deepEqual(query(`select to_jsonb(revision) from private.early_access_requests where id='${request}';`), [1]);
});

test('deny audits stable failures but never reopens or changes non-pending states', () => {
  for (const [options, errorCode] of [[{ revision: -1 }, 'invalid_input'], [{ revision: null }, 'invalid_input'], [{ id: randomUUID() }, 'target_unavailable'], [{ id: legacy }, 'invalid_state']]) {
    assert.deepEqual(query(asActor(deny(options)))[0], { ok: false, errorCode });
  }
  for (const options of [{ id: null }, { operation: null }, { correlation: null }]) query(asActor(denied(deny(options), '22023', 'admin_request_identity_required')));
  assert.equal(query(asActor(detail(legacy)))[0].item.status, 'invited');
  assert.equal(query(asActor(detail()))[0].item.status, 'pending');
});

test('a lost audit write rolls back the status, revision and idempotency result together', () => {
  const sql = asActor(deny({ operation: randomUUID(), correlation: randomUUID() }));
  query("create function private.fixture_reject_audit() returns trigger language plpgsql as $$begin raise exception 'fixture audit unavailable';end$$;create trigger fixture_reject_audit before insert on private.site_admin_audit for each row execute function private.fixture_reject_audit();");
  const result = docker(command, sql); assert.notEqual(result.status, 0); assert.match(result.stderr, /fixture audit unavailable/);
  assert.deepEqual(query(`select jsonb_build_array(status,revision) from private.early_access_requests where id='${request}';select to_jsonb(count(*)) from private.site_admin_role_requests;`), [['pending', 0], 0]);
  query('drop trigger fixture_reject_audit on private.site_admin_audit;');
  const expected = { ok: true, requestId: request, status: 'denied', revision: '1' };
  assert.deepEqual(query(sql), [expected]); assert.deepEqual(query(sql), [expected]);
  assert.deepEqual(query("select to_jsonb(count(*)) from private.site_admin_audit where action='early_access.deny';select to_jsonb(count(*)) from private.site_admin_role_requests;"), [1, 1]);
});

test('role and early-access operations share the 20/minute and 100/hour budget without rejected ledger growth', async () => {
  query(auditSeed(19));
  const results = await Promise.all([parallel(asActor(deny())), parallel(asActor(roleAttempt()))]);
  for (const r of results) assert.equal(r.code, 0, r.error);
  assert.equal(results.map((r) => JSON.parse(r.output)).filter((v) => v.errorCode === 'rate_limited').length, 1);
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';`), [20]);
  for (let n = 0; n < 3; n += 1) assert.equal(query(asActor(deny()))[0].errorCode, 'rate_limited');
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';`), [20]);
});

test('hourly limits also count previous role actions and do not create operation records', () => {
  query(auditSeed(100, '2 minutes'));
  assert.equal(query(asActor(deny()))[0].errorCode, 'rate_limited');
  assert.deepEqual(query('select to_jsonb(count(*)) from private.site_admin_role_requests;'), [0]);
});

test('request UUID reuse across role and early-access operations fails before any denial mutation', () => {
  const operation = randomUUID(); query(asActor(roleAttempt(operation)));
  query(asActor(denied(deny({ operation }), '22023', 'admin_idempotency_conflict')));
  assert.equal(query(asActor(detail()))[0].item.status, 'pending');
});

test('denial UUID reuse by the unchanged role writer fails with the same stable conflict', () => {
  const operation = randomUUID(); query(asActor(deny({ operation })));
  query(asActor(denied(roleAttempt(operation), '22023', 'admin_idempotency_conflict')));
  assert.deepEqual(query(`select to_jsonb(role_key) from private.site_user_roles where user_id='${member}';
    select to_jsonb(count(*)) from private.site_admin_role_requests;`), ['member', 1]);
});

test('concurrent cross-kind UUID reuse serializes to one handled operation and one stable conflict', async () => {
  const operation = randomUUID();
  const results = await Promise.all([parallel(asActor(deny({ operation }))), parallel(asActor(roleAttempt(operation)))]);
  assert.equal(results.filter((v) => v.code === 0).length, 1);
  assert.equal(results.filter((v) => v.error.includes('admin_idempotency_conflict')).length, 1);
  const handled = JSON.parse(results.find((v) => v.code === 0).output);
  assert.equal(query(asActor(detail()))[0].item.status, handled.ok ? 'denied' : 'pending');
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';
    select to_jsonb(count(*)) from private.site_admin_role_requests;`), [1, 1]);
});

test('audited failure exact retries replay once, and their operation digest includes correlation and revision', async () => {
  const operation = randomUUID(); const correlation = randomUUID();
  const sql = asActor(deny({ operation, correlation, revision: 99 }));
  for (const result of await Promise.all([parallel(sql), parallel(sql)])) {
    assert.equal(result.code, 0, result.error); assert.deepEqual(JSON.parse(result.output), { ok: false, errorCode: 'revision_conflict' });
  }
  assert.deepEqual(query(sql), [{ ok: false, errorCode: 'revision_conflict' }]);
  query(asActor(denied(deny({ operation, correlation, revision: 0 }), '22023', 'admin_idempotency_conflict')));
  query(asActor(denied(deny({ operation, correlation: randomUUID(), revision: 99 }), '22023', 'admin_idempotency_conflict')));
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';
    select to_jsonb(count(*)) from private.site_admin_role_requests;`), [1, 1]);
});

test('stored success and failure retries still require recent MFA, current capability and a live session', () => {
  const success = deny({ operation: randomUUID(), correlation: randomUUID() });
  const failure = deny({ operation: randomUUID(), correlation: randomUUID(), revision: 99 });
  assert.equal(query(asActor(success))[0].ok, true);
  assert.equal(query(asActor(failure))[0].errorCode, 'revision_conflict');
  for (const sql of [success, failure]) query(asActor(denied(sql), { age: 660 }));
  query("delete from private.site_role_permissions where permission_key='operations.manage';");
  for (const sql of [success, failure]) query(asActor(denied(sql)));
  query("insert into private.site_role_permissions(role_key,permission_key) values('site_admin','operations.manage');");
  query(`delete from auth.sessions where id='${session}';`);
  for (const sql of [success, failure]) query(asActor(denied(sql, 'PT401')));
  assert.deepEqual(query(`select jsonb_build_array(status,revision) from private.early_access_requests where id='${request}';
    select to_jsonb(count(*)) from private.site_admin_role_requests;`), [['denied', 1], 2]);
});

test('authorized exact retries replay at capacity without consuming the shared operation budget again', () => {
  const success = asActor(deny({ operation: randomUUID(), correlation: randomUUID() }));
  const failure = asActor(deny({ operation: randomUUID(), correlation: randomUUID(), revision: 99 }));
  const successful = query(success); const rejected = query(failure);
  query(auditSeed(18));
  assert.deepEqual(query(success), successful); assert.deepEqual(query(failure), rejected);
  assert.deepEqual(query(asActor(deny())), [{ ok: false, errorCode: 'rate_limited' }]);
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';
    select to_jsonb(count(*)) from private.site_admin_role_requests;`), [20, 2]);
});

test('history is redacted, exact string-keyset paginated, request-bound and never invents request creation events', () => {
  assert.deepEqual(query(asActor(history()))[0].items, []);
  query('alter sequence private.site_admin_audit_sequence_id_seq restart with 9007199254740993;');
  for (let n = 0; n < 7; n += 1) query(asActor(deny({ revision: -1 })));
  const actual = []; let cursor = null;
  do { const [page] = query(asActor(history({ limit: 3, cursor }))); actual.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(actual.map((v) => v.id), Array.from({ length: 7 }, (_, n) => String(9007199254740999n - BigInt(n))));
  assert.equal(actual[0].beforeStatus, 'pending'); assert.equal(actual[0].afterStatus, 'pending');
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_CONTENT|email|answers|signature|digest|metadata|password/);
  cursor = query(asActor(history({ limit: 1 })))[0].nextCursor;
  for (const bad of [[], {}, { ...cursor, id: '9999999999999999999' }, { ...cursor, id: '0' }, { ...cursor, id: secret }, { ...cursor, actorId: member }, { ...cursor, extra: true }, { ...cursor, id: '1'.repeat(2000) }]) query(asActor(denied(history({ cursor: bad }), '22023', 'admin_invalid_cursor')));
  query(asActor(denied(history({ id: legacy, cursor }), '22023', 'admin_invalid_cursor')));
  query(asActor(denied(history({ id: randomUUID() }), 'PT404', 'admin_record_not_found')));
});

test('audit stays immutable and legacy role-event enumerations cannot adopt early-access codes', () => {
  for (const sql of ['update private.site_admin_audit set outcome=outcome;', 'delete from private.site_admin_audit;', 'truncate private.site_admin_audit;']) query(denied(sql, '42501', 'admin_immutable_record'));
  const row = `insert into private.site_admin_audit(actor_id,action,permission,reason_code,request_id,correlation_id,environment,outcome,error_code)
    values('${actor}','roles.assign','roles.manage','approved_role_change',gen_random_uuid(),gen_random_uuid(),'production','failure','invalid_state');`;
  query(denied(row, '23514'));
  query(denied(row.replace("'invalid_state'", "'revision_conflict'").replace("'roles.manage'", "'operations.manage'"), '23514'));
  query(denied(row.replace("'invalid_state'", "'revision_conflict'").replace("'approved_role_change'", "'early_access_review'"), '23514'));
  query(asActor(roleAttempt())); // The original role writer still works with its original audit schema.
});

test('intake still returns generic success without reopening denial; service cannot write new operational fields', () => {
  query(asActor(deny()));
  assert.deepEqual(query(`set role service_role;select public.submit_early_access_request_service('Member','member@example.invalid','${member}');`)[0], { received: true });
  assert.equal(query(asActor(detail()))[0].item.status, 'denied');
  for (const column of ['status', 'revision', 'invitation_sent_at', 'invitation_expires_at', 'accepted_at']) {
    query(`set role service_role;${denied(`update private.early_access_requests set ${column}=${column};`, '42501')}`);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) query(`set role ${role};${denied('select * from private.site_admin_role_requests;', '42501')}`);
});

test('every successful read, successful denial and audited failure explicitly emits private/no-store', () => {
  for (const sql of [list(), detail(), history(), deny(), deny()]) {
    const values = query(asActor(`begin;${sql}select current_setting('response.headers')::jsonb;commit;`));
    assert.deepEqual(values[1], [{ 'Cache-Control': 'private, no-store' }, { Pragma: 'no-cache' }]);
  }
});

test('actual queue query uses prefix and keyset indexes on a seeded fixture', () => {
  query(`insert into private.early_access_requests(name,email,created_at) select 'Seed'||n,'seed'||n||'@example.invalid','2026-01-01'::timestamptz+n*interval '1 second' from generate_series(1,3000)n;analyze private.early_access_requests;`);
  const actual = migration.match(/\$queue_query\$([\s\S]*?)\$queue_query\$/)?.[1].replaceAll('%1$s', 'desc').replaceAll('%2$s', '<');
  assert.ok(actual);
  const prepare = `prepare actual_queue(text,text,text,timestamptz,uuid,integer) as ${actual};`;
  const prefix = docker(command, `${prepare}explain (format json) execute actual_queue('seed299','seed299%','pending',null,null,51);`);
  assert.equal(prefix.status, 0, prefix.stderr); assert.match(prefix.stdout, /early_access_admin_email_prefix_idx/); assert.match(prefix.stdout, /early_access_admin_name_prefix_idx/);
  const keyset = docker(command, `${prepare}explain (format json) execute actual_queue('','%','all','2026-01-01T00:49:00Z','00000000-0000-0000-0000-000000000000',51);`);
  assert.equal(keyset.status, 0, keyset.stderr); assert.match(keyset.stdout, /early_access_admin_created_id_idx/);
});

test('the registered early-access admin pgTAP executes all 34 assertions', async () => {
  const sql = await readFile(new URL('../supabase/tests/database/270_early_access_admin.sql', import.meta.url), 'utf8');
  const result = docker(command, sql); assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^not ok/m); assert.match(result.stdout, /1\.\.34/);
  assert.equal((result.stdout.match(/^ok \d+ /gm) || []).length, 34);
});
