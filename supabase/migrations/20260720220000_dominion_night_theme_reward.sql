begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.reward_audit_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  event_type text not null
    check (event_type in ('reward_definition_configured', 'reward_entitlement_granted')),
  reward_key text not null,
  user_id uuid references auth.users(id) on delete set null,
  source_type text,
  source_id text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now()
);

create index if not exists reward_audit_events_reward_time_idx
  on private.reward_audit_events (reward_key, occurred_at desc, id desc);

create index if not exists reward_audit_events_user_time_idx
  on private.reward_audit_events (user_id, occurred_at desc, id desc)
  where user_id is not null;

alter table private.reward_audit_events enable row level security;
revoke all on private.reward_audit_events from public, anon, authenticated;
grant select on private.reward_audit_events to service_role;

create or replace function public.enforce_reward_point_floor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_active and new.points_required < 500 then
    raise exception 'Active point rewards must require at least 500 points.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_reward_point_floor
  on public.reward_definitions;
create trigger enforce_reward_point_floor
  before insert or update of points_required, is_active
  on public.reward_definitions
  for each row execute function public.enforce_reward_point_floor();

create or replace function private.audit_reward_definition_change()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  audit_metadata jsonb;
  audit_event_key text;
begin
  audit_metadata := jsonb_build_object(
    'rewardType', new.reward_type,
    'stateModel', new.state_model,
    'title', new.title,
    'description', new.description,
    'pointsRequired', new.points_required,
    'fulfillmentKey', new.fulfillment_key,
    'requiredEntitlementKey', new.required_entitlement_key,
    'icon', new.icon,
    'sortOrder', new.sort_order,
    'active', new.is_active,
    'displayMetadata', new.display_metadata
  );
  audit_event_key := 'definition:' || new.reward_key || ':' || md5(audit_metadata::text);

  insert into private.reward_audit_events (
    event_key,
    event_type,
    reward_key,
    metadata
  ) values (
    audit_event_key,
    'reward_definition_configured',
    new.reward_key,
    audit_metadata
  )
  on conflict (event_key) do nothing;

  return new;
end;
$$;

drop trigger if exists audit_reward_definition_change
  on public.reward_definitions;
create trigger audit_reward_definition_change
  after insert or update of reward_type, state_model, title, description,
    points_required, fulfillment_key, required_entitlement_key, icon,
    sort_order, is_active, display_metadata
  on public.reward_definitions
  for each row execute function private.audit_reward_definition_change();

create or replace function private.audit_reward_entitlement_grant()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
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
    'grant:' || new.user_id::text || ':' || new.reward_key,
    'reward_entitlement_granted',
    new.reward_key,
    new.user_id,
    new.source_type,
    new.source_id,
    jsonb_build_object(
      'ownedAt', new.owned_at,
      'celebrationPending', new.celebration_seen_at is null
    ),
    new.owned_at
  )
  on conflict (event_key) do nothing;

  return new;
end;
$$;

drop trigger if exists audit_reward_entitlement_grant
  on public.user_reward_entitlements;
create trigger audit_reward_entitlement_grant
  after insert on public.user_reward_entitlements
  for each row execute function private.audit_reward_entitlement_grant();

create or replace function public.backfill_reward_entitlements(
  target_reward_key text,
  target_after_user_id uuid default null,
  target_batch_size integer default 500,
  target_celebration_seen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
    from public.reward_definitions definition
    where definition.reward_key = target_reward_key
      and definition.state_model = 'ownership'
      and definition.is_active
  ) then
    raise exception 'An active ownership reward is required for backfill.'
      using errcode = '22023';
  end if;

  normalized_batch_size := least(greatest(coalesce(target_batch_size, 500), 1), 5000);

  with eligible as materialized (
    select stats.user_id
    from public.user_game_stats stats
    join public.reward_definitions definition
      on definition.reward_key = target_reward_key
     and definition.state_model = 'ownership'
     and definition.is_active
     and definition.points_required <= greatest(stats.total_points, 0)
    where target_after_user_id is null
      or stats.user_id > target_after_user_id
    order by stats.user_id
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
      now(),
      'backfill',
      target_reward_key,
      case when target_celebration_seen then now() else null end
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
      from public.user_game_stats stats
      join public.reward_definitions definition
        on definition.reward_key = target_reward_key
       and definition.state_model = 'ownership'
       and definition.is_active
       and definition.points_required <= greatest(stats.total_points, 0)
      where stats.user_id > last_user_id
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
) values (
  'dominion_night_theme',
  'cosmetic',
  'ownership',
  'Dominion Night',
  'Unlock a distinct dark app theme, then select it from Profile.',
  500,
  'dominion-night',
  null,
  null,
  'palette',
  5,
  true,
  jsonb_build_object(
    'themeKey', 'dominion-night',
    'preview', 'dominion-night',
    'colorScheme', 'dark',
    'selectionRoute', 'profile.html#appearance',
    'selectionLabel', 'Select in Profile'
  ),
  now(),
  now()
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
  updated_at = now();

do $$
begin
  if not exists (
    select 1
    from public.reward_definitions definition
    where definition.reward_key = 'dominion_night_theme'
      and definition.reward_type = 'cosmetic'
      and definition.state_model = 'ownership'
      and definition.points_required = 500
      and definition.fulfillment_key = 'dominion-night'
      and definition.challenge_key is null
      and definition.required_entitlement_key is null
      and definition.is_active
  ) then
    raise exception 'The Dominion Night reward identity or rollout configuration is invalid.'
      using errcode = '23514';
  end if;
end;
$$;

-- The definition trigger performs the rollout grant atomically. This bounded,
-- cursor-based pass is retained for resumable repair jobs and is safe to rerun.
do $$
begin
  perform public.backfill_reward_entitlements(
    'dominion_night_theme',
    null,
    5000,
    false
  );
end;
$$;

revoke all on function private.audit_reward_definition_change()
  from public, anon, authenticated;
revoke all on function private.audit_reward_entitlement_grant()
  from public, anon, authenticated;
revoke all on function public.enforce_reward_point_floor()
  from public, anon, authenticated;
revoke execute on function public.backfill_reward_entitlements(text, uuid, integer, boolean)
  from public, anon, authenticated;

grant execute on function public.backfill_reward_entitlements(text, uuid, integer, boolean)
  to service_role;

commit;
