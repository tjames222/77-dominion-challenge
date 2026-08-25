begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(73);

create temporary table activation_test_clock (
  user_date date not null
);
insert into activation_test_clock (user_date)
values ((pg_catalog.clock_timestamp() at time zone 'UTC')::date);
grant select on activation_test_clock to authenticated;

create temporary table activation_test_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on activation_test_results to authenticated;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
select
  '00000000-0000-0000-0000-000000000000',
  fixture.id,
  'authenticated',
  'authenticated',
  fixture.email,
  '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
  pg_catalog.clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  pg_catalog.jsonb_build_object('name', fixture.name),
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
from (values
  (
    'c1000000-0000-4000-8000-000000000001'::uuid,
    'activation-solo@example.test',
    'Activation Solo'
  ),
  (
    'c2000000-0000-4000-8000-000000000002'::uuid,
    'activation-scheduled@example.test',
    'Activation Scheduled'
  ),
  (
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'activation-group@example.test',
    'Activation Group'
  ),
  (
    'c4000000-0000-4000-8000-000000000004'::uuid,
    'activation-outsider@example.test',
    'Activation Outsider'
  ),
  (
    'c5000000-0000-4000-8000-000000000005'::uuid,
    'activation-due-solo-retry@example.test',
    'Activation Due Solo Retry'
  ),
  (
    'c6000000-0000-4000-8000-000000000006'::uuid,
    'activation-due-group-retry@example.test',
    'Activation Due Group Retry'
  ),
  (
    'c7000000-0000-4000-8000-000000000007'::uuid,
    'activation-due-date-update@example.test',
    'Activation Due Date Update'
  ),
  (
    'c8000000-0000-4000-8000-000000000008'::uuid,
    'activation-quarantined-attempt@example.test',
    'Activation Quarantined Attempt'
  ),
  (
    'c9000000-0000-4000-8000-000000000009'::uuid,
    'activation-quarantined-history@example.test',
    'Activation Quarantined History'
  )
) as fixture(id, email, name);

insert into public.entitlements (
  user_id,
  entitlement_key,
  status,
  source_type,
  source_id,
  starts_at,
  ends_at
)
values (
  'c1000000-0000-4000-8000-000000000001',
  'membership_active',
  'active',
  'test',
  'activation-lifecycle',
  pg_catalog.now() - interval '1 hour',
  pg_catalog.now() + interval '1 day'
);

insert into public.crews (
  id,
  name,
  description,
  challenge_start_date,
  created_by
)
values
  (
    'cf000000-0000-4000-8000-000000000001',
    'Activation Crew',
    'Challenge activation lifecycle coverage',
    (select user_date from activation_test_clock),
    'c3000000-0000-4000-8000-000000000003'
  ),
  (
    'cf000000-0000-4000-8000-000000000009',
    'Quarantined Activation Crew',
    'Retained DR quarantine coverage',
    (select user_date from activation_test_clock),
    'c8000000-0000-4000-8000-000000000008'
  );

insert into public.crew_members (crew_id, user_id, display_name, role)
values
  (
    'cf000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000003',
    'Activation Group',
    'owner'
  ),
  (
    'cf000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000006',
    'Activation Due Group Retry',
    'member'
  ),
  (
    'cf000000-0000-4000-8000-000000000009',
    'c8000000-0000-4000-8000-000000000008',
    'Activation Quarantined Attempt',
    'owner'
  ),
  (
    'cf000000-0000-4000-8000-000000000009',
    'c9000000-0000-4000-8000-000000000009',
    'Activation Quarantined History',
    'member'
  );

insert into public.profiles (
  user_id,
  name,
  email,
  challenge_start_date,
  time_zone,
  challenge_activation_status,
  challenge_participation_mode,
  challenge_activation_time_zone,
  challenge_group_attribution_crew_id,
  challenge_activated_at,
  challenge_activated_by,
  challenge_confirmed_at,
  challenge_confirmed_by,
  challenge_activation_revision,
  challenge_activation_updated_at
)
values
  (
    'c5000000-0000-4000-8000-000000000005',
    'Activation Due Solo Retry',
    'activation-due-solo-retry@example.test',
    (select user_date from activation_test_clock),
    'UTC',
    'scheduled',
    'solo',
    'UTC',
    null,
    null,
    null,
    pg_catalog.statement_timestamp() - interval '1 day',
    'c5000000-0000-4000-8000-000000000005',
    1,
    pg_catalog.statement_timestamp() - interval '1 day'
  ),
  (
    'c6000000-0000-4000-8000-000000000006',
    'Activation Due Group Retry',
    'activation-due-group-retry@example.test',
    (select user_date from activation_test_clock),
    'UTC',
    'scheduled',
    'group',
    'UTC',
    'cf000000-0000-4000-8000-000000000001',
    null,
    null,
    pg_catalog.statement_timestamp() - interval '1 day',
    'c6000000-0000-4000-8000-000000000006',
    1,
    pg_catalog.statement_timestamp() - interval '1 day'
  ),
  (
    'c7000000-0000-4000-8000-000000000007',
    'Activation Due Date Update',
    'activation-due-date-update@example.test',
    (select user_date from activation_test_clock),
    'UTC',
    'scheduled',
    'solo',
    'UTC',
    null,
    null,
    null,
    pg_catalog.statement_timestamp() - interval '1 day',
    'c7000000-0000-4000-8000-000000000007',
    1,
    pg_catalog.statement_timestamp() - interval '1 day'
  ),
  (
    'c9000000-0000-4000-8000-000000000009',
    'Activation Quarantined History',
    'activation-quarantined-history@example.test',
    (select user_date from activation_test_clock),
    'UTC',
    'active',
    'group',
    'UTC',
    'cf000000-0000-4000-8000-000000000009',
    pg_catalog.statement_timestamp() - interval '1 day',
    'c9000000-0000-4000-8000-000000000009',
    pg_catalog.statement_timestamp() - interval '1 day',
    'c9000000-0000-4000-8000-000000000009',
    1,
    pg_catalog.statement_timestamp() - interval '1 day'
  );

set local session_replication_role = replica;
insert into private.retired_community_dr_quarantined_crews (
  crew_id,
  source_batch_id,
  quarantined_at
)
values (
  'cf000000-0000-4000-8000-000000000009',
  'ce000000-0000-4000-8000-000000000009',
  pg_catalog.statement_timestamp()
);
set local session_replication_role = origin;

set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';

-- 01: the RPC still checks authentication when invoked by a privileged role.
select throws_ok(
  $$select public.get_challenge_activation(null)$$,
  '28000',
  'You need to log in to view challenge activation.',
  'challenge activation reads require an authenticated account'
);

-- Private evidence, RPC exposure, and direct-write boundaries.
select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'private.challenge_activation_requests'::regclass),
  'activation request evidence has RLS enabled'
);
select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'private.challenge_activation_migration_reviews'::regclass),
  'activation migration reviews have RLS enabled'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'private.challenge_activation_requests',
    'select'
  ),
  'authenticated clients cannot read private activation requests'
);
select ok(
  has_table_privilege(
    'service_role',
    'private.challenge_activation_requests',
    'select'
  ),
  'the service role can inspect activation requests operationally'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_challenge_activation(uuid)',
    'execute'
  )
  and to_regprocedure('public.get_challenge_activation()') is null,
  'authenticated clients can read their activation contract'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_challenge_activation(uuid)',
    'execute'
  ),
  'anonymous callers cannot read activation state'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.activate_solo_challenge(date,text,uuid,uuid)',
    'execute'
  )
  and to_regprocedure('public.activate_solo_challenge(date,text,uuid)') is null,
  'authenticated clients can invoke Solo activation'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.activate_group_challenge(uuid,text,uuid,uuid)',
    'execute'
  )
  and to_regprocedure('public.activate_group_challenge(uuid,text,uuid)') is null,
  'authenticated clients can invoke Group activation'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.set_challenge_start_date(date,text,uuid,bigint,uuid)',
    'execute'
  )
  and to_regprocedure('public.set_challenge_start_date(date,text,uuid,bigint)') is null,
  'authenticated clients can invoke the date-edit boundary'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.challenge_activation_payload_for_user(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.challenge_activation_allows_date(uuid,date)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.challenge_activation_payload_for_user(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.challenge_activation_allows_date(uuid,date)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.bootstrap_daily_standard_time_zone_pre_activation(text)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.mutate_daily_standard_draft_pre_activation(date,text,boolean,bigint)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.set_daily_standard_workout_difficulty_pre_activation(date,text,text,bigint)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.submit_daily_check_in_pre_activation(text,text[],jsonb,text,date)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.record_app_visit_pre_activation()',
    'execute'
  )
  and to_regprocedure('public.bootstrap_daily_standard_time_zone(text)') is null
  and to_regprocedure(
    'public.mutate_daily_standard_draft(date,text,boolean,bigint)'
  ) is null
  and to_regprocedure(
    'public.set_daily_standard_workout_difficulty(date,text,text,bigint)'
  ) is null
  and to_regprocedure(
    'public.submit_daily_check_in(text,text[],jsonb,text,date)'
  ) is null
  and to_regprocedure('public.record_app_visit()') is null
  and has_function_privilege(
    'authenticated',
    'public.bootstrap_daily_standard_time_zone(text,uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.mutate_daily_standard_draft(date,text,boolean,bigint,uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.set_daily_standard_workout_difficulty(date,text,text,bigint,uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.submit_daily_check_in(text,text[],jsonb,text,date,uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.record_app_visit(uuid)',
    'execute'
  ),
  'internal activation and mature mutation helpers are not executable externally'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.promote_due_challenge_activation(uuid,uuid,timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'private.lock_challenge_activation_actor(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'private.promote_due_challenge_activation(uuid,uuid,timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'private.lock_challenge_activation_actor(uuid)',
    'execute'
  ),
  'the lifecycle write helpers are not exposed to clients'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.profiles',
    'challenge_start_date',
    'update'
  ),
  'clients cannot update a profile challenge date directly'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.profiles',
    'challenge_start_date',
    'insert'
  ),
  'clients cannot seed a profile challenge date directly'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.profiles',
    'challenge_activation_status',
    'update'
  ),
  'clients cannot rewrite the activation state directly'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.crews',
    'challenge_start_date',
    'update'
  ),
  'clients cannot bypass crew-owned challenge dates'
);
select ok(
  (
    select pg_catalog.bool_and(
      procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']
    )
    from pg_proc procedure_row
    where procedure_row.oid in (
      'public.get_challenge_activation(uuid)'::regprocedure,
      'public.activate_solo_challenge(date,text,uuid,uuid)'::regprocedure,
      'public.activate_group_challenge(uuid,text,uuid,uuid)'::regprocedure,
      'public.set_challenge_start_date(date,text,uuid,bigint,uuid)'::regprocedure
    )
  ),
  'activation RPCs are hardened security-definer boundaries'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'c1000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated","email":"activation-solo@example.test","user_metadata":{"name":"Activation Solo"}}';

-- Every mutation boundary rejects a request prepared for a different account
-- before it can inspect or change caller-owned state.
select throws_ok(
  $$select public.get_challenge_activation(
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'challenge activation reads reject a stale expected actor before promotion'
);
select throws_ok(
  $$select public.activate_solo_challenge(
    (select user_date from activation_test_clock),
    'UTC',
    'd0100000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'Solo activation rejects a stale expected actor'
);
select throws_ok(
  $$select public.activate_group_challenge(
    'cf000000-0000-4000-8000-000000000001',
    'UTC',
    'd0100000-0000-4000-8000-000000000002',
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'Group activation rejects a stale expected actor'
);
select throws_ok(
  $$select public.set_challenge_start_date(
    (select user_date from activation_test_clock),
    'UTC',
    'd0100000-0000-4000-8000-000000000003',
    0,
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'date edits reject a stale expected actor'
);
select throws_ok(
  $$select public.bootstrap_daily_standard_time_zone(
    'UTC',
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'Daily Standards timezone bootstrap rejects a stale expected actor'
);
select throws_ok(
  $$select public.mutate_daily_standard_draft(
    (select user_date from activation_test_clock),
    'bible',
    true,
    null,
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'Daily Standards completion rejects a stale expected actor'
);
select throws_ok(
  $$select public.set_daily_standard_workout_difficulty(
    (select user_date from activation_test_clock),
    'one',
    'medium',
    null,
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'workout difficulty rejects a stale expected actor'
);
select throws_ok(
  $$select public.submit_daily_check_in(
    'complete',
    '{}'::text[],
    '{}'::jsonb,
    'UTC',
    (select user_date from activation_test_clock),
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'check-in submission rejects a stale expected actor'
);
select throws_ok(
  $$select * from public.record_app_visit(
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'App Streak recording rejects a stale expected actor'
);

insert into activation_test_results (key, payload)
values (
  'solo-before',
  public.get_challenge_activation('c1000000-0000-4000-8000-000000000001')
);

-- A new account is inert, typed, fail closed, and still earns App Streak.
select is(
  (select payload ->> 'status'
   from activation_test_results where key = 'solo-before'),
  'not_started',
  'a new account reads as not started'
);
select is(
  (
    select pg_catalog.array_agg(payload_key.name order by payload_key.name)
    from activation_test_results result_row
    cross join lateral pg_catalog.jsonb_object_keys(result_row.payload)
      as payload_key(name)
    where result_row.key = 'solo-before'
  ),
  array[
    'activatedAt',
    'activatedBy',
    'canActivateGroup',
    'canActivateSolo',
    'canEditStartDate',
    'canMutateDailyStandards',
    'canParticipate',
    'challengeDay',
    'confirmedAt',
    'confirmedBy',
    'crewId',
    'groupMembershipActive',
    'mode',
    'reviewRequired',
    'revision',
    'schemaVersion',
    'startDate',
    'status',
    'storedStatus',
    'timeZone'
  ]::text[],
  'the activation read returns the complete versioned contract'
);
select ok(
  (
    select payload @> '{
      "canActivateSolo": true,
      "canActivateGroup": true,
      "canParticipate": false,
      "canMutateDailyStandards": false,
      "canEditStartDate": false
    }'::jsonb
    from activation_test_results where key = 'solo-before'
  ),
  'the not-started contract exposes explicit fail-closed capabilities'
);
select ok(
  (
    select challenge_activation_status = 'not_started'
      and challenge_start_date is null
      and challenge_activation_revision = 0
    from public.profiles
    where user_id = 'c1000000-0000-4000-8000-000000000001'
  ),
  'the read lazily creates an inert authoritative profile'
);

insert into activation_test_results (key, payload)
values (
  'solo-draft-before',
  public.get_daily_standard_draft(
    (select user_date from activation_test_clock)
  )
);

select is(
  (
    select (payload ->> 'activation_status') || ':' || (payload ->> 'lock_reason')
    from activation_test_results where key = 'solo-draft-before'
  ),
  'not_started:challenge_not_active',
  'the Daily Standards read is explicitly locked before activation'
);
select throws_ok(
  $$select public.mutate_daily_standard_draft(
    (select user_date from activation_test_clock),
    'bible',
    true,
    null,
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'An active challenge is required before changing Daily Standards.',
  'Daily Standards completion fails closed before activation'
);
select throws_ok(
  $$select public.set_daily_standard_workout_difficulty(
    (select user_date from activation_test_clock),
    'one',
    'medium',
    null,
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'An active challenge is required before changing Daily Standards.',
  'workout difficulty fails closed before activation'
);
select throws_ok(
  $$select public.submit_daily_check_in(
    'complete', '{}'::text[], '{}'::jsonb, 'UTC',
    (select user_date from activation_test_clock),
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'An active challenge is required before posting a check-in.',
  'check-in submission fails closed before activation'
);
select lives_ok(
  $$select * from public.record_app_visit(
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  'App Streak remains independent of challenge activation'
);
reset role;
select is(
  (
    select last_seen_date
    from public.user_game_stats
    where user_id = 'c1000000-0000-4000-8000-000000000001'
  ),
  current_date,
  'a pre-activation app visit still records the authoritative visit date'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'c1000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated","email":"activation-solo@example.test","user_metadata":{"name":"Activation Solo"}}';

-- Non-finite and expired dates are rejected at the lifecycle boundary.
select throws_ok(
  $$select public.activate_solo_challenge(
    'infinity'::date,
    'UTC',
    'd1000000-0000-4000-8000-000000000099',
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '22023',
  'Choose a valid challenge start date.',
  'Solo activation rejects a non-finite date'
);
select throws_ok(
  $$select public.activate_solo_challenge(
    (select user_date - 77 from activation_test_clock),
    'UTC',
    'd1000000-0000-4000-8000-000000000000',
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '22023',
  'Choose a start date within the current 77-day challenge window.',
  'Solo activation rejects an expired challenge window'
);

insert into activation_test_results (key, payload)
values (
  'solo-active',
  public.activate_solo_challenge(
    (select user_date from activation_test_clock),
    'UTC',
    'd1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001'
  )
);

-- Solo activation is authoritative, retry-safe, and conflict-safe.
select is(
  (select payload ->> 'status'
   from activation_test_results where key = 'solo-active'),
  'active',
  'a Solo start today activates immediately'
);
select ok(
  (
    select payload @> '{
      "mode": "solo",
      "challengeDay": 1,
      "canActivateSolo": false,
      "canActivateGroup": false,
      "canParticipate": true,
      "canMutateDailyStandards": true,
      "canEditStartDate": true
    }'::jsonb
    from activation_test_results where key = 'solo-active'
  ),
  'an active Solo payload exposes the intended capabilities'
);
select ok(
  (
    select challenge_activation_status = 'active'
      and challenge_participation_mode = 'solo'
      and challenge_start_date = (select user_date from activation_test_clock)
      and challenge_activation_time_zone = 'UTC'
      and challenge_activated_by = user_id
      and challenge_confirmed_by = user_id
      and challenge_activation_revision = 1
    from public.profiles
    where user_id = 'c1000000-0000-4000-8000-000000000001'
  ),
  'Solo activation persists one complete lifecycle state'
);

insert into activation_test_results (key, payload)
values (
  'solo-replay',
  public.activate_solo_challenge(
    (select user_date from activation_test_clock),
    'UTC',
    'd1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001'
  )
);

select is(
  (
    select (payload ->> 'revision')::bigint
    from activation_test_results where key = 'solo-replay'
  ),
  1::bigint,
  'a matching Solo activation replay does not advance the revision'
);
reset role;
select is(
  (
    select count(*)::integer
    from private.challenge_activation_requests
    where actor_id = 'c1000000-0000-4000-8000-000000000001'
      and action = 'solo_activate'
  ),
  1,
  'a matching Solo replay leaves one private request record'
);
set local role authenticated;
set local "request.jwt.claim.sub" = 'c1000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.activate_solo_challenge(
    (select user_date + 1 from activation_test_clock),
    'UTC',
    'd1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '23505',
  'This request ID was already used for another operation.',
  'a request ID cannot be reused with different Solo inputs'
);
select throws_ok(
  $$select public.activate_solo_challenge(
    (select user_date + 1 from activation_test_clock),
    'UTC',
    'd1000000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'Challenge activation conflicts with the existing participation history.',
  'a second activation cannot replace established Solo history'
);

-- Active mutations work, editable dates use revisions, and check-in locks win.
select lives_ok(
  $$select public.mutate_daily_standard_draft(
    (select user_date from activation_test_clock),
    'bible',
    true,
    null,
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  'an active challenge can mutate Daily Standards'
);

insert into activation_test_results (key, payload)
values (
  'solo-date-edit',
  public.set_challenge_start_date(
    (select user_date - 1 from activation_test_clock),
    'UTC',
    'd1100000-0000-4000-8000-000000000001',
    1,
    'c1000000-0000-4000-8000-000000000001'
  )
);

select ok(
  (
    select payload ->> 'startDate' =
        (select (user_date - 1)::text from activation_test_clock)
      and (payload ->> 'revision')::bigint = 2
      and (payload ->> 'challengeDay')::integer = 2
      and (payload ->> 'canEditStartDate')::boolean
    from activation_test_results where key = 'solo-date-edit'
  ),
  'an unchecked Solo date edit updates the timeline and revision'
);

insert into activation_test_results (key, payload)
values (
  'solo-date-replay',
  public.set_challenge_start_date(
    (select user_date - 1 from activation_test_clock),
    'UTC',
    'd1100000-0000-4000-8000-000000000001',
    1,
    'c1000000-0000-4000-8000-000000000001'
  )
);

reset role;
select ok(
  (
    select count(*) = 1
      and min((result ->> 'revision')::bigint) = 2
    from private.challenge_activation_requests
    where actor_id = 'c1000000-0000-4000-8000-000000000001'
      and action = 'date_update'
  ),
  'a matching date-edit replay returns one persisted result'
);
set local role authenticated;
set local "request.jwt.claim.sub" = 'c1000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.set_challenge_start_date(
    (select user_date from activation_test_clock),
    'UTC',
    'd1100000-0000-4000-8000-000000000002',
    1,
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '40001',
  'The challenge timeline changed in another session. Refresh and try again.',
  'a stale revision cannot overwrite a changed Solo timeline'
);

insert into activation_test_results (key, payload)
values (
  'solo-check-in',
  public.submit_daily_check_in(
    'complete',
    array['bible'],
    '{}'::jsonb,
    'UTC',
    (select user_date from activation_test_clock),
    'c1000000-0000-4000-8000-000000000001'
  )
);

select is(
  (select payload ->> 'status'
   from activation_test_results where key = 'solo-check-in'),
  'partial',
  'an active challenge can submit an authoritative check-in'
);

insert into activation_test_results (key, payload)
values (
  'solo-after-check-in',
  public.get_challenge_activation('c1000000-0000-4000-8000-000000000001')
);

select is(
  (
    select (payload ->> 'canEditStartDate')::boolean
    from activation_test_results where key = 'solo-after-check-in'
  ),
  false,
  'the first check-in removes date-edit capability'
);
select throws_ok(
  $$select public.set_challenge_start_date(
    (select user_date from activation_test_clock),
    'UTC',
    'd1100000-0000-4000-8000-000000000003',
    2,
    'c1000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'The challenge start date is locked after the first check-in.',
  'the date-edit RPC fails closed after the first check-in'
);
select throws_ok(
  $$update public.profiles
    set challenge_start_date = (select user_date from activation_test_clock)
    where user_id = auth.uid()$$,
  '42501',
  'permission denied for table profiles',
  'direct profile writes cannot bypass the post-check-in lock'
);

-- A future Solo start remains inert until its server-owned date is due.
set local "request.jwt.claim.sub" = 'c2000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" =
  '{"sub":"c2000000-0000-4000-8000-000000000002","role":"authenticated","email":"activation-scheduled@example.test","user_metadata":{"name":"Activation Scheduled"}}';

insert into activation_test_results (key, payload)
values (
  'scheduled',
  public.activate_solo_challenge(
    (select user_date + 1 from activation_test_clock),
    'UTC',
    'd2000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000002'
  )
);

select ok(
  (
    select payload @> '{
      "status": "scheduled",
      "storedStatus": "scheduled",
      "mode": "solo",
      "canParticipate": false,
      "canMutateDailyStandards": false,
      "canEditStartDate": true
    }'::jsonb
    from activation_test_results where key = 'scheduled'
  ),
  'a future Solo start is scheduled without opening participation'
);
select throws_ok(
  $$select public.mutate_daily_standard_draft(
    (select user_date from activation_test_clock),
    'bible',
    true,
    null,
    'c2000000-0000-4000-8000-000000000002'
  )$$,
  '55000',
  'An active challenge is required before changing Daily Standards.',
  'scheduled challenges remain mutation-locked'
);

-- Simulate the calendar reaching the confirmed date without changing any
-- lifecycle metadata; the next authoritative read must perform the promotion.
reset role;
update public.profiles
set challenge_start_date = (select user_date from activation_test_clock)
where user_id = 'c2000000-0000-4000-8000-000000000002';

set local role authenticated;
set local "request.jwt.claim.sub" = 'c2000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" =
  '{"sub":"c2000000-0000-4000-8000-000000000002","role":"authenticated","email":"activation-scheduled@example.test","user_metadata":{"name":"Activation Scheduled"}}';
insert into activation_test_results (key, payload)
values (
  'scheduled-due',
  public.get_challenge_activation('c2000000-0000-4000-8000-000000000002')
);

select ok(
  (
    select payload @> '{
      "status": "active",
      "storedStatus": "active",
      "revision": 2,
      "challengeDay": 1,
      "canParticipate": true,
      "canMutateDailyStandards": false
    }'::jsonb
    from activation_test_results where key = 'scheduled-due'
  ),
  'an authoritative read promotes a due schedule without bypassing entitlement'
);

-- Compatible lifecycle mutations must persist the same due promotion before
-- they build a typed response, even when the requested values are unchanged.
set local "request.jwt.claim.sub" = 'c5000000-0000-4000-8000-000000000005';
set local "request.jwt.claims" =
  '{"sub":"c5000000-0000-4000-8000-000000000005","role":"authenticated","email":"activation-due-solo-retry@example.test","user_metadata":{"name":"Activation Due Solo Retry"}}';
insert into activation_test_results (key, payload)
values (
  'due-solo-retry',
  public.activate_solo_challenge(
    (select user_date from activation_test_clock),
    'UTC',
    'd5000000-0000-4000-8000-000000000005',
    'c5000000-0000-4000-8000-000000000005'
  )
);

select ok(
  (
    select payload @> '{
      "status": "active",
      "storedStatus": "active",
      "mode": "solo",
      "revision": 2,
      "canParticipate": true
    }'::jsonb
      and payload ->> 'activatedAt' is not null
      and payload ->> 'activatedBy' = 'c5000000-0000-4000-8000-000000000005'
    from activation_test_results where key = 'due-solo-retry'
  ),
  'a compatible Solo retry returns one persisted active contract when its schedule is due'
);
select ok(
  (
    select challenge_activation_status = 'active'
      and challenge_activated_at is not null
      and challenge_activated_by = user_id
      and challenge_activation_revision = 2
    from public.profiles
    where user_id = 'c5000000-0000-4000-8000-000000000005'
  ),
  'a compatible Solo retry persists the due transition exactly once'
);

set local "request.jwt.claim.sub" = 'c6000000-0000-4000-8000-000000000006';
set local "request.jwt.claims" =
  '{"sub":"c6000000-0000-4000-8000-000000000006","role":"authenticated","email":"activation-due-group-retry@example.test","user_metadata":{"name":"Activation Due Group Retry"}}';
insert into activation_test_results (key, payload)
values (
  'due-group-retry',
  public.activate_group_challenge(
    'cf000000-0000-4000-8000-000000000001',
    'UTC',
    'd6000000-0000-4000-8000-000000000006',
    'c6000000-0000-4000-8000-000000000006'
  )
);

select ok(
  (
    select payload @> '{
      "status": "active",
      "storedStatus": "active",
      "mode": "group",
      "revision": 2,
      "canParticipate": true
    }'::jsonb
      and payload ->> 'activatedAt' is not null
      and payload ->> 'activatedBy' = 'c6000000-0000-4000-8000-000000000006'
    from activation_test_results where key = 'due-group-retry'
  ),
  'a compatible Group retry returns one persisted active contract when its schedule is due'
);
select ok(
  (
    select challenge_activation_status = 'active'
      and challenge_activated_at is not null
      and challenge_activated_by = user_id
      and challenge_activation_revision = 2
    from public.profiles
    where user_id = 'c6000000-0000-4000-8000-000000000006'
  ),
  'a compatible Group retry persists the due transition exactly once'
);

set local "request.jwt.claim.sub" = 'c7000000-0000-4000-8000-000000000007';
set local "request.jwt.claims" =
  '{"sub":"c7000000-0000-4000-8000-000000000007","role":"authenticated","email":"activation-due-date-update@example.test","user_metadata":{"name":"Activation Due Date Update"}}';
insert into activation_test_results (key, payload)
values (
  'due-date-no-op',
  public.set_challenge_start_date(
    (select user_date from activation_test_clock),
    'UTC',
    'd7000000-0000-4000-8000-000000000007',
    1,
    'c7000000-0000-4000-8000-000000000007'
  )
);

select ok(
  (
    select payload @> '{
      "status": "active",
      "storedStatus": "active",
      "mode": "solo",
      "revision": 2,
      "canParticipate": true
    }'::jsonb
      and payload ->> 'activatedAt' is not null
      and payload ->> 'activatedBy' = 'c7000000-0000-4000-8000-000000000007'
    from activation_test_results where key = 'due-date-no-op'
  ),
  'a no-op date update returns one persisted active contract when its schedule is due'
);
select ok(
  (
    select challenge_activation_status = 'active'
      and challenge_activated_at is not null
      and challenge_activated_by = user_id
      and challenge_activation_revision = 2
    from public.profiles
    where user_id = 'c7000000-0000-4000-8000-000000000007'
  ),
  'a no-op date update persists the due transition exactly once'
);

set local "request.jwt.claim.sub" = 'c8000000-0000-4000-8000-000000000008';
set local "request.jwt.claims" =
  '{"sub":"c8000000-0000-4000-8000-000000000008","role":"authenticated","email":"activation-quarantined-attempt@example.test","user_metadata":{"name":"Activation Quarantined Attempt"}}';
select throws_ok(
  $$select public.activate_group_challenge(
    'cf000000-0000-4000-8000-000000000009',
    'UTC',
    'd8000000-0000-4000-8000-000000000008',
    'c8000000-0000-4000-8000-000000000008'
  )$$,
  '42501',
  'Current crew membership is required for Group activation.',
  'a retained quarantined crew cannot be used for Group activation'
);

set local "request.jwt.claim.sub" = 'c9000000-0000-4000-8000-000000000009';
set local "request.jwt.claims" =
  '{"sub":"c9000000-0000-4000-8000-000000000009","role":"authenticated","email":"activation-quarantined-history@example.test","user_metadata":{"name":"Activation Quarantined History"}}';
insert into activation_test_results (key, payload)
values (
  'quarantined-history',
  public.get_challenge_activation('c9000000-0000-4000-8000-000000000009')
);

select is(
  (
    select (payload ->> 'groupMembershipActive')::boolean
    from activation_test_results where key = 'quarantined-history'
  ),
  false,
  'a retained quarantined crew never restores live Group membership capability'
);

-- Group activation requires membership and retains immutable attribution.
set local "request.jwt.claim.sub" = 'c4000000-0000-4000-8000-000000000004';
set local "request.jwt.claims" =
  '{"sub":"c4000000-0000-4000-8000-000000000004","role":"authenticated","email":"activation-outsider@example.test","user_metadata":{"name":"Activation Outsider"}}';
select throws_ok(
  $$select public.activate_group_challenge(
    'cf000000-0000-4000-8000-000000000001',
    'UTC',
    'd4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000004'
  )$$,
  '42501',
  'Current crew membership is required for Group activation.',
  'an outsider cannot activate against another crew'
);

set local "request.jwt.claim.sub" = 'c3000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"c3000000-0000-4000-8000-000000000003","role":"authenticated","email":"activation-group@example.test","user_metadata":{"name":"Activation Group"}}';

insert into activation_test_results (key, payload)
values (
  'group-active',
  public.activate_group_challenge(
    'cf000000-0000-4000-8000-000000000001',
    'UTC',
    'd3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000003'
  )
);

select ok(
  (
    select payload @> '{
      "status": "active",
      "storedStatus": "active",
      "mode": "group",
      "crewId": "cf000000-0000-4000-8000-000000000001",
      "groupMembershipActive": true,
      "canParticipate": true,
      "canMutateDailyStandards": false,
      "canEditStartDate": false
    }'::jsonb
    from activation_test_results where key = 'group-active'
  ),
  'Group activation succeeds without misreporting subscription-gated mutations'
);
reset role;
select ok(
  (
    select challenge_participation_mode = 'group'
      and challenge_group_attribution_crew_id =
        'cf000000-0000-4000-8000-000000000001'
      and challenge_start_date = (select user_date from activation_test_clock)
      and challenge_activation_revision = 1
    from public.profiles
    where user_id = 'c3000000-0000-4000-8000-000000000003'
  ),
  'Group activation persists the authoritative crew attribution'
);

insert into public.entitlements (
  user_id,
  entitlement_key,
  status,
  source_type,
  source_id,
  starts_at,
  ends_at
)
values (
  'c3000000-0000-4000-8000-000000000003',
  'membership_active',
  'active',
  'test',
  'activation-group-lifecycle',
  pg_catalog.now() - interval '1 hour',
  pg_catalog.now() + interval '1 day'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'c3000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"c3000000-0000-4000-8000-000000000003","role":"authenticated","email":"activation-group@example.test","user_metadata":{"name":"Activation Group"}}';

insert into activation_test_results (key, payload)
values (
  'group-entitled',
  public.get_challenge_activation('c3000000-0000-4000-8000-000000000003')
);

select is(
  (
    select (payload ->> 'canMutateDailyStandards')::boolean
    from activation_test_results where key = 'group-entitled'
  ),
  true,
  'the read contract opens Daily Standards after entitlement becomes active'
);

insert into activation_test_results (key, payload)
values (
  'group-replay',
  public.activate_group_challenge(
    'cf000000-0000-4000-8000-000000000001',
    'UTC',
    'd3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000003'
  )
);

reset role;
select ok(
  (
    select count(*) = 1
      and min((result ->> 'revision')::bigint) = 1
    from private.challenge_activation_requests
    where actor_id = 'c3000000-0000-4000-8000-000000000003'
      and action = 'group_activate'
  ),
  'a matching Group replay leaves one private request and one revision'
);
set local role authenticated;
set local "request.jwt.claim.sub" = 'c3000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.set_challenge_start_date(
    (select user_date from activation_test_clock),
    'UTC',
    'd3100000-0000-4000-8000-000000000001',
    1,
    'c3000000-0000-4000-8000-000000000003'
  )$$,
  '55000',
  'A Group challenge start date is owned by the crew.',
  'a member cannot rewrite the crew-owned Group date'
);
select throws_ok(
  $$select public.activate_solo_challenge(
    (select user_date from activation_test_clock),
    'UTC',
    'd3100000-0000-4000-8000-000000000002',
    'c3000000-0000-4000-8000-000000000003'
  )$$,
  '55000',
  'Challenge activation conflicts with the existing participation history.',
  'a Group participant cannot replace history with Solo mode'
);

reset role;
delete from public.crew_members
where crew_id = 'cf000000-0000-4000-8000-000000000001'
  and user_id = 'c3000000-0000-4000-8000-000000000003';

set local role authenticated;
set local "request.jwt.claim.sub" = 'c3000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"c3000000-0000-4000-8000-000000000003","role":"authenticated","email":"activation-group@example.test","user_metadata":{"name":"Activation Group"}}';
insert into activation_test_results (key, payload)
values (
  'group-after-leave',
  public.get_challenge_activation('c3000000-0000-4000-8000-000000000003')
);

select ok(
  (
    select payload @> '{
      "mode": "group",
      "crewId": "cf000000-0000-4000-8000-000000000001",
      "groupMembershipActive": false
    }'::jsonb
    from activation_test_results where key = 'group-after-leave'
  ),
  'leaving a crew changes live membership without erasing Group attribution'
);

reset role;
update public.crews
set deleted_at = pg_catalog.now(),
    deleted_by = 'c3000000-0000-4000-8000-000000000003'
where id = 'cf000000-0000-4000-8000-000000000001';

select is(
  (
    select challenge_group_attribution_crew_id
    from public.profiles
    where user_id = 'c3000000-0000-4000-8000-000000000003'
  ),
  'cf000000-0000-4000-8000-000000000001'::uuid,
  'soft deletion cannot erase the historical Group attribution'
);

select * from finish();
rollback;
