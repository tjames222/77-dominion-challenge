begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(65);

select is(
  (
    select array_agg(reward_key order by points_required)
    from public.reward_definitions
    where is_active
  ),
  array[
    'gym_training_discount',
    'dominion_night_theme',
    'nehemiah_leadership_handbook',
    'seven_day_reset',
    'dominion_platinum',
    'big_god_energy_tshirt_discount',
    'twenty_one_day_prayer',
    'thirty_day_strength',
    'forty_day_fast',
    'bible_in_a_year'
  ]::text[],
  'the final launch catalog has exactly ten rewards in point order'
);
select is(
  (
    select array_agg(points_required order by points_required)
    from public.reward_definitions
    where is_active
  ),
  array[21, 56, 98, 140, 210, 273, 336, 406, 469, 532],
  'the database uses the authoritative launch thresholds'
);
select is(
  (
    select array_agg(points_required order by sort_order)
    from public.reward_definitions
    where is_active
  ),
  array[21, 56, 98, 140, 210, 273, 336, 406, 469, 532],
  'catalog ordering matches threshold ordering'
);
select ok(
  not exists (
    select 1
    from (
      select points_required,
        lag(points_required) over (order by points_required) as prior_points
      from public.reward_definitions
      where is_active
    ) as ordered_reward
    where ordered_reward.points_required <= ordered_reward.prior_points
  ),
  'launch thresholds are strictly increasing'
);
select is(
  (
    select array_agg(reward_type order by points_required)
    from public.reward_definitions
    where is_active and state_model = 'ownership'
  ),
  array[
    'partner_discount',
    'cosmetic',
    'digital_download',
    'cosmetic',
    'merch_discount'
  ]::text[],
  'the five permanent rewards have their typed fulfillment kinds'
);
select is(
  (
    select array_agg(points_required order by points_required)
    from public.challenge_definitions
    where is_active
  ),
  array[140, 336, 406, 469, 532],
  'Challenge Vault definitions use the final five lifecycle thresholds'
);
select throws_ok(
  $$
    insert into public.reward_definitions (
      reward_key, reward_type, state_model, title, points_required,
      fulfillment_key, is_active
    ) values (
      'below_launch_floor', 'cosmetic', 'ownership', 'Below Floor', 20,
      'below-launch-floor', true
    )
  $$,
  '23514',
  'Active point rewards must require at least 21 eligible points.',
  'an active reward cannot undercut the first launch threshold'
);

select is(
  private.reward_eligible_points(
    '10000000-0000-4000-8000-000000000001',
    'gym_training_discount'
  ),
  0,
  'legacy non-Check-In points do not unlock the gym reward'
);
select is(
  private.reward_eligible_points(
    '10000000-0000-4000-8000-000000000001',
    'dominion_night_theme'
  ),
  1200,
  'all other rewards read the authoritative lifetime total'
);

delete from public.user_reward_entitlements
where user_id = '30000000-0000-4000-8000-000000000003';
delete from public.game_point_events
where user_id = '30000000-0000-4000-8000-000000000003';
update public.user_game_stats
set total_points = 0,
    challenge_points = 0
where user_id = '30000000-0000-4000-8000-000000000003';

insert into public.game_point_events (
  user_id, event_type, points, entry_date, challenge_day, metadata,
  idempotency_key
)
select
  '30000000-0000-4000-8000-000000000003',
  'check_in',
  7,
  current_date - generated.day_offset,
  generated.day_offset + 1,
  jsonb_build_object('completedCount', 7, 'actionPoints', 7),
  'reward-launch:carol:check-in:' || generated.day_offset
from generate_series(0, 1) as generated(day_offset);

update public.user_game_stats
set total_points = 28,
    challenge_points = 28
where user_id = '30000000-0000-4000-8000-000000000003';

select is(
  private.reward_eligible_points(
    '30000000-0000-4000-8000-000000000003',
    'gym_training_discount'
  ),
  14,
  'two perfect Check-Ins contribute fourteen trusted Daily Standards points'
);
select is(
  public.reconcile_user_reward_entitlements(
    '30000000-0000-4000-8000-000000000003'
  ),
  0,
  'sharing- or adjustment-inflated lifetime points cannot grant the gym reward'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'gym_training_discount'
  ),
  0,
  'the gym entitlement remains absent below twenty-one trusted points'
);
select is(
  public.reward_catalog_for_user(
    '30000000-0000-4000-8000-000000000003', 100, null, null
  ) #>> '{items,0,currentPoints}',
  '14',
  'the gym card displays only its eligible Daily Standards points'
);
select is(
  public.reward_catalog_for_user(
    '30000000-0000-4000-8000-000000000003', 100, null, null
  ) #>> '{items,0,pointsRemaining}',
  '7',
  'the gym card reports eligible points remaining'
);

insert into public.game_point_events (
  user_id, event_type, points, entry_date, challenge_day, metadata,
  idempotency_key
)
values (
  '30000000-0000-4000-8000-000000000003',
  'check_in',
  999,
  current_date - 2,
  3,
  jsonb_build_object('completedCount', 999, 'actionPoints', 999),
  'reward-launch:carol:check-in:2'
);

select is(
  private.reward_eligible_points(
    '30000000-0000-4000-8000-000000000003',
    'gym_training_discount'
  ),
  21,
  'each trusted Check-In contributes at most seven eligible points'
);
select is(
  public.reconcile_user_reward_entitlements(
    '30000000-0000-4000-8000-000000000003'
  ),
  1,
  'crossing twenty-one trusted points grants exactly one entitlement'
);
select is(
  public.reconcile_user_reward_entitlements(
    '30000000-0000-4000-8000-000000000003'
  ),
  0,
  'reward reconciliation is idempotent'
);
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'gym_training_discount'
  ),
  1,
  'the uniqueness invariant preserves one gym entitlement'
);

delete from public.game_point_events
where user_id = '30000000-0000-4000-8000-000000000003'
  and event_type = 'check_in';
update public.user_game_stats
set total_points = 0,
    challenge_points = 0
where user_id = '30000000-0000-4000-8000-000000000003';
select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'gym_training_discount'
  ),
  1,
  'point correction never revokes earned gym ownership'
);

select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '10000000-0000-4000-8000-000000000001'
      and reward_key in (
        'dominion_night_theme',
        'nehemiah_leadership_handbook',
        'dominion_platinum',
        'big_god_energy_tshirt_discount'
      )
  ),
  4,
  'migration backfill permanently grants every lifetime reward Alice earned'
);

delete from public.user_reward_entitlements
where user_id = '10000000-0000-4000-8000-000000000001'
  and reward_key = 'nehemiah_leadership_handbook';
do $$
begin
  perform public.backfill_reward_entitlements(
    'nehemiah_leadership_handbook', null, 500, true
  );
end;
$$;

select is(
  (
    select count(*)::integer
    from public.user_reward_entitlements
    where user_id = '10000000-0000-4000-8000-000000000001'
      and reward_key = 'nehemiah_leadership_handbook'
      and source_type = 'backfill'
      and celebration_seen_at is not null
  ),
  1,
  'trusted catch-up backfills can be silently acknowledged without stacking celebrations'
);
select ok(
  exists (
    select 1
    from public.user_reward_entitlements
    where user_id = '10000000-0000-4000-8000-000000000001'
      and reward_key = 'dominion_night_theme'
      and source_type <> 'launch_curve_backfill'
  ),
  'preexisting Dominion Night ownership is preserved unchanged'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  $$
    select public.get_reward_catalog(
      100, null, null, '20000000-0000-4000-8000-000000000002'
    )
  $$,
  '42501',
  'The signed-in account changed. Try again.',
  'the catalog wrapper rejects a stale or cross-account actor'
);
select is(
  jsonb_array_length(public.get_reward_catalog(
    100, null, null, '30000000-0000-4000-8000-000000000003'
  ) -> 'items'),
  10,
  'the current actor receives all ten launch rewards'
);
select is(
  public.get_reward_catalog(
    100, null, null, '30000000-0000-4000-8000-000000000003'
  ) #>> '{nextUnlock,key}',
  'dominion_night_theme',
  'next unlock skips the permanently owned first reward'
);
select throws_ok(
  $$
    select public.claim_reward_entitlement_unlocks(
      '20000000-0000-4000-8000-000000000002'
    )
  $$,
  '42501',
  'The signed-in account changed. Try again.',
  'unlock claims reject a stale or cross-account actor'
);
select is(
  jsonb_array_length(public.claim_reward_entitlement_unlocks(
    '30000000-0000-4000-8000-000000000003'
  ) -> 'claimedKeys'),
  1,
  'a newly earned entitlement produces one actor-bound celebration'
);
select is(
  jsonb_array_length(public.claim_reward_entitlement_unlocks(
    '30000000-0000-4000-8000-000000000003'
  ) -> 'claimedKeys'),
  0,
  'the actor-bound celebration cannot replay'
);
reset role;

select ok(to_regclass('private.reward_offer_configurations') is not null,
  'versioned private offer configuration exists');
select ok(to_regclass('private.reward_offer_codes') is not null,
  'private discount-code inventory exists');
select ok(to_regclass('private.user_reward_offer_claims') is not null,
  'private user-bound offer claims exist');
select ok(to_regclass('private.reward_download_assets') is not null,
  'private approved-download metadata exists');
select ok(to_regclass('private.reward_download_tickets') is not null,
  'private one-time download tickets exist');
select is(
  (select public from storage.buckets where id = 'reward-downloads'),
  false,
  'the reward-download bucket is private'
);
select is(
  (select file_size_limit::bigint from storage.buckets where id = 'reward-downloads'),
  52428800::bigint,
  'the private reward bucket enforces the fifty-MiB limit'
);
select is(
  has_table_privilege('authenticated', 'private.reward_offer_codes', 'SELECT'),
  false,
  'browser roles cannot read discount-code inventory'
);
select is(
  has_table_privilege('authenticated', 'private.reward_download_assets', 'SELECT'),
  false,
  'browser roles cannot read private storage coordinates'
);
select is(
  (
    select count(*)::integer
    from private.reward_offer_configurations
    where campaign_key = 'production-pending'
      and not is_active
      and partner_name = ''
      and website_url is null
      and destination_url is null
  ),
  2,
  'gym and shirt fulfillment start fail-closed without fake production data'
);
select throws_ok(
  $$
    insert into private.reward_offer_configurations (
      reward_key, campaign_key, version, partner_name, website_url,
      destination_url, offer_title, description, terms,
      availability_state, is_active, approved_at
    ) values (
      'gym_training_discount', 'unsafe-url', 1, 'Unsafe Gym',
      'http://gym.example', 'javascript:alert(1)', 'Offer',
      'Description', 'Terms', 'active', true, now()
    )
  $$,
  '23514',
  null,
  'unsafe offer destinations are rejected by the trusted schema'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  public.get_reward_fulfillment(
    'gym_training_discount',
    '30000000-0000-4000-8000-000000000003'
  ) #>> '{availability}',
  'unavailable',
  'an earned gym reward remains safely unavailable without an approved offer'
);
select is(
  public.get_reward_fulfillment(
    'nehemiah_leadership_handbook',
    '30000000-0000-4000-8000-000000000003'
  ) #>> '{status}',
  'locked',
  'a locked handbook never becomes downloadable'
);
select throws_ok(
  $$
    select public.claim_reward_offer(
      'gym_training_discount',
      '20000000-0000-4000-8000-000000000002'
    )
  $$,
  '42501',
  'The signed-in account changed. Try again.',
  'offer claims reject a stale or cross-account actor'
);
select throws_ok(
  $$
    select public.request_reward_download(
      'nehemiah_leadership_handbook',
      '30000000-0000-4000-8000-000000000003'
    )
  $$,
  '42501',
  'This reward has not been unlocked.',
  'a locked actor cannot request a handbook ticket'
);
reset role;

insert into private.reward_download_assets (
  reward_key,
  edition_key,
  version,
  public_title,
  public_description,
  download_filename,
  object_path,
  sha256_hex,
  size_bytes,
  is_approved,
  approved_at,
  is_active
)
values (
  'nehemiah_leadership_handbook',
  'launch-test',
  1,
  'Nehemiah Leadership Handbook',
  'Approved test edition.',
  'Nehemiah Leadership Handbook.pdf',
  'approved/nehemiah-leadership-handbook-v1.pdf',
  repeat('a', 64),
  4096,
  true,
  now(),
  true
);

create temporary table requested_handbook_download (payload jsonb);
grant insert, select on requested_handbook_download to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into requested_handbook_download (payload)
select public.request_reward_download(
  'nehemiah_leadership_handbook',
  '10000000-0000-4000-8000-000000000001'
);
reset role;

select matches(
  (select payload ->> 'ticket' from requested_handbook_download),
  '^[0-9a-f]{64}$',
  'an entitled actor receives a short-lived opaque download ticket'
);
select is(
  (
    select count(*)::integer
    from private.reward_download_tickets
    where encode(token_hash, 'hex') = (
      select payload ->> 'ticket' from requested_handbook_download
    )
  ),
  0,
  'the raw download ticket is never stored server-side'
);

create temporary table redeemed_handbook_download as
select *
from public.redeem_reward_download_ticket(
  (select payload ->> 'ticket' from requested_handbook_download),
  '10000000-0000-4000-8000-000000000001'
);

select is(
  (select object_path from redeemed_handbook_download),
  'approved/nehemiah-leadership-handbook-v1.pdf',
  'the trusted delivery service resolves an approved ticket to its private object'
);
select is(
  (
    select count(*)::integer
    from public.redeem_reward_download_ticket(
      (select payload ->> 'ticket' from requested_handbook_download),
      '10000000-0000-4000-8000-000000000001'
    )
  ),
  0,
  'a redeemed download ticket cannot be used twice'
);
select is(
  public.record_reward_download_result(
    (select payload ->> 'ticket' from requested_handbook_download),
    '10000000-0000-4000-8000-000000000001',
    true,
    'stream_complete'
  ),
  true,
  'the trusted delivery service records one successful stream outcome'
);
select is(
  public.record_reward_download_result(
    (select payload ->> 'ticket' from requested_handbook_download),
    '10000000-0000-4000-8000-000000000001',
    true,
    'stream_complete'
  ),
  false,
  'a completed download outcome cannot be overwritten by a retry'
);
select is(
  (
    select metadata
    from private.reward_audit_events
    where event_type = 'reward_download_succeeded'
      and user_id = '10000000-0000-4000-8000-000000000001'
  ),
  jsonb_build_object('outcome', 'stream_complete'),
  'download audit evidence records the outcome without exposing storage coordinates'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.record_reward_download_result(text,uuid,boolean,text)',
    'EXECUTE'
  ),
  false,
  'browser clients cannot forge download completion evidence'
);

insert into private.reward_offer_configurations (
  reward_key, campaign_key, version, partner_name, website_url,
  destination_url, offer_title, description, terms, expiration_copy,
  usage_limit, availability_state, is_active, approved_at
)
values (
  'gym_training_discount', 'test-gym', 1, 'Test Gym',
  'https://gym.example', 'https://gym.example/redeem',
  'Test training offer', 'Test discount', 'One use.', 'Ends soon.',
  2, 'active', true, now()
);
insert into private.reward_offer_codes (
  configuration_id, secret_code, max_claims
)
select id, 'PRIVATE-CAROL', 1
from private.reward_offer_configurations
where reward_key = 'gym_training_discount'
  and campaign_key = 'test-gym';

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  public.claim_reward_offer(
    'gym_training_discount',
    '30000000-0000-4000-8000-000000000003'
  ) #>> '{code}',
  'PRIVATE-CAROL',
  'an entitled actor can allocate one private code'
);
select is(
  public.claim_reward_offer(
    'gym_training_discount',
    '30000000-0000-4000-8000-000000000003'
  ) #>> '{code}',
  'PRIVATE-CAROL',
  'a retried claim returns the same actor-bound code'
);
reset role;
select is(
  (
    select claim_count
    from private.reward_offer_codes
    where secret_code = 'PRIVATE-CAROL'
  ),
  1,
  'claim retries never consume a second code allocation'
);
select is(
  (
    select count(*)::integer
    from private.user_reward_offer_claims
    where user_id = '30000000-0000-4000-8000-000000000003'
      and reward_key = 'gym_training_discount'
  ),
  1,
  'one user and campaign produce exactly one private claim row'
);

update private.reward_offer_codes
set is_active = false
where secret_code = 'PRIVATE-CAROL';

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  public.get_reward_fulfillment(
    'gym_training_discount',
    '30000000-0000-4000-8000-000000000003'
  ) #>> '{availability}',
  'unavailable',
  'a deactivated claimed code fails closed in reward details'
);
select is(
  public.get_reward_fulfillment(
    'gym_training_discount',
    '30000000-0000-4000-8000-000000000003'
  ) -> 'destinationUrl',
  'null'::jsonb,
  'a deactivated claimed code exposes no redemption destination'
);
select throws_ok(
  $$
    select public.claim_reward_offer(
      'gym_training_discount',
      '30000000-0000-4000-8000-000000000003'
    )
  $$,
  '55000',
  'This claimed reward code is no longer available.',
  'a deactivated claimed code can never be revealed again'
);
reset role;

update private.reward_offer_codes
set is_active = true,
    expires_at = pg_catalog.clock_timestamp() - interval '1 minute'
where secret_code = 'PRIVATE-CAROL';

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  public.get_reward_fulfillment(
    'gym_training_discount',
    '30000000-0000-4000-8000-000000000003'
  ) #>> '{availability}',
  'expired',
  'an expired claimed code is reported without becoming revealable'
);
select throws_ok(
  $$
    select public.claim_reward_offer(
      'gym_training_discount',
      '30000000-0000-4000-8000-000000000003'
    )
  $$,
  '55000',
  'This claimed reward code is no longer available.',
  'an expired claimed code can never be revealed again'
);
reset role;

select is(
  has_function_privilege(
    'authenticated',
    'public.get_reward_catalog(integer,integer,text,uuid)',
    'EXECUTE'
  ),
  true,
  'authenticated clients can call only the actor-bound catalog wrapper'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.reward_catalog_for_user(uuid,integer,integer,text)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot choose a user through the internal catalog'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.redeem_reward_download_ticket(text,uuid)',
    'EXECUTE'
  ),
  false,
  'browser clients cannot redeem delivery tickets into storage coordinates'
);
select is(
  has_function_privilege(
    'service_role',
    'public.redeem_reward_download_ticket(text,uuid)',
    'EXECUTE'
  ),
  true,
  'the trusted download service can redeem one-time delivery tickets'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.backfill_reward_entitlements(text,uuid,integer,boolean)',
    'EXECUTE'
  ),
  false,
  'browser clients cannot execute reward backfills'
);

select * from finish();
rollback;
