begin;

alter table public.profiles
  add column if not exists time_zone text;

lock table public.check_ins in share row exclusive mode;

-- Existing point awards are already idempotent by user and entry date. Keep the
-- effective row that received those points, then remove zero-point duplicates.
-- Community feed rows for discarded check-ins are removed by their cascade.
with ranked_check_ins as (
  select
    id,
    row_number() over (
      partition by user_id, entry_date
      order by (points_awarded > 0) desc, points_awarded desc, created_at asc, id asc
    ) as duplicate_rank
  from public.check_ins
)
delete from public.check_ins check_in
using ranked_check_ins ranked
where check_in.id = ranked.id
  and ranked.duplicate_rank > 1;

create unique index if not exists check_ins_user_entry_date_unique_idx
  on public.check_ins (user_id, entry_date);

-- A challenge day is also single-use. This closes attempts that change the
-- client entry date or challenge start date while targeting the same day.
with ranked_challenge_days as (
  select
    id,
    row_number() over (
      partition by user_id, challenge_day
      order by (points_awarded > 0) desc, points_awarded desc, created_at asc, id asc
    ) as duplicate_rank
  from public.check_ins
)
delete from public.check_ins check_in
using ranked_challenge_days ranked
where check_in.id = ranked.id
  and ranked.duplicate_rank > 1;

create unique index if not exists check_ins_user_challenge_day_unique_idx
  on public.check_ins (user_id, challenge_day);

-- Preserve the challenge calendar already represented by legacy check-ins.
-- Profiles are normally created at sign-up, but backfill any missing rows so
-- the RPC and start-date lock also work for imported or older accounts.
drop trigger if exists lock_challenge_start_date_after_check_in on public.profiles;

with inferred_challenge_starts as (
  select distinct on (check_in.user_id)
    check_in.user_id,
    check_in.entry_date - (check_in.challenge_day - 1) as challenge_start_date
  from public.check_ins check_in
  order by check_in.user_id, check_in.created_at asc, check_in.id asc
)
insert into public.profiles (user_id, name, email, challenge_start_date)
select
  inferred.user_id,
  coalesce(nullif(auth_user.raw_user_meta_data ->> 'name', ''), 'Member'),
  coalesce(auth_user.email, ''),
  inferred.challenge_start_date
from inferred_challenge_starts inferred
join auth.users auth_user on auth_user.id = inferred.user_id
left join public.profiles profile on profile.user_id = inferred.user_id
where profile.user_id is null
on conflict (user_id) do nothing;

with inferred_challenge_starts as (
  select distinct on (check_in.user_id)
    check_in.user_id,
    check_in.entry_date - (check_in.challenge_day - 1) as challenge_start_date
  from public.check_ins check_in
  order by check_in.user_id, check_in.created_at asc, check_in.id asc
)
update public.profiles profile
set challenge_start_date = inferred.challenge_start_date
from inferred_challenge_starts inferred
where profile.user_id = inferred.user_id
  and profile.challenge_start_date is null;

create or replace function public.lock_challenge_start_date_after_check_in()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.challenge_start_date is distinct from old.challenge_start_date
    and exists (
      select 1
      from public.check_ins check_in
      where check_in.user_id = old.user_id
    ) then
    raise exception 'The challenge start date is locked after the first check-in.';
  end if;

  return new;
end;
$$;

create trigger lock_challenge_start_date_after_check_in
  before update of challenge_start_date on public.profiles
  for each row execute function public.lock_challenge_start_date_after_check_in();

create or replace function public.submit_daily_check_in(
  target_status text,
  target_completed text[] default '{}'::text[],
  target_workout_difficulty jsonb default '{}'::jsonb,
  target_time_zone text default 'UTC',
  target_expected_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_time_zone text := coalesce(nullif(btrim(target_time_zone), ''), 'UTC');
  effective_time_zone text;
  target_entry_date date;
  target_challenge_day integer;
  challenge_start date;
  normalized_completed text[];
  effective_status text;
  inserted_check_in public.check_ins%rowtype;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to post a check-in.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to post a check-in.';
  end if;

  if target_status is null or target_status not in ('complete', 'partial', 'scheduled') then
    raise exception 'Choose a valid check-in status.' using errcode = '22023';
  end if;

  if not exists (select 1 from pg_timezone_names where name = requested_time_zone) then
    raise exception 'Choose a valid time zone.' using errcode = '22023';
  end if;

  insert into public.profiles (user_id, name, email, time_zone)
  values (
    auth.uid(),
    coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''), 'Member'),
    coalesce(auth.jwt() ->> 'email', ''),
    requested_time_zone
  )
  on conflict (user_id) do nothing;

  select profile.time_zone, profile.challenge_start_date
    into effective_time_zone, challenge_start
  from public.profiles profile
  where profile.user_id = auth.uid()
  for update;

  effective_time_zone := coalesce(nullif(effective_time_zone, ''), requested_time_zone);
  if not exists (select 1 from pg_timezone_names where name = effective_time_zone) then
    effective_time_zone := requested_time_zone;
  end if;
  target_entry_date := (clock_timestamp() at time zone effective_time_zone)::date;
  if target_expected_date is not null and target_expected_date <> target_entry_date then
    raise exception 'The challenge day changed. Review today''s actions and post again.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct completed_item), '{}'::text[])
    into normalized_completed
  from unnest(coalesce(target_completed, '{}'::text[])) completed_item
  where completed_item = any(array[
    'bible',
    'morningPrayer',
    'worshipOnly',
    'eveningPrayer',
    'workoutOne',
    'walk',
    'workoutTwo'
  ]::text[]);

  if target_status = 'scheduled' then
    normalized_completed := '{}'::text[];
    effective_status := 'scheduled';
  elsif cardinality(normalized_completed) = 7 then
    effective_status := 'complete';
  elsif cardinality(normalized_completed) > 0 then
    effective_status := 'partial';
  else
    raise exception 'Complete an action or choose a scheduled miss before posting.' using errcode = '22023';
  end if;

  if challenge_start is null then
    challenge_start := target_entry_date;
  end if;

  update public.profiles
  set
    time_zone = effective_time_zone,
    challenge_start_date = coalesce(challenge_start_date, challenge_start)
  where user_id = auth.uid();

  target_challenge_day := target_entry_date - challenge_start + 1;
  if target_challenge_day < 1 or target_challenge_day > 77 then
    raise exception 'The check-in date is outside the active 77-day challenge.' using errcode = '22023';
  end if;

  insert into public.check_ins (
    user_id,
    entry_date,
    challenge_day,
    status,
    completed_count,
    completed,
    workout_difficulty
  ) values (
    auth.uid(),
    target_entry_date,
    target_challenge_day,
    effective_status,
    cardinality(normalized_completed),
    normalized_completed,
    coalesce(target_workout_difficulty, '{}'::jsonb)
  )
  returning * into inserted_check_in;

  return jsonb_build_object(
    'id', inserted_check_in.id,
    'entry_date', inserted_check_in.entry_date,
    'challenge_day', inserted_check_in.challenge_day,
    'status', inserted_check_in.status,
    'completed_count', inserted_check_in.completed_count,
    'points_awarded', inserted_check_in.points_awarded,
    'created_at', inserted_check_in.created_at
  );
end;
$$;

grant select (entry_date) on public.check_ins to authenticated;
revoke insert on public.check_ins from authenticated;
revoke update on public.profiles from authenticated;
grant update (user_id, name, email, avatar_url, challenge_start_date) on public.profiles to authenticated;
revoke execute on function public.lock_challenge_start_date_after_check_in() from public;
revoke execute on function public.lock_challenge_start_date_after_check_in() from anon;
revoke execute on function public.lock_challenge_start_date_after_check_in() from authenticated;
revoke execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) from public;
revoke execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) from anon;
grant execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) to authenticated;

commit;
