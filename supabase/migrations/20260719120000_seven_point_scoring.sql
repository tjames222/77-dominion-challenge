-- Enforce the prospective seven-point Daily Standards economy at the trusted layer.

create or replace function public.add_game_points(
  target_user_id uuid,
  target_event_type text,
  target_points integer,
  target_entry_date date,
  target_challenge_day integer,
  target_crew_id uuid,
  target_metadata jsonb,
  target_idempotency_key text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  effective_points integer := target_points;
begin
  if target_event_type in ('app_visit', 'app_streak_bonus', 'full_day_streak_bonus', 'workout_difficulty') then
    return false;
  end if;

  if target_event_type = 'check_in' then
    effective_points := least(greatest(
      case
        when coalesce(target_metadata ->> 'completedCount', '') ~ '^\d+$'
          then (target_metadata ->> 'completedCount')::integer
        else 0
      end,
      0
    ), 7);
  end if;

  if effective_points <= 0 then
    return false;
  end if;

  perform public.ensure_user_game_stats(target_user_id);

  insert into public.game_point_events (
    user_id,
    event_type,
    points,
    entry_date,
    challenge_day,
    crew_id,
    metadata,
    idempotency_key
  ) values (
    target_user_id,
    target_event_type,
    effective_points,
    target_entry_date,
    target_challenge_day,
    target_crew_id,
    coalesce(target_metadata, '{}'::jsonb),
    target_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning id into inserted_id;

  if inserted_id is null then
    return false;
  end if;

  update public.user_game_stats
  set
    total_points = total_points + effective_points,
    challenge_points = challenge_points + effective_points,
    updated_at = now()
  where user_id = target_user_id;

  return true;
end;
$$;

create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
immutable
set search_path = public
as $$
  select 0;
$$;

create or replace function public.full_streak_bonus_points(target_streak integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select 0;
$$;

create or replace function public.enforce_daily_standard_award()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.points_awarded := least(greatest(cardinality(coalesce(new.completed, '{}'::text[])), 0), 7);
  return new;
end;
$$;

drop trigger if exists zz_enforce_daily_standard_award on public.check_ins;
create trigger zz_enforce_daily_standard_award
  before insert on public.check_ins
  for each row execute function public.enforce_daily_standard_award();

drop table if exists public.workout_difficulty_point_values;
