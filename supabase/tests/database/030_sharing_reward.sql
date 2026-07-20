begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(38);

create temporary table sharing_test_state (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on sharing_test_state to authenticated;

select is(
  has_table_privilege('authenticated', 'public.sharing_reward_intents', 'SELECT'),
  false,
  'authenticated users cannot read raw Sharing intents'
);
select is(
  has_table_privilege('authenticated', 'public.sharing_reward_evidence', 'SELECT'),
  false,
  'authenticated users cannot read trusted Sharing evidence directly'
);
select is(
  has_function_privilege('authenticated', 'public.record_confirmed_group_invite_share(uuid,uuid)', 'EXECUTE'),
  false,
  'authenticated users cannot forge confirmed invite evidence'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';

select throws_ok(
  $$ select public.create_sharing_reward_intent('page_view') $$,
  'P0001',
  'This share method cannot earn the Sharing reward.',
  'a page view cannot create eligible reward evidence'
);

insert into sharing_test_state (key, payload)
values ('canceled', public.create_sharing_reward_intent('native_share'));

select is(
  (select payload ->> 'eligible' from sharing_test_state where key = 'canceled'),
  'true',
  'an authenticated native-share action can start a bounded intent'
);
select is(
  length((select payload ->> 'completionToken' from sharing_test_state where key = 'canceled')),
  64,
  'the completion token carries 256 bits of random material'
);

reset role;

select ok(
  exists (
    select 1
    from public.sharing_reward_intents intent
    join sharing_test_state state on state.key = 'canceled'
    where intent.user_id = '30000000-0000-4000-8000-000000000003'
      and intent.completion_token_hash = extensions.digest(state.payload ->> 'completionToken', 'sha256')
  ),
  'only the completion-token digest is persisted'
);
select is(
  (select count(*)::integer from public.sharing_reward_evidence where user_id = '30000000-0000-4000-8000-000000000003'),
  0,
  'opening or canceling a share sheet does not create completion evidence'
);
select is(
  (select count(*)::integer from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003' and event_type = 'sharing_bonus'),
  0,
  'an uncompleted share intent does not award points'
);
select is(
  (select count(*)::integer from public.user_badges where user_id = '30000000-0000-4000-8000-000000000003' and badge_key = 'sharing'),
  0,
  'an uncompleted share intent does not award the badge'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';

select throws_ok(
  format(
    'select public.complete_sharing_reward(%L)',
    (select payload ->> 'completionToken' from sharing_test_state where key = 'canceled')
  ),
  'P0001',
  'This share confirmation is invalid or expired.',
  'a completion token is bound to the user who created it'
);

set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';

insert into sharing_test_state (key, payload)
values ('copy', public.create_sharing_reward_intent('copy_link'));

insert into sharing_test_state (key, payload)
select
  'copy-result',
  public.complete_sharing_reward(payload ->> 'completionToken')
from sharing_test_state
where key = 'copy';

select is(
  (select payload ->> 'granted' from sharing_test_state where key = 'copy-result'),
  'true',
  'a completed copy-link action grants the reward'
);
select is(
  (select (payload ->> 'points')::integer from sharing_test_state where key = 'copy-result'),
  14,
  'the Sharing Bonus is exactly 14 points'
);
select is(
  (select payload ->> 'badgeKey' from sharing_test_state where key = 'copy-result'),
  'sharing',
  'the completion response names the permanent Sharing badge'
);
select is(
  (select count(*)::integer from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003' and event_type = 'sharing_bonus'),
  1,
  'one immutable Sharing Bonus ledger event is written'
);
select is(
  (select points from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003' and event_type = 'sharing_bonus'),
  14,
  'the ledger event records all 14 out-of-cap points'
);
select is(
  (select metadata ->> 'dailyCap' from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003' and event_type = 'sharing_bonus'),
  'false',
  'the ledger distinguishes the bonus from the seven-point daily cap'
);
select is(
  (select total_points from public.user_game_stats where user_id = '30000000-0000-4000-8000-000000000003'),
  14,
  'the cached total immediately includes the Sharing Bonus'
);
select is(
  (select challenge_points from public.user_game_stats where user_id = '30000000-0000-4000-8000-000000000003'),
  14,
  'reward and next-unlock progress immediately include the Sharing Bonus'
);
select is(
  (select count(*)::integer from public.sharing_reward_grants where user_id = '30000000-0000-4000-8000-000000000003'),
  1,
  'one immutable reward audit record is written'
);
select ok(
  exists (
    select 1
    from public.sharing_reward_grants reward
    join public.game_point_events event on event.id = reward.point_event_id
    where reward.user_id = '30000000-0000-4000-8000-000000000003'
      and event.idempotency_key = 'sharing_bonus:30000000-0000-4000-8000-000000000003'
  ),
  'the reward audit record references its ledger event'
);
select is(
  (select count(*)::integer from public.user_badges where user_id = '30000000-0000-4000-8000-000000000003' and badge_key = 'sharing'),
  1,
  'the permanent Sharing badge is awarded once'
);
select is(
  (select entry_date from public.user_badges where user_id = '30000000-0000-4000-8000-000000000003' and badge_key = 'sharing'),
  null,
  'the Sharing badge does not consume a daily badge date'
);

insert into sharing_test_state (key, payload)
select
  'copy-retry',
  public.complete_sharing_reward(payload ->> 'completionToken')
from sharing_test_state
where key = 'copy';

select is(
  (select payload ->> 'alreadyGranted' from sharing_test_state where key = 'copy-retry'),
  'true',
  'retrying the same completion is idempotent'
);
select is(
  (select count(*)::integer from public.game_point_events where user_id = '30000000-0000-4000-8000-000000000003' and event_type = 'sharing_bonus'),
  1,
  'a completion retry cannot duplicate the point event'
);
select is(
  (public.create_sharing_reward_intent('native_share') ->> 'eligible'),
  'false',
  'no new reward intent is issued after the lifetime reward is granted'
);

reset role;

insert into sharing_test_state (key, payload)
values (
  'invite-result',
  public.record_confirmed_group_invite_share(
    '20000000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000001'
  )
);

select is(
  (select payload ->> 'granted' from sharing_test_state where key = 'invite-result'),
  'true',
  'a server-confirmed private-group invite grants the inviter reward'
);
select is(
  (select count(*)::integer from public.game_point_events where user_id = '20000000-0000-4000-8000-000000000002' and event_type = 'sharing_bonus'),
  1,
  'confirmed invite attribution creates one inviter ledger event'
);
select is(
  (select count(*)::integer from public.user_badges where user_id = '20000000-0000-4000-8000-000000000002' and badge_key = 'sharing'),
  1,
  'confirmed invite attribution creates one inviter badge'
);
select is(
  (
    public.record_confirmed_group_invite_share(
      '20000000-0000-4000-8000-000000000002',
      'c1000000-0000-4000-8000-000000000001'
    ) ->> 'alreadyGranted'
  ),
  'true',
  'retrying the same confirmed invite is idempotent'
);
select throws_ok(
  $$
    select public.record_confirmed_group_invite_share(
      '10000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000001'
    )
  $$,
  'P0001',
  'Confirmed invite attribution does not match its original inviter.',
  'a redemption ID cannot be reassigned to another inviter'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';

select is(
  (select count(*)::integer from public.sharing_reward_grants),
  1,
  'RLS lets a user read only their own reward audit record'
);

reset role;

create or replace function pg_temp.reject_sharing_reward_audit()
returns trigger
language plpgsql
as $$
begin
  raise exception 'forced Sharing reward audit failure';
end;
$$;

create trigger reject_sharing_reward_audit
  before insert on public.sharing_reward_grants
  for each row execute function pg_temp.reject_sharing_reward_audit();

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

insert into sharing_test_state (key, payload)
values ('rollback', public.create_sharing_reward_intent('copy_link'));

select throws_ok(
  format(
    'select public.complete_sharing_reward(%L)',
    (select payload ->> 'completionToken' from sharing_test_state where key = 'rollback')
  ),
  'P0001',
  'forced Sharing reward audit failure',
  'a failed audit write rolls back the whole reward grant'
);

reset role;

select is(
  (select count(*)::integer from public.game_point_events where user_id = '10000000-0000-4000-8000-000000000001' and event_type = 'sharing_bonus'),
  0,
  'a rolled-back reward leaves no point event'
);
select is(
  (select count(*)::integer from public.user_badges where user_id = '10000000-0000-4000-8000-000000000001' and badge_key = 'sharing'),
  0,
  'a rolled-back reward leaves no Sharing badge'
);
select is(
  (select count(*)::integer from public.sharing_reward_evidence where user_id = '10000000-0000-4000-8000-000000000001'),
  0,
  'a rolled-back reward leaves no completion evidence'
);
select is(
  (select completed_at from public.sharing_reward_intents where user_id = '10000000-0000-4000-8000-000000000001'),
  null,
  'a rolled-back reward leaves its intent unconsumed'
);
select is(
  (select total_points from public.user_game_stats where user_id = '10000000-0000-4000-8000-000000000001'),
  1200,
  'a rolled-back reward leaves the cached balance unchanged'
);

select * from finish();
rollback;
