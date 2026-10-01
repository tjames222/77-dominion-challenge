import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

// Only a newly owned, network-none PostgreSQL container is used. No host port,
// volume, hosted connection, existing database or provider account is touched.
const fixture = `77dc-ea-membership-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const migrationName = '20260927025530_integrate_early_access_membership.sql';
const actor = '31000000-0000-4000-8000-000000000001';
const other = '31000000-0000-4000-8000-000000000002';
const stranger = '31000000-0000-4000-8000-000000000003';
const crew = '32000000-0000-4000-8000-000000000001';
const sid = '33000000-0000-4000-8000-000000000001';
let containerId;
let originalAcls;
let postIntegrationAcls;
let integrationSql;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const docker = (args, input) => spawnSync('docker', args, {
  input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
});
const psqlArgs = database => ['exec', '-i', containerId, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', '/tmp', '-U', 'postgres', '-d', database];
function sql(input, database = 'ea_test') {
  assert.match(containerId || '', /^[a-f0-9]{64}$/);
  const result = docker(psqlArgs(database), input);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
const values = input => sql(input).split('\n').filter(Boolean).map(JSON.parse);
const asActor = (input, user = actor) => `set request.jwt.claim.sub=${literal(user)};
  set request.jwt.claims=${literal(JSON.stringify({sub:user,role:'authenticated',aal:'aal1',session_id:sid}))};
  set request.headers='{"origin":"https://77dominion.com"}';set role authenticated;${input}`;
const memberRead = () => values(asActor(`select public.get_member_access_context('${actor}');`))[0];
const catalogRead = () => values(asActor(`select public.get_reward_catalog_v2(100,null,null,'${actor}',null,null,null);`))[0];
function expectActorError(statement, pattern) {
  const result=docker(psqlArgs('ea_test'),`\\set VERBOSITY verbose\n${asActor(statement)}`);
  assert.notEqual(result.status,0);assert.match(result.stderr,pattern);
}
function qualify(user = actor) {
  sql(`with request as (
    insert into private.early_access_requests(name,email,user_id,status)
    values('Synthetic member','${user}@example.invalid','${user}','accepted') returning id
  ) insert into private.early_access_grants(user_id,program_key,request_id,accepted_at,starts_at)
    select '${user}','early_access_v1',id,'2026-01-01','2026-01-01' from request;`);
}
function revoke(user = actor) {
  sql(`update private.early_access_grants set revoked_at=clock_timestamp(),revision=revision+1
    where user_id='${user}' and revoked_at is null;`);
}
function entitlement(user = actor, start = '2026-01-01', end = '2200-01-01') {
  sql(`insert into public.entitlements(user_id,entitlement_key,status,source_type,source_id,starts_at,ends_at)
    values('${user}','membership_active','active','subscription','fixture',${literal(start)},${literal(end)});`);
}
function seedCrew() {
  sql(`insert into public.crews(id,name,created_by)values('${crew}','Synthetic crew','${actor}');
    insert into public.crew_members(crew_id,user_id,display_name,role)values('${crew}','${actor}','Owner','owner');`);
}
const issue = () => values(asActor(`select public.issue_crew_invite_bundle('${crew}');`))[0];
function continuation() {
  const issued = issue(); assert.equal(issued.status, 'issued');
  const preview = values(asActor(`select public.preview_crew_invite(${literal(issued.token)},null);`,other))[0];
  assert.equal(preview.status, 'ready');
  return preview.continuationToken;
}
const progressRead = (user = actor, target = actor) => asActor(
  `select public.get_crew_member_progress_profile('${crew}','${target}');`,user);
function connection(input, { keepOpen=false, name='ea-racer' }={}) {
  const child=spawn('docker',psqlArgs('ea_test'));
  let output='',error='';
  const deadline=setTimeout(()=>child.kill(),15_000);
  const completed=new Promise((resolve,reject)=>{
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(deadline);resolve({code,output,error});});
  });
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{error+=chunk;});
  child.stdin.write(`set application_name=${literal(name)};${input}\n`);
  if(!keepOpen)child.stdin.end();
  return {child,completed,output:()=>output};
}
async function waitFor(predicate) {
  for(let n=0;n<150;n++){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Owned fixture did not reach the required concurrency barrier.');
}
async function raceAfterLock(heldSql,requestSql,{waitUntilBeta=false}={}) {
  const holder=connection(`begin;${heldSql}select 'held';`,{keepOpen:true,name:'ea-holder'});
  let contender;
  try{
    await waitFor(()=>holder.output().includes('held'));
    contender=connection(requestSql);
    await waitFor(()=>values("select to_jsonb(exists(select 1 from pg_stat_activity where application_name='ea-racer' and wait_event_type='Lock'));")[0]);
    if(waitUntilBeta){
      sql("select pg_sleep(greatest(0,extract(epoch from (beta_starts_at-clock_timestamp())))+0.05) from private.early_access_programs;");
    }
    holder.child.stdin.end('commit;\n');
    const released=await holder.completed;assert.equal(released.code,0,released.error);
    return await contender.completed;
  }finally{
    if(!holder.child.stdin.writableEnded)holder.child.stdin.end('rollback;\n');
    await holder.completed;
    if(contender)await contender.completed;
  }
}
const aclQuery = `select jsonb_object_agg(n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',to_jsonb(p.proacl))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and p.proname=any(array[
    'has_active_entitlement','reconcile_user_challenge_unlocks','sync_challenge_definition_unlocks',
    'challenge_progression_for_user','claim_challenge_unlocks','start_challenge','reward_catalog_item_for_user',
    'challenge_activation_payload_for_user','crew_invite_issuer_is_authorized','issue_crew_invite_bundle',
    'confirm_crew_invite','get_crew_member_progress_profile','member_access_context']);`;

before(async () => {
  const cached = docker(['image','inspect',image,'--format','{{.Id}}']);
  assert.equal(cached.status,0,'The pinned PostgreSQL image must already be cached; no pull is allowed.');
  assert.match(cached.stdout.trim(),/^sha256:[a-f0-9]{64}$/);
  const started = docker(['run','--detach','--pull','never','--name',fixture,'--label',`77dc.fixture=${fixture}`,
    '--network','none','--cpus','1','--memory','512m','--user','postgres','--tmpfs','/tmp:rw,size=384m',
    '--entrypoint','/bin/sh',cached.stdout.trim(),'-c',
    'initdb -D /tmp/ea-membership-pg -A trust && exec postgres -D /tmp/ea-membership-pg -k /tmp -h ""']);
  assert.equal(started.status,0,started.stderr); containerId=started.stdout.trim();
  assert.match(containerId,/^[a-f0-9]{64}$/);
  let ready=false;
  for(let i=0;i<100;i++){
    if(docker(['exec',containerId,'pg_isready','-h','/tmp','-U','postgres']).status===0){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Owned fixture must become ready.');
  sql('create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;create database ea_template;','postgres');
  const provider = await readFile(new URL('./fixtures/schema-drift-provider.sql',import.meta.url),'utf8');
  sql(`${provider}
    alter table auth.users add instance_id uuid,add aud text,add role text,add encrypted_password text,add raw_app_meta_data jsonb;
    grant usage on schema auth,extensions to anon,authenticated,service_role;
    grant usage on schema auth to supabase_auth_admin;
    alter table auth.users owner to supabase_auth_admin;
    alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;
    alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    create table auth.identities(id uuid primary key,user_id uuid,provider_id text,identity_data jsonb,provider text,
      last_sign_in_at timestamptz,created_at timestamptz,updated_at timestamptz,unique(provider_id,provider));`,'ea_template');
  // The canonical application snapshot deliberately omits the historical
  // production-cutover preflight, which requires full provider vector tables.
  // Use its reviewed provider shapes here; full Supabase replay remains a CI gate.
  const snapshotUrl=new URL('../supabase/schema.sql',import.meta.url);
  const snapshot=await readFile(snapshotUrl,'utf8');
  let beforeIntegration='';
  let afterIntegration='';
  let reachedIntegration=false;
  for(const line of snapshot.split('\n')){
    const include=line.match(/^\\ir (.+)$/);
    if(include){
      const source=await readFile(new URL(include[1],snapshotUrl),'utf8');
      if(include[1]===`migrations/${migrationName}`){
        integrationSql=source;reachedIntegration=true;continue;
      }
      if(reachedIntegration)afterIntegration+=source;
      else beforeIntegration+=source;
    }else if(reachedIntegration)afterIntegration+=line;
    else beforeIntegration+=line;
    if(reachedIntegration)afterIntegration+='\n';
    else beforeIntegration+='\n';
  }
  assert.ok(reachedIntegration,'The early-access integration migration must be present in the canonical snapshot.');
  sql(`set search_path=public,extensions;begin;${beforeIntegration}\ncommit;`,'ea_template');
  originalAcls=sql(aclQuery,'ea_template');
  sql(`begin;${integrationSql}\ncommit;`,'ea_template');
  postIntegrationAcls=sql(aclQuery,'ea_template');
  sql(`set search_path=public,extensions;begin;${afterIntegration}\ncommit;`,'ea_template');
});

beforeEach(() => {
  // Exact databases inside this new fixture only; the template has no users.
  sql('drop database if exists ea_test;create database ea_test template ea_template;','postgres');
  sql(`insert into auth.users(id,email,email_confirmed_at,created_at,updated_at,raw_user_meta_data)
    select id,id::text||'@example.invalid',now(),now(),now(),'{}'::jsonb
    from unnest(array['${actor}'::uuid,'${other}'::uuid,'${stranger}'::uuid])id;
    insert into auth.sessions(id,user_id,aal)values('${sid}','${actor}','aal1');
    insert into public.profiles(user_id,name,email,time_zone)
    select id,'Synthetic member',email,'UTC' from auth.users;`);
});

after(() => {
  if(!containerId)return;
  const ownership=docker(['inspect',containerId,'--format','{{index .Config.Labels "77dc.fixture"}}']);
  assert.equal(ownership.status,0,ownership.stderr);assert.equal(ownership.stdout.trim(),fixture);
  const removed=docker(['rm','--force',containerId]);assert.equal(removed.status,0,removed.stderr);
});

test('canonical application snapshot plus complete new migration preserves ACLs and never seeds access',()=>{
  assert.equal(postIntegrationAcls,originalAcls);
  const before=JSON.parse(originalAcls);
  const final=JSON.parse(sql(aclQuery));
  const actorBoundStart='public.start_challenge(target_challenge_key text, target_expected_actor_id uuid)';
  assert.deepEqual(final[actorBoundStart],['postgres=X/postgres','authenticated=X/postgres']);
  delete final[actorBoundStart];
  assert.deepEqual(final,before);
  for(const signature of [
    'public.get_reward_catalog_v2(integer,integer,text,uuid,bigint,bigint,text)',
    'public.get_challenge_activation_v2(uuid)',
    'public.get_daily_action_bootstrap_v2(uuid,text,date,uuid)',
    'public.start_challenge_instance_v2(text,date,text,uuid,uuid,uuid,bigint)',
  ]){
    assert.deepEqual(values(`select jsonb_build_array(
      has_function_privilege('authenticated',${literal(signature)},'execute'),
      has_function_privilege('anon',${literal(signature)},'execute'),
      has_function_privilege('service_role',${literal(signature)},'execute'));`),[[true,false,false]]);
  }
  assert.deepEqual(values('select jsonb_build_array((select count(*) from private.early_access_grants),(select count(*) from private.early_access_price_qualifications));'),[[0,0]]);
  assert.deepEqual(values(`select jsonb_build_array(
    has_function_privilege('anon','private.lock_early_access_authority(uuid[])','execute'),
    has_function_privilege('authenticated','private.lock_early_access_authority(uuid[])','execute'),
    has_function_privilege('service_role','private.lock_early_access_authority(uuid[])','execute'));`),[[false,false,false]]);
  assert.deepEqual(values(`select jsonb_build_object(
    'count',count(*),
    'name',min(conname),
    'definition',min(pg_get_constraintdef(oid)),
    'validated',bool_and(convalidated)
  ) from pg_constraint
  where conrelid='public.check_ins'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%challenge_day%';`),[{
    count:1,
    name:'check_ins_challenge_day_range',
    definition:'CHECK (((challenge_day >= 1) AND (challenge_day <= 3652059)))',
    validated:true,
  }]);
  assert.equal(sql(`begin;set local session_replication_role=replica;
    insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,completed)
    values('${actor}','2026-03-19',78,'partial',1,array['walk']::text[]);
    select challenge_day from public.check_ins where user_id='${actor}';rollback;`),'78');
  assert.match(integrationSql,/order by g.user_id for share/);
});

test('EA permits membership only and remains distinct from legacy and paid access',()=>{
  assert.equal(memberRead().appAccess,false);qualify();
  const read=memberRead();
  assert.equal(read.appAccess,true);assert.equal(read.earlyAccessActive,true);
  assert.equal(read.legacyMembershipActive,false);assert.equal(read.paidSubscriptionActive,false);
  assert.equal(read.betaPriceEligible,true);
  assert.deepEqual(values(asActor(`select jsonb_build_array(public.has_active_entitlement('membership_active'),
    public.has_active_entitlement('premium_unrelated'),public.has_active_entitlement(null));`)),[[true,false,false]]);
  revoke();assert.equal(memberRead().appAccess,false);assert.equal(memberRead().betaPriceEligible,true);
});

test('legacy future-start semantics, cancellation, return and earned qualification stay independent',()=>{
  qualify();revoke();entitlement(actor,'2199-01-01');
  let read=memberRead();assert.equal(read.legacyMembershipActive,true);assert.equal(read.paidSubscriptionActive,false);
  sql("update public.entitlements set starts_at='2026-01-01';");
  read=memberRead();assert.equal(read.paidSubscriptionActive,true);assert.equal(read.earlyAccessActive,false);
  sql("update public.entitlements set status='expired';");assert.equal(memberRead().appAccess,false);
  assert.equal(memberRead().betaPriceEligible,true);
  sql("update public.entitlements set status='active';");assert.equal(memberRead().paidSubscriptionActive,true);
});

test('challenge readers, reconciliation, claim and start use EA without granting unrelated products',()=>{
  qualify();
  sql(`select public.ensure_user_game_stats('${actor}');update public.user_game_stats set total_points=10000 where user_id='${actor}';`);
  const progression=values(`select public.challenge_progression_for_user('${actor}');`)[0];
  const challenge=progression.challenges.find(row=>row.key==='seven_day_reset');
  assert.equal(challenge.canAccess,true);assert.equal(challenge.status,'available');
  const reward=values(`select public.reward_catalog_item_for_user('${actor}',reward_key,10000) from public.reward_definitions where challenge_key='seven_day_reset';`)[0];
  assert.equal(reward.canAccess,true);
  assert.deepEqual(reward.allowedActions,[]);
  const claim=values(asActor('select public.claim_challenge_unlocks();'))[0];assert.ok(claim.claimedKeys.includes('seven_day_reset'));
  const catalog=catalogRead();
  assert.equal(catalog.schemaVersion,2);assert.equal(catalog.actorId,actor);
  assert.equal(catalog.currentInstance,null);assert.match(catalog.snapshotVersion,/^[a-f0-9]{64}$/);
  const reset=catalog.items.find(row=>row.key==='seven_day_reset');
  assert.equal(reset.canAccess,true);assert.equal(reset.status,'available');
  assert.deepEqual(reset.allowedActions,[],'Points unlock Reset but cannot bypass the required current challenge.');
  assert.deepEqual(values(`select coalesce(jsonb_agg(challenge_key order by challenge_key),'[]')
    from public.user_challenge_states where user_id='${actor}';`),[['seven_day_reset']],
  'Lifetime points must not grant any completion-only successor.');
  expectActorError(`select public.get_reward_catalog_v2(100,null,null,'${other}',null,null,null);`,/40001|signed-in account changed/);
  expectActorError(`select public.start_challenge_instance_v2('seven_day_reset',current_date,'UTC','${randomUUID()}','${actor}',null,${catalog.revision+1});`,/40001|challenge timeline changed/);
  expectActorError(`select public.start_challenge_instance_v2('seven_day_reset',current_date,'UTC','${randomUUID()}','${actor}',null,${catalog.revision});`,/55000|Complete the current challenge/);
  for(const statement of [
    "select public.start_challenge('seven_day_reset');",
    `select public.start_challenge('seven_day_reset','${actor}');`,
  ]){
    const denied=docker(psqlArgs('ea_test'),`\\set VERBOSITY verbose\n${asActor(statement)}`);
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/55000|not ready to start/);
  }
  const changedActor=docker(psqlArgs('ea_test'),`\\set VERBOSITY verbose\n${asActor(`select public.start_challenge('seven_day_reset','${other}');`)}`);
  assert.notEqual(changedActor.status,0);assert.match(changedActor.stderr,/40001|signed-in account changed/);
  assert.deepEqual(values(`select jsonb_build_object('status',status,'startedAt',started_at)
    from public.user_challenge_states where user_id='${actor}' and challenge_key='seven_day_reset';`),
    [{status:'available',startedAt:null}]);
  sql(`insert into public.challenge_definitions(challenge_key,title,teaser,challenge_type,points_required,duration_days,entitlement_key,icon,sort_order)
    values('fixture_ea','EA challenge','Fixture','reset',21,7,'membership_active','repeat',999),
      ('fixture_other','Unrelated product','Fixture','reset',21,7,'premium_unrelated','repeat',1000);`);
  // V2 intentionally removed definition-insert point fan-out. Register each
  // released rule explicitly, then use the real actor-bound reconciliation.
  sql(`insert into public.reward_definitions(reward_key,reward_type,state_model,title,points_required,
      fulfillment_key,challenge_key,required_entitlement_key,sort_order,unlock_rule_type,phase,released)
    values('fixture_ea','challenge','challenge_lifecycle','EA challenge',21,'fixture_ea','fixture_ea','membership_active',999,'lifetime_points','core',true),
      ('fixture_other','challenge','challenge_lifecycle','Unrelated product',21,'fixture_other','fixture_other','premium_unrelated',1000,'lifetime_points','core',true);`);
  assert.deepEqual(values(`select coalesce(jsonb_agg(challenge_key order by challenge_key),'[]')
    from public.user_challenge_states where user_id='${actor}' and challenge_key like 'fixture_%';`),[[]]);
  const configured=catalogRead();
  assert.equal(configured.items.find(row=>row.key==='fixture_ea').canAccess,true);
  assert.equal(configured.items.find(row=>row.key==='fixture_other').canAccess,false);
  assert.deepEqual(values(`select jsonb_agg(challenge_key order by challenge_key) from public.user_challenge_states where user_id='${actor}' and challenge_key like 'fixture_%';`),[['fixture_ea']]);
  assert.deepEqual(values(`select to_jsonb(count(*)) from private.challenge_instance_requests where user_id='${actor}';`),[0]);
  revoke();
  const after=values(`select public.challenge_progression_for_user('${actor}');`)[0];
  assert.equal(after.challenges.find(row=>row.key==='seven_day_reset').canAccess,false);
  assert.equal(after.challenges.find(row=>row.key==='fixture_other').canAccess,false);
  assert.equal(after.challenges.find(row=>row.key==='fixture_other').accessReason,'membership_required');
  const revokedCatalog=catalogRead();
  for(const key of ['seven_day_reset','fixture_ea','fixture_other']){
    assert.equal(revokedCatalog.items.find(row=>row.key===key).canAccess,false);
    assert.deepEqual(revokedCatalog.items.find(row=>row.key===key).allowedActions,[]);
  }
});

test('EA crew issuer, recipient confirmation and same-crew badge reader work without billing rows',()=>{
  qualify();qualify(other);seedCrew();
  assert.deepEqual(values(`select to_jsonb(private.crew_invite_issuer_is_authorized('${crew}','${actor}'));`),[true]);
  const token=continuation();
  const joined=values(asActor(`select public.confirm_crew_invite(${literal(token)});`,other))[0];
  assert.equal(joined.status,'joined');
  assert.equal(values(progressRead(actor,other))[0].memberId,other);
  assert.equal(values(progressRead(other,actor))[0].memberId,actor);
  const denied=docker(psqlArgs('ea_test'),progressRead(stranger,actor));
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/Member progress is no longer available/);
  revoke();assert.equal(issue().status,'forbidden');
  const after=docker(psqlArgs('ea_test'),progressRead(actor,other));
  assert.notEqual(after.status,0);assert.match(after.stderr,/Member progress is no longer available/);
});

test('a configured beta boundary removes free access but preserves price eligibility',()=>{
  qualify();seedCrew();
  sql("update private.early_access_programs set beta_starts_at=clock_timestamp();");
  const read=memberRead();assert.equal(read.appAccess,false);assert.equal(read.betaPriceEligible,true);
  assert.equal(issue().status,'forbidden');
});

test('solo activation and Daily Action bootstrap recognize EA through canonical gates',()=>{
  qualify();
  const active=values(asActor(`select public.activate_solo_challenge((clock_timestamp() at time zone 'UTC')::date,'UTC','${randomUUID()}','${actor}');`))[0];
  assert.equal(active.status,'active');assert.equal(active.canMutateDailyStandards,true);
  const daily=values(asActor(`select public.get_daily_action_bootstrap('${actor}','UTC',null);`))[0];
  assert.equal(daily.appAccess,true);assert.equal(daily.activation.canMutateDailyStandards,true);
  assert.deepEqual(daily.activation.originalProgress,{
    schemaVersion:1,userId:actor,instanceId:`original77:${daily.activation.startDate}`,
    targetCount:77,submittedCount:0,completionState:'in_progress',canonicalEvent:null,
  });
  assert.equal(daily.activation.canEditStartDate,true);
  const activation=values(asActor(`select public.get_challenge_activation_v2('${actor}');`))[0];
  const instanceId=activation.currentInstance.id;
  assert.equal(activation.schemaVersion,2);assert.equal(activation.actorId,actor);
  assert.match(instanceId,/^[a-f0-9-]{36}$/);
  assert.equal(activation.currentInstance.challengeKey,'original_77');
  assert.equal(activation.currentInstance.targetCount,77);
  assert.equal(activation.currentInstance.submittedCount,0);
  const current=values(asActor(`select public.get_daily_action_bootstrap_v2('${actor}','UTC',null,'${instanceId}');`))[0];
  assert.equal(current.schemaVersion,2);assert.equal(current.actorId,actor);
  assert.equal(current.appAccess,true);assert.equal(current.instanceId,instanceId);
  assert.equal(current.activation.currentInstance.id,instanceId);assert.equal(current.draft.locked,false);
  expectActorError(`select public.get_daily_action_bootstrap_v2('${other}','UTC',null,'${instanceId}');`,/40001|signed-in account changed/);
  expectActorError(`select public.get_daily_action_bootstrap_v2('${actor}','UTC',null,'${randomUUID()}');`,/40001|challenge instance changed/);
  values(asActor(`select public.mutate_daily_standard_draft_v2('${current.entryDate}','walk',true,${current.draft.version},'${actor}','${instanceId}');`));
  revoke();
  const after=values(asActor(`select public.get_daily_action_bootstrap('${actor}','UTC',null);`))[0];
  assert.equal(after.appAccess,false);assert.equal(after.draft,null);
  assert.equal(values(`select public.challenge_activation_payload_for_user('${actor}');`)[0].canMutateDailyStandards,false);
  const revoked=values(asActor(`select public.get_daily_action_bootstrap_v2('${actor}','UTC',null,'${instanceId}');`))[0];
  assert.equal(revoked.appAccess,false);assert.equal(revoked.draft,null);assert.equal(revoked.activation,null);
  expectActorError(`select public.mutate_daily_standard_draft_v2('${current.entryDate}','walk',false,null,'${actor}','${instanceId}');`,/42501|membership/);
  assert.deepEqual(values(`select to_jsonb(completed) from public.challenge_entries where user_id='${actor}' and entry_date='${current.entryDate}';`),[['walk']],
    'Revoked access cannot mutate an already saved current-run draft.');
});

test('all EA readers fail closed on unconfigured programs and unhealthy accounts',()=>{
  qualify();seedCrew();
  for(const change of ["update private.early_access_programs set configured=false;",
    `update auth.users set email_confirmed_at=null where id='${actor}';`,
    `update auth.users set is_anonymous=true where id='${actor}';`,
    `update auth.users set banned_until='2200-01-01' where id='${actor}';`,
    `update auth.users set deleted_at=now() where id='${actor}';`]){
    const output=values(`begin;${change}
      select to_jsonb(private.crew_invite_issuer_is_authorized('${crew}','${actor}'));
      ${asActor("select to_jsonb(public.has_active_entitlement('membership_active'));")}reset role;rollback;`);
    assert.deepEqual(output,[false,false]);
  }
});

for(const scenario of ['issue','confirm-issuer','confirm-recipient','profile']){
  test(`${scenario}: committed revocation wins after an authority row wait`,async()=>{
    qualify();qualify(other);seedCrew();
    let requestSql;
    if(scenario==='issue')requestSql=asActor(`select public.issue_crew_invite_bundle('${crew}');`);
    else if(scenario==='profile')requestSql=progressRead();
    else requestSql=asActor(`select public.confirm_crew_invite(${literal(continuation())});`,other);
    const revoked=scenario==='confirm-recipient'?other:actor;
    const result=await raceAfterLock(`update private.early_access_grants set revoked_at=clock_timestamp(),revision=revision+1 where user_id='${revoked}';`,requestSql);
    if(scenario==='profile'){
      assert.notEqual(result.code,0);assert.match(result.error,/Member progress is no longer available/);
    }else{
      assert.equal(result.code,0,result.error);
      assert.equal(JSON.parse(result.output.trim()).status,scenario==='issue'?'forbidden':scenario==='confirm-recipient'?'subscription_required':'invalid');
    }
    assert.deepEqual(values(`select to_jsonb(count(*)) from public.crew_members where user_id='${other}';`),[0]);
  });
}

for(const scenario of ['issue','confirm','profile-authority','profile-crew']){
  test(`${scenario}: beta expiry during a lock wait uses the post-wait clock`,async()=>{
    qualify();qualify(other);seedCrew();
    let requestSql;
    if(scenario==='issue')requestSql=asActor(`select public.issue_crew_invite_bundle('${crew}');`);
    else if(scenario==='confirm')requestSql=asActor(`select public.confirm_crew_invite(${literal(continuation())});`,other);
    else requestSql=progressRead();
    sql("update private.early_access_programs set beta_starts_at=clock_timestamp()+interval '2 seconds';");
    const held=scenario==='profile-crew'?`select 1 from public.crews where id='${crew}' for update;`:
      `select 1 from private.early_access_grants where user_id='${actor}' for update;`;
    const result=await raceAfterLock(held,requestSql,{waitUntilBeta:true});
    if(scenario.startsWith('profile')){
      assert.notEqual(result.code,0);assert.match(result.error,/Member progress is no longer available/);
    }else{
      assert.equal(result.code,0,result.error);
      assert.equal(JSON.parse(result.output.trim()).status,scenario==='issue'?'forbidden':'invalid');
    }
  });
}

test('existing challenge and crew pgTAP suites retain their legacy behavior',async()=>{
  sql(await readFile(new URL('../supabase/seed.sql',import.meta.url),'utf8'));
  const files=['030_private_group_invites.sql','120_challenge_activation.sql','150_crew_member_progress_profile.sql','160_crew_invite_codes.sql','260_scoped_member_badge_pagination.sql'];
  for(const name of files){
    const text=await readFile(new URL(`../supabase/tests/database/${name}`,import.meta.url),'utf8');
    const result=sql(text);assert.doesNotMatch(result,/^not ok/m,`${name}\n${result}`);
    const plan=Number(text.match(/select plan\((\d+)\)/)?.[1]);
    assert.ok(plan>0);assert.equal((result.match(/^ok \d+/gm)||[]).length,plan,`${name}\n${result}`);
  }
});
