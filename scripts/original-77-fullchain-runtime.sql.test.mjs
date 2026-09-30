import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

const actions = ['bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer', 'workoutOne', 'walk', 'workoutTwo'];
let fixture;

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function actorSql(actor, sql) {
  const claims = JSON.stringify({ sub: actor, role: 'authenticated', email: `${actor}@example.test`, user_metadata: { name: 'Runtime Member' } });
  return `\\set VERBOSITY verbose
    begin;
    set local role authenticated;
    set local statement_timeout='8s';
    set local lock_timeout='5s';
    set local request.jwt.claim.sub=${literal(actor)};
    set local request.jwt.claims=${literal(claims)};
    ${sql}
    commit;`;
}

function submitSql(actor) {
  return `select public.submit_daily_check_in(
    'partial',array['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo']::text[],
    '{"one":"extreme"}'::jsonb,'America/Los_Angeles',current_date,${literal(actor)}::uuid
  );`;
}

function applicationNameSql(name) {
  return `select pg_catalog.set_config('application_name',${literal(name)},true);`;
}

function gateHoldSql(gateKey, applicationName) {
  return `${applicationNameSql(applicationName)}
    do $gate$
    declare deadline timestamptz := pg_catalog.clock_timestamp()+interval '6 seconds';
    begin
      loop
        exit when coalesce((select released from public.original77_test_gates
          where gate_key=${literal(gateKey)}),false);
        if pg_catalog.clock_timestamp()>=deadline then
          raise exception 'Controlled concurrency gate timed out.' using errcode='57014';
        end if;
        perform pg_catalog.pg_sleep(0.02);
      end loop;
    end $gate$;`;
}

function createGate(gateKey) {
  fixture.queryAsBootstrap(`insert into public.original77_test_gates(gate_key)
    values(${literal(gateKey)});`);
}

async function waitForHolder(applicationName) {
  let lastActivity = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const activity = JSON.parse(fixture.queryAsBootstrap(`select coalesce((
      select pg_catalog.jsonb_build_object(
        'pid',pid,'state',state,'waitEventType',wait_event_type,'waitEvent',wait_event
      ) from pg_catalog.pg_stat_activity
      where datname=pg_catalog.current_database()
        and application_name=${literal(applicationName)}
      order by backend_start desc limit 1
    ),'null'::jsonb);`));
    lastActivity = activity;
    if (activity && Number.isInteger(activity.pid)) return activity;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for gate holder ${applicationName}: ${JSON.stringify(lastActivity)}.`);
}

async function waitForBlockedWaiter(applicationName, blockerPid) {
  let lastActivity = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const activity = JSON.parse(fixture.queryAsBootstrap(`select coalesce((
      select pg_catalog.jsonb_build_object(
        'pid',pid,'state',state,'waitEventType',wait_event_type,'waitEvent',wait_event,
        'blockingPids',pg_catalog.pg_blocking_pids(pid)
      ) from pg_catalog.pg_stat_activity
      where datname=pg_catalog.current_database()
        and application_name=${literal(applicationName)}
      order by backend_start desc limit 1
    ),'null'::jsonb);`));
    lastActivity = activity;
    if (activity?.waitEventType === 'Lock' && activity.blockingPids?.includes(blockerPid)) return activity;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out proving ${applicationName} was blocked by backend ${blockerPid}: ${JSON.stringify(lastActivity)}.`);
}

function releaseGate(gateKey) {
  assert.equal(fixture.queryAsBootstrap(`update public.original77_test_gates
    set released=true where gate_key=${literal(gateKey)} returning gate_key;`),gateKey);
}

function settle(promise) {
  return promise.then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  );
}

function completionSnapshot(actor) {
  return JSON.parse(fixture.query(`select pg_catalog.jsonb_build_object(
    'checkIns',(select pg_catalog.count(*) from public.check_ins where user_id=${literal(actor)}::uuid),
    'checkInPointEvents',(select pg_catalog.count(*) from public.game_point_events
      where user_id=${literal(actor)}::uuid and event_type='check_in'),
    'totalPoints',(select total_points from public.user_game_stats where user_id=${literal(actor)}::uuid),
    'completionEvents',(select pg_catalog.count(*) from private.original_77_completion_events
      where user_id=${literal(actor)}::uuid),
    'finisherAwards',(select pg_catalog.count(*) from public.user_badges
      where user_id=${literal(actor)}::uuid and badge_key='original_77_completed'),
    'appVisits',(select pg_catalog.count(*) from private.badge_app_visits
      where user_id=${literal(actor)}::uuid)
  );`));
}

function expectActorState(actor, state, statement) {
  fixture.queryAsBootstrap(actorSql(actor, `do $assert$
    begin
      begin
        ${statement};
      exception when sqlstate '${state}' then return;
      end;
      raise exception 'Expected SQLSTATE ${state}';
    end $assert$;`));
}

function setupActor(actor, {
  submitted = 76,
  entitlement = true,
  status = 'active',
  reviewRequired = false,
  draft = true,
  startOffset = -77,
} = {}) {
  assert(Number.isInteger(startOffset));
  const email = `${actor}@example.test`;
  fixture.queryAsBootstrap(`
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
    values(${literal(actor)}::uuid,${literal(email)},pg_catalog.now(),
      pg_catalog.jsonb_build_object('name','Runtime Member'),pg_catalog.now(),pg_catalog.now());
    insert into public.profiles(user_id,name,email)
    values(${literal(actor)}::uuid,'Runtime Member',${literal(email)})
    on conflict(user_id) do nothing;
    update public.profiles set
      time_zone='UTC',
      challenge_activation_status=${literal(status)},
      challenge_participation_mode=case when ${literal(status)}='not_started' then null else 'solo' end,
      challenge_start_date=case when ${literal(status)}='not_started' then null else current_date+(${startOffset}) end,
      challenge_activation_time_zone=case when ${literal(status)}='not_started' then null else 'UTC' end,
      challenge_group_attribution_crew_id=null,
      challenge_activated_at=case when ${literal(status)}='active' then pg_catalog.now()+(${startOffset}||' days')::interval else null end,
      challenge_confirmed_at=case when ${literal(status)}='not_started' then null else pg_catalog.now() end,
      challenge_activated_by=case when ${literal(status)}='active' then ${literal(actor)}::uuid else null end,
      challenge_confirmed_by=case when ${literal(status)}='not_started' then null else ${literal(actor)}::uuid end,
      challenge_activation_request_id=null,
      challenge_activation_schema_version=1,
      challenge_activation_revision=1,
      challenge_activation_review_required=${reviewRequired ? 'true' : 'false'},
      challenge_activation_updated_at=pg_catalog.now()
    where user_id=${literal(actor)}::uuid;
    ${entitlement ? `insert into public.entitlements(
      user_id,entitlement_key,status,source_type,source_id,starts_at,ends_at
    ) values(
      ${literal(actor)}::uuid,'membership_active','active','test','original77-fullchain',
      pg_catalog.now()-interval '1 day',pg_catalog.now()+interval '1 day'
    ) on conflict(user_id,entitlement_key) do update set
      status='active',ends_at=excluded.ends_at;` : ''}
    set session_replication_role=replica;
    insert into public.check_ins(
      id,user_id,entry_date,challenge_day,status,completed_count,created_at,
      completed,workout_difficulty,points_awarded
    )
    select extensions.gen_random_uuid(),${literal(actor)}::uuid,
      current_date+(${startOffset})+(ordinal-1),ordinal,'partial',1,
      (current_date+(${startOffset})+(ordinal-1))::timestamp at time zone 'UTC'+interval '12 hours',
      array['walk']::text[],'{}'::jsonb,1
    from pg_catalog.generate_series(1,${submitted}) ordinal;
    set session_replication_role=origin;
    ${draft ? `insert into public.challenge_entries(
      user_id,entry_date,completed,workout_difficulty
    ) values(${literal(actor)}::uuid,current_date,array['walk']::text[],'{}'::jsonb);` : ''}
  `);
}

before(async () => {
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  fixture.queryAsBootstrap(`create table public.original77_test_gates(
    gate_key text primary key,
    released boolean not null default false
  );
  revoke all on public.original77_test_gates from public,anon,authenticated,service_role;
  grant select on public.original77_test_gates to authenticated;`);
});

after(() => fixture?.close());

test('actual bootstrap and submit RPC complete the sparse original run from authoritative draft state', () => {
  const actor = '71000000-0000-4000-8000-000000000001';
  setupActor(actor);
  const bootstrap = JSON.parse(fixture.queryAsBootstrap(actorSql(actor,
    `select public.get_daily_action_bootstrap(${literal(actor)}::uuid,'America/Los_Angeles',current_date);`,
  )));
  assert.equal(bootstrap.appAccess, true);
  assert.equal(bootstrap.activation.challengeDay, 78);
  assert.equal(bootstrap.activation.originalProgress.submittedCount, 76);
  assert.equal(bootstrap.activation.originalProgress.completionState, 'in_progress');
  assert.equal(bootstrap.activation.originalProgress.userId, actor);
  assert.equal(bootstrap.activation.originalProgress.instanceId, `original77:${bootstrap.activation.startDate}`);
  assert.equal(bootstrap.activation.originalProgress.targetCount, 77);
  assert.equal(bootstrap.activation.originalProgress.canonicalEvent, null);
  assert.equal(bootstrap.draft.activation_status, 'active');
  assert.equal(bootstrap.draft.lock_reason, null);
  assert.deepEqual(bootstrap.draft.completed, ['walk']);

  const submitted = JSON.parse(fixture.queryAsBootstrap(actorSql(actor,
    `select public.submit_daily_check_in(
      'complete',array[${actions.map(literal).join(',')}]::text[],
      '{"one":"extreme"}'::jsonb,'America/Los_Angeles',current_date,${literal(actor)}::uuid
    );`,
  )));
  assert.equal(submitted.challenge_day, 78);
  assert.equal(submitted.status, 'partial');
  assert.equal(submitted.completed_count, 1);
  assert.equal(submitted.points_awarded, 1);
  assert.equal(submitted.activation.originalProgress.submittedCount, 77);
  assert.equal(submitted.activation.originalProgress.completionState, 'live_completed');
  assert.equal(submitted.activation.canParticipate, false);
  assert.equal(submitted.activation.canMutateDailyStandards, false);

  const persisted = JSON.parse(fixture.query(`select pg_catalog.jsonb_build_object(
    'checkIns',(select count(*) from public.check_ins where user_id=${literal(actor)}::uuid),
    'today',(select pg_catalog.jsonb_build_object(
      'id',id,'entryDate',entry_date,'completed',completed,'status',status,
      'count',completed_count,'points',points_awarded,'createdAt',created_at
    ) from public.check_ins where user_id=${literal(actor)}::uuid and entry_date=current_date),
    'startDate',(select challenge_start_date from public.profiles where user_id=${literal(actor)}::uuid),
    'points',(select count(*) from public.game_point_events where user_id=${literal(actor)}::uuid),
    'events',(select count(*) from private.original_77_completion_events where user_id=${literal(actor)}::uuid),
    'event',(select pg_catalog.jsonb_build_object(
      'id',id,'sourceId',source_check_in_id,'localDate',source_local_date,
      'recordedAt',source_recorded_at,'persistedAt',recorded_at
    ) from private.original_77_completion_events where user_id=${literal(actor)}::uuid),
    'award',(select pg_catalog.jsonb_build_object(
      'earnedAt',earned_at,'metadata',metadata,'scope',scope_key
    ) from public.user_badges where user_id=${literal(actor)}::uuid and badge_key='original_77_completed')
  );`));
  assert.equal(persisted.checkIns, 77);
  assert.deepEqual(persisted.today.completed, ['walk']);
  assert.equal(persisted.today.status, 'partial');
  assert.equal(persisted.today.count, 1);
  assert.equal(persisted.today.points, 1);
  assert.equal(persisted.points, 1);
  assert.equal(persisted.events, 1);
  assert.equal(persisted.event.sourceId, persisted.today.id);
  assert.equal(persisted.event.localDate, persisted.today.entryDate);
  assert.equal(persisted.event.recordedAt, persisted.today.createdAt);
  assert.equal(persisted.award.earnedAt, persisted.today.createdAt);
  assert.equal(persisted.award.scope, `original77:${persisted.startDate}`);
  assert.equal(persisted.award.metadata.sourceRecordId, persisted.event.id);
  assert.equal(persisted.award.metadata.sourceCheckInId, persisted.today.id);
  assert.deepEqual(submitted.activation.originalProgress, {
    schemaVersion: 1,
    userId: actor,
    instanceId: `original77:${persisted.startDate}`,
    targetCount: 77,
    submittedCount: 77,
    completionState: 'live_completed',
    canonicalEvent: persisted.event,
  });
  assert.deepEqual(persisted.award.metadata.earningEvidence, {
    schemaVersion: 1, kind: 'challenge_completion', completionKind: 'original_77_submissions',
    completionEventId: persisted.event.id, sourceCheckInId: persisted.today.id,
    submittedCount: 77, targetCount: 77,
  });

  expectActorState(actor,'22023',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(actor)}::uuid)`);
  expectActorState(actor,'22023',`perform public.mutate_daily_standard_draft(
    current_date,'bible',true,null,${literal(actor)}::uuid)`);
  const unchanged = JSON.parse(fixture.query(`select pg_catalog.jsonb_build_object(
    'checks',(select count(*) from public.check_ins where user_id=${literal(actor)}::uuid),
    'points',(select count(*) from public.game_point_events where user_id=${literal(actor)}::uuid),
    'events',(select count(*) from private.original_77_completion_events where user_id=${literal(actor)}::uuid),
    'awards',(select count(*) from public.user_badges where user_id=${literal(actor)}::uuid and badge_key='original_77_completed'))`));
  assert.deepEqual(unchanged,{ checks:77,points:1,events:1,awards:1 });
});

test('owner, access, lifecycle and historical-provenance boundaries fail closed without writes', () => {
  const owner = '72000000-0000-4000-8000-000000000001';
  const other = '72000000-0000-4000-8000-000000000002';
  const noAccess = '72000000-0000-4000-8000-000000000003';
  const inert = '72000000-0000-4000-8000-000000000004';
  const review = '72000000-0000-4000-8000-000000000005';
  const historical = '72000000-0000-4000-8000-000000000006';
  const scheduled = '72000000-0000-4000-8000-000000000007';
  setupActor(owner);
  setupActor(other,{submitted:0,draft:false});
  setupActor(noAccess,{entitlement:false});
  setupActor(inert,{submitted:0,status:'not_started',draft:false});
  setupActor(review,{submitted:0,reviewRequired:true});
  setupActor(historical,{submitted:77,draft:false});
  setupActor(scheduled,{submitted:0,status:'scheduled',draft:false,startOffset:1});

  expectActorState(owner,'40001',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(other)}::uuid)`);
  const denied = JSON.parse(fixture.queryAsBootstrap(actorSql(noAccess,
    `select public.get_daily_action_bootstrap(${literal(noAccess)}::uuid,'UTC',current_date);`,
  )));
  assert.equal(denied.appAccess,false);
  assert.equal(denied.draft,null);
  const inertPayload = JSON.parse(fixture.queryAsBootstrap(actorSql(inert,
    `select public.get_challenge_activation(${literal(inert)}::uuid);`,
  )));
  assert.equal(inertPayload.status,'not_started');
  assert.equal(inertPayload.originalProgress,null);
  const scheduledPayload = JSON.parse(fixture.queryAsBootstrap(actorSql(scheduled,
    `select public.get_challenge_activation(${literal(scheduled)}::uuid);`,
  )));
  assert.equal(scheduledPayload.status,'scheduled');
  assert.equal(scheduledPayload.canParticipate,false);
  expectActorState(scheduled,'55000',`perform public.mutate_daily_standard_draft(
    current_date,'walk',true,null,${literal(scheduled)}::uuid)`);
  const reviewPayload = JSON.parse(fixture.queryAsBootstrap(actorSql(review,
    `select public.get_challenge_activation(${literal(review)}::uuid);`,
  )));
  assert.equal(reviewPayload.originalProgress.completionState,'invalid_evidence');
  assert.equal(reviewPayload.canParticipate,false);
  const historicalPayload = JSON.parse(fixture.queryAsBootstrap(actorSql(historical,
    `select public.get_challenge_activation(${literal(historical)}::uuid);`,
  )));
  assert.equal(historicalPayload.originalProgress.submittedCount,77);
  assert.equal(historicalPayload.originalProgress.completionState,'historical_provenance_pending');
  assert.equal(historicalPayload.originalProgress.canonicalEvent,null);
  expectActorState(noAccess,'P0001',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(noAccess)}::uuid)`);
  expectActorState(inert,'55000',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(inert)}::uuid)`);
  expectActorState(review,'22023',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(review)}::uuid)`);
  expectActorState(scheduled,'55000',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(scheduled)}::uuid)`);
  expectActorState(historical,'22023',`perform public.submit_daily_check_in(
    'partial',array['walk']::text[],'{}'::jsonb,'UTC',current_date,${literal(historical)}::uuid)`);
  expectActorState(historical,'22023',`perform public.mutate_daily_standard_draft(
    current_date,'walk',true,null,${literal(historical)}::uuid)`);
  const noReplay = JSON.parse(fixture.query(`select pg_catalog.jsonb_build_object(
    'events',(select count(*) from private.original_77_completion_events where user_id=${literal(historical)}::uuid),
    'awards',(select count(*) from public.user_badges where user_id=${literal(historical)}::uuid and badge_key='original_77_completed'),
    'ownerChecks',(select count(*) from public.check_ins where user_id=${literal(owner)}::uuid),
    'otherChecks',(select count(*) from public.check_ins where user_id=${literal(other)}::uuid),
    'deniedPointEvents',(select count(*) from public.game_point_events
      where user_id=any(array[
        ${literal(noAccess)}::uuid,${literal(inert)}::uuid,${literal(review)}::uuid,
        ${literal(scheduled)}::uuid,${literal(historical)}::uuid
      ])))`));
  assert.deepEqual(noReplay,{events:0,awards:0,ownerChecks:76,otherChecks:0,deniedPointEvents:0});
});

test('bounded async fixture sessions preserve postgres and authenticated identities', async () => {
  const actor = '73000000-0000-4000-8000-000000000001';
  const [postgresIdentity, actorIdentity] = await Promise.all([
    fixture.queryAsync(`select current_user from pg_catalog.pg_sleep(0.05);`),
    fixture.queryAsBootstrapAsync(actorSql(actor,
      `select current_user::text||'|'||current_setting('request.jwt.claim.sub');`,
    )),
  ]);
  assert.equal(postgresIdentity, 'postgres');
  assert.equal(actorIdentity, `authenticated|${actor}`);
});

test('two actual 77th-submit sessions serialize to one committed completion', async () => {
  const actor = '74000000-0000-4000-8000-000000000001';
  const gate = 'two-submit';
  const holderName = 'original77-two-submit-holder';
  const waiterName = 'original77-two-submit-waiter';
  setupActor(actor);
  createGate(gate);

  const first = settle(fixture.queryAsBootstrapAsync(actorSql(actor, `${submitSql(actor)}
    ${gateHoldSql(gate,holderName)}`)));
  let second;
  let overlapError;
  try {
    const holder = await waitForHolder(holderName);
    second = settle(fixture.queryAsBootstrapAsync(actorSql(actor,
      `${applicationNameSql(waiterName)} ${submitSql(actor)}`)));
    await waitForBlockedWaiter(waiterName,holder.pid);
  } catch (error) {
    overlapError = error;
  } finally {
    releaseGate(gate);
  }
  const [firstResult, secondResult] = await Promise.all([first,second]);
  if (overlapError) throw overlapError;

  assert.equal(firstResult.status, 'fulfilled');
  assert.equal(secondResult.status, 'rejected');
  const refusal = String(secondResult.reason);
  assert.doesNotMatch(refusal, /40P01|deadlock/i);
  assert.match(refusal, /22023|complete|outside/i);
  assert.deepEqual(completionSnapshot(actor), {
    checkIns: 77,
    checkInPointEvents: 1,
    totalPoints: 1,
    completionEvents: 1,
    finisherAwards: 1,
    appVisits: 0,
  });
});

test('app visit and actual 77th submit complete in both lock interleavings', async () => {
  const cases = [
    { actor: '75000000-0000-4000-8000-000000000001', first: 'visit' },
    { actor: '75000000-0000-4000-8000-000000000002', first: 'submit' },
  ];

  for (const scenario of cases) {
    const gate = `${scenario.first}-first`;
    const holderName = `original77-${scenario.first}-holder`;
    const waiterName = `original77-${scenario.first}-waiter`;
    setupActor(scenario.actor);
    createGate(gate);
    const visit = `select * from public.record_app_visit(${literal(scenario.actor)}::uuid);`;
    const submit = submitSql(scenario.actor);
    const firstStatement = scenario.first === 'visit' ? visit : submit;
    const secondStatement = scenario.first === 'visit' ? submit : visit;
    const first = settle(fixture.queryAsBootstrapAsync(actorSql(scenario.actor, `${firstStatement}
      ${gateHoldSql(gate,holderName)}`)));
    let second;
    let overlapError;
    try {
      const holder = await waitForHolder(holderName);
      second = settle(fixture.queryAsBootstrapAsync(actorSql(scenario.actor,
        `${applicationNameSql(waiterName)} ${secondStatement}`)));
      await waitForBlockedWaiter(waiterName,holder.pid);
    } catch (error) {
      overlapError = error;
    } finally {
      releaseGate(gate);
    }
    const results = await Promise.all([first,second]);
    if (overlapError) throw overlapError;
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'],
      `${scenario.first}-first interleaving must finish without a lock error.`);
    assert.deepEqual(completionSnapshot(scenario.actor), {
      checkIns: 77,
      checkInPointEvents: 1,
      totalPoints: 1,
      completionEvents: 1,
      finisherAwards: 1,
      appVisits: 1,
    });
  }
});
