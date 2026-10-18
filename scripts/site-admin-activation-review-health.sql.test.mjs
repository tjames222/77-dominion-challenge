import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';
import { verifyPost74ReleaseSources } from './verify-post74-release-plan.mjs';

// Actual first75 migrations and canonical Admin guards, in the existing owned
// PG17.6 network-none/read-only-root/tmpfs fixture. Never a hosted DB, existing
// local stack, native account, credential, pull, bind mount or published port.
const migrationName = '20261018013111_site_admin_activation_review_health.sql';
const signature = 'public.site_admin_get_activation_review_health(uuid)';
const registry = 'private.challenge_activation_migration_reviews';
const index = 'private.challenge_activation_reviews_unresolved_created_idx';
const actor = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const reserve = '10000000-0000-4000-8000-000000000003';
const session = '30000000-0000-4000-8000-000000000001';
const memberSession = '30000000-0000-4000-8000-000000000002';
const factor = '20000000-0000-4000-8000-000000000001';
const otherFactor = '20000000-0000-4000-8000-000000000002';
const sentinel = 'SYNTHETIC_PRIVATE_REVIEW_REASON_EVIDENCE_NOTE';
const quote = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const sha = value => createHash('sha256').update(value).digest('hex');
const source = filename => readFile(new URL(`../supabase/migrations/${filename}`, import.meta.url), 'utf8');
let fixture; let migration; let names; let sources; let frozenBoundary; let buildCost; let writeBefore; let writeAfter; let beforeRows;
const pending = new Set();
const query = sql => fixture.queryAsBootstrap(`set role postgres;set statement_timeout='20s';set search_path=public,extensions;${sql}`);
const bootstrap = sql => fixture.queryAsBootstrap(`set statement_timeout='20s';set search_path=public,extensions;${sql}`);
const one = sql => JSON.parse(query(sql));
const asyncQuery = sql => {
  const promise = fixture.queryAsBootstrapAsync(`set role postgres;set statement_timeout='15s';set search_path=public,extensions;${sql}`);
  pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
};
const health = (expected = actor) => `select public.site_admin_get_activation_review_health(${quote(expected)});`;
function asActor(sql, { id = actor, sid = session, aal = 'aal2', origin = 'https://77dominion.com', claims = {} } = {}) {
  return `set request.jwt.claims=${quote(JSON.stringify({ sub: id, session_id: sid, role: 'authenticated', aal, ...claims }))};
    set request.jwt.claim.sub='';set request.headers=${quote(JSON.stringify({ origin }))};set role authenticated;${sql}`;
}
function denied(sql, state = 'PT403', message) {
  return `do $denied$ begin begin ${sql.replace(/^select /, 'perform ')} exception when sqlstate '${state}' then
    ${message ? `if sqlerrm<>${quote(message)} then raise;end if;` : ''}return;end;raise exception 'Expected fixed denial';end $denied$;`;
}
function boundary() {
  return one(`select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text)order by n.nspname,c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in('public','private','auth')),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p)order by schemaname,tablename,policyname),'[]')from pg_policies p),
    'roles',(select jsonb_agg(to_jsonb(r)order by rolname)from pg_roles r),
    'roleMembership',(select coalesce(jsonb_agg(to_jsonb(m)order by roleid,member),'[]')from pg_auth_members m),
    'permissions',(select jsonb_agg(to_jsonb(p)order by role_key,permission_key)from private.site_role_permissions p),
    'helpers',(select jsonb_agg(jsonb_build_array(oid::regprocedure::text,pg_get_functiondef(oid),proowner,proacl::text)order by oid::regprocedure::text)
      from pg_proc where oid in('private.require_site_admin(text,uuid,boolean)'::regprocedure,
      'private.site_admin_request_identity(uuid)'::regprocedure,'private.site_admin_mfa_ready(uuid,uuid,boolean)'::regprocedure)),
    'columnGrants',(select coalesce(jsonb_agg(jsonb_build_array(attrelid,attname,attacl::text)order by attrelid,attnum),'[]')from pg_attribute where attacl is not null));`);
}
function rowFingerprint() {
  const tables = one("select jsonb_agg(format('%I.%I',n.nspname,c.relname)order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in('public','private','auth');");
  return one(`select jsonb_object_agg(name,digest)from(${tables.map(table => `select ${quote(table)} as name,
    (select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n'order by to_jsonb(r)::text),''))from ${table} r)as digest`).join(' union all ')})proof;`);
}
const insertRows = (amount, { prefix = 'review', resolved = false, time = "timestamptz '2026-01-01 00:00:00+00'" } = {}) => `
  insert into ${registry}(user_id,reasons,evidence,created_at,resolved_at,resolved_by,resolution_note)
  select md5('activation-health-user:'||n)::uuid,array['${sentinel}'],jsonb_build_object('private','${sentinel}'),${time},
    ${resolved ? `statement_timestamp(),'${actor}'` : 'null,null'},'${sentinel}:${prefix}'from generate_series(1,${amount})n;`;
const writeProbe = `begin;explain(analyze,buffers,wal,format json)update ${registry}
  set resolved_at=statement_timestamp(),resolved_by='${actor}' where user_id in(select user_id from ${registry} order by user_id limit 1000);rollback;`;
const nodes = plan => [plan, ...(plan.Plans || []).flatMap(nodes)];
const clean = () => query(`truncate ${registry};`);

before(async () => {
  names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort().slice(0, 75);
  sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await source(name)])));
  verifyPost74ReleaseSources({ migrationFilenames: names, migrationSourceHashes: Object.fromEntries(names.map(name => [name, sha(sources[name])])) });
  migration = await source(migrationName);
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  for (const name of names.slice(70)) query(`begin;set local check_function_bodies=on;${sources[name]}
    insert into supabase_migrations.schema_migrations(version,name,statements)values(${quote(name.slice(0,14))},${quote(name.slice(15,-4))},array[${quote(sources[name])}]);commit;`);
  bootstrap(`grant usage on schema public,auth,extensions to anon,authenticated,service_role;
    create or replace function auth.uid()returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    create role supabase_auth_admin nologin nosuperuser nocreaterole nobypassrls;grant usage on schema auth to supabase_auth_admin;
    alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger,maintain on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to postgres;`);
  query(`insert into auth.users(id,email,email_confirmed_at,created_at,updated_at)values
    ('${actor}','admin@example.invalid',now(),now(),now()),('${member}','member@example.invalid',now(),now(),now()),('${reserve}','reserve@example.invalid',now(),now(),now());
    insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at)values
    ('${factor}','${actor}','totp','verified',now(),now()),('${otherFactor}','${member}','totp','verified',now(),now()),
    ('20000000-0000-4000-8000-000000000003','${reserve}','totp','verified',now(),now());
    update private.site_user_roles set role_key='site_admin'where user_id in('${actor}','${reserve}');
    insert into auth.sessions(id,user_id,factor_id,aal,not_after)values('${session}','${actor}','${factor}','aal2',null),('${memberSession}','${member}','${otherFactor}','aal2',null);
    insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at)values(gen_random_uuid(),'${session}','totp',now()-interval '1 day',now()-interval '1 day');
    insert into auth.users(id,email,email_confirmed_at)select md5('activation-health-user:'||n)::uuid,'synthetic-'||n||'@example.invalid',now()from generate_series(1,100000)n;
    ${insertRows(100000)}vacuum(analyze)${registry};`);
  frozenBoundary = boundary(); beforeRows = rowFingerprint();
  bootstrap('checkpoint;'); writeBefore = one(writeProbe)[0]; query(`vacuum(analyze)${registry};`);
  buildCost = one(`begin;do $$begin perform set_config('fixture.build_started_at',clock_timestamp()::text,true);end$$;${migration}
    select jsonb_build_object('elapsedMs',extract(epoch from(clock_timestamp()-current_setting('fixture.build_started_at')::timestamptz))*1000,
      'rows',(select count(*)from ${registry}),'heapBytes',pg_relation_size('${registry}'),'totalBytes',pg_total_relation_size('${registry}'),
      'indexBytes',pg_relation_size('${index}'),'locks',(select jsonb_agg(mode order by mode)from pg_locks where pid=pg_backend_pid()and relation='${registry}'::regclass and granted));commit;`);
  bootstrap('checkpoint;'); writeAfter = one(writeProbe)[0];
});
after(async () => {
  await Promise.allSettled([...pending]); fixture?.close();
  for (const name of names || []) assert.equal(sha(await source(name)), sha(sources[name]), `Frozen migration changed: ${name}`);
});

test('actual first75 and canonical authority remain unchanged by the non-superuser additive migration', () => {
  assert.equal(one("select to_jsonb(rolsuper)from pg_roles where rolname='postgres';"), false);
  assert.equal(one('select to_jsonb(count(*))from supabase_migrations.schema_migrations;'), 75);
  assert.deepEqual(boundary(), frozenBoundary); assert.deepEqual(rowFingerprint(), beforeRows);
  assert.equal((migration.match(/create index /g) || []).length, 1);
  assert.equal((migration.match(/create function /g) || []).length, 1);
  assert.doesNotMatch(migration, /create\s+(table|role|policy)|alter\s+(table|role)|insert\s+into|delete\s+from|update\s+(public|private)|grant\s+[^;]*\bon\s+(?:table\s+)?(?:private|auth)\./i);
  assert.match(migration, /perform private\.require_site_admin\('operations\.read', target_expected_actor_id, false\);/);
  assert.doesNotMatch(migration, /testing\.manage|operations\.manage|review_required|resolution_note|select \*/);
  assert.equal(one(`select to_jsonb(pg_get_userbyid(proowner)='postgres'and prosecdef and provolatile='s'
    and proconfig @> array['search_path=""','lock_timeout=1s','TimeZone=UTC'])from pg_proc where oid='${signature}'::regprocedure;`), true);
  assert.equal(one(`select to_jsonb(i.indisvalid and i.indisready and pg_get_expr(i.indpred,i.indrelid)='(resolved_at IS NULL)'
    and pg_get_indexdef(i.indexrelid)like '%(created_at, user_id)%')from pg_index i where indexrelid='${index}'::regclass;`), true);
  clean();
});

test('function ACL grants only authenticated while private source ACL/RLS and direct access remain unchanged', () => {
  for (const role of ['anon', 'service_role']) query(`set role ${role};${denied(health(), '42501')}`);
  for (const role of ['anon', 'authenticated']) query(`set role ${role};${denied(`select * from ${registry};`, '42501')}`);
  assert.deepEqual(one(`select jsonb_agg(jsonb_build_array(coalesce(r.rolname,'PUBLIC'),a.privilege_type,a.is_grantable)order by coalesce(r.rolname,'PUBLIC'))
    from pg_proc p cross join lateral aclexplode(p.proacl)a left join pg_roles r on r.oid=a.grantee where p.oid='${signature}'::regprocedure;`),
  [['authenticated','EXECUTE',false],['postgres','EXECUTE',false]]);
  assert.equal(one(`select to_jsonb(relrowsecurity)from pg_class where oid='${registry}'::regclass;`), true);
  assert.deepEqual(boundary(), frozenBoundary);
});

test('native canonical guard denies actor, JWT role, Origin, member and metadata-spoofed admin mismatches', () => {
  for (const [expected, options, code] of [
    [null, {}, 'PT401'], [member, {}, 'PT401'], [actor, {id:null}, 'PT401'], [actor, {claims:{role:'service_role'}}, 'PT401'],
    [actor, {origin:null}, 'PT403'], [actor, {origin:'https://attacker.invalid'}, 'PT403'],
    [member, {id:member,sid:memberSession,claims:{user_metadata:{role:'site_admin'},app_metadata:{site_admin:true}}}, 'PT403'],
  ]) query(asActor(denied(health(expected), code), options));
  query(asActor(`set request.headers='not-json';${denied(health(),'PT401')}`));
});

test('native live session guard denies missing, malformed, wrong-owner, deleted, expired and replaced sessions', () => {
  for (const sid of [null, 'not-a-uuid', randomUUID(), memberSession]) query(asActor(denied(health(), 'PT401'), {sid}));
  for (const mutation of [
    `delete from auth.sessions where id='${session}';`,
    `update auth.sessions set not_after=statement_timestamp()where id='${session}';`,
    `update auth.sessions set user_id='${member}'where id='${session}';`,
    `delete from auth.sessions where id='${session}';insert into auth.sessions(id,user_id,factor_id,aal)values('${randomUUID()}','${actor}','${factor}','aal2');`,
  ]) query(`begin;${mutation}${asActor(denied(health(),'PT401'))}rollback;`);
});

test('native account lifecycle and factor/session AAL2 branches cannot be bypassed by JWT claims', () => {
  for (const change of ['deleted_at=now()', "banned_until=now()+interval '1 day'", 'is_anonymous=true', 'email_confirmed_at=null'])
    query(`begin;update auth.users set ${change} where id='${actor}';${asActor(denied(health(),'PT401'))}rollback;`);
  query(`begin;delete from auth.users where id='${actor}';${asActor(denied(health(),'PT401'))}rollback;`);
  query(asActor(denied(health()), {aal:'aal1'}));
  for (const mutation of [
    `update auth.sessions set aal='aal1'where id='${session}';`,
    `update auth.sessions set factor_id=null where id='${session}';`,
    `update auth.sessions set factor_id='${otherFactor}'where id='${session}';`,
    `update auth.mfa_factors set status='unverified'where id='${factor}';`,
    `update auth.mfa_factors set user_id='${member}'where id='${factor}';`,
    `update auth.mfa_factors set factor_type='phone'where id='${factor}';`,
    `delete from auth.mfa_factors where id='${factor}';`,
    `insert into private.site_admin_session_blocks(session_id,user_id,request_id)values('${session}','${actor}',gen_random_uuid());`,
    `update private.site_user_roles set role_key='member'where user_id='${actor}';`,
    "delete from private.site_role_permissions where permission_key='operations.read';",
  ]) query(`begin;${mutation}${asActor(denied(health()))}rollback;`);
});

test('operations.read alone and old verified MFA suffice without auditing or any application row writes', () => {
  const before = rowFingerprint();
  const result = one(`begin;delete from private.site_role_permissions where role_key='site_admin'and permission_key<>'operations.read';${asActor(health())}rollback;`);
  assert.equal(result.schemaVersion, 1);
  one(`begin read only;${asActor(health())}rollback;`);
  assert.deepEqual(rowFingerprint(), before); assert.deepEqual(boundary(), frozenBoundary);
});

test('empty DTO keys, UTC observation and no-store response headers disclose no sensitive fields', () => {
  const result = one(`begin read only;${asActor(health())}rollback;`);
  assert.deepEqual(Object.keys(result).sort(), ['actorId','counterLimit','coverage','observedAt','oldestRecordedAt','oldestRecordedState','schemaVersion','unresolved']);
  assert.equal(result.actorId, actor); assert.equal(result.schemaVersion, 1); assert.equal(result.counterLimit, 1000);
  assert.equal(result.coverage, 'legacy-activation-migration-reviews-only');
  assert.deepEqual(result.unresolved, {count:0,hasMore:false}); assert.equal(result.oldestRecordedAt,null); assert.equal(result.oldestRecordedState,'none');
  assert.match(result.observedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?\+00:00$/);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|reasons|evidence|resolution|userId|healthy|currentBlock/);
  assert.deepEqual(one(`begin;${asActor(`do $$begin perform public.site_admin_get_activation_review_health('${actor}');end$$;select current_setting('response.headers')::jsonb;`)}rollback;`),
    [{'Cache-Control':'private, no-store'},{Pragma:'no-cache'}]);
});

test('counts distinguish resolved-only, mixed, 999, exact1000 and1000+; oldest order is chronological not UUID', () => {
  for (const amount of [0,1,999,1000,1001,5000]) {
    const result = one(`begin;${insertRows(amount)}${asActor(health())}rollback;`);
    assert.deepEqual(result.unresolved, {count:Math.min(amount,1000),hasMore:amount>1000});
    assert.equal(result.oldestRecordedState, amount ? 'known' : 'none');
  }
  const resolved = one(`begin;${insertRows(5000,{resolved:true})}${asActor(health())}rollback;`);
  assert.deepEqual(resolved.unresolved,{count:0,hasMore:false}); assert.equal(resolved.oldestRecordedState,'none');
  const mixed = one(`begin;${insertRows(10000,{resolved:true})}update ${registry} set resolved_at=null,resolved_by=null where user_id in(select user_id from ${registry} order by user_id desc limit 2);
    update ${registry} set created_at='0001-01-01 00:00:00+00'where user_id=(select max(user_id::text)::uuid from ${registry} where resolved_at is null);${asActor(health())}rollback;`);
  assert.deepEqual(mixed.unresolved,{count:2,hasMore:false}); assert.equal(mixed.oldestRecordedAt,'0001-01-01T00:00:00+00:00');
});

test('nonempty aggregate is read-only and never exposes source identities, reasons, evidence or notes', () => {
  query(insertRows(2));
  const before = rowFingerprint();
  const result = one(`begin read only;${asActor(health())}rollback;`);
  assert.deepEqual(result.unresolved, {count:2,hasMore:false});
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|reasons|evidence|resolution|userId|healthy|currentBlock/);
  const sourceIds = one(`select jsonb_agg(user_id)from ${registry};`);
  for (const id of sourceIds) assert.equal(JSON.stringify(result).includes(id), false);
  assert.deepEqual(rowFingerprint(), before);
  clean();
});

test('invalid earliest finite/out-of-range/infinite/future times stay unknown rather than skipping rows', () => {
  for (const time of ["'-infinity'::timestamptz", "'infinity'::timestamptz", "'0010-01-01 BC'::timestamptz", "'10000-01-01+00'::timestamptz", "statement_timestamp()+interval '1 day'"]) {
    const result = one(`begin;${insertRows(1,{time})}${asActor(health())}rollback;`);
    assert.deepEqual(result.unresolved,{count:1,hasMore:false}); assert.equal(result.oldestRecordedAt,null); assert.equal(result.oldestRecordedState,'unknown');
  }
  const invalidPrefix = one(`begin;${insertRows(1001)}update ${registry} set created_at='-infinity'where user_id=md5('activation-health-user:1')::uuid;${asActor(health())}rollback;`);
  assert.deepEqual(invalidPrefix.unresolved,{count:1000,hasMore:true}); assert.equal(invalidPrefix.oldestRecordedState,'unknown');
  const validPrefix = one(`begin;${insertRows(3)}update ${registry} set created_at='infinity'where user_id=md5('activation-health-user:2')::uuid;
    update ${registry} set created_at=statement_timestamp()+interval '1 day'where user_id=md5('activation-health-user:3')::uuid;${asActor(health())}rollback;`);
  assert.equal(validPrefix.oldestRecordedState,'known'); assert.equal(validPrefix.oldestRecordedAt,'2026-01-01T00:00:00+00:00');
});

test('exact observed-time boundary is accepted, with microseconds retained and no browser-clock comparison', () => {
  query(`begin;${insertRows(1)}do $$declare result jsonb;begin update ${registry} set created_at=statement_timestamp();
    perform set_config('request.jwt.claims',${quote(JSON.stringify({sub:actor,session_id:session,role:'authenticated',aal:'aal2'}))},true);
    perform set_config('request.headers','{"origin":"https://77dominion.com"}',true);
    result:=public.site_admin_get_activation_review_health('${actor}');
    if result->>'oldestRecordedState'<>'known' or result->>'oldestRecordedAt'<>result->>'observedAt'then raise exception 'Exact time boundary failed';end if;end$$;rollback;`);
});

test('UTC DTO survives caller +14/-12 zones including year1 and restores caller configuration', () => {
  for (const zone of ['+14:00','-12:00']) {
    const result = one(`begin;${insertRows(1,{time:"timestamptz '0001-01-01 00:00:00.123456+00'"})}
      set time zone interval '${zone}' hour to minute;${asActor(`select jsonb_build_object('before',current_setting('TimeZone'),
        'result',public.site_admin_get_activation_review_health('${actor}'),'after',current_setting('TimeZone'));`)}rollback;`);
    assert.equal(result.before,result.after); assert.notEqual(result.before,'UTC');
    assert.equal(result.result.oldestRecordedAt,'0001-01-01T00:00:00.123456+00:00');
    assert.equal(result.result.oldestRecordedState,'known'); assert.match(result.result.observedAt,/\+00:00$/);
  }
});

test('resolving a legacy record changes the next snapshot without asserting current runtime repair', () => {
  query(insertRows(2));
  query(`update ${registry} set created_at='2025-01-01+00'where user_id=md5('activation-health-user:1')::uuid;`);
  const first = one(asActor(health())); assert.equal(first.unresolved.count,2);
  assert.equal(first.oldestRecordedAt,'2025-01-01T00:00:00+00:00');
  query(`update ${registry} set resolved_at=now(),resolved_by='${actor}'where user_id=md5('activation-health-user:1')::uuid;`);
  const second = one(asActor(health())); assert.equal(second.unresolved.count,1);
  assert.equal(second.oldestRecordedAt,'2026-01-01T00:00:00+00:00'); clean();
  const currentFlagOnly = one(`begin;insert into private.challenge_runtime(user_id,review_required,review_reason)values('${member}',true,'synthetic_review');${asActor(health())}rollback;`);
  assert.equal(currentFlagOnly.unresolved.count,0); assert.equal(currentFlagOnly.oldestRecordedState,'none');
  const legacyOnly = one(`begin;${insertRows(1)}insert into private.challenge_runtime(user_id,review_required)values(md5('activation-health-user:1')::uuid,false);${asActor(health())}rollback;`);
  assert.equal(legacyOnly.unresolved.count,1); assert.equal(legacyOnly.coverage,'legacy-activation-migration-reviews-only');
});

test('underlying read denial or missing guard/table fails closed instead of returning zero', () => {
  bootstrap(`begin;create role fixture_activation_reader nologin nosuperuser nobypassrls;
    grant usage on schema public,private to fixture_activation_reader;grant execute on function private.require_site_admin(text,uuid,boolean)to fixture_activation_reader;
    alter function ${signature} owner to fixture_activation_reader;${asActor(denied(health(),'42501'))}rollback;`);
  query(`begin;alter function private.require_site_admin(text,uuid,boolean)rename to fixture_missing_admin_guard;${asActor(denied(health(),'42883'))}rollback;`);
  query(`begin;alter table ${registry} rename to fixture_missing_review_table;${asActor(denied(health(),'42P01'))}rollback;`);
  query(`begin;alter table ${registry} rename column created_at to fixture_missing_timestamp;${asActor(denied(health(),'42703'))}rollback;`);
  assert.deepEqual(boundary(),frozenBoundary);
});

test('runtime source lock contention fails within the one-second function lock limit, never as an empty queue', async () => {
  const appName = `activation-read-lock-${randomUUID()}`;
  const holder = asyncQuery(`set application_name='${appName}';begin;lock table ${registry} in access exclusive mode;select pg_sleep(3);rollback;`);
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.parse(bootstrap(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${appName}'and wait_event='PgSleep'));`))) {
      locked = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(locked, 'Owned source-lock holder must reach the explicit barrier.');
  try {
    await assert.rejects(asyncQuery(`begin read only;${asActor(health())}rollback;`), /lock timeout/);
  } finally {
    await holder;
  }
  assert.deepEqual(one(`begin read only;${asActor(health())}rollback;`).unresolved, {count:0,hasMore:false});
  assert.deepEqual(boundary(), frozenBoundary);
});

test('exact oldest-prefix probe has bounded visible results across sparse, capped, tie and churn distributions', t => {
  const probe = migration.match(/-- BEGIN BOUNDED LEGACY REVIEWS\n([\s\S]*?)\n  -- END BOUNDED LEGACY REVIEWS/)?.[1]
    .replace(/\s+into sampled_count, oldest_recorded_at/,''); assert.ok(probe);
  const evidence=[];
  for (const scenario of ['empty','small','sparse','all-unresolved','ties','churn']) {
    clean();
    const amount=scenario==='empty'?0:scenario==='small'?10:100000;
    query(`${insertRows(amount,{resolved:scenario==='sparse',time:scenario==='ties'?"timestamptz '2026-01-01+00'":"timestamptz '2026-01-01+00'+n*interval '1 microsecond'"})}
      ${scenario==='sparse'?`update ${registry} set resolved_at=null,resolved_by=null where user_id in(select user_id from ${registry} order by user_id limit 7);`:''}
      vacuum(analyze)${registry};`);
    if(scenario==='churn')query(`update ${registry} set created_at=created_at+interval '1 second'where user_id in(select user_id from ${registry} order by created_at,user_id limit 10000);analyze ${registry};`);
    const plan=one(`explain(analyze,buffers,format json)${probe}`)[0]; const all=nodes(plan.Plan);
    const scans=all.filter(n=>n['Relation Name']==='challenge_activation_migration_reviews');
    const limit=all.find(n=>n['Node Type']==='Limit'); assert.ok(limit); assert.ok(limit['Actual Rows']<=1001);
    assert.equal(scans.length,1); assert.equal(all.filter(n=>n['Node Type']==='CTE Scan').length,1);
    if(['sparse','all-unresolved','ties'].includes(scenario)){
      assert.match(scans[0]['Index Name']||'',/challenge_activation_reviews_unresolved_created_idx/);
      assert.equal(scans[0]['Rows Removed by Filter']||0,0); assert.equal(all.some(n=>n['Node Type']==='Sort'),false);
    }
    const result=one(`begin read only;${asActor(health())}rollback;`);
    const expected=scenario==='sparse'?7:Math.min(amount,1000);assert.deepEqual(result.unresolved,{count:expected,hasMore:scenario!=='sparse'&&amount>1000});
    evidence.push({scenario,rows:amount,visiblePrefix:limit['Actual Rows'],executionMs:plan['Execution Time'],sharedBlocks:plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks'],
      scans:scans.map(n=>({type:n['Node Type'],index:n['Index Name'],rows:n['Actual Rows'],heapFetches:n['Heap Fetches'],rowsRemoved:n['Rows Removed by Filter']||0})),
      sorts:all.filter(n=>n['Node Type']==='Sort').map(n=>({method:n['Sort Method'],inputRows:n.Plans[0]['Actual Rows']}))});
  }
  t.diagnostic('ACTIVATION_REVIEW_PLANS '+JSON.stringify({logicalVisiblePrefixLimit:1001,notAbsolutePhysicalWorkBound:true,evidence}));clean();
});

test('index build and lifecycle-write cost are explicit and canonical catalog metadata is recorded', t => {
  assert.equal(buildCost.rows,100000);assert.ok(buildCost.elapsedMs<30000);assert.ok(buildCost.locks.includes('ShareLock'));
  const reduce=plan=>({executionMs:plan['Execution Time'],sharedBlocks:plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks'],walBytes:plan.Plan['WAL Bytes'],walRecords:plan.Plan['WAL Records'],walFullPageImages:plan.Plan['WAL FPI']});
  t.diagnostic('ACTIVATION_REVIEW_BUILD_COST '+JSON.stringify({buildCost,write1000Before:reduce(writeBefore),write1000After:reduce(writeAfter),
    limitations:'One synthetic warm-cache sample, not hosted latency. Rolled-back updates still create WAL/dead versions. Ordinary index SHARE lock persists to transaction end. Visible prefix cap does not bound MVCC physical work.'}));
  const catalog=one(`set search_path=pg_catalog;set timezone='UTC';set datestyle='ISO,YMD';select jsonb_build_object(
    'functions',(select jsonb_object_agg(sig,encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(sig)),'UTF8')),'hex'))from unnest(array['${signature}','private.require_site_admin(text,uuid,boolean)','private.site_admin_request_identity(uuid)','private.site_admin_mfa_ready(uuid,uuid,boolean)'])sig),
    'index',pg_get_indexdef('${index}'::regclass),'indexHash',encode(sha256(convert_to(pg_get_indexdef('${index}'::regclass),'UTF8')),'hex'),
    'functionOwner',(select pg_get_userbyid(proowner)from pg_proc where oid='${signature}'::regprocedure),
    'columns',(select jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull)order by attnum)from pg_attribute where attrelid='${registry}'::regclass and attnum>0 and not attisdropped));`);
  t.diagnostic('CANONICAL_ACTIVATION_REVIEW_CATALOG '+JSON.stringify(catalog));
});

test('transactional index lock timeout rolls back the entire addition with no partial object', async () => {
  query(`drop function ${signature};drop index ${index};`);
  const appName=`activation-lock-${randomUUID()}`;
  const holder=asyncQuery(`set application_name='${appName}';begin;lock table ${registry} in row exclusive mode;select pg_sleep(7);rollback;`);
  let locked=false;
  for(let attempt=0;attempt<100;attempt++){
    if(JSON.parse(bootstrap(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${appName}'and wait_event='PgSleep'));`))){locked=true;break;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(locked,'Owned lock holder must reach the explicit barrier.');
  try{await assert.rejects(asyncQuery(`begin;${migration}commit;`),/lock timeout/);}finally{await holder;}
  assert.equal(one(`select to_jsonb(to_regprocedure('${signature}')is null and to_regclass('${index}')is null);`),true);
  assert.deepEqual(boundary(),frozenBoundary);
  query(`begin;${migration}commit;`);
  assert.equal(one(`begin read only;${asActor(health())}rollback;`).schemaVersion,1);
});
