import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

// Explicit latest-source wrapper; the shared helper still executes only its
// pinned first70. All history here is synthetic constructor data, not a replay
// or backfill of member data. Cutover preservation is a separate test suite.
const migrationUrl = new URL('../supabase/migrations/20261001001245_repeatable_challenge_instances_v2.sql', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const q = value => `'${String(value).replaceAll("'", "''")}'`;
let fixture, sourceHash, beforeCutover;
const cutoverActor = randomUUID();
const cutoverSnapshotSql = () => `select jsonb_build_object(
  'profile',(select to_jsonb(p) from public.profiles p where p.user_id=${q(cutoverActor)}),
  'stats',(select to_jsonb(s) from public.user_game_stats s where s.user_id=${q(cutoverActor)}),
  'drafts',(select jsonb_agg(to_jsonb(e)-'challenge_instance_id') from public.challenge_entries e where e.user_id=${q(cutoverActor)}),
  'rewards',(select jsonb_agg(to_jsonb(e) order by reward_key) from public.user_reward_entitlements e where e.user_id=${q(cutoverActor)}),
  'challenges',(select jsonb_agg(to_jsonb(s) order by challenge_key) from public.user_challenge_states s where s.user_id=${q(cutoverActor)}))`;
before(async () => {
  const source = await readFile(migrationUrl, 'utf8'); sourceHash = digest(source);
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  fixture.queryAsBootstrap(`begin;set local session_replication_role=replica;
    insert into auth.users(id,email) values(${q(cutoverActor)},'cutover-preservation@example.test');
    insert into public.profiles(user_id,name,email) values(${q(cutoverActor)},'Preserved','cutover-preservation@example.test');
    insert into public.entitlements(user_id,entitlement_key,status,source_type) values(${q(cutoverActor)},'membership_active','active','testing');
    insert into public.user_game_stats(user_id,total_points) values(${q(cutoverActor)},10000);
    insert into public.user_reward_entitlements(user_id,reward_key,owned_at,metadata)
      values(${q(cutoverActor)},'dominion_night_theme','2026-01-02T12:34:56.123456Z','{"original":true}');
    insert into public.user_challenge_states(user_id,challenge_key,unlock_points,unlocked_at,metadata)
      values(${q(cutoverActor)},'twenty_one_day_prayer',336,'2026-01-03T12:34:56.123456Z','{"original":true}');
    insert into public.challenge_entries(user_id,entry_date,completed,version,updated_at)
      values(${q(cutoverActor)},current_date-1,array['walk'],5,'2026-01-04T12:34:56.123456Z');commit;`);
  beforeCutover = fixture.query(cutoverSnapshotSql());
  fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;${source}commit;`);
});
after(async () => {
  try { assert.equal(digest(await readFile(migrationUrl, 'utf8')), sourceHash, 'Migration changed during runtime verification.'); }
  finally { fixture?.close(); }
});
function actorSql(actor, statement) {
  return `begin;set local role authenticated;set local statement_timeout='8s';set local lock_timeout='5s';
    set local request.jwt.claim.sub=${q(actor)};set local request.jwt.claims=${q(JSON.stringify({ sub: actor, role: 'authenticated' }))};
    ${statement};commit;`;
}
const call = (actor, statement) => JSON.parse(fixture.queryAsBootstrap(actorSql(actor, statement)).split('\n').at(-1));
const callAsync = async (actor, statement) => JSON.parse((await fixture.queryAsBootstrapAsync(actorSql(actor, statement))).split('\n').at(-1));
const activation = actor => call(actor, `select public.get_challenge_activation_v2(${q(actor)})`);
const draft = (actor, instance) => call(actor, `select public.mutate_daily_standard_draft_v2(current_date,'walk',true,0,${q(actor)},${q(instance)})`);
const submitSql = (actor, instance) => `select public.submit_daily_check_in_v2('complete',array['bible'],'{}','UTC',current_date,${q(actor)},${q(instance)})`;
const startSql = (actor, observed, key, request = randomUUID()) => `select public.start_challenge_instance_v2(${q(key)},current_date,'UTC',${q(request)},${q(actor)},${q(observed.currentInstance.id)},${observed.revision})`;
function seed({ key = 'original_77', target = 77, submitted = target - 1, priorOriginal = false, completed = false } = {}) {
  const actor = randomUUID(), instance = randomUUID(), prior = randomUUID();
  const title = { original_77: '77-Day Dominion Challenge', seven_day_reset: '7-Day Reset', twenty_one_day_prayer: '21-Day Prayer Track',
    thirty_day_strength: '30-Day Strength Intensive', forty_day_fast: '40-Day Fasting & Prayer Track', bible_in_a_year: 'Bible in a Year' }[key];
  const offset = target + 10;
  fixture.queryAsBootstrap(`begin;set local session_replication_role=replica;
    insert into auth.users(id,email) values(${q(actor)},${q(`${actor}@example.test`)});
    insert into public.profiles(user_id,name,email,challenge_start_date,time_zone,challenge_activation_status,
      challenge_participation_mode,challenge_activation_time_zone,challenge_activation_schema_version,
      challenge_activated_at,challenge_confirmed_at,challenge_activated_by,challenge_confirmed_by)
      values(${q(actor)},'Synthetic',${q(`${actor}@example.test`)},current_date-${priorOriginal ? 1000 : offset},'UTC','active','solo','UTC',1,now(),now(),${q(actor)},${q(actor)});
    insert into public.entitlements(user_id,entitlement_key,status,source_type) values(${q(actor)},'membership_active','active','testing');
    ${priorOriginal ? `insert into private.challenge_instances(id,user_id,challenge_key,title,scope_key,sequence_no,status,start_date,time_zone,participation_mode,target_count,provenance)
      values(${q(prior)},${q(actor)},'original_77','77-Day Dominion Challenge','original77:'||(current_date-1000)::text,0,'completed',current_date-1000,'UTC','solo',77,'legacy_completed');
      insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,completed,points_awarded,challenge_instance_id)
        select ${q(actor)},current_date-1000+n,n+1,'partial',1,array['walk'],1,${q(prior)} from generate_series(0,76) n;
      insert into public.user_badges(user_id,badge_key,scope_key,entry_date,earned_at,metadata)
        values(${q(actor)},'original_77_completed','original77:'||(current_date-1000)::text,current_date-924,now()-interval '924 days','{"legacy":true}');` : ''}
    insert into private.challenge_instances(id,user_id,challenge_key,title,scope_key,sequence_no,status,start_date,time_zone,participation_mode,target_count,provenance)
      values(${q(instance)},${q(actor)},${q(key)},${q(title)},${key === 'original_77' && !priorOriginal ? `'original77:'||(current_date-${offset})::text` : q(`instance:${instance}`)},${priorOriginal || key !== 'original_77' ? 1 : 0},
        ${q(completed ? 'completed' : 'active')},current_date-${offset},'UTC','solo',${target},${q(completed ? 'legacy_completed' : 'live')});
    insert into private.challenge_runtime(user_id,current_instance_id) values(${q(actor)},${q(instance)});
    insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,completed,points_awarded,challenge_instance_id)
      select ${q(actor)},current_date-${offset}+n,n+1,'partial',1,array['walk'],1,${q(instance)} from generate_series(0,${submitted - 1}) n;
    ${key === 'original_77' ? '' : `insert into public.user_challenge_states(user_id,challenge_key,status,unlock_points,started_at,completed_at)
      values(${q(actor)},${q(key)},${q(completed ? 'completed' : 'active')},0,now()-interval '${offset} days',${completed ? 'now()' : 'null'});`}
    commit;`);
  return { actor, instance, prior };
}

test('catalog cutover preserves prior grants, point totals and draft bytes without an automatic grant backfill', () => {
  assert.equal(fixture.query(cutoverSnapshotSql()), beforeCutover);
  assert.equal(fixture.query(`select count(*) from public.user_reward_entitlements where user_id=${q(cutoverActor)}`), '1');
  assert.equal(fixture.query(`select count(*) from private.reward_grant_preservation where user_id=${q(cutoverActor)}`), '2');
  assert.equal(fixture.query(`select count(*) from public.game_point_events where user_id=${q(cutoverActor)}`), '0');
});

test('first original: partial #77 after calendar77 preserves source and earns one legacy-scoped live Finisher', () => {
  const { actor, instance } = seed();
  const beforeProfile = fixture.query(`select to_jsonb(p) from public.profiles p where user_id=${q(actor)}`);
  draft(actor, instance);
  const result = call(actor, submitSql(actor, instance));
  assert.equal(result.status, 'partial'); assert.equal(result.completed_count, 1); assert.equal(result.points_awarded, 1);
  assert.equal(result.challenge_day, 88); assert.equal(result.activation.currentInstance.submittedCount, 77);
  assert.equal(result.activation.currentInstance.status, 'completed');
  assert.equal(fixture.query(`select to_jsonb(p) from public.profiles p where user_id=${q(actor)}`), beforeProfile);
  assert.equal(fixture.query(`select count(*) from private.original_77_completion_events where user_id=${q(actor)}`), '1');
  assert.equal(fixture.query(`select count(*) from private.challenge_instance_completions where user_id=${q(actor)}`), '1');
  assert.equal(fixture.query(`select count(*) from public.user_badges where user_id=${q(actor)} and badge_key='original_77_completed'`), '1');
  const started = call(actor, startSql(actor, result.activation, 'original_77'));
  assert.equal(started.activation.currentInstance.scopeKey, `instance:${started.instanceId}`);
  assert.equal(started.activation.currentInstance.submittedCount, 0);
  assert.throws(() => draft(actor, instance), /instance changed/i);
  assert.throws(() => draft(actor, started.instanceId), /already submitted/i);
});

test('second original gets its own Finisher without replacing first-run badge/history', () => {
  const { actor, instance } = seed({ priorOriginal: true });
  const historical = fixture.query(`select jsonb_agg(to_jsonb(b) order by id) from public.user_badges b where user_id=${q(actor)}`);
  draft(actor, instance); const result = call(actor, submitSql(actor, instance));
  assert.equal(result.activation.currentInstance.scopeKey, `instance:${instance}`);
  assert.equal(fixture.query(`select count(*) from public.check_ins where user_id=${q(actor)}`), '154');
  assert.equal(fixture.query(`select count(*) from public.user_badges where user_id=${q(actor)} and badge_key='original_77_completed'`), '2');
  assert.equal(fixture.query(`select jsonb_agg(to_jsonb(b) order by id) from public.user_badges b where user_id=${q(actor)} and scope_key like 'original77:%'`), historical);
  assert.equal(fixture.query(`select count(*) from private.original_77_completion_events where user_id=${q(actor)}`), '0');
});

for (const [key, target, successor] of [['seven_day_reset', 7, 'twenty_one_day_prayer'], ['twenty_one_day_prayer', 21, 'thirty_day_strength'],
  ['thirty_day_strength', 30, 'forty_day_fast'], ['forty_day_fast', 40, 'bible_in_a_year'], ['bible_in_a_year', 365, null]]) {
  test(`${key}: final partial completes exact target and grants only immediate successor`, () => {
    const { actor, instance } = seed({ key, target }); draft(actor, instance);
    const result = call(actor, submitSql(actor, instance));
    assert.equal(result.activation.currentInstance.status, 'completed'); assert.equal(result.activation.currentInstance.submittedCount, target);
    const available = JSON.parse(fixture.query(`select coalesce(jsonb_agg(challenge_key order by challenge_key),'[]') from public.user_challenge_states where user_id=${q(actor)} and status='available'`));
    assert.deepEqual(available, successor ? [successor] : []);
    if (successor) assert.equal(fixture.query(`select unlock_points is null from public.user_challenge_states where user_id=${q(actor)} and challenge_key=${q(successor)}`), 't');
    assert.equal(fixture.query(`select count(*) from public.user_badges where user_id=${q(actor)} and badge_key='original_77_completed'`), '0');
  });
}

test('same-instance concurrent submissions persist one source/event/award and one point', async () => {
  const { actor, instance } = seed(); draft(actor, instance);
  const results = await Promise.allSettled([callAsync(actor, submitSql(actor, instance)), callAsync(actor, submitSql(actor, instance))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(fixture.query(`select count(*) from public.game_point_events where user_id=${q(actor)} and event_type='check_in'`), '1');
  assert.equal(fixture.query(`select count(*) from private.challenge_instance_completions where user_id=${q(actor)}`), '1');
});

test('concurrent distinct Starts have one winner; same request replays exact instance', async () => {
  const { actor } = seed({ submitted: 77, completed: true }); const observed = activation(actor);
  const one = startSql(actor, observed, 'original_77'), two = startSql(actor, observed, 'original_77');
  const results = await Promise.allSettled([callAsync(actor, one), callAsync(actor, two)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(fixture.query(`select count(*) from private.challenge_instances where user_id=${q(actor)} and status in ('scheduled','active')`), '1');
  const winner = results.find(r => r.status === 'fulfilled').value;
  const replay = call(actor, results[0].status === 'fulfilled' ? one : two);
  assert.equal(replay.instanceId, winner.instanceId); assert.equal(replay.replayed, true);
});

test('typed thresholds, immutable pagination snapshot and private grants fail closed', () => {
  const { actor, instance } = seed({ submitted: 0 });
  assert.throws(() => fixture.query("begin;update public.reward_definitions set points_required=null where reward_key='dominion_night_theme';commit;"), /reward_definition_unlock_rule_v2/);
  const first = call(actor, `select public.get_reward_catalog_v2(2,null,null,${q(actor)},null,null,null)`);
  assert.match(first.snapshotVersion, /^[a-f0-9]{64}$/);
  const next = call(actor, `select public.get_reward_catalog_v2(2,${first.page.nextCursor.sortOrder},${q(first.page.nextCursor.key)},${q(actor)},${first.revision},${first.catalogVersion},${q(first.snapshotVersion)})`);
  assert.equal(next.snapshotVersion, first.snapshotVersion);
  assert.throws(() => call(actor, `select public.get_reward_catalog_v2(2,${first.page.nextCursor.sortOrder},${q(first.page.nextCursor.key)},${q(actor)},${first.revision},${first.catalogVersion},null)`), /catalog changed/i);
  assert.throws(() => call(actor, `select public.get_challenge_activation_v2(${q(randomUUID())})`), /account changed/i);
  assert.throws(() => call(actor, 'select * from private.challenge_instances'), /permission denied/);
  assert.throws(() => call(actor, `select public.submit_daily_check_in('partial',array['walk'],'{}','UTC',current_date,${q(actor)})`), /instance-bound/);
  assert.throws(() => call(actor, `select public.mutate_daily_standard_draft_v2(current_date,'walk',true,0,${q(actor)},null)`), /instance changed/i);
  assert.equal(activation(actor).currentInstance.id, instance);
});

test('six point rules only; unreleased ownership stays ungranted and lifetime points never grant completion tracks', () => {
  const { actor } = seed({ submitted: 77, completed: true });
  const thresholds = JSON.parse(fixture.query("select jsonb_object_agg(reward_key,points_required) from public.reward_definitions where unlock_rule_type<>'challenge_completion'"));
  assert.deepEqual(thresholds, { gym_training_discount: 42, dominion_night_theme: 112, nehemiah_leadership_handbook: 210,
    dominion_platinum: 308, seven_day_reset: 420, big_god_energy_tshirt_discount: 532 });
  fixture.query(`begin;update public.reward_definitions set released=false where state_model='ownership';
    select public.ensure_user_game_stats(${q(actor)});update public.user_game_stats set total_points=10000 where user_id=${q(actor)};commit;`);
  call(actor, `select public.get_reward_catalog_v2(100,null,null,${q(actor)},null,null,null)`);
  assert.equal(fixture.query(`select count(*) from public.user_reward_entitlements where user_id=${q(actor)}`), '0');
  assert.equal(fixture.query(`select string_agg(challenge_key,',') from public.user_challenge_states where user_id=${q(actor)}`), 'seven_day_reset');
  assert.equal(fixture.query(`select public.grant_reward_entitlement(${q(actor)},'dominion_night_theme')`), 'f');
  assert.throws(() => fixture.query(`select public.backfill_reward_entitlements('dominion_night_theme')`), /active ownership reward/i);
  fixture.query("update public.reward_definitions set released=true where state_model='ownership'");
  const catalog = call(actor, `select public.get_reward_catalog_v2(100,null,null,${q(actor)},null,null,null)`);
  assert.equal(catalog.items.find(i => i.key === 'gym_training_discount').status, 'locked');
  assert.equal(catalog.items.find(i => i.key === 'dominion_night_theme').status, 'owned');
  for (const item of catalog.items.filter(i => i.requirement.type === 'challenge_completion')) {
    assert.equal(item.status, 'locked'); assert.equal(item.requirement.satisfied, false);
    for (const key of ['pointsRequired', 'currentPoints', 'pointsRemaining', 'progressPercent']) assert.equal(item[key], null);
  }
});

test('explicit preserved grant remains usable without new predecessor, but cannot bypass its required entitlement', () => {
  const { actor } = seed({ submitted: 77, completed: true });
  fixture.query(`insert into public.user_challenge_states(user_id,challenge_key,unlock_points) values(${q(actor)},'twenty_one_day_prayer',336);
    insert into private.reward_grant_preservation(user_id,reward_key,catalog_version,reason,prior_state)
      select user_id,challenge_key,1,'catalog_v1_preserved',to_jsonb(s) from public.user_challenge_states s
      where user_id=${q(actor)} and challenge_key='twenty_one_day_prayer';
    update public.reward_definitions set required_entitlement_key='synthetic_missing_access' where reward_key='twenty_one_day_prayer';`);
  const observed = activation(actor);
  assert.throws(() => call(actor, startSql(actor, observed, 'twenty_one_day_prayer')), /required challenge entitlement/i);
  fixture.query("update public.reward_definitions set required_entitlement_key='membership_active' where reward_key='twenty_one_day_prayer'");
  const catalog = call(actor, `select public.get_reward_catalog_v2(100,null,null,${q(actor)},null,null,null)`);
  const prayer = catalog.items.find(i => i.key === 'twenty_one_day_prayer');
  assert.deepEqual(prayer.grantProvenance, { type: 'legacy_preserved', catalogVersion: 1 });
  assert.equal(prayer.requirement.satisfied, false); assert.deepEqual(prayer.allowedActions, ['start']);
  const started = call(actor, startSql(actor, observed, 'twenty_one_day_prayer'));
  assert.equal(started.activation.currentInstance.challengeKey, 'twenty_one_day_prayer');
});

test('new storage is private/forced RLS and V2 execution is authenticated-only', () => {
  for (const table of ['challenge_instances', 'challenge_runtime', 'challenge_instance_completions', 'challenge_instance_requests', 'reward_grant_preservation']) {
    assert.equal(fixture.query(`select relrowsecurity and relforcerowsecurity from pg_class where oid=${q(`private.${table}`)}::regclass`), 't');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(fixture.query(`select has_table_privilege(${q(role)},${q(`private.${table}`)},'SELECT,INSERT,UPDATE,DELETE')`), 'f');
    }
  }
  const functions = ['get_challenge_activation_v2(uuid)', 'get_challenge_check_ins_v2(uuid,uuid)',
    'get_daily_action_bootstrap_v2(uuid,text,date,uuid)', 'start_challenge_instance_v2(text,date,text,uuid,uuid,uuid,bigint)',
    'submit_daily_check_in_v2(text,text[],jsonb,text,date,uuid,uuid)', 'get_reward_catalog_v2(integer,integer,text,uuid,bigint,bigint,text)'];
  for (const signature of functions) {
    assert.equal(fixture.query(`select has_function_privilege('anon',${q(`public.${signature}`)},'EXECUTE')`), 'f');
    assert.equal(fixture.query(`select has_function_privilege('authenticated',${q(`public.${signature}`)},'EXECUTE')`), 't');
    assert.equal(fixture.query(`select proconfig@>array['search_path=""'] from pg_proc where oid=${q(`public.${signature}`)}::regprocedure`), 't');
  }
});

test('date edits require current membership and runtime review blocks every new mutation', () => {
  const { actor, instance } = seed({ submitted: 0 });
  const edit = observed => `select public.set_challenge_start_date_v2(current_date,'UTC',${q(randomUUID())},${observed.revision},${q(actor)},${q(instance)})`;
  const observed = activation(actor);
  fixture.query(`update public.entitlements set ends_at=now()-interval '1 second' where user_id=${q(actor)}`);
  assert.equal(activation(actor).canEditStartDate, false);
  assert.throws(() => call(actor, edit(observed)), /active membership/i);
  fixture.query(`update public.entitlements set ends_at=null where user_id=${q(actor)};
    update private.challenge_runtime set review_required=true,review_reason='synthetic_conflict' where user_id=${q(actor)}`);
  const reviewed = activation(actor);
  assert.equal(reviewed.reviewRequired, true); assert.equal(reviewed.currentInstance.reviewRequired, true);
  for (const capability of ['canParticipate', 'canMutateDailyStandards', 'canEditStartDate', 'canActivateSolo', 'canActivateGroup']) {
    assert.equal(reviewed[capability], false);
  }
  assert.throws(() => draft(actor, instance), /history needs review/i);
  assert.throws(() => call(actor, submitSql(actor, instance)), /history needs review/i);
  assert.throws(() => call(actor, edit(reviewed)), /history needs review/i);
  assert.throws(() => call(actor, startSql(actor, reviewed, 'original_77')), /history needs review/i);
  assert.equal(fixture.query(`select count(*) from public.check_ins where user_id=${q(actor)}`), '0');
  assert.equal(fixture.query(`select count(*) from private.challenge_instance_requests where user_id=${q(actor)}`), '0');
});

test('missing group membership closes participation and cannot be bypassed through direct Daily Action RPCs', () => {
  const { actor, instance } = seed({ submitted: 0 });
  fixture.query(`update private.challenge_instances set participation_mode='group',crew_id=${q(randomUUID())} where id=${q(instance)}`);
  const observed = activation(actor);
  assert.equal(observed.groupMembershipActive, false);
  assert.equal(observed.canParticipate, false);
  assert.equal(observed.canMutateDailyStandards, false);
  assert.throws(() => draft(actor, instance), /crew membership/i);
  assert.throws(() => call(actor, submitSql(actor, instance)), /crew membership/i);
  assert.equal(fixture.query(`select count(*) from public.challenge_entries where user_id=${q(actor)}`), '0');
});

test('actual legacy overload ACLs cannot bypass captured actors or instances', () => {
  const absentOrPrivate = [
    'mutate_daily_standard_draft(date,text,boolean,bigint)',
    'set_daily_standard_workout_difficulty(date,text,text,bigint)',
    'submit_daily_check_in(text,text[],jsonb,text,date)', 'bootstrap_daily_standard_time_zone(text)',
    'mutate_daily_standard_draft_pre_activation(date,text,boolean,bigint)',
    'set_daily_standard_workout_difficulty_pre_activation(date,text,text,bigint)',
    'submit_daily_check_in_pre_activation(text,text[],jsonb,text,date)',
    'bootstrap_daily_standard_time_zone_pre_activation(text)',
  ];
  for (const signature of absentOrPrivate) {
    const existing = fixture.query(`select to_regprocedure(${q(`public.${signature}`)}) is not null`);
    if (existing === 'f') continue;
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(fixture.query(`select has_function_privilege(${q(role)},${q(`public.${signature}`)},'EXECUTE')`), 'f', `${role}: ${signature}`);
    }
  }
  for (const signature of ['bootstrap_daily_standard_time_zone(text,uuid)', 'activate_solo_challenge(date,text,uuid,uuid)',
    'activate_group_challenge(uuid,text,uuid,uuid)', 'create_crew_and_activate_group(uuid,uuid,text,text,date,text,uuid)']) {
    assert.equal(fixture.query(`select has_function_privilege('authenticated',${q(`public.${signature}`)},'EXECUTE')`), 't', signature);
  }
  const { actor } = seed({ submitted: 0 });
  for (const statement of [
    `select public.mutate_daily_standard_draft(current_date,'walk',true,0,${q(actor)})`,
    `select public.set_daily_standard_workout_difficulty(current_date,'one','hard',0,${q(actor)})`,
    `select public.submit_daily_check_in('partial',array['walk'],'{}','UTC',current_date,${q(actor)})`,
    `select public.set_challenge_start_date(current_date,'UTC',${q(randomUUID())},0,${q(actor)})`,
    `select public.start_challenge('seven_day_reset',${q(actor)})`, `select public.start_challenge('seven_day_reset')`,
  ]) assert.throws(() => call(actor, statement), /instance-bound/);
});

test('runtime storage rejects invalid shape, finite bounds, definition identity and weak request hashes', () => {
  const { actor, instance } = seed({ submitted: 0 });
  const rejectUpdate = (table, update, predicate) => assert.throws(() => fixture.query(`begin;update ${table} set ${update} where ${predicate};set constraints all immediate;rollback;`), /constraint|foreign key/i);
  for (const update of ["review_required=true,review_reason=null", "review_required=true,review_reason=' '", "review_required=false,review_reason='unexpected'"]) {
    rejectUpdate('private.challenge_runtime', update, `user_id=${q(actor)}`);
  }
  for (const update of ["challenge_key='unknown_track'", 'target_count=366', "created_at='infinity'", "start_date='infinity'"]) {
    rejectUpdate('private.challenge_instances', update, `id=${q(instance)}`);
  }
  const request = (hash, result, created = 'now()') => `insert into private.challenge_instance_requests(request_id,user_id,action,request_hash,result,created_at)
    values(${q(randomUUID())},${q(actor)},'set_start',${hash},${result},${created})`;
  for (const statement of [request("decode('aa','hex')", "'{}'"), request("decode(repeat('aa',32),'hex')", "'[]'"),
    request("decode(repeat('aa',32),'hex')", "'{}'", "'infinity'")]) {
    assert.throws(() => fixture.query(statement), /check constraint/i);
  }
  assert.throws(() => fixture.query(`insert into private.challenge_instance_completions(user_id,instance_id,source_check_in_id,local_date,completed_at,target_count)
    values(${q(actor)},${q(instance)},${q(randomUUID())},'infinity',now(),77)`), /check constraint/i);
});

test('completion foreign keys bind source and event to the exact owner and run', () => {
  const one = seed({ submitted: 1, priorOriginal: true }), other = seed({ submitted: 1 });
  const sourceFor = instance => fixture.query(`select id from public.check_ins where challenge_instance_id=${q(instance)} order by entry_date limit 1`);
  for (const source of [sourceFor(other.instance), sourceFor(one.prior)]) {
    assert.throws(() => fixture.query(`begin;insert into private.challenge_instance_completions(user_id,instance_id,source_check_in_id,local_date,completed_at,target_count)
      values(${q(one.actor)},${q(one.instance)},${q(source)},current_date,now(),77);set constraints all immediate;commit;`), /foreign key constraint/i);
  }
  const completed = seed(); draft(completed.actor, completed.instance); call(completed.actor, submitSql(completed.actor, completed.instance));
  const event = fixture.query(`select id from private.challenge_instance_completions where instance_id=${q(completed.instance)}`);
  assert.throws(() => fixture.query(`begin;update private.challenge_instances set status='completed',completed_at=now(),completion_event_id=${q(event)}
    where id=${q(one.instance)};set constraints all immediate;commit;`), /foreign key constraint/i);
});

test('standalone run deletion cannot erase history, while Auth-parent erasure still removes all owned runtime rows', () => {
  const { actor, instance } = seed(); draft(actor, instance); call(actor, submitSql(actor, instance));
  const before = fixture.query(`select jsonb_agg(to_jsonb(c) order by entry_date) from public.check_ins c where user_id=${q(actor)}`);
  assert.throws(() => fixture.query(`begin;delete from private.challenge_instances where id=${q(instance)};set constraints all immediate;commit;`), /foreign key constraint/i);
  assert.equal(fixture.query(`select jsonb_agg(to_jsonb(c) order by entry_date) from public.check_ins c where user_id=${q(actor)}`), before);
  assert.equal(fixture.query(`select count(*) from private.challenge_instance_completions where user_id=${q(actor)}`), '1');
  fixture.queryAsBootstrap(`begin;delete from auth.users where id=${q(actor)};set constraints all immediate;commit;`);
  for (const table of ['private.challenge_instances', 'private.challenge_runtime', 'private.challenge_instance_completions',
    'private.challenge_instance_requests', 'private.reward_grant_preservation', 'public.check_ins', 'public.challenge_entries']) {
    assert.equal(fixture.query(`select count(*) from ${table} where user_id=${q(actor)}`), '0', table);
  }
});

test('reward audit and sync triggers include every V2 rule field', () => {
  for (const trigger of ['audit_reward_definition_change', 'sync_reward_definition_entitlements']) {
    const definition = fixture.query(`select pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.reward_definitions'::regclass and tgname=${q(trigger)}`);
    for (const column of ['unlock_rule_type', 'prerequisite_challenge_key', 'phase', 'released']) assert.ok(definition.includes(column), `${trigger}: ${column}`);
  }
  const row = JSON.parse(fixture.query(`begin;update public.reward_definitions set released=false where reward_key='bible_in_a_year';
    select metadata from private.reward_audit_events where reward_key='bible_in_a_year' and metadata->'released'='false'::jsonb order by id desc limit 1;rollback;`));
  assert.equal(row.unlockRuleType, 'challenge_completion'); assert.equal(row.prerequisiteChallengeKey, 'forty_day_fast');
  assert.equal(row.phase, 'post_core'); assert.equal(row.released, false); assert.equal(row.pointsRequired, null);
});
