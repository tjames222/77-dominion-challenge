begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

select ok(
  exists (
    select 1
    from public.reward_definitions
    where reward_key = 'dominion_night_theme'
  ),
  'the stable Dominion Night reward definition exists'
);
select is(
  (select reward_type from public.reward_definitions where reward_key = 'dominion_night_theme'),
  'cosmetic',
  'the theme is a cosmetic instead of a badge or challenge'
);
select is(
  (select state_model from public.reward_definitions where reward_key = 'dominion_night_theme'),
  'ownership',
  'the theme uses permanent ownership state'
);
select is(
  (select points_required from public.reward_definitions where reward_key = 'dominion_night_theme'),
  500,
  'the configured threshold is exactly 500 total points'
);
select is(
  (select fulfillment_key from public.reward_definitions where reward_key = 'dominion_night_theme'),
  'dominion-night',
  'the fulfillment identity matches the stable theme registry key'
);
select is(
  (select display_metadata ->> 'themeKey' from public.reward_definitions where reward_key = 'dominion_night_theme'),
  'dominion-night',
  'the read metadata exposes the stable theme key'
);
select is(
  (select display_metadata ->> 'selectionRoute' from public.reward_definitions where reward_key = 'dominion_night_theme'),
  'profile.html#appearance',
  'the reward tells the UI where an owned theme can be selected'
);
select is(
  (
    select reward_key
    from public.reward_definitions
    where is_active
    order by points_required, sort_order, reward_key
    limit 1
  ),
  'dominion_night_theme',
  'Dominion Night is the lowest active point reward'
);
select ok(
  not exists (
    select 1
    from public.reward_definitions
    where reward_key <> 'dominion_night_theme'
      and points_required < 1000
  ),
  'all existing rewards remain at 1,000 points or higher'
);
select throws_ok(
  $$
    insert into public.reward_definitions (
      reward_key,
      reward_type,
      state_model,
      title,
      points_required,
      fulfillment_key,
      is_active
    ) values (
      'too_cheap_fixture',
      'cosmetic',
      'ownership',
      'Too Cheap',
      499,
      'too-cheap-fixture',
      true
    )
  $$,
  '23514',
  'Active point rewards must require at least 500 points.',
  'the trusted catalog rejects an active reward below Dominion Night'
);
select is(
  (
    select array_agg(points_required order by points_required)
    from public.reward_definitions
    where reward_type = 'challenge'
  ),
  array[1000, 3000, 4500, 6000, 10000],
  'existing challenge thresholds are unchanged'
);

select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '10000000-0000-4000-8000-000000000001'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'an existing user above 500 is automatically backfilled once'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  0,
  'an existing user below 500 is not backfilled'
);
select is(
  (
    select count(*)::integer
    from private.reward_audit_events
    where reward_key = 'dominion_night_theme'
      and event_type = 'reward_definition_configured'
  ),
  1,
  'the initial trusted reward definition is audited once'
);
select is(
  (
    select count(*)::integer
    from private.reward_audit_events
    where reward_key = 'dominion_night_theme'
      and user_id = '10000000-0000-4000-8000-000000000001'
      and event_type = 'reward_entitlement_granted'
  ),
  1,
  'the existing-user grant has one audit event'
);
select ok(
  not exists (
    select 1
    from private.reward_audit_events
    where metadata ?| array['email', 'name', 'journal', 'reflection']
  ),
  'reward audit metadata excludes profile and private-content fields'
);
select is(
  has_table_privilege('authenticated', 'private.reward_audit_events', 'SELECT'),
  false,
  'browser clients cannot read private reward audit records'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.backfill_reward_entitlements(text,uuid,integer,boolean)',
    'EXECUTE'
  ),
  false,
  'browser clients cannot run reward backfills'
);
select is(
  has_function_privilege(
    'service_role',
    'public.backfill_reward_entitlements(text,uuid,integer,boolean)',
    'EXECUTE'
  ),
  true,
  'the trusted service role can resume reward backfills'
);

select is(
  public.reward_catalog_for_user(
    '20000000-0000-4000-8000-000000000002', 100, null, null
  ) #>> '{items,0,status}',
  'locked',
  'the server reports the theme locked without an entitlement row'
);
select is(
  (
    public.reward_catalog_for_user(
      '20000000-0000-4000-8000-000000000002', 100, null, null
    ) #>> '{items,0,currentPoints}'
  )::integer,
  400,
  'locked progress uses the authoritative overall point total'
);
select is(
  (
    public.reward_catalog_for_user(
      '20000000-0000-4000-8000-000000000002', 100, null, null
    ) #>> '{items,0,pointsRemaining}'
  )::integer,
  100,
  'locked progress reports accurate points remaining'
);
select is(
  public.reward_catalog_for_user(
    '20000000-0000-4000-8000-000000000002', 100, null, null
  ) #>> '{nextUnlock,key}',
  'dominion_night_theme',
  'Dominion Night is emphasized as the nearest locked reward'
);

update public.user_game_stats
set total_points = 499
where user_id = '20000000-0000-4000-8000-000000000002';
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  0,
  '499 points remains locked'
);
select is(
  (
    public.reward_catalog_for_user(
      '20000000-0000-4000-8000-000000000002', 100, null, null
    ) #>> '{items,0,pointsRemaining}'
  )::integer,
  1,
  'the boundary contract reports one point remaining at 499'
);

update public.user_game_stats
set total_points = 500
where user_id = '20000000-0000-4000-8000-000000000002';
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'crossing 500 automatically grants one permanent entitlement'
);
select ok(
  (
    select owned_at is not null
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  'the grant records an unlock timestamp'
);
select is(
  public.reconcile_user_reward_entitlements(
    '20000000-0000-4000-8000-000000000002'
  ),
  0,
  'a retried reconciliation is idempotent'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'retries cannot duplicate ownership'
);
select is(
  (
    select count(*)::integer
    from private.reward_audit_events
    where reward_key = 'dominion_night_theme'
      and user_id = '20000000-0000-4000-8000-000000000002'
      and event_type = 'reward_entitlement_granted'
  ),
  1,
  'retries cannot duplicate the grant audit event'
);

update public.user_game_stats
set total_points = 10
where user_id = '20000000-0000-4000-8000-000000000002';
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'a downward point correction never revokes the earned theme'
);

update public.entitlements
set status = 'expired', ends_at = now() - interval '1 day'
where user_id = '20000000-0000-4000-8000-000000000002'
  and entitlement_key = 'membership_active';
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '20000000-0000-4000-8000-000000000002'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'a membership lapse does not delete cosmetic ownership'
);
select is(
  public.reward_catalog_for_user(
    '20000000-0000-4000-8000-000000000002', 100, null, null
  ) #>> '{items,0,status}',
  'owned',
  'the read contract trusts persisted ownership after point and membership changes'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  jsonb_array_length(public.claim_reward_entitlement_unlocks() -> 'claimedKeys'),
  1,
  'the new ownership produces one unlock celebration'
);
select is(
  jsonb_array_length(public.claim_reward_entitlement_unlocks() -> 'claimedKeys'),
  0,
  'the unlock celebration never replays across claims'
);
reset role;

select ok(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'migration_fixture',
    479,
    current_date,
    1,
    null,
    '{"fixture":true}',
    'theme:carol:base'
  ),
  'a valid overall point source advances reward progress'
);
select ok(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'check_in',
    999,
    current_date,
    1,
    null,
    '{"completedCount":7}',
    'theme:carol:daily-standards'
  ),
  'the seven-point Daily Standards source advances reward progress'
);
select is(
  (
    select total_points
    from public.user_game_stats
    where user_id = '30000000-0000-4000-8000-000000000003'
  ),
  486,
  'Daily Standards contribute their server-derived seven points'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'dominion_night_theme'
  ),
  0,
  'the Daily Standards source does not grant below the threshold'
);
select ok(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'sharing_bonus',
    14,
    current_date,
    1,
    null,
    '{"award":"first_successful_share"}',
    'theme:carol:sharing-bonus'
  ),
  'the prospective one-time Sharing Bonus advances reward progress'
);
select is(
  (
    select total_points
    from public.user_game_stats
    where user_id = '30000000-0000-4000-8000-000000000003'
  ),
  500,
  'all valid sources contribute to the same authoritative total'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'the Sharing Bonus can cross the threshold and grant the theme'
);
select is(
  public.add_game_points(
    '30000000-0000-4000-8000-000000000003',
    'sharing_bonus',
    14,
    current_date,
    1,
    null,
    '{"award":"first_successful_share"}',
    'theme:carol:sharing-bonus'
  ),
  false,
  'a retried Sharing Bonus cannot advance points twice'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'dominion_night_theme'
  ),
  1,
  'a point-source retry cannot duplicate ownership'
);
select is(
  (
    select count(*)::integer
    from private.reward_audit_events
    where reward_key = 'dominion_night_theme'
      and user_id = '30000000-0000-4000-8000-000000000003'
      and event_type = 'reward_entitlement_granted'
  ),
  1,
  'the point-source grant is audited once'
);

create temporary table first_theme_backfill as
select public.backfill_reward_entitlements(
  'dominion_night_theme', null, 1, false
) as result;
select is(
  (select (result ->> 'complete')::boolean from first_theme_backfill),
  false,
  'a bounded backfill exposes that another eligible page remains'
);
select is(
  (select result ->> 'nextCursor' from first_theme_backfill),
  '10000000-0000-4000-8000-000000000001',
  'a resumable backfill returns a stable user cursor'
);

create temporary table second_theme_backfill as
select public.backfill_reward_entitlements(
  'dominion_night_theme',
  '10000000-0000-4000-8000-000000000001',
  1,
  false
) as result;
select is(
  (select (result ->> 'processedCount')::integer from second_theme_backfill),
  1,
  'the next backfill page resumes after the supplied cursor'
);
select is(
  (select (result ->> 'insertedCount')::integer from second_theme_backfill),
  0,
  'rerunning a page does not recreate existing ownership'
);
select is(
  (select (result ->> 'complete')::boolean from second_theme_backfill),
  true,
  'the resumable backfill reports completion at the end'
);

update public.reward_definitions
set points_required = 600
where reward_key = 'dominion_night_theme';
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where reward_key = 'dominion_night_theme'
      and user_id in (
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000003'
      )
  ),
  3,
  'raising the configured threshold never relocks prior owners'
);
update public.reward_definitions
set points_required = 500
where reward_key = 'dominion_night_theme';
select is(
  (
    select count(*)::integer
    from private.reward_audit_events
    where reward_key = 'dominion_night_theme'
      and event_type = 'reward_definition_configured'
  ),
  2,
  'configuration auditing is immutable and deduplicates a restored definition'
);
select is(
  (select points_required from public.reward_definitions where reward_key = 'dominion_night_theme'),
  500,
  'the theme returns to its rollout threshold after configuration testing'
);

update public.reward_definitions
set is_active = false
where reward_key = 'dominion_night_theme';
select is(
  public.reward_catalog_for_user(
    '10000000-0000-4000-8000-000000000001', 100, null, null
  ) #>> '{items,0,active}',
  'false',
  'unavailable reward configuration fails closed for UI activation'
);
select is(
  jsonb_array_length(
    public.reward_catalog_for_user(
      '10000000-0000-4000-8000-000000000001', 100, null, null
    ) #> '{items,0,allowedActions}'
  ),
  0,
  'a cosmetic never exposes a challenge Start action'
);
select is(
  public.reward_catalog_for_user(
    '10000000-0000-4000-8000-000000000001', 100, null, null
  ) #>> '{items,0,status}',
  'owned',
  'temporary configuration unavailability preserves stored ownership'
);

select * from finish();
rollback;
