begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(68);

select is(
  has_function_privilege(
    'authenticated',
    'public.update_integration_destination_settings(uuid,uuid,boolean,boolean,boolean,boolean,text,boolean)',
    'EXECUTE'
  ),
  false,
  'the browser cannot bypass the integration settings Edge Function'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.resolve_claimed_outbound_delivery(uuid,uuid)',
    'EXECUTE'
  ),
  false,
  'the browser cannot resolve a claimed provider delivery'
);
select is(
  has_function_privilege(
    'service_role',
    'public.update_integration_destination_settings(uuid,uuid,boolean,boolean,boolean,boolean,text,boolean)',
    'EXECUTE'
  ),
  true,
  'the integration Edge Function can update destination settings'
);
select is(
  has_function_privilege(
    'service_role',
    'private.enqueue_crew_outbound_event(uuid,text,text,jsonb,uuid)',
    'EXECUTE'
  ),
  false,
  'even the service API cannot forge trusted source-table events directly'
);
select is(
  has_function_privilege('service_role', 'public.queue_due_leaderboard_recaps()', 'EXECUTE'),
  true,
  'the delivery worker can queue due anonymous leaderboard recaps'
);

select ok(
  private.outbound_event_payload_is_safe(
    'check_in',
    '{"challengeDay":12,"status":"partial","completedCount":5}'::jsonb
  ),
  'the exact provider-neutral Check-In payload is accepted'
);
select is(
  private.outbound_event_payload_is_safe(
    'check_in',
    '{"challengeDay":12,"status":"partial","completedCount":5,"body":"private"}'::jsonb
  ),
  false,
  'an extra free-form body is rejected from a Check-In payload'
);
select is(
  private.outbound_event_payload_is_safe(
    'journal_entry',
    '{"prayer":"private","email":"private@example.test"}'::jsonb
  ),
  false,
  'journal, prayer, and email events are outside the outbound allowlist'
);
select is(
  private.outbound_event_payload_is_safe(
    'streak_milestone',
    '{"streakType":"app","milestone":7.5}'::jsonb
  ),
  false,
  'fractional streak milestones are rejected'
);

insert into private.integration_destinations (
  id,
  crew_id,
  provider,
  provider_workspace_id,
  provider_destination_id,
  display_name,
  credential_ciphertext,
  credential_nonce,
  credential_key_version,
  credential_fingerprint,
  scopes,
  installed_by
) values
  (
    'd0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'slack',
    'T-FOU542-ALPHA',
    'C-FOU542-ALPHA',
    'Alpha updates',
    decode(repeat('11', 17), 'hex'),
    decode(repeat('22', 12), 'hex'),
    1,
    repeat('3', 64),
    array['chat:write'],
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    'd0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000002',
    'discord',
    'G-FOU542-BRAVO',
    'C-FOU542-BRAVO',
    'Bravo updates',
    decode(repeat('44', 17), 'hex'),
    decode(repeat('55', 12), 'hex'),
    1,
    repeat('6', 64),
    array['SendMessages'],
    '20000000-0000-4000-8000-000000000002'
  );

select is(
  (
    select concat_ws(':', check_ins_enabled, streak_milestones_enabled,
      badges_rewards_enabled, membership_enabled, recap_cadence, include_safe_link)
    from private.integration_destinations
    where id = 'd0000000-0000-4000-8000-000000000001'
  ),
  'f:f:f:f:off:t',
  'all event categories fail closed while safe Dominion links default on'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
values (
  'b0000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'Alice Example',
  'member'
);
insert into public.outbound_update_preferences (
  crew_id,
  user_id,
  outbound_updates_enabled,
  presentation_mode,
  share_check_ins,
  share_streak_milestones,
  share_badges_rewards,
  share_membership_events
) values (
  'b0000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  true,
  'anonymous',
  false,
  false,
  false,
  true
);
select ok(
  public.update_integration_destination_settings(
    'd0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    false, false, false, true, 'off', false
  ),
  'the Bravo owner independently enables only membership updates'
);

select throws_ok(
  $$
    select public.update_integration_destination_settings(
      'd0000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000003',
      true, true, true, true, 'weekly', true
    )
  $$,
  '42501',
  'Only a group owner or admin can manage integrations.',
  'a regular group member cannot configure outbound events'
);
select throws_ok(
  $$
    select public.update_integration_destination_settings(
      'd0000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      true, true, true, true, 'weekly', true
    )
  $$,
  '42501',
  'Only a group owner or admin can manage integrations.',
  'an owner from another group cannot configure the destination'
);
select throws_ok(
  $$
    select public.update_integration_destination_settings(
      'd0000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      true, true, true, true, 'daily', true
    )
  $$,
  '22023',
  'Leaderboard recap cadence must be off or weekly.',
  'unsupported recap schedules are rejected'
);
select ok(
  public.update_integration_destination_settings(
    'd0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    true, true, true, true, 'weekly', true
  ),
  'the Alpha owner enables the approved event categories and weekly recap'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  (
    select count(*)::integer
    from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001')
  ),
  1,
  'every group member can read the group destination without credentials'
);
select is(
  (
    select concat_ws(':', check_ins_enabled, streak_milestones_enabled,
      badges_rewards_enabled, membership_enabled, recap_cadence, include_safe_link, can_manage)
    from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001')
  ),
  't:t:t:t:weekly:t:f',
  'members see read-only event settings while management remains restricted'
);

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select * from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001') $$,
  '42501',
  'This private group is not available.',
  'destination settings remain isolated from another group'
);
reset role;

insert into public.outbound_update_preferences (
  crew_id,
  user_id,
  outbound_updates_enabled,
  presentation_mode,
  share_check_ins,
  share_streak_milestones,
  share_badges_rewards,
  share_membership_events
) values (
  'a0000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  false,
  'anonymous',
  false,
  false,
  false,
  false
);

select is(
  (select count(*)::integer from private.outbound_deliveries),
  0,
  'recording fail-closed consent does not publish a membership event'
);

update public.outbound_update_preferences
set outbound_updates_enabled = true,
    presentation_mode = 'named',
    share_check_ins = true,
    share_streak_milestones = true,
    share_badges_rewards = true,
    share_membership_events = true
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where event_type = 'membership'
      and crew_id = 'a0000000-0000-4000-8000-000000000001'
  ),
  0,
  'enabling consent does not misrepresent an old membership as a new join'
);

update public.outbound_update_preferences
set share_membership_events = false
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000001';
update public.crew_members
set joined_at = now()
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000001';
update public.outbound_update_preferences
set share_membership_events = true
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where event_type = 'membership'
      and crew_id = 'a0000000-0000-4000-8000-000000000001'
  ),
  1,
  'membership is queued only after the member explicitly approves it'
);
select ok(
  (
    select subject_user_id = '10000000-0000-4000-8000-000000000001'::uuid
      and source_reference ~ '^membership:a0000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000001:[0-9]{20}$'
      and payload = '{}'::jsonb
    from private.outbound_deliveries
    where event_type = 'membership'
  ),
  'membership delivery stores consent context but no member content'
);

insert into public.challenge_entries (
  user_id,
  entry_date,
  completed,
  workout_difficulty
) values (
  '10000000-0000-4000-8000-000000000001',
  current_date - 30,
  array['bible'],
  '{}'::jsonb
) on conflict (user_id, entry_date) do update set
  completed = excluded.completed,
  workout_difficulty = excluded.workout_difficulty;

insert into public.check_ins (
  id,
  user_id,
  entry_date,
  challenge_day,
  status,
  completed_count,
  completed,
  workout_difficulty
) values (
  'd1000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  current_date - 30,
  2,
  'partial',
  1,
  array['bible'],
  '{}'::jsonb
);

select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where event_type = 'check_in'
      and source_reference = 'check-in:d1000000-0000-4000-8000-000000000001'
  ),
  1,
  'a submitted Check-In emits one durable canonical event'
);
select is(
  (
    select payload
    from private.outbound_deliveries
    where event_type = 'check_in'
      and source_reference = 'check-in:d1000000-0000-4000-8000-000000000001'
  ),
  '{"challengeDay":2,"status":"partial","completedCount":1}'::jsonb,
  'the Check-In event contains only the rendered allowlist fields'
);

insert into public.challenge_entries (
  user_id,
  entry_date,
  completed,
  workout_difficulty
) values (
  '10000000-0000-4000-8000-000000000001',
  current_date - 29,
  array['bible'],
  '{}'::jsonb
) on conflict (user_id, entry_date) do update set
  completed = excluded.completed,
  workout_difficulty = excluded.workout_difficulty;

select throws_ok(
  $$
    insert into public.check_ins (
      id,
      user_id,
      entry_date,
      challenge_day,
      status,
      completed_count,
      completed,
      workout_difficulty
    ) values (
      'd1000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      current_date - 29,
      3,
      'scheduled',
      0,
      '{}',
      '{}'::jsonb
    )
  $$,
  '22023',
  'Scheduled miss Check-Ins are no longer supported.',
  'the retired scheduled-miss status is rejected before outbound delivery'
);

select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where source_reference = 'check-in:d1000000-0000-4000-8000-000000000002'
  ),
  0,
  'a scheduled miss is not represented as a submitted Check-In update'
);

insert into public.user_badges (user_id, badge_key, entry_date)
values ('10000000-0000-4000-8000-000000000001', 'first_sweat', null);
select is(
  (
    select payload ->> 'rewardName'
    from private.outbound_deliveries
    where source_reference = 'badge:10000000-0000-4000-8000-000000000001:first_sweat'
  ),
  'First Sweat',
  'an earned badge emits the definition name instead of private metadata'
);

insert into public.user_challenge_states (
  user_id,
  challenge_key,
  status,
  unlock_points,
  unlocked_at
) values (
  '10000000-0000-4000-8000-000000000001',
  'twenty_one_day_prayer',
  'available',
  3000,
  now()
);
select is(
  (
    select payload
    from private.outbound_deliveries
    where source_reference = 'challenge:10000000-0000-4000-8000-000000000001:twenty_one_day_prayer'
  ),
  '{"rewardKind":"challenge","rewardName":"21-Day Prayer Track"}'::jsonb,
  'an unlocked challenge emits only its public reward kind and title'
);

update public.user_game_stats
set current_app_streak = 7,
    best_app_streak = 7
where user_id = '10000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where event_type = 'streak_milestone'
      and payload ->> 'streakType' = 'app'
  ),
  2,
  'a streak jump emits each newly crossed supported milestone once'
);
select is(
  (
    select array_agg((payload ->> 'milestone')::integer order by (payload ->> 'milestone')::integer)
    from private.outbound_deliveries
    where event_type = 'streak_milestone'
      and payload ->> 'streakType' = 'app'
  ),
  array[3, 7],
  'only the configured 3-day and 7-day milestones are emitted'
);
select is(
  (
    select count(*)::integer
    from pg_trigger trigger_row
    join pg_class table_row on table_row.oid = trigger_row.tgrelid
    join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
    where not trigger_row.tgisinternal
      and schema_row.nspname = 'public'
      and table_row.relname in ('challenge_entries', 'journal_entries', 'community_posts', 'post_comments')
      and trigger_row.tgname like 'emit%outbound%'
  ),
  0,
  'draft checkboxes, journals, posts, and comments are not outbound event sources'
);
select ok(
  not exists (
    select 1
    from private.outbound_deliveries delivery,
      lateral jsonb_object_keys(delivery.payload) payload_key
    where lower(payload_key) in ('body', 'text', 'content', 'prayer', 'journal', 'email', 'note')
  ),
  'canonical event payloads contain no free-form or private-content fields'
);
select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where crew_id = 'b0000000-0000-4000-8000-000000000002'
  ),
  0,
  'Alpha activity never crosses into the Bravo destination'
);

delete from private.outbound_deliveries;

select is(
  private.enqueue_crew_outbound_event(
    '10000000-0000-4000-8000-000000000001',
    'check_in',
    'test-resolver-check-in',
    '{"challengeDay":12,"status":"partial","completedCount":5}'::jsonb
  ),
  1,
  'the trusted emitter queues one consented destination delivery'
);
select is(
  private.enqueue_crew_outbound_event(
    '10000000-0000-4000-8000-000000000001',
    'check_in',
    'test-resolver-check-in',
    '{"challengeDay":12,"status":"partial","completedCount":5}'::jsonb
  ),
  1,
  'an exact trusted-emitter retry resolves to the same logical delivery'
);
select is(
  (
    select count(*)::integer
    from private.outbound_deliveries
    where source_reference = 'test-resolver-check-in'
  ),
  1,
  'the trusted emitter remains idempotent without duplicating the outbox row'
);

create temporary table fou542_claimed on commit drop as
select *
from public.claim_outbound_deliveries(
  'd2000000-0000-4000-8000-000000000001',
  1
);

select is(
  (select subject_user_id from fou542_claimed),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'the claim contract returns the consent subject to the worker'
);
select is(
  (select source_reference from fou542_claimed),
  'test-resolver-check-in',
  'the claim contract returns the private source reference to the worker'
);

set local "request.jwt.claims" = '{"role":"service_role"}';

select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'eligible'
    from fou542_claimed
  ),
  'true',
  'send-time resolution approves a currently consented delivery'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'reason'
    from fou542_claimed
  ),
  'approved',
  'the eligible resolution exposes a safe machine-readable reason'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'presentationMode'
    from fou542_claimed
  ),
  'named',
  'the resolver carries the member current named presentation choice'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'subjectName'
    from fou542_claimed
  ),
  'Alice Example',
  'a named resolution looks up the current member display name'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'crewName'
    from fou542_claimed
  ),
  'Alpha Crew',
  'the resolver supplies the current group name for server rendering'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'includeSafeLink'
    from fou542_claimed
  ),
  'true',
  'the resolver carries only the approved Dominion-link switch'
);
select is(
  (
    select count(*)::integer
    from jsonb_object_keys(
      public.resolve_claimed_outbound_delivery(
        (select delivery_id from fou542_claimed),
        'd2000000-0000-4000-8000-000000000001'
      )
    )
  ),
  6,
  'the resolver response has exactly the six worker contract fields'
);

select is(
  private.enqueue_crew_outbound_event(
    '10000000-0000-4000-8000-000000000001',
    'badge_reward',
    'test-pending-consent-change',
    '{"rewardKind":"badge","rewardName":"Consent Test"}'::jsonb
  ),
  1,
  'another approved member event can wait behind the claimed delivery'
);

update public.outbound_update_preferences
set outbound_updates_enabled = false
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000001';

select is(
  (
    select status
    from private.outbound_deliveries
    where id = (select delivery_id from fou542_claimed)
  ),
  'processing',
  'a consent change leaves a worker-owned row for send-time resolution'
);
select is(
  (
    select status
    from private.outbound_deliveries
    where source_reference = 'test-pending-consent-change'
  ),
  'cancelled',
  'a consent change immediately cancels matching queued deliveries'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'eligible'
    from fou542_claimed
  ),
  'false',
  'send-time resolution observes consent revoked after claim'
);
select is(
  (
    select public.resolve_claimed_outbound_delivery(
      delivery_id,
      'd2000000-0000-4000-8000-000000000001'
    ) ->> 'reason'
    from fou542_claimed
  ),
  'updates_disabled',
  'the worker receives the current fail-closed consent reason'
);
select is(
  public.cancel_claimed_outbound_delivery(
    (select delivery_id from fou542_claimed),
    'd2000000-0000-4000-8000-000000000001',
    'updates_disabled'
  ),
  'cancelled',
  'an ineligible claimed delivery is cancelled instead of sent'
);
select ok(
  (
    select status = 'cancelled'
      and lock_token is null
      and locked_at is null
      and cancelled_at is not null
    from private.outbound_deliveries
    where id = (select delivery_id from fou542_claimed)
  ),
  'cancellation safely releases the durable worker lock'
);
select is(
  (
    select outcome
    from private.integration_delivery_attempts
    where delivery_id = (select delivery_id from fou542_claimed)
  ),
  'cancelled',
  'send-time cancellation is retained in attempt history'
);
select throws_ok(
  $$
    select public.cancel_claimed_outbound_delivery(
      (select delivery_id from fou542_claimed),
      'd2000000-0000-4000-8000-000000000001',
      'Unsafe reason!'
    )
  $$,
  '22023',
  'Invalid delivery cancellation reason.',
  'unbounded cancellation text cannot enter delivery history'
);

update public.outbound_update_preferences
set outbound_updates_enabled = true,
    share_check_ins = true,
    share_streak_milestones = true,
    share_badges_rewards = true,
    share_membership_events = true
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000001';

select is(
  private.enqueue_crew_outbound_event(
    '10000000-0000-4000-8000-000000000001',
    'streak_milestone',
    'test-settings-streak',
    '{"streakType":"app","milestone":14}'::jsonb
  ),
  1,
  'a currently enabled streak event is queued'
);
select ok(
  public.update_integration_destination_settings(
    'd0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    true, false, true, true, 'weekly', true
  ),
  'the owner can disable one destination event category'
);
select is(
  (
    select status
    from private.outbound_deliveries
    where source_reference = 'test-settings-streak'
  ),
  'cancelled',
  'disabling a destination category cancels its pending delivery'
);
select ok(
  (
    select count(*) >= 2
    from private.integration_connection_audit
    where destination_id = 'd0000000-0000-4000-8000-000000000001'
      and action = 'settings_updated'
  ),
  'destination setting changes are retained in redacted admin audit history'
);

delete from private.outbound_deliveries;

insert into public.challenge_entries (
  user_id,
  entry_date,
  completed,
  workout_difficulty
) values (
  '10000000-0000-4000-8000-000000000001',
  date_trunc('week', now() at time zone 'UTC')::date - 6,
  array['bible', 'walk'],
  '{}'::jsonb
) on conflict (user_id, entry_date) do update set
  completed = excluded.completed,
  workout_difficulty = excluded.workout_difficulty;

insert into public.check_ins (
  id,
  user_id,
  entry_date,
  challenge_day,
  status,
  completed_count,
  completed,
  workout_difficulty
) values (
  'd1000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  date_trunc('week', now() at time zone 'UTC')::date - 6,
  70,
  'partial',
  2,
  array['bible', 'walk'],
  '{}'::jsonb
);

delete from private.outbound_deliveries
where event_type <> 'leaderboard_recap';

select is(
  public.queue_due_leaderboard_recaps(),
  1,
  'the worker queues one recap for the previous completed UTC week'
);
select is(
  public.queue_due_leaderboard_recaps(),
  0,
  'weekly recap retries are idempotent per destination and period'
);
select ok(
  (
    select subject_user_id is null
      and source_reference like 'leaderboard:a0000000-0000-4000-8000-000000000001:%'
    from private.outbound_deliveries
    where event_type = 'leaderboard_recap'
  ),
  'leaderboard recaps are aggregate events with no member consent subject'
);
select is(
  (
    select payload ->> 'memberCount'
    from private.outbound_deliveries
    where event_type = 'leaderboard_recap'
  ),
  '2',
  'the recap exposes only the current aggregate member count'
);
select is(
  (
    select payload ->> 'checkInCount'
    from private.outbound_deliveries
    where event_type = 'leaderboard_recap'
  ),
  '1',
  'the recap aggregates Check-Ins for the completed period'
);
select is(
  (
    select payload ->> 'completedStandards'
    from private.outbound_deliveries
    where event_type = 'leaderboard_recap'
  ),
  '2',
  'the recap aggregates completed standards without member details'
);
select is(
  (
    select count(*)::integer
    from private.outbound_deliveries delivery,
      lateral jsonb_object_keys(delivery.payload) payload_key
    where delivery.event_type = 'leaderboard_recap'
      and payload_key not in ('periodLabel', 'memberCount', 'checkInCount', 'completedStandards')
  ),
  0,
  'the recap payload contains only the four provider renderer fields'
);

select ok(
  public.update_integration_destination_settings(
    'd0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    true, false, true, true, 'off', true
  ),
  'the owner can turn weekly recaps off'
);
select is(
  (
    select status
    from private.outbound_deliveries
    where event_type = 'leaderboard_recap'
  ),
  'cancelled',
  'turning recaps off cancels the pending aggregate delivery'
);

update private.integration_destinations
set last_error_code = 'provider_unavailable'
where id = 'd0000000-0000-4000-8000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  (
    select corrective_action
    from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001')
  ),
  'Wait for the provider and retry the test.',
  'members receive a non-sensitive corrective action for destination health'
);
reset role;

select * from finish();
rollback;
