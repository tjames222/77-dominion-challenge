begin;

create table if not exists public.challenge_definitions (
  challenge_key text primary key check (challenge_key ~ '^[a-z0-9][a-z0-9_]*$'),
  title text not null check (btrim(title) <> ''),
  teaser text not null default '',
  challenge_type text not null default 'general' check (btrim(challenge_type) <> ''),
  points_required integer not null check (points_required >= 0),
  duration_days integer check (duration_days is null or duration_days > 0),
  entitlement_key text default 'membership_active',
  icon text not null default 'target',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_challenge_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_key text not null references public.challenge_definitions(challenge_key),
  status text not null default 'available' check (status in ('available', 'active', 'completed')),
  unlock_points integer not null check (unlock_points >= 0),
  unlocked_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  celebration_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, challenge_key),
  check (
    (status = 'available' and started_at is null and completed_at is null)
    or (status = 'active' and started_at is not null and completed_at is null)
    or (status = 'completed' and started_at is not null and completed_at is not null)
  )
);

create index if not exists challenge_definitions_active_points_idx
  on public.challenge_definitions (points_required, sort_order, challenge_key)
  where is_active;

create index if not exists user_challenge_states_user_status_idx
  on public.user_challenge_states (user_id, status, unlocked_at desc);

create index if not exists user_challenge_states_pending_celebration_idx
  on public.user_challenge_states (user_id, unlocked_at, challenge_key)
  where celebration_seen_at is null;

drop trigger if exists set_challenge_definitions_updated_at on public.challenge_definitions;
create trigger set_challenge_definitions_updated_at
  before update on public.challenge_definitions
  for each row execute function public.set_updated_at();

drop trigger if exists set_user_challenge_states_updated_at on public.user_challenge_states;
create trigger set_user_challenge_states_updated_at
  before update on public.user_challenge_states
  for each row execute function public.set_updated_at();

create or replace function public.reconcile_user_challenge_unlocks(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  if target_user_id is null then
    return 0;
  end if;

  insert into public.user_challenge_states (
    user_id,
    challenge_key,
    status,
    unlock_points,
    unlocked_at
  )
  select
    stats.user_id,
    definition.challenge_key,
    'available',
    definition.points_required,
    now()
  from public.user_game_stats stats
  join public.challenge_definitions definition
    on definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
   and (
     definition.entitlement_key is null
     or exists (
       select 1
       from public.entitlements entitlement
       where entitlement.user_id = stats.user_id
         and entitlement.entitlement_key = definition.entitlement_key
         and entitlement.status = 'active'
         and (entitlement.starts_at is null or entitlement.starts_at <= now())
         and (entitlement.ends_at is null or entitlement.ends_at > now())
     )
   )
  where stats.user_id = target_user_id
  on conflict (user_id, challenge_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.sync_user_challenge_unlocks_from_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.total_points is not distinct from old.total_points then
      return new;
    end if;
  end if;

  perform public.reconcile_user_challenge_unlocks(new.user_id);
  return new;
end;
$$;

drop trigger if exists sync_user_challenge_unlocks_from_stats on public.user_game_stats;
create trigger sync_user_challenge_unlocks_from_stats
  after insert or update of total_points on public.user_game_stats
  for each row execute function public.sync_user_challenge_unlocks_from_stats();

create or replace function public.sync_challenge_definition_unlocks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.is_active then
    return new;
  end if;

  insert into public.user_challenge_states (
    user_id,
    challenge_key,
    status,
    unlock_points,
    unlocked_at
  )
  select
    stats.user_id,
    new.challenge_key,
    'available',
    new.points_required,
    now()
  from public.user_game_stats stats
  where greatest(stats.total_points, 0) >= new.points_required
    and (
      new.entitlement_key is null
      or exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = stats.user_id
          and entitlement.entitlement_key = new.entitlement_key
          and entitlement.status = 'active'
          and (entitlement.starts_at is null or entitlement.starts_at <= now())
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    )
  on conflict (user_id, challenge_key) do nothing;

  return new;
end;
$$;

drop trigger if exists sync_challenge_definition_unlocks on public.challenge_definitions;
create trigger sync_challenge_definition_unlocks
  after insert or update of points_required, is_active, entitlement_key on public.challenge_definitions
  for each row execute function public.sync_challenge_definition_unlocks();

insert into public.challenge_definitions (
  challenge_key,
  title,
  teaser,
  challenge_type,
  points_required,
  duration_days,
  entitlement_key,
  icon,
  sort_order
)
values
  (
    'seven_day_reset',
    '7-Day Reset',
    'A focused week to rebuild rhythm and recover momentum.',
    'reset',
    500,
    7,
    'membership_active',
    'repeat',
    10
  ),
  (
    'twenty_one_day_prayer',
    '21-Day Prayer Track',
    'Deepen the daily prayer habit with a guided three-week track.',
    'spiritual',
    1500,
    21,
    'membership_active',
    'spark',
    20
  ),
  (
    'thirty_day_strength',
    '30-Day Strength Intensive',
    'Turn consistency into a focused month of physical training.',
    'physical',
    2250,
    30,
    'membership_active',
    'dumbbell',
    30
  ),
  (
    'forty_day_fast',
    '40-Day Fasting & Prayer Track',
    'Build a guided rhythm of fasting, prayer, and disciplined reflection.',
    'fasting',
    3000,
    40,
    'membership_active',
    'flame',
    40
  ),
  (
    'bible_in_a_year',
    'Bible in a Year',
    'Carry the reading discipline into a complete yearlong plan.',
    'bible',
    5000,
    365,
    'membership_active',
    'book',
    50
  )
on conflict (challenge_key) do nothing;

insert into public.user_challenge_states (
  user_id,
  challenge_key,
  status,
  unlock_points,
  unlocked_at
)
select
  stats.user_id,
  definition.challenge_key,
  'available',
  definition.points_required,
  now()
from public.user_game_stats stats
join public.challenge_definitions definition
  on definition.is_active
 and definition.points_required <= greatest(stats.total_points, 0)
 and (
   definition.entitlement_key is null
   or exists (
     select 1
     from public.entitlements entitlement
     where entitlement.user_id = stats.user_id
       and entitlement.entitlement_key = definition.entitlement_key
       and entitlement.status = 'active'
       and (entitlement.starts_at is null or entitlement.starts_at <= now())
       and (entitlement.ends_at is null or entitlement.ends_at > now())
   )
 )
on conflict (user_id, challenge_key) do nothing;

create or replace function public.challenge_progression_for_user(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_total_points integer := 0;
  challenge_rows jsonb := '[]'::jsonb;
  next_unlock jsonb := null;
begin
  select greatest(coalesce(stats.total_points, 0), 0)
    into current_total_points
  from public.user_game_stats stats
  where stats.user_id = target_user_id;

  current_total_points := coalesce(current_total_points, 0);

  select coalesce(jsonb_agg(catalog.challenge order by catalog.points_required, catalog.sort_order, catalog.challenge_key), '[]'::jsonb)
    into challenge_rows
  from (
    select
      definition.challenge_key,
      definition.points_required,
      definition.sort_order,
      jsonb_build_object(
        'key', definition.challenge_key,
        'title', definition.title,
        'teaser', definition.teaser,
        'type', definition.challenge_type,
        'pointsRequired', definition.points_required,
        'durationDays', definition.duration_days,
        'entitlementKey', definition.entitlement_key,
        'icon', definition.icon,
        'sortOrder', definition.sort_order,
        'metadata', definition.metadata,
        'active', definition.is_active,
        'status', coalesce(user_state.status, 'locked'),
        'canAccess',
          definition.entitlement_key is null
          or exists (
            select 1
            from public.entitlements entitlement
            where entitlement.user_id = target_user_id
              and entitlement.entitlement_key = definition.entitlement_key
              and entitlement.status = 'active'
              and (entitlement.starts_at is null or entitlement.starts_at <= now())
              and (entitlement.ends_at is null or entitlement.ends_at > now())
          ),
        'accessReason', case
          when definition.entitlement_key is not null and not exists (
            select 1
            from public.entitlements entitlement
            where entitlement.user_id = target_user_id
              and entitlement.entitlement_key = definition.entitlement_key
              and entitlement.status = 'active'
              and (entitlement.starts_at is null or entitlement.starts_at <= now())
              and (entitlement.ends_at is null or entitlement.ends_at > now())
          ) then 'membership_required'
          when user_state.challenge_key is null then 'points_required'
          else null
        end,
        'pointsRemaining', case
          when user_state.challenge_key is not null then 0
          else greatest(definition.points_required - current_total_points, 0)
        end,
        'progressPercent', case
          when user_state.challenge_key is not null or definition.points_required = 0 then 100
          else least(round((current_total_points::numeric / definition.points_required::numeric) * 100, 2), 100)
        end,
        'unlockPoints', user_state.unlock_points,
        'unlockedAt', user_state.unlocked_at,
        'startedAt', user_state.started_at,
        'completedAt', user_state.completed_at,
        'celebrationSeenAt', user_state.celebration_seen_at
      ) as challenge
    from public.challenge_definitions definition
    left join public.user_challenge_states user_state
      on user_state.user_id = target_user_id
     and user_state.challenge_key = definition.challenge_key
    where definition.is_active
  ) catalog;

  select jsonb_build_object(
      'key', definition.challenge_key,
      'title', definition.title,
      'pointsRequired', definition.points_required,
      'pointsRemaining', greatest(definition.points_required - current_total_points, 0),
      'progressPercent', case
        when definition.points_required = 0 then 100
        else least(round((current_total_points::numeric / definition.points_required::numeric) * 100, 2), 100)
      end
    )
    into next_unlock
  from public.challenge_definitions definition
  left join public.user_challenge_states user_state
    on user_state.user_id = target_user_id
   and user_state.challenge_key = definition.challenge_key
  where definition.is_active
    and user_state.challenge_key is null
    and (
      definition.entitlement_key is null
      or exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = target_user_id
          and entitlement.entitlement_key = definition.entitlement_key
          and entitlement.status = 'active'
          and (entitlement.starts_at is null or entitlement.starts_at <= now())
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    )
  order by definition.points_required, definition.sort_order, definition.challenge_key
  limit 1;

  return jsonb_build_object(
    'totalPoints', current_total_points,
    'challenges', challenge_rows,
    'nextUnlock', next_unlock
  );
end;
$$;

create or replace function public.get_challenge_progression()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You need to log in to view challenge progression.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  return public.challenge_progression_for_user(current_user_id);
end;
$$;

create or replace function public.claim_challenge_unlocks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  claimed_keys jsonb := '[]'::jsonb;
begin
  if current_user_id is null then
    raise exception 'You need to log in to claim challenge unlocks.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  with pending as materialized (
    select user_state.user_id, user_state.challenge_key
    from public.user_challenge_states user_state
    join public.challenge_definitions definition
      on definition.challenge_key = user_state.challenge_key
     and definition.is_active
    where user_state.user_id = current_user_id
      and user_state.celebration_seen_at is null
      and (
        definition.entitlement_key is null
        or exists (
          select 1
          from public.entitlements entitlement
          where entitlement.user_id = current_user_id
            and entitlement.entitlement_key = definition.entitlement_key
            and entitlement.status = 'active'
            and (entitlement.starts_at is null or entitlement.starts_at <= now())
            and (entitlement.ends_at is null or entitlement.ends_at > now())
        )
      )
    order by definition.points_required, definition.sort_order, definition.challenge_key
    for update of user_state skip locked
  ),
  claimed as (
    update public.user_challenge_states user_state
    set celebration_seen_at = now()
    from pending
    where user_state.user_id = pending.user_id
      and user_state.challenge_key = pending.challenge_key
      and user_state.celebration_seen_at is null
    returning user_state.challenge_key
  )
  select coalesce(jsonb_agg(claimed.challenge_key order by definition.points_required, definition.sort_order, claimed.challenge_key), '[]'::jsonb)
    into claimed_keys
  from claimed
  join public.challenge_definitions definition
    on definition.challenge_key = claimed.challenge_key;

  return jsonb_build_object(
    'claimedKeys', claimed_keys,
    'progression', public.challenge_progression_for_user(current_user_id)
  );
end;
$$;

create or replace function public.start_challenge(target_challenge_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_status text;
  definition_active boolean;
  required_entitlement_key text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to start a challenge.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  select user_state.status, definition.is_active, definition.entitlement_key
    into current_status, definition_active, required_entitlement_key
  from public.user_challenge_states user_state
  join public.challenge_definitions definition
    on definition.challenge_key = user_state.challenge_key
  where user_state.user_id = current_user_id
    and user_state.challenge_key = target_challenge_key
  for update of user_state;

  if not found then
    raise exception 'That challenge is still locked.';
  end if;

  if not definition_active then
    raise exception 'That challenge is not currently available.';
  end if;

  if current_status <> 'available' then
    raise exception 'Only an available challenge can be started.';
  end if;

  if required_entitlement_key is not null and not exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = current_user_id
      and entitlement.entitlement_key = required_entitlement_key
      and entitlement.status = 'active'
      and (entitlement.starts_at is null or entitlement.starts_at <= now())
      and (entitlement.ends_at is null or entitlement.ends_at > now())
  ) then
    raise exception 'An active membership is required to start this challenge.';
  end if;

  update public.user_challenge_states
  set
    status = 'active',
    started_at = now()
  where user_id = current_user_id
    and challenge_key = target_challenge_key
    and status = 'available';

  return public.challenge_progression_for_user(current_user_id);
end;
$$;

alter table public.challenge_definitions enable row level security;
alter table public.user_challenge_states enable row level security;

drop policy if exists "Authenticated users can read challenge definitions" on public.challenge_definitions;
create policy "Authenticated users can read challenge definitions"
  on public.challenge_definitions
  for select
  to authenticated
  using (is_active);

drop policy if exists "Users can read own challenge states" on public.user_challenge_states;
create policy "Users can read own challenge states"
  on public.user_challenge_states
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.challenge_definitions from public;
revoke all on public.challenge_definitions from anon;
revoke all on public.challenge_definitions from authenticated;
revoke all on public.challenge_definitions from service_role;
revoke all on public.user_challenge_states from public;
revoke all on public.user_challenge_states from anon;
revoke all on public.user_challenge_states from authenticated;
revoke all on public.user_challenge_states from service_role;

grant select on public.challenge_definitions to authenticated;
grant select on public.user_challenge_states to authenticated;
grant select, insert, update, delete on public.challenge_definitions to service_role;
grant select, insert, update, delete on public.user_challenge_states to service_role;

revoke execute on function public.reconcile_user_challenge_unlocks(uuid) from public;
revoke execute on function public.reconcile_user_challenge_unlocks(uuid) from anon;
revoke execute on function public.reconcile_user_challenge_unlocks(uuid) from authenticated;
revoke execute on function public.sync_user_challenge_unlocks_from_stats() from public;
revoke execute on function public.sync_user_challenge_unlocks_from_stats() from anon;
revoke execute on function public.sync_user_challenge_unlocks_from_stats() from authenticated;
revoke execute on function public.sync_challenge_definition_unlocks() from public;
revoke execute on function public.sync_challenge_definition_unlocks() from anon;
revoke execute on function public.sync_challenge_definition_unlocks() from authenticated;
revoke execute on function public.challenge_progression_for_user(uuid) from public;
revoke execute on function public.challenge_progression_for_user(uuid) from anon;
revoke execute on function public.challenge_progression_for_user(uuid) from authenticated;

revoke execute on function public.get_challenge_progression() from public;
revoke execute on function public.get_challenge_progression() from anon;
grant execute on function public.get_challenge_progression() to authenticated;
revoke execute on function public.claim_challenge_unlocks() from public;
revoke execute on function public.claim_challenge_unlocks() from anon;
grant execute on function public.claim_challenge_unlocks() to authenticated;
revoke execute on function public.start_challenge(text) from public;
revoke execute on function public.start_challenge(text) from anon;
grant execute on function public.start_challenge(text) to authenticated;

commit;
