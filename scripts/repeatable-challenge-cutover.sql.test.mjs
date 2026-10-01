import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

// Synthetic history only, in the owned no-network first70 fixture. No hosted
// data, credentials, historical replay, or altered frozen migration is used.
const migrationUrl = new URL('../supabase/migrations/20261001001245_repeatable_challenge_instances_v2.sql', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const ids = Object.fromEntries(['inert', 'draft', 'partial', 'scheduled', 'overdue', 'group', 'historical77',
  'event77', 'later', 'laterCompleted', 'available', 'invalidRows', 'tooMany', 'invalidZone', 'review',
  'orphanHistory', 'conflict', 'twoActive', 'invalidLater'].map(key => [key, randomUUID()]));
const crew = randomUUID(), oldEvent = randomUUID(), destination = randomUUID();
let fixture, source, sourceHash, preserved;
const tables = ['public.profiles', 'public.check_ins', 'public.challenge_entries', 'public.user_game_stats',
  'public.game_point_events', 'public.user_reward_entitlements', 'public.user_challenge_states', 'public.user_badges',
  'private.original_77_completion_events', 'public.community_feed_items', 'private.outbound_deliveries',
  'public.outbound_update_preferences', 'public.outbound_update_preference_audit', 'public.entitlements',
  'public.crews', 'public.crew_members', 'private.badge_app_visits', 'private.challenge_activation_requests',
  'private.challenge_activation_migration_reviews', 'private.integration_destinations'];
function snapshot(db = fixture) {
  return JSON.parse(db.query(`select jsonb_build_object(${tables.map(table => `${q(table)},
    (select coalesce(jsonb_agg(row_json order by row_json::text),'[]'::jsonb) from
      (select to_jsonb(t)-'challenge_instance_id' row_json from ${table} t) rows)`).join(',')})`));
}
function seedSql(actor, { status = 'active', submitted = 0, zone = 'UTC', mode = 'solo', start = 'current_date-160',
  review = false, badActions = false } = {}) {
  const active = status !== 'not_started';
  return `insert into auth.users(id,email) values(${q(actor)},${q(`${actor}@example.test`)});
    insert into public.profiles(user_id,name,email,time_zone,challenge_start_date,challenge_activation_status,
      challenge_participation_mode,challenge_activation_time_zone,challenge_group_attribution_crew_id,
      challenge_activated_at,challenge_confirmed_at,challenge_activated_by,challenge_confirmed_by,
      challenge_activation_revision,challenge_activation_review_required)
    values(${q(actor)},'Synthetic history',${q(`${actor}@example.test`)},'UTC',${active ? start : 'null'},${q(status)},
      ${active ? q(mode) : 'null'},${active ? q(zone) : 'null'},${mode === 'group' ? q(crew) : 'null'},
      ${status === 'active' ? "now()-interval '200 days'" : 'null'},${active ? "now()-interval '200 days'" : 'null'},
      ${status === 'active' ? q(actor) : 'null'},${active ? q(actor) : 'null'},${active ? 3 : 0},${review});
    insert into public.entitlements(user_id,entitlement_key,status,source_type)
      values(${q(actor)},'membership_active','active','testing');
    insert into public.user_game_stats(user_id,total_points) values(${q(actor)},${submitted + 11});
    ${submitted ? `insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,completed,points_awarded,created_at)
      select ${q(actor)},${start}+2*n,2*n+1,'partial',1,array[${q(badActions ? 'invalidSyntheticAction' : 'walk')}],1,
        ((${start}+2*n)::timestamp at time zone 'UTC')+interval '12 hours 34 minutes 56.123456 seconds'
      from generate_series(0,${submitted - 1}) n;` : ''}`;
}
function legacySql(actor, key, status, started = "now()-interval '6 days'", completed = "now()-interval '1 day'") {
  return `insert into public.user_challenge_states(user_id,challenge_key,status,unlock_points,started_at,completed_at,metadata)
    values(${q(actor)},${q(key)},${q(status)},336,${status === 'available' ? 'null' : started},
      ${status === 'completed' ? completed : 'null'},'{"preserve":"exact"}');`;
}
const wrap = body => `begin;set local check_function_bodies=on;set local search_path=public,extensions;${body}commit;`;
function actorSql(actor, statement) {
  return `begin;set local role authenticated;set local statement_timeout='8s';set local lock_timeout='5s';
    set local request.jwt.claim.sub=${q(actor)};set local request.jwt.claims=${q(JSON.stringify({ sub: actor, role: 'authenticated' }))};${statement};commit;`;
}
const call = (actor, statement, db = fixture) => JSON.parse(db.queryAsBootstrap(actorSql(actor, statement)).split('\n').at(-1));
const callAsync = async (actor, statement, db = fixture) => JSON.parse((await db.queryAsBootstrapAsync(actorSql(actor, statement))).split('\n').at(-1));
const activation = actor => call(actor, `select public.get_challenge_activation_v2(${q(actor)})`);
const rows = actor => JSON.parse(fixture.query(`select coalesce(jsonb_agg(to_jsonb(i) order by sequence_no),'[]') from private.challenge_instances i where user_id=${q(actor)}`));
const runtime = actor => JSON.parse(fixture.query(`select to_jsonb(r) from private.challenge_runtime r where user_id=${q(actor)}`));
const soloSql = (actor, date = 'current_date', request = randomUUID()) => `select public.activate_solo_challenge(${date},'UTC',${q(request)},${q(actor)})`;
function newActor(db = fixture) {
  const actor = randomUUID();
  db.queryAsBootstrap(`begin;set local session_replication_role=replica;${seedSql(actor, { status: 'not_started' })}commit;`);
  return actor;
}

before(async () => {
  source = await readFile(migrationUrl, 'utf8'); sourceHash = digest(source);
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  fixture.queryAsBootstrap(`begin;set local session_replication_role=replica;
    ${seedSql(ids.inert, { status: 'not_started' })}
    ${seedSql(ids.draft)}${seedSql(ids.partial, { submitted: 3 })}
    ${seedSql(ids.scheduled, { status: 'scheduled', start: 'current_date+3' })}
    ${seedSql(ids.overdue, { status: 'scheduled', start: 'current_date-1' })}
    ${seedSql(ids.group, { mode: 'group', submitted: 2 })}
    ${seedSql(ids.historical77, { submitted: 77 })}${seedSql(ids.event77, { submitted: 77 })}
    ${seedSql(ids.later, { submitted: 77 })}${seedSql(ids.laterCompleted, { submitted: 77 })}
    ${seedSql(ids.available, { submitted: 77 })}
    ${seedSql(ids.invalidRows, { submitted: 2, badActions: true })}${seedSql(ids.tooMany, { submitted: 78 })}
    ${seedSql(ids.invalidZone, { zone: 'Synthetic/Invalid' })}
    ${seedSql(ids.review, { status: 'not_started', review: true })}
    ${seedSql(ids.orphanHistory, { status: 'not_started', submitted: 1 })}
    ${seedSql(ids.conflict, { submitted: 1 })}${seedSql(ids.twoActive, { submitted: 77 })}
    ${seedSql(ids.invalidLater, { submitted: 77 })}
    insert into public.crews(id,name,created_by,challenge_start_date) values(${q(crew)},'Preserved crew',${q(ids.group)},current_date-160);
    insert into public.crew_members(crew_id,user_id,role) values(${q(crew)},${q(ids.group)},'owner');
    insert into public.game_point_events(user_id,event_type,points,entry_date,challenge_day,crew_id,metadata,idempotency_key,created_at)
      values(${q(ids.group)},'check_in',1,current_date-160,1,${q(crew)},'{"old":true}','synthetic-preserved-point','2026-01-02T12:34:56.123456Z');
    insert into public.community_feed_items(check_in_id,user_id,display_name,challenge_day,status,completed_count,created_at)
      select id,user_id,'Preserved group member',challenge_day,status,completed_count,created_at from public.check_ins
      where user_id=${q(ids.group)} and challenge_day=1;
    insert into private.badge_app_visits(user_id,local_date,occurred_at,time_zone)
      values(${q(ids.group)},current_date-3,'2026-01-02T12:34:56.123456Z','UTC');
    insert into private.challenge_activation_requests(request_id,actor_id,action,request_hash,result,created_at)
      values(${q(randomUUID())},${q(ids.group)},'group_activate',decode(repeat('22',32),'hex'),'{"preserved":true}','2026-01-02T12:34:56.123456Z');
    insert into private.challenge_activation_migration_reviews(user_id,reasons,evidence,created_at)
      values(${q(ids.review)},array['synthetic_conflict'],'{"old":true}','2026-01-02T12:34:56.123456Z');
    -- Inert synthetic ciphertext bytes only; no key, credential read, provider,
    -- or network exists in this fixture, and this old delivery is already done.
    insert into private.integration_destinations(id,crew_id,provider,provider_workspace_id,provider_destination_id,
      credential_ciphertext,credential_nonce,credential_key_version,credential_fingerprint,installed_by,status)
      values(${q(destination)},${q(crew)},'slack','synthetic-workspace','synthetic-channel',decode(repeat('00',17),'hex'),
        decode(repeat('00',12),'hex'),1,repeat('0',64),${q(ids.group)},'disconnected');
    insert into private.outbound_deliveries(crew_id,destination_id,event_type,idempotency_key,payload,status,subject_user_id,source_reference,
      created_at,updated_at,delivered_at)
      values(${q(crew)},${q(destination)},'check_in','synthetic-preserved-outbound','{"schemaVersion":1,"status":"partial","completedCount":1,"challengeDay":1}',
        'delivered',${q(ids.group)},'synthetic-old-source','2026-01-02T12:34:56.123456Z','2026-01-02T12:35:56.123456Z','2026-01-02T12:35:56.123456Z');
    insert into public.outbound_update_preferences(crew_id,user_id,outbound_updates_enabled,share_check_ins)
      values(${q(crew)},${q(ids.group)},true,true);
    insert into public.outbound_update_preference_audit(preference_id,crew_id,user_id,revision,change_type,change_source,
      outbound_updates_enabled,presentation_mode,share_check_ins,share_streak_milestones,share_badges_rewards,share_membership_events,changed_at)
      select id,crew_id,user_id,revision,'created','member',outbound_updates_enabled,presentation_mode,share_check_ins,
        share_streak_milestones,share_badges_rewards,share_membership_events,'2026-01-02T12:34:56.123456Z'
      from public.outbound_update_preferences where user_id=${q(ids.group)};
    insert into public.challenge_entries(user_id,entry_date,completed,version,updated_at)
      values(${q(ids.draft)},current_date,array['walk'],9,'2026-01-04T12:34:56.123456Z'),
        (${q(ids.partial)},current_date-159,array['bible'],4,'2026-01-03T01:02:03.654321Z');
    insert into public.user_reward_entitlements(user_id,reward_key,owned_at,metadata)
      values(${q(ids.available)},'dominion_night_theme','2026-01-02T12:34:56.123456Z','{"preserved":true}');
    ${legacySql(ids.available, 'twenty_one_day_prayer', 'available')}
    ${legacySql(ids.later, 'seven_day_reset', 'completed')}${legacySql(ids.later, 'twenty_one_day_prayer', 'active')}
    ${legacySql(ids.laterCompleted, 'seven_day_reset', 'completed')}
    ${legacySql(ids.conflict, 'seven_day_reset', 'active')}
    ${legacySql(ids.twoActive, 'seven_day_reset', 'active')}${legacySql(ids.twoActive, 'twenty_one_day_prayer', 'active')}
    ${legacySql(ids.invalidLater, 'seven_day_reset', 'completed', "'infinity'::timestamptz")}
    insert into private.original_77_completion_events(id,user_id,challenge_start_date,source_check_in_id,source_local_date,source_recorded_at,recorded_at)
      select ${q(oldEvent)},user_id,current_date-160,id,entry_date,created_at,created_at+interval '0.123456 seconds'
      from public.check_ins where user_id=${q(ids.event77)} and challenge_day=153;
    insert into public.user_badges(user_id,badge_key,scope_key,entry_date,earned_at,metadata)
      select user_id,'original_77_completed','original77:'||(current_date-160)::text,source_local_date,source_recorded_at,
        jsonb_build_object('completionEventId',id) from private.original_77_completion_events where id=${q(oldEvent)};
    commit;`);
  preserved = snapshot();
  fixture.query(wrap(source));
});
after(async () => {
  try { assert.equal(digest(await readFile(migrationUrl, 'utf8')), sourceHash, 'Migration changed during cutover verification.'); }
  finally { fixture?.close(); }
});

test('70→71 preserves every source column except the new check-in UUID, and creates no award/feed/outbound replay', () => {
  assert.deepEqual(snapshot(), preserved);
  assert.equal(fixture.query('select count(*) from public.challenge_entries where challenge_instance_id is not null'), '0');
  assert.equal(fixture.query('select count(*) from private.challenge_instance_completions'), '1');
  assert.equal(fixture.query('select count(*) from private.original_77_completion_events'), '1');
  assert.equal(fixture.query('select count(*) from public.user_badges'), '1');
  assert.equal(fixture.query('select count(*) from public.game_point_events'), '1');
  assert.equal(fixture.query('select count(*) from private.outbound_deliveries'), '1');
});

test('valid partial, scheduled, overdue and group histories bind to exactly one original UUID with original scope/date/attribution', () => {
  for (const key of ['draft', 'partial', 'scheduled', 'overdue', 'group']) {
    const [instance] = rows(ids[key]); assert(instance); assert.equal(rows(ids[key]).length, 1);
    assert.equal(instance.challenge_key, 'original_77'); assert.equal(instance.scope_key, `original77:${instance.start_date}`);
    assert.equal(instance.sequence_no, 0); assert.equal(instance.provenance, 'legacy_bound');
    assert.equal(runtime(ids[key]).current_instance_id, instance.id);
    assert.equal(fixture.query(`select count(*) from public.check_ins where user_id=${q(ids[key])} and challenge_instance_id is distinct from ${q(instance.id)}`), '0');
    assert.equal(instance.status, key === 'scheduled' ? 'scheduled' : 'active');
  }
  assert.equal(rows(ids.group)[0].crew_id, crew); assert.equal(rows(ids.group)[0].participation_mode, 'group');
  assert.deepEqual(rows(ids.inert), []);
  assert.equal(fixture.query(`select count(*) from private.challenge_runtime where user_id=${q(ids.inert)}`), '0');
});

test('historical 77 partials allow repeat without invented completion time/event/Finisher; live event identity/times copy exactly', () => {
  const historical = rows(ids.historical77)[0];
  assert.equal(historical.status, 'completed'); assert.equal(historical.provenance, 'legacy_completed');
  assert.equal(historical.completed_at, null); assert.equal(historical.completion_event_id, null);
  assert.equal(fixture.query(`select count(*) from public.user_badges where user_id=${q(ids.historical77)}`), '0');
  const live = rows(ids.event77)[0]; assert.equal(live.completion_event_id, oldEvent);
  assert.equal(fixture.query(`select jsonb_build_array(n.id,n.user_id,n.source_check_in_id,n.local_date,n.completed_at,n.persisted_at)
    =jsonb_build_array(o.id,o.user_id,o.source_check_in_id,o.source_local_date,o.source_recorded_at,o.recorded_at)
    from private.challenge_instance_completions n join private.original_77_completion_events o using(id) where n.id=${q(oldEvent)}`), 't');
  assert.equal(fixture.query(`select i.completed_at=e.source_recorded_at from private.challenge_instances i
    join private.original_77_completion_events e on e.id=i.completion_event_id where i.user_id=${q(ids.event77)}`), 't');
});

test('explicit completed/active later lifecycles import without fabricated submissions, while available ownership stays a grant only', () => {
  const imported = rows(ids.later);
  assert.deepEqual(imported.map(i => [i.challenge_key, i.status]), [
    ['original_77', 'completed'], ['seven_day_reset', 'completed'], ['twenty_one_day_prayer', 'active']]);
  assert.equal(runtime(ids.later).current_instance_id, imported[2].id);
  assert.equal(imported[1].provenance, 'legacy_completed'); assert.equal(imported[2].provenance, 'legacy_bound');
  for (const instance of imported.slice(1)) {
    assert.equal(instance.completion_event_id, null);
    assert.deepEqual(instance.metadata.legacyState, preserved['public.user_challenge_states'].find(s => s.user_id === ids.later && s.challenge_key === instance.challenge_key));
    assert.equal(fixture.query(`select count(*) from public.check_ins where challenge_instance_id=${q(instance.id)}`), '0');
  }
  assert.equal(rows(ids.available).length, 1);
  assert.equal(rows(ids.laterCompleted).at(-1).challenge_key, 'seven_day_reset');
  assert.equal(runtime(ids.laterCompleted).current_instance_id, rows(ids.laterCompleted).at(-1).id);
});

test('invalid and conflicting history remains unchanged and closes runtime mutations without invented runs', () => {
  for (const key of ['invalidRows', 'tooMany', 'invalidZone', 'review', 'orphanHistory']) {
    assert.deepEqual(rows(ids[key]), [], key); const state = runtime(ids[key]);
    assert.equal(state.review_required, true, key); assert.equal(state.current_instance_id, null);
    assert.equal(fixture.query(`select count(*) from public.check_ins where user_id=${q(ids[key])} and challenge_instance_id is not null`), '0');
  }
  for (const key of ['conflict', 'twoActive', 'invalidLater']) {
    assert.equal(rows(ids[key]).length, 1); assert.equal(runtime(ids[key]).review_required, true);
    assert.equal(rows(ids[key])[0].review_required, true);
    const state = activation(ids[key]); assert.equal(state.canParticipate, false); assert.equal(state.canActivateSolo, false);
  }
  assert.throws(() => call(ids.review, soloSql(ids.review)), /review/i);
});

test('legacy drafts stay unbound/readable until their first legitimate V2 mutation', () => {
  const actor = ids.draft, instance = rows(actor)[0].id;
  const old = fixture.query(`select to_jsonb(e) from public.challenge_entries e where user_id=${q(actor)}`);
  const boot = call(actor, `select public.get_daily_action_bootstrap_v2(${q(actor)},'UTC',current_date,null)`);
  assert.equal(boot.instanceId, instance); assert.equal(boot.draft.version, 9);
  assert.equal(fixture.query(`select to_jsonb(e) from public.challenge_entries e where user_id=${q(actor)}`), old);
  call(actor, `select public.mutate_daily_standard_draft_v2(current_date,'bible',true,9,${q(actor)},${q(instance)})`);
  assert.equal(fixture.query(`select challenge_instance_id from public.challenge_entries where user_id=${q(actor)}`), instance);
});

test('new Solo activation, replay and date edit keep one UUID and one atomic activation state', () => {
  const actor = newActor(), request = randomUUID(), sql = soloSql(actor, 'current_date+2', request);
  call(actor, sql); const first = activation(actor);
  assert.equal(first.currentInstance.status, 'scheduled'); assert.equal(first.currentInstance.provenance, 'live');
  call(actor, sql); assert.equal(activation(actor).currentInstance.id, first.currentInstance.id); assert.equal(rows(actor).length, 1);
  const edited = call(actor, `select public.set_challenge_start_date_v2(current_date,'UTC',${q(randomUUID())},${first.revision},${q(actor)},${q(first.currentInstance.id)})`);
  assert.equal(edited.currentInstance?.id ?? edited.activation?.currentInstance?.id, first.currentInstance.id);
  assert.equal(rows(actor).length, 1); assert.equal(activation(actor).currentInstance.status, 'active');
});

test('due legacy scheduling promotion re-enters the binder without replacing its original UUID', () => {
  const actor = ids.overdue, first = rows(actor)[0];
  assert.equal(fixture.query(`select challenge_activation_status from public.profiles where user_id=${q(actor)}`), 'scheduled');
  const boot = call(actor, `select public.get_daily_action_bootstrap_v2(${q(actor)},'UTC',current_date,null)`);
  assert.equal(boot.instanceId, first.id); assert.equal(boot.activation.currentInstance.status, 'active');
  assert.equal(fixture.query(`select challenge_activation_status from public.profiles where user_id=${q(actor)}`), 'active');
  assert.equal(rows(actor).length, 1);
});

test('new Group creation/activation binds the exact crew atomically and a failed binding leaves no crew/request/run', () => {
  const actor = newActor(), request = randomUUID(), activationRequest = randomUUID();
  const sql = `select public.create_crew_and_activate_group(${q(request)},${q(activationRequest)},'New synthetic crew','',current_date,'UTC',${q(actor)})`;
  const created = call(actor, sql); const first = activation(actor);
  assert.equal(first.currentInstance.crewId, created.crew.crewId); assert.equal(first.currentInstance.mode, 'group');
  call(actor, sql); assert.equal(rows(actor).length, 1); assert.equal(activation(actor).currentInstance.id, first.currentInstance.id);
  const failed = newActor();
  fixture.query(`insert into private.challenge_runtime(user_id,review_required,review_reason) values(${q(failed)},true,'synthetic_conflict')`);
  assert.throws(() => call(failed, `select public.create_crew_and_activate_group(${q(randomUUID())},${q(randomUUID())},'Must roll back','',current_date,'UTC',${q(failed)})`), /review/i);
  assert.equal(fixture.query(`select count(*) from public.crews where created_by=${q(failed)}`), '0');
  assert.equal(fixture.query(`select count(*) from private.challenge_activation_requests where actor_id=${q(failed)}`), '0');
  assert.deepEqual(rows(failed), []);
});

test('concurrent initial requests serialize: same request replays and conflicting starts create one UUID', async () => {
  const actor = newActor(), sql = soloSql(actor);
  await Promise.all([callAsync(actor, sql), callAsync(actor, sql)]);
  assert.equal(rows(actor).length, 1);
  const other = newActor();
  const results = await Promise.allSettled([callAsync(other, soloSql(other)), callAsync(other, soloSql(other, 'current_date+1'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(rows(other).length, 1);
});

test('repeat Start and trigger re-entry preserve the original profile date and never reset a later current UUID', () => {
  const actor = ids.historical77, original = rows(actor)[0], observed = activation(actor);
  const profile = fixture.query(`select to_jsonb(p) from public.profiles p where user_id=${q(actor)}`);
  const started = call(actor, `select public.start_challenge_instance_v2('original_77',current_date,'UTC',${q(randomUUID())},${q(actor)},${q(original.id)},${observed.revision})`);
  assert.notEqual(started.instanceId, original.id);
  assert.equal(fixture.query(`select to_jsonb(p) from public.profiles p where user_id=${q(actor)}`), profile);
  assert.equal(fixture.query(`select private.bind_original_challenge_instance(${q(actor)},false)`), original.id);
  fixture.query(`update public.profiles set challenge_activation_status=challenge_activation_status where user_id=${q(actor)}`);
  assert.equal(runtime(actor).current_instance_id, started.instanceId);
  // The normal profile updated_at trigger may run on an explicit UPDATE; the
  // repeat Start itself must not change any original profile source column.
  const beforeProfile = JSON.parse(profile); delete beforeProfile.updated_at;
  assert.deepEqual(JSON.parse(fixture.query(`select (to_jsonb(p)-'updated_at') from public.profiles p where user_id=${q(actor)}`)), beforeProfile);
});

async function waitFor(db, predicate) {
  for (let n = 0; n < 80; n++) {
    if (db.queryAsBootstrap(predicate) === 't') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Synthetic concurrent session did not reach its expected lock boundary.');
}

for (const operation of ['activation', 'account deletion', 'direct Auth deletion']) {
  test(`early lifecycle fence safely drains an in-flight legacy ${operation} before any child DDL`, async () => {
    const db = await createOriginal77FullchainFixture({ through: 70 });
    const sessions = [];
    try {
      const actor = newActor(db), marker = `cutover-${randomUUID()}`, contender = `migration-${randomUUID()}`;
      const statement = operation === 'activation'
        ? actorSql(actor, `set local application_name=${q(marker)};${soloSql(actor)};select pg_sleep(3)`)
        : `begin;set local application_name=${q(marker)};${operation === 'account deletion' ? "select pg_advisory_xact_lock(hashtextextended('retired-community-deletion',0));" : ''}
          delete from auth.users where id=${q(actor)};select pg_sleep(3);commit;`;
      sessions.push(db.queryAsBootstrapAsync(statement));
      await waitFor(db, `select exists(select 1 from pg_stat_activity where application_name=${q(marker)} and wait_event='PgSleep')`);
      sessions.push(db.queryAsync(wrap(`set local application_name=${q(contender)};${source}`)));
      await waitFor(db, `select exists(select 1 from pg_stat_activity where application_name=${q(contender)}
        and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0)`);
      await Promise.all(sessions);
      assert.equal(db.query(`select count(*) from private.challenge_instances where user_id=${q(actor)}`), operation === 'activation' ? '1' : '0');
      assert.equal(db.query(`select count(*) from auth.users where id=${q(actor)}`), operation === 'activation' ? '1' : '0');
      assert.equal(db.query("select deadlocks from pg_stat_database where datname=current_database()"), '0');
    } finally { await Promise.allSettled(sessions); db.close(); }
  });
}

for (const operation of ['activation', 'account deletion', 'direct Auth deletion']) {
  test(`${operation} arriving after the cutover fence waits and observes fully bound latest schema`, async () => {
    const db = await createOriginal77FullchainFixture({ through: 70 });
    const sessions = [];
    try {
      const actor = newActor(db), marker = `cutover-${randomUUID()}`, contender = `writer-${randomUUID()}`;
      sessions.push(db.queryAsync(wrap(`set local application_name=${q(marker)};${source}select pg_sleep(3);`)));
      await waitFor(db, `select exists(select 1 from pg_stat_activity where application_name=${q(marker)} and wait_event='PgSleep')`);
      sessions.push(operation === 'activation'
        ? db.queryAsBootstrapAsync(actorSql(actor, `set local application_name=${q(contender)};${soloSql(actor)}`))
        : db.queryAsBootstrapAsync(`begin;set local application_name=${q(contender)};
          ${operation === 'account deletion' ? "select pg_advisory_xact_lock(hashtextextended('retired-community-deletion',0));" : ''}
          delete from auth.users where id=${q(actor)};commit;`));
      await waitFor(db, `select exists(select 1 from pg_stat_activity where application_name=${q(contender)}
        and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0)`);
      await Promise.all(sessions);
      assert.equal(db.query(`select count(*) from private.challenge_instances where user_id=${q(actor)}`), operation === 'activation' ? '1' : '0');
      assert.equal(db.query(`select count(*) from auth.users where id=${q(actor)}`), operation === 'activation' ? '1' : '0');
      assert.equal(db.query("select deadlocks from pg_stat_database where datname=current_database()"), '0');
    } finally { await Promise.allSettled(sessions); db.close(); }
  });
}

test('a direct child writer causes immediate rollback before any DDL or source capture', async () => {
  const db = await createOriginal77FullchainFixture({ through: 70 });
  let pending;
  try {
    const marker = `child-writer-${randomUUID()}`;
    pending = db.queryAsync(`begin;set local application_name=${q(marker)};
      lock table public.check_ins in row exclusive mode;select pg_sleep(1.5);commit;`);
    await waitFor(db, `select exists(select 1 from pg_stat_activity where application_name=${q(marker)} and wait_event='PgSleep')`);
    assert.throws(() => db.query(wrap(source)), /could not obtain lock on relation "public\.check_ins"/);
    assert.equal(db.query("select to_regclass('private.challenge_instances') is null"), 't');
    await pending;
    assert.equal(db.query("select deadlocks from pg_stat_database where datname=current_database()"), '0');
  } finally { if (pending) await Promise.allSettled([pending]); db.close(); }
});

test('a busy Auth parent times out after the declared 5s lock boundary with the entire migration rolled back', async () => {
  const db = await createOriginal77FullchainFixture({ through: 70 });
  let pending;
  try {
    const marker = `auth-writer-${randomUUID()}`;
    pending = db.queryAsBootstrapAsync(`begin;set local application_name=${q(marker)};
      lock table auth.users in row exclusive mode;select pg_sleep(6);commit;`);
    await waitFor(db, `select exists(select 1 from pg_stat_activity where application_name=${q(marker)} and wait_event='PgSleep')`);
    const startedAt = performance.now();
    assert.throws(() => db.query(wrap(source)), /canceling statement due to lock timeout/);
    assert(performance.now() - startedAt >= 4900, 'The declared lock timeout must be exercised, not an unrelated fast error.');
    assert.equal(db.query("select to_regclass('private.challenge_instances') is null"), 't');
    assert.equal(db.query("select count(*) from pg_attribute where attrelid='public.check_ins'::regclass and attname='challenge_instance_id' and not attisdropped"), '0');
    await pending;
    assert.equal(db.query("select deadlocks from pg_stat_database where datname=current_database()"), '0');
  } finally { if (pending) await Promise.allSettled([pending]); db.close(); }
});

test('an unexpected generic check-in UPDATE trigger aborts the entire cutover before source association', async () => {
  const db = await createOriginal77FullchainFixture({ through: 70 });
  try {
    const actor = randomUUID();
    db.queryAsBootstrap(`begin;set local session_replication_role=replica;${seedSql(actor, { submitted: 1 })}commit;`);
    const before = snapshot(db);
    db.query(`create function private.synthetic_update_hook() returns trigger language plpgsql as $$begin return new;end;$$;
      create trigger synthetic_update_hook before update on public.check_ins for each row execute function private.synthetic_update_hook();`);
    assert.throws(() => db.query(wrap(source)), /Unexpected check-in UPDATE trigger/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.query("select to_regclass('private.challenge_instances') is null"), 't');
    assert.equal(db.query("select count(*) from pg_attribute where attrelid='public.check_ins'::regclass and attname='challenge_instance_id' and not attisdropped"), '0');
  } finally { db.close(); }
});
