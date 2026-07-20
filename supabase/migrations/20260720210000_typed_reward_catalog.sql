begin;

create table if not exists public.reward_catalog_meta (
  catalog_key text primary key check (catalog_key = 'primary'),
  catalog_version bigint not null default 1 check (catalog_version > 0),
  updated_at timestamptz not null default now()
);

insert into public.reward_catalog_meta (catalog_key, catalog_version)
values ('primary', 1)
on conflict (catalog_key) do nothing;

create table if not exists public.reward_definitions (
  reward_key text primary key
    check (reward_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  reward_type text not null
    check (reward_type ~ '^[a-z][a-z0-9_]*$'),
  state_model text not null
    check (state_model in ('challenge_lifecycle', 'ownership')),
  title text not null check (btrim(title) <> ''),
  description text not null default '',
  points_required integer not null check (points_required >= 0),
  fulfillment_key text not null
    check (fulfillment_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  challenge_key text unique references public.challenge_definitions(challenge_key),
  required_entitlement_key text,
  icon text not null default 'gift'
    check (icon ~ '^[a-z][a-z0-9-]*$'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  display_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(display_metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      state_model = 'challenge_lifecycle'
      and reward_type = 'challenge'
      and challenge_key is not null
      and fulfillment_key = challenge_key
    )
    or (
      state_model = 'ownership'
      and reward_type <> 'challenge'
      and challenge_key is null
    )
  )
);

create table if not exists public.user_reward_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null references public.reward_definitions(reward_key) on delete restrict,
  owned_at timestamptz not null default now(),
  source_type text not null default 'point_threshold'
    check (source_type ~ '^[a-z][a-z0-9_]*$'),
  source_id text,
  celebration_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, reward_key)
);

create index if not exists reward_definitions_active_order_idx
  on public.reward_definitions (points_required, sort_order, reward_key)
  where is_active;

create index if not exists user_reward_entitlements_user_owned_idx
  on public.user_reward_entitlements (user_id, owned_at desc, reward_key);

create index if not exists user_reward_entitlements_pending_celebration_idx
  on public.user_reward_entitlements (user_id, owned_at, reward_key)
  where celebration_seen_at is null;

alter table public.reward_catalog_meta enable row level security;
alter table public.reward_definitions enable row level security;
alter table public.user_reward_entitlements enable row level security;

drop policy if exists "Authenticated users can read active reward definitions"
  on public.reward_definitions;
create policy "Authenticated users can read active reward definitions"
  on public.reward_definitions
  for select
  to authenticated
  using (is_active);

drop policy if exists "Users can read own reward entitlements"
  on public.user_reward_entitlements;
create policy "Users can read own reward entitlements"
  on public.user_reward_entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.bump_reward_catalog_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.reward_catalog_meta (
    catalog_key,
    catalog_version,
    updated_at
  ) values (
    'primary',
    1,
    now()
  )
  on conflict (catalog_key) do update set
    catalog_version = reward_catalog_meta.catalog_version + 1,
    updated_at = now();

  return null;
end;
$$;

drop trigger if exists bump_reward_catalog_version
  on public.reward_definitions;
create trigger bump_reward_catalog_version
  after insert or update or delete on public.reward_definitions
  for each statement execute function public.bump_reward_catalog_version();

create or replace function public.enforce_reward_entitlement_definition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.reward_definitions definition
    where definition.reward_key = new.reward_key
      and definition.state_model = 'ownership'
  ) then
    raise exception 'Only ownership rewards can create permanent entitlements.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_reward_entitlement_definition
  on public.user_reward_entitlements;
create trigger enforce_reward_entitlement_definition
  before insert or update of reward_key on public.user_reward_entitlements
  for each row execute function public.enforce_reward_entitlement_definition();

create or replace function public.protect_reward_definition_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.reward_key is distinct from old.reward_key
    or new.reward_type is distinct from old.reward_type
    or new.state_model is distinct from old.state_model
    or new.fulfillment_key is distinct from old.fulfillment_key
    or new.challenge_key is distinct from old.challenge_key then
    raise exception 'Reward identity fields are immutable.'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_reward_definition_identity
  on public.reward_definitions;
create trigger protect_reward_definition_identity
  before update of reward_key, reward_type, state_model, fulfillment_key, challenge_key
  on public.reward_definitions
  for each row execute function public.protect_reward_definition_identity();

create or replace function public.sync_challenge_reward_definition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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
    new.challenge_key,
    'challenge',
    'challenge_lifecycle',
    new.title,
    new.teaser,
    new.points_required,
    new.challenge_key,
    new.challenge_key,
    new.entitlement_key,
    new.icon,
    new.sort_order,
    new.is_active,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'challengeType', new.challenge_type,
      'durationDays', new.duration_days
    ),
    new.created_at,
    now()
  )
  on conflict (reward_key) do update set
    reward_type = 'challenge',
    state_model = 'challenge_lifecycle',
    title = excluded.title,
    description = excluded.description,
    points_required = excluded.points_required,
    fulfillment_key = excluded.fulfillment_key,
    challenge_key = excluded.challenge_key,
    required_entitlement_key = excluded.required_entitlement_key,
    icon = excluded.icon,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    display_metadata = excluded.display_metadata,
    updated_at = now();

  return new;
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
)
select
  definition.challenge_key,
  'challenge',
  'challenge_lifecycle',
  definition.title,
  definition.teaser,
  definition.points_required,
  definition.challenge_key,
  definition.challenge_key,
  definition.entitlement_key,
  definition.icon,
  definition.sort_order,
  definition.is_active,
  coalesce(definition.metadata, '{}'::jsonb) || jsonb_build_object(
    'challengeType', definition.challenge_type,
    'durationDays', definition.duration_days
  ),
  definition.created_at,
  definition.updated_at
from public.challenge_definitions definition
on conflict (reward_key) do update set
  reward_type = excluded.reward_type,
  state_model = excluded.state_model,
  title = excluded.title,
  description = excluded.description,
  points_required = excluded.points_required,
  fulfillment_key = excluded.fulfillment_key,
  challenge_key = excluded.challenge_key,
  required_entitlement_key = excluded.required_entitlement_key,
  icon = excluded.icon,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  display_metadata = excluded.display_metadata,
  updated_at = excluded.updated_at;

drop trigger if exists sync_challenge_reward_definition
  on public.challenge_definitions;
create trigger sync_challenge_reward_definition
  after insert or update of title, teaser, challenge_type, points_required,
    duration_days, entitlement_key, icon, sort_order, is_active, metadata
  on public.challenge_definitions
  for each row execute function public.sync_challenge_reward_definition();

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
set search_path = public, pg_temp
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
    stats.user_id,
    definition.reward_key,
    now(),
    target_source_type,
    coalesce(target_source_id, definition.reward_key),
    case when target_celebration_seen then now() else null end
  from public.user_game_stats stats
  join public.reward_definitions definition
    on definition.reward_key = target_reward_key
   and definition.state_model = 'ownership'
   and definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
  where stats.user_id = target_user_id
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
set search_path = public, pg_temp
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
    stats.user_id,
    definition.reward_key,
    now(),
    'point_threshold',
    definition.reward_key,
    case when target_celebration_seen then now() else null end
  from public.user_game_stats stats
  join public.reward_definitions definition
    on definition.state_model = 'ownership'
   and definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
  where stats.user_id = target_user_id
  on conflict (user_id, reward_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.sync_user_reward_entitlements_from_stats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
    and new.total_points is not distinct from old.total_points then
    return new;
  end if;

  perform public.reconcile_user_reward_entitlements(new.user_id);
  return new;
end;
$$;

drop trigger if exists sync_user_reward_entitlements_from_stats
  on public.user_game_stats;
create trigger sync_user_reward_entitlements_from_stats
  after insert or update of total_points on public.user_game_stats
  for each row execute function public.sync_user_reward_entitlements_from_stats();

create or replace function public.sync_reward_definition_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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
    stats.user_id,
    new.reward_key,
    now(),
    'catalog_threshold',
    new.reward_key
  from public.user_game_stats stats
  where greatest(stats.total_points, 0) >= new.points_required
  on conflict (user_id, reward_key) do nothing;

  return new;
end;
$$;

drop trigger if exists sync_reward_definition_entitlements
  on public.reward_definitions;
create trigger sync_reward_definition_entitlements
  after insert or update of points_required, is_active, state_model
  on public.reward_definitions
  for each row execute function public.sync_reward_definition_entitlements();

create or replace function public.reward_catalog_item_for_user(
  target_user_id uuid,
  target_reward_key text,
  target_current_points integer
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with item as (
    select
      definition.*,
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
          from public.entitlements access_entitlement
          where access_entitlement.user_id = target_user_id
            and access_entitlement.entitlement_key = definition.required_entitlement_key
            and access_entitlement.status = 'active'
            and (
              access_entitlement.starts_at is null
              or access_entitlement.starts_at <= now()
            )
            and (
              access_entitlement.ends_at is null
              or access_entitlement.ends_at > now()
            )
        )
      ) as can_access,
      case
        when definition.state_model = 'challenge_lifecycle'
          then coalesce(challenge_state.status, 'locked')
        when reward_entitlement.reward_key is not null then 'owned'
        else 'locked'
      end as current_status
    from public.reward_definitions definition
    left join public.user_challenge_states challenge_state
      on challenge_state.user_id = target_user_id
     and challenge_state.challenge_key = definition.challenge_key
    left join public.user_reward_entitlements reward_entitlement
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
    'currentPoints', greatest(coalesce(target_current_points, 0), 0),
    'pointsRemaining', case
      when item.current_status <> 'locked' then 0
      else greatest(item.points_required - greatest(coalesce(target_current_points, 0), 0), 0)
    end,
    'progressPercent', case
      when item.current_status <> 'locked' or item.points_required = 0 then 100
      else least(
        round(
          greatest(coalesce(target_current_points, 0), 0)::numeric
            / item.points_required::numeric * 100,
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

create or replace function public.reward_catalog_for_user(
  target_user_id uuid,
  target_page_size integer default 50,
  target_after_sort_order integer default null,
  target_after_reward_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  current_total_points integer := 0;
  normalized_page_size integer;
  catalog_version bigint := 1;
  total_items integer := 0;
  item_rows jsonb := '[]'::jsonb;
  next_unlock jsonb := null;
  next_cursor jsonb := null;
  has_more boolean := false;
  last_item jsonb;
begin
  if target_user_id is null then
    raise exception 'A user is required for the reward catalog.'
      using errcode = '22023';
  end if;

  normalized_page_size := least(greatest(coalesce(target_page_size, 50), 1), 100);
  if (target_after_sort_order is null) <> (target_after_reward_key is null)
    or (
      target_after_reward_key is not null
      and target_after_reward_key !~ '^[a-z0-9][a-z0-9_.:-]*$'
    ) then
    raise exception 'The reward catalog cursor is invalid.'
      using errcode = '22023';
  end if;

  select greatest(coalesce(stats.total_points, 0), 0)
    into current_total_points
  from public.user_game_stats stats
  where stats.user_id = target_user_id;
  current_total_points := coalesce(current_total_points, 0);

  select coalesce(meta.catalog_version, 1)
    into catalog_version
  from public.reward_catalog_meta meta
  where meta.catalog_key = 'primary';
  catalog_version := coalesce(catalog_version, 1);

  select count(*)::integer
    into total_items
  from public.reward_definitions definition
  left join public.user_reward_entitlements reward_entitlement
    on reward_entitlement.user_id = target_user_id
   and reward_entitlement.reward_key = definition.reward_key
  where definition.is_active
    or (
      definition.state_model = 'ownership'
      and reward_entitlement.reward_key is not null
    );

  with candidates as (
    select
      definition.sort_order,
      definition.reward_key,
      public.reward_catalog_item_for_user(
        target_user_id,
        definition.reward_key,
        current_total_points
      ) as reward
    from public.reward_definitions definition
    left join public.user_reward_entitlements reward_entitlement
      on reward_entitlement.user_id = target_user_id
     and reward_entitlement.reward_key = definition.reward_key
    where (
        definition.is_active
        or (
          definition.state_model = 'ownership'
          and reward_entitlement.reward_key is not null
        )
      )
      and (
        target_after_sort_order is null
        or (definition.sort_order, definition.reward_key)
          > (target_after_sort_order, target_after_reward_key)
      )
    order by definition.sort_order, definition.reward_key
    limit normalized_page_size + 1
  ), numbered as (
    select
      candidates.*,
      row_number() over (
        order by candidates.sort_order, candidates.reward_key
      ) as row_number
    from candidates
  )
  select
    coalesce(
      jsonb_agg(numbered.reward order by numbered.sort_order, numbered.reward_key)
        filter (where numbered.row_number <= normalized_page_size),
      '[]'::jsonb
    ),
    coalesce(bool_or(numbered.row_number > normalized_page_size), false)
  into item_rows, has_more
  from numbered;

  if has_more and jsonb_array_length(item_rows) > 0 then
    last_item := item_rows -> (jsonb_array_length(item_rows) - 1);
    next_cursor := jsonb_build_object(
      'sortOrder', (last_item ->> 'sortOrder')::integer,
      'key', last_item ->> 'key'
    );
  end if;

  select state.reward
    into next_unlock
  from public.reward_definitions definition
  cross join lateral (
    select public.reward_catalog_item_for_user(
      target_user_id,
      definition.reward_key,
      current_total_points
    ) as reward
  ) state
  where definition.is_active
    and state.reward ->> 'status' = 'locked'
    and coalesce((state.reward ->> 'canAccess')::boolean, false)
  order by definition.points_required, definition.sort_order, definition.reward_key
  limit 1;

  return jsonb_build_object(
    'schemaVersion', 1,
    'catalogVersion', catalog_version,
    'totalPoints', current_total_points,
    'items', item_rows,
    'nextUnlock', next_unlock,
    'page', jsonb_build_object(
      'limit', normalized_page_size,
      'totalItems', total_items,
      'hasMore', has_more,
      'nextCursor', next_cursor
    )
  );
end;
$$;

create or replace function public.get_reward_catalog(
  target_page_size integer default 50,
  target_after_sort_order integer default null,
  target_after_reward_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You need to log in to view rewards.'
      using errcode = '42501';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);
  perform public.reconcile_user_reward_entitlements(current_user_id);

  return public.reward_catalog_for_user(
    current_user_id,
    target_page_size,
    target_after_sort_order,
    target_after_reward_key
  );
end;
$$;

create or replace function public.claim_reward_entitlement_unlocks()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  claimed_keys jsonb := '[]'::jsonb;
begin
  if current_user_id is null then
    raise exception 'You need to log in to claim reward unlocks.'
      using errcode = '42501';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_reward_entitlements(current_user_id);

  with pending as materialized (
    select reward_entitlement.user_id, reward_entitlement.reward_key
    from public.user_reward_entitlements reward_entitlement
    join public.reward_definitions definition
      on definition.reward_key = reward_entitlement.reward_key
     and definition.state_model = 'ownership'
    where reward_entitlement.user_id = current_user_id
      and reward_entitlement.celebration_seen_at is null
    order by definition.points_required, definition.sort_order, definition.reward_key
    for update of reward_entitlement skip locked
  ), claimed as (
    update public.user_reward_entitlements reward_entitlement
    set celebration_seen_at = now(),
        updated_at = now()
    from pending
    where reward_entitlement.user_id = pending.user_id
      and reward_entitlement.reward_key = pending.reward_key
      and reward_entitlement.celebration_seen_at is null
    returning reward_entitlement.reward_key
  )
  select coalesce(
      jsonb_agg(claimed.reward_key order by definition.points_required, definition.sort_order, claimed.reward_key),
      '[]'::jsonb
    )
    into claimed_keys
  from claimed
  join public.reward_definitions definition
    on definition.reward_key = claimed.reward_key;

  return jsonb_build_object(
    'claimedKeys', claimed_keys,
    'catalog', public.reward_catalog_for_user(current_user_id, 100, null, null)
  );
end;
$$;

revoke all on public.reward_catalog_meta from public, anon, authenticated;
revoke all on public.reward_definitions from public, anon, authenticated;
revoke all on public.user_reward_entitlements from public, anon, authenticated;

grant select, insert, update, delete on public.reward_catalog_meta to service_role;
grant select, insert, update, delete on public.reward_definitions to service_role;
grant select, insert, update, delete on public.user_reward_entitlements to service_role;
grant select on public.user_reward_entitlements to authenticated;

revoke execute on function public.bump_reward_catalog_version() from public, anon, authenticated;
revoke execute on function public.enforce_reward_entitlement_definition() from public, anon, authenticated;
revoke execute on function public.protect_reward_definition_identity() from public, anon, authenticated;
revoke execute on function public.sync_challenge_reward_definition() from public, anon, authenticated;
revoke execute on function public.grant_reward_entitlement(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.reconcile_user_reward_entitlements(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.sync_user_reward_entitlements_from_stats() from public, anon, authenticated;
revoke execute on function public.sync_reward_definition_entitlements() from public, anon, authenticated;
revoke execute on function public.reward_catalog_item_for_user(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.reward_catalog_for_user(uuid, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.get_reward_catalog(integer, integer, text) from public, anon;
revoke execute on function public.claim_reward_entitlement_unlocks() from public, anon;

grant execute on function public.grant_reward_entitlement(uuid, text, text, text, boolean) to service_role;
grant execute on function public.reconcile_user_reward_entitlements(uuid, boolean) to service_role;
grant execute on function public.get_reward_catalog(integer, integer, text) to authenticated;
grant execute on function public.claim_reward_entitlement_unlocks() to authenticated;

commit;
