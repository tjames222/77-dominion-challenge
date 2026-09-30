import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

const container = `77dc-original-77-live-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const foundationUrl = new URL('../supabase/migrations/20260930152825_add_original_77_completion_evidence_foundation.sql', import.meta.url);
const runtimeUrl = new URL('../supabase/migrations/20260930160740_wire_original_77_live_completion.sql', import.meta.url);
const command = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
const actor = '10000000-0000-4000-8000-000000000001';
const historical = '10000000-0000-4000-8000-000000000002';
const today = new Date().toISOString().slice(0, 10);
const actorStartDate = new Date(`${today}T00:00:00Z`);
actorStartDate.setUTCDate(actorStartDate.getUTCDate() - 77);
const actorStart = actorStartDate.toISOString().slice(0, 10);
let created = false;
let foundation = '';
let runtime = '';

function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 40_000, maxBuffer: 8 * 1024 * 1024 });
}
function query(sql) {
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function queryAsync(sql) {
  return new Promise((resolve) => {
    const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}
function expectState(sql, state) {
  const statement = sql.replace(/;\s*$/, '');
  query(`do $test$ begin begin ${statement}; exception when sqlstate '${state}' then return; end;
    raise exception 'Expected SQLSTATE ${state}'; end $test$;`);
}
function insertSql(userId, ordinal, createdAt = null, start = '2026-01-01') {
  const localDate = new Date(`${start}T00:00:00Z`);
  localDate.setUTCDate(localDate.getUTCDate() + ordinal - 1);
  const date = localDate.toISOString().slice(0, 10);
  const recordedAt = createdAt ?? `${date}T12:00:00.123456Z`;
  return `insert into public.check_ins(user_id,entry_date,challenge_day,status,completed,created_at)
    values('${userId}','${date}',${ordinal},'partial',array['walk']::text[],'${recordedAt}');`;
}

before(async () => {
  foundation = await readFile(foundationUrl, 'utf8');
  runtime = await readFile(runtimeUrl, 'utf8');
  const started = docker(['run', '--pull', 'never', '--detach', '--name', container, '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', image, '-c',
    'initdb -D /tmp/original-77-live-pgdata -A trust && exec postgres -D /tmp/original-77-live-pgdata -k /tmp -h ""']);
  assert.equal(started.status, 0, started.stderr || started.error?.message);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated PostgreSQL fixture did not become ready');

  query(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create table public.profiles(
      user_id uuid primary key references auth.users(id) on delete cascade,
      challenge_start_date date,
      challenge_activation_review_required boolean not null default false,
      challenge_activation_status text not null default 'active',
      challenge_activation_schema_version integer not null default 1,
      challenge_activation_revision integer not null default 1,
      challenge_participation_mode text default 'solo',
      challenge_activation_time_zone text default 'UTC',
      challenge_group_attribution_crew_id uuid,
      challenge_activated_at timestamptz, challenge_confirmed_at timestamptz,
      challenge_activated_by uuid, challenge_confirmed_by uuid,
      time_zone text default 'UTC', name text default 'Member', email text default ''
    );
    create table public.check_ins(
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      entry_date date not null,
      challenge_day integer not null,
      status text not null,
      completed_count integer not null default 0,
      completed text[] not null,
      workout_difficulty jsonb not null default '{}'::jsonb,
      points_awarded integer not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      constraint check_ins_challenge_day_range check(challenge_day between 1 and 77),
      unique(user_id,entry_date), unique(user_id,challenge_day)
    );
    create index check_ins_user_entry_date_fixture_idx on public.check_ins(user_id,entry_date desc);
    create table public.challenge_entries(
      user_id uuid not null references auth.users(id) on delete cascade,
      entry_date date not null, completed text[] not null default '{}',
      workout_difficulty jsonb not null default '{}', version bigint not null default 0,
      updated_at timestamptz default now(), primary key(user_id,entry_date)
    );
    create table public.crews(id uuid primary key,deleted_at timestamptz);
    create table public.crew_members(user_id uuid,crew_id uuid);
    create table private.retired_community_dr_quarantined_crews(crew_id uuid);
    create table public.entitlements(user_id uuid,entitlement_key text,status text,starts_at timestamptz,ends_at timestamptz);
    create table public.reward_definitions(
      reward_key text primary key,reward_type text,state_model text,challenge_key text,
      title text,description text,points_required integer,fulfillment_key text,
      required_entitlement_key text,icon text,sort_order integer,is_active boolean,
      display_metadata jsonb
    );
    create table public.user_challenge_states(
      user_id uuid,challenge_key text,status text,unlock_points integer,unlocked_at timestamptz,
      started_at timestamptz,completed_at timestamptz,celebration_seen_at timestamptz
    );
    create table public.user_reward_entitlements(
      user_id uuid,reward_key text,owned_at timestamptz,celebration_seen_at timestamptz
    );
    create table public.badge_definitions(
      badge_key text primary key,name text,description text,requirement text,category text,
      tier text,tier_rank integer,icon text,sort_order integer,criteria_version integer,
      source_event text,metric text,threshold integer,predicate text,scope text,visibility text,
      show_progress boolean,celebration text,retired boolean,blocked boolean
    );
    create table public.user_badges(
      id uuid primary key default gen_random_uuid(),
      user_id uuid references auth.users(id) on delete cascade,badge_key text,scope_key text,
      entry_date date,earned_at timestamptz,metadata jsonb,celebration_seen_at timestamptz,
      unique(user_id,badge_key,scope_key)
    );
    create table public.fixture_points(
      user_id uuid references auth.users(id) on delete cascade,
      entry_date date,points integer,unique(user_id,entry_date)
    );
    create function public.challenge_activation_user_date(uuid) returns date language sql stable as $$ select current_date $$;
    create function public.daily_standard_user_date(uuid) returns date language sql stable as $$ select current_date $$;
    create function public.has_active_entitlement(text) returns boolean language sql stable as $$ select true $$;
    create function private.early_access_active_for_user(uuid,timestamptz) returns boolean language sql stable as $$ select true $$;
    create function private.reward_eligible_points(uuid,text) returns integer language sql stable as $$ select 0 $$;
    create function public.normalize_daily_standard_completed(text[]) returns text[] language sql immutable as $$ select $1 $$;
    create function public.get_challenge_activation(target_expected_actor_id uuid) returns jsonb
      language plpgsql security definer set search_path='' as $$
      declare caller_id uuid:=(select auth.uid());
      begin
        if caller_id is null then raise exception 'login required' using errcode='28000'; end if;
        if target_expected_actor_id is distinct from caller_id then
          raise exception 'actor changed' using errcode='40001';
        end if;
        perform 1 from public.profiles where user_id=caller_id for update;
        return public.challenge_activation_payload_for_user(caller_id);
      end $$;
    create function public.add_game_points(uuid,text,integer,date,integer,uuid,jsonb,text) returns boolean
      language plpgsql as $$ begin insert into public.fixture_points values($1,$4,$3) on conflict do nothing; return found; end $$;
    create function public.process_check_in_game_rewards() returns trigger
      language plpgsql as $$ begin return new; end $$;
    create function private.award_check_in_badges() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger award_check_in_badges_after_insert after insert on public.check_ins
      for each row execute function private.award_check_in_badges();
    create trigger process_check_in_game_rewards_before_insert before insert on public.check_ins
      for each row execute function public.process_check_in_game_rewards();
    grant usage on schema auth,private,public to authenticated;
    insert into public.badge_definitions values(
      'original_77_completed','77-Day Finisher','pending','pending','completion','gold',3,'crown',900,1,
      'challenge_completion','original_77_completion',1,null,'challenge_instance','public',false,'queue',false,true
    );
    insert into auth.users(id) values('${historical}');
    insert into public.profiles(user_id,challenge_start_date) values('${historical}','2026-01-01');
    ${Array.from({ length: 77 }, (_, index) => insertSql(historical, index + 1)).join('\n')}
    ${foundation}
    ${runtime}
  `);
});

beforeEach(() => {
  query(`delete from auth.users where id='${actor}';
    insert into auth.users(id) values('${actor}');
    insert into public.profiles(user_id,challenge_start_date) values('${actor}','${actorStart}');`);
});

after(() => {
  if (!created) return;
  const removed = docker(['rm', '--force', container]);
  assert.equal(removed.status, 0, removed.stderr || removed.error?.message);
});

test('migration keeps browser roles out and widens only the calendar ordinal bound', () => {
  const [shape] = query(`select jsonb_build_object(
    'constraint',pg_get_constraintdef(oid),
    'progressAuth',has_function_privilege('authenticated','private.original_77_progress_for_user(uuid,date)','execute'),
    'eventInsert',has_table_privilege('authenticated','private.original_77_completion_events','insert'),
    'startAuth',has_function_privilege('authenticated','public.start_challenge(text)','execute'))
    from pg_constraint where conname='check_ins_challenge_day_range';`);
  assert.match(shape.constraint, /3652059/);
  assert.equal(shape.progressAuth, false);
  assert.equal(shape.eventInsert, false);
  assert.equal(shape.startAuth, true);
  expectState(`perform set_config('request.jwt.claim.sub','${actor}',true);
    perform public.start_challenge('reset_77')`, '55000');
  expectState(`perform set_config('request.jwt.claim.sub','${actor}',true);
    perform public.start_challenge('reset_77','${actor}')`, '55000');
});

test('mature draft payload preserves owner, activation status and lock reason contracts', () => {
  const [active] = query(`select public.daily_standard_draft_payload('${actor}','${today}',false)`);
  assert.equal(active.activation_status, 'active');
  assert.equal(active.locked, false);
  assert.equal(active.lock_reason, null);
  expectState(`perform set_config('request.jwt.claim.sub','${historical}',true);
    perform public.daily_standard_draft_payload('${actor}','${today}',false)`, '42501');
  query(`update public.profiles set challenge_activation_status='not_started' where user_id='${actor}'`);
  const [notStarted] = query(`select public.daily_standard_draft_payload('${actor}','${today}',false)`);
  assert.equal(notStarted.activation_status, 'not_started');
  assert.equal(notStarted.locked, true);
  assert.equal(notStarted.lock_reason, 'challenge_not_active');
});

test('the actual sparse 77th submission records one immutable event and typed Finisher award', () => {
  query(`set request.jwt.claim.sub='${actor}';
    ${Array.from({ length: 76 }, (_, index) => insertSql(actor, index + 1, null, actorStart)).join('\n')}
    insert into public.challenge_entries(user_id,entry_date,completed)
      values('${actor}','${today}',array['walk']::text[]);`);
  const [submitted] = query(`set request.jwt.claim.sub='${actor}';
    select public.submit_daily_check_in(
      'partial',array['walk']::text[],'{}'::jsonb,'UTC','${today}','${actor}'
    )`);
  assert.equal(submitted.challenge_day, 78);
  assert.equal(submitted.activation.originalProgress.submittedCount, 77);
  assert.equal(submitted.activation.originalProgress.completionState, 'live_completed');
  const [result] = query(`select jsonb_build_object(
    'progress',private.original_77_progress_for_user('${actor}','${actorStart}'),
    'events',(select count(*) from private.original_77_completion_events where user_id='${actor}'),
    'awards',(select count(*) from public.user_badges where user_id='${actor}' and badge_key='original_77_completed'),
    'metadata',(select metadata from public.user_badges where user_id='${actor}' and badge_key='original_77_completed'),
    'earnedAt',(select earned_at from public.user_badges where user_id='${actor}' and badge_key='original_77_completed'))`);
  assert.equal(result.progress.submittedCount, 77);
  assert.equal(result.progress.completionState, 'live_completed');
  assert.equal(result.progress.canonicalEvent.localDate, today);
  assert.equal(result.progress.canonicalEvent.recordedAt, result.earnedAt);
  assert.equal(result.events, 1);
  assert.equal(result.awards, 1);
  assert.equal(result.metadata.sourceType, 'challenge_completion');
  assert.equal(result.metadata.sourceCheckInId, result.progress.canonicalEvent.sourceId);
  assert.deepEqual(result.metadata.earningEvidence, {
    schemaVersion: 1, kind: 'challenge_completion', completionKind: 'original_77_submissions',
    completionEventId: result.progress.canonicalEvent.id,
    sourceCheckInId: result.progress.canonicalEvent.sourceId, submittedCount: 77, targetCount: 77,
  });
  assert.ok(Date.parse(result.earnedAt));
  const [activation] = query(`select public.challenge_activation_payload_for_user('${actor}')`);
  assert.equal(activation.originalProgress.completionState, 'live_completed');
  assert.equal(activation.canParticipate, false);
  assert.equal(activation.canMutateDailyStandards, false);
  const [draft] = query(`select public.daily_standard_draft_payload('${actor}','${today}',false)`);
  assert.equal(draft.activation_status, 'active');
  assert.equal(draft.lock_reason, 'submitted');
  assert.equal(draft.locked, true);
  expectState(`set local request.jwt.claim.sub='${actor}'; ${insertSql(actor, 79, null, actorStart)}`, '22023');
});

test('historical qualification remains provenance-pending and cannot replay an event or award', () => {
  const [progress] = query(`select private.original_77_progress_for_user('${historical}','2026-01-01')`);
  assert.equal(progress.completionState, 'historical_provenance_pending');
  assert.equal(progress.submittedCount, 77);
  assert.deepEqual(query(`select jsonb_build_object(
    'events',(select count(*) from private.original_77_completion_events where user_id='${historical}'),
    'awards',(select count(*) from public.user_badges where user_id='${historical}' and badge_key='original_77_completed'))`)[0],
  { events: 0, awards: 0 });
  expectState(`set local request.jwt.claim.sub='${historical}'; ${insertSql(historical, 78)}`, '22023');
});

test('two actor-bound 77th RPC attempts serialize to one check-in, point, event and award', async () => {
  query(`set request.jwt.claim.sub='${actor}';
    ${Array.from({ length: 76 }, (_, index) => insertSql(actor, index + 1, null, actorStart)).join('\n')}
    insert into public.challenge_entries(user_id,entry_date,completed)
      values('${actor}','${today}',array['walk']::text[]);`);
  const call = `select public.submit_daily_check_in(
    'partial',array['bible']::text[],'{"one":"extreme"}'::jsonb,
    'UTC','${today}','${actor}'
  );`;
  const first = queryAsync(`begin; set local request.jwt.claim.sub='${actor}';
    set local statement_timeout='5s'; ${call} select pg_sleep(0.25); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = queryAsync(`set request.jwt.claim.sub='${actor}';
    set statement_timeout='5s'; ${call}`);
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [0, 3]);
  assert.doesNotMatch(outcomes.map(({ stderr }) => stderr).join('\n'), /40P01|deadlock detected/i);
  assert.deepEqual(query(`select jsonb_build_object(
    'checks',(select count(*) from public.check_ins where user_id='${actor}'),
    'points',(select count(*) from public.fixture_points where user_id='${actor}'),
    'events',(select count(*) from private.original_77_completion_events where user_id='${actor}'),
    'awards',(select count(*) from public.user_badges where user_id='${actor}' and badge_key='original_77_completed'),
    'completed',(select completed from public.check_ins where user_id='${actor}' and entry_date='${today}'))`)[0],
  { checks: 77, points: 77, events: 1, awards: 1, completed: ['walk'] });
});

test('a missing canonical badge definition rolls the 77th insert, points and event back together', () => {
  query(`set request.jwt.claim.sub='${actor}';
    ${Array.from({ length: 76 }, (_, index) => insertSql(actor, index + 1, null, actorStart)).join('\n')}
    update public.badge_definitions set blocked=true where badge_key='original_77_completed';`);
  expectState(`set local request.jwt.claim.sub='${actor}'; ${insertSql(actor, 78, null, actorStart)}`, '23514');
  assert.deepEqual(query(`select jsonb_build_object(
    'checks',(select count(*) from public.check_ins where user_id='${actor}'),
    'points',(select count(*) from public.fixture_points where user_id='${actor}'),
    'events',(select count(*) from private.original_77_completion_events where user_id='${actor}'),
    'awards',(select count(*) from public.user_badges where user_id='${actor}' and badge_key='original_77_completed'))`)[0],
  { checks: 76, points: 76, events: 0, awards: 0 });
  query(`update public.badge_definitions set blocked=false where badge_key='original_77_completed'`);
});
