-- Publish the single launch reward curve and its fail-closed fulfillment
-- contracts. This is intentionally one prelaunch migration: no superseded
-- intermediate reward curve is ever observable by an application client.

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- The gym reward is the one exception to lifetime-point eligibility. Its
-- progress comes only from trusted Check-In ledger events and is capped at the
-- seven Daily Standards represented by each event. All other ownership rewards
-- continue to use the authoritative cached lifetime total maintained from the
-- immutable point ledger.
create index if not exists game_point_events_user_check_in_idx
  on public.game_point_events (user_id, created_at, id)
  where event_type = 'check_in';

create or replace function private.reward_eligible_points(
  target_user_id uuid,
  target_reward_key text
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  eligible_points bigint := 0;
begin
  if target_user_id is null or target_reward_key is null then
    return 0;
  end if;

  if target_reward_key = 'gym_training_discount' then
    select coalesce(sum(
      least(
        greatest(
          case
            when coalesce(point_event.metadata ->> 'completedCount', '') ~ '^[0-9]{1,3}$'
              then (point_event.metadata ->> 'completedCount')::integer
            when coalesce(point_event.metadata ->> 'actionPoints', '') ~ '^[0-9]{1,3}$'
              then (point_event.metadata ->> 'actionPoints')::integer
            else point_event.points
          end,
          0
        ),
        7
      )
    ), 0)
      into eligible_points
    from public.game_point_events as point_event
    where point_event.user_id = target_user_id
      and point_event.event_type = 'check_in';
  else
    select greatest(coalesce(game_stats.total_points, 0), 0)
      into eligible_points
    from public.user_game_stats as game_stats
    where game_stats.user_id = target_user_id;
  end if;

  return least(greatest(coalesce(eligible_points, 0), 0), 2147483647)::integer;
end;
$$;

revoke all on function private.reward_eligible_points(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.enforce_reward_point_floor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_active and new.points_required < 21 then
    raise exception 'Active point rewards must require at least 21 eligible points.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.grant_reward_entitlement(
  target_user_id uuid,
  target_reward_key text,
  target_source_type text default 'point_threshold',
  target_source_id text default null,
  target_celebration_seen boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_user_id uuid;
begin
  if target_user_id is null
    or target_reward_key is null
    or target_source_type is null
    or target_source_type !~ '^[a-z][a-z0-9_]*$' then
    return false;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id,
    celebration_seen_at
  )
  select
    target_user_id,
    definition.reward_key,
    pg_catalog.clock_timestamp(),
    target_source_type,
    coalesce(target_source_id, definition.reward_key),
    case
      when target_celebration_seen then pg_catalog.clock_timestamp()
      else null
    end
  from public.reward_definitions as definition
  where definition.reward_key = target_reward_key
    and definition.state_model = 'ownership'
    and definition.is_active
    and private.reward_eligible_points(
      target_user_id,
      definition.reward_key
    ) >= definition.points_required
  on conflict (user_id, reward_key) do nothing
  returning user_id into inserted_user_id;

  return inserted_user_id is not null;
end;
$$;

create or replace function public.reconcile_user_reward_entitlements(
  target_user_id uuid,
  target_celebration_seen boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
begin
  if target_user_id is null then
    return 0;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id,
    celebration_seen_at
  )
  select
    target_user_id,
    definition.reward_key,
    pg_catalog.clock_timestamp(),
    'point_threshold',
    definition.reward_key,
    case
      when target_celebration_seen then pg_catalog.clock_timestamp()
      else null
    end
  from public.reward_definitions as definition
  where definition.state_model = 'ownership'
    and definition.is_active
    and private.reward_eligible_points(
      target_user_id,
      definition.reward_key
    ) >= definition.points_required
  on conflict (user_id, reward_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.sync_reward_definition_entitlements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.is_active or new.state_model <> 'ownership' then
    return new;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id
  )
  select
    game_stats.user_id,
    new.reward_key,
    pg_catalog.clock_timestamp(),
    'catalog_threshold',
    new.reward_key
  from public.user_game_stats as game_stats
  where private.reward_eligible_points(
      game_stats.user_id,
      new.reward_key
    ) >= new.points_required
  on conflict (user_id, reward_key) do nothing;

  return new;
end;
$$;

create or replace function public.backfill_reward_entitlements(
  target_reward_key text,
  target_after_user_id uuid default null,
  target_batch_size integer default 500,
  target_celebration_seen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_batch_size integer;
  processed_count integer := 0;
  inserted_count integer := 0;
  last_user_id uuid := null;
  has_more boolean := false;
begin
  if target_reward_key is null
    or target_reward_key !~ '^[a-z0-9][a-z0-9_.:-]*$' then
    raise exception 'A valid reward key is required for backfill.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.reward_definitions as definition
    where definition.reward_key = target_reward_key
      and definition.state_model = 'ownership'
      and definition.is_active
  ) then
    raise exception 'An active ownership reward is required for backfill.'
      using errcode = '22023';
  end if;

  normalized_batch_size := least(
    greatest(coalesce(target_batch_size, 500), 1),
    5000
  );

  with eligible as materialized (
    select game_stats.user_id
    from public.user_game_stats as game_stats
    join public.reward_definitions as definition
      on definition.reward_key = target_reward_key
     and definition.state_model = 'ownership'
     and definition.is_active
    where (
        target_after_user_id is null
        or game_stats.user_id > target_after_user_id
      )
      and private.reward_eligible_points(
        game_stats.user_id,
        definition.reward_key
      ) >= definition.points_required
    order by game_stats.user_id
    limit normalized_batch_size
  ), inserted as (
    insert into public.user_reward_entitlements (
      user_id,
      reward_key,
      owned_at,
      source_type,
      source_id,
      celebration_seen_at
    )
    select
      eligible.user_id,
      target_reward_key,
      pg_catalog.clock_timestamp(),
      'backfill',
      target_reward_key,
      case
        when target_celebration_seen then pg_catalog.clock_timestamp()
        else null
      end
    from eligible
    on conflict (user_id, reward_key) do nothing
    returning user_id
  )
  select
    (select count(*)::integer from eligible),
    (select count(*)::integer from inserted),
    (select eligible.user_id from eligible order by eligible.user_id desc limit 1)
  into processed_count, inserted_count, last_user_id;

  if last_user_id is not null then
    select exists (
      select 1
      from public.user_game_stats as game_stats
      join public.reward_definitions as definition
        on definition.reward_key = target_reward_key
       and definition.state_model = 'ownership'
       and definition.is_active
      where game_stats.user_id > last_user_id
        and private.reward_eligible_points(
          game_stats.user_id,
          definition.reward_key
        ) >= definition.points_required
    ) into has_more;
  end if;

  return jsonb_build_object(
    'rewardKey', target_reward_key,
    'processedCount', processed_count,
    'insertedCount', inserted_count,
    'nextCursor', case when has_more then last_user_id else null end,
    'complete', not has_more
  );
end;
$$;

-- Avoid migration-time celebration storms while the final catalog is replaced.
-- The trigger is restored before commit; future threshold crossings continue to
-- create the normal one-time celebration.
alter table public.reward_definitions
  disable trigger sync_reward_definition_entitlements;

with challenge_curve(challenge_key, points_required, sort_order) as (
  values
    ('seven_day_reset', 140, 40),
    ('twenty_one_day_prayer', 336, 70),
    ('thirty_day_strength', 406, 80),
    ('forty_day_fast', 469, 90),
    ('bible_in_a_year', 532, 100)
)
update public.challenge_definitions as definition
set points_required = challenge_curve.points_required,
    sort_order = challenge_curve.sort_order,
    updated_at = pg_catalog.clock_timestamp()
from challenge_curve
where definition.challenge_key = challenge_curve.challenge_key
  and (
    definition.points_required is distinct from challenge_curve.points_required
    or definition.sort_order is distinct from challenge_curve.sort_order
  );

insert into public.reward_definitions (
  reward_key,
  reward_type,
  state_model,
  title,
  description,
  points_required,
  fulfillment_key,
  challenge_key,
  required_entitlement_key,
  icon,
  sort_order,
  is_active,
  display_metadata,
  created_at,
  updated_at
)
values
  (
    'gym_training_discount',
    'partner_discount',
    'ownership',
    'Gym Training Discount',
    'Earn a configurable partner offer to support training in a properly equipped gym.',
    21,
    'gym-training-discount',
    null,
    null,
    'dumbbell',
    10,
    true,
    jsonb_build_object(
      'eligibilitySource', 'daily_standard',
      'fulfillmentAvailability', 'unavailable',
      'encouragement', 'Complete challenge workouts at a properly equipped gym whenever practical so you can train safely and consistently.'
    ),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    'dominion_night_theme',
    'cosmetic',
    'ownership',
    'Dominion Night',
    'Earn a dark app theme, then select it from Profile.',
    56,
    'dominion-night',
    null,
    null,
    'palette',
    20,
    true,
    jsonb_build_object(
      'themeKey', 'dominion-night',
      'preview', 'dominion-night',
      'colorScheme', 'dark',
      'selectionRoute', 'profile.html#appearance',
      'selectionLabel', 'Select in Profile'
    ),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    'nehemiah_leadership_handbook',
    'digital_download',
    'ownership',
    'Nehemiah Leadership Handbook',
    'A faith-centered leadership resource for the rest of your challenge.',
    98,
    'nehemiah-leadership-handbook',
    null,
    null,
    'book',
    30,
    true,
    jsonb_build_object(
      'format', 'PDF',
      'fulfillmentAvailability', 'unavailable'
    ),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    'dominion_platinum',
    'cosmetic',
    'ownership',
    'Dominion Platinum',
    'Unlock a rare obsidian, platinum-glass, and Dominion gold app theme.',
    210,
    'dominion-platinum',
    null,
    null,
    'crown',
    50,
    true,
    jsonb_build_object(
      'themeKey', 'dominion-platinum',
      'preview', 'dominion-platinum',
      'colorScheme', 'dark',
      'selectionRoute', 'profile.html#appearance',
      'selectionLabel', 'Select in Profile'
    ),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    'big_god_energy_tshirt_discount',
    'merch_discount',
    'ownership',
    'Big God Energy T-Shirt Discount',
    'Earn a configurable discount toward the Big God Energy T-shirt.',
    273,
    'big-god-energy-tshirt-discount',
    null,
    null,
    'gift',
    60,
    true,
    jsonb_build_object(
      'thumbnailUrl', './images/big-god-energy-tshirt.jpg',
      'thumbnailAlt', 'Black Big God Energy T-shirt with white lettering.',
      'fulfillmentAvailability', 'unavailable'
    ),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
on conflict (reward_key) do update set
  title = excluded.title,
  description = excluded.description,
  points_required = excluded.points_required,
  required_entitlement_key = excluded.required_entitlement_key,
  icon = excluded.icon,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  display_metadata = excluded.display_metadata,
  updated_at = excluded.updated_at;

-- Newly eligible ownership is granted from trusted server state before the
-- catalog becomes visible. These migration grants are already acknowledged so
-- a member receives no stacked catch-up celebrations. Existing pending
-- celebrations and every previously earned entitlement remain untouched.
insert into public.user_reward_entitlements (
  user_id,
  reward_key,
  owned_at,
  source_type,
  source_id,
  celebration_seen_at
)
select
  game_stats.user_id,
  definition.reward_key,
  pg_catalog.clock_timestamp(),
  'launch_curve_backfill',
  'fou-1446-1449',
  pg_catalog.clock_timestamp()
from public.user_game_stats as game_stats
join public.reward_definitions as definition
  on definition.state_model = 'ownership'
 and definition.is_active
where private.reward_eligible_points(
    game_stats.user_id,
    definition.reward_key
  ) >= definition.points_required
on conflict (user_id, reward_key) do nothing;

alter table public.reward_definitions
  enable trigger sync_reward_definition_entitlements;

do $$
declare
  configured_keys text[];
  configured_thresholds integer[];
begin
  select
    array_agg(definition.reward_key order by definition.points_required),
    array_agg(definition.points_required order by definition.points_required)
    into configured_keys, configured_thresholds
  from public.reward_definitions as definition
  where definition.is_active;

  if configured_keys is distinct from array[
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
    ]::text[]
    or configured_thresholds is distinct from array[
      21, 56, 98, 140, 210, 273, 336, 406, 469, 532
    ]::integer[] then
    raise exception 'The final launch reward catalog is incomplete or inconsistent.'
      using errcode = '23514';
  end if;
end;
$$;

-- Fail-closed fulfillment configuration. Browser roles cannot read these
-- tables; public RPCs expose only approved display fields and the current
-- actor's own claim.
create table private.reward_offer_configurations (
  id uuid primary key default gen_random_uuid(),
  reward_key text not null references public.reward_definitions(reward_key) on delete restrict,
  campaign_key text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  version integer not null check (version > 0),
  partner_name text not null default '',
  website_url text,
  destination_url text,
  offer_title text not null default '',
  description text not null default '',
  terms text not null default '',
  expiration_copy text not null default '',
  fulfillment_method text not null default 'unique_code'
    check (fulfillment_method in ('unique_code', 'shared_code', 'provider')),
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  availability_state text not null default 'production_pending'
    check (availability_state in ('production_pending', 'active', 'paused', 'expired')),
  is_active boolean not null default false,
  approved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (reward_key, campaign_key, version),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (
    website_url is null
    or website_url ~ '^https://[A-Za-z0-9][^[:space:]<>"\\]*$'
  ),
  check (
    destination_url is null
    or destination_url ~ '^https://[A-Za-z0-9][^[:space:]<>"\\]*$'
  ),
  check (
    not is_active
    or (
      availability_state = 'active'
      and approved_at is not null
      and btrim(partner_name) <> ''
      and website_url is not null
      and destination_url is not null
      and btrim(offer_title) <> ''
      and btrim(description) <> ''
      and btrim(terms) <> ''
    )
  )
);

create unique index reward_offer_one_active_configuration_idx
  on private.reward_offer_configurations (reward_key)
  where is_active;

create index reward_offer_configurations_reward_version_idx
  on private.reward_offer_configurations (reward_key, version desc, id);

create table private.reward_offer_codes (
  id uuid primary key default gen_random_uuid(),
  configuration_id uuid not null
    references private.reward_offer_configurations(id) on delete restrict,
  secret_code text not null check (
    btrim(secret_code) <> ''
    and length(secret_code) <= 256
    and secret_code !~ '[[:cntrl:]]'
  ),
  max_claims integer not null default 1 check (max_claims > 0),
  claim_count integer not null default 0 check (
    claim_count >= 0 and claim_count <= max_claims
  ),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  unique (configuration_id, secret_code)
);

create index reward_offer_codes_available_idx
  on private.reward_offer_codes (configuration_id, created_at, id)
  where is_active;

create table private.user_reward_offer_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null references public.reward_definitions(reward_key) on delete restrict,
  configuration_id uuid not null
    references private.reward_offer_configurations(id) on delete restrict,
  code_id uuid not null references private.reward_offer_codes(id) on delete restrict,
  claimed_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, configuration_id)
);

create index user_reward_offer_claims_user_reward_idx
  on private.user_reward_offer_claims (user_id, reward_key, claimed_at desc);

create table private.reward_download_assets (
  id uuid primary key default gen_random_uuid(),
  reward_key text not null references public.reward_definitions(reward_key) on delete restrict,
  edition_key text not null check (edition_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  version integer not null check (version > 0),
  public_title text not null check (btrim(public_title) <> ''),
  public_description text not null default '',
  download_filename text not null check (
    download_filename ~ '^[A-Za-z0-9][A-Za-z0-9._ -]*[.]pdf$'
  ),
  bucket_name text not null default 'reward-downloads'
    check (bucket_name = 'reward-downloads'),
  object_path text not null check (
    object_path ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*[.]pdf$'
    and object_path !~ '(^/|[.][.]|//)'
  ),
  content_type text not null default 'application/pdf'
    check (content_type = 'application/pdf'),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  is_approved boolean not null default false,
  approved_at timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (reward_key, edition_key, version),
  unique (bucket_name, object_path),
  check (not is_approved or approved_at is not null),
  check (not is_active or (is_approved and approved_at is not null))
);

create unique index reward_download_one_active_asset_idx
  on private.reward_download_assets (reward_key)
  where is_active;

create table private.reward_download_tickets (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null references public.reward_definitions(reward_key) on delete restrict,
  asset_id uuid not null references private.reward_download_assets(id) on delete restrict,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  completed_at timestamptz,
  success boolean,
  outcome text,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > created_at),
  check (redeemed_at is null or redeemed_at >= created_at),
  check ((completed_at is null) = (success is null)),
  check (completed_at is null or redeemed_at is not null),
  check (outcome is null or outcome ~ '^[a-z][a-z0-9_]*$')
);

create index reward_download_tickets_user_created_idx
  on private.reward_download_tickets (user_id, created_at desc);

alter table private.reward_offer_configurations enable row level security;
alter table private.reward_offer_codes enable row level security;
alter table private.user_reward_offer_claims enable row level security;
alter table private.reward_download_assets enable row level security;
alter table private.reward_download_tickets enable row level security;

revoke all on private.reward_offer_configurations from public, anon, authenticated;
revoke all on private.reward_offer_codes from public, anon, authenticated;
revoke all on private.user_reward_offer_claims from public, anon, authenticated;
revoke all on private.reward_download_assets from public, anon, authenticated;
revoke all on private.reward_download_tickets from public, anon, authenticated;

grant select, insert, update, delete on private.reward_offer_configurations to service_role;
grant select, insert, update, delete on private.reward_offer_codes to service_role;
grant select, insert, update, delete on private.user_reward_offer_claims to service_role;
grant select, insert, update, delete on private.reward_download_assets to service_role;
grant select, insert, update, delete on private.reward_download_tickets to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'reward-downloads',
  'reward-downloads',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into private.reward_offer_configurations (
  reward_key,
  campaign_key,
  version,
  fulfillment_method,
  availability_state,
  is_active,
  metadata
)
values
  (
    'gym_training_discount',
    'production-pending',
    1,
    'unique_code',
    'production_pending',
    false,
    jsonb_build_object('launchGate', 'partner_approval_required')
  ),
  (
    'big_god_energy_tshirt_discount',
    'production-pending',
    1,
    'unique_code',
    'production_pending',
    false,
    jsonb_build_object('launchGate', 'commerce_approval_required')
  )
on conflict (reward_key, campaign_key, version) do nothing;

alter table private.reward_audit_events
  drop constraint if exists reward_audit_events_event_type_check;
alter table private.reward_audit_events
  add constraint reward_audit_events_event_type_check check (
    event_type in (
      'reward_definition_configured',
      'reward_entitlement_granted',
      'reward_offer_claimed',
      'reward_download_requested',
      'reward_download_succeeded',
      'reward_download_failed'
    )
  );

create or replace function public.reward_catalog_item_for_user(
  target_user_id uuid,
  target_reward_key text,
  target_current_points integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with item as (
    select
      definition.*,
      case
        when definition.state_model = 'ownership'
          then private.reward_eligible_points(target_user_id, definition.reward_key)
        else greatest(coalesce(target_current_points, 0), 0)
      end as eligible_points,
      challenge_state.status as challenge_status,
      challenge_state.unlock_points,
      challenge_state.unlocked_at,
      challenge_state.started_at,
      challenge_state.completed_at,
      challenge_state.celebration_seen_at as challenge_celebration_seen_at,
      reward_entitlement.owned_at,
      reward_entitlement.celebration_seen_at as ownership_celebration_seen_at,
      (
        definition.required_entitlement_key is null
        or exists (
          select 1
          from public.entitlements as access_entitlement
          where access_entitlement.user_id = target_user_id
            and access_entitlement.entitlement_key = definition.required_entitlement_key
            and access_entitlement.status = 'active'
            and (
              access_entitlement.starts_at is null
              or access_entitlement.starts_at <= pg_catalog.now()
            )
            and (
              access_entitlement.ends_at is null
              or access_entitlement.ends_at > pg_catalog.now()
            )
        )
      ) as can_access,
      case
        when definition.state_model = 'challenge_lifecycle'
          then coalesce(challenge_state.status, 'locked')
        when reward_entitlement.reward_key is not null then 'owned'
        else 'locked'
      end as current_status
    from public.reward_definitions as definition
    left join public.user_challenge_states as challenge_state
      on challenge_state.user_id = target_user_id
     and challenge_state.challenge_key = definition.challenge_key
    left join public.user_reward_entitlements as reward_entitlement
      on reward_entitlement.user_id = target_user_id
     and reward_entitlement.reward_key = definition.reward_key
    where definition.reward_key = target_reward_key
  )
  select jsonb_build_object(
    'key', item.reward_key,
    'rewardType', item.reward_type,
    'stateModel', item.state_model,
    'status', item.current_status,
    'title', item.title,
    'description', item.description,
    'pointsRequired', item.points_required,
    'currentPoints', item.eligible_points,
    'pointsRemaining', case
      when item.current_status <> 'locked' then 0
      else greatest(item.points_required - item.eligible_points, 0)
    end,
    'progressPercent', case
      when item.current_status <> 'locked' or item.points_required = 0 then 100
      else least(
        round(
          item.eligible_points::numeric / item.points_required::numeric * 100,
          2
        ),
        100
      )
    end,
    'fulfillmentKey', item.fulfillment_key,
    'requiredEntitlementKey', item.required_entitlement_key,
    'icon', item.icon,
    'sortOrder', item.sort_order,
    'active', item.is_active,
    'metadata', item.display_metadata,
    'canAccess', item.can_access,
    'accessReason', case
      when not item.can_access then 'entitlement_required'
      when item.current_status = 'locked' then 'points_required'
      else null
    end,
    'allowedActions', case
      when item.state_model = 'challenge_lifecycle'
        and item.current_status = 'available'
        and item.can_access
        then jsonb_build_array('start')
      else '[]'::jsonb
    end,
    'unlockPoints', item.unlock_points,
    'unlockedAt', item.unlocked_at,
    'startedAt', item.started_at,
    'completedAt', item.completed_at,
    'ownedAt', item.owned_at,
    'celebrationSeenAt', case
      when item.state_model = 'challenge_lifecycle'
        then item.challenge_celebration_seen_at
      else item.ownership_celebration_seen_at
    end
  )
  from item;
$$;

drop function if exists public.get_reward_catalog(integer, integer, text);
create function public.get_reward_catalog(
  target_page_size integer,
  target_after_sort_order integer,
  target_after_reward_key text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'You need to log in to view rewards.'
      using errcode = '42501';
  end if;

  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '42501';
  end if;

  perform public.ensure_user_game_stats(caller_id);
  perform public.reconcile_user_challenge_unlocks(caller_id);
  perform public.reconcile_user_reward_entitlements(caller_id);

  return public.reward_catalog_for_user(
    caller_id,
    target_page_size,
    target_after_sort_order,
    target_after_reward_key
  );
end;
$$;

drop function if exists public.claim_reward_entitlement_unlocks();
create function public.claim_reward_entitlement_unlocks(
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  claimed_keys jsonb := '[]'::jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to claim reward unlocks.'
      using errcode = '42501';
  end if;

  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '42501';
  end if;

  perform public.ensure_user_game_stats(caller_id);
  perform public.reconcile_user_reward_entitlements(caller_id);

  with pending as materialized (
    select reward_entitlement.user_id, reward_entitlement.reward_key
    from public.user_reward_entitlements as reward_entitlement
    join public.reward_definitions as definition
      on definition.reward_key = reward_entitlement.reward_key
     and definition.state_model = 'ownership'
    where reward_entitlement.user_id = caller_id
      and reward_entitlement.celebration_seen_at is null
    order by definition.points_required, definition.sort_order, definition.reward_key
    for update of reward_entitlement skip locked
  ), claimed as (
    update public.user_reward_entitlements as reward_entitlement
    set celebration_seen_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    from pending
    where reward_entitlement.user_id = pending.user_id
      and reward_entitlement.reward_key = pending.reward_key
      and reward_entitlement.celebration_seen_at is null
    returning reward_entitlement.reward_key
  )
  select coalesce(
      jsonb_agg(
        claimed.reward_key
        order by definition.points_required, definition.sort_order, claimed.reward_key
      ),
      '[]'::jsonb
    )
    into claimed_keys
  from claimed
  join public.reward_definitions as definition
    on definition.reward_key = claimed.reward_key;

  return jsonb_build_object(
    'claimedKeys', claimed_keys,
    'catalog', public.reward_catalog_for_user(caller_id, 100, null, null)
  );
end;
$$;

create or replace function private.active_reward_offer(
  target_reward_key text
)
returns private.reward_offer_configurations
language sql
stable
security definer
set search_path = ''
as $$
  select configuration
  from private.reward_offer_configurations as configuration
  where configuration.reward_key = target_reward_key
    and configuration.is_active
    and configuration.availability_state = 'active'
    and (configuration.starts_at is null or configuration.starts_at <= pg_catalog.now())
    and (configuration.ends_at is null or configuration.ends_at > pg_catalog.now())
  limit 1;
$$;

create or replace function public.get_reward_fulfillment(
  target_reward_key text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  definition public.reward_definitions%rowtype;
  catalog_item jsonb;
  configuration private.reward_offer_configurations%rowtype;
  claim_row private.user_reward_offer_claims%rowtype;
  claim_code private.reward_offer_codes%rowtype;
  download_asset private.reward_download_assets%rowtype;
  offer_availability text := 'unavailable';
begin
  if caller_id is null then
    raise exception 'You need to log in to view reward details.'
      using errcode = '42501';
  end if;

  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '42501';
  end if;

  select * into definition
  from public.reward_definitions
  where reward_key = target_reward_key
    and reward_type in ('partner_discount', 'merch_discount', 'digital_download');

  if definition.reward_key is null then
    raise exception 'The requested reward fulfillment is unavailable.'
      using errcode = '22023';
  end if;

  catalog_item := public.reward_catalog_item_for_user(
    caller_id,
    definition.reward_key,
    private.reward_eligible_points(caller_id, definition.reward_key)
  );

  if definition.reward_type = 'digital_download' then
    select * into download_asset
    from private.reward_download_assets as asset
    where asset.reward_key = definition.reward_key
      and asset.is_active
      and asset.is_approved
    limit 1;

    return jsonb_build_object(
      'rewardKey', definition.reward_key,
      'rewardType', definition.reward_type,
      'status', case
        when catalog_item ->> 'status' <> 'owned' then 'locked'
        when download_asset.id is null then 'unavailable'
        else 'unclaimed'
      end,
      'availability', case
        when download_asset.id is null then 'unavailable'
        else 'available'
      end,
      'downloadFilename', download_asset.download_filename,
      'edition', download_asset.edition_key,
      'format', 'PDF',
      'message', case
        when catalog_item ->> 'status' = 'owned' and download_asset.id is null
          then 'You permanently own this reward. The approved handbook edition is being finalized.'
        else ''
      end
    );
  end if;

  configuration := private.active_reward_offer(definition.reward_key);
  if configuration.id is not null then
    select * into claim_row
    from private.user_reward_offer_claims as offer_claim
    where offer_claim.user_id = caller_id
      and offer_claim.configuration_id = configuration.id;

    if claim_row.id is not null then
      select * into claim_code
      from private.reward_offer_codes as offer_code
      where offer_code.id = claim_row.code_id;

      if claim_code.id is null or not claim_code.is_active then
        offer_availability := 'unavailable';
      elsif claim_code.expires_at is not null
        and claim_code.expires_at <= pg_catalog.now() then
        offer_availability := 'expired';
      else
        offer_availability := 'available';
      end if;
    elsif configuration.usage_limit is not null and (
      select count(*)
      from private.user_reward_offer_claims as offer_claim
      where offer_claim.configuration_id = configuration.id
    ) >= configuration.usage_limit then
      offer_availability := 'exhausted';
    elsif exists (
      select 1
      from private.reward_offer_codes as offer_code
      where offer_code.configuration_id = configuration.id
        and offer_code.is_active
        and (offer_code.expires_at is null or offer_code.expires_at > pg_catalog.now())
        and offer_code.claim_count < offer_code.max_claims
    ) then
      offer_availability := 'available';
    else
      offer_availability := 'exhausted';
    end if;
  end if;

  return jsonb_build_object(
    'rewardKey', definition.reward_key,
    'rewardType', definition.reward_type,
    'status', case
      when catalog_item ->> 'status' <> 'owned' then 'locked'
      when configuration.id is null then 'unavailable'
      when claim_row.id is not null and offer_availability = 'available'
        then 'claimed'
      when offer_availability = 'available' then 'unclaimed'
      else 'unavailable'
    end,
    'availability', offer_availability,
    'partnerName', coalesce(configuration.partner_name, ''),
    'offerTitle', coalesce(configuration.offer_title, ''),
    'description', coalesce(configuration.description, ''),
    'terms', case
      when catalog_item ->> 'status' = 'owned' then coalesce(configuration.terms, '')
      else ''
    end,
    'expiration', coalesce(configuration.expiration_copy, ''),
    'websiteUrl', configuration.website_url,
    'destinationUrl', case
      when catalog_item ->> 'status' = 'owned'
        and claim_row.id is not null
        and offer_availability = 'available'
        then configuration.destination_url
      else null
    end,
    'claimedAt', claim_row.claimed_at,
    'message', case
      when catalog_item ->> 'status' = 'owned' and configuration.id is null
        then 'You permanently own this reward. Production fulfillment is being finalized.'
      when catalog_item ->> 'status' = 'owned'
        and claim_row.id is not null
        and offer_availability = 'expired'
        then 'Your claimed offer has expired.'
      when catalog_item ->> 'status' = 'owned'
        and claim_row.id is not null
        and offer_availability = 'unavailable'
        then 'Your claimed offer is temporarily unavailable.'
      when catalog_item ->> 'status' = 'owned' and offer_availability = 'exhausted'
        then 'This offer is temporarily unavailable.'
      else ''
    end
  );
end;
$$;

create or replace function public.claim_reward_offer(
  target_reward_key text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  definition public.reward_definitions%rowtype;
  configuration private.reward_offer_configurations%rowtype;
  claim_row private.user_reward_offer_claims%rowtype;
  code_row private.reward_offer_codes%rowtype;
begin
  if caller_id is null then
    raise exception 'You need to log in to claim a reward offer.'
      using errcode = '42501';
  end if;

  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '42501';
  end if;

  select * into definition
  from public.reward_definitions
  where reward_key = target_reward_key
    and reward_type in ('partner_discount', 'merch_discount')
    and is_active;

  if definition.reward_key is null then
    raise exception 'The requested reward offer is unavailable.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_reward_entitlements as reward_entitlement
    where reward_entitlement.user_id = caller_id
      and reward_entitlement.reward_key = definition.reward_key
  ) then
    raise exception 'This reward has not been unlocked.'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'reward-offer:' || caller_id::text || ':' || definition.reward_key,
      0
    )
  );

  select * into configuration
  from private.reward_offer_configurations as offer_configuration
  where offer_configuration.reward_key = definition.reward_key
    and offer_configuration.is_active
    and offer_configuration.availability_state = 'active'
    and (
      offer_configuration.starts_at is null
      or offer_configuration.starts_at <= pg_catalog.now()
    )
    and (
      offer_configuration.ends_at is null
      or offer_configuration.ends_at > pg_catalog.now()
    )
  for update;

  if configuration.id is null then
    raise exception 'This reward offer is temporarily unavailable.'
      using errcode = '55000';
  end if;

  select * into claim_row
  from private.user_reward_offer_claims as offer_claim
  where offer_claim.user_id = caller_id
    and offer_claim.configuration_id = configuration.id;

  if claim_row.id is not null then
    select * into code_row
    from private.reward_offer_codes as offer_code
    where offer_code.id = claim_row.code_id
      and offer_code.is_active
      and (
        offer_code.expires_at is null
        or offer_code.expires_at > pg_catalog.now()
      );

    if code_row.id is null then
      raise exception 'This claimed reward code is no longer available.'
        using errcode = '55000';
    end if;
  else
    if configuration.usage_limit is not null and (
      select count(*)
      from private.user_reward_offer_claims as offer_claim
      where offer_claim.configuration_id = configuration.id
    ) >= configuration.usage_limit then
      raise exception 'This reward offer has no codes available.'
        using errcode = '55000';
    end if;

    select * into code_row
    from private.reward_offer_codes as offer_code
    where offer_code.configuration_id = configuration.id
      and offer_code.is_active
      and (offer_code.expires_at is null or offer_code.expires_at > pg_catalog.now())
      and offer_code.claim_count < offer_code.max_claims
    order by offer_code.created_at, offer_code.id
    for update skip locked
    limit 1;

    if code_row.id is null then
      raise exception 'This reward offer has no codes available.'
        using errcode = '55000';
    end if;

    update private.reward_offer_codes
    set claim_count = claim_count + 1
    where id = code_row.id;

    insert into private.user_reward_offer_claims (
      user_id,
      reward_key,
      configuration_id,
      code_id
    ) values (
      caller_id,
      definition.reward_key,
      configuration.id,
      code_row.id
    )
    returning * into claim_row;

    insert into private.reward_audit_events (
      event_key,
      event_type,
      reward_key,
      user_id,
      source_type,
      source_id,
      metadata,
      occurred_at
    ) values (
      'offer-claim:' || claim_row.id::text,
      'reward_offer_claimed',
      definition.reward_key,
      caller_id,
      'offer_configuration',
      configuration.campaign_key || ':' || configuration.version::text,
      jsonb_build_object('claimId', claim_row.id),
      claim_row.claimed_at
    )
    on conflict (event_key) do nothing;
  end if;

  return jsonb_build_object(
    'rewardKey', definition.reward_key,
    'rewardType', definition.reward_type,
    'status', 'claimed',
    'availability', 'available',
    'partnerName', configuration.partner_name,
    'offerTitle', configuration.offer_title,
    'description', configuration.description,
    'terms', configuration.terms,
    'expiration', configuration.expiration_copy,
    'websiteUrl', configuration.website_url,
    'destinationUrl', configuration.destination_url,
    'code', code_row.secret_code,
    'claimedAt', claim_row.claimed_at
  );
end;
$$;

create or replace function public.request_reward_download(
  target_reward_key text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  asset private.reward_download_assets%rowtype;
  raw_token text;
begin
  if caller_id is null then
    raise exception 'You need to log in to download this reward.'
      using errcode = '42501';
  end if;

  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '42501';
  end if;

  if target_reward_key <> 'nehemiah_leadership_handbook' then
    raise exception 'The requested download is unavailable.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_reward_entitlements as reward_entitlement
    where reward_entitlement.user_id = caller_id
      and reward_entitlement.reward_key = target_reward_key
  ) then
    raise exception 'This reward has not been unlocked.'
      using errcode = '42501';
  end if;

  -- Serialize the rolling-window check and ticket insert for this actor. Without
  -- the transaction-scoped lock, concurrent requests can all observe the same
  -- pre-insert count and exceed the ten-per-hour ceiling.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'reward-download-rate:' || caller_id::text,
      0
    )
  );

  if (
    select count(*)
    from private.reward_download_tickets as prior_ticket
    where prior_ticket.user_id = caller_id
      and prior_ticket.created_at > pg_catalog.clock_timestamp() - interval '1 hour'
  ) >= 10 then
    raise exception 'Too many download requests. Try again shortly.'
      using errcode = '54000';
  end if;

  select * into asset
  from private.reward_download_assets as download_asset
  where download_asset.reward_key = target_reward_key
    and download_asset.is_active
    and download_asset.is_approved
  limit 1;

  if asset.id is null then
    return jsonb_build_object(
      'rewardKey', target_reward_key,
      'status', 'unavailable',
      'availability', 'unavailable',
      'message', 'You permanently own this reward. The approved handbook edition is being finalized.'
    );
  end if;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.reward_download_tickets (
    token_hash,
    user_id,
    reward_key,
    asset_id,
    expires_at
  ) values (
    extensions.digest(raw_token, 'sha256'),
    caller_id,
    target_reward_key,
    asset.id,
    pg_catalog.clock_timestamp() + interval '2 minutes'
  );

  insert into private.reward_audit_events (
    event_key,
    event_type,
    reward_key,
    user_id,
    source_type,
    source_id,
    metadata
  ) values (
    'download-request:' || encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    'reward_download_requested',
    target_reward_key,
    caller_id,
    'approved_asset',
    asset.edition_key || ':' || asset.version::text,
    jsonb_build_object('assetId', asset.id)
  )
  on conflict (event_key) do nothing;

  return jsonb_build_object(
    'rewardKey', target_reward_key,
    'status', 'unclaimed',
    'availability', 'available',
    'ticket', raw_token,
    'expiresInSeconds', 120
  );
end;
$$;

create or replace function public.redeem_reward_download_ticket(
  target_token text,
  target_user_id uuid
)
returns table (
  bucket_name text,
  object_path text,
  download_filename text,
  content_type text,
  sha256_hex text,
  size_bytes bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  ticket private.reward_download_tickets%rowtype;
begin
  if target_user_id is null or coalesce(target_token, '') !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select * into ticket
  from private.reward_download_tickets as download_ticket
  where download_ticket.token_hash = extensions.digest(target_token, 'sha256')
    and download_ticket.user_id = target_user_id
  for update;

  if ticket.token_hash is null
    or ticket.redeemed_at is not null
    or ticket.expires_at <= pg_catalog.clock_timestamp() then
    return;
  end if;

  update private.reward_download_tickets
  set redeemed_at = pg_catalog.clock_timestamp()
  where token_hash = ticket.token_hash;

  return query
  select
    asset.bucket_name,
    asset.object_path,
    asset.download_filename,
    asset.content_type,
    asset.sha256_hex,
    asset.size_bytes
  from private.reward_download_assets as asset
  where asset.id = ticket.asset_id
    and asset.reward_key = ticket.reward_key
    and asset.is_active
    and asset.is_approved;
end;
$$;

create or replace function public.record_reward_download_result(
  target_token text,
  target_user_id uuid,
  target_success boolean,
  target_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_ticket private.reward_download_tickets%rowtype;
begin
  if target_user_id is null
    or coalesce(target_token, '') !~ '^[0-9a-f]{64}$'
    or target_success is null
    or coalesce(target_outcome, '') !~ '^[a-z][a-z0-9_]*$' then
    return false;
  end if;

  update private.reward_download_tickets as download_ticket
  set completed_at = pg_catalog.clock_timestamp(),
      success = target_success,
      outcome = target_outcome
  where download_ticket.token_hash = extensions.digest(target_token, 'sha256')
    and download_ticket.user_id = target_user_id
    and download_ticket.redeemed_at is not null
    and download_ticket.completed_at is null
  returning * into updated_ticket;

  if updated_ticket.token_hash is null then
    return false;
  end if;

  insert into private.reward_audit_events (
    event_key,
    event_type,
    reward_key,
    user_id,
    source_type,
    source_id,
    metadata,
    occurred_at
  ) values (
    'download-result:' || encode(updated_ticket.token_hash, 'hex'),
    case
      when target_success then 'reward_download_succeeded'
      else 'reward_download_failed'
    end,
    updated_ticket.reward_key,
    target_user_id,
    'download_ticket',
    null,
    jsonb_build_object('outcome', target_outcome),
    updated_ticket.completed_at
  )
  on conflict (event_key) do nothing;

  return true;
end;
$$;

revoke all on function public.enforce_reward_point_floor()
  from public, anon, authenticated;
revoke all on function public.grant_reward_entitlement(uuid, text, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.reconcile_user_reward_entitlements(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.sync_reward_definition_entitlements()
  from public, anon, authenticated;
revoke all on function public.backfill_reward_entitlements(text, uuid, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.reward_catalog_item_for_user(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.get_reward_catalog(integer, integer, text, uuid)
  from public, anon;
revoke all on function public.claim_reward_entitlement_unlocks(uuid)
  from public, anon;
revoke all on function private.active_reward_offer(text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_reward_fulfillment(text, uuid)
  from public, anon;
revoke all on function public.claim_reward_offer(text, uuid)
  from public, anon;
revoke all on function public.request_reward_download(text, uuid)
  from public, anon;
revoke all on function public.redeem_reward_download_ticket(text, uuid)
  from public, anon, authenticated;
revoke all on function public.record_reward_download_result(text, uuid, boolean, text)
  from public, anon, authenticated;

grant execute on function public.grant_reward_entitlement(uuid, text, text, text, boolean)
  to service_role;
grant execute on function public.reconcile_user_reward_entitlements(uuid, boolean)
  to service_role;
grant execute on function public.backfill_reward_entitlements(text, uuid, integer, boolean)
  to service_role;
grant execute on function public.get_reward_catalog(integer, integer, text, uuid)
  to authenticated;
grant execute on function public.claim_reward_entitlement_unlocks(uuid)
  to authenticated;
grant execute on function public.get_reward_fulfillment(text, uuid)
  to authenticated;
grant execute on function public.claim_reward_offer(text, uuid)
  to authenticated;
grant execute on function public.request_reward_download(text, uuid)
  to authenticated;
grant execute on function public.redeem_reward_download_ticket(text, uuid)
  to service_role;
grant execute on function public.record_reward_download_result(text, uuid, boolean, text)
  to service_role;

comment on function private.reward_eligible_points(uuid, text) is
  'Trusted reward eligibility: Daily Standards ledger points for the gym reward and authoritative lifetime totals for every other reward.';
comment on table private.reward_offer_configurations is
  'Service-only versioned partner and merchandise offer configuration. Never expose code inventory through the catalog.';
comment on table private.reward_download_assets is
  'Service-only approved handbook metadata for exact private-object verification and streaming.';
