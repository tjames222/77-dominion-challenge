begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(40);

select ok(to_regclass('public.reward_definitions') is not null, 'the typed reward catalog exists');
select ok(to_regclass('public.user_reward_entitlements') is not null, 'permanent reward ownership exists');
select is(
  (select count(*)::integer from public.reward_definitions where reward_type = 'challenge'),
  5,
  'all existing Challenge Vault definitions are represented once'
);
select is(
  (
    select array_agg(points_required order by points_required)
    from public.reward_definitions
    where reward_type = 'challenge'
  ),
  array[1000, 3000, 4500, 6000, 10000],
  'the existing challenge thresholds are preserved'
);
select ok(
  not exists (
    select 1 from public.reward_definitions
    where reward_type = 'challenge'
      and state_model <> 'challenge_lifecycle'
  ),
  'challenge rewards retain their lifecycle state model'
);
select is(
  public.grant_reward_entitlement(
    '10000000-0000-4000-8000-000000000001',
    'seven_day_reset'
  ),
  false,
  'a challenge cannot be granted as a permanent cosmetic entitlement'
);

select lives_ok(
  $$
    insert into public.reward_definitions (
      reward_key,
      reward_type,
      state_model,
      title,
      description,
      points_required,
      fulfillment_key,
      required_entitlement_key,
      icon,
      sort_order,
      display_metadata
    ) values (
      'test_theme_reward',
      'cosmetic',
      'ownership',
      'Test Theme',
      'A fixture cosmetic reward.',
      500,
      'dominion_night_test',
      null,
      'palette',
      5,
      '{"preview":"night"}'
    )
  $$,
  'the catalog can represent a cosmetic ownership reward'
);
select throws_ok(
  $$
    update public.reward_definitions
    set fulfillment_key = 'mutable_identity_attempt'
    where reward_key = 'test_theme_reward'
  $$,
  '55000',
  'Reward identity fields are immutable.',
  'stable reward and fulfillment identities cannot be edited'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '10000000-0000-4000-8000-000000000001'
      and reward_key = 'test_theme_reward'
  ),
  1,
  'an already-qualified user is granted the cosmetic idempotently'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'test_theme_reward'
  ),
  0,
  'a user below the threshold is not granted the cosmetic'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  jsonb_array_length(public.get_reward_catalog() -> 'items'),
  6,
  'the authenticated read contract returns challenges and cosmetics together'
);
select is(
  public.get_reward_catalog() #>> '{items,1,status}',
  'available',
  'the existing unlocked challenge stays available'
);
select is(
  public.get_reward_catalog() #>> '{items,1,allowedActions,0}',
  'start',
  'only the available challenge exposes its existing Start action'
);
select is(
  public.get_reward_catalog() #>> '{items,0,status}',
  'owned',
  'the cosmetic uses owned instead of challenge lifecycle states'
);
select is(
  public.get_reward_catalog() #>> '{nextUnlock,key}',
  'twenty_one_day_prayer',
  'the contract identifies the next reachable locked reward'
);
select is(
  (public.get_reward_catalog(2) #>> '{page,hasMore}')::boolean,
  true,
  'the catalog exposes bounded pagination'
);
select is(
  public.get_reward_catalog(2) #>> '{page,nextCursor,key}',
  'seven_day_reset',
  'the stable cursor points after the last returned reward'
);
select is(
  (select count(*)::integer from public.user_reward_entitlements),
  1,
  'RLS exposes only the current user reward entitlement'
);
select throws_ok(
  $$
    insert into public.user_reward_entitlements (user_id, reward_key)
    values ('20000000-0000-4000-8000-000000000002', 'test_theme_reward')
  $$,
  '42501',
  'permission denied for table user_reward_entitlements',
  'the browser cannot mint reward ownership'
);

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  (select count(*)::integer from public.user_reward_entitlements),
  0,
  'another user cannot read Alice reward ownership'
);
select is(
  public.get_reward_catalog() #>> '{nextUnlock,key}',
  'test_theme_reward',
  'the nearest locked reward is calculated from the current user points'
);
select is(
  (public.get_reward_catalog() #>> '{nextUnlock,pointsRemaining}')::integer,
  100,
  'next-unlock progress uses the authoritative point total'
);

reset role;
set local role anon;
select throws_ok(
  $$ select public.get_reward_catalog() $$,
  '42501',
  'permission denied for function get_reward_catalog',
  'anonymous users cannot read the reward contract'
);
reset role;

delete from public.user_reward_entitlements
where user_id = '30000000-0000-4000-8000-000000000003';
update public.user_game_stats
set total_points = 0
where user_id = '30000000-0000-4000-8000-000000000003';

select is(
  public.reward_catalog_for_user(
    '30000000-0000-4000-8000-000000000003', 100, null, null
  ) #>> '{nextUnlock,status}',
  'locked',
  'a new user sees a locked next reward'
);
select is(
  (
    public.reward_catalog_for_user(
      '30000000-0000-4000-8000-000000000003', 100, null, null
    ) #>> '{nextUnlock,pointsRemaining}'
  )::integer,
  500,
  'a new user sees the complete points remaining'
);

update public.user_game_stats
set total_points = 499
where user_id = '30000000-0000-4000-8000-000000000003';
select is(
  (
    select count(*)::integer from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
  ),
  0,
  'one point below the threshold remains locked'
);

update public.user_game_stats
set total_points = 500
where user_id = '30000000-0000-4000-8000-000000000003';
select is(
  (
    select count(*)::integer from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'test_theme_reward'
  ),
  1,
  'crossing the exact threshold grants one permanent entitlement'
);
select is(
  public.grant_reward_entitlement(
    '30000000-0000-4000-8000-000000000003',
    'test_theme_reward'
  ),
  false,
  'a retried grant is idempotent'
);
select is(
  (
    select count(*)::integer from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'test_theme_reward'
  ),
  1,
  'the uniqueness invariant prevents duplicate ownership'
);

create temporary table reward_catalog_version_before as
select catalog_version
from public.reward_catalog_meta
where catalog_key = 'primary';

update public.user_game_stats
set total_points = 0
where user_id = '30000000-0000-4000-8000-000000000003';
select is(
  (
    select count(*)::integer from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'test_theme_reward'
  ),
  1,
  'a downward point correction never revokes ownership'
);

update public.reward_definitions
set points_required = 900
where reward_key = 'test_theme_reward';
select is(
  (
    select count(*)::integer from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'test_theme_reward'
  ),
  1,
  'raising the catalog threshold never relocks an owned reward'
);
select ok(
  (
    select catalog_version from public.reward_catalog_meta
    where catalog_key = 'primary'
  ) > (select catalog_version from reward_catalog_version_before),
  'catalog edits advance a monotonic version'
);
select is(
  public.reward_catalog_for_user(
    '30000000-0000-4000-8000-000000000003', 100, null, null
  ) #>> '{items,0,status}',
  'owned',
  'the read contract trusts persisted ownership after corrections'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  jsonb_array_length(public.claim_reward_entitlement_unlocks() -> 'claimedKeys'),
  1,
  'one cosmetic unlock celebration is claimed'
);
select is(
  jsonb_array_length(public.claim_reward_entitlement_unlocks() -> 'claimedKeys'),
  0,
  'claim retries never replay a cosmetic unlock celebration'
);
reset role;

update public.reward_definitions
set is_active = false
where reward_key = 'test_theme_reward';
select is(
  public.reward_catalog_for_user(
    '30000000-0000-4000-8000-000000000003', 100, null, null
  ) #>> '{items,0,active}',
  'false',
  'owned cosmetics remain visible when catalog configuration is disabled'
);
select throws_ok(
  $$
    insert into public.user_reward_entitlements (user_id, reward_key)
    values ('30000000-0000-4000-8000-000000000003', 'seven_day_reset')
  $$,
  '23514',
  'Only ownership rewards can create permanent entitlements.',
  'the database rejects an ownership row for a lifecycle challenge'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_reward_entitlements'::regclass),
  'reward ownership has RLS enabled'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.reward_catalog_for_user(uuid,integer,integer,text)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot choose another user for the internal contract'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.get_reward_catalog(integer,integer,text)',
    'EXECUTE'
  ),
  true,
  'authenticated clients can invoke only the current-user catalog wrapper'
);

select * from finish();
rollback;
