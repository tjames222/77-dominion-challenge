import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';
import { BADGE_CATALOG, badgeRuleMatches, checkInBadgeFacts, evaluateBadgeEvent } from '../src/static/badge-evaluation.mjs';

const container=`77dc-badges-sql-${randomUUID()}`;
const actor='10000000-0000-4000-8000-000000000001';
const other='10000000-0000-4000-8000-000000000002';
const claim='20000000-0000-4000-8000-000000000001';
let created=false;
const command=['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'];
const literal=(v)=>v===null?'null':`'${String(v).replaceAll("'","''")}'`;
function docker(args,input) { return spawnSync('docker',args,{input,encoding:'utf8',timeout:30000,maxBuffer:1024*1024}); }
function query(sql) { const r=docker(command,sql); assert.equal(r.status,0,r.stderr||r.error?.message); return r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse); }
function parallel(sql) { return new Promise((resolve,reject)=>{ const c=spawn('docker',command);let output='',error='';c.stdout.on('data',v=>output+=v);c.stderr.on('data',v=>error+=v);c.on('error',reject);c.on('close',code=>resolve({code,output,error}));c.stdin.end(sql); }); }
const asActor=(sql,id=actor)=>`set request.jwt.claim.sub=${literal(id)}; ${sql}`;
const denied=(sql)=>`do $test$ begin begin ${sql} exception when insufficient_privilege then return; end; raise exception 'Expected denial'; end $test$;`;
const actions=['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'];
const checkIn=(day,{id=randomUUID(),completed=actions,difficulty={},user=actor,start='2026-01-01'}={})=>`insert into public.check_ins(id,user_id,entry_date,challenge_day,status,completed,completed_count,workout_difficulty,created_at) values(${literal(id)},${literal(user)},${literal(start)}::date+${day-1},${day},${literal(completed.length===7?'complete':'partial')},array[${completed.map(literal).join(',')}]::text[],${completed.length},${literal(JSON.stringify(difficulty))}::jsonb,(${literal(start)}::date+${day-1})::timestamp at time zone 'UTC'+interval '12 hours');`;

before(async()=>{
  const previousScoring=await readFile(new URL('../supabase/migrations/20260719120000_seven_point_scoring.sql',import.meta.url),'utf8');
  const previousActivation=await readFile(new URL('../supabase/migrations/20260804200019_challenge_activation_lifecycle.sql',import.meta.url),'utf8');
  const previousWorkout=await readFile(new URL('../supabase/migrations/20260731193250_persist_explicit_workout_difficulty.sql',import.meta.url),'utf8');
  const oldVisit=previousScoring.match(/create or replace function public\.record_app_visit\(\)[\s\S]*?\n\$\$;/)[0]
    .replace('public.record_app_visit()','public.record_app_visit_pre_activation()');
  const visitWrapper=previousActivation.match(/create or replace function public\.record_app_visit\(target_expected_actor_id uuid\)[\s\S]*?\n\$\$;/)[0];
  const workoutSetter=previousWorkout.match(/create or replace function public\.set_daily_standard_workout_difficulty\([\s\S]*?\n\$\$;/)[0]
    .replace('public.set_daily_standard_workout_difficulty(','public.set_daily_standard_workout_difficulty_pre_activation(');
  const started=docker(['run','--detach','--name',container,'--network','none','--user','postgres','--tmpfs','/tmp:rw','--entrypoint','/bin/sh','public.ecr.aws/supabase/postgres:17.6.1.141','-c','initdb -D /tmp/badge-pgdata -A trust && exec postgres -D /tmp/badge-pgdata -k /tmp -h ""']);
  assert.equal(started.status,0,started.stderr);created=true;
  for(let i=0;i<100;i++){ if(docker(['exec',container,'pg_isready','-h','/tmp','-U','postgres']).status===0)break; await new Promise(r=>setTimeout(r,100)); }
  query(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema private;create schema extensions;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${actor}'),('${other}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
    create table public.profiles(user_id uuid primary key,challenge_start_date date,time_zone text default 'UTC',challenge_activation_time_zone text default 'UTC',challenge_activation_review_required boolean default false);
    create table public.challenge_entries(user_id uuid,entry_date date,completed text[],workout_difficulty jsonb default '{}',version bigint default 0,primary key(user_id,entry_date));
    create function public.daily_standard_draft_payload(uuid,date,boolean)returns jsonb language sql as $$select to_jsonb(d) from public.challenge_entries d where user_id=$1 and entry_date=$2$$;
    insert into public.profiles(user_id,challenge_start_date) values('${actor}','2026-01-01'),('${other}','2026-01-01');
    create table public.badge_definitions(badge_key text primary key,name text not null,description text not null,category text not null,tier text,icon text,sort_order integer);
    create table public.user_badges(user_id uuid not null references auth.users,badge_key text not null references public.badge_definitions,entry_date date,earned_at timestamptz not null default now(),metadata jsonb not null default '{}',primary key(user_id,badge_key));
    create unique index user_badges_user_entry_date_unique on public.user_badges(user_id,entry_date) where entry_date is not null;
    alter table public.user_badges enable row level security;create policy own on public.user_badges for select to authenticated using(auth.uid()=user_id);grant select on public.user_badges to authenticated;
    create table public.check_ins(id uuid primary key,user_id uuid not null,entry_date date not null,challenge_day integer not null,status text not null,completed text[] not null,completed_count integer not null,workout_difficulty jsonb not null,points_awarded integer default 0,created_at timestamptz not null,unique(user_id,entry_date));
    create table public.user_game_stats(user_id uuid primary key,total_points integer default 0,current_app_streak integer default 0,best_app_streak integer default 0,current_full_day_streak integer default 0,best_full_day_streak integer default 0,last_seen_date date,last_full_day_date date);
    create table public.game_point_events(id uuid primary key default gen_random_uuid(),user_id uuid,event_type text,points integer,idempotency_key text unique);
    create table public.sharing_reward_evidence(id uuid primary key,user_id uuid,recorded_at timestamptz);
    create table private.badge_test_outbound(actor uuid,source_reference text,payload jsonb);
    create function private.enqueue_crew_outbound_event(uuid,text,text,jsonb) returns void language sql as $$insert into private.badge_test_outbound values($1,$3,$4)$$;
    create function public.has_active_entitlement(text) returns boolean language sql stable as $$select current_setting('fixture.entitled',true) is distinct from 'false'$$;
    create function public.ensure_user_game_stats(uuid) returns void language sql as $$insert into public.user_game_stats(user_id)values($1)on conflict do nothing$$;
    create function public.daily_standard_user_date(uuid) returns date language sql stable as $$select (statement_timestamp() at time zone coalesce(challenge_activation_time_zone,time_zone,'UTC'))::date from public.profiles where user_id=$1$$;
    create function private.lock_challenge_activation_actor(uuid) returns void language sql as $$select pg_advisory_xact_lock(hashtextextended($1::text,0))$$;
    ${oldVisit}
    ${visitWrapper}
    ${workoutSetter}
    create function public.add_game_points(uuid,text,integer,date,integer,uuid,jsonb,text) returns boolean language plpgsql as $$begin perform public.ensure_user_game_stats($1);insert into public.game_point_events(user_id,event_type,points,idempotency_key)values($1,$2,$3,$8)on conflict do nothing;return found;end$$;
    ${BADGE_CATALOG.filter(r=>!r.key.startsWith('check_ins_')&&r.key!=='original_77_completed').map(r=>`insert into public.badge_definitions values(${[r.key,r.name,r.description,r.series,r.key==='seven_sealed'?'gold':r.tier,r.icon].map(literal).join(',')},${r.displayOrder});`).join('\n')}
    insert into public.user_badges(user_id,badge_key,entry_date,earned_at)values('${actor}','seven_sealed','2025-12-20','2025-12-20T12:00:00Z');
    create function private.emit_badge_outbound_event() returns trigger language plpgsql as $$begin insert into private.badge_test_outbound values(new.user_id,new.badge_key,'{}');return new;end$$;
    create trigger emit_badge_outbound_event after insert on public.user_badges for each row execute function private.emit_badge_outbound_event();
    ${checkIn(1,{completed:['workoutOne'],difficulty:{one:'hard'}})}`);
  const draft=await readFile(new URL('../supabase/migrations/20260913033347_deterministic_badge_pipeline.sql',import.meta.url),'utf8');
  const catalog=JSON.parse(draft.match(/\$badge_catalog\$(.*?)\$badge_catalog\$/s)[1]);
  assert.deepEqual(catalog,BADGE_CATALOG);
  query(`begin;${draft}commit;`);
  query('create trigger process_check_in_game_rewards_before_insert before insert on public.check_ins for each row execute function public.process_check_in_game_rewards();');
  const rows=query(`select jsonb_build_object('legacy',metadata->'legacy','snapshotTier',metadata->'awardDefinition'->'tier','earnedAt',earned_at,'seen',celebration_seen_at is not null) from public.user_badges where badge_key='seven_sealed';
    select jsonb_build_object('count',count(*),'allSeen',bool_and(celebration_seen_at is not null),'originalDate',bool_and(earned_at='2026-01-01T12:00:00Z')) from public.user_badges where badge_key in ('faithful_start','honest_partial','hard_path');`);
  assert.equal(rows[0].snapshotTier,'gold');assert.equal(rows[0].legacy,true);assert.equal(rows[0].earnedAt,'2025-12-20T12:00:00+00:00');assert.equal(rows[0].seen,true);
  assert.deepEqual(rows[1],{count:3,allSeen:true,originalDate:true});
  assert.deepEqual(query('select to_jsonb(count(*)) from private.badge_test_outbound;'),[0]);
  const pgtap=await readFile(new URL('../supabase/tests/database/220_deterministic_badges.sql',import.meta.url),'utf8');
  const tap=docker(command,pgtap);assert.equal(tap.status,0,tap.stderr);
  assert.doesNotMatch(tap.stdout,/^not ok/m);assert.match(tap.stdout,/1\.\.20/);
});
beforeEach(()=>query("truncate public.user_badges,public.check_ins,public.game_point_events,public.user_game_stats,private.badge_app_visits,public.sharing_reward_evidence,public.challenge_entries,private.badge_test_outbound;update public.profiles set challenge_start_date='2026-01-01';"));
after(()=>{if(created){const removed=docker(['rm','--force',container]);assert.equal(removed.status,0,removed.stderr);}});

test('every SQL rule matches JavaScript at one-before/exact/one-after',()=>{
  for(const rule of BADGE_CATALOG.filter(r=>r.status==='active')) for(const delta of [-1,0,1]) {
    const facts={source:rule.source,instanceId:'original77:2026-01-01',[rule.metric]:rule.threshold+delta,workouts:delta===0?{[rule.predicate]:'one'}:{}};
    const [actual]=query(`select to_jsonb(coalesce(private.badge_rule_matches(${literal(rule.metric)},${rule.threshold},${literal(rule.predicate)},${literal(JSON.stringify(facts))}::jsonb),false));`);
    assert.equal(actual,badgeRuleMatches(rule,facts),`${rule.key} ${delta}`);
  }
});
test('partial workout earns all foundations with SQL/preview parity and no daily badge cap',()=>{
  const id=randomUUID();query(asActor(checkIn(1,{id,completed:['workoutOne'],difficulty:{one:'medium'}})));
  const rows=query('select jsonb_build_object(\'key\',badge_key,\'evidence\',metadata->\'earningEvidence\') from public.user_badges order by badge_key;');
  const expected=evaluateBadgeEvent(checkInBadgeFacts({sourceId:id,localDate:'2026-01-01',occurredAt:'2026-01-01T12:00:00Z',challengeDay:1,completed:['workoutOne'],workoutDifficulty:{one:'medium'}}));
  assert.deepEqual(rows,expected.map(r=>({key:r.key,evidence:r.earningEvidence})).sort((a,b)=>a.key.localeCompare(b.key)));
});
test('perfect Day7 grants both exact crossings, Day8 does not catch up and missing difficulty earns none',()=>{
  query(asActor(Array.from({length:8},(_,i)=>checkIn(i+1)).join('\n')));
  assert.deepEqual(query("select to_jsonb(array_agg(badge_key order by badge_key)) from public.user_badges where entry_date='2026-01-07';"),[['check_ins_7','seven_sealed']]);
  assert.deepEqual(query("select to_jsonb(count(*)) from public.user_badges where entry_date='2026-01-08' or badge_key in ('steady_grind','first_sweat','hard_path','extreme_fire');"),[0]);
});
test('partial and missed days reset perfect streak instead of using stale counters',()=>{
  query(asActor(checkIn(1)+checkIn(2)+checkIn(3,{completed:['walk']})+checkIn(4)+checkIn(6)));
  assert.deepEqual(query(`select to_jsonb(current_full_day_streak) from public.user_game_stats where user_id='${actor}';`),[1]);
  assert.deepEqual(query("select to_jsonb(count(*)) from public.user_badges where badge_key='streak_flame';"),[0]);
});
test('app visit owns its timezone/local date and awards without a check-in',()=>{
  query(`insert into private.badge_app_visits(user_id,local_date,time_zone)select '${actor}',public.daily_standard_user_date('${actor}')-n,'UTC' from generate_series(1,2)n;`);
  query(asActor(`select to_jsonb(v) from public.record_app_visit('${actor}')v;`));
  assert.deepEqual(query("select to_jsonb(array_agg(badge_key)) from public.user_badges;"),[['morning_watch']]);
  query(asActor('select to_jsonb(v) from public.record_app_visit_pre_activation()v;'));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.badge_app_visits;'),[3]);
});
test('cutover preserves an ongoing display streak without fabricating award evidence',()=>{
  query(`insert into public.user_game_stats(user_id,current_app_streak,best_app_streak,last_seen_date)values('${actor}',6,12,public.daily_standard_user_date('${actor}')-1);`);
  const [visit]=query(asActor(`select to_jsonb(v) from public.record_app_visit('${actor}')v;`));
  assert.equal(visit.current_app_streak,7);assert.equal(visit.best_app_streak,12);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.badge_app_visits;select to_jsonb(count(*)) from public.user_badges;'),[1,0]);
  const [collection]=query(asActor(`select public.get_badge_collection('${actor}');`));
  assert.equal(collection.items.find(r=>r.key==='watchman_week').progress.current,1);
  const [retry]=query(asActor(`select to_jsonb(v) from public.record_app_visit('${actor}')v;`));
  assert.equal(retry.current_app_streak,7);
});
test('concurrent claims lease each unseen award once and retry/ack/recovery are durable',async()=>{
  query(asActor(checkIn(1,{completed:['workoutOne'],difficulty:{one:'medium'}})));
  const tokens=[claim,randomUUID(),randomUUID(),randomUUID()];
  const results=await Promise.all(tokens.map(token=>parallel(asActor(`set role authenticated;select public.claim_badge_celebrations('${actor}','${token}');`))));
  for(const result of results)assert.equal(result.code,0,result.error);
  const payloads=results.map(r=>JSON.parse(r.output.trim()));assert.equal(payloads.flat().length,3);
  const winner=payloads.findIndex(r=>r.length>0);const token=tokens[winner];
  const [retry]=query(asActor(`set role authenticated;select public.claim_badge_celebrations('${actor}','${token}');`));assert.equal(retry.length,3);
  query(asActor(`set role authenticated;select public.acknowledge_badge_celebrations('${actor}','${token}',array['${retry[0].id}']::uuid[]);`).replace('select public.acknowledge','do $ack$ begin perform public.acknowledge').replace(/;$/,'; end $ack$;'));
  query("update public.user_badges set celebration_claim_until=now()-interval '1 second' where celebration_seen_at is null;");
  const [reclaimed]=query(asActor(`set role authenticated;select public.claim_badge_celebrations('${actor}','${randomUUID()}');`));assert.equal(reclaimed.length,2);
});
test('RLS and claim/evaluator boundaries reject another actor and public award forgery',()=>{
  query(asActor(checkIn(1)));
  const rows=query(asActor(`set role authenticated;select to_jsonb(count(*)) from public.user_badges;`,other));assert.deepEqual(rows,[0]);
  query(asActor(`set role authenticated;${denied(`perform public.claim_badge_celebrations('${other}','${claim}');`)}${denied(`perform public.award_badge('${actor}','sharing',null,'{}');`)}${denied('perform * from private.badge_app_visits;')}`));
  query(asActor(denied(checkIn(2,{user:other}))));
});
test('acknowledgment returns only durable seen IDs and a wrong lease cannot drop pending state',()=>{
  query(asActor(checkIn(1,{completed:['walk']})));
  const [batch]=query(asActor(`select public.claim_badge_celebrations('${actor}','${claim}');`));
  const id=batch[0].id;
  const ack=(token)=>query(asActor(`select public.acknowledge_badge_celebrations('${actor}','${token}',array['${id}']::uuid[]);`))[0];
  assert.deepEqual(ack(randomUUID()),[]);
  assert.deepEqual(ack(claim),[id]);
  assert.deepEqual(ack(claim),[id]);
});
test('sharing still requires verified evidence plus the existing14-point ledger',()=>{
  query(denied(`perform public.award_badge('${actor}','sharing',null,'{}');`));
  query(`insert into public.sharing_reward_evidence values('${randomUUID()}','${actor}','2026-01-01T12:00:00Z');insert into public.game_point_events(user_id,event_type,points,idempotency_key)values('${actor}','sharing_bonus',14,'sharing_bonus:${actor}');select to_jsonb(public.award_badge('${actor}','sharing',null,'{}'));`);
  assert.deepEqual(query(`select to_jsonb(public.award_badge('${actor}','sharing',null,'{}'));`),[false]);
});
test('an explicit first Medium selection is persisted but an absent selection is not fabricated',()=>{
  const [row]=query(asActor(`update public.profiles set challenge_start_date=public.daily_standard_user_date('${actor}') where user_id='${actor}';select public.set_daily_standard_workout_difficulty_pre_activation(public.daily_standard_user_date('${actor}'),'one','medium',0);`));
  assert.deepEqual(row.workout_difficulty,{one:'medium'});assert.equal(row.version,1);
});
test('collection reports authoritative current-scope progress and omits hidden locked and unowned retired badges',()=>{
  query(asActor(checkIn(1,{completed:['walk']})));
  const [original]=query(asActor(`set role authenticated;select public.get_badge_collection('${actor}');`));
  assert.equal(original.items.find(r=>r.key==='check_ins_7').progress.current,1);
  assert.equal(original.items.some(r=>r.key==='day_77_finisher'),false);
  assert.equal(original.items.find(r=>r.key==='original_77_completed').status,'blocked');
  query("update public.profiles set challenge_start_date='2026-01-02';update public.badge_definitions set visibility='hidden' where badge_key='check_ins_70';");
  const [changed]=query(asActor(`set role authenticated;select public.get_badge_collection('${actor}');`));
  assert.equal(changed.items.find(r=>r.key==='check_ins_7').progress.current,0);
  assert.equal(changed.items.find(r=>r.key==='streak_flame').progress.current,0);
  assert.equal(changed.items.some(r=>r.key==='check_ins_70'),false);
  query("update public.badge_definitions set visibility='public' where badge_key='check_ins_70';");
  query(asActor(`set role authenticated;${denied(`perform public.get_badge_collection('${other}');`)}`));
});
test('simultaneous duplicate posts leave one event with all awards and scoped outbound identities',async()=>{
  const rows=await Promise.all([1,2].map(()=>parallel(asActor(checkIn(1,{completed:['workoutOne'],difficulty:{one:'medium'}})))));
  assert.equal(rows.filter(r=>r.code===0).length,1);
  assert.equal(rows.filter(r=>r.error.includes('duplicate key')).length,1);
  assert.deepEqual(query('select to_jsonb(count(*)) from public.check_ins;select to_jsonb(count(*)) from public.user_badges;select to_jsonb(count(*)) from private.badge_test_outbound;'),[1,3,3]);
});
