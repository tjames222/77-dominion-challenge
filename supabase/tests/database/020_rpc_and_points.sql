begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

delete from public.game_point_events
where user_id = '30000000-0000-4000-8000-000000000003';
delete from public.user_game_stats
where user_id = '30000000-0000-4000-8000-000000000003';

select ok(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'test_award',
    11,
    current_date,
    1,
    null,
    '{"test":true}',
    'test:points:carol'
  ),
  'the first point award is accepted'
);

select is(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'test_award',
    11,
    current_date,
    1,
    null,
    '{"test":true}',
    'test:points:carol'
  ),
  false,
  'a retried point award is idempotent'
);

select is(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'invalid_award',
    -1,
    current_date,
    1,
    null,
    '{}',
    'test:points:negative'
  ),
  false,
  'negative point awards are rejected'
);

select is(
  (select count(*)::integer from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003'),
  1,
  'idempotent retries create one ledger event'
);
select is(
  (select total_points from public.user_game_stats where user_id = '30000000-0000-4000-8000-000000000003'),
  11,
  'the cached total advances exactly once'
);
select is(
  (select total_points from public.user_game_stats where user_id = '30000000-0000-4000-8000-000000000003'),
  (select coalesce(sum(points), 0)::integer from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003'),
  'the cached point total equals the immutable ledger sum'
);

delete from public.check_ins
where user_id = '10000000-0000-4000-8000-000000000001'
  and entry_date = current_date;
delete from public.game_point_events
where user_id = '10000000-0000-4000-8000-000000000001'
  and idempotency_key = 'checkin:10000000-0000-4000-8000-000000000001:' || current_date::text;
update public.profiles
set challenge_start_date = current_date, time_zone = 'UTC'
where user_id = '10000000-0000-4000-8000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test","user_metadata":{"name":"Alice Example"}}';

select lives_ok(
  $$ select public.mutate_daily_standard_draft(current_date, 'bible', true) $$,
  'the trusted draft mutation records the completed Daily Standard before submission'
);

reset role;

select throws_ok(
  $$
    insert into public.check_ins (
      user_id,
      entry_date,
      challenge_day,
      status,
      completed_count,
      completed,
      workout_difficulty
    ) values (
      '10000000-0000-4000-8000-000000000001',
      current_date,
      1,
      'scheduled',
      0,
      '{}',
      '{}'::jsonb
    )
  $$,
  '22023',
  'Scheduled miss Check-Ins are no longer supported.',
  'a direct scheduled Check-In cannot be normalized past the retirement guard'
);

set local role authenticated;

select is(
  public.submit_daily_check_in(
    'complete',
    array['bible', 'bible', 'notAnAction'],
    '{}',
    'UTC',
    current_date
  ) ->> 'status',
  'partial',
  'the RPC derives status from the authoritative draft instead of client-supplied actions'
);

reset role;

select is(
  (select completed_count from public.check_ins where user_id = '10000000-0000-4000-8000-000000000001' and entry_date = current_date),
  1,
  'spoofed duplicate and unknown submission identifiers are ignored'
);
select is(
  (select count(*)::integer from public.check_ins where user_id = '10000000-0000-4000-8000-000000000001' and entry_date = current_date),
  1,
  'the RPC persists one check-in for the date'
);
select is(
  (select count(*)::integer from public.game_point_events where idempotency_key = 'checkin:10000000-0000-4000-8000-000000000001:' || current_date::text),
  1,
  'the check-in has exactly one point-ledger event'
);
select is(
  (select points_awarded from public.check_ins where user_id = '10000000-0000-4000-8000-000000000001' and entry_date = current_date),
  (select points from public.game_point_events where idempotency_key = 'checkin:10000000-0000-4000-8000-000000000001:' || current_date::text),
  'the check-in award agrees with its ledger event'
);
select ok(
  (select points_awarded >= 0 from public.check_ins where user_id = '10000000-0000-4000-8000-000000000001' and entry_date = current_date),
  'a check-in never awards negative points'
);

set local role authenticated;

select throws_ok(
  $$
    update public.profiles
    set challenge_start_date = current_date - 1
    where user_id = auth.uid()
  $$,
  'P0001',
  'The challenge start date is locked after the first check-in.',
  'the first check-in locks the challenge start date'
);

select throws_ok(
  $$ select public.start_challenge('twenty_one_day_prayer') $$,
  'P0001',
  'That challenge is still locked.',
  'a challenge below the point threshold remains locked'
);

select is(
  jsonb_array_length(public.claim_challenge_unlocks() -> 'claimedKeys'),
  1,
  'an eligible pending unlock is claimed once'
);
select is(
  jsonb_array_length(public.claim_challenge_unlocks() -> 'claimedKeys'),
  0,
  'retrying an unlock claim is idempotent'
);

select * from finish();
rollback;
