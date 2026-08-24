-- Journal dates use the member's authoritative challenge/profile timezone.
-- The trigger is intentionally non-retroactive: a pre-existing future row
-- remains readable and deletable, but its date must be corrected before any
-- update can be saved. No row is silently clamped, rewritten, or removed.

create or replace function private.journal_effective_time_zone(target_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_time_zone text;
begin
  select coalesce(
      nullif(profile.challenge_activation_time_zone, ''),
      nullif(profile.time_zone, '')
    )
    into target_time_zone
  from public.profiles profile
  where profile.user_id = target_user_id;

  if target_time_zone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = target_time_zone
  ) then
    target_time_zone := 'UTC';
  end if;

  return target_time_zone;
end;
$$;

create or replace function private.journal_user_date(target_user_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (
    pg_catalog.statement_timestamp()
      at time zone private.journal_effective_time_zone(target_user_id)
  )::date;
$$;

create or replace function private.enforce_journal_entry_date()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.entry_date > private.journal_user_date(new.user_id) then
    raise exception 'Journal entries cannot be dated in the future.'
      using errcode = '22023', detail = 'journal_entry_date_in_future';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_journal_entry_date on public.journal_entries;
create trigger enforce_journal_entry_date
  before insert or update on public.journal_entries
  for each row execute function private.enforce_journal_entry_date();

create or replace function public.journal_current_user_date()
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'You need to log in to use the private journal.'
      using errcode = '28000';
  end if;
  return private.journal_user_date(caller_id);
end;
$$;

create or replace function public.get_journal_date_policy(
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
  effective_time_zone text;
begin
  if caller_id is null then
    raise exception 'You need to log in to use the private journal.'
      using errcode = '28000';
  end if;
  if target_expected_actor_id is null or target_expected_actor_id <> caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '40001';
  end if;

  effective_time_zone := private.journal_effective_time_zone(caller_id);
  return pg_catalog.jsonb_build_object(
    'timeZone', effective_time_zone,
    'today', private.journal_user_date(caller_id)
  );
end;
$$;

create or replace function public.create_journal_entry(
  target_entry_date date,
  target_challenge_day integer,
  target_note text,
  target_win text,
  target_prayer text,
  target_mood text,
  target_energy text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  saved_row public.journal_entries%rowtype;
begin
  if caller_id is null then
    raise exception 'You need to log in to use the private journal.'
      using errcode = '28000';
  end if;
  if target_expected_actor_id is null or target_expected_actor_id <> caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '40001';
  end if;
  if target_entry_date is null then
    raise exception 'Choose a valid journal date.' using errcode = '22023';
  end if;
  if target_entry_date > public.journal_current_user_date() then
    raise exception 'Journal entries cannot be dated in the future.'
      using errcode = '22023', detail = 'journal_entry_date_in_future';
  end if;

  insert into public.journal_entries (
    user_id,
    entry_date,
    challenge_day,
    note,
    win,
    prayer,
    mood,
    energy
  ) values (
    caller_id,
    target_entry_date,
    target_challenge_day,
    coalesce(target_note, ''),
    coalesce(target_win, ''),
    coalesce(target_prayer, ''),
    coalesce(target_mood, ''),
    coalesce(target_energy, '')
  )
  returning * into saved_row;

  return pg_catalog.to_jsonb(saved_row);
end;
$$;

create or replace function public.update_journal_entry(
  target_entry_id uuid,
  target_entry_date date,
  target_challenge_day integer,
  target_note text,
  target_win text,
  target_prayer text,
  target_mood text,
  target_energy text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  saved_row public.journal_entries%rowtype;
begin
  if caller_id is null then
    raise exception 'You need to log in to use the private journal.'
      using errcode = '28000';
  end if;
  if target_expected_actor_id is null or target_expected_actor_id <> caller_id then
    raise exception 'The signed-in account changed. Try again.'
      using errcode = '40001';
  end if;
  if target_entry_id is null then
    raise exception 'A journal entry id is required.' using errcode = '22023';
  end if;
  if target_entry_date is null then
    raise exception 'Choose a valid journal date.' using errcode = '22023';
  end if;
  if target_entry_date > public.journal_current_user_date() then
    raise exception 'Journal entries cannot be dated in the future.'
      using errcode = '22023', detail = 'journal_entry_date_in_future';
  end if;

  update public.journal_entries entry
  set
    entry_date = target_entry_date,
    challenge_day = target_challenge_day,
    note = coalesce(target_note, ''),
    win = coalesce(target_win, ''),
    prayer = coalesce(target_prayer, ''),
    mood = coalesce(target_mood, ''),
    energy = coalesce(target_energy, '')
  where entry.id = target_entry_id
    and entry.user_id = caller_id
  returning entry.* into saved_row;

  if not found then
    raise exception 'This journal entry is no longer available.' using errcode = '42501';
  end if;
  return pg_catalog.to_jsonb(saved_row);
end;
$$;

drop policy if exists "Users can insert own journal entries" on public.journal_entries;
create policy "Users can insert own journal entries"
  on public.journal_entries
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and entry_date <= public.journal_current_user_date()
  );

drop policy if exists "Users can update own journal entries" on public.journal_entries;
create policy "Users can update own journal entries"
  on public.journal_entries
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  )
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and entry_date <= public.journal_current_user_date()
  );

revoke all on function private.journal_effective_time_zone(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.journal_user_date(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_journal_entry_date()
  from public, anon, authenticated, service_role;

revoke all on function public.journal_current_user_date()
  from public, anon, authenticated, service_role;
revoke all on function public.get_journal_date_policy(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.create_journal_entry(date, integer, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.update_journal_entry(uuid, date, integer, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.journal_current_user_date() to authenticated;
grant execute on function public.get_journal_date_policy(uuid) to authenticated;
grant execute on function public.create_journal_entry(date, integer, text, text, text, text, text, uuid)
  to authenticated;
grant execute on function public.update_journal_entry(uuid, date, integer, text, text, text, text, text, uuid)
  to authenticated;

comment on function public.get_journal_date_policy(uuid) is
  'Returns the authenticated member effective timezone and current local date for journal UI limits.';
comment on trigger enforce_journal_entry_date on public.journal_entries is
  'Rejects future-dated inserts and updates without rewriting pre-existing rows.';
