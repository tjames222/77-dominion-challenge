-- Atomic, date-scoped Daily Standard drafts shared by every action surface.

alter table public.challenge_entries
  add column if not exists workout_difficulty jsonb not null default '{}'::jsonb,
  add column if not exists version bigint not null default 0;

create or replace function public.normalize_daily_standard_completed(target_completed text[])
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(item.action_id order by item.first_position), '{}'::text[])
  from (
    select completed_item as action_id, min(item_position) as first_position
    from unnest(coalesce(target_completed, '{}'::text[]))
      with ordinality as supplied(completed_item, item_position)
    where completed_item = any(array[
      'bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer',
      'workoutOne', 'walk', 'workoutTwo'
    ]::text[])
    group by completed_item
  ) item;
$$;

update public.challenge_entries draft
set
  completed = public.normalize_daily_standard_completed(draft.completed),
  version = draft.version + 1
where draft.completed is distinct from public.normalize_daily_standard_completed(draft.completed);

create or replace function public.normalize_daily_standard_draft()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.completed := public.normalize_daily_standard_completed(new.completed);
  return new;
end;
$$;

drop trigger if exists normalize_daily_standard_draft_write on public.challenge_entries;
create trigger normalize_daily_standard_draft_write
  before insert or update of completed on public.challenge_entries
  for each row execute function public.normalize_daily_standard_draft();

create or replace function public.daily_standard_user_date(target_user_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_time_zone text;
begin
  select nullif(profile.time_zone, '')
    into target_time_zone
    from public.profiles profile
    where profile.user_id = target_user_id;

  if target_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = target_time_zone
  ) then
    target_time_zone := 'UTC';
  end if;

  return (clock_timestamp() at time zone target_time_zone)::date;
end;
$$;

create or replace function public.bootstrap_daily_standard_time_zone(target_time_zone text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  requested_time_zone text := nullif(btrim(target_time_zone), '');
  effective_time_zone text;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to set your Daily Standards time zone.';
  end if;
  if requested_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = requested_time_zone
  ) then
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

  select nullif(profile.time_zone, '')
    into effective_time_zone
    from public.profiles profile
    where profile.user_id = auth.uid()
    for update;

  if effective_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = effective_time_zone
  ) then
    update public.profiles
    set time_zone = requested_time_zone
    where user_id = auth.uid();
    effective_time_zone := requested_time_zone;
  end if;

  return effective_time_zone;
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
set search_path = pg_catalog, pg_temp
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
    'locked', was_submitted
      or target_entry_date <> public.daily_standard_user_date(target_user_id)
      or exists (
        select 1 from public.profiles profile
        where profile.user_id = target_user_id
          and profile.challenge_start_date is not null
          and target_entry_date - profile.challenge_start_date + 1 not between 1 and 77
      ),
    'stale_write_reconciled', stale_write_reconciled
  );
end;
$$;

create or replace function public.get_daily_standard_draft(target_entry_date date)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
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
set search_path = pg_catalog, pg_temp
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
  if exists (
    select 1 from public.profiles profile
    where profile.user_id = auth.uid()
      and profile.challenge_start_date is not null
      and target_entry_date - profile.challenge_start_date + 1 not between 1 and 77
  ) then
    raise exception 'The 77-day challenge is complete.' using errcode = '22023';
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
set search_path = pg_catalog, pg_temp
as $$
declare
  requested_time_zone text := coalesce(nullif(btrim(target_time_zone), ''), 'UTC');
  effective_time_zone text;
  target_entry_date date;
  target_challenge_day integer;
  challenge_start date;
  normalized_completed text[];
  effective_status text;
  draft public.challenge_entries%rowtype;
  inserted_check_in public.check_ins%rowtype;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to post a check-in.';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to post a check-in.';
  end if;
  if target_status is null or target_status not in ('complete', 'partial') then
    raise exception 'Choose a valid check-in status.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = requested_time_zone
  ) then
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
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = effective_time_zone
  ) then
    effective_time_zone := requested_time_zone;
  end if;

  target_entry_date := (clock_timestamp() at time zone effective_time_zone)::date;
  if target_expected_date is not null and target_expected_date <> target_entry_date then
    raise exception 'The challenge day changed. Review today''s actions and post again.' using errcode = '22023';
  end if;

  select * into draft
    from public.challenge_entries entry
    where entry.user_id = auth.uid()
      and entry.entry_date = target_entry_date
    for update;
  if not found then
    raise exception 'Complete at least one action before posting.' using errcode = '22023';
  end if;

  normalized_completed := public.normalize_daily_standard_completed(draft.completed);
  if cardinality(normalized_completed) = 0 then
    raise exception 'Complete at least one action before posting.' using errcode = '22023';
  end if;
  if draft.completed is distinct from normalized_completed then
    update public.challenge_entries
    set
      completed = normalized_completed,
      version = version + 1
    where user_id = auth.uid()
      and entry_date = target_entry_date;
  end if;

  effective_status := case
    when cardinality(normalized_completed) = 7 then 'complete'
    else 'partial'
  end;

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
    coalesce(draft.workout_difficulty, '{}'::jsonb)
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

create or replace function public.apply_authoritative_daily_standard_draft()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  draft public.challenge_entries%rowtype;
  normalized_completed text[];
begin
  if new.status = 'scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode = '22023';
  end if;

  select * into draft
    from public.challenge_entries entry
    where entry.user_id = new.user_id
      and entry.entry_date = new.entry_date
    for update;

  if not found then
    raise exception 'Complete at least one action before posting.' using errcode = '22023';
  end if;

  normalized_completed := public.normalize_daily_standard_completed(draft.completed);
  if cardinality(normalized_completed) = 0 then
    raise exception 'Complete at least one action before posting.' using errcode = '22023';
  end if;

  new.completed := normalized_completed;
  new.completed_count := cardinality(normalized_completed);
  new.status := case when cardinality(normalized_completed) = 7 then 'complete' else 'partial' end;
  new.workout_difficulty := draft.workout_difficulty;
  return new;
end;
$$;

drop trigger if exists a_apply_authoritative_daily_standard_draft on public.check_ins;
create trigger a_apply_authoritative_daily_standard_draft
  before insert on public.check_ins
  for each row execute function public.apply_authoritative_daily_standard_draft();

revoke insert, update, delete on public.challenge_entries from authenticated;
revoke insert (user_id, entry_date, completed) on public.challenge_entries from authenticated;
revoke update (user_id, entry_date, completed) on public.challenge_entries from authenticated;
grant select on public.challenge_entries to authenticated;

revoke execute on function public.normalize_daily_standard_completed(text[]) from public, anon, authenticated;
revoke execute on function public.normalize_daily_standard_draft() from public, anon, authenticated;
revoke execute on function public.daily_standard_user_date(uuid) from public, anon, authenticated;
revoke execute on function public.daily_standard_draft_payload(uuid, date, boolean) from public, anon, authenticated;
revoke execute on function public.apply_authoritative_daily_standard_draft() from public, anon, authenticated;
revoke execute on function public.bootstrap_daily_standard_time_zone(text) from public, anon;
grant execute on function public.bootstrap_daily_standard_time_zone(text) to authenticated;
revoke execute on function public.get_daily_standard_draft(date) from public, anon;
grant execute on function public.get_daily_standard_draft(date) to authenticated;
revoke execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) from public, anon;
grant execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) to authenticated;
revoke execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) from public, anon;
grant execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) to authenticated;
revoke execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) from public, anon;
grant execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) to authenticated;

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
set search_path = pg_catalog, pg_temp
as $$
declare
  requested_time_zone text := coalesce(nullif(btrim(target_time_zone), ''), 'UTC');
  effective_time_zone text;
  target_entry_date date;
  target_challenge_day integer;
  challenge_start date;
  normalized_completed text[];
  effective_status text;
  draft public.challenge_entries%rowtype;
  inserted_check_in public.check_ins%rowtype;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to post a check-in.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to post a check-in.';
  end if;

  if target_status is null or target_status not in ('complete', 'partial') then
    raise exception 'Choose a valid check-in status.' using errcode = '22023';
  end if;

  if not exists (select 1 from pg_catalog.pg_timezone_names where name = requested_time_zone) then
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
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = effective_time_zone) then
    effective_time_zone := requested_time_zone;
  end if;
  target_entry_date := (clock_timestamp() at time zone effective_time_zone)::date;
  if target_expected_date is not null and target_expected_date <> target_entry_date then
    raise exception 'The challenge day changed. Review today''s actions and post again.' using errcode = '22023';
  end if;

  select * into draft
  from public.challenge_entries entry
  where entry.user_id = auth.uid()
    and entry.entry_date = target_entry_date
  for update;
  if not found then
    raise exception 'Complete at least one action before posting.' using errcode = '22023';
  end if;

  normalized_completed := public.normalize_daily_standard_completed(draft.completed);

  if cardinality(normalized_completed) = 0 then
    raise exception 'Complete at least one action before posting.' using errcode = '22023';
  end if;
  if draft.completed is distinct from normalized_completed then
    update public.challenge_entries
    set
      completed = normalized_completed,
      version = version + 1
    where user_id = auth.uid()
      and entry_date = target_entry_date;
  end if;

  effective_status := case
    when cardinality(normalized_completed) = 7 then 'complete'
    else 'partial'
  end;

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
    coalesce(draft.workout_difficulty, '{}'::jsonb)
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
