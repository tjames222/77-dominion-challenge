import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

const container = `77dc-daily-bootstrap-${randomUUID()}`;
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
let created = false; let actualFunctions = ''; let migration = '';
const command = ['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'];
const literal = (value) => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
function docker(args, input) { return spawnSync('docker', args, { input, encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024 }); }
function query(sql) { const result = docker(command, sql); assert.equal(result.status,0,result.stderr || result.error?.message); return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse); }
function parallel(sql) { return new Promise((resolve,reject) => { const child=spawn('docker',command); let output='',error=''; child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>error+=v);child.on('error',reject);child.on('close',code=>resolve({code,output,error}));child.stdin.end(sql); }); }
const asActor = (sql, actor=A) => `set request.jwt.claims=${literal(JSON.stringify({sub:actor,email:'synthetic@example.test',role:'authenticated'}))};set role authenticated;${sql}`;
const call = ({ actor=A, zone='UTC', date=null }={}) => `public.get_daily_action_bootstrap(${literal(actor)},${literal(zone)},${literal(date)}::date)`;
const read = (args={},actor=A) => query(asActor(`select ${call(args)};`,actor))[0];
const denied = (sql, code) => `do $test$ begin begin perform ${sql}; exception when sqlstate '${code}' then return;end;raise exception 'Expected denial';end $test$;`;
const functions = (source, names) => names.map((name) => {
  const pattern = new RegExp(`create or replace function ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\n\\$\\$;`);
  const value = source.match(pattern)?.[0]; assert.ok(value, `Missing actual function ${name}`); return value;
}).join('\n');
const entitled = (id=A) => `insert into public.entitlements(user_id,entitlement_key,status,source_type,source_id,ends_at)values('${id}','membership_active','active','test','fixture',null);`;
const schedule = (date='2026-09-12',zone='America/Los_Angeles') => `update public.profiles set challenge_activation_status='scheduled',challenge_participation_mode='solo',challenge_start_date='${date}',challenge_activation_time_zone='${zone}',challenge_confirmed_at='2026-01-01',challenge_confirmed_by=user_id where user_id='${A}';`;
const clock = (value) => query(`update private.daily_test_clock set value='${value}';`);
async function waitForSql(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (query(`select to_jsonb(${predicate});`)[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail('The local concurrency fixture did not acquire its expected lock.');
}

before(async () => {
  const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
  const baseline = await readMigration('20260707170000_baseline.sql');
  const activation = await readMigration('20260804200019_challenge_activation_lifecycle.sql');
  const drafts = await readMigration('20260719130000_atomic_daily_standard_drafts.sql');
  actualFunctions = functions(baseline,['public.has_active_entitlement'])
    + functions(drafts,['public.bootstrap_daily_standard_time_zone']).replace('public.bootstrap_daily_standard_time_zone(', 'public.bootstrap_daily_standard_time_zone_pre_activation(')
    + functions(activation,['public.challenge_activation_user_date','public.daily_standard_user_date','private.promote_due_challenge_activation',
      'private.lock_challenge_activation_actor','public.challenge_activation_allows_date','public.challenge_activation_payload_for_user',
      'public.get_challenge_activation','public.bootstrap_daily_standard_time_zone','public.daily_standard_draft_payload']);
  for (const name of ['public.challenge_activation_user_date','private.promote_due_challenge_activation',
    'private.lock_challenge_activation_actor','public.challenge_activation_allows_date',
    'public.challenge_activation_payload_for_user','public.daily_standard_user_date','public.daily_standard_draft_payload']) {
    const statement = activation.match(new RegExp(`revoke all on function ${name.replaceAll('.', '\\.')}\\([^;]+;`))?.[0];
    assert.ok(statement, `Missing prerequisite privilege boundary: ${name}`); actualFunctions += statement;
  }
  migration = await readMigration('20260913075846_focused_daily_action_bootstrap.sql');
  const started=docker(['run','--detach','--name',container,'--network','none','--user','postgres','--tmpfs','/tmp:rw','--entrypoint','/bin/sh','public.ecr.aws/supabase/postgres:17.6.1.141','-c','initdb -D /tmp/daily-pgdata -A trust && exec postgres -D /tmp/daily-pgdata -k /tmp -h ""']);
  assert.equal(started.status,0,started.stderr);created=true;
  for(let i=0;i<100;i++){if(docker(['exec',container,'pg_isready','-h','/tmp','-U','postgres']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  query(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema private;create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid()returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema public,auth,extensions to authenticated;
    create table public.profiles(user_id uuid primary key references auth.users on delete cascade,name text,email text,time_zone text,
      challenge_activation_status text not null default 'not_started',challenge_participation_mode text,challenge_start_date date,
      challenge_activation_time_zone text,challenge_group_attribution_crew_id uuid,challenge_activated_at timestamptz,challenge_confirmed_at timestamptz,
      challenge_activated_by uuid,challenge_confirmed_by uuid,challenge_activation_schema_version integer default 1,
      challenge_activation_revision bigint default 0,challenge_activation_review_required boolean default false,challenge_activation_updated_at timestamptz);
    create table public.entitlements(user_id uuid references auth.users on delete cascade,entitlement_key text,status text,source_type text,source_id text,ends_at timestamptz);
    create table public.challenge_entries(user_id uuid references auth.users on delete cascade,entry_date date,completed text[] default '{}',workout_difficulty jsonb default '{}',version bigint default 0,updated_at timestamptz,primary key(user_id,entry_date));
    create table public.check_ins(user_id uuid references auth.users on delete cascade,entry_date date,primary key(user_id,entry_date));
    create table public.crews(id uuid primary key,deleted_at timestamptz);
    create table public.crew_members(user_id uuid,crew_id uuid);
    create table private.retired_community_dr_quarantined_crews(crew_id uuid);
    alter table public.challenge_entries enable row level security;
    create policy own on public.challenge_entries for select to authenticated using(user_id=(select auth.uid()));
    grant select on public.challenge_entries to authenticated;
    ${actualFunctions}${migration}`);
  const tap=await readFile(new URL('../supabase/tests/database/280_daily_action_bootstrap.sql',import.meta.url),'utf8');
  const result=docker(command,tap);assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/^not ok/m);assert.match(result.stdout,/1\.\.24/);
  // The normal-clock pgTAP above used the exact production function bodies.
  // Only this network-none fixture replaces clock calls, never business rules,
  // to execute deterministic midnight/DST cases on those same SQL bodies.
  query(`create table private.daily_test_clock(value timestamptz);insert into private.daily_test_clock values('2026-09-13T00:30:00Z');
    create function private.daily_fixture_now()returns timestamptz language sql stable as $$select value from private.daily_test_clock$$;`);
  const withClock=(sql)=>sql.replaceAll('pg_catalog.statement_timestamp()', 'private.daily_fixture_now()').replaceAll('> now()', '> private.daily_fixture_now()');
  query(withClock(actualFunctions)+withClock(migration.replaceAll('create function ', 'create or replace function ')));
});
beforeEach(() => {
  query(`truncate auth.users cascade;insert into auth.users(id,email)values('${A}','a@example.test'),('${B}','b@example.test');
    insert into public.profiles(user_id,name,email)values('${A}','A','a@example.test'),('${B}','B','b@example.test');${entitled()}
    update private.daily_test_clock set value='2026-09-13T00:30:00Z';`);
});
after(() => {if(created){const removed=docker(['rm','--force',container]);assert.equal(removed.status,0,removed.stderr);}});

test('actual SQL preserves actor, access, privacy, parameter and deleted-user boundaries', () => {
  query(asActor(denied(call({actor:B}), '40001')+denied(call({actor:null}), '40001')));
  query(`delete from public.entitlements;`);const value=read();assert.equal(value.appAccess,false);assert.equal(value.draft,null);
  assert.equal(query(`select coalesce(to_jsonb(time_zone),'null'::jsonb) from public.profiles where user_id='${A}';`)[0],null);
  query(asActor(denied(call({zone:'Bogus/Zone'}),'22023')+denied(call({date:'infinity'}),'22023')));
  query(`delete from auth.users where id='${A}';`);query(asActor(denied(call(),'28000')));
  query(`set role anon;${denied(call(),'42501')}`);
});
test('existing timezone wins; missing profile/timezone initialize without starting a challenge', () => {
  query(`delete from public.profiles where user_id='${A}';`);
  const value=read({zone:'Pacific/Kiritimati'});assert.equal(value.entryDate,'2026-09-13');assert.equal(value.activation.status,'not_started');assert.equal(value.draft.locked,true);
  assert.equal(read({zone:'America/Los_Angeles'}).timeZone,'Pacific/Kiritimati');
});
test('same server instant gives canonical dates on either side of midnight, never the browser zone', () => {
  query(schedule());const west=read({zone:'Pacific/Kiritimati'});assert.equal(west.entryDate,'2026-09-12');assert.equal(west.asOf,'2026-09-13T00:30:00+00:00');
  query(`update public.profiles set challenge_activation_time_zone='Pacific/Kiritimati' where user_id='${A}';`);
  assert.equal(read({zone:'America/Los_Angeles'}).entryDate,'2026-09-13');
});
test('DST spring-forward and repeated fall-back hour keep the canonical daily boundary', () => {
  query(schedule('2026-03-08'));
  for(const instant of ['2026-03-08T09:59:59Z','2026-03-08T10:00:00Z']){clock(instant);assert.equal(read().entryDate,'2026-03-08');}
  query(schedule('2026-11-01'));
  for(const instant of ['2026-11-01T08:59:59Z','2026-11-01T09:00:00Z']){clock(instant);assert.equal(read().entryDate,'2026-11-01');}
});
test('future schedule remains locked; midnight promotion persists only once across concurrent reads', async () => {
  query(schedule('2026-09-13'));assert.equal(read().activation.status,'scheduled');
  clock('2026-09-13T07:00:00Z');
  const results=await Promise.all(Array.from({length:4},()=>parallel(asActor(`select ${call()};`))));
  for(const result of results){assert.equal(result.code,0,result.error);const value=JSON.parse(result.output);assert.equal(value.activation.storedStatus,'active');assert.equal(value.activation.revision,1);assert.equal(value.draft.locked,false);}
});
test('only the requested actor/date draft is returned, including submitted and completed challenge locks', () => {
  query(schedule());query(`insert into public.challenge_entries(user_id,entry_date,completed,version)values('${A}','2026-09-12',array['bible'],7),('${B}','2026-09-12',array['PRIVATE_SENTINEL'],99);`);
  const value=read();assert.deepEqual(value.draft.completed,['bible']);assert.equal(value.draft.version,7);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SENTINEL|stats|badges|history|feed/);
  query(`insert into public.check_ins values('${A}','2026-09-12');`);assert.equal(read().draft.lock_reason,'submitted');
  assert.equal(read({date:'2026-09-11'}).draft.lock_reason,'date_locked');
  query(`truncate public.check_ins;update public.profiles set challenge_start_date='2026-01-01' where user_id='${A}';`);assert.equal(read().draft.lock_reason,'challenge_complete');
});
test('bootstrap follows activation advisory locks and serializes safely with account erasure', async () => {
  query(schedule());
  const blocker=parallel(`set application_name='daily-bootstrap-advisory-test';begin;select pg_advisory_xact_lock(hashtextextended('single-crew:${A}',821));select pg_sleep(1);commit;`);
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='daily-bootstrap-advisory-test' and wait_event='PgSleep')");
  const readResult=await parallel(asActor(`set lock_timeout='100ms';select ${call()};`));assert.notEqual(readResult.code,0);assert.match(readResult.error,/lock timeout/);await blocker;
  const deletion=parallel(`set application_name='daily-bootstrap-delete-test';begin;select id from auth.users where id='${A}' for update;select pg_sleep(1);delete from auth.users where id='${A}';commit;`);
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='daily-bootstrap-delete-test' and wait_event='PgSleep')");
  const result=await parallel(asActor(`set lock_timeout='2s';select ${call()};`));await deletion;
  assert.notEqual(result.code,0);assert.match(result.error,/no longer exists/);assert.doesNotMatch(result.error,/deadlock/);
});
