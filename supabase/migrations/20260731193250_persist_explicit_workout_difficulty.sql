begin;

-- An absent value still scores with the established Medium fallback, but once
-- the member explicitly chooses Medium it must be stored like every other
-- selection so the UI does not return to its Difficulty placeholder.
create or replace function public.set_daily_standard_workout_difficulty(
  target_entry_date date,
  target_workout_id text,
  target_difficulty text,
  target_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  draft public.challenge_entries%rowtype;
  stale_write boolean := false;
  current_difficulty text;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to update workout difficulty.';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to update workout difficulty.';
  end if;
  if target_entry_date is null or target_entry_date <> public.daily_standard_user_date(auth.uid()) then
    raise exception 'That Daily Standards date is locked.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.profiles profile
    where profile.user_id = auth.uid()
      and profile.challenge_start_date is not null
      and target_entry_date - profile.challenge_start_date + 1 not between 1 and 77
  ) then
    raise exception 'The 77-day challenge is complete.' using errcode = '22023';
  end if;
  if target_workout_id is null or target_workout_id not in ('one', 'two') then
    raise exception 'Choose a valid workout.' using errcode = '22023';
  end if;
  if target_difficulty is null or target_difficulty not in ('easy', 'medium', 'hard', 'extreme') then
    raise exception 'Choose a valid workout difficulty.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.check_ins check_in
    where check_in.user_id = auth.uid()
      and check_in.entry_date = target_entry_date
  ) then
    raise exception 'This Check-In is already submitted.' using errcode = '55000';
  end if;

  insert into public.challenge_entries (user_id, entry_date, completed)
  values (auth.uid(), target_entry_date, '{}'::text[])
  on conflict (user_id, entry_date) do nothing;

  select * into draft
    from public.challenge_entries entry
    where entry.user_id = auth.uid()
      and entry.entry_date = target_entry_date
    for update;

  if exists (
    select 1 from public.check_ins check_in
    where check_in.user_id = auth.uid()
      and check_in.entry_date = target_entry_date
  ) then
    raise exception 'This Check-In is already submitted.' using errcode = '55000';
  end if;

  stale_write := target_expected_version is not null
    and target_expected_version <> draft.version;
  current_difficulty := draft.workout_difficulty ->> target_workout_id;

  if current_difficulty is distinct from target_difficulty then
    update public.challenge_entries
    set
      workout_difficulty = jsonb_set(
        coalesce(workout_difficulty, '{}'::jsonb),
        array[target_workout_id],
        to_jsonb(target_difficulty),
        true
      ),
      version = version + 1
    where user_id = auth.uid()
      and entry_date = target_entry_date;
  end if;

  return public.daily_standard_draft_payload(auth.uid(), target_entry_date, stale_write);
end;
$$;

revoke execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint)
  from public, anon;
grant execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint)
  to authenticated;

commit;
