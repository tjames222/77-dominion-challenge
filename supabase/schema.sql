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
  time_zone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists time_zone text;

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
  avatar_url text not null default '',
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);

alter table public.crew_members
  add column if not exists avatar_url text not null default '';

update public.crew_members cm
set avatar_url = p.avatar_url
from public.profiles p
where p.user_id = cm.user_id
  and cm.avatar_url = ''
  and p.avatar_url <> '';

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
  avatar_url text not null default '',
  crew_id uuid references public.crews(id) on delete cascade,
  scope text not null check (scope in ('crew', 'global')),
  body text not null default '',
  image_path text,
  image_alt text not null default '',
  post_type text not null default 'message' check (post_type in ('message', 'prayer', 'encouragement', 'check_in')),
  challenge_day integer,
  status text check (status is null or status in ('complete', 'partial', 'scheduled')),
  completed_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint community_posts_body_or_image_check check (
    char_length(trim(body)) <= 2000
    and (char_length(trim(body)) >= 1 or image_path is not null)
  ),
  constraint community_posts_image_alt_check check (char_length(image_alt) <= 500),
  constraint community_posts_image_path_scope_check check (
    image_path is null
    or (
      scope = 'crew'
      and crew_id is not null
      and image_path like (crew_id::text || '/' || author_id::text || '/%')
      and char_length(image_path) > char_length(crew_id::text) + char_length(author_id::text) + 2
    )
  ),
  check (
    (scope = 'crew' and crew_id is not null)
    or (scope = 'global' and crew_id is null)
  )
);

alter table public.community_posts
  add column if not exists avatar_url text not null default '',
  add column if not exists image_path text,
  add column if not exists image_alt text not null default '';

alter table public.community_posts
  alter column body set default '';

alter table public.community_posts
  drop constraint if exists community_posts_body_check;

alter table public.community_posts
  drop constraint if exists community_posts_body_or_image_check;

alter table public.community_posts
  add constraint community_posts_body_or_image_check check (
    char_length(trim(body)) <= 2000
    and (char_length(trim(body)) >= 1 or image_path is not null)
  );

alter table public.community_posts
  drop constraint if exists community_posts_image_alt_check;

alter table public.community_posts
  add constraint community_posts_image_alt_check
  check (char_length(image_alt) <= 500);

alter table public.community_posts
  drop constraint if exists community_posts_image_path_scope_check;

alter table public.community_posts
  add constraint community_posts_image_path_scope_check check (
    image_path is null
    or (
      scope = 'crew'
      and crew_id is not null
      and image_path like (crew_id::text || '/' || author_id::text || '/%')
      and char_length(image_path) > char_length(crew_id::text) + char_length(author_id::text) + 2
    )
  );

update public.community_posts cp
set avatar_url = p.avatar_url
from public.profiles p
where p.user_id = cp.author_id
  and cp.avatar_url = ''
  and p.avatar_url <> '';

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
  avatar_url text not null default '',
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.post_comments
  add column if not exists avatar_url text not null default '';

update public.post_comments pc
set avatar_url = p.avatar_url
from public.profiles p
where p.user_id = pc.user_id
  and pc.avatar_url = ''
  and p.avatar_url <> '';

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

create table if not exists public.challenge_definitions (
  challenge_key text primary key check (challenge_key ~ '^[a-z0-9][a-z0-9_]*$'),
  title text not null check (btrim(title) <> ''),
  teaser text not null default '',
  challenge_type text not null default 'general' check (btrim(challenge_type) <> ''),
  points_required integer not null check (points_required >= 0),
  duration_days integer check (duration_days is null or duration_days > 0),
  entitlement_key text default 'membership_active',
  icon text not null default 'target',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_challenge_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_key text not null references public.challenge_definitions(challenge_key),
  status text not null default 'available' check (status in ('available', 'active', 'completed')),
  unlock_points integer not null check (unlock_points >= 0),
  unlocked_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  celebration_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, challenge_key),
  check (
    (status = 'available' and started_at is null and completed_at is null)
    or (status = 'active' and started_at is not null and completed_at is null)
    or (status = 'completed' and started_at is not null and completed_at is not null)
  )
);

create index if not exists challenge_entries_user_date_idx
  on public.challenge_entries (user_id, entry_date desc);

create index if not exists check_ins_created_at_idx
  on public.check_ins (created_at desc);

create index if not exists check_ins_user_date_idx
  on public.check_ins (user_id, entry_date desc);

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

-- Preserve the challenge calendar already represented by the first retained
-- legacy check-in. Drop an earlier version of the lock before repairing data.
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

create index if not exists community_posts_crew_cursor_idx
  on public.community_posts (crew_id, created_at desc, id desc);

create index if not exists community_posts_scope_cursor_idx
  on public.community_posts (scope, created_at desc, id desc);

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

create index if not exists challenge_definitions_active_points_idx
  on public.challenge_definitions (points_required, sort_order, challenge_key)
  where is_active;

create index if not exists user_challenge_states_user_status_idx
  on public.user_challenge_states (user_id, status, unlocked_at desc);

create index if not exists user_challenge_states_pending_celebration_idx
  on public.user_challenge_states (user_id, unlocked_at, challenge_key)
  where celebration_seen_at is null;

insert into public.challenge_definitions (
  challenge_key,
  title,
  teaser,
  challenge_type,
  points_required,
  duration_days,
  entitlement_key,
  icon,
  sort_order
)
values
  (
    'seven_day_reset',
    '7-Day Reset',
    'A focused week to rebuild rhythm and recover momentum.',
    'reset',
    1000,
    7,
    'membership_active',
    'repeat',
    10
  ),
  (
    'twenty_one_day_prayer',
    '21-Day Prayer Track',
    'Deepen the daily prayer habit with a guided three-week track.',
    'spiritual',
    3000,
    21,
    'membership_active',
    'spark',
    20
  ),
  (
    'thirty_day_strength',
    '30-Day Strength Intensive',
    'Turn consistency into a focused month of physical training.',
    'physical',
    4500,
    30,
    'membership_active',
    'dumbbell',
    30
  ),
  (
    'forty_day_fast',
    '40-Day Fasting & Prayer Track',
    'Build a guided rhythm of fasting, prayer, and disciplined reflection.',
    'fasting',
    6000,
    40,
    'membership_active',
    'flame',
    40
  ),
  (
    'bible_in_a_year',
    'Bible in a Year',
    'Carry the reading discipline into a complete yearlong plan.',
    'bible',
    10000,
    365,
    'membership_active',
    'book',
    50
  )
on conflict (challenge_key) do nothing;

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

drop trigger if exists set_challenge_definitions_updated_at on public.challenge_definitions;
create trigger set_challenge_definitions_updated_at
  before update on public.challenge_definitions
  for each row execute function public.set_updated_at();

drop trigger if exists set_user_challenge_states_updated_at on public.user_challenge_states;
create trigger set_user_challenge_states_updated_at
  before update on public.user_challenge_states
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

create or replace function public.reconcile_user_challenge_unlocks(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  if target_user_id is null then
    return 0;
  end if;

  insert into public.user_challenge_states (
    user_id,
    challenge_key,
    status,
    unlock_points,
    unlocked_at
  )
  select
    stats.user_id,
    definition.challenge_key,
    'available',
    definition.points_required,
    now()
  from public.user_game_stats stats
  join public.challenge_definitions definition
    on definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
   and (
     definition.entitlement_key is null
     or exists (
       select 1
       from public.entitlements entitlement
       where entitlement.user_id = stats.user_id
         and entitlement.entitlement_key = definition.entitlement_key
         and entitlement.status = 'active'
         and (entitlement.starts_at is null or entitlement.starts_at <= now())
         and (entitlement.ends_at is null or entitlement.ends_at > now())
     )
   )
  where stats.user_id = target_user_id
  on conflict (user_id, challenge_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.sync_user_challenge_unlocks_from_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.total_points is not distinct from old.total_points then
      return new;
    end if;
  end if;

  perform public.reconcile_user_challenge_unlocks(new.user_id);
  return new;
end;
$$;

drop trigger if exists sync_user_challenge_unlocks_from_stats on public.user_game_stats;
create trigger sync_user_challenge_unlocks_from_stats
  after insert or update of total_points on public.user_game_stats
  for each row execute function public.sync_user_challenge_unlocks_from_stats();

create or replace function public.sync_challenge_definition_unlocks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.is_active then
    return new;
  end if;

  insert into public.user_challenge_states (
    user_id,
    challenge_key,
    status,
    unlock_points,
    unlocked_at
  )
  select
    stats.user_id,
    new.challenge_key,
    'available',
    new.points_required,
    now()
  from public.user_game_stats stats
  where greatest(stats.total_points, 0) >= new.points_required
    and (
      new.entitlement_key is null
      or exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = stats.user_id
          and entitlement.entitlement_key = new.entitlement_key
          and entitlement.status = 'active'
          and (entitlement.starts_at is null or entitlement.starts_at <= now())
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    )
  on conflict (user_id, challenge_key) do nothing;

  return new;
end;
$$;

drop trigger if exists sync_challenge_definition_unlocks on public.challenge_definitions;
create trigger sync_challenge_definition_unlocks
  after insert or update of points_required, is_active, entitlement_key on public.challenge_definitions
  for each row execute function public.sync_challenge_definition_unlocks();

insert into public.user_challenge_states (
  user_id,
  challenge_key,
  status,
  unlock_points,
  unlocked_at
)
select
  stats.user_id,
  definition.challenge_key,
  'available',
  definition.points_required,
  now()
from public.user_game_stats stats
join public.challenge_definitions definition
  on definition.is_active
 and definition.points_required <= greatest(stats.total_points, 0)
 and (
   definition.entitlement_key is null
   or exists (
     select 1
     from public.entitlements entitlement
     where entitlement.user_id = stats.user_id
       and entitlement.entitlement_key = definition.entitlement_key
       and entitlement.status = 'active'
       and (entitlement.starts_at is null or entitlement.starts_at <= now())
       and (entitlement.ends_at is null or entitlement.ends_at > now())
   )
 )
on conflict (user_id, challenge_key) do nothing;

create or replace function public.challenge_progression_for_user(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_total_points integer := 0;
  challenge_rows jsonb := '[]'::jsonb;
  next_unlock jsonb := null;
begin
  select greatest(coalesce(stats.total_points, 0), 0)
    into current_total_points
  from public.user_game_stats stats
  where stats.user_id = target_user_id;

  current_total_points := coalesce(current_total_points, 0);

  select coalesce(jsonb_agg(catalog.challenge order by catalog.points_required, catalog.sort_order, catalog.challenge_key), '[]'::jsonb)
    into challenge_rows
  from (
    select
      definition.challenge_key,
      definition.points_required,
      definition.sort_order,
      jsonb_build_object(
        'key', definition.challenge_key,
        'title', definition.title,
        'teaser', definition.teaser,
        'type', definition.challenge_type,
        'pointsRequired', definition.points_required,
        'durationDays', definition.duration_days,
        'entitlementKey', definition.entitlement_key,
        'icon', definition.icon,
        'sortOrder', definition.sort_order,
        'metadata', definition.metadata,
        'active', definition.is_active,
        'status', coalesce(user_state.status, 'locked'),
        'canAccess',
          definition.entitlement_key is null
          or exists (
            select 1
            from public.entitlements entitlement
            where entitlement.user_id = target_user_id
              and entitlement.entitlement_key = definition.entitlement_key
              and entitlement.status = 'active'
              and (entitlement.starts_at is null or entitlement.starts_at <= now())
              and (entitlement.ends_at is null or entitlement.ends_at > now())
          ),
        'accessReason', case
          when definition.entitlement_key is not null and not exists (
            select 1
            from public.entitlements entitlement
            where entitlement.user_id = target_user_id
              and entitlement.entitlement_key = definition.entitlement_key
              and entitlement.status = 'active'
              and (entitlement.starts_at is null or entitlement.starts_at <= now())
              and (entitlement.ends_at is null or entitlement.ends_at > now())
          ) then 'membership_required'
          when user_state.challenge_key is null then 'points_required'
          else null
        end,
        'pointsRemaining', case
          when user_state.challenge_key is not null then 0
          else greatest(definition.points_required - current_total_points, 0)
        end,
        'progressPercent', case
          when user_state.challenge_key is not null or definition.points_required = 0 then 100
          else least(round((current_total_points::numeric / definition.points_required::numeric) * 100, 2), 100)
        end,
        'unlockPoints', user_state.unlock_points,
        'unlockedAt', user_state.unlocked_at,
        'startedAt', user_state.started_at,
        'completedAt', user_state.completed_at,
        'celebrationSeenAt', user_state.celebration_seen_at
      ) as challenge
    from public.challenge_definitions definition
    left join public.user_challenge_states user_state
      on user_state.user_id = target_user_id
     and user_state.challenge_key = definition.challenge_key
    where definition.is_active
  ) catalog;

  select jsonb_build_object(
      'key', definition.challenge_key,
      'title', definition.title,
      'pointsRequired', definition.points_required,
      'pointsRemaining', greatest(definition.points_required - current_total_points, 0),
      'progressPercent', case
        when definition.points_required = 0 then 100
        else least(round((current_total_points::numeric / definition.points_required::numeric) * 100, 2), 100)
      end
    )
    into next_unlock
  from public.challenge_definitions definition
  left join public.user_challenge_states user_state
    on user_state.user_id = target_user_id
   and user_state.challenge_key = definition.challenge_key
  where definition.is_active
    and user_state.challenge_key is null
    and (
      definition.entitlement_key is null
      or exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = target_user_id
          and entitlement.entitlement_key = definition.entitlement_key
          and entitlement.status = 'active'
          and (entitlement.starts_at is null or entitlement.starts_at <= now())
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    )
  order by definition.points_required, definition.sort_order, definition.challenge_key
  limit 1;

  return jsonb_build_object(
    'totalPoints', current_total_points,
    'challenges', challenge_rows,
    'nextUnlock', next_unlock
  );
end;
$$;

create or replace function public.get_challenge_progression()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You need to log in to view challenge progression.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  return public.challenge_progression_for_user(current_user_id);
end;
$$;

create or replace function public.claim_challenge_unlocks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  claimed_keys jsonb := '[]'::jsonb;
begin
  if current_user_id is null then
    raise exception 'You need to log in to claim challenge unlocks.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  with pending as materialized (
    select user_state.user_id, user_state.challenge_key
    from public.user_challenge_states user_state
    join public.challenge_definitions definition
      on definition.challenge_key = user_state.challenge_key
     and definition.is_active
    where user_state.user_id = current_user_id
      and user_state.celebration_seen_at is null
      and (
        definition.entitlement_key is null
        or exists (
          select 1
          from public.entitlements entitlement
          where entitlement.user_id = current_user_id
            and entitlement.entitlement_key = definition.entitlement_key
            and entitlement.status = 'active'
            and (entitlement.starts_at is null or entitlement.starts_at <= now())
            and (entitlement.ends_at is null or entitlement.ends_at > now())
        )
      )
    order by definition.points_required, definition.sort_order, definition.challenge_key
    for update of user_state skip locked
  ),
  claimed as (
    update public.user_challenge_states user_state
    set celebration_seen_at = now()
    from pending
    where user_state.user_id = pending.user_id
      and user_state.challenge_key = pending.challenge_key
      and user_state.celebration_seen_at is null
    returning user_state.challenge_key
  )
  select coalesce(jsonb_agg(claimed.challenge_key order by definition.points_required, definition.sort_order, claimed.challenge_key), '[]'::jsonb)
    into claimed_keys
  from claimed
  join public.challenge_definitions definition
    on definition.challenge_key = claimed.challenge_key;

  return jsonb_build_object(
    'claimedKeys', claimed_keys,
    'progression', public.challenge_progression_for_user(current_user_id)
  );
end;
$$;

create or replace function public.start_challenge(target_challenge_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_status text;
  definition_active boolean;
  required_entitlement_key text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to start a challenge.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  select user_state.status, definition.is_active, definition.entitlement_key
    into current_status, definition_active, required_entitlement_key
  from public.user_challenge_states user_state
  join public.challenge_definitions definition
    on definition.challenge_key = user_state.challenge_key
  where user_state.user_id = current_user_id
    and user_state.challenge_key = target_challenge_key
  for update of user_state;

  if not found then
    raise exception 'That challenge is still locked.';
  end if;

  if not definition_active then
    raise exception 'That challenge is not currently available.';
  end if;

  if current_status <> 'available' then
    raise exception 'Only an available challenge can be started.';
  end if;

  if required_entitlement_key is not null and not exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = current_user_id
      and entitlement.entitlement_key = required_entitlement_key
      and entitlement.status = 'active'
      and (entitlement.starts_at is null or entitlement.starts_at <= now())
      and (entitlement.ends_at is null or entitlement.ends_at > now())
  ) then
    raise exception 'An active membership is required to start this challenge.';
  end if;

  update public.user_challenge_states
  set
    status = 'active',
    started_at = now()
  where user_id = current_user_id
    and challenge_key = target_challenge_key
    and status = 'available';

  return public.challenge_progression_for_user(current_user_id);
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
  member_avatar_url text;
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

  select coalesce(nullif(p.name, ''), 'Member'), coalesce(p.avatar_url, '')
    into member_name, member_avatar_url
    from public.profiles p
    where p.user_id = auth.uid();

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
    target_crew_id,
    auth.uid(),
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'member'
  )
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

create or replace function public.get_community_post_engagement(target_post_ids uuid[])
returns table (
  post_id uuid,
  display_name text,
  avatar_url text,
  like_count integer,
  liked_by_me boolean,
  reactions jsonb,
  comments jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You need to log in to view Community activity.';
  end if;

  if coalesce(cardinality(target_post_ids), 0) = 0 then
    return;
  end if;

  if cardinality(target_post_ids) > 25 then
    raise exception 'Community activity can be loaded for at most 25 posts at a time.';
  end if;

  return query
    select
      cp.id as post_id,
      case
        when author_profile.user_id is not null
          then coalesce(nullif(author_profile.name, ''), 'Member')
        else coalesce(nullif(cp.display_name, ''), 'Member')
      end as display_name,
      case
        when author_profile.user_id is not null then coalesce(author_profile.avatar_url, '')
        else coalesce(cp.avatar_url, '')
      end as avatar_url,
      (select count(*)::integer from public.post_likes pl where pl.post_id = cp.id) as like_count,
      exists (
        select 1
        from public.post_likes own_like
        where own_like.post_id = cp.id
          and own_like.user_id = current_user_id
      ) as liked_by_me,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'user_id', recent.user_id,
            'display_name', recent.display_name,
            'avatar_url', recent.avatar_url,
            'created_at', recent.created_at
          )
          order by recent.created_at desc, recent.user_id
        )
        from (
          select
            pl.user_id,
            coalesce(nullif(liker_profile.name, ''), 'Member') as display_name,
            coalesce(liker_profile.avatar_url, '') as avatar_url,
            pl.created_at
          from public.post_likes pl
          left join public.profiles liker_profile on liker_profile.user_id = pl.user_id
          where pl.post_id = cp.id
          order by pl.created_at desc, pl.user_id
          limit 3
        ) recent
      ), '[]'::jsonb) as reactions,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pc.id,
            'post_id', pc.post_id,
            'user_id', pc.user_id,
            'display_name', case
              when commenter_profile.user_id is not null
                then coalesce(nullif(commenter_profile.name, ''), 'Member')
              else coalesce(nullif(pc.display_name, ''), 'Member')
            end,
            'avatar_url', case
              when commenter_profile.user_id is not null then coalesce(commenter_profile.avatar_url, '')
              else coalesce(pc.avatar_url, '')
            end,
            'body', pc.body,
            'created_at', pc.created_at
          )
          order by pc.created_at, pc.id
        )
        from public.post_comments pc
        left join public.profiles commenter_profile on commenter_profile.user_id = pc.user_id
        where pc.post_id = cp.id
      ), '[]'::jsonb) as comments
    from public.community_posts cp
    left join public.profiles author_profile on author_profile.user_id = cp.author_id
    where cp.id = any(target_post_ids)
      and public.can_read_community_post(cp.id);
end;
$$;

create or replace function public.get_crew_members_with_profiles(target_crew_id uuid)
returns table (
  crew_id uuid,
  user_id uuid,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You need to log in to view crew members.';
  end if;

  if not public.has_active_entitlement('membership_active') or not public.is_crew_member(target_crew_id) then
    raise exception 'Crew membership is required to view these members.';
  end if;

  return query
    select
      cm.crew_id,
      cm.user_id,
      case
        when p.user_id is not null then coalesce(nullif(p.name, ''), 'Member')
        else coalesce(nullif(cm.display_name, ''), 'Member')
      end as display_name,
      case
        when p.user_id is not null then coalesce(p.avatar_url, '')
        else coalesce(cm.avatar_url, '')
      end as avatar_url,
      cm.role,
      cm.joined_at
    from public.crew_members cm
    left join public.profiles p on p.user_id = cm.user_id
    where cm.crew_id = target_crew_id
    order by cm.joined_at, cm.user_id;
end;
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

drop function if exists public.get_global_leaderboard(text);

create function public.get_global_leaderboard(target_window text default 'week')
returns table (
  rank_position bigint,
  user_id uuid,
  display_name text,
  avatar_url text,
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
	      coalesce(p.avatar_url, '') as avatar_url,
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

drop function if exists public.get_crew_leaderboard(uuid, text);

create function public.get_crew_leaderboard(target_crew_id uuid, target_window text default 'week')
returns table (
  rank_position bigint,
  user_id uuid,
  display_name text,
  avatar_url text,
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
	      coalesce(p.avatar_url, '') as avatar_url,
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
revoke execute on function public.lock_challenge_start_date_after_check_in() from public;
revoke execute on function public.lock_challenge_start_date_after_check_in() from anon;
revoke execute on function public.lock_challenge_start_date_after_check_in() from authenticated;
revoke execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) from public;
revoke execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) from anon;
grant execute on function public.submit_daily_check_in(text, text[], jsonb, text, date) to authenticated;
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
revoke execute on function public.reconcile_user_challenge_unlocks(uuid) from public;
revoke execute on function public.reconcile_user_challenge_unlocks(uuid) from anon;
revoke execute on function public.reconcile_user_challenge_unlocks(uuid) from authenticated;
revoke execute on function public.sync_user_challenge_unlocks_from_stats() from public;
revoke execute on function public.sync_user_challenge_unlocks_from_stats() from anon;
revoke execute on function public.sync_user_challenge_unlocks_from_stats() from authenticated;
revoke execute on function public.sync_challenge_definition_unlocks() from public;
revoke execute on function public.sync_challenge_definition_unlocks() from anon;
revoke execute on function public.sync_challenge_definition_unlocks() from authenticated;
revoke execute on function public.challenge_progression_for_user(uuid) from public;
revoke execute on function public.challenge_progression_for_user(uuid) from anon;
revoke execute on function public.challenge_progression_for_user(uuid) from authenticated;
revoke execute on function public.get_challenge_progression() from public;
revoke execute on function public.get_challenge_progression() from anon;
grant execute on function public.get_challenge_progression() to authenticated;
revoke execute on function public.claim_challenge_unlocks() from public;
revoke execute on function public.claim_challenge_unlocks() from anon;
grant execute on function public.claim_challenge_unlocks() to authenticated;
revoke execute on function public.start_challenge(text) from public;
revoke execute on function public.start_challenge(text) from anon;
grant execute on function public.start_challenge(text) to authenticated;
revoke execute on function public.process_check_in_game_rewards() from public;
revoke execute on function public.process_check_in_game_rewards() from anon;
revoke execute on function public.process_check_in_game_rewards() from authenticated;
revoke execute on function public.record_app_visit() from public;
revoke execute on function public.record_app_visit() from anon;
grant execute on function public.record_app_visit() to authenticated;
revoke execute on function public.get_community_post_engagement(uuid[]) from public;
revoke execute on function public.get_community_post_engagement(uuid[]) from anon;
grant execute on function public.get_community_post_engagement(uuid[]) to authenticated;
revoke execute on function public.get_crew_members_with_profiles(uuid) from public;
revoke execute on function public.get_crew_members_with_profiles(uuid) from anon;
grant execute on function public.get_crew_members_with_profiles(uuid) to authenticated;
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
alter table public.challenge_definitions enable row level security;
alter table public.user_challenge_states enable row level security;

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

drop policy if exists "Authenticated users can read challenge definitions" on public.challenge_definitions;
create policy "Authenticated users can read challenge definitions"
  on public.challenge_definitions
  for select
  to authenticated
  using (is_active);

drop policy if exists "Users can read own challenge states" on public.user_challenge_states;
create policy "Users can read own challenge states"
  on public.user_challenge_states
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

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

drop policy if exists "Authors and crew leaders can delete posts" on public.community_posts;
create policy "Authors and crew leaders can delete posts"
  on public.community_posts
  for delete
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (
      author_id = (select auth.uid())
      or (
        scope = 'crew'
        and public.can_manage_crew(crew_id)
      )
    )
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

drop policy if exists "Authors and crew leaders can delete comments" on public.post_comments;
create policy "Authors and crew leaders can delete comments"
  on public.post_comments
  for delete
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (
      user_id = (select auth.uid())
      or exists (
        select 1
        from public.community_posts cp
        where cp.id = post_comments.post_id
          and cp.scope = 'crew'
          and public.can_manage_crew(cp.crew_id)
      )
    )
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
revoke all on public.challenge_definitions from public;
revoke all on public.challenge_definitions from anon;
revoke all on public.challenge_definitions from authenticated;
revoke all on public.challenge_definitions from service_role;
revoke all on public.user_challenge_states from public;
revoke all on public.user_challenge_states from anon;
revoke all on public.user_challenge_states from authenticated;
revoke all on public.user_challenge_states from service_role;

revoke update on public.profiles from authenticated;
grant select, insert on public.profiles to authenticated;
grant update (user_id, name, email, avatar_url, challenge_start_date) on public.profiles to authenticated;
grant select, insert, update on public.challenge_entries to authenticated;
revoke insert on public.check_ins from authenticated;
grant select (id, user_id, entry_date, challenge_day, status, completed_count, points_awarded, created_at)
  on public.check_ins to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.entitlements to authenticated;
grant insert on public.community_feed_items to authenticated;
grant select (id, display_name, challenge_day, status, completed_count, points_awarded, created_at)
  on public.community_feed_items to authenticated;
grant select, insert, update on public.crews to authenticated;
grant select, insert on public.crew_members to authenticated;
grant select, insert, update on public.crew_invites to authenticated;
grant select, insert, delete on public.community_posts to authenticated;
grant update (body, image_alt) on public.community_posts to authenticated;

-- Keep the server-only integration runtime identical to the forward migration.
-- This canonical file is executed through psql, so \ir resolves relative to
-- this file's directory.
\ir migrations/20260719170000_integration_delivery_runtime.sql
\ir migrations/20260719180000_integration_connection_management.sql
grant select, insert, delete on public.post_likes to authenticated;
grant select, insert, delete on public.post_comments to authenticated;
grant update (body) on public.post_comments to authenticated;
grant select, insert, update, delete on public.journal_entries to authenticated;
grant select, insert, update, delete on public.journal_photos to authenticated;
grant select on public.badge_definitions to authenticated;
grant select on public.user_badges to authenticated;
grant select on public.user_game_stats to authenticated;
grant select on public.game_point_events to authenticated;
grant select on public.workout_difficulty_point_values to authenticated;
grant select on public.workout_difficulty_point_values to service_role;
grant update (points) on public.workout_difficulty_point_values to service_role;
grant select on public.challenge_definitions to authenticated;
grant select on public.user_challenge_states to authenticated;
grant select, insert, update, delete on public.challenge_definitions to service_role;
grant select, insert, update, delete on public.user_challenge_states to service_role;

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
  'community-post-images',
  'community-post-images',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Crew members can read community post images" on storage.objects;
create policy "Crew members can read community post images"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'community-post-images'
    and public.has_active_entitlement('membership_active')
    and exists (
      select 1
      from public.crew_members cm
      where cm.crew_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid())
    )
  );

drop policy if exists "Crew members can upload own community post images" on storage.objects;
create policy "Crew members can upload own community post images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'community-post-images'
    and public.has_active_entitlement('membership_active')
    and exists (
      select 1
      from public.crew_members cm
      where cm.crew_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid())
    )
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists "Authors and crew leaders can delete community post images" on storage.objects;
create policy "Authors and crew leaders can delete community post images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'community-post-images'
    and public.has_active_entitlement('membership_active')
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or exists (
        select 1
        from public.crew_members cm
        where cm.crew_id::text = (storage.foldername(name))[1]
          and cm.user_id = (select auth.uid())
          and cm.role in ('owner', 'admin')
      )
    )
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

-- Member-controlled privacy preferences for updates sent from Dominion to a
-- crew's external Slack or Discord destination. A missing preference row is
-- deliberately treated as no consent so existing and future members fail
-- closed until they make an explicit choice.

create table public.outbound_update_preferences (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null,
  user_id uuid not null,
  outbound_updates_enabled boolean not null default false,
  presentation_mode text not null default 'anonymous'
    check (presentation_mode in ('named', 'anonymous')),
  share_check_ins boolean not null default false,
  share_streak_milestones boolean not null default false,
  share_badges_rewards boolean not null default false,
  share_membership_events boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crew_id, user_id),
  foreign key (crew_id, user_id)
    references public.crew_members (crew_id, user_id)
    on delete cascade
);

comment on table public.outbound_update_preferences is
  'Current per-member approval for sending selected crew events to external destinations. Absence means no consent.';

create table public.outbound_update_preference_audit (
  id uuid primary key default gen_random_uuid(),
  preference_id uuid not null,
  crew_id uuid not null,
  user_id uuid not null,
  revision bigint not null check (revision > 0),
  change_type text not null check (change_type in ('created', 'updated', 'revoked')),
  change_source text not null check (change_source in ('member', 'membership_or_account_removed')),
  outbound_updates_enabled boolean not null,
  presentation_mode text not null check (presentation_mode in ('named', 'anonymous')),
  share_check_ins boolean not null,
  share_streak_milestones boolean not null,
  share_badges_rewards boolean not null,
  share_membership_events boolean not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  unique (preference_id, revision)
);

comment on table public.outbound_update_preference_audit is
  'Immutable consent-setting history only. Event payloads and outbound message content must never be stored here.';

create index outbound_update_preference_audit_user_changed_idx
  on public.outbound_update_preference_audit (user_id, changed_at desc);

create or replace function public.prepare_outbound_update_preference()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.revision := 1;
    new.created_at := now();
    new.updated_at := new.created_at;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.crew_id is distinct from old.crew_id
    or new.user_id is distinct from old.user_id then
    raise exception 'Consent preference identity cannot be changed.';
  end if;

  if row(
    new.outbound_updates_enabled,
    new.presentation_mode,
    new.share_check_ins,
    new.share_streak_milestones,
    new.share_badges_rewards,
    new.share_membership_events
  ) is not distinct from row(
    old.outbound_updates_enabled,
    old.presentation_mode,
    old.share_check_ins,
    old.share_streak_milestones,
    old.share_badges_rewards,
    old.share_membership_events
  ) then
    -- Treat an identical client or worker retry as a no-op. This avoids a
    -- misleading new audit revision without weakening current-consent checks.
    return null;
  end if;

  new.id := old.id;
  new.crew_id := old.crew_id;
  new.user_id := old.user_id;
  new.revision := old.revision + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.audit_outbound_update_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.outbound_update_preference_audit (
      preference_id,
      crew_id,
      user_id,
      revision,
      change_type,
      change_source,
      outbound_updates_enabled,
      presentation_mode,
      share_check_ins,
      share_streak_milestones,
      share_badges_rewards,
      share_membership_events,
      changed_by
    ) values (
      old.id,
      old.crew_id,
      old.user_id,
      old.revision + 1,
      'revoked',
      'membership_or_account_removed',
      false,
      'anonymous',
      false,
      false,
      false,
      false,
      null
    );
    return old;
  end if;

  insert into public.outbound_update_preference_audit (
    preference_id,
    crew_id,
    user_id,
    revision,
    change_type,
    change_source,
    outbound_updates_enabled,
    presentation_mode,
    share_check_ins,
    share_streak_milestones,
    share_badges_rewards,
    share_membership_events,
    changed_by
  ) values (
    new.id,
    new.crew_id,
    new.user_id,
    new.revision,
    case when tg_op = 'INSERT' then 'created' else 'updated' end,
    'member',
    new.outbound_updates_enabled,
    new.presentation_mode,
    new.share_check_ins,
    new.share_streak_milestones,
    new.share_badges_rewards,
    new.share_membership_events,
    auth.uid()
  );
  return new;
end;
$$;

create or replace function public.reject_outbound_update_preference_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'Consent audit history is immutable.';
end;
$$;

create trigger prepare_outbound_update_preference
  before insert or update on public.outbound_update_preferences
  for each row execute function public.prepare_outbound_update_preference();

create trigger audit_outbound_update_preference
  after insert or update or delete on public.outbound_update_preferences
  for each row execute function public.audit_outbound_update_preference();

create trigger reject_outbound_update_preference_audit_mutation
  before update or delete on public.outbound_update_preference_audit
  for each row execute function public.reject_outbound_update_preference_audit_mutation();

create or replace function public.get_current_outbound_consent(
  target_user_id uuid,
  target_crew_id uuid,
  target_event_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_user_id uuid := auth.uid();
  effective_user_id uuid := coalesce(target_user_id, auth.uid());
  caller_is_service_role boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  preference public.outbound_update_preferences%rowtype;
  consent_recorded boolean := false;
  account_active boolean := false;
  membership_active boolean := false;
  event_recognized boolean := false;
  event_allowed boolean := false;
  eligible boolean := false;
  decision_reason text;
begin
  if not caller_is_service_role
    and (caller_user_id is null or effective_user_id is distinct from caller_user_id) then
    raise exception 'You can only read your own outbound update consent.';
  end if;

  select exists (
    select 1
    from auth.users account
    where account.id = effective_user_id
  ) into account_active;

  select exists (
    select 1
    from public.crew_members member
    where member.crew_id = target_crew_id
      and member.user_id = effective_user_id
  ) into membership_active;

  select current_preference.*
    into preference
    from public.outbound_update_preferences current_preference
    where current_preference.crew_id = target_crew_id
      and current_preference.user_id = effective_user_id;
  consent_recorded := found;

  event_recognized := coalesce(
    target_event_type in ('check_in', 'streak_milestone', 'badge_reward', 'membership'),
    false
  );

  event_allowed := case target_event_type
    when 'check_in' then coalesce(preference.share_check_ins, false)
    when 'streak_milestone' then coalesce(preference.share_streak_milestones, false)
    when 'badge_reward' then coalesce(preference.share_badges_rewards, false)
    when 'membership' then coalesce(preference.share_membership_events, false)
    else false
  end;

  eligible := account_active
    and membership_active
    and consent_recorded
    and coalesce(preference.outbound_updates_enabled, false)
    and event_recognized
    and event_allowed;

  decision_reason := case
    when not account_active then 'account_missing'
    when not membership_active then 'membership_missing'
    when not consent_recorded then 'consent_missing'
    when not coalesce(preference.outbound_updates_enabled, false) then 'updates_disabled'
    when target_event_type is null then 'event_required'
    when not event_recognized then 'unsupported_event'
    when not event_allowed then 'event_not_approved'
    else 'approved'
  end;

  return jsonb_build_object(
    'schemaVersion', 1,
    'consentId', preference.id,
    'userId', effective_user_id,
    'crewId', target_crew_id,
    'eventType', target_event_type,
    'accountActive', account_active,
    'membershipActive', membership_active,
    'consentRecorded', consent_recorded,
    'outboundUpdatesEnabled', coalesce(preference.outbound_updates_enabled, false),
    'presentationMode', coalesce(preference.presentation_mode, 'anonymous'),
    'events', jsonb_build_object(
      'checkIns', coalesce(preference.share_check_ins, false),
      'streakMilestones', coalesce(preference.share_streak_milestones, false),
      'badgesRewards', coalesce(preference.share_badges_rewards, false),
      'membership', coalesce(preference.share_membership_events, false)
    ),
    'eventRecognized', event_recognized,
    'eventAllowed', event_allowed,
    'eligible', eligible,
    'reason', decision_reason,
    'revision', coalesce(preference.revision, 0),
    'changedAt', preference.updated_at,
    'evaluatedAt', clock_timestamp(),
    'destinationCheckRequired', true
  );
end;
$$;

comment on function public.get_current_outbound_consent(uuid, uuid, text) is
  'FOU-542 send-time contract. Call with a concrete event immediately before every initial delivery and retry, then independently verify the FOU-541 connection and FOU-553 runtime destination are active.';

create or replace function public.set_outbound_update_consent(
  target_crew_id uuid,
  target_outbound_updates_enabled boolean default false,
  target_presentation_mode text default 'anonymous',
  target_share_check_ins boolean default false,
  target_share_streak_milestones boolean default false,
  target_share_badges_rewards boolean default false,
  target_share_membership_events boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_user_id uuid := auth.uid();
  normalized_presentation_mode text := lower(trim(coalesce(target_presentation_mode, 'anonymous')));
begin
  if caller_user_id is null then
    raise exception 'You need to log in to change outbound update consent.';
  end if;

  if normalized_presentation_mode not in ('named', 'anonymous') then
    raise exception 'Presentation mode must be named or anonymous.';
  end if;

  if not exists (
    select 1
    from public.crew_members member
    where member.crew_id = target_crew_id
      and member.user_id = caller_user_id
  ) then
    raise exception 'You can only change consent for a group you belong to.';
  end if;

  insert into public.outbound_update_preferences (
    crew_id,
    user_id,
    outbound_updates_enabled,
    presentation_mode,
    share_check_ins,
    share_streak_milestones,
    share_badges_rewards,
    share_membership_events
  ) values (
    target_crew_id,
    caller_user_id,
    coalesce(target_outbound_updates_enabled, false),
    normalized_presentation_mode,
    coalesce(target_share_check_ins, false),
    coalesce(target_share_streak_milestones, false),
    coalesce(target_share_badges_rewards, false),
    coalesce(target_share_membership_events, false)
  )
  on conflict (crew_id, user_id) do update set
    outbound_updates_enabled = excluded.outbound_updates_enabled,
    presentation_mode = excluded.presentation_mode,
    share_check_ins = excluded.share_check_ins,
    share_streak_milestones = excluded.share_streak_milestones,
    share_badges_rewards = excluded.share_badges_rewards,
    share_membership_events = excluded.share_membership_events;

  return public.get_current_outbound_consent(caller_user_id, target_crew_id, null);
end;
$$;

alter table public.outbound_update_preferences enable row level security;
alter table public.outbound_update_preference_audit enable row level security;

create policy "Members can read own outbound update preferences"
  on public.outbound_update_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Members can insert own outbound update preferences"
  on public.outbound_update_preferences
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.is_crew_member(crew_id)
  );

create policy "Members can update own outbound update preferences"
  on public.outbound_update_preferences
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and public.is_crew_member(crew_id)
  )
  with check (
    (select auth.uid()) = user_id
    and public.is_crew_member(crew_id)
  );

create policy "Members can read own outbound consent audit"
  on public.outbound_update_preference_audit
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.outbound_update_preferences from public;
revoke all on public.outbound_update_preferences from anon;
revoke all on public.outbound_update_preferences from authenticated;
revoke all on public.outbound_update_preferences from service_role;
grant select, insert on public.outbound_update_preferences to authenticated;
grant update (
  outbound_updates_enabled,
  presentation_mode,
  share_check_ins,
  share_streak_milestones,
  share_badges_rewards,
  share_membership_events
) on public.outbound_update_preferences to authenticated;

revoke all on public.outbound_update_preference_audit from public;
revoke all on public.outbound_update_preference_audit from anon;
revoke all on public.outbound_update_preference_audit from authenticated;
revoke all on public.outbound_update_preference_audit from service_role;
grant select on public.outbound_update_preference_audit to authenticated;

revoke execute on function public.prepare_outbound_update_preference() from public;
revoke execute on function public.prepare_outbound_update_preference() from anon;
revoke execute on function public.prepare_outbound_update_preference() from authenticated;
revoke execute on function public.prepare_outbound_update_preference() from service_role;
revoke execute on function public.audit_outbound_update_preference() from public;
revoke execute on function public.audit_outbound_update_preference() from anon;
revoke execute on function public.audit_outbound_update_preference() from authenticated;
revoke execute on function public.audit_outbound_update_preference() from service_role;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from public;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from anon;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from authenticated;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from service_role;

revoke execute on function public.get_current_outbound_consent(uuid, uuid, text) from public;
revoke execute on function public.get_current_outbound_consent(uuid, uuid, text) from anon;
grant execute on function public.get_current_outbound_consent(uuid, uuid, text) to authenticated;
grant execute on function public.get_current_outbound_consent(uuid, uuid, text) to service_role;

revoke execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) from public;
revoke execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) from anon;
revoke execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) from service_role;
grant execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) to authenticated;
