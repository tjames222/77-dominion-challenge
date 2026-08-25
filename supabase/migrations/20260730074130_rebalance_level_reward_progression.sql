-- Active rewards remain independent point thresholds, but every launch reward
-- lands on the same 14-point cadence used by the display-only level system.
create or replace function public.enforce_reward_point_floor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_active and (
    new.points_required < 56
    or mod(new.points_required, 14) <> 0
  ) then
    raise exception 'Active point rewards must require at least 56 points and align to a 14-point level boundary.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- A state inserted with its celebration already acknowledged is a silent
-- backfill, not a newly earned unlock. Keep those rows out of crew integration
-- notifications as well as the in-app celebration queue.
drop trigger if exists emit_challenge_reward_outbound_event
  on public.user_challenge_states;
create trigger emit_challenge_reward_outbound_event
  after insert on public.user_challenge_states
  for each row
  when (new.celebration_seen_at is null)
  execute function private.emit_challenge_reward_outbound_event();

-- Users who already qualify under the launch curve keep their history and gain
-- the newly reachable rewards without receiving a migration-time celebration
-- cascade. Future threshold crossings still use the normal pending celebration
-- behavior.
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
  'threshold_rebalance',
  'fou-846:56',
  now()
from public.user_game_stats stats
join public.reward_definitions definition
  on definition.reward_key = 'dominion_night_theme'
 and definition.state_model = 'ownership'
 and definition.is_active
where greatest(stats.total_points, 0) >= 56
on conflict (user_id, reward_key) do nothing;

with launch_thresholds(challenge_key, points_required) as (
  values
    ('seven_day_reset', 126),
    ('twenty_one_day_prayer', 210),
    ('thirty_day_strength', 308),
    ('forty_day_fast', 420),
    ('bible_in_a_year', 532)
)
insert into public.user_challenge_states (
  user_id,
  challenge_key,
  status,
  unlock_points,
  unlocked_at,
  celebration_seen_at
)
select
  stats.user_id,
  definition.challenge_key,
  'available',
  launch_thresholds.points_required,
  now(),
  now()
from public.user_game_stats stats
join launch_thresholds
  on greatest(stats.total_points, 0) >= launch_thresholds.points_required
join public.challenge_definitions definition
  on definition.challenge_key = launch_thresholds.challenge_key
 and definition.is_active
where definition.entitlement_key is null
   or exists (
     select 1
     from public.entitlements entitlement
     where entitlement.user_id = stats.user_id
       and entitlement.entitlement_key = definition.entitlement_key
       and entitlement.status = 'active'
       and (entitlement.starts_at is null or entitlement.starts_at <= now())
       and (entitlement.ends_at is null or entitlement.ends_at > now())
   )
on conflict (user_id, challenge_key) do nothing;

update public.challenge_definitions as definition
set points_required = launch_thresholds.points_required,
    updated_at = now()
from (
  values
    ('seven_day_reset', 126),
    ('twenty_one_day_prayer', 210),
    ('thirty_day_strength', 308),
    ('forty_day_fast', 420),
    ('bible_in_a_year', 532)
) as launch_thresholds(challenge_key, points_required)
where definition.challenge_key = launch_thresholds.challenge_key
  and definition.points_required is distinct from launch_thresholds.points_required;

update public.reward_definitions
set points_required = 56,
    updated_at = now()
where reward_key = 'dominion_night_theme'
  and points_required is distinct from 56;

do $$
declare
  configured_thresholds integer[];
begin
  select array_agg(definition.points_required order by definition.points_required)
    into configured_thresholds
  from public.reward_definitions definition
  where definition.is_active
    and definition.reward_key in (
      'dominion_night_theme',
      'seven_day_reset',
      'twenty_one_day_prayer',
      'thirty_day_strength',
      'forty_day_fast',
      'bible_in_a_year'
    );

  if configured_thresholds is distinct from array[56, 126, 210, 308, 420, 532] then
    raise exception 'The launch reward progression thresholds are incomplete or inconsistent.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.reward_definitions definition
    where definition.is_active
      and (
        definition.points_required < 56
        or mod(definition.points_required, 14) <> 0
      )
  ) then
    raise exception 'Every active reward must align to the launch level cadence.'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.enforce_reward_point_floor()
  from public, anon, authenticated;
