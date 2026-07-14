create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'Member',
  email text not null default '',
  avatar_url text not null default '',
  challenge_start_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.challenge_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  completed text[] not null default '{}',
  scheduled_miss boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_date)
);

create table if not exists public.check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  challenge_day integer not null check (challenge_day between 1 and 77),
  status text not null check (status in ('complete', 'partial', 'scheduled')),
  completed_count integer not null default 0,
  completed text[] not null default '{}',
  workout_difficulty jsonb not null default '{}'::jsonb,
  points_awarded integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.check_ins
  add column if not exists completed text[] not null default '{}',
  add column if not exists workout_difficulty jsonb not null default '{}'::jsonb,
  add column if not exists points_awarded integer not null default 0;

create table if not exists public.workout_difficulty_point_values (
  difficulty text primary key check (difficulty in ('easy', 'medium', 'hard', 'extreme')),
  points integer not null check (points >= 0),
  updated_at timestamptz not null default now()
);

insert into public.workout_difficulty_point_values (difficulty, points)
values
  ('easy', 2),
  ('medium', 5),
  ('hard', 10),
  ('extreme', 15)
on conflict (difficulty) do nothing;

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop table if exists public.purchases cascade;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null check (product_key in ('dominion_membership')),
  status text not null,
  stripe_customer_id text,
  stripe_subscription_id text not null unique,
  stripe_price_id text,
  cancel_at_period_end boolean not null default false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  entitlement_key text not null check (entitlement_key in ('membership_active')),
  status text not null check (status in ('active', 'inactive', 'revoked', 'expired')) default 'inactive',
  source_type text not null,
  source_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement_key)
);

delete from public.entitlements
where entitlement_key <> 'membership_active';

alter table public.entitlements
  drop constraint if exists entitlements_entitlement_key_check;

alter table public.entitlements
  add constraint entitlements_entitlement_key_check
  check (entitlement_key in ('membership_active'));

drop view if exists public.community_feed;

create table if not exists public.community_feed_items (
  id uuid primary key default gen_random_uuid(),
  check_in_id uuid not null unique references public.check_ins(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  challenge_day integer not null,
  status text not null check (status in ('complete', 'partial', 'scheduled')),
  completed_count integer not null default 0,
  points_awarded integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.community_feed_items
  add column if not exists points_awarded integer not null default 0;

create table if not exists public.crews (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text not null default '',
  challenge_start_date date,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crew_members (
  crew_id uuid not null references public.crews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);

create table if not exists public.crew_invites (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  crew_id uuid references public.crews(id) on delete cascade,
  scope text not null check (scope in ('crew', 'global')),
  body text not null check (char_length(trim(body)) between 1 and 2000),
  post_type text not null default 'message' check (post_type in ('message', 'prayer', 'encouragement', 'check_in')),
  challenge_day integer,
  status text check (status is null or status in ('complete', 'partial', 'scheduled')),
  completed_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'crew' and crew_id is not null)
    or (scope = 'global' and crew_id is null)
  )
);

create table if not exists public.post_likes (
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  challenge_day integer,
  note text not null default '',
  win text not null default '',
  prayer text not null default '',
  mood text not null default '',
  energy text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, entry_date)
);

create table if not exists public.journal_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  journal_entry_id uuid references public.journal_entries(id) on delete cascade,
  storage_path text not null,
  caption text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.badge_definitions (
  badge_key text primary key,
  name text not null,
  description text not null,
  category text not null,
  tier text not null default 'bronze',
  icon text not null default 'shield',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.user_badges (
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_key text not null references public.badge_definitions(badge_key) on delete cascade,
  earned_at timestamptz not null default now(),
  entry_date date,
  metadata jsonb not null default '{}'::jsonb,
  primary key (user_id, badge_key)
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
  updated_at timestamptz not null default now()
);

create table if not exists public.game_point_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  points integer not null check (points >= 0),
  entry_date date,
  challenge_day integer,
  crew_id uuid references public.crews(id) on delete set null,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists challenge_entries_user_date_idx
  on public.challenge_entries (user_id, entry_date desc);

create index if not exists check_ins_created_at_idx
  on public.check_ins (created_at desc);

create index if not exists check_ins_user_date_idx
  on public.check_ins (user_id, entry_date desc);

create index if not exists check_ins_user_status_date_idx
  on public.check_ins (user_id, status, entry_date desc);

create index if not exists subscriptions_user_created_at_idx
  on public.subscriptions (user_id, created_at desc);

create index if not exists entitlements_user_status_idx
  on public.entitlements (user_id, status);

create index if not exists community_feed_items_created_at_idx
  on public.community_feed_items (created_at desc);

create index if not exists community_feed_items_user_created_at_idx
  on public.community_feed_items (user_id, created_at desc);

create index if not exists crews_created_by_idx
  on public.crews (created_by, created_at desc);

create index if not exists crew_members_user_idx
  on public.crew_members (user_id, joined_at desc);

create index if not exists crew_invites_crew_idx
  on public.crew_invites (crew_id, created_at desc);

create index if not exists community_posts_scope_created_at_idx
  on public.community_posts (scope, created_at desc);

create index if not exists community_posts_crew_created_at_idx
  on public.community_posts (crew_id, created_at desc);

create index if not exists post_comments_post_created_at_idx
  on public.post_comments (post_id, created_at asc);

create index if not exists journal_entries_user_date_idx
  on public.journal_entries (user_id, entry_date desc);

create index if not exists journal_photos_user_created_at_idx
  on public.journal_photos (user_id, created_at desc);

create index if not exists user_badges_user_earned_idx
  on public.user_badges (user_id, earned_at desc);

create unique index if not exists user_badges_user_entry_date_unique
  on public.user_badges (user_id, entry_date)
  where entry_date is not null;

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
  ('seven_day_start', 'Seven-Day Start', 'Reached the first seven days of the challenge.', 'milestone', 'bronze', 'calendar', 55),
  ('streak_flame', 'Streak Flame', 'Held a three-day full-standard streak.', 'streak', 'silver', 'flame', 60),
  ('seven_sealed', 'Seven Sealed', 'Held a seven-day full-standard streak.', 'streak', 'gold', 'repeat', 70),
  ('full_streak_14', '14-Day Full Streak', 'Held a fourteen-day full-standard streak.', 'streak', 'silver', 'shield', 101),
  ('full_streak_21', '21-Day Full Streak', 'Held a twenty-one-day full-standard streak.', 'streak', 'silver', 'target', 102),
  ('full_streak_28', '28-Day Full Streak', 'Held a twenty-eight-day full-standard streak.', 'streak', 'silver', 'dumbbell', 103),
  ('full_streak_35', '35-Day Full Streak', 'Held a thirty-five-day full-standard streak.', 'streak', 'gold', 'flame', 104),
  ('full_streak_42', '42-Day Full Streak', 'Held a forty-two-day full-standard streak.', 'streak', 'gold', 'eye', 105),
  ('full_streak_49', '49-Day Full Streak', 'Held a forty-nine-day full-standard streak.', 'streak', 'gold', 'repeat', 106),
  ('full_streak_56', '56-Day Full Streak', 'Held a fifty-six-day full-standard streak.', 'streak', 'gold', 'mountain', 107),
  ('full_streak_63', '63-Day Full Streak', 'Held a sixty-three-day full-standard streak.', 'streak', 'gold', 'star', 108),
  ('full_streak_70', '70-Day Full Streak', 'Held a seventy-day full-standard streak.', 'streak', 'gold', 'flag', 109),
  ('two_week_guard', 'Two-Week Guard', 'Reached day 14 with the standard still in sight.', 'milestone', 'silver', 'shield', 72),
  ('three_week_wall', 'Three-Week Wall', 'Reached day 21 and pushed through the early wall.', 'milestone', 'silver', 'target', 74),
  ('third_way', 'One-Third Dominion', 'Crossed one-third of the 77-day challenge.', 'milestone', 'gold', 'flag', 76),
  ('deep_roots', 'Deep Roots', 'Reached day 33 with deeper habits forming.', 'milestone', 'silver', 'mountain', 78),
  ('halfway_fire', 'Halfway Fire', 'Crossed the halfway point of the 77-day challenge.', 'milestone', 'gold', 'spark', 80),
  ('fifty_faithful', 'Fifty Faithful', 'Reached day 50 with faithful momentum.', 'milestone', 'silver', 'star', 84),
  ('sixty_strong', 'Sixty Strong', 'Reached day 60 and kept showing up.', 'milestone', 'gold', 'dumbbell', 88),
  ('final_watch', 'Final Watch', 'Reached day 70 and entered the final stretch.', 'milestone', 'gold', 'eye', 92),
  ('morning_watch', 'Morning Watch', 'Opened the app three days in a row.', 'presence', 'bronze', 'eye', 94),
  ('watchman_week', 'Watchman Week', 'Opened the app seven days in a row.', 'presence', 'silver', 'eye', 96),
  ('day_77_finisher', '77-Day Finisher', 'Finished the final day of the 77-day challenge.', 'challenge', 'gold', 'crown', 100)
on conflict (badge_key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  tier = excluded.tier,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_challenge_entries_updated_at on public.challenge_entries;
create trigger set_challenge_entries_updated_at
  before update on public.challenge_entries
  for each row execute function public.set_updated_at();

drop trigger if exists set_workout_difficulty_point_values_updated_at on public.workout_difficulty_point_values;
create trigger set_workout_difficulty_point_values_updated_at
  before update on public.workout_difficulty_point_values
  for each row execute function public.set_updated_at();

drop trigger if exists set_billing_customers_updated_at on public.billing_customers;
create trigger set_billing_customers_updated_at
  before update on public.billing_customers
  for each row execute function public.set_updated_at();

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists set_entitlements_updated_at on public.entitlements;
create trigger set_entitlements_updated_at
  before update on public.entitlements
  for each row execute function public.set_updated_at();

drop trigger if exists set_user_game_stats_updated_at on public.user_game_stats;
create trigger set_user_game_stats_updated_at
  before update on public.user_game_stats
  for each row execute function public.set_updated_at();

drop trigger if exists set_crews_updated_at on public.crews;
create trigger set_crews_updated_at
  before update on public.crews
  for each row execute function public.set_updated_at();

drop trigger if exists set_community_posts_updated_at on public.community_posts;
create trigger set_community_posts_updated_at
  before update on public.community_posts
  for each row execute function public.set_updated_at();

drop trigger if exists set_post_comments_updated_at on public.post_comments;
create trigger set_post_comments_updated_at
  before update on public.post_comments
  for each row execute function public.set_updated_at();

drop trigger if exists set_journal_entries_updated_at on public.journal_entries;
create trigger set_journal_entries_updated_at
  before update on public.journal_entries
  for each row execute function public.set_updated_at();

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

create or replace function public.award_badge(
  target_user_id uuid,
  target_badge_key text,
  target_entry_date date default null,
  target_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_key text;
begin
  if target_entry_date is not null and exists (
    select 1
    from public.user_badges
    where user_id = target_user_id
      and entry_date = target_entry_date
  ) then
    return false;
  end if;

  insert into public.user_badges (user_id, badge_key, entry_date, metadata)
  values (target_user_id, target_badge_key, target_entry_date, target_metadata)
  on conflict do nothing
  returning badge_key into inserted_key;

  return inserted_key is not null;
end;
$$;

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

create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(
    (
      select config.points
      from public.workout_difficulty_point_values config
      where config.difficulty = lower(btrim(coalesce(target_difficulty, 'medium')))
    ),
    (
      select config.points
      from public.workout_difficulty_point_values config
      where config.difficulty = 'medium'
    ),
    0
  );
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
  selected_badge_key text := null;
  selected_badge_metadata jsonb := '{}'::jsonb;
begin
  if new.challenge_day < 1 or new.challenge_day > 77 then
    raise exception 'The 77-day challenge is complete.';
  end if;

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

  if new.status = 'complete' then
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

  select * into stats_row
  from public.user_game_stats
  where user_id = new.user_id;

  if not exists (
    select 1
    from public.user_badges
    where user_id = new.user_id
      and entry_date = new.entry_date
  ) then
    if new.status = 'complete' then
      if new.challenge_day >= 77 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'day_77_finisher') then
        selected_badge_key := 'day_77_finisher';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 70 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'final_watch') then
        selected_badge_key := 'final_watch';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 60 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'sixty_strong') then
        selected_badge_key := 'sixty_strong';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 50 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'fifty_faithful') then
        selected_badge_key := 'fifty_faithful';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 39 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'halfway_fire') then
        selected_badge_key := 'halfway_fire';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 33 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'deep_roots') then
        selected_badge_key := 'deep_roots';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 26 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'third_way') then
        selected_badge_key := 'third_way';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 21 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'three_week_wall') then
        selected_badge_key := 'three_week_wall';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 14 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'two_week_guard') then
        selected_badge_key := 'two_week_guard';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 7 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'seven_day_start') then
        selected_badge_key := 'seven_day_start';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif next_full_streak >= 70 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_70') then
        selected_badge_key := 'full_streak_70';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 63 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_63') then
        selected_badge_key := 'full_streak_63';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 56 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_56') then
        selected_badge_key := 'full_streak_56';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 49 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_49') then
        selected_badge_key := 'full_streak_49';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 42 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_42') then
        selected_badge_key := 'full_streak_42';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 35 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_35') then
        selected_badge_key := 'full_streak_35';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 28 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_28') then
        selected_badge_key := 'full_streak_28';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 21 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_21') then
        selected_badge_key := 'full_streak_21';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 14 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_14') then
        selected_badge_key := 'full_streak_14';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 7 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'seven_sealed') then
        selected_badge_key := 'seven_sealed';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 3 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'streak_flame') then
        selected_badge_key := 'streak_flame';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif coalesce(stats_row.current_app_streak, 0) >= 7 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'watchman_week') then
        selected_badge_key := 'watchman_week';
        selected_badge_metadata := jsonb_build_object('appStreak', stats_row.current_app_streak);
      elsif coalesce(stats_row.current_app_streak, 0) >= 3 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'morning_watch') then
        selected_badge_key := 'morning_watch';
        selected_badge_metadata := jsonb_build_object('appStreak', stats_row.current_app_streak);
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'extreme')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'extreme'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'extreme_fire') then
        selected_badge_key := 'extreme_fire';
        selected_badge_metadata := new.workout_difficulty;
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'hard')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'hard'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'hard_path') then
        selected_badge_key := 'hard_path';
        selected_badge_metadata := new.workout_difficulty;
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'medium')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'medium'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'steady_grind') then
        selected_badge_key := 'steady_grind';
        selected_badge_metadata := new.workout_difficulty;
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'easy')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'easy'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'first_sweat') then
        selected_badge_key := 'first_sweat';
        selected_badge_metadata := new.workout_difficulty;
      elsif not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'iron_standard') then
        selected_badge_key := 'iron_standard';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      end if;
    elsif new.status = 'partial' then
      if not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'honest_partial') then
        selected_badge_key := 'honest_partial';
        selected_badge_metadata := jsonb_build_object('completedCount', new.completed_count);
      end if;
    end if;

    if selected_badge_key is null and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'faithful_start') then
      selected_badge_key := 'faithful_start';
      selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
    end if;

    if selected_badge_key is not null then
      perform public.award_badge(new.user_id, selected_badge_key, new.entry_date, selected_badge_metadata);
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

create or replace function public.join_crew_by_invite(invite_token text)
returns table (
  crew_id uuid,
  name text,
  description text,
  challenge_start_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_crew_id uuid;
  member_name text;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to join this crew.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to join a crew.';
  end if;

  select ci.crew_id
    into target_crew_id
    from public.crew_invites ci
    where ci.token = invite_token
      and ci.revoked_at is null
      and ci.expires_at > now()
    limit 1;

  if target_crew_id is null then
    raise exception 'This invite link is invalid or expired.';
  end if;

  select coalesce(nullif(name, ''), 'Member')
    into member_name
    from public.profiles
    where user_id = auth.uid();

  insert into public.crew_members (crew_id, user_id, display_name, role)
  values (target_crew_id, auth.uid(), coalesce(member_name, 'Member'), 'member')
  on conflict (crew_id, user_id) do nothing;

  return query
    select c.id, c.name, c.description, c.challenge_start_date
    from public.crews c
    where c.id = target_crew_id;
end;
$$;

create or replace function public.is_crew_member(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crew_members cm
    where cm.crew_id = target_crew_id
      and cm.user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_crew(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crew_members cm
    where cm.crew_id = target_crew_id
      and cm.user_id = auth.uid()
      and cm.role in ('owner', 'admin')
  );
$$;

create or replace function public.has_active_entitlement(target_entitlement_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.entitlements e
    where e.user_id = auth.uid()
      and e.entitlement_key = target_entitlement_key
      and e.status = 'active'
      and (e.ends_at is null or e.ends_at > now())
  );
$$;

create or replace function public.can_read_community_post(target_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.community_posts cp
    where cp.id = target_post_id
      and public.has_active_entitlement('membership_active')
      and (
        cp.scope = 'global'
        or public.is_crew_member(cp.crew_id)
      )
  );
$$;

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

  update public.user_game_stats
  set
    current_app_streak = next_app_streak,
    best_app_streak = greatest(best_app_streak, next_app_streak),
    last_seen_date = today,
    updated_at = now()
  where user_id = current_user_id;

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

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;
revoke execute on function public.create_community_feed_item() from public;
revoke execute on function public.create_community_feed_item() from anon;
revoke execute on function public.create_community_feed_item() from authenticated;
revoke execute on function public.join_crew_by_invite(text) from public;
revoke execute on function public.join_crew_by_invite(text) from anon;
grant execute on function public.join_crew_by_invite(text) to authenticated;
revoke execute on function public.is_crew_member(uuid) from public;
revoke execute on function public.is_crew_member(uuid) from anon;
grant execute on function public.is_crew_member(uuid) to authenticated;
revoke execute on function public.can_manage_crew(uuid) from public;
revoke execute on function public.can_manage_crew(uuid) from anon;
grant execute on function public.can_manage_crew(uuid) to authenticated;
revoke execute on function public.has_active_entitlement(text) from public;
revoke execute on function public.has_active_entitlement(text) from anon;
grant execute on function public.has_active_entitlement(text) to authenticated;
revoke execute on function public.can_read_community_post(uuid) from public;
revoke execute on function public.can_read_community_post(uuid) from anon;
grant execute on function public.can_read_community_post(uuid) to authenticated;
revoke execute on function public.workout_difficulty_points(text) from public;
revoke execute on function public.workout_difficulty_points(text) from anon;
revoke execute on function public.workout_difficulty_points(text) from authenticated;
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

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public';
    execute 'revoke execute on function public.rls_auto_enable() from anon';
    execute 'revoke execute on function public.rls_auto_enable() from authenticated';
  end if;
end;
$$;

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

alter table public.profiles enable row level security;
alter table public.challenge_entries enable row level security;
alter table public.check_ins enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlements enable row level security;
alter table public.community_feed_items enable row level security;
alter table public.crews enable row level security;
alter table public.crew_members enable row level security;
alter table public.crew_invites enable row level security;
alter table public.community_posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_photos enable row level security;
alter table public.badge_definitions enable row level security;
alter table public.user_badges enable row level security;
alter table public.user_game_stats enable row level security;
alter table public.game_point_events enable row level security;
alter table public.workout_difficulty_point_values enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read own challenge entries" on public.challenge_entries;
create policy "Users can read own challenge entries"
  on public.challenge_entries
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can insert own challenge entries" on public.challenge_entries;
create policy "Users can insert own challenge entries"
  on public.challenge_entries
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can update own challenge entries" on public.challenge_entries;
create policy "Users can update own challenge entries"
  on public.challenge_entries
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  )
  with check (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can insert own check ins" on public.check_ins;
create policy "Users can insert own check ins"
  on public.check_ins
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can read own check ins" on public.check_ins;
create policy "Users can read own check ins"
  on public.check_ins
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can read own subscriptions" on public.subscriptions;
create policy "Users can read own subscriptions"
  on public.subscriptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own entitlements" on public.entitlements;
create policy "Users can read own entitlements"
  on public.entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Authenticated users can read workout difficulty point values"
  on public.workout_difficulty_point_values;
create policy "Authenticated users can read workout difficulty point values"
  on public.workout_difficulty_point_values
  for select
  to authenticated
  using (true);

drop policy if exists "Service role can update workout difficulty point values"
  on public.workout_difficulty_point_values;
create policy "Service role can update workout difficulty point values"
  on public.workout_difficulty_point_values
  for update
  to service_role
  using (true)
  with check (true);

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

drop policy if exists "Authenticated users can read community feed" on public.community_feed_items;
create policy "Authenticated users can read community feed"
  on public.community_feed_items
  for select
  to authenticated
  using (public.has_active_entitlement('membership_active'));

drop policy if exists "Users can insert own community feed items" on public.community_feed_items;
create policy "Users can insert own community feed items"
  on public.community_feed_items
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Crew members can read crews" on public.crews;
create policy "Crew members can read crews"
  on public.crews
  for select
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (public.is_crew_member(id) or created_by = (select auth.uid()))
  );

drop policy if exists "Users can create own crews" on public.crews;
create policy "Users can create own crews"
  on public.crews
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Crew admins can update crews" on public.crews;
create policy "Crew admins can update crews"
  on public.crews
  for update
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (public.can_manage_crew(id) or created_by = (select auth.uid()))
  )
  with check (
    public.has_active_entitlement('membership_active')
    and (public.can_manage_crew(id) or created_by = (select auth.uid()))
  );

drop policy if exists "Crew members can read members" on public.crew_members;
create policy "Crew members can read members"
  on public.crew_members
  for select
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Crew owners can add themselves" on public.crew_members;
create policy "Crew owners can add themselves"
  on public.crew_members
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and role = 'owner'
    and public.has_active_entitlement('membership_active')
    and exists (
      select 1
      from public.crews c
      where c.id = crew_id
        and c.created_by = (select auth.uid())
    )
  );

drop policy if exists "Crew admins can read invites" on public.crew_invites;
create policy "Crew admins can read invites"
  on public.crew_invites
  for select
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and public.can_manage_crew(crew_id)
  );

drop policy if exists "Crew admins can create invites" on public.crew_invites;
create policy "Crew admins can create invites"
  on public.crew_invites
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and public.can_manage_crew(crew_id)
  );

drop policy if exists "Crew admins can update invites" on public.crew_invites;
create policy "Crew admins can update invites"
  on public.crew_invites
  for update
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and public.can_manage_crew(crew_id)
  )
  with check (
    public.has_active_entitlement('membership_active')
    and public.can_manage_crew(crew_id)
  );

drop policy if exists "Authenticated users can read visible posts" on public.community_posts;
create policy "Authenticated users can read visible posts"
  on public.community_posts
  for select
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (scope = 'global' or public.is_crew_member(crew_id))
  );

drop policy if exists "Users can create visible posts" on public.community_posts;
create policy "Users can create visible posts"
  on public.community_posts
  for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and (
      (
        scope = 'global'
        and crew_id is null
      )
      or (scope = 'crew' and public.is_crew_member(crew_id))
    )
  );

drop policy if exists "Authors can update own posts" on public.community_posts;
create policy "Authors can update own posts"
  on public.community_posts
  for update
  to authenticated
  using (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  )
  with check (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can read likes on visible posts" on public.post_likes;
create policy "Users can read likes on visible posts"
  on public.post_likes
  for select
  to authenticated
  using (public.can_read_community_post(post_id));

drop policy if exists "Users can like visible posts" on public.post_likes;
create policy "Users can like visible posts"
  on public.post_likes
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_read_community_post(post_id)
  );

drop policy if exists "Users can remove own likes" on public.post_likes;
create policy "Users can remove own likes"
  on public.post_likes
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can read comments on visible posts" on public.post_comments;
create policy "Users can read comments on visible posts"
  on public.post_comments
  for select
  to authenticated
  using (public.can_read_community_post(post_id));

drop policy if exists "Users can comment on visible posts" on public.post_comments;
create policy "Users can comment on visible posts"
  on public.post_comments
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_read_community_post(post_id)
  );

drop policy if exists "Users can update own comments" on public.post_comments;
create policy "Users can update own comments"
  on public.post_comments
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  )
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can read own journal entries" on public.journal_entries;
create policy "Users can read own journal entries"
  on public.journal_entries
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can insert own journal entries" on public.journal_entries;
create policy "Users can insert own journal entries"
  on public.journal_entries
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
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
  );

drop policy if exists "Users can delete own journal entries" on public.journal_entries;
create policy "Users can delete own journal entries"
  on public.journal_entries
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can read own journal photos" on public.journal_photos;
create policy "Users can read own journal photos"
  on public.journal_photos
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can insert own journal photos" on public.journal_photos;
create policy "Users can insert own journal photos"
  on public.journal_photos
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can update own journal photos" on public.journal_photos;
create policy "Users can update own journal photos"
  on public.journal_photos
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  )
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can delete own journal photos" on public.journal_photos;
create policy "Users can delete own journal photos"
  on public.journal_photos
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
  );

revoke all on public.profiles from anon;
revoke all on public.challenge_entries from anon;
revoke all on public.check_ins from anon;
revoke all on public.billing_customers from anon;
revoke all on public.billing_customers from authenticated;
revoke all on public.subscriptions from anon;
revoke all on public.subscriptions from authenticated;
revoke all on public.entitlements from anon;
revoke all on public.entitlements from authenticated;
revoke all on public.community_feed_items from anon;
revoke all on public.community_feed_items from authenticated;
revoke all on public.crews from anon;
revoke all on public.crews from authenticated;
revoke all on public.crew_members from anon;
revoke all on public.crew_members from authenticated;
revoke all on public.crew_invites from anon;
revoke all on public.crew_invites from authenticated;
revoke all on public.community_posts from anon;
revoke all on public.community_posts from authenticated;
revoke all on public.post_likes from anon;
revoke all on public.post_likes from authenticated;
revoke all on public.post_comments from anon;
revoke all on public.post_comments from authenticated;
revoke all on public.journal_entries from anon;
revoke all on public.journal_entries from authenticated;
revoke all on public.journal_photos from anon;
revoke all on public.journal_photos from authenticated;
revoke all on public.badge_definitions from anon;
revoke all on public.badge_definitions from authenticated;
revoke all on public.user_badges from anon;
revoke all on public.user_badges from authenticated;
revoke all on public.user_game_stats from anon;
revoke all on public.user_game_stats from authenticated;
revoke all on public.game_point_events from anon;
revoke all on public.game_point_events from authenticated;
revoke all on public.workout_difficulty_point_values from public;
revoke all on public.workout_difficulty_point_values from anon;
revoke all on public.workout_difficulty_point_values from authenticated;
revoke all on public.workout_difficulty_point_values from service_role;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.challenge_entries to authenticated;
grant insert on public.check_ins to authenticated;
grant select (id, user_id, challenge_day, status, completed_count, points_awarded, created_at)
  on public.check_ins to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.entitlements to authenticated;
grant insert on public.community_feed_items to authenticated;
grant select (id, display_name, challenge_day, status, completed_count, points_awarded, created_at)
  on public.community_feed_items to authenticated;
grant select, insert, update on public.crews to authenticated;
grant select, insert on public.crew_members to authenticated;
grant select, insert, update on public.crew_invites to authenticated;
grant select, insert, update on public.community_posts to authenticated;
grant select, insert, delete on public.post_likes to authenticated;
grant select, insert, update on public.post_comments to authenticated;
grant select, insert, update, delete on public.journal_entries to authenticated;
grant select, insert, update, delete on public.journal_photos to authenticated;
grant select on public.badge_definitions to authenticated;
grant select on public.user_badges to authenticated;
grant select on public.user_game_stats to authenticated;
grant select on public.game_point_events to authenticated;
grant select on public.workout_difficulty_point_values to authenticated;
grant select on public.workout_difficulty_point_values to service_role;
grant update (points) on public.workout_difficulty_point_values to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Profile photos are publicly readable" on storage.objects;
create policy "Profile photos are publicly readable"
  on storage.objects
  for select
  to public
  using (bucket_id = 'profile-photos');

drop policy if exists "Users can upload own profile photo objects" on storage.objects;
create policy "Users can upload own profile photo objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update own profile photo objects" on storage.objects;
create policy "Users can update own profile photo objects"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete own profile photo objects" on storage.objects;
create policy "Users can delete own profile photo objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'journal-progress',
  'journal-progress',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read own journal photo objects" on storage.objects;
create policy "Users can read own journal photo objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can upload own journal photo objects" on storage.objects;
create policy "Users can upload own journal photo objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can update own journal photo objects" on storage.objects;
create policy "Users can update own journal photo objects"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_active_entitlement('membership_active')
  )
  with check (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_active_entitlement('membership_active')
  );

drop policy if exists "Users can delete own journal photo objects" on storage.objects;
create policy "Users can delete own journal photo objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_active_entitlement('membership_active')
  );
