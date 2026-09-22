import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

// This suite never connects to Supabase or an existing local database. No image
// pull is allowed: the caller must already have this pinned PostgreSQL image.
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const fixture = `77dc-member-authority-${randomUUID()}`;
const label = `77dc.fixture=${fixture}`;
let containerId;
let migration;
let foundation;
let intake;
let legacyPredicate;
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const sid = '20000000-0000-4000-8000-000000000001';
const otherSid = '20000000-0000-4000-8000-000000000002';
const factor = '30000000-0000-4000-8000-000000000001';
const request = '40000000-0000-4000-8000-000000000001';
const grant = '50000000-0000-4000-8000-000000000001';
const ownerRole = 'fixture_migration';
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
function query(sql) {
  assert.match(containerId || '', /^[a-f0-9]{64}$/);
  const result = docker(['exec', '-i', containerId, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'], sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
function parallel(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', containerId, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres']);
    let output = ''; let error = '';
    const deadline = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { error += value; });
    child.on('error', reject); child.on('close', code => { clearTimeout(deadline); resolve({ code, output, error }); });
    child.stdin.end(sql);
  });
}
async function waitForSql(predicate) {
  for (let n = 0; n < 100; n++) {
    if (query(`select to_jsonb(${predicate});`)[0]) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Owned concurrency fixture did not reach its required barrier.');
}
function asActor(sql, { id = actor, session = sid, aal = 'aal1', role = 'authenticated', origin = 'https://77dominion.com', claims = {}, headers } = {}) {
  return `set request.jwt.claims=${literal(JSON.stringify({ sub: id, session_id: session, aal, role, ...claims }))};
    set request.headers=${literal(headers ?? JSON.stringify({ origin }))};set role authenticated;${sql}`;
}
const asService = sql => `set request.jwt.claims='{"role":"service_role"}';set role service_role;${sql}`;
const context = (id = actor) => `public.get_member_access_context(${literal(id)}::uuid)`;
const price = (id = actor, session = sid) => `public.get_beta_price_eligibility(${literal(id)}::uuid,${literal(session)}::uuid)`;
const denied = (sql, code, message) => `do $test$ begin begin ${sql}
  exception when sqlstate '${code}' then ${message ? `if sqlerrm <> ${literal(message)} then raise;end if;` : ''} return;
  end;raise exception 'Expected denial';end $test$;`;
const read = options => query(asActor(`select ${context()};`, options))[0];
const qualify = () => query(`update private.early_access_requests set status='accepted' where id='${request}';
  insert into private.early_access_grants(id,user_id,program_key,request_id,accepted_at,starts_at)
    values('${grant}','${actor}','early_access_v1','${request}','2026-01-01','2026-01-01');`);
const entitlement = (source = 'testing', starts = null, ends = null) => query(`insert into public.entitlements
  (user_id,entitlement_key,status,source_type,source_id,starts_at,ends_at)
  values('${actor}','membership_active','active',${literal(source)},'synthetic-source',${literal(starts)}::timestamptz,${literal(ends)}::timestamptz);`);

before(async () => {
  const file = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  migration = await file('20260922000204_early_access_member_authority.sql');
  foundation = await file('20260913062841_site_admin_foundation.sql');
  intake = await file('20260913023402_early_access_request_intake.sql');
  const baseline = await file('20260707170000_baseline.sql');
  legacyPredicate = baseline.match(/create or replace function public\.has_active_entitlement\([\s\S]*?\n\$\$;/)?.[0];
  assert.ok(legacyPredicate, 'Use the exact existing legacy entitlement predicate.');
  const cached = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(cached.status, 0, 'Pinned PostgreSQL image must already be cached; this suite does not pull.');
  const imageId = cached.stdout.trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const created = docker(['run', '--detach', '--pull', 'never', '--name', fixture, '--label', label,
    '--network', 'none', '--cpus', '1', '--memory', '512m', '--user', 'postgres', '--tmpfs', '/tmp:rw,size=384m',
    '--entrypoint', '/bin/sh', imageId, '-c',
    'initdb -D /tmp/member-authority-pgdata -A trust && exec postgres -D /tmp/member-authority-pgdata -k /tmp -h ""']);
  assert.equal(created.status, 0, created.stderr);
  containerId = created.stdout.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', containerId, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Owned synthetic PostgreSQL fixture must become ready.');
  query(`create role anon;create role authenticated;create role service_role bypassrls;
    create role supabase_auth_admin nologin;
    create role ${ownerRole} nologin nosuperuser nobypassrls;
    grant create on database postgres to ${ownerRole};`);
});

beforeEach(() => {
  // These resets affect only the newly created, labelled, network-none fixture.
  query(`drop schema if exists private cascade;drop schema if exists auth cascade;drop schema public cascade;
    create schema auth;create schema public;grant usage on schema auth,public to anon,authenticated,service_role,${ownerRole};
    grant usage on schema auth to supabase_auth_admin;
    grant create on schema public to ${ownerRole};
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now(),
      is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_id uuid,aal text,not_after timestamptz);
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_type text,status text);
    create index on auth.mfa_factors(user_id);
    create table auth.mfa_amr_claims(session_id uuid,authentication_method text,updated_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to ${ownerRole};
    set role ${ownerRole};create schema private;
    create table public.entitlements(user_id uuid references auth.users on delete cascade,entitlement_key text,status text,
      source_type text,source_id text,starts_at timestamptz,ends_at timestamptz,primary key(user_id,entitlement_key));
    begin;${intake}${foundation}${legacyPredicate}commit;reset role;
    insert into auth.users(id,email)values('${actor}','one@example.invalid'),('${other}','two@example.invalid');
    insert into auth.sessions values('${sid}','${actor}',null,'aal1',null),('${otherSid}','${other}',null,'aal1',null);
    insert into private.early_access_requests(id,name,email,user_id)values('${request}','Synthetic Member','one@example.invalid','${actor}');
    set role ${ownerRole};begin;${migration}commit;reset role;`);
});

after(() => {
  if (!containerId) return;
  const inspected = docker(['inspect', containerId, '--format', '{{index .Config.Labels "77dc.fixture"}}']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.stdout.trim(), fixture);
  const removed = docker(['rm', '--force', containerId]);
  assert.equal(removed.status, 0, removed.stderr);
});

test('migration configures only the approved unlaunched program and never grants anyone', () => {
  const [program, grants, facts, roles] = query(`select to_jsonb(p)-'created_at' from private.early_access_programs p;
    select to_jsonb(count(*)) from private.early_access_grants;
    select to_jsonb(count(*)) from private.early_access_price_qualifications;
    select jsonb_agg(role_key order by user_id) from private.site_user_roles;`);
  assert.deepEqual(program, { program_key: 'early_access_v1', policy_version: 1, configured: true,
    free_access_rule: 'until_beta', beta_starts_at: null, price_retention: 'lifetime_including_returners' });
  assert.equal(grants, 0); assert.equal(facts, 0); assert.deepEqual(roles, ['member', 'member']);
  const value = read();
  assert.deepEqual(Object.keys(value).sort(), ['schemaVersion','actorId','asOf','appAccess','legacyMembershipActive',
    'paidSubscriptionActive','earlyAccessActive','earlyAccessProgram','earlyAccessEndsAt','betaPriceEligible'].sort());
  assert.deepEqual({ ...value, asOf: 'server-time' }, { schemaVersion: 1, actorId: actor, asOf: 'server-time',
    appAccess: false, legacyMembershipActive: false, paidSubscriptionActive: false, earlyAccessActive: false,
    earlyAccessProgram: null, earlyAccessEndsAt: null, betaPriceEligible: false });
  assert.ok(Number.isFinite(Date.parse(value.asOf)));
});

test('only accepted matching requests create atomic lifetime facts', () => {
  for (const status of ['pending', 'approved', 'invited', 'denied', 'expired', 'revoked']) {
    query(`update private.early_access_requests set status='${status}' where id='${request}';
      ${denied(`insert into private.early_access_grants(id,user_id,program_key,request_id,accepted_at,starts_at)
      values('${grant}','${actor}','early_access_v1','${request}','2026-01-01','2026-01-01');`, '42501', 'early_access_accepted_request_required')}`);
  }
  qualify();
  const value = read();
  assert.equal(value.appAccess, true); assert.equal(value.earlyAccessActive, true);
  assert.equal(value.earlyAccessProgram, 'early_access_v1'); assert.equal(value.earlyAccessEndsAt, null);
  assert.equal(value.betaPriceEligible, true); assert.equal(value.paidSubscriptionActive, false);
  const [fact] = query('select to_jsonb(q) from private.early_access_price_qualifications q;');
  assert.deepEqual(fact, { user_id: actor, program_key: 'early_access_v1', grant_id: grant,
    qualified_at: '2026-01-01T00:00:00+00:00', policy_version: 1, currency: 'usd', unit_amount: 350, recurring_interval: 'month', interval_count: 1 });
  assert.deepEqual(query(asService(`select ${price()};`)), [{ user_id: actor, eligible: true }]);
});

test('beta boundary is strict and lifetime price survives beta, revocation, cancellation and return', () => {
  qualify();
  query("update private.early_access_programs set beta_starts_at='2026-07-01T00:00:00Z';");
  assert.deepEqual(query(`select jsonb_build_array(
    private.early_access_active_for_user('${actor}','2026-06-30T23:59:59.999999Z'),
    private.early_access_active_for_user('${actor}','2026-07-01T00:00:00Z'),
    private.early_access_active_for_user('${actor}','2025-12-31T23:59:59Z'),
    private.early_access_active_for_user('${actor}',null),
    private.early_access_active_for_user('${actor}','infinity'));`), [[true, false, false, false, false]]);
  assert.equal(read().earlyAccessActive, false); assert.equal(read().betaPriceEligible, true);
  query(`update private.early_access_grants set revoked_at=clock_timestamp(),revision=1 where id='${grant}';`);
  entitlement('subscription');
  assert.equal(read().paidSubscriptionActive, true);
  query("update public.entitlements set status='expired';");
  assert.equal(read().appAccess, false); assert.equal(read().betaPriceEligible, true);
  query("update public.entitlements set status='active';");
  assert.equal(read().paidSubscriptionActive, true); assert.equal(read().betaPriceEligible, true);
  assert.deepEqual(query(asService(`select ${price()};`)), [{ user_id: actor, eligible: true }]);
});

test('future explicit beta date is returned only while early access is active', () => {
  qualify(); query("update private.early_access_programs set beta_starts_at='2200-01-01';");
  assert.equal(read().earlyAccessEndsAt, '2200-01-01T00:00:00+00:00');
  query('update private.early_access_programs set configured=false;');
  const value = read(); assert.equal(value.earlyAccessActive, false); assert.equal(value.earlyAccessProgram, null);
  assert.equal(value.earlyAccessEndsAt, null); assert.equal(value.betaPriceEligible, true);
});

test('testing access stays distinct; current paid implies legacy; legacy start semantics remain unchanged', () => {
  entitlement('testing');
  let value = read(); assert.equal(value.legacyMembershipActive, true); assert.equal(value.appAccess, true);
  assert.equal(value.paidSubscriptionActive, false); assert.equal(value.earlyAccessActive, false); assert.equal(value.betaPriceEligible, false);
  query("update public.entitlements set source_type='subscription',starts_at='2200-01-01';");
  value = read(); assert.equal(value.legacyMembershipActive, true); assert.equal(value.paidSubscriptionActive, false);
  query("update public.entitlements set starts_at=null;");
  value = read(); assert.equal(value.legacyMembershipActive, true); assert.equal(value.paidSubscriptionActive, true);
  query("update public.entitlements set ends_at='2026-01-01';");
  assert.equal(read().appAccess, false);
});

test('foreign actor, invalid original session, malformed claims and false metadata fail closed', () => {
  const call = `perform ${context()};`;
  for (const options of [ { id: other }, { session: otherSid }, { session: null }, { session: randomUUID() },
    { claims: { session_id: 'not-uuid' } }, { role: 'service_role' }, { aal: null }, { claims: { sub: 'not-uuid' } } ]) {
    query(asActor(denied(call, 'PT401', 'member_authentication_required'), options));
  }
  query(asActor(denied(`perform ${context(null)};`, 'PT401')));
  const value = read({ claims: { user_metadata: { early_access: true, eligible: true, role: 'site_admin' }, app_metadata: { early_access: true } } });
  assert.equal(value.earlyAccessActive, false); assert.equal(value.betaPriceEligible, false);
});

test('canonical shared origin allowlist is required and no private payload is returned', () => {
  for (const options of [ { origin: 'https://attacker.invalid' }, { origin: null }, { origin: 'https://77dominion.com.attacker.invalid' } ]) {
    query(asActor(denied(`perform ${context()};`, 'PT403', 'member_origin_forbidden'), options));
  }
  query(asActor(denied(`perform ${context()};`, 'PT401'), { headers: 'invalid-json' }));
  const [headers] = query(asActor(`begin;select ${context()};select to_jsonb(current_setting('response.headers'));commit;`)).slice(1);
  assert.deepEqual(JSON.parse(headers), [{ 'Cache-Control': 'private, no-store' }, { Pragma: 'no-cache' }]);
});

test('deleted, unconfirmed, anonymous, suspended and expired/revoked sessions are rejected every time', () => {
  for (const patch of ["deleted_at=now()", "email_confirmed_at=null", "is_anonymous=true", "banned_until='2200-01-01'"]) {
    query(`begin;update auth.users set ${patch} where id='${actor}';
      ${asActor(denied(`perform ${context()};`, 'PT401'))}reset role;rollback;`);
  }
  query(`update auth.sessions set not_after=statement_timestamp() where id='${sid}';`);
  query(asActor(denied(`perform ${context()};`, 'PT401')));
  query(asService(denied(`perform ${price()};`, 'PT401')));
  query(`delete from auth.sessions where id='${sid}';`);
  query(asActor(denied(`perform ${context()};`, 'PT401')));
});

test('verified MFA requires both current session factor and signed JWT AAL2, not admin role or recent step-up', () => {
  query(`insert into auth.mfa_factors values('${factor}','${actor}','totp','verified');`);
  query(asActor(denied(`perform ${context()};`, 'PT403', 'member_mfa_required')));
  query(asActor(denied(`perform ${context()};`, 'PT403'), { aal: 'aal2' }));
  query(asService(denied(`perform ${price()};`, 'PT403')));
  query(`update auth.sessions set factor_id='${factor}',aal='aal2' where id='${sid}';`);
  query(asActor(denied(`perform ${context()};`, 'PT403'), { aal: 'aal1' }));
  assert.equal(read({ aal: 'aal2' }).actorId, actor);
  assert.deepEqual(query(asService(`select ${price()};`)), [{ user_id: actor, eligible: false }]);
  query(`insert into private.site_admin_session_blocks values('${sid}','${actor}',now(),'${randomUUID()}');`);
  assert.equal(read({ aal: 'aal2' }).actorId, actor, 'An admin-authority block does not grant or deny ordinary member access.');
  query(`update auth.mfa_factors set user_id='${other}' where id='${factor}';
    insert into auth.mfa_factors values('${randomUUID()}','${actor}','totp','verified');`);
  query(asActor(denied(`perform ${context()};`, 'PT403'), { aal: 'aal2' }));
});

test('unverified factor alone does not impose an admin-style MFA requirement', () => {
  query(`insert into auth.mfa_factors values('${factor}','${actor}','totp','unverified');`);
  assert.equal(read().actorId, actor);
});

test('service lookup requires the original matching live member session and cannot be called by members', () => {
  qualify();
  query(asService(denied(`perform ${price(actor, otherSid)};`, 'PT401')));
  query(asService(denied(`perform ${price(null, sid)};`, 'PT401')));
  query(asActor(denied(`perform ${price()};`, '42501')));
  query(`set role anon;${denied(`perform ${price()};`, '42501')}${denied(`perform ${context()};`, '42501')}`);
  query(asService(denied(`perform ${context()};`, '42501')));
  query(`set request.jwt.claims=${literal(JSON.stringify({ sub: actor, role: 'service_role' }))};set role service_role;
    ${denied(`perform ${price()};`, '42501', 'member_service_required')}`);
});

test('all private objects are deny-by-default with empty search paths and no added schema visibility', () => {
  const [tables, functions, privateUsage] = query(`select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,
    'allowed',exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner)))
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
      and c.relname in ('early_access_programs','early_access_grants','early_access_price_qualifications');
    select jsonb_agg(jsonb_build_object('name',p.proname,'config',p.proconfig,
      'publicAllowed',exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0)))
    from pg_proc p where p.proname in ('guard_early_access_grant','record_early_access_price_qualification','guard_early_access_price_qualification',
      'early_access_active_for_user','require_member_current_session','require_member_request_identity','member_access_context',
      'get_member_access_context','member_beta_price_eligibility','get_beta_price_eligibility');
    select to_jsonb(has_schema_privilege('authenticated','private','USAGE'));`);
  assert.equal(tables.length, 3); for (const table of tables) { assert.equal(table.rls, true); assert.equal(table.allowed, false); }
  assert.equal(functions.length, 10); for (const fn of functions) { assert.deepEqual(fn.config, ['search_path=""']); assert.equal(fn.publicAllowed, false); }
  assert.equal(privateUsage, false);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    query(`set role ${role};${denied('perform 1 from private.early_access_grants;', '42501')}
      ${denied(`perform private.early_access_active_for_user('${actor}',now());`, '42501')}`);
  }
});

test('facts and accepted identity cannot be rewritten, and later revocation cannot reactivate', () => {
  qualify();
  query(denied(`update private.early_access_price_qualifications set qualified_at=now();`, '42501', 'early_access_price_fact_immutable'));
  query(denied(`update private.early_access_grants set user_id='${other}';`, '42501', 'early_access_grant_immutable'));
  query(denied(`update private.early_access_grants set revoked_at=now(),revision=2;`, '42501', 'early_access_grant_immutable'));
  query('update private.early_access_grants set revoked_at=now(),revision=1;');
  query(denied('update private.early_access_grants set revoked_at=null,revision=2;', '42501', 'early_access_grant_immutable'));
  assert.equal(read().earlyAccessActive, false); assert.equal(read().betaPriceEligible, true);
});

test('qualification insert failure rolls the accepted grant back atomically', () => {
  query(`update private.early_access_requests set status='accepted' where id='${request}';
    create function private.fixture_reject_price() returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end$$;
    create trigger fixture_reject_price before insert on private.early_access_price_qualifications for each row execute function private.fixture_reject_price();
    ${denied(`insert into private.early_access_grants(id,user_id,program_key,request_id,accepted_at,starts_at)
      values('${grant}','${actor}','early_access_v1','${request}','2026-01-01','2026-01-01');`, 'P0001', 'synthetic failure')}`);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_grants;select to_jsonb(count(*)) from private.early_access_price_qualifications;'), [0, 0]);
});

test('Auth deletion removes live UUID-bound access without transferring facts to a reused email', () => {
  qualify(); query(`delete from auth.users where id='${actor}';update auth.users set email='one@example.invalid' where id='${other}';`);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_grants;select to_jsonb(count(*)) from private.early_access_price_qualifications;'), [0, 0]);
  assert.deepEqual(query(asService(`select ${price(other, otherSid)};`)), [{ user_id: other, eligible: false }]);
});

test('grant insertion cannot bind another applicant, accept in the future or create after the program boundary', () => {
  const insert = (id = actor, accepted = '2026-01-01') => `insert into private.early_access_grants
    (id,user_id,program_key,request_id,accepted_at,starts_at)
    values('${grant}','${id}','early_access_v1','${request}',${literal(accepted)},${literal(accepted)});`;
  query(`update private.early_access_requests set status='accepted' where id='${request}';`);
  query(denied(insert(other), '42501', 'early_access_accepted_request_required'));
  query(denied(insert(actor, '2200-01-01'), '42501', 'early_access_accepted_request_required'));
  query("update private.early_access_programs set beta_starts_at='2026-01-01';");
  query(denied(insert(), '42501', 'early_access_accepted_request_required'));
  query('update private.early_access_programs set beta_starts_at=null,configured=false;');
  query(denied(insert(), '42501', 'early_access_accepted_request_required'));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_price_qualifications;'), [0]);
});

test('healthy owner checks also protect the internal predicate and price lookup', () => {
  qualify();
  for (const patch of ["deleted_at=now()", "email_confirmed_at=null", "is_anonymous=true", "banned_until='2200-01-01'"]) {
    const [active] = query(`begin;update auth.users set ${patch} where id='${actor}';
      select to_jsonb(private.early_access_active_for_user('${actor}',statement_timestamp()));
      ${asService(denied(`perform ${price()};`, 'PT401', 'member_authentication_required'))}reset role;rollback;`);
    assert.equal(active, false);
  }
});

test('a session that expires while the same SQL statement waits is rejected after the wait', async () => {
  query(`create function public.fixture_wait_then_context(target uuid) returns jsonb
    language plpgsql security definer set search_path='' as $$begin
      perform private.require_member_request_identity(target);
      perform pg_catalog.pg_advisory_xact_lock(1803, 999);
      return public.get_member_access_context(target);
    end$$;`);
  const blocker = parallel("set application_name='member-expiry-blocker';begin;select pg_advisory_xact_lock(1803,999);select pg_sleep(1.5);commit;");
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='member-expiry-blocker' and wait_event='PgSleep')");
  const waiting = parallel(asActor(`set application_name='member-expiry-waiter';select public.fixture_wait_then_context('${actor}');`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='member-expiry-waiter' and wait_event='advisory')");
  // After the first identity check and statement start, but before lock release.
  query(`update auth.sessions set not_after=clock_timestamp() where id='${sid}';`);
  const [held, result] = await Promise.all([blocker, waiting]);
  assert.equal(held.code, 0, held.error);
  assert.notEqual(result.code, 0); assert.match(result.error, /member_authentication_required/);
});
