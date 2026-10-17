import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';
import { verifyPost73ReleaseSources } from './verify-post73-release-plan.mjs';

// The reviewed full-chain helper only creates an owned, network-none, no-mount,
// socket-only tmpfs cluster from its already cached PG17 image. No existing DB,
// Auth session, credential, remote endpoint, CLI reset, registry pull or provider.
const migrationName = '20261013091749_site_admin_profile_name_correction.sql';
const root = new URL('../supabase/', import.meta.url);
const quote = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const sha = value => createHash('sha256').update(value).digest('hex');
const readSignature = 'public.site_admin_get_profile_name(uuid,uuid)';
const writeSignature = 'public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)';
let fixture; let migration; let context; let frozenBoundary; let preflightSql; let historicalProfile; let migrationCost;
// Bootstrap session may SET ROLE for the test's native runtime assertions. All
// SQL starts as the actual NOSUPERUSER application owner, never as bootstrap.
const query = sql => fixture.queryAsBootstrap(`set role postgres;set statement_timeout='20s';set search_path=public,extensions;${sql}`);
const bootstrap = sql => fixture.queryAsBootstrap(`set statement_timeout='20s';set search_path=public,extensions;${sql}`);
const parsed = sql => query(sql).split('\n').filter(Boolean).map(JSON.parse);
const one = sql => parsed(sql).at(-1);
const source = filename => readFile(new URL(`migrations/${filename}`, root), 'utf8');
function asActor(sql, { actor = context.actor, session = context.session, aal = 'aal2', origin = 'https://77dominion.com', age = 0, claims = {} } = {}) {
  return `set request.jwt.claims=${quote(JSON.stringify({ sub: actor, session_id: session, role: 'authenticated', aal,
    amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - age }], ...claims }))};
    set request.jwt.claim.sub='';set request.headers=${quote(JSON.stringify({ origin }))};set role authenticated;${sql}`;
}
function denied(sql, state = 'PT403', message) {
  return `do $denial$ begin begin ${sql.replace(/^select /, 'perform ')}
    exception when sqlstate '${state}' then ${message ? `if sqlerrm<>${quote(message)} then raise;end if;` : ''}return;end;
    raise exception 'Expected fixed denial';end $denial$;`;
}
function read(target = context.target, expected = context.actor) {
  return `select public.site_admin_get_profile_name(${quote(expected)},${quote(target)});`;
}
function write({ actor = context.actor, target = context.target, version = context.version, name = 'Corrected Member', operation = randomUUID(), correlation = randomUUID() } = {}) {
  return `select public.site_admin_correct_profile_name(${quote(actor)},${quote(target)},${quote(version)},${quote(name)},${quote(operation)},${quote(correlation)});`;
}
function seed() {
  const ids = { actor: randomUUID(), target: randomUUID(), session: randomUUID(), factor: randomUUID() };
  query(`insert into auth.users(id,email,email_confirmed_at,created_at,updated_at) values
    ('${ids.actor}','admin-${ids.actor}@example.invalid',now(),now(),now()),('${ids.target}','member-${ids.target}@example.invalid',now(),now(),now());
    insert into public.profiles(user_id,name,email,updated_at) values('${ids.actor}','Administrator','admin@example.invalid','2026-01-01T00:00:00.123456Z'),
      ('${ids.target}','Original Member','member@example.invalid','2026-01-01T00:00:00.654321Z');
    insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values('${ids.factor}','${ids.actor}','totp','verified',now(),now());
    update private.site_user_roles set role_key='site_admin' where user_id='${ids.actor}';
    insert into auth.sessions(id,user_id,factor_id,aal,not_after) values('${ids.session}','${ids.actor}','${ids.factor}','aal2',null);
    insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values(gen_random_uuid(),'${ids.session}','totp',now(),now());`);
  return ids;
}
function auditCount(actor = context.actor) { return one(`select to_jsonb(count(*)) from private.site_admin_audit where actor_id='${actor}';`); }
function profile(target = context.target) { return one(`select to_jsonb(p) from public.profiles p where user_id='${target}';`); }
function version(target = context.target) { return one(`select to_jsonb(version) from private.site_admin_profile_name_versions where user_id='${target}';`); }
function rows(target = context.target) { return one(`select jsonb_build_object('profile',to_jsonb(p),'version',v.version) from public.profiles p join private.site_admin_profile_name_versions v using(user_id) where user_id='${target}';`); }
function authorityBoundary() {
  return one(`select jsonb_build_object('auth',(select jsonb_agg(jsonb_build_array(relname,relowner,relacl::text) order by relname) from pg_class where relnamespace='auth'::regnamespace and relkind='r'),
    'helpers',(select jsonb_agg(jsonb_build_array(oid::regprocedure::text,pg_get_functiondef(oid),proacl::text) order by oid::regprocedure::text)from pg_proc
      where oid in('private.require_site_admin(text,uuid,boolean)'::regprocedure,'private.site_admin_request_identity(uuid)'::regprocedure,
        'private.site_admin_mfa_ready(uuid,uuid,boolean)'::regprocedure,'private.require_member_current_session(uuid,uuid)'::regprocedure)),
    'profilePolicies',(select jsonb_agg(to_jsonb(p) order by policyname)from pg_policies p where schemaname='public' and tablename='profiles'),
    'profileAcl',(select relacl::text from pg_class where oid='public.profiles'::regclass));`);
}
async function fresh74() {
  const value = await createOriginal77FullchainFixture({ through: 70 });
  const names = (await readdir(new URL('migrations/', root))).filter(name => name.endsWith('.sql')).sort().slice(0, 74);
  const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await source(name)])));
  verifyPost73ReleaseSources({ migrationFilenames: names, migrationSourceHashes: Object.fromEntries(names.map(name => [name, sha(sources[name])])) });
  try {
    for (const filename of names.slice(70)) value.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;
      ${sources[filename]}
      insert into supabase_migrations.schema_migrations(version,name,statements)values(${quote(filename.slice(0, 14))},${quote(filename.slice(15, -4))},array[${quote(sources[filename])}]);commit;`);
    value.queryAsBootstrap(`grant usage on schema public,auth,extensions to anon,authenticated,service_role;
      create or replace function auth.uid()returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
      create role supabase_auth_admin nologin nosuperuser nocreaterole nobypassrls;
      grant usage on schema auth to supabase_auth_admin;
      alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;
      alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
      grant select,insert,update,delete,truncate,references,trigger,maintain on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to postgres;`);
    return value;
  } catch (error) { value.close(); throw error; }
}
const catalogRow = sql => `select row_to_json(proof) from(${sql.trim().replace(/;$/, '')})proof;`;
const pending = new Set();
const asyncQuery = sql => {
  const promise = fixture.queryAsBootstrapAsync(`set role postgres;set statement_timeout='15s';set search_path=public,extensions;${sql}`);
  pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
};
async function waitFor(sql) {
  for (let attempt = 0; attempt < 100; attempt++) {
    // Monitoring another fixture backend is a bootstrap diagnostic, not an
    // application privilege. pg_stat_activity hides this from ordinary roles.
    if (JSON.parse(bootstrap(sql))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Owned fixture did not reach the explicit lock barrier.');
}
async function heldProfile({ target = context.target, seconds = 1.5, change = '' } = {}) {
  const name = `profile-holder-${randomUUID()}`;
  const running = asyncQuery(`set application_name='${name}';begin;select 1 from public.profiles where user_id='${target}' for update;${change}select pg_sleep(${seconds});commit;`);
  try { await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'));`); }
  catch (error) { await running; throw error; }
  return { running, name };
}
before(async () => {
  migration = await source(migrationName);
  preflightSql = await readFile(new URL('./verify-admin-profile-name-preflight.sql', import.meta.url), 'utf8');
  fixture = await fresh74();
  context = seed(); historicalProfile = rowsBefore(); frozenBoundary = authorityBoundary();
  assert.ok(Object.values(one(`begin read only;${catalogRow(preflightSql)}rollback;`)).every(value => value === true), 'Exact74 populated/unanalysed preflight must pass.');
  migrationCost = one(`begin;do $$begin perform set_config('fixture.migration_started_at',clock_timestamp()::text,true);end$$;
    ${migration}
    insert into supabase_migrations.schema_migrations(version,name,statements)values('${migrationName.slice(0, 14)}','${migrationName.slice(15, -4)}',array[${quote(migration)}]);
    select jsonb_build_object('elapsedMs',extract(epoch from(clock_timestamp()-current_setting('fixture.migration_started_at')::timestamptz))*1000,
      'profileLock',(select jsonb_agg(mode order by mode)from pg_locks where pid=pg_backend_pid() and relation='public.profiles'::regclass and granted),
      'auditLock',(select jsonb_agg(mode order by mode)from pg_locks where pid=pg_backend_pid() and relation='private.site_admin_audit'::regclass and granted));commit;`);
  function rowsBefore() { return { target: context.target, row: profile() }; }
});
beforeEach(() => { context = seed(); context.version = version(); });
after(async () => { await Promise.allSettled([...pending]); fixture?.close(); });

test('exact74 preflight, non-superuser migration and IDs-only backfill preserve profile/Auth/guard boundaries', () => {
  assert.deepEqual(profile(historicalProfile.target), historicalProfile.row);
  assert.deepEqual(authorityBoundary(), frozenBoundary);
  assert.equal(one("select to_jsonb(rolsuper)from pg_roles where rolname='postgres';"), false);
  assert.equal(one('select to_jsonb(count(*)) from public.profiles p left join private.site_admin_profile_name_versions v using(user_id) where v.user_id is null;'), 0);
  assert.ok(migrationCost.elapsedMs < 30000); assert.ok(migrationCost.profileLock.includes('ExclusiveLock')); assert.ok(migrationCost.auditLock.includes('AccessExclusiveLock'));
  assert.doesNotMatch(migration, /alter\s+(?:table\s+auth\.|role\s)|grant\s+[^;]*\bon\s+auth\.|update\s+public\.profiles\s+set\s+(?!name=)/i);
});

test('private sidecar/trigger/helpers and both public RPCs expose only canonical authenticated entry points', () => {
  for (const role of ['anon', 'service_role']) for (const call of [read(), write()]) query(`set role ${role};${denied(call, '42501')}`);
  for (const role of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
    query(`set role ${role};${denied('select * from private.site_admin_profile_name_versions;', '42501')}`);
    for (const call of ['select private.sync_site_admin_profile_name_version();', "select private.site_admin_profile_name_valid('Name');", `select * from private.site_admin_profile_name_snapshot('${context.actor}','${context.session}','${context.target}',true);`])
      query(`set role ${role};${denied(call, '42501')}`);
  }
  assert.equal(one("select to_jsonb(relrowsecurity)from pg_class where oid='private.site_admin_profile_name_versions'::regclass;"), true);
  assert.equal(one(`select to_jsonb(bool_and(prosecdef and proconfig @> array['search_path=""'])) from pg_proc where oid in('${readSignature}'::regprocedure,'${writeSignature}'::regprocedure);`), true);
});

test('read/write deny wrong identity, native session, Origin, JWT spoofing, canonical permissions and MFA', () => {
  for (const call of [read(), write()]) {
    for (const [options, state] of [[{ session: randomUUID() }, 'PT401'], [{ actor: context.target }, 'PT401'], [{ origin: 'https://attacker.invalid' }, 'PT403'], [{ aal: 'aal1' }, 'PT403'], [{ claims: { role: 'service_role' } }, 'PT401']]) query(asActor(denied(call, state), options));
  }
  const memberSession = randomUUID(); query(`insert into auth.sessions(id,user_id,aal)values('${memberSession}','${context.target}','aal2');`);
  for (const call of [read(context.actor, context.target), write({ actor: context.target, target: context.actor })])
    query(asActor(denied(call, 'PT403'), { actor: context.target, session: memberSession, claims: { user_metadata: { site_admin: true }, app_metadata: { role: 'site_admin' } } }));
  for (const permission of ['users.read', 'users.manage']) for (const call of [read(), write()]) query(`begin;delete from private.site_role_permissions where permission_key='${permission}';${asActor(denied(call))}rollback;`);
  for (const change of ["update auth.sessions set aal='aal1'", 'update auth.sessions set factor_id=null', "update auth.mfa_factors set status='unverified'"])
    query(`begin;${change} where ${change.includes('factors') ? `id='${context.factor}'` : `id='${context.session}'`};${asActor(denied(write()))}rollback;`);
  query(asActor(denied(write(), 'PT403'), { age: 601 }));
  assert.equal(one(asActor(read(), { age: 601 })).profile.state, 'editable');
});

test('complete exact read preserves microsecond timestamp; unavailable responses never expose truncated legacy names', () => {
  const result = one(asActor(read()));
  assert.deepEqual(Object.keys(result).sort(), ['actorId', 'observedAt', 'profile', 'schemaVersion', 'targetUserId']);
  assert.deepEqual(result.profile, { state: 'editable', reason: null, name: 'Original Member', version: context.version, updatedAt: '2026-01-01T00:00:00.654321+00:00' });
  for (const [setup, reason] of [
    [`update public.profiles set name=repeat('x',121) where user_id='${context.target}';`, 'unsupported_legacy_name'],
    [`delete from private.site_admin_profile_name_versions where user_id='${context.target}';`, 'missing_version'],
    [`delete from public.profiles where user_id='${context.target}';`, 'missing_profile'],
    [`delete from auth.users where id='${context.target}';`, 'target_unavailable'],
    [`update auth.users set banned_until=now()+interval '1 hour' where id='${context.target}';`, 'target_unavailable'],
  ]) assert.deepEqual(one(`begin;${setup}${asActor(read())}rollback;`).profile, { state: 'unavailable', reason, name: null, version: null, updatedAt: null });
  assert.equal(one(asActor(read(context.actor))).profile.reason, 'self_action_forbidden');
});

test('Unicode validation is exact in code points, bytes, edge whitespace and forbidden controls', () => {
  const valid = ['A', 'Zoë', '李 小龍', '😀'.repeat(120), 'e\u0301', 'A\u00a0B', 'A\u200bB'];
  const invalid = ['', 'x'.repeat(121), '😀'.repeat(121), ' Name', 'Name ', ' Name ', 'A\nB', 'A\u007fB', 'A\u009fB', 'A\u2028B', 'A\u2029B'];
  const edge = [9, 10, 11, 12, 13, 32, 160, 5760, ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288, 65279];
  for (const cp of edge) invalid.push(String.fromCodePoint(cp) + 'N', 'N' + String.fromCodePoint(cp), String.fromCodePoint(cp));
  const all = [...valid.map(name => [name, true]), ...invalid.map(name => [name, false])];
  const output = parsed(all.map(([name]) => `select to_jsonb(private.site_admin_profile_name_valid(${quote(name)}));`).join('\n'));
  assert.deepEqual(output, all.map(([, expected]) => expected));
  const result = one(asActor(write({ name: valid[3] }))); assert.equal(result.ok, true); assert.equal(profile().name, valid[3]);
  query(asActor(denied(write({ name: '😀'.repeat(121) }), '22023', 'admin_invalid_input')));
  assert.equal(one(asActor(write({ name: '\u00a0Name' }))).error, 'invalid_input');
});

test('name-only correction atomically rotates UUID, preserves unrelated fields, audits metadata and never persists raw names', () => {
  const before = profile(); const operation = randomUUID(); const correlation = randomUUID();
  const name = 'SENSITIVE NAME SENTINEL'; const result = one(asActor(write({ operation, correlation, name })));
  assert.deepEqual(Object.keys(result).sort(), ['actorId', 'changed', 'correlationId', 'ok', 'operationId', 'schemaVersion', 'targetUserId', 'version']);
  assert.equal(result.changed, true); assert.equal(result.ok, true); assert.notEqual(result.version, context.version);
  const after = profile(); assert.equal(after.name, name); assert.notEqual(after.updated_at, before.updated_at);
  assert.deepEqual({ ...after, name: before.name, updated_at: before.updated_at }, before);
  const audit = one(`select private.site_admin_audit_payload(sequence_id) from private.site_admin_audit where actor_id='${context.actor}';`);
  assert.equal(audit.action, 'users.display_name.correct'); assert.equal(audit.beforeProfileNameVersion, context.version);
  assert.equal(audit.afterProfileNameVersion, result.version); assert.equal(audit.profileNameChanged, true);
  assert.equal(one(`select to_jsonb(bool_or(to_jsonb(a)::text like '%SENSITIVE NAME SENTINEL%')) from private.site_admin_audit a;`), false);
  assert.equal(one(`select to_jsonb(bool_or(to_jsonb(a)::text like '%SENSITIVE NAME SENTINEL%')) from private.site_admin_role_requests a;`), false);
});

test('fresh-token no-op preserves UUID/timestamp, while stale same-name token remains a conflict', () => {
  const before = rows();
  assert.equal(one(asActor(write({ name: 'Original Member' }))).changed, false);
  assert.deepEqual(rows(), before); assert.equal(auditCount(), 1);
  query(`update public.profiles set name='Other' where user_id='${context.target}';update public.profiles set name='Original Member' where user_id='${context.target}';`);
  assert.equal(one(asActor(write({ name: 'Original Member' }))).error, 'revision_conflict');
  assert.notEqual(version(), context.version);
});

test('member name ABA rotates despite identical transaction timestamp; avatar/other-field changes never rotate or get overwritten', () => {
  const outputs = parsed(`begin;update public.profiles set name='B' where user_id='${context.target}';select jsonb_build_array(updated_at,v.version) from public.profiles p join private.site_admin_profile_name_versions v using(user_id) where user_id='${context.target}';
    update public.profiles set name='Original Member' where user_id='${context.target}';select jsonb_build_array(updated_at,v.version) from public.profiles p join private.site_admin_profile_name_versions v using(user_id) where user_id='${context.target}';commit;`);
  assert.equal(outputs[0][0], outputs[1][0]); assert.notEqual(outputs[0][1], outputs[1][1]);
  context.version = version();
  query(`update public.profiles set name=name,email='new@example.invalid',time_zone='America/Los_Angeles' where user_id='${context.target}';`);
  assert.equal(version(), context.version);
  const before = profile();
  assert.equal(one(asActor(write())).ok, true);
  assert.equal(profile().email, before.email); assert.equal(profile().time_zone, before.time_zone);
  // Trusted avatar-only and avatar+name commits execute the same table trigger.
  const current = version();
  query(`update public.profiles set avatar_url='' where user_id='${context.target}';`);
  assert.equal(version(), current);
  query(`update public.profiles set avatar_url='',name='Combined Text And Avatar' where user_id='${context.target}';`);
  assert.notEqual(version(), current);
});

test('eligibility rejects self, missing/unsupported profile and live deletion intake without altering unrelated state', () => {
  assert.equal(one(asActor(write({ target: context.actor }))).error, 'self_action_forbidden');
  for (const [setup, error] of [
    [`delete from public.profiles where user_id='${context.target}';`, 'profile_unavailable'],
    [`delete from private.site_admin_profile_name_versions where user_id='${context.target}';`, 'profile_unavailable'],
    [`update public.profiles set name=repeat('x',121) where user_id='${context.target}';`, 'unsupported_legacy_name'],
    [`update auth.users set email_confirmed_at=null where id='${context.target}';`, 'target_unavailable'],
    [`update auth.users set is_anonymous=true where id='${context.target}';`, 'target_unavailable'],
    [`insert into public.account_lifecycle_requests(user_id,request_type)values('${context.target}','account_deletion');`, 'target_unavailable'],
  ]) assert.equal(one(`begin;${setup}${asActor(write())}rollback;`).error, error);
});

test('exact replay is historical metadata after target edits or deletion but requires CURRENT actor authority and fresh MFA', () => {
  const operation = randomUUID(); const correlation = randomUUID(); const sql = write({ operation, correlation });
  const result = one(asActor(sql));
  query(`update public.profiles set name='Later Member Choice' where user_id='${context.target}';`);
  assert.deepEqual(one(asActor(sql)), result); assert.equal(profile().name, 'Later Member Choice');
  query(`delete from auth.users where id='${context.target}';`);
  assert.deepEqual(one(asActor(sql)), result); assert.equal(auditCount(), 1);
  assert.equal(one(asActor(read())).profile.reason, 'target_unavailable');
  query(asActor(denied(sql, 'PT403'), { age: 601 }));
  query(`delete from auth.sessions where id='${context.session}';`);
  query(asActor(denied(sql, 'PT401')));
});

test('operation reuse is domain/request-bound, conflicts across writer kinds and never replays a different input', () => {
  const operation = randomUUID(); const correlation = randomUUID(); const sql = write({ operation, correlation });
  one(asActor(sql));
  for (const changes of [{ name: 'Different' }, { version: randomUUID() }, { target: context.actor }, { correlation: randomUUID() }])
    query(asActor(denied(write({ operation, correlation, ...changes }), '22023', 'admin_idempotency_conflict')));
  query(asActor(denied(`select public.site_admin_assign_role('${context.actor}','${context.target}','member',0,'${operation}','${correlation}','approved_role_change');`, '22023', 'admin_idempotency_conflict')));
  const acceptance = randomUUID();
  query(`insert into private.early_access_acceptance_operations(actor_id,operation_id,signature,result)values('${context.actor}','${acceptance}',repeat('a',64),'{}');`);
  query(asActor(denied(write({ operation: acceptance }), '22023', 'admin_idempotency_conflict')));
  assert.equal(auditCount(), 1);
});

test('every new audit NULL/mismatched metadata branch rejects, and old branches cannot acquire name metadata', () => {
  const columns = ['actor_id', 'target_user_id', 'action', 'permission', 'reason_code', 'request_id', 'correlation_id', 'environment', 'outcome', 'error_code', 'before_profile_name_version', 'after_profile_name_version', 'profile_name_changed'];
  const valid = [context.actor, context.target, 'users.display_name.correct', 'users.manage', 'profile_name_correction', randomUUID(), randomUUID(), 'production', 'success', null, context.version, randomUUID(), true];
  const insert = values => `insert into private.site_admin_audit(${columns})values(${values.map(quote)});`;
  for (const index of [0, 1, 10, 11, 12]) { const values = [...valid]; values[index] = null; query(denied(insert(values), '23514')); }
  const selfSuccess = [...valid]; selfSuccess[1] = context.actor; query(denied(insert(selfSuccess), '23514'));
  for (const values of [[...valid.slice(0, 12), false], [...valid.slice(0, 11), context.version, true], [...valid.slice(0, 8), 'failure', 'revision_conflict', context.version, null, null], [...valid.slice(0, 8), 'failure', null, null, null, null]])
    query(denied(insert(values), '23514'));
  query(`begin;${insert(valid)}rollback;`);
  query(`begin;${insert([...valid.slice(0, 8), 'failure', 'revision_conflict', null, null, null])}rollback;`);
  query(denied(`insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,environment,outcome,before_profile_name_version)
    values('${context.actor}','${context.target}','roles.assign','roles.manage','approved_role_change',gen_random_uuid(),gen_random_uuid(),'production','success','${context.version}');`, '23514'));
});

test('audit and receipt insertion failures atomically roll back the profile, UUID and all evidence', () => {
  for (const table of ['site_admin_audit', 'site_admin_role_requests']) {
    const before = rows();
    query(`create function private.fixture_fail_name_evidence()returns trigger language plpgsql as $$begin raise exception 'fixture_evidence_unavailable';end$$;
      create trigger fixture_fail_name_evidence before insert on private.${table} for each row execute function private.fixture_fail_name_evidence();`);
    query(asActor(denied(write(), 'P0001', 'fixture_evidence_unavailable')));
    assert.deepEqual(rows(), before); assert.equal(auditCount(), 0);
    query(`drop trigger fixture_fail_name_evidence on private.${table};drop function private.fixture_fail_name_evidence();`);
  }
});

test('combined actor quota is 20/minute and 100/hour, exact replay bypasses quota but rejection never grows the ledger', () => {
  const operation = randomUUID(); const correlation = randomUUID(); const sql = write({ operation, correlation, name: 'Original Member' });
  const result = one(asActor(sql));
  for (let index = 1; index < 20; index++) assert.equal(one(asActor(write({ name: 'Original Member' }))).ok, true);
  const before = auditCount();
  for (let index = 0; index < 3; index++) assert.equal(one(asActor(write())).error, 'rate_limited');
  assert.equal(auditCount(), before); assert.deepEqual(one(asActor(sql)), result);
  const another = seed();
  query(`insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,environment,outcome,occurred_at)
    select '${another.actor}','${another.target}','roles.assign','roles.manage','approved_role_change',gen_random_uuid(),gen_random_uuid(),'production','success',now()-interval '2 minutes' from generate_series(1,100);`);
  assert.equal(one(asActor(write({ actor: another.actor, target: another.target, version: version(another.target) }), { actor: another.actor, session: another.session })).error, 'rate_limited');
});

test('typed account-history reads include new metadata and old events retain only null added fields', () => {
  one(asActor(write()));
  query(`insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,environment,outcome)
    values('${context.actor}','${context.target}','roles.assign','roles.manage','approved_role_change',gen_random_uuid(),gen_random_uuid(),'production','success');`);
  const result = one(asActor(`select public.site_admin_list_audit('${context.actor}',25,'${context.target}','all','all',null);`));
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(item => item.action), ['roles.assign', 'users.display_name.correct']);
  assert.equal(result.items[0].beforeProfileNameVersion, null); assert.equal(result.items[0].afterProfileNameVersion, null); assert.equal(result.items[0].profileNameChanged, null);
  assert.equal(one(asActor(`select public.site_admin_list_audit('${context.actor}',25,'${context.target}','users.display_name.correct','all',null);`)).items.length, 1);
});

test('concurrent same-operation requests return one identical receipt and one audit; distinct operations CAS conflict', async () => {
  const sql = asActor(write({ operation: randomUUID(), correlation: randomUUID() }));
  const results = (await Promise.all([asyncQuery(sql), asyncQuery(sql)])).map(JSON.parse);
  assert.deepEqual(results[0], results[1]); assert.equal(auditCount(), 1);
  context.version = version();
  const other = (await Promise.all([asyncQuery(asActor(write({ name: 'First' }))), asyncQuery(asActor(write({ name: 'Second' })))] )).map(JSON.parse);
  assert.deepEqual(other.map(result => result.ok).sort(), [false, true]);
  assert.equal(other.find(result => !result.ok).error, 'revision_conflict'); assert.equal(auditCount(), 3);
});

test('member name edit wins while Admin waits; avatar-only edit preserves token and is not overwritten', async () => {
  const memberName = 'Concurrent Member';
  const hold = await heldProfile({ change: `update public.profiles set name='${memberName}' where user_id='${context.target}';` });
  const waiting = asyncQuery(asActor(write()));
  const result = JSON.parse(await waiting); await hold.running;
  assert.equal(result.error, 'revision_conflict'); assert.equal(profile().name, memberName);
  context.version = version();
  const avatar = await heldProfile({ change: `update public.profiles set avatar_url='',email='concurrent@example.invalid' where user_id='${context.target}';` });
  const correction = JSON.parse(await asyncQuery(asActor(write()))); await avatar.running;
  assert.equal(correction.ok, true); assert.equal(profile().avatar_url, ''); assert.equal(profile().email, 'concurrent@example.invalid');
});

for (const event of ['session-delete', 'session-aal', 'recent-mfa', 'permission-revoke', 'deletion-intake']) test(`post-lock current snapshot observes committed ${event} and never applies a stale authorized write`, async () => {
  const before = rows(); const hold = await heldProfile(); const name = `profile-writer-${randomUUID()}`;
  const expected = event === 'session-delete' ? 'PT401' : 'PT403';
  const sql = event === 'deletion-intake' ? write() : denied(write(), expected);
  const waiting = asyncQuery(`set application_name='${name}';${asActor(sql)}`);
  await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event_type='Lock'));`);
  try {
    if (event === 'session-delete') query(`delete from auth.sessions where id='${context.session}';`);
    if (event === 'session-aal') query(`update auth.sessions set aal='aal1' where id='${context.session}';`);
    if (event === 'recent-mfa') query(`update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '11 minutes' where session_id='${context.session}';`);
    if (event === 'permission-revoke') query("delete from private.site_role_permissions where role_key='site_admin' and permission_key='users.manage';");
    if (event === 'deletion-intake') query(asActor(`insert into public.account_lifecycle_requests(user_id,request_type)values('${context.target}','account_deletion');`, { actor: context.target, session: randomUUID() }));
    const output = await waiting; await hold.running;
    if (event === 'deletion-intake') assert.equal(JSON.parse(output).error, 'target_unavailable');
    assert.deepEqual(rows(), before); assert.equal(auditCount(), event === 'deletion-intake' ? 1 : 0);
  } finally {
    await Promise.allSettled([waiting, hold.running]);
    if (event === 'permission-revoke') query("insert into private.site_role_permissions(role_key,permission_key)values('site_admin','users.manage')on conflict do nothing;");
  }
});

test('five-second aggregate lock budget fails closed without mutation or an invented rollback receipt', async () => {
  const before = rows(); const hold = await heldProfile({ seconds: 5.8 });
  const start = Date.now();
  await asyncQuery(asActor(denied(write(), '55P03')));
  const elapsed = Date.now() - start; await hold.running;
  assert.ok(elapsed >= 4500 && elapsed < 5800, `Observed lock wait ${elapsed}ms`);
  assert.deepEqual(rows(), before); assert.equal(auditCount(), 0);
});

test('sidecar deletion fails closed and rolls member text back; deleting and recreating a profile defeats the old token', () => {
  const before = profile();
  query(`begin;delete from private.site_admin_profile_name_versions where user_id='${context.target}';
    ${denied(`update public.profiles set name='Must Roll Back' where user_id='${context.target}';`, '55000', 'admin_profile_version_unavailable')}
    rollback;`);
  assert.deepEqual(profile(), before);
  query(`delete from public.profiles where user_id='${context.target}';insert into public.profiles(user_id,name,email)values('${context.target}','Original Member','member@example.invalid');`);
  assert.notEqual(version(), context.version); assert.equal(one(asActor(write())).error, 'revision_conflict');
});

test('sealed erasure and retained DR quarantine deny reads/writes; terminal cancellation restores eligibility', () => {
  const batch = randomUUID();
  query(`insert into private.retired_community_deletion_batches(id,reason,requested_by,requested_at,execute_after,deadline_at,subject_user_id,t0_source_sha256)
    values('${batch}','account_erasure','synthetic-fixture',now(),now(),now()+interval '24 hours','${context.target}',repeat('a',64));
    update private.retired_community_deletion_batches set sealed=true,source_sha256=repeat('b',64),post_count=0,comment_count=0,like_count=0,object_count=0,credential_count=0 where id='${batch}';`);
  assert.equal(one(asActor(read())).profile.reason, 'target_unavailable'); assert.equal(one(asActor(write())).error, 'target_unavailable');
  query(`insert into private.retired_community_deletion_ledger(batch_id,event_type,actor,event_at)values('${batch}','cancelled','synthetic-fixture',now());`);
  assert.equal(one(asActor(read())).profile.state, 'editable');
  // A separate executed historical batch models restored-account quarantine.
  const restored = randomUUID();
  query(`insert into private.retired_community_deletion_batches(id,reason,requested_by,requested_at,execute_after,deadline_at,subject_user_id,t0_source_sha256)
    values('${restored}','account_erasure','synthetic-fixture',now(),now(),now()+interval '24 hours','${context.target}',repeat('a',64));
    update private.retired_community_deletion_batches set sealed=true,source_sha256=repeat('b',64),post_count=0,comment_count=0,like_count=0,object_count=0,credential_count=0 where id='${restored}';
    insert into private.retired_community_deletion_ledger(batch_id,event_type,actor,event_at)values('${restored}','executed','synthetic-fixture',now());
    insert into private.retired_community_dr_quarantined_users(user_id,source_batch_id,quarantined_at)values('${context.target}','${restored}',now());`);
  assert.equal(one(asActor(read())).profile.reason, 'target_unavailable'); assert.equal(one(asActor(write())).error, 'target_unavailable');
});

test('quota plans use actor+captured-time index ranges with dense old history and generic/custom plans', () => {
  query(`insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,environment,outcome,occurred_at)
    select '${context.actor}','${context.target}','roles.assign','roles.manage','approved_role_change',gen_random_uuid(),gen_random_uuid(),'production','success',now()-interval '2 days' from generate_series(1,10000);
    analyze private.site_admin_audit;`);
  const fragments = [...migration.matchAll(/select count\(\*\) from\(select 1 from private\.site_admin_audit where actor_id=target_expected_actor_id\s+and occurred_at>quota_as_of-interval '(?:1 minute|1 hour)' order by occurred_at desc limit (?:20|100)\) q/g)].map(match => match[0].replace('target_expected_actor_id', '$1').replace('quota_as_of', '$2'));
  assert.equal(fragments.length, 2);
  const nodes = plan => [plan, ...(plan.Plans || []).flatMap(nodes)];
  for (const mode of ['force_custom_plan', 'force_generic_plan']) for (const fragment of fragments) {
    const plan = JSON.parse(query(`set plan_cache_mode='${mode}';prepare quota(uuid,timestamptz)as ${fragment};explain(analyze,buffers,format json)execute quota('${context.actor}',now());`))[0].Plan;
    const scans = nodes(plan).filter(node => /Scan/.test(node['Node Type']));
    assert.equal(scans.length, 1); assert.equal(scans[0]['Index Name'], 'site_admin_audit_actor_time_idx');
    assert.match(scans[0]['Index Cond'], /actor_id.*occurred_at/); assert.equal(scans[0]['Actual Rows'], 0);
    assert.equal(scans[0]['Rows Removed by Filter'] || 0, 0); assert.ok((scans[0]['Shared Hit Blocks'] || 0) <= 10);
  }
  assert.equal(one(asActor(write())).ok, true, 'Old audit history must not consume the current quota.');
});

test('metadata-only final catalog capture uses production owner and canonical deparse context', async t => {
  const capture = await readFile(new URL('./fixtures/admin-profile-name-catalog.sql', import.meta.url), 'utf8');
  const metadata = one(capture);
  assert.equal(metadata.functions.length, 12);
  assert.ok(metadata.functions.every(item => item.owner === 'postgres' && /^[a-f0-9]{64}$/.test(item.definitionSha256)));
  assert.equal(metadata.sidecar.columns.length, 2); assert.equal(metadata.audit.columns.length, 20);
  t.diagnostic(`ADMIN_PROFILE_NAME_CATALOG ${JSON.stringify(metadata)}`);
  const oldFiles = ['verify-production-account-request-inbox.sql', 'verify-production-admin-cleanup-health.sql',
    'verify-production-original77.sql', 'verify-production-repeatable-challenge.sql'];
  const legacy = {};
  for (const file of oldFiles) {
    const previous = await readFile(new URL(file, import.meta.url), 'utf8');
    legacy[file] = one(`begin read only;${catalogRow(previous)}rollback;`);
    if (file === 'verify-production-repeatable-challenge.sql') {
      const prefix = previous.slice(0, previous.indexOf('), expected_contracts(contract_name,definition_hash)')) + ')';
      legacy.repeatableDocumentHashes = one(`begin read only;${prefix}
        select jsonb_object_agg(contract_name,encode(sha256(convert_to(document::text,'UTF8')),'hex'))from contract_documents;rollback;`);
    }
  }
  t.diagnostic(`ADMIN_PROFILE_NAME_LEGACY_CATALOG ${JSON.stringify(legacy)}`);
});

test('registered pgTAP profile-name boundary executes all 36 assertions', async () => {
  const body = await readFile(new URL('tests/database/350_site_admin_profile_name.sql', root), 'utf8');
  const result = bootstrap(body);
  assert.match(result, /^1\.\.36$/m); assert.doesNotMatch(result, /^(not ok|Bail out!|#)/m);
  assert.equal([...result.matchAll(/^ok \d+\b/gm)].length, 36);
});

test('migration EXCLUSIVE lock closes the reproduced SRE/member-FOR-UPDATE/backfill-FK deadlock', async () => {
  const originalFixture = fixture;
  fixture = await fresh74();
  try {
    const user = randomUUID();
    query(`insert into auth.users(id,email,email_confirmed_at)values('${user}','locking@example.invalid',now());insert into public.profiles(user_id,name)values('${user}','Locking Member');`);
    const prefix = migration.slice(0, migration.indexOf('create function private.sync_site_admin_profile_name_version'));
    const reproduce = prefix.replace('lock table public.profiles in exclusive mode;', 'lock table public.profiles in share row exclusive mode;')
      .replace('lock table private.site_admin_audit in access exclusive mode;', 'lock table private.site_admin_audit in access exclusive mode;select pg_sleep(1.5);');
    const migrator = `old-sre-${randomUUID()}`; const writer = `old-writer-${randomUUID()}`;
    const oldMigration = asyncQuery(`set application_name='${migrator}';begin;${reproduce}rollback;`);
    await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${migrator}' and wait_event='PgSleep'));`);
    const oldWriter = asyncQuery(`set application_name='${writer}';begin;select 1 from public.profiles where user_id='${user}'for update;
      update public.profiles set name=name where user_id='${user}';commit;`);
    const oldResults = await Promise.allSettled([oldMigration, oldWriter]);
    assert.ok(oldResults.some(result => result.status === 'rejected' && /deadlock detected/.test(String(result.reason))), 'Old SRE pattern must reproduce the real lock cycle.');
    assert.equal(one("select to_jsonb(to_regclass('private.site_admin_profile_name_versions')is null);"), true);
    const heldReader = `pre-migration-reader-${randomUUID()}`;
    const holder = asyncQuery(`set application_name='${heldReader}';begin;select 1 from public.profiles where user_id='${user}'for update;select pg_sleep(5.8);rollback;`);
    try {
      await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${heldReader}'and wait_event='PgSleep'));`);
      await assert.rejects(asyncQuery(`begin;${migration}commit;`), /lock timeout/);
      assert.equal(one("select to_jsonb(to_regclass('private.site_admin_profile_name_versions')is null);"), true);
      assert.equal(one("select to_jsonb(count(*))from pg_attribute where attrelid='private.site_admin_audit'::regclass and attname='profile_name_changed';"), 0);
    } finally { await holder; }
    const newMigrator = `new-exclusive-${randomUUID()}`; const newWriter = `new-writer-${randomUUID()}`;
    const safe = migration.replace('lock table private.site_admin_audit in access exclusive mode;', 'lock table private.site_admin_audit in access exclusive mode;select pg_sleep(0.6);');
    const newMigration = asyncQuery(`set application_name='${newMigrator}';begin;${safe}commit;`);
    await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${newMigrator}' and wait_event='PgSleep'));`);
    const member = asyncQuery(`set application_name='${newWriter}';begin;select 1 from public.profiles where user_id='${user}'for update;update public.profiles set name=name where user_id='${user}';commit;`);
    await Promise.all([newMigration, member]);
    assert.equal(one('select to_jsonb(count(*))from private.site_admin_profile_name_versions;'), 1);
  } finally { await Promise.allSettled([...pending]); fixture.close(); fixture = originalFixture; }
});

test('target Auth health change sharing lifecycle order commits after an already authorized correction, not before its snapshot', async () => {
  const hold = await heldProfile(); const writerName = `ordered-name-${randomUUID()}`;
  const writer = asyncQuery(`set application_name='${writerName}';${asActor(write())}`);
  await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${writerName}'and wait_event_type='Lock'));`);
  const healthName = `ordered-health-${randomUUID()}`;
  const health = asyncQuery(`set application_name='${healthName}';update auth.users set banned_until=clock_timestamp()+interval '1 hour'where id='${context.target}';`);
  try {
    await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${healthName}'and wait_event_type='Lock'));`);
    assert.equal(JSON.parse(await writer).ok, true); await Promise.all([hold.running, health]);
    assert.equal(profile().name, 'Corrected Member'); assert.equal(one(asActor(read())).profile.reason, 'target_unavailable');
    assert.equal(auditCount(), 1);
  } finally { await Promise.allSettled([hold.running, writer, health]); }
});

test('exact100000 profile/audit envelope backfills without rewriting profiles;100001 guards and preflight metadata fail closed', async t => {
  const originalFixture = fixture;
  fixture = await fresh74();
  try {
    const preflight = () => one(`begin read only;${catalogRow(preflightSql)}rollback;`);
    assert.ok(Object.values(preflight()).every(value => value === true));
    query("insert into auth.users(id,email,email_confirmed_at)select md5('profile-cap:'||n)::uuid,'synthetic-'||n||'@example.invalid',now()from generate_series(1,100001)n;");
    query("insert into public.profiles(user_id,name,updated_at)select md5('profile-cap:'||n)::uuid,'Boundary Member','2026-01-01T00:00:00.123456Z'from generate_series(1,100001)n;");
    await assert.rejects(asyncQuery(`begin;${migration}commit;`), /admin_profile_migration_size_limit/);
    assert.equal(one("select to_jsonb(to_regclass('private.site_admin_profile_name_versions')is null);"), true);
    query("delete from public.profiles where user_id=md5('profile-cap:100001')::uuid;");
    const auditRows = amount => `insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,environment,outcome,occurred_at)
      select '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','roles.assign','roles.manage','approved_role_change',gen_random_uuid(),gen_random_uuid(),'production','success','2026-01-01'from generate_series(1,${amount});`;
    await assert.rejects(asyncQuery(`begin;${auditRows(100001)}${migration}commit;`), /admin_profile_migration_size_limit/);
    assert.equal(one('select to_jsonb(count(*))from private.site_admin_audit;'), 0);
    query(auditRows(100000));
    const populatedPreflight = preflight();
    t.diagnostic(`ADMIN_PROFILE_NAME_POPULATED_PREFLIGHT ${JSON.stringify(populatedPreflight)} ${query("select jsonb_agg(jsonb_build_object('table',oid::regclass::text,'heap',pg_relation_size(oid),'total',pg_total_relation_size(oid),'estimate',reltuples))from pg_class where oid in('public.profiles'::regclass,'private.site_admin_audit'::regclass);")}`);
    assert.equal(populatedPreflight.existing_tables_size_within_bound_ok, false, 'The rolled-back synthetic audit allocation plus live rows must trip the physical guard.');
    assert.ok(Object.entries(populatedPreflight).every(([key, value]) => key === 'existing_tables_size_within_bound_ok' || value === true));
    // Test-only compaction of this newly owned disposable cluster removes the
    // deliberate failed-transaction bloat. Never a hosted preflight or repair.
    query('vacuum full private.site_admin_audit;');
    assert.ok(Object.values(preflight()).every(value => value === true));
    // These catalog mutations are restricted to the owned disposable cluster.
    bootstrap("update pg_class set reltuples=-1 where oid in('public.profiles'::regclass,'private.site_admin_audit'::regclass);");
    assert.equal(preflight().existing_tables_estimate_within_bound_ok, true);
    bootstrap("update pg_class set reltuples=100001 where oid='public.profiles'::regclass;");
    assert.equal(preflight().existing_tables_estimate_within_bound_ok, false);
    bootstrap("update pg_class set reltuples=-1 where oid='public.profiles'::regclass;");
    bootstrap("update pg_index set indisvalid=false where indexrelid='public.site_admin_profiles_name_prefix_idx'::regclass;");
    assert.equal(preflight().existing_indexes_valid_ok, false);
    bootstrap("update pg_index set indisvalid=true where indexrelid='public.site_admin_profiles_name_prefix_idx'::regclass;");
    query("create function private.fixture_profile_name_collision()returns void language sql as $$select$$;");
    assert.equal(preflight().new_objects_absent_ok, false); query('drop function private.fixture_profile_name_collision();');
    query("update supabase_migrations.schema_migrations set name='fixture_wrong'where version='20261013055744';");
    assert.equal(preflight().exact_pre_migration_history_ok, false);
    query("update supabase_migrations.schema_migrations set name='site_admin_cleanup_health'where version='20261013055744';");
    for (const [relation, mode, expected] of [['public.profiles', 'access share', true], ['public.profiles', 'row share', false], ['private.site_admin_audit', 'access share', false]]) {
      const application = `preflight-lock-${randomUUID()}`;
      const blocker = asyncQuery(`set application_name='${application}';begin;lock table ${relation} in ${mode} mode;select pg_sleep(0.5);rollback;`);
      try {
        await waitFor(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name='${application}'and wait_event='PgSleep'));`);
        assert.equal(preflight().no_conflicting_table_locks_ok, expected);
      } finally { await blocker; }
    }
    const before = one("select to_jsonb(encode(sha256(convert_to(string_agg(to_jsonb(p)::text,','order by user_id),'UTF8')),'hex'))from public.profiles p;");
    const cost = one(`begin;do $$begin perform set_config('fixture.migration_started_at',clock_timestamp()::text,true);end$$;${migration}
      select jsonb_build_object('profileRows',(select count(*)from public.profiles),'auditRows',(select count(*)from private.site_admin_audit),
        'elapsedMs',extract(epoch from(clock_timestamp()-current_setting('fixture.migration_started_at')::timestamptz))*1000,
        'sidecarBytes',pg_total_relation_size('private.site_admin_profile_name_versions'),'profilesBytes',pg_total_relation_size('public.profiles'),
        'auditBytes',pg_total_relation_size('private.site_admin_audit'),'profileLock',(select jsonb_agg(mode order by mode)from pg_locks where pid=pg_backend_pid()and relation='public.profiles'::regclass and granted));commit;`);
    assert.equal(cost.profileRows, 100000); assert.equal(cost.auditRows, 100000); assert.ok(cost.elapsedMs < 30000);
    assert.ok(cost.profileLock.includes('ExclusiveLock'));
    assert.equal(one("select to_jsonb(encode(sha256(convert_to(string_agg(to_jsonb(p)::text,','order by user_id),'UTF8')),'hex'))from public.profiles p;"), before);
    assert.equal(one('select to_jsonb(count(*))from public.profiles p join private.site_admin_profile_name_versions v using(user_id);'), 100000);
    assert.equal(one('select to_jsonb(count(distinct version))from private.site_admin_profile_name_versions;'), 100000);
    t.diagnostic(`ADMIN_PROFILE_NAME_MIGRATION_COST ${JSON.stringify(cost)}`);
  } finally { await Promise.allSettled([...pending]); fixture.close(); fixture = originalFixture; }
});

test('retained erasure eligibility records sparse/dense existing-table scan costs without an unreviewed index', t => {
  const predicate = migration.match(/exists\(select 1 from private\.retired_community_deletion_batches b where b\.reason='account_erasure'[\s\S]*?l\.event_type in \('cancelled','executed'\)\)\)/)?.[0];
  assert.ok(predicate, 'Extract the exact production eligibility predicate, not an optimized substitute.');
  const inspectPlan = sql => {
    const plan = JSON.parse(query(sql))[0]; assert.ok(plan?.Plan);
    return plan;
  };
  const costs = [];
  for (const density of ['sparse', 'dense-terminal']) {
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      const plan = inspectPlan(`begin;
        insert into private.retired_community_deletion_batches(id,reason,requested_by,requested_at,execute_after,deadline_at,subject_user_id,t0_source_sha256)
          select md5('erasure-cost:'||n)::uuid,'account_erasure','synthetic-fixture',now(),now(),now()+interval '24 hours',
            ${density === 'sparse' ? "md5('unrelated-subject:'||n)::uuid" : quote(context.target)},repeat('a',64)from generate_series(1,10000)n;
        update private.retired_community_deletion_batches set sealed=true,source_sha256=repeat('b',64),post_count=0,comment_count=0,like_count=0,object_count=0,credential_count=0
          where requested_by='synthetic-fixture'and not sealed;
        ${density === 'dense-terminal' ? "insert into private.retired_community_deletion_ledger(batch_id,event_type,actor,event_at)select md5('erasure-cost:'||n)::uuid,'cancelled','synthetic-fixture',now()from generate_series(1,10000)n;" : ''}
        analyze private.retired_community_deletion_batches;analyze private.retired_community_deletion_ledger;
        set local plan_cache_mode=${mode};prepare fixture_erasure(uuid)as select ${predicate.replaceAll('target_user', '$1')};
        explain(analyze,buffers,format json)execute fixture_erasure('${context.target}');rollback;`);
      const nodes = []; const visit = node => { nodes.push(node); for (const child of node.Plans || []) visit(child); }; visit(plan.Plan);
      const batch = nodes.find(node => node['Relation Name'] === 'retired_community_deletion_batches');
      assert.ok(batch); assert.equal(batch['Node Type'], 'Seq Scan');
      assert.ok((batch['Actual Rows'] + (batch['Rows Removed by Filter'] || 0)) >= 10000, 'Existing retained batches require a measured scan; do not claim a bounded index lookup.');
      costs.push({ density, mode, executionMs: plan['Execution Time'], batchRows: batch['Actual Rows'], removed: batch['Rows Removed by Filter'] || 0,
        sharedHits: plan.Plan['Shared Hit Blocks'] || 0, sharedReads: plan.Plan['Shared Read Blocks'] || 0, batchLoops: batch['Actual Loops'] });
    }
  }
  t.diagnostic(`ADMIN_PROFILE_NAME_ERASURE_COST ${JSON.stringify(costs)}`);
});

test('exact75 metadata-only catalog passes and independent catalog drifts fail closed', async t => {
  const sql = await readFile(new URL('./verify-production-admin-profile-name.sql', import.meta.url), 'utf8');
  const positive = one(`begin read only;${catalogRow(sql)}rollback;`);
  assert.equal(Object.keys(positive).length, 13); assert.ok(Object.values(positive).every(value => value === true), JSON.stringify(positive));
  const cases = [
    ['wrong migration name', "update supabase_migrations.schema_migrations set name='wrong'where version='20261013091749';", 'exact_migration_history_ok'],
    ['missing migration', "delete from supabase_migrations.schema_migrations where version='20261013091749';", 'exact_migration_history_ok'],
    ['extra migration', "insert into supabase_migrations.schema_migrations(version,name,statements)values('20990101000000','wrong','{}');", 'exact_migration_history_ok'],
    ['body', "create or replace function private.site_admin_profile_name_valid(target_name text)returns boolean language sql immutable set search_path=''as $$select true$$;", 'functions_catalog_ok'],
    ['immutable body', "create or replace function private.site_admin_immutable()returns trigger language plpgsql set search_path=''as $$begin return new;end$$;", 'functions_catalog_ok'],
    ['public grant', `grant execute on function ${writeSignature}to public;`, 'functions_catalog_ok'],
    ['service grant', `grant execute on function ${readSignature}to service_role;`, 'functions_catalog_ok'],
    ['native grant missing', `revoke execute on function ${readSignature}from authenticated;`, 'functions_catalog_ok'],
    ['search path', `alter function ${readSignature}set search_path=public;`, 'functions_catalog_ok'],
    ['lock timeout', `alter function ${writeSignature}set lock_timeout='6s';`, 'functions_catalog_ok'],
    ['security definer', `alter function ${writeSignature}security invoker;`, 'functions_catalog_ok'],
    ['volatility', `alter function ${readSignature}stable;`, 'functions_catalog_ok'],
    ['cost', `alter function ${readSignature}cost 1;`, 'functions_catalog_ok'],
    ['overload', "create function private.site_admin_profile_name_valid(integer)returns boolean language sql as $$select true$$;", 'functions_catalog_ok'],
    ['unexpected routine', "create function private.fixture_profile_name_extra()returns boolean language sql as $$select true$$;", 'functions_catalog_ok'],
    ['sidecar column', 'alter table private.site_admin_profile_name_versions add column unexpected integer;', 'sidecar_structure_ok'],
    ['sidecar default', 'alter table private.site_admin_profile_name_versions alter column version drop default;', 'sidecar_structure_ok'],
    ['sidecar RLS', 'alter table private.site_admin_profile_name_versions disable row level security;', 'sidecar_structure_ok'],
    ['sidecar policy', 'create policy fixture_any on private.site_admin_profile_name_versions using(true);', 'sidecar_structure_ok'],
    ['sidecar table ACL', 'grant select on private.site_admin_profile_name_versions to authenticated;', 'sidecar_privileges_ok'],
    ['sidecar column ACL', 'grant select(version)on private.site_admin_profile_name_versions to anon;', 'sidecar_privileges_ok'],
    ['sidecar FK', 'alter table private.site_admin_profile_name_versions drop constraint site_admin_profile_name_versions_user_id_fkey;', 'sidecar_constraints_ok'],
    ['sidecar index invalid', "update pg_index set indisvalid=false where indexrelid='private.site_admin_profile_name_versions_pkey'::regclass;", 'sidecar_indexes_ok'],
    ['sidecar extra index', 'create index fixture_version_extra on private.site_admin_profile_name_versions(version);', 'sidecar_indexes_ok'],
    ['profile trigger disabled', 'alter table public.profiles disable trigger sync_site_admin_profile_name_version;', 'profile_version_trigger_ok'],
    ['audit column', 'alter table private.site_admin_audit add column unexpected integer;', 'audit_structure_ok'],
    ['audit ACL', 'grant select on private.site_admin_audit to authenticated;', 'audit_privileges_ok'],
    ['audit check', 'alter table private.site_admin_audit drop constraint site_admin_audit_typed_action_check;alter table private.site_admin_audit add constraint site_admin_audit_typed_action_check check(true);', 'audit_constraints_ok'],
    ['audit index not ready', "update pg_index set indisready=false where indexrelid='private.site_admin_audit_actor_time_idx'::regclass;", 'audit_indexes_ok'],
    ['audit immutable trigger disabled', 'alter table private.site_admin_audit disable trigger site_admin_audit_immutable;', 'audit_immutable_trigger_ok'],
  ];
  for (const [name, mutate, field] of cases) {
    // The mutation transaction is deliberately not read-only, so its separate
    // read_only_pinned_server_ok is false too. Each independent target attestation
    // must itself fail; everything is rolled back in this owned scratch cluster.
    const result = JSON.parse(bootstrap(`begin;${mutate}${catalogRow(sql)}rollback;`));
    assert.equal(result[field], false, `${name} must fail ${field}`);
  }
  assert.deepEqual(one(`begin read only;${catalogRow(sql)}rollback;`), positive);
  t.diagnostic(`ADMIN_PROFILE_NAME_CATALOG_MUTATIONS ${cases.length}`);
});

test('100k retained erasure custom/generic stress and both physical-size preflight boundaries are explicit', async t => {
  const originalFixture = fixture; fixture = await fresh74();
  try {
    const target = randomUUID(); const absent = randomUUID();
    const preflight = () => one(`begin read only;${catalogRow(preflightSql)}rollback;`);
    assert.equal(Object.keys(preflight()).length, 9); assert.ok(Object.values(preflight()).every(value => value === true));
    const sizes = () => one("select jsonb_build_object('batchHeap',pg_relation_size('private.retired_community_deletion_batches'),'batchTotal',pg_total_relation_size('private.retired_community_deletion_batches'),'ledgerHeap',pg_relation_size('private.retired_community_deletion_ledger'),'ledgerTotal',pg_total_relation_size('private.retired_community_deletion_ledger'));");
    const batchOptions = () => one("select jsonb_build_object('reloptions',reloptions)from pg_class where oid='private.retired_community_deletion_batches'::regclass;");
    const originalOptions = batchOptions();
    assert.deepEqual(originalOptions, { reloptions: null }, 'The frozen exact74 batch table has default storage options.');
    const triggers = () => one("select jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,tgenabled)order by tgrelid::regclass::text,tgname)from pg_trigger where tgrelid in('private.retired_community_deletion_batches'::regclass,'private.retired_community_deletion_ledger'::regclass);");
    const originalTriggers = triggers();
    assert.ok(originalTriggers.length > 0 && originalTriggers.every(row => row[2] === 'O'));
    // Keep every legacy sealing/immutability/FK trigger active. Fixed setup
    // chunks bound each statement without changing the 100k stress workload,
    // the fixture's 20s statement limit, or its 30s process boundary.
    for (let start = 1; start <= 100000; start += 10000) {
      const end = start + 9999;
      query(`insert into private.retired_community_deletion_batches(id,reason,requested_by,requested_at,execute_after,deadline_at,subject_user_id,t0_source_sha256)
        select md5('erasure-large:'||n)::uuid,'account_erasure','synthetic-fixture',now(),now(),now()+interval '24 hours','${target}',repeat('a',64)from generate_series(${start},${end})n;
        update private.retired_community_deletion_batches set sealed=true,source_sha256=repeat('b',64),post_count=0,comment_count=0,like_count=0,object_count=0,credential_count=0
          where id in(select md5('erasure-large:'||n)::uuid from generate_series(${start},${end})n);
        insert into private.retired_community_deletion_ledger(batch_id,event_type,actor,event_at)
          select md5('erasure-large:'||n)::uuid,'cancelled','synthetic-fixture',now()from generate_series(${start},${end})n;`);
    }
    query('analyze private.retired_community_deletion_batches;analyze private.retired_community_deletion_ledger;');
    const semanticState = () => one(`select jsonb_build_object(
      'batches',(select jsonb_build_object('count',count(*),'sealed',count(*)filter(where sealed),
        'digest',md5(string_agg(md5(to_jsonb(b)::text),''order by id)))from private.retired_community_deletion_batches b),
      'ledger',(select jsonb_build_object('count',count(*),'terminal',count(*)filter(where event_type='cancelled'),
        'digest',md5(string_agg(md5(to_jsonb(l)::text),''order by id)))from private.retired_community_deletion_ledger l));`);
    const originalRows = semanticState();
    assert.deepEqual({ batches: originalRows.batches.count, sealed: originalRows.batches.sealed,
      ledger: originalRows.ledger.count, terminal: originalRows.ledger.terminal },
    { batches: 100000, sealed: 100000, ledger: 100000, terminal: 100000 });
    assert.deepEqual(triggers(), originalTriggers);
    const sizeBefore = sizes();
    const predicate = migration.match(/exists\(select 1 from private\.retired_community_deletion_batches b where b\.reason='account_erasure'[\s\S]*?l\.event_type in \('cancelled','executed'\)\)\)/)?.[0];
    assert.ok(predicate); const costs = [];
    for (const [density, subject] of [['sparse', absent], ['dense-terminal', target]]) {
      for (const mode of ['force_custom_plan', 'force_generic_plan']) {
        const plan = JSON.parse(query(`begin;set local plan_cache_mode=${mode};prepare fixture_large_erasure(uuid)as select ${predicate.replaceAll('target_user', '$1')};
          explain(analyze,buffers,format json)execute fixture_large_erasure('${subject}');rollback;`))[0];
        const nodes = []; const visit = node => { nodes.push(node); for (const child of node.Plans || []) visit(child); }; visit(plan.Plan);
        const batch = nodes.find(node => node['Relation Name'] === 'retired_community_deletion_batches');
        assert.ok(batch); assert.equal(batch['Node Type'], 'Seq Scan');
        assert.equal(batch['Actual Rows'] + (batch['Rows Removed by Filter'] || 0), 100000);
        costs.push({ density, mode, executionMs: plan['Execution Time'], batchRows: batch['Actual Rows'], removed: batch['Rows Removed by Filter'] || 0,
          sharedHits: plan.Plan['Shared Hit Blocks'] || 0, sharedReads: plan.Plan['Shared Read Blocks'] || 0 });
      }
    }
    // Physical-boundary proof is independent of platform-dependent MVCC churn
    // from setup commits. Only this owned scratch table is expanded/compacted;
    // the deployment preflight never changes storage options or runs VACUUM.
    query('alter table private.retired_community_deletion_batches set(fillfactor=40);vacuum full private.retired_community_deletion_batches;');
    assert.deepEqual(batchOptions(), { reloptions: ['fillfactor=40'] });
    assert.deepEqual(semanticState(), originalRows, 'Expansion preserves every batch/ledger row and count.');
    assert.deepEqual(triggers(), originalTriggers);
    const sizeExpanded = sizes();
    assert.ok(sizeExpanded.batchHeap > 33554432); assert.ok(sizeExpanded.ledgerHeap < 33554432);
    assert.ok(sizeExpanded.batchTotal <= 134217728 && sizeExpanded.ledgerTotal <= 134217728);
    assert.equal(preflight().retained_erasure_size_within_bound_ok, false, 'Only the expanded batch heap exceeds the fixed cap.');
    query('alter table private.retired_community_deletion_batches reset(fillfactor);vacuum full private.retired_community_deletion_batches;');
    assert.deepEqual(batchOptions(), originalOptions, 'Restore the exact original storage options.');
    assert.deepEqual(semanticState(), originalRows, 'Compaction preserves every batch/ledger row and count.');
    assert.deepEqual(triggers(), originalTriggers);
    const sizeRestored = sizes();
    assert.ok(sizeRestored.batchHeap <= 33554432 && sizeRestored.ledgerHeap < 33554432);
    assert.equal(preflight().retained_erasure_size_within_bound_ok, true);
    query("insert into private.retired_community_deletion_ledger(batch_id,event_type,actor,event_at,details)select md5('erasure-large:'||n)::uuid,'cancelled','synthetic-fixture',now(),jsonb_build_object('synthetic',repeat('x',1100))from generate_series(1,35000)n;");
    const sizeAfter = sizes();
    assert.ok(sizeAfter.batchHeap <= 33554432); assert.ok(sizeAfter.ledgerHeap > 33554432);
    assert.equal(preflight().retained_erasure_size_within_bound_ok, false, 'Only the retained ledger heap now exceeds the fixed cap.');
    t.diagnostic(`ADMIN_PROFILE_NAME_ERASURE_100K_COST ${JSON.stringify({ sizeBefore, sizeExpanded, sizeRestored, sizeAfter, semanticState: originalRows, costs })}`);
  } finally { await Promise.allSettled([...pending]); fixture.close(); fixture = originalFixture; }
});
