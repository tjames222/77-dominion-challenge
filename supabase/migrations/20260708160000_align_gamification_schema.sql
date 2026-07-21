begin;

-- The original gamification migration predated the canonical schema changes
-- committed with it. Align those shapes before later migrations refer to
-- user_badges.entry_date and the globally idempotent point ledger.
alter table public.badge_definitions
  alter column description drop default,
  alter column category drop default;

alter table public.user_badges
  add column if not exists entry_date date;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_badges'
      and column_name = 'earned_date'
  ) then
    execute 'update public.user_badges set entry_date = earned_date where entry_date is null';
  end if;
end;
$$;

alter table public.user_badges
  drop constraint if exists user_badges_pkey,
  drop constraint if exists user_badges_user_id_badge_key_key,
  drop column if exists id,
  drop column if exists earned_date;

alter table public.user_badges
  add constraint user_badges_pkey primary key (user_id, badge_key);

alter table public.user_game_stats
  drop column if exists created_at;

alter table public.game_point_events
  drop constraint if exists game_point_events_user_id_idempotency_key_key,
  drop constraint if exists game_point_events_idempotency_key_key,
  drop constraint if exists game_point_events_points_check;

alter table public.game_point_events
  add constraint game_point_events_idempotency_key_key unique (idempotency_key),
  add constraint game_point_events_points_check check (points >= 0);

create or replace function public.ensure_user_game_stats(target_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.user_game_stats (user_id)
  values (target_user_id)
  on conflict (user_id) do nothing;
$$;

create or replace function public.add_game_points(
  target_user_id uuid,
  target_event_type text,
  target_points integer,
  target_entry_date date default null,
  target_challenge_day integer default null,
  target_crew_id uuid default null,
  target_metadata jsonb default '{}'::jsonb,
  target_idempotency_key text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
begin
  if target_points <= 0 then
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
  )
  values (
    target_user_id,
    target_event_type,
    target_points,
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
    total_points = total_points + target_points,
    challenge_points = challenge_points + target_points,
    updated_at = now()
  where user_id = target_user_id;

  return true;
end;
$$;

commit;
