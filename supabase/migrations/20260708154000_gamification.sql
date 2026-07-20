begin;

alter table public.check_ins
  add column if not exists completed text[] not null default '{}',
  add column if not exists workout_difficulty jsonb not null default '{}'::jsonb,
  add column if not exists points_awarded integer not null default 0;

alter table public.community_feed_items
  add column if not exists points_awarded integer not null default 0;

create table if not exists public.badge_definitions (
  badge_key text primary key,
  name text not null,
  description text not null default '',
  category text not null default 'challenge',
  tier text not null default 'bronze',
  icon text not null default 'shield',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.user_badges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_key text not null references public.badge_definitions(badge_key) on delete cascade,
  earned_at timestamptz not null default now(),
  earned_date date not null default current_date,
  metadata jsonb not null default '{}'::jsonb,
  unique (user_id, badge_key)
);

create table if not exists public.user_game_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  total_points integer not null default 0,
  challenge_points integer not null default 0,
  current_app_streak integer not null default 0,
  best_app_streak integer not null default 0,
  current_full_day_streak integer not null default 0,
  best_full_day_streak integer not null default 0,
  last_seen_date date,
  last_full_day_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_point_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  points integer not null,
  entry_date date,
  challenge_day integer,
  crew_id uuid references public.crews(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists check_ins_user_status_date_idx
  on public.check_ins (user_id, status, entry_date desc);

create index if not exists user_badges_user_earned_idx
  on public.user_badges (user_id, earned_at desc);

create index if not exists game_point_events_user_created_idx
  on public.game_point_events (user_id, created_at desc);

create index if not exists game_point_events_created_idx
  on public.game_point_events (created_at desc);

create index if not exists game_point_events_crew_created_idx
  on public.game_point_events (crew_id, created_at desc);

insert into public.badge_definitions (badge_key, name, description, category, tier, icon, sort_order)
values
  ('faithful_start', 'Faithful Start', 'Posted the first honest check-in and started the record.', 'challenge', 'bronze', 'shield', 10),
  ('honest_partial', 'Honest Standard', 'Posted a partial day instead of hiding the work.', 'challenge', 'bronze', 'check', 20),
  ('first_sweat', 'First Sweat', 'Completed a workout marked easy and kept the body in the fight.', 'workout', 'bronze', 'spark', 25),
  ('steady_grind', 'Steady Grind', 'Completed a workout marked medium and held the line.', 'workout', 'bronze', 'flame', 28),
  ('iron_standard', 'Iron Standard', 'Completed all seven daily actions in one day.', 'challenge', 'silver', 'dumbbell', 30),
  ('hard_path', 'Hard Path', 'Completed a workout marked hard.', 'workout', 'silver', 'run', 40),
  ('extreme_fire', 'Extreme Fire', 'Completed a workout marked extreme.', 'workout', 'gold', 'flame', 50),
  ('streak_flame', 'Streak Flame', 'Held a three-day full-standard streak.', 'streak', 'silver', 'flame', 60),
  ('seven_sealed', 'Seven Sealed', 'Held a seven-day full-standard streak.', 'streak', 'gold', 'repeat', 70),
  ('morning_watch', 'Morning Watch', 'Opened the app three days in a row.', 'presence', 'bronze', 'eye', 80),
  ('watchman_week', 'Watchman Week', 'Opened the app seven days in a row.', 'presence', 'silver', 'eye', 90),
  ('day_77_finisher', 'Day 77 Finisher', 'Finished the final day of the 77-day challenge.', 'challenge', 'gold', 'crown', 100)
on conflict (badge_key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  tier = excluded.tier,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

drop trigger if exists set_user_game_stats_updated_at on public.user_game_stats;
create trigger set_user_game_stats_updated_at
  before update on public.user_game_stats
  for each row execute function public.set_updated_at();

create or replace function public.ensure_user_game_stats(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_game_stats (user_id)
  values (target_user_id)
  on conflict (user_id) do nothing;
end;
$$;

create or replace function public.award_badge(
  target_user_id uuid,
  target_badge_key text,
  target_earned_date date default current_date,
  target_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_badges (user_id, badge_key, earned_date, metadata)
  values (target_user_id, target_badge_key, target_earned_date, target_metadata)
  on conflict (user_id, badge_key) do nothing;

  return found;
end;
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
  inserted_points boolean := false;
  resolved_idempotency_key text := coalesce(
    target_idempotency_key,
    target_event_type || ':' || target_user_id::text || ':' || coalesce(target_entry_date::text, current_date::text)
  );
begin
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
    greatest(target_points, 0),
    target_entry_date,
    target_challenge_day,
    target_crew_id,
    target_metadata,
    resolved_idempotency_key
  )
  on conflict (user_id, idempotency_key) do nothing;

  inserted_points := found;

  if inserted_points then
    update public.user_game_stats
    set
      total_points = total_points + greatest(target_points, 0),
      challenge_points = challenge_points + greatest(target_points, 0),
      updated_at = now()
    where user_id = target_user_id;
  end if;

  return inserted_points;
end;
$$;

create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case lower(coalesce(target_difficulty, 'medium'))
    when 'easy' then 2
    when 'medium' then 5
    when 'hard' then 10
    when 'extreme' then 15
    else 5
  end;
$$;

create or replace function public.full_streak_bonus_points(target_streak integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case target_streak
    when 3 then 25
    when 7 then 75
    when 14 then 150
    when 30 then 300
    when 77 then 777
    else 0
  end;
$$;

create or replace function public.process_check_in_game_rewards()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_points integer := 0;
  bonus_points integer := 0;
  workout_points integer := 0;
  total_points integer := 0;
  difficulty_one text := coalesce(new.workout_difficulty ->> 'one', 'medium');
  difficulty_two text := coalesce(new.workout_difficulty ->> 'two', 'medium');
  points_inserted boolean := false;
  stats_row public.user_game_stats%rowtype;
  next_full_streak integer := 0;
  streak_bonus integer := 0;
begin
  if cardinality(new.completed) > 0 then
    new.completed_count := cardinality(new.completed);
  end if;

  action_points := greatest(new.completed_count, 0) * 10;
  if new.status = 'complete' then
    bonus_points := 30;
  elsif new.status = 'partial' then
    bonus_points := 10;
  elsif new.status = 'scheduled' then
    bonus_points := 15;
  end if;

  if 'workoutOne' = any(new.completed) then
    workout_points := workout_points + public.workout_difficulty_points(difficulty_one);
  end if;

  if 'workoutTwo' = any(new.completed) then
    workout_points := workout_points + public.workout_difficulty_points(difficulty_two);
  end if;

  total_points := action_points + bonus_points + workout_points;
  points_inserted := public.add_game_points(
    new.user_id,
    'check_in',
    total_points,
    new.entry_date,
    new.challenge_day,
    null,
    jsonb_build_object(
      'status', new.status,
      'completedCount', new.completed_count,
      'completed', new.completed,
      'workoutDifficulty', new.workout_difficulty,
      'actionPoints', action_points,
      'bonusPoints', bonus_points,
      'workoutPoints', workout_points
    ),
    'checkin:' || new.user_id::text || ':' || new.entry_date::text
  );

  new.points_awarded := case when points_inserted then total_points else 0 end;

  if not points_inserted then
    return new;
  end if;

  perform public.award_badge(new.user_id, 'faithful_start', new.entry_date, jsonb_build_object('challengeDay', new.challenge_day));

  if new.status = 'partial' then
    perform public.award_badge(new.user_id, 'honest_partial', new.entry_date, jsonb_build_object('completedCount', new.completed_count));
  end if;

  if ('workoutOne' = any(new.completed) and difficulty_one = 'easy')
    or ('workoutTwo' = any(new.completed) and difficulty_two = 'easy') then
    perform public.award_badge(new.user_id, 'first_sweat', new.entry_date, new.workout_difficulty);
  end if;

  if ('workoutOne' = any(new.completed) and difficulty_one = 'medium')
    or ('workoutTwo' = any(new.completed) and difficulty_two = 'medium') then
    perform public.award_badge(new.user_id, 'steady_grind', new.entry_date, new.workout_difficulty);
  end if;

  if ('workoutOne' = any(new.completed) and difficulty_one = 'hard')
    or ('workoutTwo' = any(new.completed) and difficulty_two = 'hard') then
    perform public.award_badge(new.user_id, 'hard_path', new.entry_date, new.workout_difficulty);
  end if;

  if ('workoutOne' = any(new.completed) and difficulty_one = 'extreme')
    or ('workoutTwo' = any(new.completed) and difficulty_two = 'extreme') then
    perform public.award_badge(new.user_id, 'extreme_fire', new.entry_date, new.workout_difficulty);
  end if;

  if new.status = 'complete' then
    perform public.award_badge(new.user_id, 'iron_standard', new.entry_date, jsonb_build_object('challengeDay', new.challenge_day));

    select * into stats_row
    from public.user_game_stats
    where user_id = new.user_id
    for update;

    if stats_row.last_full_day_date = new.entry_date then
      next_full_streak := stats_row.current_full_day_streak;
    elsif stats_row.last_full_day_date = new.entry_date - 1 then
      next_full_streak := stats_row.current_full_day_streak + 1;
    else
      next_full_streak := 1;
    end if;

    update public.user_game_stats
    set
      current_full_day_streak = next_full_streak,
      best_full_day_streak = greatest(best_full_day_streak, next_full_streak),
      last_full_day_date = new.entry_date,
      updated_at = now()
    where user_id = new.user_id;

    if next_full_streak >= 3 then
      perform public.award_badge(new.user_id, 'streak_flame', new.entry_date, jsonb_build_object('streak', next_full_streak));
    end if;
    if next_full_streak >= 7 then
      perform public.award_badge(new.user_id, 'seven_sealed', new.entry_date, jsonb_build_object('streak', next_full_streak));
    end if;
    if new.challenge_day >= 77 then
      perform public.award_badge(new.user_id, 'day_77_finisher', new.entry_date, jsonb_build_object('challengeDay', new.challenge_day));
    end if;

    streak_bonus := public.full_streak_bonus_points(next_full_streak);
    if streak_bonus > 0 then
      perform public.add_game_points(
        new.user_id,
        'full_day_streak_bonus',
        streak_bonus,
        new.entry_date,
        new.challenge_day,
        null,
        jsonb_build_object('streak', next_full_streak),
        'fullstreak:' || new.user_id::text || ':' || next_full_streak::text
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists process_check_in_game_rewards_before_insert on public.check_ins;
create trigger process_check_in_game_rewards_before_insert
  before insert on public.check_ins
  for each row execute function public.process_check_in_game_rewards();

create or replace function public.create_community_feed_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  feed_name text;
begin
  select coalesce(nullif(name, ''), 'Member')
    into feed_name
    from public.profiles
    where user_id = new.user_id;

  insert into public.community_feed_items (
    check_in_id,
    user_id,
    display_name,
    challenge_day,
    status,
    completed_count,
    points_awarded,
    created_at
  ) values (
    new.id,
    new.user_id,
    coalesce(feed_name, 'Member'),
    new.challenge_day,
    new.status,
    new.completed_count,
    new.points_awarded,
    new.created_at
  )
  on conflict (check_in_id) do nothing;

  return new;
end;
$$;

drop trigger if exists create_community_feed_item_on_check_in on public.check_ins;
create trigger create_community_feed_item_on_check_in
  after insert on public.check_ins
  for each row execute function public.create_community_feed_item();

create or replace function public.record_app_visit()
returns table (
  total_points integer,
  current_app_streak integer,
  best_app_streak integer,
  new_badges jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  today date := current_date;
  stats_row public.user_game_stats%rowtype;
  next_app_streak integer := 1;
  bonus_points integer := 0;
  awarded_badges jsonb := '[]'::jsonb;
begin
  if current_user_id is null then
    raise exception 'You need to log in to record app activity.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to record app activity.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);

  select * into stats_row
  from public.user_game_stats
  where user_id = current_user_id
  for update;

  if stats_row.last_seen_date = today then
    return query
      select
        stats_row.total_points,
        stats_row.current_app_streak,
        stats_row.best_app_streak,
        awarded_badges;
    return;
  end if;

  if stats_row.last_seen_date = today - 1 then
    next_app_streak := stats_row.current_app_streak + 1;
  else
    next_app_streak := 1;
  end if;

  update public.user_game_stats as game_stats
  set
    current_app_streak = next_app_streak,
    best_app_streak = greatest(game_stats.best_app_streak, next_app_streak),
    last_seen_date = today,
    updated_at = now()
  where game_stats.user_id = current_user_id;

  perform public.add_game_points(
    current_user_id,
    'app_visit',
    5,
    today,
    null,
    null,
    jsonb_build_object('appStreak', next_app_streak),
    'appvisit:' || current_user_id::text || ':' || today::text
  );

  bonus_points := public.full_streak_bonus_points(next_app_streak);
  if bonus_points > 0 then
    perform public.add_game_points(
      current_user_id,
      'app_streak_bonus',
      bonus_points,
      today,
      null,
      null,
      jsonb_build_object('appStreak', next_app_streak),
      'appstreak:' || current_user_id::text || ':' || next_app_streak::text
    );
  end if;

  if next_app_streak >= 3 and public.award_badge(current_user_id, 'morning_watch', today, jsonb_build_object('appStreak', next_app_streak)) then
    awarded_badges := awarded_badges || jsonb_build_array('morning_watch');
  end if;

  if next_app_streak >= 7 and public.award_badge(current_user_id, 'watchman_week', today, jsonb_build_object('appStreak', next_app_streak)) then
    awarded_badges := awarded_badges || jsonb_build_array('watchman_week');
  end if;

  select * into stats_row
  from public.user_game_stats
  where user_id = current_user_id;

  return query
    select
      stats_row.total_points,
      stats_row.current_app_streak,
      stats_row.best_app_streak,
      awarded_badges;
end;
$$;

create or replace function public.get_global_leaderboard(target_window text default 'week')
returns table (
  rank_position bigint,
  user_id uuid,
  display_name text,
  points integer,
  current_app_streak integer,
  badges jsonb,
  latest_challenge_day integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  starts_at timestamptz := case when target_window = 'challenge' then '-infinity'::timestamptz else date_trunc('week', now()) end;
begin
  if current_user_id is null then
    raise exception 'You need to log in to view the leaderboard.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to view the leaderboard.';
  end if;

  return query
    with point_totals as (
      select
        g.user_id as leader_user_id,
        sum(g.points)::integer as points
      from public.game_point_events g
      where g.created_at >= starts_at
      group by g.user_id
    )
    select
      row_number() over (order by pt.points desc, coalesce(nullif(p.name, ''), 'Member') asc) as rank_position,
      pt.leader_user_id as user_id,
      coalesce(nullif(p.name, ''), 'Member') as display_name,
      pt.points,
      coalesce(s.current_app_streak, 0) as current_app_streak,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', recent.badge_key,
          'name', bd.name,
          'tier', bd.tier,
          'icon', bd.icon
        ) order by recent.earned_at desc)
        from (
          select ub.badge_key, ub.earned_at
          from public.user_badges ub
          where ub.user_id = pt.leader_user_id
          order by ub.earned_at desc
          limit 3
        ) recent
        join public.badge_definitions bd on bd.badge_key = recent.badge_key
      ), '[]'::jsonb) as badges,
      coalesce((
        select max(c.challenge_day)
        from public.check_ins c
        where c.user_id = pt.leader_user_id
      ), 0) as latest_challenge_day
    from point_totals pt
    left join public.profiles p on p.user_id = pt.leader_user_id
    left join public.user_game_stats s on s.user_id = pt.leader_user_id
    order by pt.points desc, coalesce(nullif(p.name, ''), 'Member') asc
    limit 25;
end;
$$;

create or replace function public.get_crew_leaderboard(target_crew_id uuid, target_window text default 'week')
returns table (
  rank_position bigint,
  user_id uuid,
  display_name text,
  points integer,
  current_app_streak integer,
  badges jsonb,
  latest_challenge_day integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  starts_at timestamptz := case when target_window = 'challenge' then '-infinity'::timestamptz else date_trunc('week', now()) end;
begin
  if current_user_id is null then
    raise exception 'You need to log in to view the crew leaderboard.';
  end if;

  if not public.has_active_entitlement('membership_active') or not public.is_crew_member(target_crew_id) then
    raise exception 'Crew membership is required to view this leaderboard.';
  end if;

  return query
    with point_totals as (
      select
        cm.user_id as leader_user_id,
        coalesce(sum(g.points), 0)::integer as points
      from public.crew_members cm
      left join public.game_point_events g
        on g.user_id = cm.user_id
        and g.created_at >= starts_at
      where cm.crew_id = target_crew_id
      group by cm.user_id
    )
    select
      row_number() over (order by pt.points desc, coalesce(nullif(p.name, ''), 'Member') asc) as rank_position,
      pt.leader_user_id as user_id,
      coalesce(nullif(p.name, ''), 'Member') as display_name,
      pt.points,
      coalesce(s.current_app_streak, 0) as current_app_streak,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', recent.badge_key,
          'name', bd.name,
          'tier', bd.tier,
          'icon', bd.icon
        ) order by recent.earned_at desc)
        from (
          select ub.badge_key, ub.earned_at
          from public.user_badges ub
          where ub.user_id = pt.leader_user_id
          order by ub.earned_at desc
          limit 3
        ) recent
        join public.badge_definitions bd on bd.badge_key = recent.badge_key
      ), '[]'::jsonb) as badges,
      coalesce((
        select max(c.challenge_day)
        from public.check_ins c
        where c.user_id = pt.leader_user_id
      ), 0) as latest_challenge_day
    from point_totals pt
    left join public.profiles p on p.user_id = pt.leader_user_id
    left join public.user_game_stats s on s.user_id = pt.leader_user_id
    order by pt.points desc, coalesce(nullif(p.name, ''), 'Member') asc
    limit 25;
end;
$$;

revoke execute on function public.ensure_user_game_stats(uuid) from public;
revoke execute on function public.ensure_user_game_stats(uuid) from anon;
revoke execute on function public.ensure_user_game_stats(uuid) from authenticated;
revoke execute on function public.award_badge(uuid, text, date, jsonb) from public;
revoke execute on function public.award_badge(uuid, text, date, jsonb) from anon;
revoke execute on function public.award_badge(uuid, text, date, jsonb) from authenticated;
revoke execute on function public.add_game_points(uuid, text, integer, date, integer, uuid, jsonb, text) from public;
revoke execute on function public.add_game_points(uuid, text, integer, date, integer, uuid, jsonb, text) from anon;
revoke execute on function public.add_game_points(uuid, text, integer, date, integer, uuid, jsonb, text) from authenticated;
revoke execute on function public.process_check_in_game_rewards() from public;
revoke execute on function public.process_check_in_game_rewards() from anon;
revoke execute on function public.process_check_in_game_rewards() from authenticated;
revoke execute on function public.record_app_visit() from public;
revoke execute on function public.record_app_visit() from anon;
grant execute on function public.record_app_visit() to authenticated;
revoke execute on function public.get_global_leaderboard(text) from public;
revoke execute on function public.get_global_leaderboard(text) from anon;
grant execute on function public.get_global_leaderboard(text) to authenticated;
revoke execute on function public.get_crew_leaderboard(uuid, text) from public;
revoke execute on function public.get_crew_leaderboard(uuid, text) from anon;
grant execute on function public.get_crew_leaderboard(uuid, text) to authenticated;

insert into public.community_feed_items (
  check_in_id,
  user_id,
  display_name,
  challenge_day,
  status,
  completed_count,
  points_awarded,
  created_at
)
select
  c.id,
  c.user_id,
  coalesce(nullif(p.name, ''), 'Member') as display_name,
  c.challenge_day,
  c.status,
  c.completed_count,
  c.points_awarded,
  c.created_at
from public.check_ins c
left join public.profiles p on p.user_id = c.user_id
on conflict (check_in_id) do nothing;

alter table public.badge_definitions enable row level security;
alter table public.user_badges enable row level security;
alter table public.user_game_stats enable row level security;
alter table public.game_point_events enable row level security;

drop policy if exists "Authenticated users can read badge definitions" on public.badge_definitions;
create policy "Authenticated users can read badge definitions"
  on public.badge_definitions
  for select
  to authenticated
  using (public.has_active_entitlement('membership_active'));

drop policy if exists "Users can read own badges" on public.user_badges;
create policy "Users can read own badges"
  on public.user_badges
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own game stats" on public.user_game_stats;
create policy "Users can read own game stats"
  on public.user_game_stats
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own point events" on public.game_point_events;
create policy "Users can read own point events"
  on public.game_point_events
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own check ins" on public.check_ins;
create policy "Users can read own check ins"
  on public.check_ins
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

revoke all on public.badge_definitions from anon;
revoke all on public.badge_definitions from authenticated;
revoke all on public.user_badges from anon;
revoke all on public.user_badges from authenticated;
revoke all on public.user_game_stats from anon;
revoke all on public.user_game_stats from authenticated;
revoke all on public.game_point_events from anon;
revoke all on public.game_point_events from authenticated;

grant select (id, user_id, challenge_day, status, completed_count, points_awarded, created_at)
  on public.check_ins to authenticated;
grant select (id, display_name, challenge_day, status, completed_count, points_awarded, created_at)
  on public.community_feed_items to authenticated;
grant select on public.badge_definitions to authenticated;
grant select on public.user_badges to authenticated;
grant select on public.user_game_stats to authenticated;
grant select on public.game_point_events to authenticated;

commit;
