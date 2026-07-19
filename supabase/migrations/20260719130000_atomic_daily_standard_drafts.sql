-- Atomic, date-scoped Daily Standard drafts shared by every action surface.

alter table public.challenge_entries
  add column if not exists workout_difficulty jsonb not null default '{}'::jsonb,
  add column if not exists version bigint not null default 0;

create or replace function public.daily_standard_user_date(target_user_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target_time_zone text;
begin
  select nullif(profile.time_zone, '')
    into target_time_zone
    from public.profiles profile
    where profile.user_id = target_user_id;

  if target_time_zone is null or not exists (
    select 1 from pg_timezone_names where name = target_time_zone
  ) then
    target_time_zone := 'UTC';
  end if;

  return (clock_timestamp() at time zone target_time_zone)::date;
end;
$$;

create or replace function public.daily_standard_draft_payload(
  target_user_id uuid,
  target_entry_date date,
  stale_write_reconciled boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  draft public.challenge_entries%rowtype;
  was_submitted boolean;
begin
  select * into draft
    from public.challenge_entries entry
    where entry.user_id = target_user_id
      and entry.entry_date = target_entry_date;

  select exists (
    select 1
    from public.check_ins check_in
    where check_in.user_id = target_user_id
      and check_in.entry_date = target_entry_date
  ) into was_submitted;

  return jsonb_build_object(
    'entry_date', target_entry_date,
    'completed', coalesce(draft.completed, '{}'::text[]),
    'workout_difficulty', coalesce(draft.workout_difficulty, '{}'::jsonb),
    'version', coalesce(draft.version, 0),
    'updated_at', draft.updated_at,
    'submitted', was_submitted,
    'locked', was_submitted or target_entry_date <> public.daily_standard_user_date(target_user_id),
    'stale_write_reconciled', stale_write_reconciled
  );
end;
$$;

create or replace function public.get_daily_standard_draft(target_entry_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You need to log in to view Daily Standards.';
  end if;
  if target_entry_date is null then
    raise exception 'Choose a valid challenge date.' using errcode = '22023';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to view Daily Standards.';
  end if;

  return public.daily_standard_draft_payload(auth.uid(), target_entry_date);
end;
$$;

create or replace function public.mutate_daily_standard_draft(
  target_entry_date date,
  target_action_id text,
  target_completed boolean,
  target_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft public.challenge_entries%rowtype;
  valid_action_ids constant text[] := array[
    'bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer',
    'workoutOne', 'walk', 'workoutTwo'
  ]::text[];
  stale_write boolean := false;
  state_changed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to update Daily Standards.';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to update Daily Standards.';
  end if;
  if target_entry_date is null or target_entry_date <> public.daily_standard_user_date(auth.uid()) then
    raise exception 'That Daily Standards date is locked.' using errcode = '22023';
  end if;
  if target_action_id is null or not (target_action_id = any(valid_action_ids)) then
    raise exception 'Choose a valid Daily Standard.' using errcode = '22023';
  end if;
  if target_completed is null then
    raise exception 'Choose whether the action is complete.' using errcode = '22023';
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
  state_changed := (target_action_id = any(draft.completed)) is distinct from target_completed;

  if state_changed then
    update public.challenge_entries
    set
      completed = case
        when target_completed then array_append(completed, target_action_id)
        else array_remove(completed, target_action_id)
      end,
      version = version + 1
    where user_id = auth.uid()
      and entry_date = target_entry_date;
  end if;

  return public.daily_standard_draft_payload(auth.uid(), target_entry_date, stale_write);
end;
$$;

create or replace function public.set_daily_standard_workout_difficulty(
  target_entry_date date,
  target_workout_id text,
  target_difficulty text,
  target_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
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
  current_difficulty := coalesce(draft.workout_difficulty ->> target_workout_id, 'medium');

  if current_difficulty <> target_difficulty then
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

create or replace function public.apply_authoritative_daily_standard_draft()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  draft public.challenge_entries%rowtype;
begin
  select * into draft
    from public.challenge_entries entry
    where entry.user_id = new.user_id
      and entry.entry_date = new.entry_date
    for update;

  if found then
    new.completed := draft.completed;
    new.completed_count := cardinality(draft.completed);
    new.status := case when cardinality(draft.completed) = 7 then 'complete' else 'partial' end;
    new.workout_difficulty := draft.workout_difficulty;
  end if;
  return new;
end;
$$;

drop trigger if exists a_apply_authoritative_daily_standard_draft on public.check_ins;
create trigger a_apply_authoritative_daily_standard_draft
  before insert on public.check_ins
  for each row execute function public.apply_authoritative_daily_standard_draft();

revoke insert, update, delete on public.challenge_entries from authenticated;
grant select on public.challenge_entries to authenticated;

revoke execute on function public.daily_standard_user_date(uuid) from public, anon, authenticated;
revoke execute on function public.daily_standard_draft_payload(uuid, date, boolean) from public, anon, authenticated;
revoke execute on function public.apply_authoritative_daily_standard_draft() from public, anon, authenticated;
revoke execute on function public.get_daily_standard_draft(date) from public, anon;
grant execute on function public.get_daily_standard_draft(date) to authenticated;
revoke execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) from public, anon;
grant execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) to authenticated;
revoke execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) from public, anon;
grant execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) to authenticated;
