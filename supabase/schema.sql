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
  workout_difficulty jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  scheduled_miss boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_date)
);

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

update public.challenge_entries draft
set
  scheduled_miss = false,
  updated_at = now()
where draft.scheduled_miss
  and not exists (
    select 1
    from public.check_ins finalized
    where finalized.user_id = draft.user_id
      and finalized.entry_date = draft.entry_date
      and finalized.status = 'scheduled'
  );

create or replace function public.reject_scheduled_miss_draft()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.scheduled_miss then
    raise exception 'Scheduled miss days are no longer supported.' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_scheduled_miss_draft_write on public.challenge_entries;
create trigger reject_scheduled_miss_draft_write
  before insert or update of scheduled_miss on public.challenge_entries
  for each row execute function public.reject_scheduled_miss_draft();

create or replace function public.reject_scheduled_check_in()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists block_scheduled_check_in_write on public.check_ins;
create trigger block_scheduled_check_in_write
  before insert or update of status on public.check_ins
  for each row execute function public.reject_scheduled_check_in();

create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
immutable
set search_path = public
as $$
  select 0;
$$;

drop table if exists public.workout_difficulty_point_values;

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
  target_earned_date date default null,
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
  if target_earned_date is not null and exists (
    select 1
    from public.user_badges
    where user_id = target_user_id
      and entry_date = target_earned_date
  ) then
    return false;
  end if;

  insert into public.user_badges (user_id, badge_key, entry_date, metadata)
  values (target_user_id, target_badge_key, target_earned_date, target_metadata)
  on conflict do nothing
  returning badge_key into inserted_key;

  return inserted_key is not null;
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
  )
  values (
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

create or replace function public.process_check_in_game_rewards()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_points integer := 0;
  difficulty_one text := coalesce(new.workout_difficulty ->> 'one', 'medium');
  difficulty_two text := coalesce(new.workout_difficulty ->> 'two', 'medium');
  points_inserted boolean := false;
  stats_row public.user_game_stats%rowtype;
  next_full_streak integer := 0;
  selected_badge_key text := null;
  selected_badge_metadata jsonb := '{}'::jsonb;
begin
  if new.challenge_day < 1 or new.challenge_day > 77 then
    raise exception 'The 77-day challenge is complete.';
  end if;

  if new.status = 'scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode = '22023';
  end if;

  if cardinality(new.completed) > 0 then
    new.completed_count := cardinality(new.completed);
  end if;

  action_points := least(greatest(new.completed_count, 0), 7);
  points_inserted := public.add_game_points(
    new.user_id,
    'check_in',
    action_points,
    new.entry_date,
    new.challenge_day,
    null,
    jsonb_build_object(
      'status', new.status,
      'completedCount', new.completed_count,
      'completed', new.completed,
      'workoutDifficulty', new.workout_difficulty,
      'actionPoints', action_points
    ),
    'checkin:' || new.user_id::text || ':' || new.entry_date::text
  );

  new.points_awarded := case when points_inserted then action_points else 0 end;

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
  select nullif(profile.time_zone, '') into target_time_zone
  from public.profiles profile where profile.user_id = target_user_id;
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
  select * into draft from public.challenge_entries entry
  where entry.user_id = target_user_id and entry.entry_date = target_entry_date;
  select exists (
    select 1 from public.check_ins check_in
    where check_in.user_id = target_user_id and check_in.entry_date = target_entry_date
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
  if auth.uid() is null then raise exception 'You need to log in to view Daily Standards.'; end if;
  if target_entry_date is null then raise exception 'Choose a valid challenge date.' using errcode = '22023'; end if;
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
  if auth.uid() is null then raise exception 'You need to log in to update Daily Standards.'; end if;
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
    where check_in.user_id = auth.uid() and check_in.entry_date = target_entry_date
  ) then
    raise exception 'This Check-In is already submitted.' using errcode = '55000';
  end if;
  insert into public.challenge_entries (user_id, entry_date, completed)
  values (auth.uid(), target_entry_date, '{}'::text[])
  on conflict (user_id, entry_date) do nothing;
  select * into draft from public.challenge_entries entry
  where entry.user_id = auth.uid() and entry.entry_date = target_entry_date for update;
  if exists (
    select 1 from public.check_ins check_in
    where check_in.user_id = auth.uid() and check_in.entry_date = target_entry_date
  ) then
    raise exception 'This Check-In is already submitted.' using errcode = '55000';
  end if;
  stale_write := target_expected_version is not null and target_expected_version <> draft.version;
  state_changed := (target_action_id = any(draft.completed)) is distinct from target_completed;
  if state_changed then
    update public.challenge_entries
    set
      completed = case
        when target_completed then array_append(completed, target_action_id)
        else array_remove(completed, target_action_id)
      end,
      version = version + 1
    where user_id = auth.uid() and entry_date = target_entry_date;
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
  if auth.uid() is null then raise exception 'You need to log in to update workout difficulty.'; end if;
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
    where check_in.user_id = auth.uid() and check_in.entry_date = target_entry_date
  ) then
    raise exception 'This Check-In is already submitted.' using errcode = '55000';
  end if;
  insert into public.challenge_entries (user_id, entry_date, completed)
  values (auth.uid(), target_entry_date, '{}'::text[])
  on conflict (user_id, entry_date) do nothing;
  select * into draft from public.challenge_entries entry
  where entry.user_id = auth.uid() and entry.entry_date = target_entry_date for update;
  if exists (
    select 1 from public.check_ins check_in
    where check_in.user_id = auth.uid() and check_in.entry_date = target_entry_date
  ) then
    raise exception 'This Check-In is already submitted.' using errcode = '55000';
  end if;
  stale_write := target_expected_version is not null and target_expected_version <> draft.version;
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
    where user_id = auth.uid() and entry_date = target_entry_date;
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

  select * into draft from public.challenge_entries entry
  where entry.user_id = new.user_id and entry.entry_date = new.entry_date for update;
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
revoke execute on function public.normalize_daily_standard_completed(text[]) from public;
revoke execute on function public.normalize_daily_standard_completed(text[]) from anon;
revoke execute on function public.normalize_daily_standard_completed(text[]) from authenticated;
revoke execute on function public.normalize_daily_standard_draft() from public;
revoke execute on function public.normalize_daily_standard_draft() from anon;
revoke execute on function public.normalize_daily_standard_draft() from authenticated;
revoke execute on function public.daily_standard_user_date(uuid) from public;
revoke execute on function public.daily_standard_user_date(uuid) from anon;
revoke execute on function public.daily_standard_user_date(uuid) from authenticated;
revoke execute on function public.daily_standard_draft_payload(uuid, date, boolean) from public;
revoke execute on function public.daily_standard_draft_payload(uuid, date, boolean) from anon;
revoke execute on function public.daily_standard_draft_payload(uuid, date, boolean) from authenticated;
revoke execute on function public.bootstrap_daily_standard_time_zone(text) from public;
revoke execute on function public.bootstrap_daily_standard_time_zone(text) from anon;
grant execute on function public.bootstrap_daily_standard_time_zone(text) to authenticated;
revoke execute on function public.get_daily_standard_draft(date) from public;
revoke execute on function public.get_daily_standard_draft(date) from anon;
grant execute on function public.get_daily_standard_draft(date) to authenticated;
revoke execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) from public;
revoke execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) from anon;
grant execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint) to authenticated;
revoke execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) from public;
revoke execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) from anon;
grant execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint) to authenticated;
revoke execute on function public.apply_authoritative_daily_standard_draft() from public;
revoke execute on function public.apply_authoritative_daily_standard_draft() from anon;
revoke execute on function public.apply_authoritative_daily_standard_draft() from authenticated;
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
revoke insert, update, delete on public.challenge_entries from authenticated;
revoke insert (user_id, entry_date, completed) on public.challenge_entries from authenticated;
revoke update (user_id, entry_date, completed) on public.challenge_entries from authenticated;
grant select on public.challenge_entries to authenticated;
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
grant select, insert, delete on public.post_likes to authenticated;
grant select, insert, delete on public.post_comments to authenticated;
grant update (body) on public.post_comments to authenticated;
grant select, insert, update, delete on public.journal_entries to authenticated;
grant select, insert, update, delete on public.journal_photos to authenticated;
grant select on public.badge_definitions to authenticated;
grant select on public.user_badges to authenticated;
grant select on public.user_game_stats to authenticated;
grant select on public.game_point_events to authenticated;
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

-- Retire global Community access without deleting historical social data.

drop function if exists public.get_global_leaderboard(text);

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
      and cp.scope = 'crew'
      and public.has_active_entitlement('membership_active')
      and public.is_crew_member(cp.crew_id)
  );
$$;

drop policy if exists "Authenticated users can read visible posts" on public.community_posts;
create policy "Authenticated users can read visible posts"
  on public.community_posts
  for select
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Users can create visible posts" on public.community_posts;
create policy "Users can create visible posts"
  on public.community_posts
  for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Authors can update own posts" on public.community_posts;
create policy "Authors can update own posts"
  on public.community_posts
  for update
  to authenticated
  using (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  )
  with check (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Authors and crew leaders can delete posts" on public.community_posts;
create policy "Authors and crew leaders can delete posts"
  on public.community_posts
  for delete
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and (
      author_id = (select auth.uid())
      or public.can_manage_crew(crew_id)
    )
  );

drop policy if exists "Users can remove own likes" on public.post_likes;
create policy "Users can remove own likes"
  on public.post_likes
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
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
    and public.can_read_community_post(post_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and public.can_read_community_post(post_id)
  );

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists private.integration_destinations (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews(id) on delete cascade,
  provider text not null check (provider in ('slack', 'discord')),
  provider_workspace_id text not null check (char_length(provider_workspace_id) between 1 and 200),
  provider_destination_id text not null check (char_length(provider_destination_id) between 1 and 200),
  display_name text not null default '' check (char_length(display_name) <= 200),
  credential_ciphertext bytea not null check (octet_length(credential_ciphertext) between 17 and 16384),
  credential_nonce bytea not null check (octet_length(credential_nonce) = 12),
  credential_key_version smallint not null check (credential_key_version > 0),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default '{}',
  status text not null default 'active'
    check (status in ('active', 'reconnect_required', 'disconnected', 'revoked')),
  installed_by uuid not null references auth.users(id) on delete restrict,
  installed_at timestamptz not null default now(),
  last_verified_at timestamptz,
  disconnected_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crew_id, provider, provider_workspace_id, provider_destination_id)
);

comment on table private.integration_destinations is
  'Server-only provider destinations. OAuth credentials are AES-256-GCM ciphertext; key material lives only in Edge Function secrets.';

create table if not exists private.outbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews(id) on delete cascade,
  destination_id uuid not null references private.integration_destinations(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 240),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 65536
  ),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry', 'delivered', 'dead_letter', 'cancelled')),
  priority smallint not null default 100 check (priority between 0 and 1000),
  available_at timestamptz not null default now(),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 8),
  lock_token uuid,
  locked_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  cancelled_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (destination_id, idempotency_key),
  check (
    (status = 'processing' and lock_token is not null and locked_at is not null)
    or (status <> 'processing' and lock_token is null and locked_at is null)
  )
);

comment on table private.outbound_deliveries is
  'Durable, private-group-scoped provider outbox. Publishing commits independently from provider delivery.';

create table if not exists private.integration_delivery_attempts (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references private.outbound_deliveries(id) on delete cascade,
  attempt_number smallint not null check (attempt_number > 0),
  outcome text not null check (outcome in ('delivered', 'retry', 'dead_letter', 'worker_timeout')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 200),
  retry_after_seconds integer check (retry_after_seconds is null or retry_after_seconds between 0 and 86400),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  error_summary text check (error_summary is null or char_length(error_summary) <= 500),
  response_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(response_metadata) = 'object'
    and octet_length(response_metadata::text) <= 8192
  ),
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  unique (delivery_id, attempt_number)
);

create index if not exists integration_destinations_crew_status_idx
  on private.integration_destinations (crew_id, status, provider);

create index if not exists outbound_deliveries_ready_idx
  on private.outbound_deliveries (priority, available_at, created_at)
  where status in ('queued', 'retry');

create index if not exists outbound_deliveries_crew_created_idx
  on private.outbound_deliveries (crew_id, created_at desc);

create index if not exists outbound_deliveries_dead_letter_idx
  on private.outbound_deliveries (dead_lettered_at desc)
  where status = 'dead_letter';

create index if not exists integration_delivery_attempts_delivery_idx
  on private.integration_delivery_attempts (delivery_id, attempt_number desc);

alter table private.integration_destinations enable row level security;
alter table private.outbound_deliveries enable row level security;
alter table private.integration_delivery_attempts enable row level security;

revoke all on all tables in schema private from public;
revoke all on all tables in schema private from anon;
revoke all on all tables in schema private from authenticated;
revoke all on all sequences in schema private from public;
revoke all on all sequences in schema private from anon;
revoke all on all sequences in schema private from authenticated;

drop trigger if exists set_integration_destinations_updated_at on private.integration_destinations;
create trigger set_integration_destinations_updated_at
  before update on private.integration_destinations
  for each row execute function public.set_updated_at();

drop trigger if exists set_outbound_deliveries_updated_at on private.outbound_deliveries;
create trigger set_outbound_deliveries_updated_at
  before update on private.outbound_deliveries
  for each row execute function public.set_updated_at();

create or replace function public.redact_integration_metadata(input jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  output jsonb;
begin
  if input is null then
    return '{}'::jsonb;
  end if;

  if jsonb_typeof(input) = 'object' then
    select coalesce(
      jsonb_object_agg(
        item.key,
        case
          when lower(item.key) ~ '(authorization|credential|secret|token|webhook|content|payload|body)'
            then '"[redacted]"'::jsonb
          else public.redact_integration_metadata(item.value)
        end
      ),
      '{}'::jsonb
    )
    into output
    from jsonb_each(input) item;
    return output;
  end if;

  if jsonb_typeof(input) = 'array' then
    select coalesce(jsonb_agg(public.redact_integration_metadata(item.value)), '[]'::jsonb)
    into output
    from jsonb_array_elements(input) item;
    return output;
  end if;

  return input;
end;
$$;

create or replace function private.redact_integration_destination_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  new.metadata := public.redact_integration_metadata(new.metadata);
  return new;
end;
$$;

drop trigger if exists redact_integration_destination_metadata
  on private.integration_destinations;
create trigger redact_integration_destination_metadata
  before insert or update of metadata on private.integration_destinations
  for each row execute function private.redact_integration_destination_metadata();

create or replace function public.enqueue_outbound_delivery(
  target_crew_id uuid,
  target_destination_id uuid,
  target_event_type text,
  target_idempotency_key text,
  target_payload jsonb,
  target_max_attempts integer default 5,
  target_available_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
  existing private.outbound_deliveries%rowtype;
  delivery_id uuid;
begin
  if target_crew_id is null or target_destination_id is null then
    raise exception 'A crew and destination are required.' using errcode = '22023';
  end if;
  if target_event_type is null or target_event_type !~ '^[a-z][a-z0-9_.-]{1,79}$' then
    raise exception 'Invalid integration event type.' using errcode = '22023';
  end if;
  if target_idempotency_key is null or char_length(target_idempotency_key) not between 8 and 240 then
    raise exception 'Invalid integration idempotency key.' using errcode = '22023';
  end if;
  if target_payload is null or jsonb_typeof(target_payload) <> 'object'
    or octet_length(target_payload::text) > 65536 then
    raise exception 'Invalid integration payload.' using errcode = '22023';
  end if;
  if target_max_attempts not between 1 and 8 then
    raise exception 'Invalid maximum attempt count.' using errcode = '22023';
  end if;

  select * into destination
  from private.integration_destinations
  where id = target_destination_id;

  if not found or destination.crew_id <> target_crew_id then
    raise exception 'The integration destination does not belong to this group.' using errcode = '42501';
  end if;
  if destination.status <> 'active' then
    raise exception 'The integration destination is not active.' using errcode = '55000';
  end if;

  select * into existing
  from private.outbound_deliveries
  where destination_id = target_destination_id
    and idempotency_key = target_idempotency_key;

  if found then
    if existing.crew_id <> target_crew_id
      or existing.event_type <> target_event_type
      or existing.payload <> target_payload then
      raise exception 'The idempotency key was reused with different delivery data.' using errcode = '23505';
    end if;
    return existing.id;
  end if;

  insert into private.outbound_deliveries (
    crew_id,
    destination_id,
    event_type,
    idempotency_key,
    payload,
    max_attempts,
    available_at
  ) values (
    target_crew_id,
    target_destination_id,
    target_event_type,
    target_idempotency_key,
    target_payload,
    target_max_attempts,
    coalesce(target_available_at, now())
  )
  on conflict (destination_id, idempotency_key) do nothing
  returning id into delivery_id;

  if delivery_id is not null then
    return delivery_id;
  end if;

  select * into existing
  from private.outbound_deliveries
  where destination_id = target_destination_id
    and idempotency_key = target_idempotency_key;

  if existing.crew_id <> target_crew_id
    or existing.event_type <> target_event_type
    or existing.payload <> target_payload then
    raise exception 'The idempotency key was reused with different delivery data.' using errcode = '23505';
  end if;
  return existing.id;
end;
$$;

create or replace function public.claim_outbound_deliveries(
  worker_token uuid,
  batch_size integer default 20
)
returns table (
  delivery_id uuid,
  crew_id uuid,
  destination_id uuid,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  event_type text,
  payload jsonb,
  attempt_number integer,
  max_attempts integer,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer
)
language sql
security definer
set search_path = public, private, pg_temp
as $$
  with candidates as (
    select queued.id
    from private.outbound_deliveries queued
    join private.integration_destinations destination
      on destination.id = queued.destination_id
    where queued.status in ('queued', 'retry')
      and queued.available_at <= now()
      and destination.status = 'active'
    order by queued.priority asc, queued.available_at asc, queued.created_at asc
    for update of queued skip locked
    limit least(greatest(coalesce(batch_size, 20), 1), 100)
  ), claimed as (
    update private.outbound_deliveries queued
    set status = 'processing',
        attempt_count = queued.attempt_count + 1,
        lock_token = worker_token,
        locked_at = now(),
        last_error_code = null,
        last_error_summary = null
    from candidates
    where queued.id = candidates.id
      and worker_token is not null
    returning queued.*
  )
  select
    claimed.id,
    claimed.crew_id,
    destination.id,
    destination.provider,
    destination.provider_workspace_id,
    destination.provider_destination_id,
    claimed.event_type,
    claimed.payload,
    claimed.attempt_count::integer,
    claimed.max_attempts::integer,
    destination.credential_ciphertext,
    destination.credential_nonce,
    destination.credential_key_version::integer
  from claimed
  join private.integration_destinations destination
    on destination.id = claimed.destination_id
  order by claimed.priority asc, claimed.available_at asc, claimed.created_at asc;
$$;

create or replace function public.settle_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid,
  target_outcome text,
  target_started_at timestamptz,
  target_http_status integer default null,
  target_provider_request_id text default null,
  target_retry_after_seconds integer default null,
  target_error_code text default null,
  target_error_summary text default null,
  target_response_metadata jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
  final_outcome text;
  retry_seconds integer;
begin
  if target_outcome not in ('delivered', 'retry', 'dead_letter') then
    raise exception 'Invalid delivery outcome.' using errcode = '22023';
  end if;
  if target_http_status is not null and target_http_status not between 100 and 599 then
    raise exception 'Invalid provider status.' using errcode = '22023';
  end if;

  select * into delivery
  from private.outbound_deliveries
  where id = target_delivery_id
  for update;

  if not found or delivery.status <> 'processing' or delivery.lock_token <> worker_token then
    raise exception 'The delivery is not owned by this worker.' using errcode = '55000';
  end if;

  final_outcome := target_outcome;
  if target_outcome = 'retry' and delivery.attempt_count >= delivery.max_attempts then
    final_outcome := 'dead_letter';
  end if;

  retry_seconds := case
    when final_outcome = 'retry' then least(
      greatest(
        coalesce(target_retry_after_seconds, (30 * power(2, delivery.attempt_count - 1))::integer),
        1
      ),
      86400
    )
    else null
  end;

  insert into private.integration_delivery_attempts (
    delivery_id,
    attempt_number,
    outcome,
    http_status,
    provider_request_id,
    retry_after_seconds,
    error_code,
    error_summary,
    response_metadata,
    started_at
  ) values (
    delivery.id,
    delivery.attempt_count,
    final_outcome,
    target_http_status,
    left(target_provider_request_id, 200),
    retry_seconds,
    left(target_error_code, 100),
    left(target_error_summary, 500),
    public.redact_integration_metadata(coalesce(target_response_metadata, '{}'::jsonb)),
    coalesce(target_started_at, delivery.locked_at, now())
  )
  on conflict (delivery_id, attempt_number) do nothing;

  update private.outbound_deliveries
  set status = case final_outcome
        when 'delivered' then 'delivered'
        when 'retry' then 'retry'
        else 'dead_letter'
      end,
      available_at = case when final_outcome = 'retry' then now() + make_interval(secs => retry_seconds) else available_at end,
      delivered_at = case when final_outcome = 'delivered' then now() else null end,
      dead_lettered_at = case when final_outcome = 'dead_letter' then now() else null end,
      last_error_code = case when final_outcome = 'delivered' then null else left(target_error_code, 100) end,
      last_error_summary = case when final_outcome = 'delivered' then null else left(target_error_summary, 500) end,
      lock_token = null,
      locked_at = null
  where id = delivery.id;

  return final_outcome;
end;
$$;

create or replace function public.release_stale_outbound_deliveries(
  stale_after interval default interval '5 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
  released integer := 0;
  release_outcome text;
begin
  if stale_after < interval '1 minute' or stale_after > interval '1 day' then
    raise exception 'Invalid stale-delivery window.' using errcode = '22023';
  end if;

  for delivery in
    select *
    from private.outbound_deliveries
    where status = 'processing'
      and locked_at < now() - stale_after
    order by locked_at asc
    for update skip locked
  loop
    release_outcome := case
      when delivery.attempt_count >= delivery.max_attempts then 'dead_letter'
      else 'worker_timeout'
    end;

    insert into private.integration_delivery_attempts (
      delivery_id,
      attempt_number,
      outcome,
      retry_after_seconds,
      error_code,
      error_summary,
      started_at
    ) values (
      delivery.id,
      delivery.attempt_count,
      release_outcome,
      case when release_outcome = 'worker_timeout' then 60 else null end,
      'worker_timeout',
      'The delivery worker did not settle its lock before the timeout.',
      delivery.locked_at
    )
    on conflict (delivery_id, attempt_number) do nothing;

    update private.outbound_deliveries
    set status = case when release_outcome = 'dead_letter' then 'dead_letter' else 'retry' end,
        available_at = case when release_outcome = 'dead_letter' then available_at else now() + interval '1 minute' end,
        dead_lettered_at = case when release_outcome = 'dead_letter' then now() else null end,
        last_error_code = 'worker_timeout',
        last_error_summary = 'The delivery worker did not settle its lock before the timeout.',
        lock_token = null,
        locked_at = null
    where id = delivery.id;

    released := released + 1;
  end loop;

  return released;
end;
$$;

create or replace function public.integration_delivery_health()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'queued', count(*) filter (where status in ('queued', 'retry')),
    'processing', count(*) filter (where status = 'processing'),
    'deadLettersLast24Hours', count(*) filter (
      where status = 'dead_letter' and dead_lettered_at >= now() - interval '24 hours'
    ),
    'oldestReadyAt', min(available_at) filter (
      where status in ('queued', 'retry') and available_at <= now()
    ),
    'generatedAt', now()
  )
  from private.outbound_deliveries;
$$;

create or replace function public.purge_integration_delivery_history()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  redacted_payloads integer;
  redacted_attempts integer;
  deleted_deliveries integer;
begin
  update private.outbound_deliveries
  set payload = jsonb_build_object('redacted', true, 'eventType', event_type)
  where status = 'delivered'
    and delivered_at < now() - interval '7 days'
    and payload <> jsonb_build_object('redacted', true, 'eventType', event_type);
  get diagnostics redacted_payloads = row_count;

  update private.integration_delivery_attempts
  set response_metadata = '{"redacted":true}'::jsonb,
      error_summary = null
  where completed_at < now() - interval '30 days'
    and (response_metadata <> '{"redacted":true}'::jsonb or error_summary is not null);
  get diagnostics redacted_attempts = row_count;

  delete from private.outbound_deliveries
  where status in ('delivered', 'dead_letter', 'cancelled')
    and coalesce(delivered_at, dead_lettered_at, cancelled_at, updated_at) < now() - interval '90 days';
  get diagnostics deleted_deliveries = row_count;

  return jsonb_build_object(
    'redactedPayloads', redacted_payloads,
    'redactedAttempts', redacted_attempts,
    'deletedDeliveries', deleted_deliveries
  );
end;
$$;

revoke all on function public.redact_integration_metadata(jsonb) from public, anon, authenticated;
revoke all on function private.redact_integration_destination_metadata() from public, anon, authenticated;
revoke all on function public.enqueue_outbound_delivery(uuid, uuid, text, text, jsonb, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_outbound_deliveries(uuid, integer) from public, anon, authenticated;
revoke all on function public.settle_outbound_delivery(uuid, uuid, text, timestamptz, integer, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_stale_outbound_deliveries(interval) from public, anon, authenticated;
revoke all on function public.integration_delivery_health() from public, anon, authenticated;
revoke all on function public.purge_integration_delivery_history() from public, anon, authenticated;

grant execute on function public.enqueue_outbound_delivery(uuid, uuid, text, text, jsonb, integer, timestamptz) to service_role;
grant execute on function public.claim_outbound_deliveries(uuid, integer) to service_role;
grant execute on function public.settle_outbound_delivery(uuid, uuid, text, timestamptz, integer, text, integer, text, text, jsonb) to service_role;
grant execute on function public.release_stale_outbound_deliveries(interval) to service_role;
grant execute on function public.integration_delivery_health() to service_role;
grant execute on function public.purge_integration_delivery_history() to service_role;

alter table private.integration_destinations
  alter column credential_ciphertext drop not null,
  alter column credential_nonce drop not null,
  alter column credential_key_version drop not null,
  alter column credential_fingerprint drop not null;

alter table private.integration_destinations
  add column if not exists provider_workspace_name text not null default ''
    check (char_length(provider_workspace_name) <= 200),
  add column if not exists last_tested_at timestamptz,
  add column if not exists last_delivered_at timestamptz;

alter table private.integration_destinations
  drop constraint if exists integration_destinations_active_credentials_check;
alter table private.integration_destinations
  add constraint integration_destinations_active_credentials_check check (
    status <> 'active'
    or (
      credential_ciphertext is not null
      and credential_nonce is not null
      and credential_key_version is not null
      and credential_fingerprint is not null
    )
  );

create unique index if not exists integration_destinations_crew_provider_unique
  on private.integration_destinations (crew_id, provider);

create table if not exists private.integration_oauth_states (
  nonce_hash text primary key check (nonce_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('slack', 'discord')),
  crew_id uuid not null references public.crews(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete cascade,
  return_path text not null default '/community.html'
    check (return_path = '/community.html'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.pending_integration_connections (
  id uuid primary key,
  setup_token_hash text not null unique check (setup_token_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('slack', 'discord')),
  crew_id uuid not null references public.crews(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete cascade,
  provider_workspace_id text not null check (char_length(provider_workspace_id) between 1 and 200),
  provider_workspace_name text not null default '' check (char_length(provider_workspace_name) <= 200),
  credential_ciphertext bytea not null check (octet_length(credential_ciphertext) between 17 and 16384),
  credential_nonce bytea not null check (octet_length(credential_nonce) = 12),
  credential_key_version smallint not null check (credential_key_version > 0),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.integration_connection_audit (
  id bigint generated always as identity primary key,
  crew_id uuid not null references public.crews(id) on delete cascade,
  destination_id uuid references private.integration_destinations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  provider text not null check (provider in ('slack', 'discord')),
  action text not null check (
    action in (
      'authorization_started',
      'authorization_completed',
      'connected',
      'reconnected',
      'test_succeeded',
      'needs_attention',
      'disconnected'
    )
  ),
  outcome text not null default 'succeeded' check (outcome in ('succeeded', 'failed')),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 8192
  ),
  created_at timestamptz not null default now()
);

create index if not exists integration_oauth_states_expires_idx
  on private.integration_oauth_states (expires_at);
create index if not exists pending_integration_connections_expires_idx
  on private.pending_integration_connections (expires_at);
create index if not exists integration_connection_audit_crew_created_idx
  on private.integration_connection_audit (crew_id, created_at desc);

alter table private.integration_oauth_states enable row level security;
alter table private.pending_integration_connections enable row level security;
alter table private.integration_connection_audit enable row level security;

revoke all on private.integration_oauth_states from public, anon, authenticated;
revoke all on private.pending_integration_connections from public, anon, authenticated;
revoke all on private.integration_connection_audit from public, anon, authenticated;
revoke all on sequence private.integration_connection_audit_id_seq from public, anon, authenticated;

create or replace function private.record_integration_connection_audit(
  target_crew_id uuid,
  target_destination_id uuid,
  target_actor_id uuid,
  target_provider text,
  target_action text,
  target_outcome text default 'succeeded',
  target_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public, private, pg_temp
as $$
  insert into private.integration_connection_audit (
    crew_id,
    destination_id,
    actor_id,
    provider,
    action,
    outcome,
    metadata
  ) values (
    target_crew_id,
    target_destination_id,
    target_actor_id,
    target_provider,
    target_action,
    target_outcome,
    public.redact_integration_metadata(coalesce(target_metadata, '{}'::jsonb))
  );
$$;

create or replace function public.create_integration_oauth_state(
  target_user_id uuid,
  target_crew_id uuid,
  target_provider text,
  target_nonce_hash text,
  target_return_path text,
  target_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if target_provider not in ('slack', 'discord')
    or target_nonce_hash !~ '^[a-f0-9]{64}$'
    or target_return_path <> '/community.html'
    or target_expires_at < now() + interval '1 minute'
    or target_expires_at > now() + interval '15 minutes' then
    raise exception 'Invalid integration authorization state.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = target_user_id
      and crew_member.role in ('owner', 'admin')
  ) then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  delete from private.integration_oauth_states
  where expires_at < now() - interval '1 day';

  insert into private.integration_oauth_states (
    nonce_hash,
    provider,
    crew_id,
    initiated_by,
    return_path,
    expires_at
  ) values (
    target_nonce_hash,
    target_provider,
    target_crew_id,
    target_user_id,
    target_return_path,
    target_expires_at
  );

  perform private.record_integration_connection_audit(
    target_crew_id,
    null,
    target_user_id,
    target_provider,
    'authorization_started'
  );
  return true;
end;
$$;

create or replace function public.consume_integration_oauth_state(
  target_provider text,
  target_nonce_hash text
)
returns table (
  user_id uuid,
  crew_id uuid,
  return_path text
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  oauth_state private.integration_oauth_states%rowtype;
begin
  update private.integration_oauth_states
  set consumed_at = now()
  where nonce_hash = target_nonce_hash
    and provider = target_provider
    and consumed_at is null
    and expires_at > now()
  returning * into oauth_state;

  if not found then
    raise exception 'Integration authorization state is invalid, expired, or already used.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.crew_members crew_member
    where crew_member.crew_id = oauth_state.crew_id
      and crew_member.user_id = oauth_state.initiated_by
      and crew_member.role in ('owner', 'admin')
  ) then
    raise exception 'Integration administrator access is no longer active.' using errcode = '42501';
  end if;

  return query select
    oauth_state.initiated_by,
    oauth_state.crew_id,
    oauth_state.return_path;
end;
$$;

create or replace function public.create_pending_integration_connection(
  target_pending_id uuid,
  target_setup_token_hash text,
  target_provider text,
  target_crew_id uuid,
  target_user_id uuid,
  target_workspace_id text,
  target_workspace_name text,
  target_credential_ciphertext bytea,
  target_credential_nonce bytea,
  target_credential_key_version integer,
  target_credential_fingerprint text,
  target_scopes text[],
  target_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if target_provider not in ('slack', 'discord')
    or target_setup_token_hash !~ '^[a-f0-9]{64}$'
    or target_expires_at < now() + interval '1 minute'
    or target_expires_at > now() + interval '20 minutes' then
    raise exception 'Invalid pending integration connection.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = target_user_id
      and crew_member.role in ('owner', 'admin')
  ) then
    raise exception 'Integration administrator access is no longer active.' using errcode = '42501';
  end if;

  delete from private.pending_integration_connections
  where expires_at < now() - interval '1 day';

  insert into private.pending_integration_connections (
    id,
    setup_token_hash,
    provider,
    crew_id,
    initiated_by,
    provider_workspace_id,
    provider_workspace_name,
    credential_ciphertext,
    credential_nonce,
    credential_key_version,
    credential_fingerprint,
    scopes,
    expires_at
  ) values (
    target_pending_id,
    target_setup_token_hash,
    target_provider,
    target_crew_id,
    target_user_id,
    target_workspace_id,
    coalesce(target_workspace_name, ''),
    target_credential_ciphertext,
    target_credential_nonce,
    target_credential_key_version,
    target_credential_fingerprint,
    coalesce(target_scopes, '{}'),
    target_expires_at
  );

  perform private.record_integration_connection_audit(
    target_crew_id,
    null,
    target_user_id,
    target_provider,
    'authorization_completed'
  );
  return target_pending_id;
end;
$$;

create or replace function public.get_pending_integration_connection(
  target_setup_token_hash text,
  target_user_id uuid
)
returns table (
  pending_id uuid,
  provider text,
  crew_id uuid,
  provider_workspace_id text,
  provider_workspace_name text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer,
  credential_fingerprint text,
  scopes text[]
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not exists (
    select 1
    from private.pending_integration_connections pending
    join public.crew_members crew_member
      on crew_member.crew_id = pending.crew_id
     and crew_member.user_id = target_user_id
     and crew_member.role in ('owner', 'admin')
    where pending.setup_token_hash = target_setup_token_hash
      and pending.initiated_by = target_user_id
      and pending.consumed_at is null
      and pending.expires_at > now()
  ) then
    raise exception 'Pending integration setup is invalid or expired.' using errcode = '42501';
  end if;

  return query
    select
      pending.id,
      pending.provider,
      pending.crew_id,
      pending.provider_workspace_id,
      pending.provider_workspace_name,
      pending.credential_ciphertext,
      pending.credential_nonce,
      pending.credential_key_version::integer,
      pending.credential_fingerprint,
      pending.scopes
    from private.pending_integration_connections pending
    where pending.setup_token_hash = target_setup_token_hash
      and pending.initiated_by = target_user_id
      and pending.consumed_at is null
      and pending.expires_at > now();
end;
$$;

create or replace function public.prepare_integration_destination_id(
  target_crew_id uuid,
  target_provider text,
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination_id uuid;
begin
  if not exists (
    select 1 from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = target_user_id
      and crew_member.role in ('owner', 'admin')
  ) then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  select destination.id into destination_id
  from private.integration_destinations destination
  where destination.crew_id = target_crew_id
    and destination.provider = target_provider;

  return coalesce(destination_id, gen_random_uuid());
end;
$$;

create or replace function public.complete_pending_integration_connection(
  target_setup_token_hash text,
  target_user_id uuid,
  target_destination_id uuid,
  target_provider_destination_id text,
  target_destination_name text,
  target_credential_ciphertext bytea,
  target_credential_nonce bytea,
  target_credential_key_version integer,
  target_credential_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  pending private.pending_integration_connections%rowtype;
  existing_id uuid;
  connection_action text;
begin
  select * into pending
  from private.pending_integration_connections
  where setup_token_hash = target_setup_token_hash
    and initiated_by = target_user_id
    and consumed_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Pending integration setup is invalid or expired.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.crew_members crew_member
    where crew_member.crew_id = pending.crew_id
      and crew_member.user_id = target_user_id
      and crew_member.role in ('owner', 'admin')
  ) then
    raise exception 'Integration administrator access is no longer active.' using errcode = '42501';
  end if;

  select destination.id into existing_id
  from private.integration_destinations destination
  where destination.crew_id = pending.crew_id
    and destination.provider = pending.provider;

  if existing_id is not null and existing_id <> target_destination_id then
    raise exception 'The integration destination changed during confirmation.' using errcode = '40001';
  end if;
  connection_action := case when existing_id is null then 'connected' else 'reconnected' end;

  insert into private.integration_destinations (
    id,
    crew_id,
    provider,
    provider_workspace_id,
    provider_workspace_name,
    provider_destination_id,
    display_name,
    credential_ciphertext,
    credential_nonce,
    credential_key_version,
    credential_fingerprint,
    scopes,
    status,
    installed_by,
    installed_at,
    last_verified_at,
    disconnected_at,
    last_error_code,
    last_error_summary
  ) values (
    target_destination_id,
    pending.crew_id,
    pending.provider,
    pending.provider_workspace_id,
    pending.provider_workspace_name,
    target_provider_destination_id,
    coalesce(target_destination_name, ''),
    target_credential_ciphertext,
    target_credential_nonce,
    target_credential_key_version,
    target_credential_fingerprint,
    pending.scopes,
    'active',
    target_user_id,
    now(),
    now(),
    null,
    null,
    null
  )
  on conflict (crew_id, provider) do update set
    provider_workspace_id = excluded.provider_workspace_id,
    provider_workspace_name = excluded.provider_workspace_name,
    provider_destination_id = excluded.provider_destination_id,
    display_name = excluded.display_name,
    credential_ciphertext = excluded.credential_ciphertext,
    credential_nonce = excluded.credential_nonce,
    credential_key_version = excluded.credential_key_version,
    credential_fingerprint = excluded.credential_fingerprint,
    scopes = excluded.scopes,
    status = 'active',
    installed_by = excluded.installed_by,
    installed_at = now(),
    last_verified_at = now(),
    disconnected_at = null,
    last_error_code = null,
    last_error_summary = null;

  update private.pending_integration_connections
  set consumed_at = now(),
      credential_ciphertext = decode(repeat('00', 17), 'hex'),
      credential_nonce = decode(repeat('00', 12), 'hex'),
      credential_fingerprint = repeat('0', 64),
      scopes = '{}'
  where id = pending.id;

  perform private.record_integration_connection_audit(
    pending.crew_id,
    target_destination_id,
    target_user_id,
    pending.provider,
    connection_action,
    'succeeded',
    jsonb_build_object(
      'workspaceId', pending.provider_workspace_id,
      'destinationId', target_provider_destination_id
    )
  );
  return target_destination_id;
end;
$$;

create or replace function public.list_crew_integration_destinations(
  target_crew_id uuid
)
returns table (
  destination_id uuid,
  provider text,
  workspace_id text,
  workspace_name text,
  channel_id text,
  channel_name text,
  status text,
  last_verified_at timestamptz,
  last_tested_at timestamptz,
  last_delivered_at timestamptz,
  health_code text,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not public.is_crew_member(target_crew_id) then
    raise exception 'This private group is not available.' using errcode = '42501';
  end if;

  return query
    select
      destination.id,
      destination.provider,
      destination.provider_workspace_id,
      destination.provider_workspace_name,
      destination.provider_destination_id,
      destination.display_name,
      destination.status,
      destination.last_verified_at,
      destination.last_tested_at,
      destination.last_delivered_at,
      destination.last_error_code,
      public.can_manage_crew(target_crew_id)
    from private.integration_destinations destination
    where destination.crew_id = target_crew_id
    order by destination.provider;
end;
$$;

create or replace function public.get_integration_destination_secret(
  target_destination_id uuid,
  target_user_id uuid
)
returns table (
  destination_id uuid,
  crew_id uuid,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  status text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer,
  credential_fingerprint text,
  revoke_safe boolean
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not exists (
    select 1
    from private.integration_destinations destination
    join public.crew_members crew_member on crew_member.crew_id = destination.crew_id
    where destination.id = target_destination_id
      and crew_member.user_id = target_user_id
      and crew_member.role in ('owner', 'admin')
  ) then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  return query
    select
      destination.id,
      destination.crew_id,
      destination.provider,
      destination.provider_workspace_id,
      destination.provider_destination_id,
      destination.status,
      destination.credential_ciphertext,
      destination.credential_nonce,
      destination.credential_key_version::integer,
      destination.credential_fingerprint,
      not exists (
        select 1
        from private.integration_destinations other
        where other.id <> destination.id
          and other.provider = destination.provider
          and other.provider_workspace_id = destination.provider_workspace_id
          and other.status = 'active'
      )
    from private.integration_destinations destination
    where destination.id = target_destination_id;
end;
$$;

create or replace function public.mark_integration_destination_health(
  target_destination_id uuid,
  target_user_id uuid,
  target_healthy boolean,
  target_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
begin
  select destination_row.* into destination
  from private.integration_destinations destination_row
  join public.crew_members crew_member on crew_member.crew_id = destination_row.crew_id
  where destination_row.id = target_destination_id
    and crew_member.user_id = target_user_id
    and crew_member.role in ('owner', 'admin')
  for update of destination_row;

  if not found then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  update private.integration_destinations
  set status = case when target_healthy then 'active' else 'reconnect_required' end,
      last_tested_at = case when target_healthy then now() else last_tested_at end,
      last_verified_at = case when target_healthy then now() else last_verified_at end,
      last_error_code = case when target_healthy then null else left(coalesce(target_error_code, 'provider_unavailable'), 100) end,
      last_error_summary = null
  where id = target_destination_id;

  perform private.record_integration_connection_audit(
    destination.crew_id,
    destination.id,
    target_user_id,
    destination.provider,
    case when target_healthy then 'test_succeeded' else 'needs_attention' end,
    case when target_healthy then 'succeeded' else 'failed' end,
    jsonb_build_object('errorCode', target_error_code)
  );
  return true;
end;
$$;

create or replace function public.disconnect_integration_destination(
  target_destination_id uuid,
  target_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
begin
  select destination_row.* into destination
  from private.integration_destinations destination_row
  join public.crew_members crew_member on crew_member.crew_id = destination_row.crew_id
  where destination_row.id = target_destination_id
    and crew_member.user_id = target_user_id
    and crew_member.role in ('owner', 'admin')
  for update of destination_row;

  if not found then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  update private.integration_destinations
  set status = 'disconnected',
      credential_ciphertext = null,
      credential_nonce = null,
      credential_key_version = null,
      credential_fingerprint = null,
      scopes = '{}',
      disconnected_at = now(),
      last_error_code = null,
      last_error_summary = null
  where id = target_destination_id;

  update private.outbound_deliveries
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = 'destination_disconnected',
      last_error_summary = 'The integration destination was disconnected.'
  where destination_id = target_destination_id
    and status in ('queued', 'retry');

  perform private.record_integration_connection_audit(
    destination.crew_id,
    destination.id,
    target_user_id,
    destination.provider,
    'disconnected'
  );
  return true;
end;
$$;

create or replace function public.validate_claimed_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from private.outbound_deliveries delivery
    join private.integration_destinations destination
      on destination.id = delivery.destination_id
    where delivery.id = target_delivery_id
      and delivery.status = 'processing'
      and delivery.lock_token = worker_token
      and destination.status = 'active'
      and destination.credential_ciphertext is not null
  );
$$;

create or replace function private.record_integration_delivery_health()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.status = 'delivered' and old.status is distinct from new.status then
    update private.integration_destinations
    set last_delivered_at = coalesce(new.delivered_at, now()),
        last_verified_at = coalesce(new.delivered_at, now()),
        last_error_code = null,
        last_error_summary = null
    where id = new.destination_id
      and status = 'active';
  elsif new.status = 'dead_letter'
    and old.status is distinct from new.status
    and new.last_error_code in (
      'provider_authorization_failed',
      'provider_destination_missing',
      'provider_rejected'
    ) then
    update private.integration_destinations
    set status = 'reconnect_required',
        last_error_code = new.last_error_code,
        last_error_summary = null
    where id = new.destination_id
      and status = 'active';

    if found then
      perform private.record_integration_connection_audit(
        new.crew_id,
        new.destination_id,
        null,
        (select provider from private.integration_destinations where id = new.destination_id),
        'needs_attention',
        'failed',
        jsonb_build_object('errorCode', new.last_error_code)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists record_integration_delivery_health
  on private.outbound_deliveries;
create trigger record_integration_delivery_health
  after update of status on private.outbound_deliveries
  for each row execute function private.record_integration_delivery_health();

create or replace function public.purge_integration_connection_setup()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  deleted_states integer;
  deleted_pending integer;
begin
  delete from private.integration_oauth_states
  where expires_at < now() - interval '1 day';
  get diagnostics deleted_states = row_count;

  delete from private.pending_integration_connections
  where expires_at < now() - interval '1 day';
  get diagnostics deleted_pending = row_count;

  return jsonb_build_object(
    'deletedOAuthStates', deleted_states,
    'deletedPendingConnections', deleted_pending
  );
end;
$$;

revoke all on function private.record_integration_connection_audit(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.create_integration_oauth_state(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_integration_oauth_state(text, text) from public, anon, authenticated;
revoke all on function public.create_pending_integration_connection(uuid, text, text, uuid, uuid, text, text, bytea, bytea, integer, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.get_pending_integration_connection(text, uuid) from public, anon, authenticated;
revoke all on function public.prepare_integration_destination_id(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_pending_integration_connection(text, uuid, uuid, text, text, bytea, bytea, integer, text) from public, anon, authenticated;
revoke all on function public.list_crew_integration_destinations(uuid) from public, anon;
revoke all on function public.get_integration_destination_secret(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_integration_destination_health(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.disconnect_integration_destination(uuid, uuid) from public, anon, authenticated;
revoke all on function public.validate_claimed_outbound_delivery(uuid, uuid) from public, anon, authenticated;
revoke all on function private.record_integration_delivery_health() from public, anon, authenticated;
revoke all on function public.purge_integration_connection_setup() from public, anon, authenticated;

grant execute on function public.create_integration_oauth_state(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.consume_integration_oauth_state(text, text) to service_role;
grant execute on function public.create_pending_integration_connection(uuid, text, text, uuid, uuid, text, text, bytea, bytea, integer, text, text[], timestamptz) to service_role;
grant execute on function public.get_pending_integration_connection(text, uuid) to service_role;
grant execute on function public.prepare_integration_destination_id(uuid, text, uuid) to service_role;
grant execute on function public.complete_pending_integration_connection(text, uuid, uuid, text, text, bytea, bytea, integer, text) to service_role;
grant execute on function public.list_crew_integration_destinations(uuid) to authenticated;
grant execute on function public.get_integration_destination_secret(uuid, uuid) to service_role;
grant execute on function public.mark_integration_destination_health(uuid, uuid, boolean, text) to service_role;
grant execute on function public.disconnect_integration_destination(uuid, uuid) to service_role;
grant execute on function public.validate_claimed_outbound_delivery(uuid, uuid) to service_role;
grant execute on function public.purge_integration_connection_setup() to service_role;

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
    from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = effective_user_id
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
    from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = caller_user_id
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

-- Canonical, consent-aware outbound events for private-group Slack and Discord
-- destinations. Delivery rows carry only the minimum structured facts needed
-- by the server-side renderer; journal, prayer, post, comment, and free-form
-- content is never accepted by this event layer.

alter table private.integration_destinations
  add column if not exists check_ins_enabled boolean not null default false,
  add column if not exists streak_milestones_enabled boolean not null default false,
  add column if not exists badges_rewards_enabled boolean not null default false,
  add column if not exists membership_enabled boolean not null default false,
  add column if not exists recap_cadence text not null default 'off',
  add column if not exists include_safe_link boolean not null default true;

alter table private.integration_destinations
  drop constraint if exists integration_destinations_recap_cadence_check;
alter table private.integration_destinations
  add constraint integration_destinations_recap_cadence_check
  check (recap_cadence in ('off', 'weekly'));

alter table private.outbound_deliveries
  add column if not exists subject_user_id uuid,
  add column if not exists source_reference text;

alter table private.outbound_deliveries
  drop constraint if exists outbound_deliveries_source_reference_check;
alter table private.outbound_deliveries
  add constraint outbound_deliveries_source_reference_check check (
    source_reference is null
    or char_length(source_reference) between 1 and 240
  );

comment on column private.outbound_deliveries.subject_user_id is
  'Send-time consent subject. Deliberately has no account foreign key so queued rows can be cancelled after account deletion.';
comment on column private.outbound_deliveries.source_reference is
  'Private, non-message source identifier used for auditability and idempotency; never rendered to providers.';

create index if not exists outbound_deliveries_subject_status_idx
  on private.outbound_deliveries (subject_user_id, crew_id, status)
  where subject_user_id is not null and status in ('queued', 'retry', 'processing');

alter table private.integration_delivery_attempts
  drop constraint if exists integration_delivery_attempts_outcome_check;
alter table private.integration_delivery_attempts
  add constraint integration_delivery_attempts_outcome_check check (
    outcome in ('delivered', 'retry', 'dead_letter', 'worker_timeout', 'cancelled')
  );

create or replace function private.outbound_event_payload_is_safe(
  target_event_type text,
  target_payload jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, private, pg_temp
as $$
declare
  numeric_value numeric;
begin
  if target_payload is null
    or jsonb_typeof(target_payload) <> 'object'
    or octet_length(target_payload::text) > 8192 then
    return false;
  end if;

  if target_event_type = 'check_in' then
    if not (target_payload ?& array['challengeDay', 'status', 'completedCount'])
      or target_payload - array['challengeDay', 'status', 'completedCount'] <> '{}'::jsonb
      or jsonb_typeof(target_payload -> 'challengeDay') <> 'number'
      or jsonb_typeof(target_payload -> 'status') <> 'string'
      or jsonb_typeof(target_payload -> 'completedCount') <> 'number'
      or (target_payload ->> 'status') not in ('complete', 'partial') then
      return false;
    end if;
    numeric_value := (target_payload ->> 'challengeDay')::numeric;
    if numeric_value <> trunc(numeric_value) or numeric_value not between 1 and 77 then
      return false;
    end if;
    numeric_value := (target_payload ->> 'completedCount')::numeric;
    return numeric_value = trunc(numeric_value) and numeric_value between 0 and 7;
  end if;

  if target_event_type = 'streak_milestone' then
    if not (target_payload ?& array['streakType', 'milestone'])
      or target_payload - array['streakType', 'milestone'] <> '{}'::jsonb
      or jsonb_typeof(target_payload -> 'streakType') <> 'string'
      or (target_payload ->> 'streakType') not in ('app', 'full_standard')
      or jsonb_typeof(target_payload -> 'milestone') <> 'number' then
      return false;
    end if;
    numeric_value := (target_payload ->> 'milestone')::numeric;
    return numeric_value = trunc(numeric_value) and numeric_value between 1 and 10000;
  end if;

  if target_event_type = 'badge_reward' then
    return target_payload ?& array['rewardKind', 'rewardName']
      and target_payload - array['rewardKind', 'rewardName'] = '{}'::jsonb
      and jsonb_typeof(target_payload -> 'rewardKind') = 'string'
      and (target_payload ->> 'rewardKind') in ('badge', 'challenge')
      and jsonb_typeof(target_payload -> 'rewardName') = 'string'
      and char_length(btrim(target_payload ->> 'rewardName')) between 1 and 100;
  end if;

  if target_event_type = 'membership' then
    return target_payload = '{}'::jsonb;
  end if;

  if target_event_type = 'leaderboard_recap' then
    if not (target_payload ?& array['periodLabel', 'memberCount', 'checkInCount', 'completedStandards'])
      or target_payload - array['periodLabel', 'memberCount', 'checkInCount', 'completedStandards'] <> '{}'::jsonb
      or jsonb_typeof(target_payload -> 'periodLabel') <> 'string'
      or char_length(btrim(target_payload ->> 'periodLabel')) not between 1 and 40
      or jsonb_typeof(target_payload -> 'memberCount') <> 'number'
      or jsonb_typeof(target_payload -> 'checkInCount') <> 'number'
      or jsonb_typeof(target_payload -> 'completedStandards') <> 'number' then
      return false;
    end if;
    numeric_value := (target_payload ->> 'memberCount')::numeric;
    if numeric_value <> trunc(numeric_value) or numeric_value not between 0 and 100000 then
      return false;
    end if;
    numeric_value := (target_payload ->> 'checkInCount')::numeric;
    if numeric_value <> trunc(numeric_value) or numeric_value not between 0 and 1000000 then
      return false;
    end if;
    numeric_value := (target_payload ->> 'completedStandards')::numeric;
    return numeric_value = trunc(numeric_value) and numeric_value between 0 and 7000000;
  end if;

  if target_event_type = 'synthetic.delivery' then
    return target_payload ? 'text'
      and target_payload - 'text' = '{}'::jsonb
      and jsonb_typeof(target_payload -> 'text') = 'string'
      and char_length(btrim(target_payload ->> 'text')) between 1 and 2000;
  end if;

  return false;
exception
  when numeric_value_out_of_range or invalid_text_representation then
    return false;
end;
$$;

create or replace function private.enqueue_crew_outbound_event(
  target_user_id uuid,
  target_event_type text,
  target_source_reference text,
  target_payload jsonb,
  target_only_crew_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination record;
  delivery_id uuid;
  queued_count integer := 0;
  delivery_key text;
begin
  if target_user_id is null
    or target_source_reference is null
    or char_length(target_source_reference) not between 1 and 240
    or target_event_type not in ('check_in', 'streak_milestone', 'badge_reward', 'membership')
    or not private.outbound_event_payload_is_safe(target_event_type, target_payload) then
    raise exception 'Invalid canonical outbound event.' using errcode = '22023';
  end if;

  delivery_key := 'canonical:' || target_event_type || ':'
    || encode(extensions.digest(target_event_type || ':' || target_source_reference, 'sha256'), 'hex');

  for destination in
    select provider_destination.id, provider_destination.crew_id
    from public.crew_members crew_member
    join public.outbound_update_preferences preference
      on preference.crew_id = crew_member.crew_id
      and preference.user_id = crew_member.user_id
    join private.integration_destinations provider_destination
      on provider_destination.crew_id = crew_member.crew_id
    where crew_member.user_id = target_user_id
      and (target_only_crew_id is null or crew_member.crew_id = target_only_crew_id)
      and preference.outbound_updates_enabled
      and provider_destination.status = 'active'
      and case target_event_type
        when 'check_in' then preference.share_check_ins and provider_destination.check_ins_enabled
        when 'streak_milestone' then preference.share_streak_milestones and provider_destination.streak_milestones_enabled
        when 'badge_reward' then preference.share_badges_rewards and provider_destination.badges_rewards_enabled
        when 'membership' then preference.share_membership_events and provider_destination.membership_enabled
        else false
      end
    order by provider_destination.id
    for key share of provider_destination
  loop
    delivery_id := null;
    insert into private.outbound_deliveries (
      crew_id,
      destination_id,
      subject_user_id,
      source_reference,
      event_type,
      idempotency_key,
      payload,
      max_attempts,
      available_at
    ) values (
      destination.crew_id,
      destination.id,
      target_user_id,
      target_source_reference,
      target_event_type,
      delivery_key,
      target_payload,
      5,
      now()
    )
    on conflict (destination_id, idempotency_key) do nothing
    returning id into delivery_id;

    if delivery_id is null then
      perform 1
      from private.outbound_deliveries existing
      where existing.destination_id = destination.id
        and existing.idempotency_key = delivery_key
        and existing.crew_id = destination.crew_id
        and existing.subject_user_id = target_user_id
        and existing.source_reference = target_source_reference
        and existing.event_type = target_event_type
        and existing.payload = target_payload;
    end if;

    if delivery_id is null and not found then
      raise exception 'Canonical event identity conflicted with an existing delivery.' using errcode = '23505';
    end if;

    queued_count := queued_count + 1;
  end loop;

  return queued_count;
end;
$$;

revoke all on function private.outbound_event_payload_is_safe(text, jsonb) from public, anon, authenticated;
revoke all on function private.enqueue_crew_outbound_event(uuid, text, text, jsonb, uuid) from public, anon, authenticated, service_role;

create or replace function private.emit_check_in_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.status in ('complete', 'partial')
    and new.completed_count between 0 and 7 then
    perform private.enqueue_crew_outbound_event(
      new.user_id,
      'check_in',
      'check-in:' || new.id::text,
      jsonb_build_object(
        'challengeDay', new.challenge_day,
        'status', new.status,
        'completedCount', new.completed_count
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_check_in_outbound_event on public.check_ins;
create trigger emit_check_in_outbound_event
  after insert on public.check_ins
  for each row execute function private.emit_check_in_outbound_event();

create or replace function private.emit_badge_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  reward_name text;
begin
  select definition.name into reward_name
  from public.badge_definitions definition
  where definition.badge_key = new.badge_key;

  if reward_name is not null and char_length(btrim(reward_name)) between 1 and 100 then
    perform private.enqueue_crew_outbound_event(
      new.user_id,
      'badge_reward',
      'badge:' || new.user_id::text || ':' || new.badge_key,
      jsonb_build_object('rewardKind', 'badge', 'rewardName', reward_name)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_badge_outbound_event on public.user_badges;
create trigger emit_badge_outbound_event
  after insert on public.user_badges
  for each row execute function private.emit_badge_outbound_event();

create or replace function private.emit_challenge_reward_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  reward_name text;
begin
  select definition.title into reward_name
  from public.challenge_definitions definition
  where definition.challenge_key = new.challenge_key;

  if reward_name is not null and char_length(btrim(reward_name)) between 1 and 100 then
    perform private.enqueue_crew_outbound_event(
      new.user_id,
      'badge_reward',
      'challenge:' || new.user_id::text || ':' || new.challenge_key,
      jsonb_build_object('rewardKind', 'challenge', 'rewardName', reward_name)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_challenge_reward_outbound_event on public.user_challenge_states;
create trigger emit_challenge_reward_outbound_event
  after insert on public.user_challenge_states
  for each row execute function private.emit_challenge_reward_outbound_event();

create or replace function private.emit_streak_milestone_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  milestone integer;
  supported_milestones integer[] := array[3, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77];
begin
  foreach milestone in array supported_milestones
  loop
    if old.current_app_streak < milestone and new.current_app_streak >= milestone then
      perform private.enqueue_crew_outbound_event(
        new.user_id,
        'streak_milestone',
        'streak:' || new.user_id::text || ':app:' || milestone::text,
        jsonb_build_object('streakType', 'app', 'milestone', milestone)
      );
    end if;

    if old.current_full_day_streak < milestone and new.current_full_day_streak >= milestone then
      perform private.enqueue_crew_outbound_event(
        new.user_id,
        'streak_milestone',
        'streak:' || new.user_id::text || ':full-standard:' || milestone::text,
        jsonb_build_object('streakType', 'full_standard', 'milestone', milestone)
      );
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists emit_streak_milestone_outbound_event on public.user_game_stats;
create trigger emit_streak_milestone_outbound_event
  after update of current_app_streak, current_full_day_streak on public.user_game_stats
  for each row execute function private.emit_streak_milestone_outbound_event();

create or replace function private.apply_outbound_preference_to_deliveries()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  preference_crew_id uuid := case when tg_op = 'DELETE' then old.crew_id else new.crew_id end;
  preference_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  updates_enabled boolean := case when tg_op = 'DELETE' then false else new.outbound_updates_enabled end;
  check_ins_allowed boolean := case when tg_op = 'DELETE' then false else new.share_check_ins end;
  streaks_allowed boolean := case when tg_op = 'DELETE' then false else new.share_streak_milestones end;
  rewards_allowed boolean := case when tg_op = 'DELETE' then false else new.share_badges_rewards end;
  membership_allowed boolean := case when tg_op = 'DELETE' then false else new.share_membership_events end;
  membership_was_allowed boolean := case
    when tg_op = 'INSERT' then false
    when tg_op = 'DELETE' then old.outbound_updates_enabled and old.share_membership_events
    else old.outbound_updates_enabled and old.share_membership_events
  end;
  joined_at timestamptz;
begin
  update private.outbound_deliveries delivery
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = case when tg_op = 'DELETE' then 'membership_or_consent_changed' else 'consent_changed' end,
      last_error_summary = 'The member no longer approves this outbound update.',
      lock_token = null,
      locked_at = null
  where delivery.crew_id = preference_crew_id
    and delivery.subject_user_id = preference_user_id
    and delivery.status in ('queued', 'retry')
    and (
      not updates_enabled
      or (delivery.event_type = 'check_in' and not check_ins_allowed)
      or (delivery.event_type = 'streak_milestone' and not streaks_allowed)
      or (delivery.event_type = 'badge_reward' and not rewards_allowed)
      or (delivery.event_type = 'membership' and not membership_allowed)
    );

  if tg_op <> 'DELETE'
    and updates_enabled
    and membership_allowed
    and not membership_was_allowed then
    select crew_member.joined_at into joined_at
    from public.crew_members crew_member
    where crew_member.crew_id = preference_crew_id
      and crew_member.user_id = preference_user_id;

    if joined_at is not null then
      if joined_at >= now() - interval '7 days' then
        perform private.enqueue_crew_outbound_event(
          preference_user_id,
          'membership',
          'membership:' || preference_crew_id::text || ':' || preference_user_id::text
            || ':' || to_char(joined_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
          '{}'::jsonb,
          preference_crew_id
        );
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_outbound_preference_to_deliveries
  on public.outbound_update_preferences;
create trigger apply_outbound_preference_to_deliveries
  after insert or update or delete on public.outbound_update_preferences
  for each row execute function private.apply_outbound_preference_to_deliveries();

revoke all on function private.emit_check_in_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.emit_badge_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.emit_challenge_reward_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.emit_streak_milestone_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.apply_outbound_preference_to_deliveries() from public, anon, authenticated, service_role;

create or replace function public.queue_due_leaderboard_recaps()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination record;
  period_start date := (date_trunc('week', now() at time zone 'UTC')::date - 7);
  recap_payload jsonb;
  queued_id uuid;
  queued_count integer := 0;
begin
  for destination in
    select provider_destination.id, provider_destination.crew_id
    from private.integration_destinations provider_destination
    where provider_destination.status = 'active'
      and provider_destination.recap_cadence = 'weekly'
    order by provider_destination.id
  loop
    select jsonb_build_object(
      'periodLabel', 'Week of ' || to_char(period_start, 'YYYY-MM-DD'),
      'memberCount', (
        select count(*)::integer
        from public.crew_members crew_member
        where crew_member.crew_id = destination.crew_id
      ),
      'checkInCount', (
        select count(*)::integer
        from public.check_ins check_in
        join public.crew_members crew_member
          on crew_member.user_id = check_in.user_id
          and crew_member.crew_id = destination.crew_id
        where check_in.entry_date >= period_start
          and check_in.entry_date < period_start + 7
      ),
      'completedStandards', (
        select coalesce(sum(check_in.completed_count), 0)::integer
        from public.check_ins check_in
        join public.crew_members crew_member
          on crew_member.user_id = check_in.user_id
          and crew_member.crew_id = destination.crew_id
        where check_in.entry_date >= period_start
          and check_in.entry_date < period_start + 7
      )
    ) into recap_payload;

    if not private.outbound_event_payload_is_safe('leaderboard_recap', recap_payload) then
      raise exception 'Generated leaderboard recap was invalid.' using errcode = '22023';
    end if;

    insert into private.outbound_deliveries (
      crew_id,
      destination_id,
      subject_user_id,
      source_reference,
      event_type,
      idempotency_key,
      payload,
      max_attempts,
      available_at
    ) values (
      destination.crew_id,
      destination.id,
      null,
      'leaderboard:' || destination.crew_id::text || ':' || period_start::text,
      'leaderboard_recap',
      'leaderboard:' || period_start::text,
      recap_payload,
      5,
      now()
    )
    on conflict (destination_id, idempotency_key) do nothing
    returning id into queued_id;

    if queued_id is not null then
      queued_count := queued_count + 1;
    end if;
    queued_id := null;
  end loop;

  return queued_count;
end;
$$;

drop function public.claim_outbound_deliveries(uuid, integer);
create function public.claim_outbound_deliveries(
  worker_token uuid,
  batch_size integer default 20
)
returns table (
  delivery_id uuid,
  crew_id uuid,
  destination_id uuid,
  subject_user_id uuid,
  source_reference text,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  event_type text,
  payload jsonb,
  attempt_number integer,
  max_attempts integer,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer
)
language sql
security definer
set search_path = public, private, pg_temp
as $$
  with candidates as (
    select queued.id
    from private.outbound_deliveries queued
    join private.integration_destinations destination
      on destination.id = queued.destination_id
    where queued.status in ('queued', 'retry')
      and queued.available_at <= now()
      and destination.status = 'active'
    order by queued.priority asc, queued.available_at asc, queued.created_at asc
    for update of queued skip locked
    limit least(greatest(coalesce(batch_size, 20), 1), 100)
  ), claimed as (
    update private.outbound_deliveries queued
    set status = 'processing',
        attempt_count = queued.attempt_count + 1,
        lock_token = worker_token,
        locked_at = now(),
        last_error_code = null,
        last_error_summary = null
    from candidates
    where queued.id = candidates.id
      and worker_token is not null
    returning queued.*
  )
  select
    claimed.id,
    claimed.crew_id,
    destination.id,
    claimed.subject_user_id,
    claimed.source_reference,
    destination.provider,
    destination.provider_workspace_id,
    destination.provider_destination_id,
    claimed.event_type,
    claimed.payload,
    claimed.attempt_count::integer,
    claimed.max_attempts::integer,
    destination.credential_ciphertext,
    destination.credential_nonce,
    destination.credential_key_version::integer
  from claimed
  join private.integration_destinations destination
    on destination.id = claimed.destination_id
  order by claimed.priority asc, claimed.available_at asc, claimed.created_at asc;
$$;

revoke all on function public.queue_due_leaderboard_recaps() from public, anon, authenticated;
revoke all on function public.claim_outbound_deliveries(uuid, integer) from public, anon, authenticated;
grant execute on function public.queue_due_leaderboard_recaps() to service_role;
grant execute on function public.claim_outbound_deliveries(uuid, integer) to service_role;

create or replace function public.resolve_claimed_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
  destination private.integration_destinations%rowtype;
  consent jsonb;
  delivery_eligible boolean := false;
  decision_reason text := 'unsupported_event';
  presentation_mode text := 'anonymous';
  subject_name text := null;
  crew_name text := null;
  event_enabled boolean := false;
begin
  select delivery_row.* into delivery
  from private.outbound_deliveries delivery_row
  where delivery_row.id = target_delivery_id
    and delivery_row.status = 'processing'
    and delivery_row.lock_token = worker_token;

  if not found then
    raise exception 'The delivery is not owned by this worker.' using errcode = '55000';
  end if;

  select destination_row.* into destination
  from private.integration_destinations destination_row
  where destination_row.id = delivery.destination_id;

  select left(nullif(btrim(group_row.name), ''), 120) into crew_name
  from public.crews group_row
  where group_row.id = delivery.crew_id;

  if destination.id is null or destination.status <> 'active' then
    decision_reason := 'destination_inactive';
  elsif destination.credential_ciphertext is null
    or destination.credential_nonce is null
    or destination.credential_key_version is null then
    decision_reason := 'destination_credentials_missing';
  elsif not private.outbound_event_payload_is_safe(delivery.event_type, delivery.payload) then
    decision_reason := case
      when delivery.event_type in (
        'check_in',
        'streak_milestone',
        'badge_reward',
        'membership',
        'leaderboard_recap',
        'synthetic.delivery'
      ) then 'invalid_payload'
      else 'unsupported_event'
    end;
  elsif delivery.event_type = 'synthetic.delivery' then
    delivery_eligible := true;
    decision_reason := 'approved';
  elsif delivery.event_type = 'leaderboard_recap' then
    if destination.recap_cadence <> 'weekly' then
      decision_reason := 'event_disabled';
    elsif delivery.subject_user_id is not null then
      decision_reason := 'subject_not_allowed';
    else
      delivery_eligible := true;
      decision_reason := 'approved';
    end if;
  elsif delivery.event_type in ('check_in', 'streak_milestone', 'badge_reward', 'membership') then
    event_enabled := case delivery.event_type
      when 'check_in' then destination.check_ins_enabled
      when 'streak_milestone' then destination.streak_milestones_enabled
      when 'badge_reward' then destination.badges_rewards_enabled
      when 'membership' then destination.membership_enabled
      else false
    end;

    if not event_enabled then
      decision_reason := 'event_disabled';
    elsif delivery.subject_user_id is null then
      decision_reason := 'subject_missing';
    elsif delivery.source_reference is null then
      decision_reason := 'source_reference_missing';
    else
      consent := public.get_current_outbound_consent(
        delivery.subject_user_id,
        delivery.crew_id,
        delivery.event_type
      );
      delivery_eligible := coalesce((consent ->> 'eligible')::boolean, false);
      decision_reason := coalesce(consent ->> 'reason', 'consent_unavailable');
      presentation_mode := case
        when consent ->> 'presentationMode' = 'named' then 'named'
        else 'anonymous'
      end;

      if delivery_eligible and presentation_mode = 'named' then
        select left(coalesce(
          nullif(btrim(profile.name), ''),
          nullif(btrim(crew_member.display_name), '')
        ), 120) into subject_name
        from public.crew_members crew_member
        left join public.profiles profile on profile.user_id = crew_member.user_id
        where crew_member.crew_id = delivery.crew_id
          and crew_member.user_id = delivery.subject_user_id;
      end if;
    end if;
  end if;

  if not delivery_eligible then
    presentation_mode := 'anonymous';
    subject_name := null;
  end if;

  return jsonb_build_object(
    'eligible', delivery_eligible,
    'reason', decision_reason,
    'presentationMode', presentation_mode,
    'subjectName', subject_name,
    'crewName', crew_name,
    'includeSafeLink', case
      when delivery.event_type = 'synthetic.delivery' then false
      else coalesce(destination.include_safe_link, false)
    end
  );
end;
$$;

create or replace function public.cancel_claimed_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid,
  target_reason text
)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
begin
  if target_reason is null or target_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'Invalid delivery cancellation reason.' using errcode = '22023';
  end if;

  select * into delivery
  from private.outbound_deliveries
  where id = target_delivery_id
  for update;

  if not found or delivery.status <> 'processing' or delivery.lock_token <> worker_token then
    raise exception 'The delivery is not owned by this worker.' using errcode = '55000';
  end if;

  insert into private.integration_delivery_attempts (
    delivery_id,
    attempt_number,
    outcome,
    error_code,
    error_summary,
    started_at
  ) values (
    delivery.id,
    delivery.attempt_count,
    'cancelled',
    target_reason,
    'Current outbound delivery approval was not available.',
    coalesce(delivery.locked_at, now())
  )
  on conflict (delivery_id, attempt_number) do nothing;

  update private.outbound_deliveries
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = target_reason,
      last_error_summary = 'Current outbound delivery approval was not available.',
      lock_token = null,
      locked_at = null
  where id = delivery.id;

  return 'cancelled';
end;
$$;

revoke all on function public.resolve_claimed_outbound_delivery(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_claimed_outbound_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_claimed_outbound_delivery(uuid, uuid) to service_role;
grant execute on function public.cancel_claimed_outbound_delivery(uuid, uuid, text) to service_role;

alter table private.integration_connection_audit
  drop constraint if exists integration_connection_audit_action_check;
alter table private.integration_connection_audit
  add constraint integration_connection_audit_action_check check (
    action in (
      'authorization_started',
      'authorization_completed',
      'connected',
      'reconnected',
      'test_succeeded',
      'needs_attention',
      'settings_updated',
      'disconnected'
    )
  );

create or replace function public.update_integration_destination_settings(
  target_destination_id uuid,
  target_actor_id uuid,
  target_check_ins_enabled boolean,
  target_streak_milestones_enabled boolean,
  target_badges_rewards_enabled boolean,
  target_membership_enabled boolean,
  target_recap_cadence text,
  target_include_safe_link boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
  normalized_recap_cadence text := lower(btrim(coalesce(target_recap_cadence, 'off')));
begin
  if normalized_recap_cadence not in ('off', 'weekly') then
    raise exception 'Leaderboard recap cadence must be off or weekly.' using errcode = '22023';
  end if;

  select destination_row.* into destination
  from private.integration_destinations destination_row
  join public.crew_members crew_member on crew_member.crew_id = destination_row.crew_id
  where destination_row.id = target_destination_id
    and crew_member.user_id = target_actor_id
    and crew_member.role in ('owner', 'admin')
  for update of destination_row;

  if not found then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  update private.integration_destinations
  set check_ins_enabled = coalesce(target_check_ins_enabled, false),
      streak_milestones_enabled = coalesce(target_streak_milestones_enabled, false),
      badges_rewards_enabled = coalesce(target_badges_rewards_enabled, false),
      membership_enabled = coalesce(target_membership_enabled, false),
      recap_cadence = normalized_recap_cadence,
      include_safe_link = coalesce(target_include_safe_link, false)
  where id = destination.id;

  update private.outbound_deliveries delivery
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = 'destination_settings_changed',
      last_error_summary = 'This outbound event type is no longer enabled for the destination.',
      lock_token = null,
      locked_at = null
  where delivery.destination_id = destination.id
    and delivery.status in ('queued', 'retry')
    and (
      (delivery.event_type = 'check_in' and not coalesce(target_check_ins_enabled, false))
      or (delivery.event_type = 'streak_milestone' and not coalesce(target_streak_milestones_enabled, false))
      or (delivery.event_type = 'badge_reward' and not coalesce(target_badges_rewards_enabled, false))
      or (delivery.event_type = 'membership' and not coalesce(target_membership_enabled, false))
      or (delivery.event_type = 'leaderboard_recap' and normalized_recap_cadence = 'off')
    );

  perform private.record_integration_connection_audit(
    destination.crew_id,
    destination.id,
    target_actor_id,
    destination.provider,
    'settings_updated',
    'succeeded',
    jsonb_build_object(
      'checkInsEnabled', coalesce(target_check_ins_enabled, false),
      'streakMilestonesEnabled', coalesce(target_streak_milestones_enabled, false),
      'badgesRewardsEnabled', coalesce(target_badges_rewards_enabled, false),
      'membershipEnabled', coalesce(target_membership_enabled, false),
      'recapCadence', normalized_recap_cadence,
      'includeSafeLink', coalesce(target_include_safe_link, false)
    )
  );

  return true;
end;
$$;

drop function public.list_crew_integration_destinations(uuid);
create function public.list_crew_integration_destinations(
  target_crew_id uuid
)
returns table (
  destination_id uuid,
  provider text,
  workspace_id text,
  workspace_name text,
  channel_id text,
  channel_name text,
  status text,
  last_verified_at timestamptz,
  last_tested_at timestamptz,
  last_delivered_at timestamptz,
  health_code text,
  last_error_code text,
  corrective_action text,
  check_ins_enabled boolean,
  streak_milestones_enabled boolean,
  badges_rewards_enabled boolean,
  membership_enabled boolean,
  recap_cadence text,
  include_safe_link boolean,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not public.is_crew_member(target_crew_id) then
    raise exception 'This private group is not available.' using errcode = '42501';
  end if;

  return query
    select
      destination.id,
      destination.provider,
      destination.provider_workspace_id,
      destination.provider_workspace_name,
      destination.provider_destination_id,
      destination.display_name,
      destination.status,
      destination.last_verified_at,
      destination.last_tested_at,
      destination.last_delivered_at,
      destination.last_error_code,
      destination.last_error_code,
      case
        when destination.status = 'active' and destination.last_error_code is not null
          then 'Wait for the provider and retry the test.'
        when destination.status = 'reconnect_required'
          then 'Reconnect and verify the selected channel.'
        when destination.status = 'disconnected'
          then 'Connect this provider again.'
        when destination.status = 'revoked'
          then 'Reconnect this provider before enabling updates.'
        else null
      end,
      destination.check_ins_enabled,
      destination.streak_milestones_enabled,
      destination.badges_rewards_enabled,
      destination.membership_enabled,
      destination.recap_cadence,
      destination.include_safe_link,
      public.can_manage_crew(target_crew_id)
    from private.integration_destinations destination
    where destination.crew_id = target_crew_id
    order by destination.provider;
end;
$$;

revoke all on function public.update_integration_destination_settings(uuid, uuid, boolean, boolean, boolean, boolean, text, boolean)
  from public, anon, authenticated;
revoke all on function public.list_crew_integration_destinations(uuid) from public, anon;
grant execute on function public.update_integration_destination_settings(uuid, uuid, boolean, boolean, boolean, boolean, text, boolean)
  to service_role;
grant execute on function public.list_crew_integration_destinations(uuid) to authenticated;

-- Retire private-group conversation features without deleting historical rows
-- or objects. Service-role retention/export jobs remain possible, while every
-- supported browser/API path fails closed at the database and storage layers.

drop policy if exists "Authenticated users can read visible posts" on public.community_posts;
drop policy if exists "Users can create visible posts" on public.community_posts;
drop policy if exists "Authors can update own posts" on public.community_posts;
drop policy if exists "Authors and crew leaders can delete posts" on public.community_posts;

drop policy if exists "Users can read likes on visible posts" on public.post_likes;
drop policy if exists "Users can like visible posts" on public.post_likes;
drop policy if exists "Users can remove own likes" on public.post_likes;

drop policy if exists "Users can read comments on visible posts" on public.post_comments;
drop policy if exists "Users can comment on visible posts" on public.post_comments;
drop policy if exists "Users can update own comments" on public.post_comments;
drop policy if exists "Authors and crew leaders can delete comments" on public.post_comments;

revoke all on public.community_posts from public, anon, authenticated;
revoke all on public.post_likes from public, anon, authenticated;
revoke all on public.post_comments from public, anon, authenticated;

revoke execute on function public.can_read_community_post(uuid)
  from public, anon, authenticated;
revoke execute on function public.get_community_post_engagement(uuid[])
  from public, anon, authenticated;

drop policy if exists "Crew members can read community post images" on storage.objects;
drop policy if exists "Crew members can upload own community post images" on storage.objects;
drop policy if exists "Authors and crew leaders can delete community post images" on storage.objects;

comment on table public.community_posts is
  'Retained retired Community post history. Product/API access ended at the private-group social cutover; service-only retention controls apply.';
comment on table public.post_comments is
  'Retained retired Community comment history. No client role has access after the private-group social cutover.';
comment on table public.post_likes is
  'Retained retired Community reaction history. No client role has access after the private-group social cutover.';


-- FOU-564 P0-P3: immutable retirement snapshot, member-authored export,
-- sealed deletion coordination, and worker-facing confirmation boundaries.
-- No scheduler or production Storage/provider worker is created here.

create table private.retired_community_t0_comment_inventory (
  comment_id uuid primary key,
  post_id uuid not null,
  author_id uuid not null,
  created_at timestamptz not null,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_t0_like_inventory (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (post_id, user_id)
);

create table private.retired_community_t0_object_inventory (
  bucket_id text not null,
  object_name text not null,
  object_id uuid not null,
  owner_id uuid,
  referenced_post_ids uuid[] not null default '{}',
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (bucket_id, object_name)
);

create table private.retired_community_t0_post_inventory (
  post_id uuid primary key,
  scope text not null check (scope in ('global', 'crew')),
  author_id uuid not null,
  crew_id uuid,
  created_at timestamptz not null,
  image_reference_sha256 text,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  children_sha256 text not null check (children_sha256 ~ '^[0-9a-f]{64}$'),
  object_sha256 text check (object_sha256 is null or object_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_t0_census (
  singleton boolean primary key default true check (singleton),
  captured_at timestamptz not null,
  member_export_ends_at timestamptz not null,
  global_post_count bigint not null check (global_post_count >= 0),
  private_post_count bigint not null check (private_post_count >= 0),
  comment_count bigint not null check (comment_count >= 0),
  like_count bigint not null check (like_count >= 0),
  referenced_image_count bigint not null check (referenced_image_count >= 0),
  bucket_object_count bigint not null check (bucket_object_count >= 0),
  missing_object_count bigint not null check (missing_object_count >= 0),
  orphan_object_count bigint not null check (orphan_object_count >= 0),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  check (member_export_ends_at = captured_at + interval '30 days')
);

create function private.retired_community_sha256(target_value text)
returns text language sql immutable security definer
set search_path = pg_catalog, extensions, pg_temp as $$
  select encode(extensions.digest(convert_to(coalesce(target_value, ''), 'UTF8'), 'sha256'), 'hex');
$$;

create function private.compute_retired_community_census()
returns table (
  global_post_count bigint,
  private_post_count bigint,
  comment_count bigint,
  like_count bigint,
  referenced_image_count bigint,
  bucket_object_count bigint,
  missing_object_count bigint,
  orphan_object_count bigint,
  source_sha256 text
)
language sql stable security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
  with source_rows(kind, source_key, row_sha256) as (
    select 'post', post_row.id::text,
      private.retired_community_sha256(to_jsonb(post_row)::text)
    from public.community_posts post_row
    union all
    select 'comment', comment_row.id::text,
      private.retired_community_sha256(to_jsonb(comment_row)::text)
    from public.post_comments comment_row
    union all
    select 'like', like_row.post_id::text || ':' || like_row.user_id::text,
      private.retired_community_sha256(to_jsonb(like_row)::text)
    from public.post_likes like_row
    union all
    select 'object', object_row.name,
      private.retired_community_sha256(to_jsonb(object_row)::text)
    from storage.objects object_row
    where object_row.bucket_id = 'community-post-images'
  ), digest_row as (
    select private.retired_community_sha256(coalesce(
      jsonb_agg(jsonb_build_array(kind, source_key, row_sha256) order by kind, source_key)::text,
      '[]'
    )) value
    from source_rows
  )
  select
    (select count(*) from public.community_posts where scope = 'global'),
    (select count(*) from public.community_posts where scope = 'crew'),
    (select count(*) from public.post_comments),
    (select count(*) from public.post_likes),
    (select count(distinct image_path) from public.community_posts where image_path is not null),
    (select count(*) from storage.objects where bucket_id = 'community-post-images'),
    (select count(distinct post_row.image_path) from public.community_posts post_row where post_row.image_path is not null
      and not exists (select 1 from storage.objects object_row
        where object_row.bucket_id = 'community-post-images' and object_row.name = post_row.image_path)),
    (select count(*) from storage.objects object_row where object_row.bucket_id = 'community-post-images'
      and not exists (select 1 from public.community_posts post_row
        where post_row.image_path = object_row.name)),
    digest_row.value
  from digest_row;
$$;

insert into private.retired_community_t0_comment_inventory (
  comment_id, post_id, author_id, created_at, row_sha256
)
select comment_row.id, comment_row.post_id, comment_row.user_id, comment_row.created_at,
  private.retired_community_sha256(to_jsonb(comment_row)::text)
from public.post_comments comment_row;

insert into private.retired_community_t0_like_inventory (
  post_id, user_id, created_at, row_sha256
)
select like_row.post_id, like_row.user_id, like_row.created_at,
  private.retired_community_sha256(to_jsonb(like_row)::text)
from public.post_likes like_row;

insert into private.retired_community_t0_object_inventory (
  bucket_id, object_name, object_id, owner_id, referenced_post_ids, row_sha256
)
select object_row.bucket_id, object_row.name, object_row.id, object_row.owner,
  coalesce((select array_agg(post_row.id order by post_row.id)
    from public.community_posts post_row where post_row.image_path = object_row.name), '{}'::uuid[]),
  private.retired_community_sha256(to_jsonb(object_row)::text)
from storage.objects object_row
where object_row.bucket_id = 'community-post-images';

insert into private.retired_community_t0_post_inventory (
  post_id, scope, author_id, crew_id, created_at, image_reference_sha256,
  row_sha256, children_sha256, object_sha256
)
select post_row.id, post_row.scope, post_row.author_id, post_row.crew_id, post_row.created_at,
  case when post_row.image_path is not null
    then private.retired_community_sha256(post_row.image_path) end,
  private.retired_community_sha256(to_jsonb(post_row)::text),
  private.retired_community_sha256(coalesce((
    select jsonb_agg(jsonb_build_array(child.kind, child.child_key, child.row_sha256)
      order by child.kind, child.child_key)::text
    from (
      select 'comment' kind, comment_item.comment_id::text child_key, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      where comment_item.post_id = post_row.id
      union all
      select 'like', like_item.user_id::text, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      where like_item.post_id = post_row.id
    ) child
  ), '[]')),
  (select object_item.row_sha256
    from private.retired_community_t0_object_inventory object_item
    where object_item.bucket_id = 'community-post-images'
      and object_item.object_name = post_row.image_path)
from public.community_posts post_row;

insert into private.retired_community_t0_census (
  singleton, captured_at, member_export_ends_at, global_post_count,
  private_post_count, comment_count, like_count, referenced_image_count,
  bucket_object_count, missing_object_count, orphan_object_count, source_sha256
)
select true, statement_timestamp(), statement_timestamp() + interval '30 days',
  current_census.global_post_count, current_census.private_post_count,
  current_census.comment_count, current_census.like_count,
  current_census.referenced_image_count, current_census.bucket_object_count,
  current_census.missing_object_count, current_census.orphan_object_count,
  current_census.source_sha256
from private.compute_retired_community_census() current_census;

create function private.block_retired_community_t0_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'The retired Community T0 snapshot is immutable.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_t0_census_mutation
  before insert or update or delete on private.retired_community_t0_census
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_post_mutation
  before insert or update or delete on private.retired_community_t0_post_inventory
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_comment_mutation
  before insert or update or delete on private.retired_community_t0_comment_inventory
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_like_mutation
  before insert or update or delete on private.retired_community_t0_like_inventory
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_object_mutation
  before insert or update or delete on private.retired_community_t0_object_inventory
  for each row execute function private.block_retired_community_t0_mutation();

create function private.build_own_retired_community_export(
  target_user_id uuid,
  target_exported_at timestamptz
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, private, pg_temp set timezone = 'UTC' as $$
declare census_row private.retired_community_t0_census%rowtype;
declare export_value jsonb;
begin
  if target_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if target_exported_at < census_row.captured_at
     or target_exported_at > census_row.member_export_ends_at then
    raise exception 'The member-authored export window has closed.' using errcode = '55000';
  end if;

  if exists (
    select 1 from private.retired_community_t0_post_inventory inventory
    left join public.community_posts post_row on post_row.id = inventory.post_id
    where inventory.author_id = target_user_id
      and (post_row.id is null
        or private.retired_community_sha256(to_jsonb(post_row)::text) <> inventory.row_sha256)
  ) or exists (
    select 1 from private.retired_community_t0_comment_inventory inventory
    left join public.post_comments comment_row on comment_row.id = inventory.comment_id
    where inventory.author_id = target_user_id
      and (comment_row.id is null
        or private.retired_community_sha256(to_jsonb(comment_row)::text) <> inventory.row_sha256)
  ) or exists (
    select 1 from private.retired_community_t0_like_inventory inventory
    left join public.post_likes like_row
      on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
    where inventory.user_id = target_user_id
      and (like_row.post_id is null
        or private.retired_community_sha256(to_jsonb(like_row)::text) <> inventory.row_sha256)
  ) then
    raise exception 'Authored source data no longer matches the T0 inventory.' using errcode = '55000';
  end if;

  select jsonb_build_object(
    'schemaVersion', 1,
    'capturedAt', census_row.captured_at,
    'exportedAt', target_exported_at,
    'exportEndsAt', census_row.member_export_ends_at,
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'postId', post_row.id,
        'body', post_row.body,
        'type', post_row.post_type,
        'imageAlt', post_row.image_alt,
        'attachmentPath', post_row.image_path,
        'imageReferenceId', inventory.image_reference_sha256,
        'createdAt', post_row.created_at,
        'updatedAt', post_row.updated_at
      ) order by post_row.created_at, post_row.id)
      from private.retired_community_t0_post_inventory inventory
      join public.community_posts post_row on post_row.id = inventory.post_id
      where inventory.author_id = target_user_id
    ), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'commentId', comment_row.id,
        'postId', comment_row.post_id,
        'body', comment_row.body,
        'createdAt', comment_row.created_at,
        'updatedAt', comment_row.updated_at
      ) order by comment_row.created_at, comment_row.id)
      from private.retired_community_t0_comment_inventory inventory
      join public.post_comments comment_row on comment_row.id = inventory.comment_id
      where inventory.author_id = target_user_id
    ), '[]'::jsonb),
    'likes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'postId', like_row.post_id,
        'createdAt', like_row.created_at
      ) order by like_row.created_at, like_row.post_id)
      from private.retired_community_t0_like_inventory inventory
      join public.post_likes like_row
        on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
      where inventory.user_id = target_user_id
    ), '[]'::jsonb)
  ) into export_value;
  return export_value;
end;
$$;

create function public.export_own_retired_community_content()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare current_user_id uuid;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  return private.build_own_retired_community_export(current_user_id, clock_timestamp());
end;
$$;

revoke all on private.retired_community_t0_census from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_post_inventory from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_comment_inventory from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_like_inventory from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_object_inventory from public, anon, authenticated, service_role;
revoke all on function private.retired_community_sha256(text) from public, anon, authenticated, service_role;
revoke all on function private.compute_retired_community_census() from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_t0_mutation() from public, anon, authenticated, service_role;
revoke all on function private.build_own_retired_community_export(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.export_own_retired_community_content()
  from public, anon, service_role;
grant execute on function public.export_own_retired_community_content() to authenticated;

comment on table private.retired_community_t0_census is
  'Immutable, uncapped T0 census for all retired global/private Community rows and image-object reconciliation.';
comment on function public.export_own_retired_community_content() is
  'Authenticated 30-day export of only the caller authored retired Community content; derives auth.uid and exposes only that authors attachment paths.';

-- P2/P3 deletion coordination. Identity/scope records are sealed once and all
-- state transitions are appended to the ledger. Storage objects are never
-- deleted from SQL; a worker must remove and confirm each exact object first.

alter table public.crews drop constraint if exists crews_created_by_fkey;
alter table public.crews alter column created_by drop not null;
alter table public.crews add constraint crews_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

alter table private.integration_destinations
  drop constraint if exists integration_destinations_installed_by_fkey;
alter table private.integration_destinations alter column installed_by drop not null;
alter table private.integration_destinations
  add constraint integration_destinations_installed_by_fkey
  foreign key (installed_by) references auth.users(id) on delete set null;

create function private.retired_community_credential_sha256(
  target_destination private.integration_destinations
)
returns text language sql immutable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select private.retired_community_sha256(jsonb_build_object(
    'id', (target_destination).id,
    'crewId', (target_destination).crew_id,
    'provider', (target_destination).provider,
    'providerWorkspaceId', (target_destination).provider_workspace_id,
    'providerDestinationId', (target_destination).provider_destination_id,
    'credentialCiphertext', (target_destination).credential_ciphertext,
    'credentialNonce', (target_destination).credential_nonce,
    'credentialKeyVersion', (target_destination).credential_key_version,
    'credentialFingerprint', (target_destination).credential_fingerprint,
    'scopes', (target_destination).scopes
  )::text);
$$;

create table private.retired_community_deletion_batches (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (reason in
    ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup')),
  requested_by text not null check (char_length(requested_by) between 3 and 160),
  requested_at timestamptz not null,
  execute_after timestamptz not null,
  deadline_at timestamptz,
  subject_user_id uuid,
  crew_id uuid,
  t0_source_sha256 text not null check (t0_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint,
  comment_count bigint,
  like_count bigint,
  object_count bigint,
  credential_count bigint,
  sealed boolean not null default false,
  check (not sealed or (
    source_sha256 is not null
    and post_count is not null and post_count >= 0
    and comment_count is not null and comment_count >= 0
    and like_count is not null and like_count >= 0
    and object_count is not null and object_count >= 0
    and credential_count is not null and credential_count >= 0
  )),
  check (
    (reason = 'aged_retention' and subject_user_id is null and crew_id is null and deadline_at is null)
    or (reason = 'orphan_cleanup' and subject_user_id is null and crew_id is null and deadline_at is null)
    or (reason = 'account_erasure' and subject_user_id is not null and crew_id is null
      and deadline_at = requested_at + interval '24 hours')
    or (reason = 'group_deletion' and subject_user_id is null and crew_id is not null
      and deadline_at is null and execute_after = requested_at + interval '30 days')
  )
);

create table private.retired_community_deletion_items (
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  item_kind text not null check (item_kind in ('post', 'comment', 'like')),
  item_key text not null,
  post_id uuid not null,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (batch_id, item_kind, item_key)
);

create table private.retired_community_storage_work (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  object_id uuid not null,
  bucket_id text not null check (bucket_id = 'community-post-images'),
  object_name text not null,
  expected_row_sha256 text not null check (expected_row_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'confirmed')),
  claim_token uuid,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  unique (batch_id, bucket_id, object_name)
);

create table private.retired_community_credential_work (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  destination_id uuid not null,
  provider text not null check (provider in ('slack', 'discord')),
  expected_row_sha256 text not null check (expected_row_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'confirmed')),
  claim_token uuid,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  provider_revocation_reference text,
  unique (batch_id, destination_id)
);

create table private.retired_community_backup_proofs (
  batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  backup_name text not null check (char_length(trim(backup_name)) between 3 and 200),
  backup_version text not null check (char_length(trim(backup_version)) between 1 and 100),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_bytes bigint not null check (bundle_bytes > 0),
  verified_by text not null check (char_length(verified_by) between 3 and 160),
  verified_at timestamptz not null
);

create table private.retired_community_batch_approvals (
  batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  approved_by text not null check (char_length(approved_by) between 3 and 160),
  approved_at timestamptz not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint not null,
  comment_count bigint not null,
  like_count bigint not null,
  object_count bigint not null,
  credential_count bigint not null,
  check (post_count >= 0 and comment_count >= 0 and like_count >= 0
    and object_count >= 0 and credential_count >= 0)
);

create table private.retired_community_deletion_ledger (
  id bigint generated always as identity primary key,
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  event_type text not null check (event_type in
    ('created', 'backup_verified', 'approved', 'storage_confirmed',
     'credential_confirmed', 'cancelled', 'executed')),
  actor text not null check (char_length(actor) between 3 and 160),
  event_at timestamptz not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index retired_community_deletion_ledger_batch_event_idx
  on private.retired_community_deletion_ledger (batch_id, event_type);

create function private.guard_retired_community_batch_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    if new.sealed then
      raise exception 'Retired Community deletion batches must be assembled before sealing.' using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' or old.sealed then
    raise exception 'Retired Community deletion batches are immutable.' using errcode = '55000';
  end if;
  if new.sealed then
    if new.source_sha256 is null or new.post_count is null or new.post_count < 0
       or new.comment_count is null or new.comment_count < 0
       or new.like_count is null or new.like_count < 0
       or new.object_count is null or new.object_count < 0
       or new.credential_count is null or new.credential_count < 0 then
      raise exception 'A sealed deletion batch requires a digest and all five non-negative counts.'
        using errcode = '55000';
    end if;
    if new.id = old.id and new.reason = old.reason
       and new.requested_by = old.requested_by and new.requested_at = old.requested_at
       and new.execute_after = old.execute_after and new.deadline_at is not distinct from old.deadline_at
       and new.subject_user_id is not distinct from old.subject_user_id
       and new.crew_id is not distinct from old.crew_id
       and new.t0_source_sha256 = old.t0_source_sha256 then
      return new;
    end if;
  end if;
  raise exception 'Retired Community deletion batches may only be sealed once.' using errcode = '55000';
end;
$$;

create trigger guard_retired_community_batch_mutation
  before insert or update or delete on private.retired_community_deletion_batches
  for each row execute function private.guard_retired_community_batch_mutation();

create function private.guard_retired_community_item_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Retired Community deletion items are immutable.' using errcode = '55000';
  end if;
  if (select sealed from private.retired_community_deletion_batches where id = new.batch_id) then
    raise exception 'A sealed deletion batch cannot accept items.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger guard_retired_community_item_mutation
  before insert or update or delete on private.retired_community_deletion_items
  for each row execute function private.guard_retired_community_item_mutation();

create function private.block_retired_community_record_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Retired Community proof, approval, and ledger records are append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_backup_mutation
  before update or delete on private.retired_community_backup_proofs
  for each row execute function private.block_retired_community_record_mutation();
create trigger block_retired_community_approval_mutation
  before update or delete on private.retired_community_batch_approvals
  for each row execute function private.block_retired_community_record_mutation();
create trigger block_retired_community_ledger_mutation
  before update or delete on private.retired_community_deletion_ledger
  for each row execute function private.block_retired_community_record_mutation();

create function private.retired_community_batch_status(target_batch_id uuid)
returns text language sql security definer
set search_path = pg_catalog, private, pg_temp as $$
  select case
    when exists (select 1 from private.retired_community_deletion_ledger
      where batch_id = target_batch_id and event_type = 'executed') then 'executed'
    when exists (select 1 from private.retired_community_deletion_ledger
      where batch_id = target_batch_id and event_type = 'cancelled') then 'cancelled'
    when not exists (select 1 from private.retired_community_backup_proofs
      where batch_id = target_batch_id) then 'awaiting_backup'
    when not exists (select 1 from private.retired_community_batch_approvals
      where batch_id = target_batch_id) then 'awaiting_approval'
    when exists (select 1 from private.retired_community_storage_work
      where batch_id = target_batch_id and status <> 'confirmed') then 'storage_pending'
    when exists (select 1 from private.retired_community_credential_work
      where batch_id = target_batch_id and status <> 'confirmed') then 'credential_pending'
    when clock_timestamp() < (select execute_after from private.retired_community_deletion_batches
      where id = target_batch_id) then 'awaiting_execute_after'
    else 'ready'
  end;
$$;

create function private.retired_community_batch_result(target_batch_id uuid)
returns jsonb language sql security definer
set search_path = pg_catalog, private, pg_temp as $$
  select jsonb_build_object(
    'batchId', batch_row.id,
    'status', private.retired_community_batch_status(batch_row.id),
    'counts', jsonb_build_object(
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    )
  )
  from private.retired_community_deletion_batches batch_row
  where batch_row.id = target_batch_id;
$$;

create function private.create_retired_community_deletion_batch(
  target_reason text,
  target_requested_by text,
  target_subject_user_id uuid,
  target_crew_id uuid,
  target_requested_at timestamptz
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare census_row private.retired_community_t0_census%rowtype;
declare new_batch_id uuid := gen_random_uuid();
declare source_digest text;
declare selected_post_ids uuid[];
declare posts bigint;
declare comments bigint;
declare likes bigint;
declare objects bigint;
declare credentials bigint;
begin
  if target_reason not in ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup') then
    raise exception 'Unsupported retired Community deletion reason.' using errcode = '22023';
  end if;
  if target_requested_by is null or char_length(target_requested_by) not between 3 and 160 then
    raise exception 'A named requester is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if target_reason = 'aged_retention' and clock_timestamp() < census_row.captured_at + interval '91 days' then
    raise exception 'Aged retention cannot begin before T0 plus 91 days.' using errcode = '55000';
  end if;
  if target_reason = 'account_erasure'
     and (target_subject_user_id is null or not exists
       (select 1 from auth.users where id = target_subject_user_id)) then
    raise exception 'The account erasure subject does not exist.' using errcode = '22023';
  end if;
  if target_reason = 'group_deletion'
     and (target_crew_id is null or not exists (select 1 from public.crews where id = target_crew_id)) then
    raise exception 'The group deletion target does not exist.' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.retired_community_deletion_batches existing
    where existing.reason = target_reason
      and existing.subject_user_id is not distinct from target_subject_user_id
      and existing.crew_id is not distinct from target_crew_id
      and not exists (select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = existing.id and terminal.event_type in ('cancelled', 'executed'))
  ) then
    raise exception 'An active deletion batch already covers this target.' using errcode = '55000';
  end if;

  insert into private.retired_community_deletion_batches (
    id, reason, requested_by, requested_at, execute_after, deadline_at,
    subject_user_id, crew_id, t0_source_sha256
  ) values (
    new_batch_id, target_reason, target_requested_by, target_requested_at,
    case when target_reason = 'group_deletion' then target_requested_at + interval '30 days'
      else target_requested_at end,
    case when target_reason = 'account_erasure' then target_requested_at + interval '24 hours' end,
    target_subject_user_id, target_crew_id, census_row.source_sha256
  );

  if target_reason = 'aged_retention' then
    insert into private.retired_community_deletion_items
      select new_batch_id, 'post', post_id::text, post_id, row_sha256
      from private.retired_community_t0_post_inventory;
    insert into private.retired_community_deletion_items
      select new_batch_id, 'comment', comment_id::text, post_id, row_sha256
      from private.retired_community_t0_comment_inventory;
    insert into private.retired_community_deletion_items
      select new_batch_id, 'like', post_id::text || ':' || user_id::text, post_id, row_sha256
      from private.retired_community_t0_like_inventory;
  elsif target_reason = 'account_erasure' then
    insert into private.retired_community_deletion_items
      select new_batch_id, 'post', post_item.post_id::text, post_item.post_id, post_item.row_sha256
      from private.retired_community_t0_post_inventory post_item
      join public.community_posts post_row on post_row.id = post_item.post_id
      where post_item.author_id = target_subject_user_id
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256;
    insert into private.retired_community_deletion_items
      select distinct new_batch_id, 'comment', comment_item.comment_id::text,
        comment_item.post_id, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      join public.post_comments comment_row on comment_row.id = comment_item.comment_id
      where private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256
        and (comment_item.author_id = target_subject_user_id
          or exists (select 1 from private.retired_community_t0_post_inventory post_item
            where post_item.post_id = comment_item.post_id and post_item.author_id = target_subject_user_id));
    insert into private.retired_community_deletion_items
      select distinct new_batch_id, 'like', like_item.post_id::text || ':' || like_item.user_id::text,
        like_item.post_id, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      join public.post_likes like_row
        on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
      where private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256
        and (like_item.user_id = target_subject_user_id
          or exists (select 1 from private.retired_community_t0_post_inventory post_item
            where post_item.post_id = like_item.post_id and post_item.author_id = target_subject_user_id));
  elsif target_reason = 'group_deletion' then
    insert into private.retired_community_deletion_items
      select new_batch_id, 'post', post_item.post_id::text, post_item.post_id, post_item.row_sha256
      from private.retired_community_t0_post_inventory post_item
      join public.community_posts post_row on post_row.id = post_item.post_id
      where post_item.crew_id = target_crew_id
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256;
    insert into private.retired_community_deletion_items
      select new_batch_id, 'comment', comment_item.comment_id::text,
        comment_item.post_id, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      join public.post_comments comment_row on comment_row.id = comment_item.comment_id
      where private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256
        and exists (select 1 from private.retired_community_t0_post_inventory post_item
          where post_item.post_id = comment_item.post_id and post_item.crew_id = target_crew_id);
    insert into private.retired_community_deletion_items
      select new_batch_id, 'like', like_item.post_id::text || ':' || like_item.user_id::text,
        like_item.post_id, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      join public.post_likes like_row
        on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
      where private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256
        and exists (select 1 from private.retired_community_t0_post_inventory post_item
          where post_item.post_id = like_item.post_id and post_item.crew_id = target_crew_id);
  end if;

  select coalesce(array_agg(split_part(item_key, ':', 1)::uuid order by item_key), '{}'::uuid[])
    into selected_post_ids from private.retired_community_deletion_items
    where batch_id = new_batch_id and item_kind = 'post';

  insert into private.retired_community_storage_work (
    batch_id, object_id, bucket_id, object_name, expected_row_sha256
  )
  select new_batch_id, object_item.object_id, object_item.bucket_id,
    object_item.object_name, object_item.row_sha256
  from private.retired_community_t0_object_inventory object_item
  where (target_reason = 'aged_retention' and cardinality(object_item.referenced_post_ids) > 0)
    or (target_reason = 'orphan_cleanup' and cardinality(object_item.referenced_post_ids) = 0)
    or (target_reason in ('account_erasure', 'group_deletion')
      and cardinality(object_item.referenced_post_ids) > 0
      and object_item.referenced_post_ids <@ selected_post_ids);

  if target_reason = 'group_deletion' then
    insert into private.retired_community_credential_work (
      batch_id, destination_id, provider, expected_row_sha256
    )
    select new_batch_id, destination.id, destination.provider,
      private.retired_community_credential_sha256(destination)
    from private.integration_destinations destination where destination.crew_id = target_crew_id;
  end if;

  select count(*) filter (where item_kind = 'post'),
    count(*) filter (where item_kind = 'comment'),
    count(*) filter (where item_kind = 'like')
  into posts, comments, likes
  from private.retired_community_deletion_items where batch_id = new_batch_id;
  select count(*) into objects from private.retired_community_storage_work
    where batch_id = new_batch_id;
  select count(*) into credentials from private.retired_community_credential_work
    where batch_id = new_batch_id;

  with sources as (
    select 'item' kind, item_kind || ':' || item_key source_key, row_sha256
    from private.retired_community_deletion_items where batch_id = new_batch_id
    union all
    select 'object', bucket_id || ':' || object_name, expected_row_sha256
    from private.retired_community_storage_work where batch_id = new_batch_id
    union all
    select 'credential', destination_id::text, expected_row_sha256
    from private.retired_community_credential_work where batch_id = new_batch_id
  )
  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array(kind, source_key, row_sha256) order by kind, source_key)::text, '[]'))
  into source_digest from sources;

  update private.retired_community_deletion_batches set
    source_sha256 = source_digest, post_count = posts, comment_count = comments,
    like_count = likes, object_count = objects, credential_count = credentials, sealed = true
  where id = new_batch_id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (new_batch_id, 'created', target_requested_by, target_requested_at,
    jsonb_build_object('reason', target_reason, 'posts', posts, 'comments', comments,
      'likes', likes, 'objects', objects, 'credentials', credentials));
  return new_batch_id;
end;
$$;

create function private.preview_retired_community_deletion(
  target_reason text,
  target_subject_user_id uuid,
  target_crew_id uuid
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, private, pg_temp as $$
  with selected_posts as (
    select post_item.post_id from private.retired_community_t0_post_inventory post_item
    left join public.community_posts post_row on post_row.id = post_item.post_id
    where target_reason = 'aged_retention'
      or ((target_reason = 'account_erasure' and post_item.author_id = target_subject_user_id)
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256)
      or ((target_reason = 'group_deletion' and post_item.crew_id = target_crew_id)
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256)
  ), post_ids as (
    select coalesce(array_agg(post_id order by post_id), '{}'::uuid[]) ids from selected_posts
  ), selected_comments as (
    select comment_item.comment_id from private.retired_community_t0_comment_inventory comment_item
    left join public.post_comments comment_row on comment_row.id = comment_item.comment_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (comment_item.author_id = target_subject_user_id
          or comment_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion' and comment_item.post_id in (select post_id from selected_posts))))
  ), selected_likes as (
    select like_item.post_id, like_item.user_id from private.retired_community_t0_like_inventory like_item
    left join public.post_likes like_row
      on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (like_item.user_id = target_subject_user_id
          or like_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion' and like_item.post_id in (select post_id from selected_posts))))
  ), selected_objects as (
    select object_id from private.retired_community_t0_object_inventory object_item, post_ids
    where (target_reason = 'aged_retention' and cardinality(object_item.referenced_post_ids) > 0)
      or (target_reason = 'orphan_cleanup' and cardinality(object_item.referenced_post_ids) = 0)
      or (target_reason in ('account_erasure', 'group_deletion')
        and cardinality(object_item.referenced_post_ids) > 0
        and object_item.referenced_post_ids <@ post_ids.ids)
  )
  select jsonb_build_object(
    'batchId', null,
    'status', 'dry_run',
    'counts', jsonb_build_object(
      'posts', (select count(*) from selected_posts),
      'comments', (select count(*) from selected_comments),
      'likes', (select count(*) from selected_likes),
      'objects', (select count(*) from selected_objects),
      'credentials', case when target_reason = 'group_deletion'
        then (select count(*) from private.integration_destinations where crew_id = target_crew_id) else 0 end
    )
  );
$$;

create function public.plan_aged_retired_community_deletion(
  target_requested_by text,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare new_batch_id uuid;
begin
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('aged_retention', null, null);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'aged_retention', target_requested_by, null, null, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.plan_orphan_retired_community_deletion(
  target_requested_by text,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare new_batch_id uuid;
begin
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('orphan_cleanup', null, null);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'orphan_cleanup', target_requested_by, null, null, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.request_retired_community_account_erasure(
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare subject_id uuid := auth.uid();
declare new_batch_id uuid;
begin
  if subject_id is null then raise exception 'Not authenticated.' using errcode = '42501'; end if;
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('account_erasure', subject_id, null);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'account_erasure', subject_id::text, subject_id, null, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.request_retired_community_group_deletion(
  target_crew_id uuid,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare requester_id uuid := auth.uid();
declare new_batch_id uuid;
begin
  if requester_id is null then raise exception 'Not authenticated.' using errcode = '42501'; end if;
  if not public.can_manage_crew(target_crew_id) then
    raise exception 'Only a group owner or admin can request group deletion.' using errcode = '42501';
  end if;
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('group_deletion', null, target_crew_id);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'group_deletion', requester_id::text, null, target_crew_id, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.cancel_retired_community_group_deletion(target_batch_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare requester_id uuid := auth.uid();
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if requester_id is null then raise exception 'Not authenticated.' using errcode = '42501'; end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and reason = 'group_deletion';
  if not public.can_manage_crew(batch_row.crew_id) then
    raise exception 'Only a group owner or admin can cancel group deletion.' using errcode = '42501';
  end if;
  if exists (select 1 from private.retired_community_deletion_ledger
    where batch_id = batch_row.id and event_type = 'executed') then
    raise exception 'An executed group deletion cannot be cancelled.' using errcode = '55000';
  end if;
  if clock_timestamp() >= batch_row.execute_after then
    raise exception 'The 30-day group cancellation window has closed.' using errcode = '55000';
  end if;
  if not exists (select 1 from private.retired_community_deletion_ledger
    where batch_id = batch_row.id and event_type = 'cancelled') then
    insert into private.retired_community_deletion_ledger
      (batch_id, event_type, actor, event_at, details)
    values (batch_row.id, 'cancelled', requester_id::text, clock_timestamp(), '{}'::jsonb);
  end if;
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create function public.record_retired_community_backup_proof(
  target_batch_id uuid,
  target_backup_name text,
  target_backup_version text,
  target_source_sha256 text,
  target_bundle_sha256 text,
  target_bundle_bytes bigint,
  target_verified_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'A terminal deletion batch cannot accept backup proof.' using errcode = '55000';
  end if;
  if target_source_sha256 is distinct from batch_row.source_sha256 then
    raise exception 'Backup source digest does not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_backup_proofs (
    batch_id, backup_name, backup_version, source_sha256, bundle_sha256,
    bundle_bytes, verified_by, verified_at
  ) values (
    batch_row.id, target_backup_name, target_backup_version, target_source_sha256,
    target_bundle_sha256, target_bundle_bytes, target_verified_by, clock_timestamp()
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'backup_verified', target_verified_by, clock_timestamp(),
    jsonb_build_object('backupName', target_backup_name, 'backupVersion', target_backup_version,
      'sourceSha256', target_source_sha256, 'bundleSha256', target_bundle_sha256,
      'bundleBytes', target_bundle_bytes));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create function public.approve_retired_community_deletion_batch(
  target_batch_id uuid,
  target_approved_by text,
  target_source_sha256 text,
  target_bundle_sha256 text,
  target_post_count bigint,
  target_comment_count bigint,
  target_like_count bigint,
  target_object_count bigint,
  target_credential_count bigint
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare proof_row private.retired_community_backup_proofs%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  select * into strict proof_row from private.retired_community_backup_proofs
    where batch_id = batch_row.id;
  if target_approved_by = batch_row.requested_by or target_approved_by = proof_row.verified_by then
    raise exception 'The approver must be independent from the requester and backup verifier.' using errcode = '42501';
  end if;
  if (target_source_sha256, target_bundle_sha256) is distinct from
     (batch_row.source_sha256, proof_row.bundle_sha256) then
    raise exception 'Approval digests do not match the sealed batch and verified backup.' using errcode = '22023';
  end if;
  if (target_post_count, target_comment_count, target_like_count,
      target_object_count, target_credential_count) is distinct from
     (batch_row.post_count, batch_row.comment_count, batch_row.like_count,
      batch_row.object_count, batch_row.credential_count) then
    raise exception 'Approval counts do not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_batch_approvals (
    batch_id, approved_by, approved_at, source_sha256, bundle_sha256,
    post_count, comment_count, like_count, object_count, credential_count
  ) values (
    batch_row.id, target_approved_by, clock_timestamp(), target_source_sha256,
    target_bundle_sha256, target_post_count, target_comment_count,
    target_like_count, target_object_count, target_credential_count
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'approved', target_approved_by, clock_timestamp(),
    jsonb_build_object('sourceSha256', target_source_sha256,
      'bundleSha256', target_bundle_sha256, 'posts', target_post_count,
      'comments', target_comment_count, 'likes', target_like_count,
      'objects', target_object_count, 'credentials', target_credential_count));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create function public.claim_retired_community_storage_work(
  target_batch_id uuid,
  target_worker_token uuid,
  target_limit integer default 100
)
returns table (
  work_id uuid,
  bucket_id text,
  object_name text,
  expected_row_sha256 text
)
language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if target_worker_token is null or target_limit not between 1 and 100 then
    raise exception 'A worker token and limit from 1 to 100 are required.' using errcode = '22023';
  end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id) then
    raise exception 'Backup proof and independent approval are required before work begins.' using errcode = '55000';
  end if;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed')
     or clock_timestamp() < batch_row.execute_after then
    raise exception 'This deletion batch is not executable.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_storage_work work
    join storage.objects object_row
      on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
    where work.batch_id = batch_row.id and work.status <> 'confirmed'
      and private.retired_community_sha256(to_jsonb(object_row)::text) <> work.expected_row_sha256
  ) then
    raise exception 'A queued Storage object no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  return query
  with claims as (
    select work.id from private.retired_community_storage_work work
    where work.batch_id = batch_row.id
      and (work.status = 'queued' or (work.status = 'claimed' and
        (work.claim_token = target_worker_token
          or work.claimed_at <= clock_timestamp() - interval '15 minutes')))
    order by work.object_name limit target_limit for update skip locked
  )
  update private.retired_community_storage_work work set
    status = 'claimed', claim_token = target_worker_token, claimed_at = clock_timestamp()
  from claims where work.id = claims.id
  returning work.id, work.bucket_id, work.object_name, work.expected_row_sha256;
end;
$$;

create function public.confirm_retired_community_storage_work(
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid,
  target_actor text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare work_row private.retired_community_storage_work%rowtype;
begin
  select * into strict work_row from private.retired_community_storage_work
    where id = target_work_id and batch_id = target_batch_id for update;
  if work_row.status = 'confirmed' then
    return private.retired_community_batch_result(work_row.batch_id);
  end if;
  if private.retired_community_batch_status(work_row.batch_id) in ('cancelled', 'executed') then
    raise exception 'This deletion batch is terminal.' using errcode = '55000';
  end if;
  if work_row.status <> 'claimed' or work_row.claim_token is distinct from target_worker_token then
    raise exception 'Storage work is not claimed by this worker.' using errcode = '42501';
  end if;
  if exists (select 1 from storage.objects
    where bucket_id = work_row.bucket_id and name = work_row.object_name) then
    raise exception 'The Storage object still exists.' using errcode = '55000';
  end if;
  update private.retired_community_storage_work set
    status = 'confirmed', confirmed_at = clock_timestamp()
  where id = work_row.id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (work_row.batch_id, 'storage_confirmed', target_actor, clock_timestamp(),
    jsonb_build_object('workId', work_row.id));
  return private.retired_community_batch_result(work_row.batch_id);
end;
$$;

create function public.claim_retired_community_credential_work(
  target_batch_id uuid,
  target_worker_token uuid,
  target_limit integer default 20
)
returns table (
  work_id uuid,
  destination_id uuid,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version smallint
)
language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if target_worker_token is null or target_limit not between 1 and 20 then
    raise exception 'A worker token and limit from 1 to 20 are required.' using errcode = '22023';
  end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and reason = 'group_deletion' and sealed;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id)
     or clock_timestamp() < batch_row.execute_after
     or private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'This credential batch is not executable.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_credential_work work
    left join private.integration_destinations destination on destination.id = work.destination_id
    where work.batch_id = batch_row.id and work.status <> 'confirmed'
      and (destination.id is null
        or private.retired_community_credential_sha256(destination) <> work.expected_row_sha256)
  ) then
    raise exception 'A provider destination no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  return query
  with claims as (
    select work.id from private.retired_community_credential_work work
    where work.batch_id = batch_row.id
      and (work.status = 'queued' or (work.status = 'claimed' and
        (work.claim_token = target_worker_token
          or work.claimed_at <= clock_timestamp() - interval '15 minutes')))
    order by work.destination_id limit target_limit for update skip locked
  ), claimed as (
    update private.retired_community_credential_work work set
      status = 'claimed', claim_token = target_worker_token, claimed_at = clock_timestamp()
    from claims where work.id = claims.id returning work.*
  )
  select claimed.id, destination.id, destination.provider,
    destination.provider_workspace_id, destination.provider_destination_id,
    destination.credential_ciphertext, destination.credential_nonce,
    destination.credential_key_version
  from claimed join private.integration_destinations destination
    on destination.id = claimed.destination_id;
end;
$$;

create function public.confirm_retired_community_credential_work(
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid,
  target_actor text,
  target_provider_revocation_reference text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare work_row private.retired_community_credential_work%rowtype;
begin
  select * into strict work_row from private.retired_community_credential_work
    where id = target_work_id and batch_id = target_batch_id for update;
  if work_row.status = 'confirmed' then
    return private.retired_community_batch_result(work_row.batch_id);
  end if;
  if private.retired_community_batch_status(work_row.batch_id) in ('cancelled', 'executed') then
    raise exception 'This deletion batch is terminal.' using errcode = '55000';
  end if;
  if work_row.status <> 'claimed' or work_row.claim_token is distinct from target_worker_token then
    raise exception 'Credential work is not claimed by this worker.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from private.integration_destinations destination
    where destination.id = work_row.destination_id
      and private.retired_community_credential_sha256(destination) = work_row.expected_row_sha256
  ) then
    raise exception 'The provider credential no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  if char_length(trim(coalesce(target_provider_revocation_reference, ''))) not between 3 and 200 then
    raise exception 'A provider revocation reference is required.' using errcode = '22023';
  end if;
  update private.integration_destinations set
    status = 'revoked', credential_ciphertext = null, credential_nonce = null,
    credential_key_version = null, credential_fingerprint = null, scopes = '{}',
    disconnected_at = clock_timestamp(), last_error_code = null, last_error_summary = null
  where id = work_row.destination_id;
  update private.retired_community_credential_work set
    status = 'confirmed', confirmed_at = clock_timestamp(),
    provider_revocation_reference = target_provider_revocation_reference
  where id = work_row.id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (work_row.batch_id, 'credential_confirmed', target_actor, clock_timestamp(),
    jsonb_build_object('workId', work_row.id, 'provider', work_row.provider,
      'providerReference', target_provider_revocation_reference));
  return private.retired_community_batch_result(work_row.batch_id);
end;
$$;

create function public.execute_retired_community_deletion_batch(
  target_batch_id uuid,
  target_operator text,
  target_confirmation text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare census_row private.retired_community_t0_census%rowtype;
begin
  if target_confirmation is distinct from 'EXECUTE SEALED RETIRED COMMUNITY DELETION' then
    raise exception 'The exact destructive confirmation is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if private.retired_community_batch_status(batch_row.id) = 'executed' then
    return private.retired_community_batch_result(batch_row.id);
  end if;
  if private.retired_community_batch_status(batch_row.id) <> 'ready' then
    raise exception 'The deletion batch is not ready.' using errcode = '55000';
  end if;
  if batch_row.reason = 'aged_retention'
     and clock_timestamp() < census_row.captured_at + interval '91 days' then
    raise exception 'Aged retention cannot execute before T0 plus 91 days.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_deletion_items item
    left join public.community_posts post_row
      on item.item_kind = 'post' and post_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and ((post_row.id is not null
          and private.retired_community_sha256(to_jsonb(post_row)::text) <> item.row_sha256)
        or (post_row.id is null and not exists (
          select 1 from private.retired_community_deletion_items prior_item
          join private.retired_community_deletion_ledger prior_execution
            on prior_execution.batch_id = prior_item.batch_id
              and prior_execution.event_type = 'executed'
          where prior_item.batch_id <> item.batch_id
            and prior_item.item_kind = item.item_kind
            and prior_item.item_key = item.item_key
            and prior_item.row_sha256 = item.row_sha256
        )))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_comments comment_row
      on item.item_kind = 'comment' and comment_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and ((comment_row.id is not null
          and private.retired_community_sha256(to_jsonb(comment_row)::text) <> item.row_sha256)
        or (comment_row.id is null and not exists (
          select 1 from private.retired_community_deletion_items prior_item
          join private.retired_community_deletion_ledger prior_execution
            on prior_execution.batch_id = prior_item.batch_id
              and prior_execution.event_type = 'executed'
          where prior_item.batch_id <> item.batch_id
            and prior_item.item_kind = item.item_kind
            and prior_item.item_key = item.item_key
            and prior_item.row_sha256 = item.row_sha256
        )))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_likes like_row on item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and ((like_row.post_id is not null
          and private.retired_community_sha256(to_jsonb(like_row)::text) <> item.row_sha256)
        or (like_row.post_id is null and not exists (
          select 1 from private.retired_community_deletion_items prior_item
          join private.retired_community_deletion_ledger prior_execution
            on prior_execution.batch_id = prior_item.batch_id
              and prior_execution.event_type = 'executed'
          where prior_item.batch_id <> item.batch_id
            and prior_item.item_kind = item.item_kind
            and prior_item.item_key = item.item_key
            and prior_item.row_sha256 = item.row_sha256
        )))
  ) then
    raise exception 'A relational source row no longer matches the sealed batch.' using errcode = '55000';
  end if;

  if batch_row.reason = 'account_erasure' then
    delete from public.post_comments comment_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and comment_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from public.post_likes like_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid;
    delete from public.community_posts post_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and post_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from auth.users where id = batch_row.subject_user_id;
  elsif batch_row.reason = 'group_deletion' then
    delete from public.crews where id = batch_row.crew_id;
  elsif batch_row.reason = 'aged_retention' then
    delete from public.post_comments comment_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and comment_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from public.post_likes like_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid;
    delete from public.community_posts post_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and post_row.id = split_part(item.item_key, ':', 1)::uuid;
  end if;

  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'executed', target_operator, clock_timestamp(),
    jsonb_build_object('reason', batch_row.reason, 'posts', batch_row.post_count,
      'comments', batch_row.comment_count, 'likes', batch_row.like_count,
      'objects', batch_row.object_count, 'credentials', batch_row.credential_count));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

revoke all on private.retired_community_deletion_batches from public, anon, authenticated, service_role;
revoke all on private.retired_community_deletion_items from public, anon, authenticated, service_role;
revoke all on private.retired_community_storage_work from public, anon, authenticated, service_role;
revoke all on private.retired_community_credential_work from public, anon, authenticated, service_role;
revoke all on private.retired_community_backup_proofs from public, anon, authenticated, service_role;
revoke all on private.retired_community_batch_approvals from public, anon, authenticated, service_role;
revoke all on private.retired_community_deletion_ledger from public, anon, authenticated, service_role;
revoke all on sequence private.retired_community_deletion_ledger_id_seq
  from public, anon, authenticated, service_role;

revoke all on function private.guard_retired_community_batch_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_item_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_record_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_batch_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_batch_result(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_credential_sha256(private.integration_destinations)
  from public, anon, authenticated, service_role;
revoke all on function private.create_retired_community_deletion_batch(text,text,uuid,uuid,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.preview_retired_community_deletion(text,uuid,uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.plan_aged_retired_community_deletion(text,boolean)
  from public, anon, authenticated;
revoke all on function public.plan_orphan_retired_community_deletion(text,boolean)
  from public, anon, authenticated;
revoke all on function public.record_retired_community_backup_proof(uuid,text,text,text,text,bigint,text)
  from public, anon, authenticated;
revoke all on function public.approve_retired_community_deletion_batch(uuid,text,text,text,bigint,bigint,bigint,bigint,bigint)
  from public, anon, authenticated;
revoke all on function public.claim_retired_community_storage_work(uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.confirm_retired_community_storage_work(uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.claim_retired_community_credential_work(uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.confirm_retired_community_credential_work(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.execute_retired_community_deletion_batch(uuid,text,text)
  from public, anon, authenticated;

grant execute on function public.plan_aged_retired_community_deletion(text,boolean) to service_role;
grant execute on function public.plan_orphan_retired_community_deletion(text,boolean) to service_role;
grant execute on function public.record_retired_community_backup_proof(uuid,text,text,text,text,bigint,text)
  to service_role;
grant execute on function public.approve_retired_community_deletion_batch(uuid,text,text,text,bigint,bigint,bigint,bigint,bigint)
  to service_role;
grant execute on function public.claim_retired_community_storage_work(uuid,uuid,integer) to service_role;
grant execute on function public.confirm_retired_community_storage_work(uuid,uuid,uuid,text) to service_role;
grant execute on function public.claim_retired_community_credential_work(uuid,uuid,integer) to service_role;
grant execute on function public.confirm_retired_community_credential_work(uuid,uuid,uuid,text,text)
  to service_role;
grant execute on function public.execute_retired_community_deletion_batch(uuid,text,text) to service_role;

revoke all on function public.request_retired_community_account_erasure(boolean)
  from public, anon, service_role;
revoke all on function public.request_retired_community_group_deletion(uuid,boolean)
  from public, anon, service_role;
revoke all on function public.cancel_retired_community_group_deletion(uuid)
  from public, anon, service_role;
grant execute on function public.request_retired_community_account_erasure(boolean) to authenticated;
grant execute on function public.request_retired_community_group_deletion(uuid,boolean) to authenticated;
grant execute on function public.cancel_retired_community_group_deletion(uuid) to authenticated;

comment on table private.retired_community_deletion_batches is
  'Sealed immutable deletion scopes; state is derived from append-only proof, approval, work, and ledger records.';
comment on function public.claim_retired_community_storage_work(uuid,uuid,integer) is
  'Worker-only exact Storage paths. SQL never deletes storage.objects.';
comment on function public.execute_retired_community_deletion_batch(uuid,text,text) is
  'Executes only a sealed, backed-up, independently approved batch after exact object and credential confirmation.';
-- FOU-564 P4: production worker boundaries, two-scan orphan proof,
-- redacted manifests, aged-backup verification, and DR reapplication.

create function private.normalize_retired_community_operator(target_value text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select lower(btrim(coalesce(target_value, '')));
$$;

create function private.normalize_retired_community_batch_requester()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.requested_by := private.normalize_retired_community_operator(new.requested_by);
  return new;
end;
$$;

create trigger a_normalize_retired_community_batch_requester
  before insert on private.retired_community_deletion_batches
  for each row execute function private.normalize_retired_community_batch_requester();

create function private.normalize_retired_community_backup_verifier()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.verified_by := private.normalize_retired_community_operator(new.verified_by);
  return new;
end;
$$;

create trigger a_normalize_retired_community_backup_verifier
  before insert on private.retired_community_backup_proofs
  for each row execute function private.normalize_retired_community_backup_verifier();

create function private.normalize_retired_community_approver()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.approved_by := private.normalize_retired_community_operator(new.approved_by);
  return new;
end;
$$;

create trigger a_normalize_retired_community_approver
  before insert on private.retired_community_batch_approvals
  for each row execute function private.normalize_retired_community_approver();

create function private.normalize_retired_community_ledger_actor()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.actor := private.normalize_retired_community_operator(new.actor);
  return new;
end;
$$;

create trigger a_normalize_retired_community_ledger_actor
  before insert on private.retired_community_deletion_ledger
  for each row execute function private.normalize_retired_community_ledger_actor();

alter table private.retired_community_storage_work
  drop constraint if exists retired_community_storage_work_bucket_id_check;
alter table private.retired_community_storage_work
  add constraint retired_community_storage_work_bucket_id_check check (
    bucket_id in ('community-post-images', 'profile-photos', 'journal-progress')
  );
alter table private.retired_community_storage_work
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_failed_at timestamptz,
  add column last_error_code text check (
    last_error_code is null or last_error_code in ('storage_retry_exhausted')
  );
alter table private.retired_community_credential_work
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_failed_at timestamptz,
  add column last_error_code text check (
    last_error_code is null or last_error_code in ('credential_retry_exhausted')
  );

create function private.record_retired_community_work_attempt()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.status = 'claimed' and (
    old.status is distinct from 'claimed'
    or new.claim_token is distinct from old.claim_token
  ) then
    new.attempt_count := old.attempt_count + 1;
  elsif new.status = 'confirmed' then
    new.last_error_code := null;
  end if;
  return new;
end;
$$;

create trigger record_retired_community_storage_attempt
  before update on private.retired_community_storage_work
  for each row execute function private.record_retired_community_work_attempt();
create trigger record_retired_community_credential_attempt
  before update on private.retired_community_credential_work
  for each row execute function private.record_retired_community_work_attempt();

create function private.normalize_retired_community_created_ledger_counts()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if new.event_type = 'created' then
    select * into strict batch_row
    from private.retired_community_deletion_batches where id = new.batch_id;
    new.details := jsonb_build_object(
      'reason', batch_row.reason,
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    );
  end if;
  return new;
end;
$$;

create trigger b_normalize_retired_community_created_ledger_counts
  before insert on private.retired_community_deletion_ledger
  for each row execute function private.normalize_retired_community_created_ledger_counts();

create or replace function private.guard_retired_community_item_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from private.retired_community_purge_manifests manifest
    where manifest.batch_id = old.batch_id
      and manifest.expires_at <= clock_timestamp()
  ) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Retired Community deletion items are immutable.' using errcode = '55000';
  end if;
  if (select sealed from private.retired_community_deletion_batches where id = new.batch_id) then
    raise exception 'A sealed deletion batch cannot accept items.' using errcode = '55000';
  end if;
  return new;
end;
$$;

insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
select batch_row.id, 'cancelled', 'p4-account-storage-protocol-migration', clock_timestamp(),
  jsonb_build_object('reason', 'legacy_account_batch_missing_full_asset_inventory')
from private.retired_community_deletion_batches batch_row
where batch_row.reason = 'account_erasure'
  and not exists (
    select 1 from private.retired_community_deletion_ledger terminal
    where terminal.batch_id = batch_row.id
      and terminal.event_type in ('cancelled', 'executed')
  );

create function private.retired_community_item_was_executed(
  target_batch_id uuid,
  target_item_kind text,
  target_item_key text,
  target_row_sha256 text
)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
      select 1
      from private.retired_community_deletion_items prior_item
      join private.retired_community_deletion_ledger prior_execution
        on prior_execution.batch_id = prior_item.batch_id
          and prior_execution.event_type = 'executed'
      where prior_item.batch_id <> target_batch_id
        and prior_item.item_kind = target_item_kind
        and prior_item.item_key = target_item_key
        and prior_item.row_sha256 = target_row_sha256
    ) or exists (
      select 1
      from private.retired_community_deletion_batches target_batch
      join private.retired_community_deletion_batches prior_batch
        on prior_batch.id <> target_batch.id
        and prior_batch.reason = 'aged_retention'
        and prior_batch.sealed
        and prior_batch.t0_source_sha256 = target_batch.t0_source_sha256
        and prior_batch.post_count = (
          select count(*) from private.retired_community_t0_post_inventory
        )
        and prior_batch.comment_count = (
          select count(*) from private.retired_community_t0_comment_inventory
        )
        and prior_batch.like_count = (
          select count(*) from private.retired_community_t0_like_inventory
        )
        and prior_batch.object_count = (
          select count(*) from private.retired_community_t0_object_inventory inventory
          where cardinality(inventory.referenced_post_ids) > 0
        )
        and prior_batch.credential_count = 0
      join private.retired_community_deletion_ledger prior_execution
        on prior_execution.batch_id = prior_batch.id
          and prior_execution.event_type = 'executed'
      where target_batch.id = target_batch_id
        and case target_item_kind
          when 'post' then exists (
            select 1 from private.retired_community_t0_post_inventory inventory
            where inventory.post_id = target_item_key::uuid
              and inventory.row_sha256 = target_row_sha256
          )
          when 'comment' then exists (
            select 1 from private.retired_community_t0_comment_inventory inventory
            where inventory.comment_id = target_item_key::uuid
              and inventory.row_sha256 = target_row_sha256
          )
          when 'like' then exists (
            select 1 from private.retired_community_t0_like_inventory inventory
            where inventory.post_id = split_part(target_item_key, ':', 1)::uuid
              and inventory.user_id = split_part(target_item_key, ':', 2)::uuid
              and inventory.row_sha256 = target_row_sha256
          )
          else false
        end
    );
$$;

create function private.retired_community_object_was_executed(
  target_batch_id uuid,
  target_bucket_id text,
  target_object_name text,
  target_row_sha256 text
)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1
    from private.retired_community_storage_work prior_work
    join private.retired_community_deletion_ledger prior_execution
      on prior_execution.batch_id = prior_work.batch_id
        and prior_execution.event_type = 'executed'
    where prior_work.batch_id <> target_batch_id
      and prior_work.bucket_id = target_bucket_id
      and prior_work.object_name = target_object_name
      and prior_work.expected_row_sha256 = target_row_sha256
      and prior_work.status = 'confirmed'
  ) or exists (
    select 1
    from private.retired_community_deletion_batches target_batch
    join private.retired_community_deletion_batches prior_batch
      on prior_batch.id <> target_batch.id
      and prior_batch.reason = 'aged_retention'
      and prior_batch.sealed
      and prior_batch.t0_source_sha256 = target_batch.t0_source_sha256
      and prior_batch.post_count = (
        select count(*) from private.retired_community_t0_post_inventory
      )
      and prior_batch.comment_count = (
        select count(*) from private.retired_community_t0_comment_inventory
      )
      and prior_batch.like_count = (
        select count(*) from private.retired_community_t0_like_inventory
      )
      and prior_batch.object_count = (
        select count(*) from private.retired_community_t0_object_inventory inventory
        where cardinality(inventory.referenced_post_ids) > 0
      )
      and prior_batch.credential_count = 0
    join private.retired_community_deletion_ledger prior_execution
      on prior_execution.batch_id = prior_batch.id
        and prior_execution.event_type = 'executed'
    join private.retired_community_t0_object_inventory inventory
      on inventory.bucket_id = target_bucket_id
        and inventory.object_name = target_object_name
        and inventory.row_sha256 = target_row_sha256
        and cardinality(inventory.referenced_post_ids) > 0
    where target_batch.id = target_batch_id
  );
$$;

create function private.assert_retired_community_batch_evidence_complete(
  target_batch_id uuid
)
returns void language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare posts bigint;
declare comments bigint;
declare likes bigint;
declare objects bigint;
declare credentials bigint;
declare source_digest text;
begin
  select * into strict batch_row
  from private.retired_community_deletion_batches
  where id = target_batch_id and sealed;
  select count(*) filter (where item_kind = 'post'),
    count(*) filter (where item_kind = 'comment'),
    count(*) filter (where item_kind = 'like')
  into posts, comments, likes
  from private.retired_community_deletion_items where batch_id = batch_row.id;
  select count(*) into objects
  from private.retired_community_storage_work where batch_id = batch_row.id;
  select count(*) into credentials
  from private.retired_community_credential_work where batch_id = batch_row.id;
  with sources as (
    select 'item' kind, item_kind || ':' || item_key source_key, row_sha256
    from private.retired_community_deletion_items where batch_id = batch_row.id
    union all
    select 'object', bucket_id || ':' || object_name, expected_row_sha256
    from private.retired_community_storage_work where batch_id = batch_row.id
    union all
    select 'credential', destination_id::text, expected_row_sha256
    from private.retired_community_credential_work where batch_id = batch_row.id
  )
  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array(kind, source_key, row_sha256)
      order by kind, source_key)::text,
    '[]'
  )) into source_digest
  from sources;
  if (posts, comments, likes, objects, credentials, source_digest) is distinct from (
    batch_row.post_count, batch_row.comment_count, batch_row.like_count,
    batch_row.object_count, batch_row.credential_count, batch_row.source_sha256
  ) then
    raise exception 'The sealed deletion batch no longer has complete exact evidence.'
      using errcode = '55000';
  end if;
end;
$$;

create function private.assert_retired_community_cascade_scope(target_batch_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row
  from private.retired_community_deletion_batches
  where id = target_batch_id;

  if exists (
    select 1
    from private.retired_community_backup_proofs proof
    left join private.retired_community_batch_approvals approval
      on approval.batch_id = proof.batch_id
    where proof.batch_id = batch_row.id
      and (
        private.normalize_retired_community_operator(proof.verified_by)
          = private.normalize_retired_community_operator(batch_row.requested_by)
        or (approval.batch_id is not null and (
          private.normalize_retired_community_operator(approval.approved_by)
            = private.normalize_retired_community_operator(batch_row.requested_by)
          or private.normalize_retired_community_operator(approval.approved_by)
            = private.normalize_retired_community_operator(proof.verified_by)
        ))
      )
  ) then
    raise exception 'Deletion batch requester, backup verifier, and approver must be independent.'
      using errcode = '42501';
  end if;

  if batch_row.reason <> 'account_erasure' and exists (
    select 1 from private.retired_community_storage_work work
    where work.batch_id = batch_row.id
      and work.bucket_id <> 'community-post-images'
  ) then
    raise exception 'Only account erasure may contain personal asset Storage work.'
      using errcode = '55000';
  end if;

  if batch_row.reason = 'orphan_cleanup' and exists (
    select 1
    from private.retired_community_storage_work work
    join public.community_posts post_row on post_row.image_path = work.object_name
    where work.batch_id = batch_row.id
      and work.bucket_id = 'community-post-images'
  ) then
    raise exception 'Orphan deletion object acquired a current post reference.'
      using errcode = '55000';
  end if;

  if batch_row.reason not in ('account_erasure', 'group_deletion') then
    return;
  end if;

  if batch_row.reason = 'account_erasure' then
    if exists (
      select 1
      from private.retired_community_t0_post_inventory inventory
      left join public.community_posts post_row on post_row.id = inventory.post_id
      where inventory.author_id = batch_row.subject_user_id
        and (
          (post_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'post', inventory.post_id::text, inventory.row_sha256))
          or (post_row.id is not null
            and private.retired_community_sha256(to_jsonb(post_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_comment_inventory inventory
      left join public.post_comments comment_row on comment_row.id = inventory.comment_id
      where (inventory.author_id = batch_row.subject_user_id
          or exists (
            select 1 from private.retired_community_t0_post_inventory post_inventory
            where post_inventory.post_id = inventory.post_id
              and post_inventory.author_id = batch_row.subject_user_id
          ))
        and (
          (comment_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'comment', inventory.comment_id::text, inventory.row_sha256))
          or (comment_row.id is not null
            and private.retired_community_sha256(to_jsonb(comment_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_like_inventory inventory
      left join public.post_likes like_row
        on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
      where (inventory.user_id = batch_row.subject_user_id
          or exists (
            select 1 from private.retired_community_t0_post_inventory post_inventory
            where post_inventory.post_id = inventory.post_id
              and post_inventory.author_id = batch_row.subject_user_id
          ))
        and (
          (like_row.post_id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'like', inventory.post_id::text || ':' || inventory.user_id::text,
            inventory.row_sha256))
          or (like_row.post_id is not null
            and private.retired_community_sha256(to_jsonb(like_row)::text) <> inventory.row_sha256)
        )
    ) then
      raise exception 'Account erasure source rows drifted from T0 without a prior executed deletion.'
        using errcode = '55000';
    end if;

    if exists (
      select 1 from public.community_posts post_row
      where post_row.author_id = batch_row.subject_user_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'post'
            and item.item_key = post_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(post_row)::text)
        )
    ) or exists (
      select 1 from public.post_comments comment_row
      where (comment_row.user_id = batch_row.subject_user_id
          or exists (
            select 1 from public.community_posts post_row
            where post_row.id = comment_row.post_id
              and post_row.author_id = batch_row.subject_user_id
          ))
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'comment'
            and item.item_key = comment_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(comment_row)::text)
        )
    ) or exists (
      select 1 from public.post_likes like_row
      where (like_row.user_id = batch_row.subject_user_id
          or exists (
            select 1 from public.community_posts post_row
            where post_row.id = like_row.post_id
              and post_row.author_id = batch_row.subject_user_id
          ))
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'like'
            and item.item_key = like_row.post_id::text || ':' || like_row.user_id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(like_row)::text)
        )
    ) then
      raise exception 'Account erasure would cascade beyond its sealed relational manifest.'
        using errcode = '55000';
    end if;
  else
    if exists (
      select 1
      from private.retired_community_t0_post_inventory inventory
      left join public.community_posts post_row on post_row.id = inventory.post_id
      where inventory.crew_id = batch_row.crew_id
        and (
          (post_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'post', inventory.post_id::text, inventory.row_sha256))
          or (post_row.id is not null
            and private.retired_community_sha256(to_jsonb(post_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_comment_inventory inventory
      left join public.post_comments comment_row on comment_row.id = inventory.comment_id
      where exists (
          select 1 from private.retired_community_t0_post_inventory post_inventory
          where post_inventory.post_id = inventory.post_id
            and post_inventory.crew_id = batch_row.crew_id
        )
        and (
          (comment_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'comment', inventory.comment_id::text, inventory.row_sha256))
          or (comment_row.id is not null
            and private.retired_community_sha256(to_jsonb(comment_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_like_inventory inventory
      left join public.post_likes like_row
        on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
      where exists (
          select 1 from private.retired_community_t0_post_inventory post_inventory
          where post_inventory.post_id = inventory.post_id
            and post_inventory.crew_id = batch_row.crew_id
        )
        and (
          (like_row.post_id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'like', inventory.post_id::text || ':' || inventory.user_id::text,
            inventory.row_sha256))
          or (like_row.post_id is not null
            and private.retired_community_sha256(to_jsonb(like_row)::text) <> inventory.row_sha256)
        )
    ) then
      raise exception 'Group deletion source rows drifted from T0 without a prior executed deletion.'
        using errcode = '55000';
    end if;

    if exists (
      select 1 from public.community_posts post_row
      where post_row.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'post'
            and item.item_key = post_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(post_row)::text)
        )
    ) or exists (
      select 1 from public.post_comments comment_row
      join public.community_posts post_row on post_row.id = comment_row.post_id
      where post_row.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'comment'
            and item.item_key = comment_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(comment_row)::text)
        )
    ) or exists (
      select 1 from public.post_likes like_row
      join public.community_posts post_row on post_row.id = like_row.post_id
      where post_row.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'like'
            and item.item_key = like_row.post_id::text || ':' || like_row.user_id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(like_row)::text)
        )
    ) then
      raise exception 'Group deletion would cascade beyond its sealed relational manifest.'
        using errcode = '55000';
    end if;
  end if;

  if exists (
    with selected_posts as (
      select post_row.id, post_row.image_path
      from private.retired_community_deletion_items item
      join public.community_posts post_row
        on item.item_kind = 'post' and item.item_key = post_row.id::text
      where item.batch_id = batch_row.id
    ), exclusive_paths as (
      select distinct selected.image_path
      from selected_posts selected
      where selected.image_path is not null
        and not exists (
          select 1 from public.community_posts other_post
          where other_post.image_path = selected.image_path
            and not exists (select 1 from selected_posts covered where covered.id = other_post.id)
        )
    )
    select 1
    from exclusive_paths path
    join storage.objects object_row
      on object_row.bucket_id = 'community-post-images' and object_row.name = path.image_path
    where not exists (
      select 1 from private.retired_community_storage_work work
      where work.batch_id = batch_row.id
        and work.bucket_id = object_row.bucket_id and work.object_name = object_row.name
        and work.expected_row_sha256 = private.retired_community_sha256(to_jsonb(object_row)::text)
    )
  ) or exists (
    with selected_posts as (
      select post_row.id, post_row.image_path
      from private.retired_community_deletion_items item
      join public.community_posts post_row
        on item.item_kind = 'post' and item.item_key = post_row.id::text
      where item.batch_id = batch_row.id
    )
    select 1
    from private.retired_community_storage_work work
    left join storage.objects object_row
      on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
    where work.batch_id = batch_row.id and work.bucket_id = 'community-post-images'
      and (
        (object_row.id is null and work.status <> 'confirmed'
          and not private.retired_community_object_was_executed(
            batch_row.id, work.bucket_id, work.object_name, work.expected_row_sha256))
        or (object_row.id is not null and (
          private.retired_community_sha256(to_jsonb(object_row)::text) <> work.expected_row_sha256
          or (
            not exists (
              select 1 from selected_posts selected
              where selected.image_path = work.object_name
            )
            and not (
              batch_row.reason = 'account_erasure'
              and (
                object_row.owner = batch_row.subject_user_id
                or (storage.foldername(object_row.name))[2]
                  = batch_row.subject_user_id::text
              )
              and not exists (
                select 1 from public.community_posts referenced_post
                where referenced_post.image_path = object_row.name
              )
            )
          )
          or exists (
            select 1 from public.community_posts other_post
            where other_post.image_path = work.object_name
              and not exists (select 1 from selected_posts covered where covered.id = other_post.id)
          )
        ))
      )
  ) then
    raise exception 'Account or group deletion object work does not exactly cover its cascade.'
      using errcode = '55000';
  end if;

  if batch_row.reason = 'account_erasure' and (
    exists (
      select 1 from storage.objects object_row
      where (
        (
          object_row.bucket_id in ('profile-photos', 'journal-progress')
          and (
            object_row.owner = batch_row.subject_user_id
            or (storage.foldername(object_row.name))[1] = batch_row.subject_user_id::text
          )
        ) or (
          object_row.bucket_id = 'community-post-images'
          and (
            object_row.owner = batch_row.subject_user_id
            or (storage.foldername(object_row.name))[2] = batch_row.subject_user_id::text
          )
          and not exists (
            select 1 from public.community_posts referenced_post
            where referenced_post.image_path = object_row.name
          )
        )
      )
        and not exists (
          select 1 from private.retired_community_storage_work work
          where work.batch_id = batch_row.id
            and work.object_id = object_row.id
            and work.bucket_id = object_row.bucket_id
            and work.object_name = object_row.name
            and work.expected_row_sha256 =
              private.retired_community_sha256(to_jsonb(object_row)::text)
        )
    ) or exists (
      select 1
      from private.retired_community_storage_work work
      left join storage.objects object_row
        on object_row.id = work.object_id
          and object_row.bucket_id = work.bucket_id
          and object_row.name = work.object_name
      where work.batch_id = batch_row.id
        and work.bucket_id in ('profile-photos', 'journal-progress')
        and (
          (object_row.id is null and work.status <> 'confirmed'
            and not private.retired_community_object_was_executed(
              batch_row.id, work.bucket_id, work.object_name, work.expected_row_sha256))
          or (object_row.id is not null and (
            private.retired_community_sha256(to_jsonb(object_row)::text)
              <> work.expected_row_sha256
            or not (
              object_row.owner = batch_row.subject_user_id
              or (storage.foldername(object_row.name))[1] = batch_row.subject_user_id::text
            )
          ))
        )
    )
  ) then
    raise exception 'Account erasure personal asset work does not exactly cover the subject.'
      using errcode = '55000';
  end if;

  if batch_row.reason = 'group_deletion' and (
    exists (
      select 1 from private.integration_destinations destination
      where destination.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_credential_work work
          where work.batch_id = batch_row.id and work.destination_id = destination.id
            and (
              (work.status = 'confirmed' and destination.status = 'revoked'
                and destination.credential_ciphertext is null
                and destination.credential_nonce is null
                and destination.credential_key_version is null)
              or (work.status <> 'confirmed'
                and work.expected_row_sha256 = private.retired_community_credential_sha256(destination))
            )
        )
    ) or exists (
      select 1 from private.retired_community_credential_work work
      left join private.integration_destinations destination on destination.id = work.destination_id
      where work.batch_id = batch_row.id
        and (destination.id is null and work.status <> 'confirmed'
          or destination.id is not null and destination.crew_id <> batch_row.crew_id)
    )
  ) then
    raise exception 'Group deletion credential work does not exactly cover its cascade.'
      using errcode = '55000';
  end if;
end;
$$;

create function private.lock_retired_community_mutation_scope_when_creating()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, storage, pg_temp as $$
begin
  if new.reason in ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup') then
    lock table public.community_posts in share mode;
  end if;
  if new.reason in ('aged_retention', 'account_erasure', 'group_deletion') then
    lock table public.post_comments in share mode;
    lock table public.post_likes in share mode;
  end if;
  if new.reason = 'account_erasure' then
    lock table storage.objects in share mode;
    lock table private.outbound_deliveries in share mode;
  elsif new.reason = 'group_deletion' then
    lock table storage.objects in share mode;
    lock table private.integration_destinations in share mode;
  elsif new.reason in ('aged_retention', 'orphan_cleanup') then
    lock table storage.objects in share mode;
  end if;
  return new;
end;
$$;

create trigger a_lock_retired_community_mutation_scope_when_creating
  before insert on private.retired_community_deletion_batches
  for each row execute function private.lock_retired_community_mutation_scope_when_creating();

create function private.add_retired_community_account_assets_when_sealing()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason = 'account_erasure'
     and new.requested_by <> 'dr-ledger-reapply' then
    lock table storage.objects in share mode;
    insert into private.retired_community_storage_work (
      batch_id, object_id, bucket_id, object_name, expected_row_sha256
    )
    select new.id, object_row.id, object_row.bucket_id, object_row.name,
      private.retired_community_sha256(to_jsonb(object_row)::text)
    from storage.objects object_row
    where (
        object_row.bucket_id in ('profile-photos', 'journal-progress')
        and (
          object_row.owner = new.subject_user_id
          or (storage.foldername(object_row.name))[1] = new.subject_user_id::text
        )
      ) or (
        object_row.bucket_id = 'community-post-images'
        and (
          object_row.owner = new.subject_user_id
          or (storage.foldername(object_row.name))[2] = new.subject_user_id::text
        )
        and not exists (
          select 1 from public.community_posts referenced_post
          where referenced_post.image_path = object_row.name
        )
      )
    on conflict (batch_id, bucket_id, object_name) do nothing;

    select count(*) into new.object_count
    from private.retired_community_storage_work work where work.batch_id = new.id;

    with sources as (
      select 'item' kind, item_kind || ':' || item_key source_key, row_sha256
      from private.retired_community_deletion_items where batch_id = new.id
      union all
      select 'object', bucket_id || ':' || object_name, expected_row_sha256
      from private.retired_community_storage_work where batch_id = new.id
      union all
      select 'credential', destination_id::text, expected_row_sha256
      from private.retired_community_credential_work where batch_id = new.id
    )
    select private.retired_community_sha256(coalesce(
      jsonb_agg(jsonb_build_array(kind, source_key, row_sha256)
        order by kind, source_key)::text,
      '[]'
    )) into new.source_sha256
    from sources;
  end if;
  return new;
end;
$$;

create trigger c_add_retired_community_account_assets_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.add_retired_community_account_assets_when_sealing();

create function private.confirm_retired_community_credentialless_when_sealing()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason = 'group_deletion'
     and new.requested_by <> 'dr-ledger-reapply' then
    update private.integration_destinations destination set
      status = 'revoked', disconnected_at = coalesce(destination.disconnected_at, clock_timestamp()),
      last_error_code = null, last_error_summary = null
    from private.retired_community_credential_work work
    where work.batch_id = new.id
      and work.destination_id = destination.id
      and work.expected_row_sha256 = private.retired_community_credential_sha256(destination)
      and destination.credential_ciphertext is null
      and destination.credential_nonce is null
      and destination.credential_key_version is null;

    update private.retired_community_credential_work work set
      status = 'confirmed', confirmed_at = clock_timestamp(),
      provider_revocation_reference = 'already-credentialless'
    from private.integration_destinations destination
    where work.batch_id = new.id
      and work.destination_id = destination.id
      and destination.status = 'revoked'
      and destination.credential_ciphertext is null
      and destination.credential_nonce is null
      and destination.credential_key_version is null;
  end if;
  return new;
end;
$$;

create trigger b_confirm_retired_community_credentialless_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.confirm_retired_community_credentialless_when_sealing();

create function private.cancel_retired_community_account_deliveries_when_sealing()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason = 'account_erasure' then
    update private.outbound_deliveries set
      status = 'cancelled', cancelled_at = clock_timestamp(),
      last_error_code = 'account_erasure',
      last_error_summary = 'Delivery cancelled because its subject requested account erasure.',
      lock_token = null, locked_at = null
    where subject_user_id = new.subject_user_id
      and status in ('queued', 'processing', 'retry');
  end if;
  return new;
end;
$$;

create trigger d_cancel_retired_community_account_deliveries_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.cancel_retired_community_account_deliveries_when_sealing();

create or replace function private.preview_retired_community_deletion(
  target_reason text,
  target_subject_user_id uuid,
  target_crew_id uuid
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
  with selected_posts as (
    select post_item.post_id from private.retired_community_t0_post_inventory post_item
    left join public.community_posts post_row on post_row.id = post_item.post_id
    where target_reason = 'aged_retention'
      or ((target_reason = 'account_erasure' and post_item.author_id = target_subject_user_id)
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256)
      or ((target_reason = 'group_deletion' and post_item.crew_id = target_crew_id)
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256)
  ), post_ids as (
    select coalesce(array_agg(post_id order by post_id), '{}'::uuid[]) ids from selected_posts
  ), selected_comments as (
    select comment_item.comment_id from private.retired_community_t0_comment_inventory comment_item
    left join public.post_comments comment_row on comment_row.id = comment_item.comment_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (comment_item.author_id = target_subject_user_id
          or comment_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion'
          and comment_item.post_id in (select post_id from selected_posts))))
  ), selected_likes as (
    select like_item.post_id, like_item.user_id
    from private.retired_community_t0_like_inventory like_item
    left join public.post_likes like_row
      on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (like_item.user_id = target_subject_user_id
          or like_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion'
          and like_item.post_id in (select post_id from selected_posts))))
  ), selected_objects as (
    select object_item.bucket_id, object_item.object_name
    from private.retired_community_t0_object_inventory object_item, post_ids
    where (target_reason = 'aged_retention' and cardinality(object_item.referenced_post_ids) > 0)
      or (target_reason = 'orphan_cleanup' and cardinality(object_item.referenced_post_ids) = 0)
      or (target_reason in ('account_erasure', 'group_deletion')
        and cardinality(object_item.referenced_post_ids) > 0
        and object_item.referenced_post_ids <@ post_ids.ids)
    union
    select object_row.bucket_id, object_row.name
    from storage.objects object_row
    where target_reason = 'account_erasure'
      and (
        (
          object_row.bucket_id in ('profile-photos', 'journal-progress')
          and (
            object_row.owner = target_subject_user_id
            or (storage.foldername(object_row.name))[1] = target_subject_user_id::text
          )
        ) or (
          object_row.bucket_id = 'community-post-images'
          and (
            object_row.owner = target_subject_user_id
            or (storage.foldername(object_row.name))[2] = target_subject_user_id::text
          )
          and not exists (
            select 1 from public.community_posts referenced_post
            where referenced_post.image_path = object_row.name
          )
        )
      )
  )
  select jsonb_build_object(
    'batchId', null,
    'status', 'dry_run',
    'counts', jsonb_build_object(
      'posts', (select count(*) from selected_posts),
      'comments', (select count(*) from selected_comments),
      'likes', (select count(*) from selected_likes),
      'objects', (select count(*) from selected_objects),
      'credentials', case when target_reason = 'group_deletion'
        then (select count(*) from private.integration_destinations
          where crew_id = target_crew_id) else 0 end
    )
  );
$$;

create function private.assert_retired_community_scope_when_sealed()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason in ('account_erasure', 'group_deletion') then
    perform private.assert_retired_community_cascade_scope(new.id);
  end if;
  return new;
end;
$$;

create trigger assert_retired_community_scope_when_sealed
  after update of sealed on private.retired_community_deletion_batches
  for each row execute function private.assert_retired_community_scope_when_sealed();

create or replace function public.record_retired_community_backup_proof(
  target_batch_id uuid,
  target_backup_name text,
  target_backup_version text,
  target_source_sha256 text,
  target_bundle_sha256 text,
  target_bundle_bytes bigint,
  target_verified_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare normalized_verifier text := private.normalize_retired_community_operator(target_verified_by);
begin
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed for update;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'A terminal deletion batch cannot accept backup proof.' using errcode = '55000';
  end if;
  if normalized_verifier = private.normalize_retired_community_operator(batch_row.requested_by) then
    raise exception 'The backup verifier must be independent from the requester.' using errcode = '42501';
  end if;
  if target_source_sha256 is distinct from batch_row.source_sha256 then
    raise exception 'Backup source digest does not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_backup_proofs (
    batch_id, backup_name, backup_version, source_sha256, bundle_sha256,
    bundle_bytes, verified_by, verified_at
  ) values (
    batch_row.id, target_backup_name, target_backup_version, target_source_sha256,
    target_bundle_sha256, target_bundle_bytes, normalized_verifier, clock_timestamp()
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'backup_verified', normalized_verifier, clock_timestamp(),
    jsonb_build_object('backupName', target_backup_name, 'backupVersion', target_backup_version,
      'sourceSha256', target_source_sha256, 'bundleSha256', target_bundle_sha256,
      'bundleBytes', target_bundle_bytes));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create or replace function public.approve_retired_community_deletion_batch(
  target_batch_id uuid,
  target_approved_by text,
  target_source_sha256 text,
  target_bundle_sha256 text,
  target_post_count bigint,
  target_comment_count bigint,
  target_like_count bigint,
  target_object_count bigint,
  target_credential_count bigint
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare proof_row private.retired_community_backup_proofs%rowtype;
declare normalized_approver text := private.normalize_retired_community_operator(target_approved_by);
begin
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed for update;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'A terminal deletion batch cannot be approved.' using errcode = '55000';
  end if;
  select * into strict proof_row from private.retired_community_backup_proofs
    where batch_id = batch_row.id;
  if private.normalize_retired_community_operator(proof_row.verified_by)
      = private.normalize_retired_community_operator(batch_row.requested_by) then
    raise exception 'The backup verifier must be independent from the requester.'
      using errcode = '42501';
  end if;
  if normalized_approver = private.normalize_retired_community_operator(batch_row.requested_by)
     or normalized_approver = private.normalize_retired_community_operator(proof_row.verified_by) then
    raise exception 'The approver must be independent from the requester and backup verifier.' using errcode = '42501';
  end if;
  if (target_source_sha256, target_bundle_sha256) is distinct from
     (batch_row.source_sha256, proof_row.bundle_sha256) then
    raise exception 'Approval digests do not match the sealed batch and verified backup.' using errcode = '22023';
  end if;
  if (target_post_count, target_comment_count, target_like_count,
      target_object_count, target_credential_count) is distinct from
     (batch_row.post_count, batch_row.comment_count, batch_row.like_count,
      batch_row.object_count, batch_row.credential_count) then
    raise exception 'Approval counts do not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_batch_approvals (
    batch_id, approved_by, approved_at, source_sha256, bundle_sha256,
    post_count, comment_count, like_count, object_count, credential_count
  ) values (
    batch_row.id, normalized_approver, clock_timestamp(), target_source_sha256,
    target_bundle_sha256, target_post_count, target_comment_count,
    target_like_count, target_object_count, target_credential_count
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'approved', normalized_approver, clock_timestamp(),
    jsonb_build_object('sourceSha256', target_source_sha256,
      'bundleSha256', target_bundle_sha256, 'posts', target_post_count,
      'comments', target_comment_count, 'likes', target_like_count,
      'objects', target_object_count, 'credentials', target_credential_count));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create or replace function public.cancel_retired_community_group_deletion(target_batch_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare requester_id uuid := auth.uid();
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if requester_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and reason = 'group_deletion' for update;
  if not public.can_manage_crew(batch_row.crew_id) then
    raise exception 'Only a group owner or admin can cancel group deletion.' using errcode = '42501';
  end if;
  if private.retired_community_batch_status(batch_row.id) = 'executed' then
    raise exception 'An executed group deletion cannot be cancelled.' using errcode = '55000';
  end if;
  if clock_timestamp() >= batch_row.execute_after then
    raise exception 'The 30-day group cancellation window has closed.' using errcode = '55000';
  end if;
  if private.retired_community_batch_status(batch_row.id) <> 'cancelled' then
    insert into private.retired_community_deletion_ledger
      (batch_id, event_type, actor, event_at, details)
    values (batch_row.id, 'cancelled', requester_id::text, clock_timestamp(), '{}'::jsonb);
  end if;
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create table private.retired_community_orphan_scans (
  id uuid primary key,
  scanned_at timestamptz not null,
  recorded_at timestamptz not null,
  recorded_by text not null check (char_length(recorded_by) between 3 and 160),
  object_count bigint not null check (object_count >= 0),
  inventory_sha256 text not null check (inventory_sha256 ~ '^[0-9a-f]{64}$'),
  replacement_number integer not null default 0 check (replacement_number >= 0)
);

create table private.retired_community_orphan_scan_items (
  scan_id uuid not null references private.retired_community_orphan_scans(id) on delete cascade,
  object_id uuid not null,
  bucket_id text not null check (bucket_id = 'community-post-images'),
  object_name text not null,
  expected_row_sha256 text not null check (expected_row_sha256 ~ '^[0-9a-f]{64}$'),
  referenced_post_count bigint not null check (referenced_post_count >= 0),
  primary key (scan_id, bucket_id, object_name),
  unique (scan_id, object_id)
);

create table private.retired_community_orphan_scan_audit (
  id bigint generated always as identity primary key,
  scan_id uuid not null references private.retired_community_orphan_scans(id) on delete restrict,
  event_type text not null check (event_type in ('recorded', 'replaced')),
  actor text not null check (char_length(actor) between 3 and 160),
  event_at timestamptz not null,
  object_count bigint not null check (object_count >= 0),
  inventory_sha256 text not null check (inventory_sha256 ~ '^[0-9a-f]{64}$')
);

alter table private.retired_community_deletion_batches
  add column orphan_first_scan_id uuid references private.retired_community_orphan_scans(id) on delete restrict,
  add column orphan_second_scan_id uuid references private.retired_community_orphan_scans(id) on delete restrict;

insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
select batch_row.id, 'cancelled', 'p4-scan-protocol-migration', clock_timestamp(),
  jsonb_build_object('reason', 'legacy_orphan_batch_missing_two_scan_proof')
from private.retired_community_deletion_batches batch_row
where batch_row.reason = 'orphan_cleanup'
  and batch_row.orphan_first_scan_id is null
  and batch_row.orphan_second_scan_id is null
  and not exists (
    select 1 from private.retired_community_deletion_ledger terminal
    where terminal.batch_id = batch_row.id
      and terminal.event_type in ('cancelled', 'executed')
  );

alter table private.retired_community_deletion_batches
  add constraint retired_community_deletion_batches_orphan_scans_check check (
    (reason = 'orphan_cleanup' and (
      (not sealed and orphan_first_scan_id is null and orphan_second_scan_id is null)
      or (orphan_first_scan_id is not null and orphan_second_scan_id is not null
        and orphan_first_scan_id <> orphan_second_scan_id)
    ))
    or (reason <> 'orphan_cleanup' and orphan_first_scan_id is null and orphan_second_scan_id is null)
  ) not valid;

do $retired_community_validate_orphan_scan_constraint$
begin
  if not exists (
    select 1 from private.retired_community_deletion_batches
    where reason = 'orphan_cleanup' and sealed
      and (orphan_first_scan_id is null or orphan_second_scan_id is null)
  ) then
    execute 'alter table private.retired_community_deletion_batches '
      || 'validate constraint retired_community_deletion_batches_orphan_scans_check';
  end if;
end;
$retired_community_validate_orphan_scan_constraint$;

create function private.block_retired_community_orphan_scan_audit_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Retired Community orphan scan audit records are append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_orphan_scan_audit_mutation
  before update or delete on private.retired_community_orphan_scan_audit
  for each row execute function private.block_retired_community_orphan_scan_audit_mutation();

create function public.record_retired_community_orphan_scan(
  target_scan_id uuid,
  target_recorded_by text,
  target_inventory jsonb
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare normalized_actor text := private.normalize_retired_community_operator(target_recorded_by);
declare input_count bigint;
declare current_count bigint;
declare replacement integer := 0;
declare inventory_digest text;
declare scan_time timestamptz := clock_timestamp();
begin
  if target_scan_id is null or target_inventory is null
     or jsonb_typeof(target_inventory) is distinct from 'array'
     or jsonb_array_length(target_inventory) > 100000 then
    raise exception 'A scan ID and complete inventory array are required.' using errcode = '22023';
  end if;
  if char_length(normalized_actor) not between 3 and 160 then
    raise exception 'A named scan operator is required.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(target_inventory) entry
    where jsonb_typeof(entry) <> 'object'
      or not (entry ?& array['objectId', 'bucketId', 'objectName'])
      or entry - array['objectId', 'bucketId', 'objectName'] <> '{}'::jsonb
  ) then
    raise exception 'Scan inventory entries must contain only exact object identity fields.' using errcode = '22023';
  end if;

  select count(*),
    count(distinct source."objectId"),
    count(distinct source."bucketId" || ':' || source."objectName")
  into input_count, current_count, replacement
  from jsonb_to_recordset(target_inventory) as source(
    "objectId" uuid, "bucketId" text, "objectName" text
  );
  if input_count <> current_count or input_count <> replacement
     or exists (
       select 1 from jsonb_to_recordset(target_inventory) as source(
         "objectId" uuid, "bucketId" text, "objectName" text
       )
       where source."bucketId" <> 'community-post-images'
         or source."objectName" is null or source."objectName" = ''
     ) then
    raise exception 'Scan inventory contains duplicate or invalid object identities.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  lock table storage.objects in share mode;
  lock table public.community_posts in share mode;
  select count(*) into current_count from storage.objects
    where bucket_id = 'community-post-images';
  if input_count <> current_count
     or exists (
       select 1
       from jsonb_to_recordset(target_inventory) as source(
         "objectId" uuid, "bucketId" text, "objectName" text
       )
       left join storage.objects object_row
         on object_row.id = source."objectId" and object_row.bucket_id = source."bucketId"
           and object_row.name = source."objectName"
       where object_row.id is null
     )
     or exists (
       select 1 from storage.objects object_row
       where object_row.bucket_id = 'community-post-images'
         and not exists (
           select 1 from jsonb_to_recordset(target_inventory) as source(
             "objectId" uuid, "bucketId" text, "objectName" text
           )
           where source."objectId" = object_row.id
             and source."bucketId" = object_row.bucket_id
             and source."objectName" = object_row.name
         )
     ) then
    raise exception 'The worker inventory is not a complete exact bucket scan.' using errcode = '55000';
  end if;

  if exists (select 1 from private.retired_community_orphan_scans where id = target_scan_id) then
    select replacement_number + 1 into replacement
      from private.retired_community_orphan_scans where id = target_scan_id for update;
    if exists (
      select 1 from private.retired_community_deletion_batches
      where orphan_first_scan_id = target_scan_id or orphan_second_scan_id = target_scan_id
    ) then
      raise exception 'A scan bound to a deletion batch cannot be replaced.' using errcode = '55000';
    end if;
    delete from private.retired_community_orphan_scan_items where scan_id = target_scan_id;
    update private.retired_community_orphan_scans set
      scanned_at = scan_time, recorded_at = scan_time, recorded_by = normalized_actor,
      object_count = 0, inventory_sha256 = repeat('0', 64), replacement_number = replacement
    where id = target_scan_id;
  else
    replacement := 0;
    insert into private.retired_community_orphan_scans (
      id, scanned_at, recorded_at, recorded_by, object_count, inventory_sha256, replacement_number
    ) values (
      target_scan_id, scan_time, scan_time, normalized_actor, 0, repeat('0', 64), replacement
    );
  end if;

  insert into private.retired_community_orphan_scan_items (
    scan_id, object_id, bucket_id, object_name, expected_row_sha256, referenced_post_count
  )
  select target_scan_id, object_row.id, object_row.bucket_id, object_row.name,
    private.retired_community_sha256(to_jsonb(object_row)::text),
    (select count(*) from public.community_posts post_row where post_row.image_path = object_row.name)
  from storage.objects object_row
  join jsonb_to_recordset(target_inventory) as source(
    "objectId" uuid, "bucketId" text, "objectName" text
  ) on source."objectId" = object_row.id and source."bucketId" = object_row.bucket_id
    and source."objectName" = object_row.name
  where object_row.bucket_id = 'community-post-images';

  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array(object_id, bucket_id, object_name,
      expected_row_sha256, referenced_post_count) order by bucket_id, object_name)::text,
    '[]'))
  into inventory_digest
  from private.retired_community_orphan_scan_items where scan_id = target_scan_id;

  update private.retired_community_orphan_scans set
    object_count = input_count, inventory_sha256 = inventory_digest
  where id = target_scan_id;
  insert into private.retired_community_orphan_scan_audit (
    scan_id, event_type, actor, event_at, object_count, inventory_sha256
  ) values (
    target_scan_id, case when replacement = 0 then 'recorded' else 'replaced' end,
    normalized_actor, scan_time, input_count, inventory_digest
  );
  return jsonb_build_object('scanId', target_scan_id, 'status', 'complete',
    'counts', jsonb_build_object('objects', input_count));
end;
$$;

create function private.retired_community_orphan_scan_pair()
returns table (first_scan_id uuid, second_scan_id uuid)
language sql security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
  with second_scan as (
    select scan.id, scan.scanned_at
    from private.retired_community_orphan_scans scan
    where scan.scanned_at >= statement_timestamp() - interval '24 hours'
      and scan.object_count = (
        select count(*) from private.retired_community_orphan_scan_items item
        where item.scan_id = scan.id
      )
    order by scan.scanned_at desc, scan.id desc limit 1
  )
  select first_scan.id, second_scan.id
  from second_scan
  join lateral (
    select scan.id
    from private.retired_community_orphan_scans scan
    where scan.scanned_at <= second_scan.scanned_at - interval '7 days'
      and scan.object_count = (
        select count(*) from private.retired_community_orphan_scan_items item
        where item.scan_id = scan.id
      )
    order by scan.scanned_at desc, scan.id desc limit 1
  ) first_scan on true;
$$;

create or replace function private.preview_retired_community_orphan_deletion()
returns jsonb language sql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
  with pair as (
    select * from private.retired_community_orphan_scan_pair()
  ), candidates as (
    select second_item.object_id
    from pair
    join private.retired_community_orphan_scan_items first_item
      on first_item.scan_id = pair.first_scan_id
    join private.retired_community_orphan_scan_items second_item
      on second_item.scan_id = pair.second_scan_id
      and second_item.object_id = first_item.object_id
      and second_item.bucket_id = first_item.bucket_id
      and second_item.object_name = first_item.object_name
      and second_item.expected_row_sha256 = first_item.expected_row_sha256
    join storage.objects object_row
      on object_row.id = second_item.object_id and object_row.bucket_id = second_item.bucket_id
        and object_row.name = second_item.object_name
        and private.retired_community_sha256(to_jsonb(object_row)::text) = second_item.expected_row_sha256
    where first_item.referenced_post_count = 0 and second_item.referenced_post_count = 0
      and not exists (
        select 1 from public.community_posts post_row
        where post_row.image_path = second_item.object_name
      )
      and not exists (
        select 1
        from private.retired_community_storage_work active_work
        join private.retired_community_deletion_batches active_batch
          on active_batch.id = active_work.batch_id
        where active_work.bucket_id = second_item.bucket_id
          and active_work.object_name = second_item.object_name
          and not exists (
            select 1 from private.retired_community_deletion_ledger terminal
            where terminal.batch_id = active_batch.id
              and terminal.event_type in ('cancelled', 'executed')
          )
      )
  )
  select jsonb_build_object(
    'batchId', null,
    'status', case when exists (select 1 from pair) then 'dry_run' else 'awaiting_scan' end,
    'counts', jsonb_build_object(
      'posts', 0, 'comments', 0, 'likes', 0,
      'objects', (select count(*) from candidates), 'credentials', 0
    )
  );
$$;

create or replace function private.create_retired_community_orphan_batch(
  target_requested_by text,
  target_requested_at timestamptz
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare census_row private.retired_community_t0_census%rowtype;
declare pair_row record;
declare new_batch_id uuid := gen_random_uuid();
declare normalized_requester text := private.normalize_retired_community_operator(target_requested_by);
declare source_digest text;
declare objects bigint;
begin
  if char_length(normalized_requester) not between 3 and 160 then
    raise exception 'A named requester is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  select * into strict census_row from private.retired_community_t0_census where singleton;
  select * into pair_row from private.retired_community_orphan_scan_pair();
  if pair_row.first_scan_id is null or pair_row.second_scan_id is null then
    raise exception 'Two complete bucket scans at least seven days apart are required.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_deletion_batches batch_row
    where batch_row.reason = 'orphan_cleanup'
      and not exists (
        select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id and terminal.event_type in ('cancelled', 'executed')
      )
  ) then
    raise exception 'An active deletion batch already covers this target.' using errcode = '55000';
  end if;

  insert into private.retired_community_deletion_batches (
    id, reason, requested_by, requested_at, execute_after, t0_source_sha256,
    orphan_first_scan_id, orphan_second_scan_id
  ) values (
    new_batch_id, 'orphan_cleanup', normalized_requester, target_requested_at,
    target_requested_at, census_row.source_sha256,
    pair_row.first_scan_id, pair_row.second_scan_id
  );

  insert into private.retired_community_storage_work (
    batch_id, object_id, bucket_id, object_name, expected_row_sha256
  )
  select new_batch_id, second_item.object_id, second_item.bucket_id,
    second_item.object_name, second_item.expected_row_sha256
  from private.retired_community_orphan_scan_items first_item
  join private.retired_community_orphan_scan_items second_item
    on second_item.scan_id = pair_row.second_scan_id
      and second_item.object_id = first_item.object_id
      and second_item.bucket_id = first_item.bucket_id
      and second_item.object_name = first_item.object_name
      and second_item.expected_row_sha256 = first_item.expected_row_sha256
  join storage.objects object_row
    on object_row.id = second_item.object_id and object_row.bucket_id = second_item.bucket_id
      and object_row.name = second_item.object_name
      and private.retired_community_sha256(to_jsonb(object_row)::text) = second_item.expected_row_sha256
  where first_item.scan_id = pair_row.first_scan_id
    and first_item.referenced_post_count = 0 and second_item.referenced_post_count = 0
    and not exists (
      select 1 from public.community_posts post_row
      where post_row.image_path = second_item.object_name
    )
    and not exists (
      select 1
      from private.retired_community_storage_work active_work
      join private.retired_community_deletion_batches active_batch
        on active_batch.id = active_work.batch_id
      where active_work.bucket_id = second_item.bucket_id
        and active_work.object_name = second_item.object_name
        and active_batch.id <> new_batch_id
        and not exists (
          select 1 from private.retired_community_deletion_ledger terminal
          where terminal.batch_id = active_batch.id
            and terminal.event_type in ('cancelled', 'executed')
        )
    );

  select count(*) into objects from private.retired_community_storage_work
    where batch_id = new_batch_id;
  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array('object', bucket_id || ':' || object_name,
      expected_row_sha256) order by bucket_id, object_name)::text, '[]'))
  into source_digest from private.retired_community_storage_work where batch_id = new_batch_id;
  update private.retired_community_deletion_batches set
    source_sha256 = source_digest, post_count = 0, comment_count = 0,
    like_count = 0, object_count = objects, credential_count = 0, sealed = true
  where id = new_batch_id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (new_batch_id, 'created', normalized_requester, target_requested_at,
    jsonb_build_object('reason', 'orphan_cleanup', 'posts', 0, 'comments', 0,
      'likes', 0, 'objects', objects, 'credentials', 0));
  return new_batch_id;
end;
$$;

create or replace function public.plan_orphan_retired_community_deletion(
  target_requested_by text,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare new_batch_id uuid;
begin
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_orphan_deletion();
  end if;
  new_batch_id := private.create_retired_community_orphan_batch(
    target_requested_by, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create table private.retired_community_purge_manifests (
  batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  reason text not null check (reason in
    ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup')),
  executed_at timestamptz not null,
  expires_at timestamptz not null,
  t0_source_sha256 text not null check (t0_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint not null check (post_count >= 0),
  comment_count bigint not null check (comment_count >= 0),
  like_count bigint not null check (like_count >= 0),
  object_count bigint not null check (object_count >= 0),
  credential_count bigint not null check (credential_count >= 0),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  check (expires_at = executed_at + interval '180 days')
);

create table private.retired_community_backup_reverifications (
  batch_id uuid primary key references private.retired_community_purge_manifests(batch_id) on delete cascade,
  verified_at timestamptz not null,
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  verification_reference_sha256 text not null check (verification_reference_sha256 ~ '^[0-9a-f]{64}$'),
  verifier_identity_sha256 text not null check (verifier_identity_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_t0_purge_records (
  singleton boolean primary key default true check (singleton),
  aged_batch_id uuid not null unique
    references private.retired_community_deletion_batches(id) on delete restrict,
  purged_at timestamptz not null,
  t0_source_sha256 text not null check (t0_source_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint not null check (post_count >= 0),
  comment_count bigint not null check (comment_count >= 0),
  like_count bigint not null check (like_count >= 0),
  total_object_count bigint not null check (total_object_count >= 0),
  referenced_object_count bigint not null check (referenced_object_count >= 0),
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_batch_identity_redactions (
  batch_id uuid primary key
    references private.retired_community_deletion_batches(id) on delete restrict,
  reason text not null check (reason in
    ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup')),
  redacted_at timestamptz not null,
  subject_identity_removed boolean not null,
  crew_identity_removed boolean not null,
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$')
);

create trigger block_retired_community_t0_purge_record_mutation
  before update or delete on private.retired_community_t0_purge_records
  for each row execute function private.block_retired_community_record_mutation();
create trigger block_retired_community_batch_identity_redaction_mutation
  before update or delete on private.retired_community_batch_identity_redactions
  for each row execute function private.block_retired_community_record_mutation();

create or replace function private.guard_retired_community_batch_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.sealed then
      raise exception 'Retired Community deletion batches must be assembled before sealing.' using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.sealed
     and exists (
       select 1 from private.retired_community_batch_identity_redactions redaction
       where redaction.batch_id = old.id
     )
     and new.requested_by = 'redacted-after-retention'
     and new.subject_user_id is not distinct from (case
       when old.reason = 'account_erasure'
         then '00000000-0000-0000-0000-000000000000'::uuid
       else null::uuid end)
     and new.crew_id is not distinct from (case
       when old.reason = 'group_deletion'
         then '00000000-0000-0000-0000-000000000000'::uuid
       else null::uuid end)
     and (to_jsonb(new) - 'requested_by' - 'subject_user_id' - 'crew_id')
       = (to_jsonb(old) - 'requested_by' - 'subject_user_id' - 'crew_id') then
    return new;
  end if;
  if tg_op = 'DELETE' or old.sealed then
    raise exception 'Retired Community deletion batches are immutable.' using errcode = '55000';
  end if;
  if new.sealed then
    if new.source_sha256 is null or new.post_count is null or new.post_count < 0
       or new.comment_count is null or new.comment_count < 0
       or new.like_count is null or new.like_count < 0
       or new.object_count is null or new.object_count < 0
       or new.credential_count is null or new.credential_count < 0 then
      raise exception 'A sealed deletion batch requires a digest and all five non-negative counts.'
        using errcode = '55000';
    end if;
    if new.id = old.id and new.reason = old.reason
       and new.requested_by = old.requested_by and new.requested_at = old.requested_at
       and new.execute_after = old.execute_after and new.deadline_at is not distinct from old.deadline_at
       and new.subject_user_id is not distinct from old.subject_user_id
       and new.crew_id is not distinct from old.crew_id
       and new.t0_source_sha256 = old.t0_source_sha256 then
      return new;
    end if;
  end if;
  raise exception 'Retired Community deletion batches may only be sealed once.' using errcode = '55000';
end;
$$;

create or replace function private.block_retired_community_record_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'retired_community_deletion_ledger'
     and (to_jsonb(new) ->> 'actor') = 'redacted-after-retention'
     and (to_jsonb(new) - 'actor') = (to_jsonb(old) - 'actor')
     and exists (
       select 1 from private.retired_community_batch_identity_redactions redaction
       where redaction.batch_id = old.batch_id
     ) then
    return new;
  end if;
  if tg_op = 'DELETE'
     and tg_table_name in ('retired_community_backup_proofs',
       'retired_community_batch_approvals')
     and exists (
       select 1 from private.retired_community_batch_identity_redactions redaction
       where redaction.batch_id = old.batch_id
     ) then
    return old;
  end if;
  raise exception 'Retired Community proof, approval, and ledger records are append-only.'
    using errcode = '55000';
end;
$$;

create or replace function private.block_retired_community_t0_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE'
     and tg_table_name <> 'retired_community_t0_census'
     and exists (select 1 from private.retired_community_t0_purge_records) then
    return old;
  end if;
  raise exception 'The retired Community T0 snapshot is immutable.' using errcode = '55000';
end;
$$;

create function private.retired_community_evidence_is_releasable(target_batch_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  return exists (
    select 1
    from private.retired_community_purge_manifests manifest
    where manifest.batch_id = target_batch_id
      and manifest.expires_at <= clock_timestamp()
      and not exists (
        select 1 from private.retired_community_dr_reapplications reapplication
        where reapplication.source_batch_id = manifest.batch_id
          and reapplication.reapplied_at is null
      )
      and (
        manifest.reason <> 'aged_retention'
        or exists (select 1 from private.retired_community_t0_purge_records)
        or not exists (
          select 1 from private.retired_community_deletion_batches active_batch
          where not exists (
            select 1 from private.retired_community_deletion_ledger terminal
            where terminal.batch_id = active_batch.id
              and terminal.event_type in ('cancelled', 'executed')
          )
        )
      )
  ) or exists (
    select 1
    from private.retired_community_deletion_batches batch_row
    join private.retired_community_deletion_ledger cancellation
      on cancellation.batch_id = batch_row.id and cancellation.event_type = 'cancelled'
    where batch_row.id = target_batch_id
      and batch_row.sealed
      and cancellation.event_at + interval '180 days' <= clock_timestamp()
      and not exists (
        select 1 from private.retired_community_deletion_ledger execution
        where execution.batch_id = batch_row.id and execution.event_type = 'executed'
      )
  );
end;
$$;

create or replace function private.guard_retired_community_item_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE'
     and private.retired_community_evidence_is_releasable(old.batch_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Retired Community deletion items are immutable.' using errcode = '55000';
  end if;
  if (select sealed from private.retired_community_deletion_batches where id = new.batch_id) then
    raise exception 'A sealed deletion batch cannot accept items.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create function private.guard_retired_community_work_delete()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if private.retired_community_evidence_is_releasable(old.batch_id) then
    return old;
  end if;
  raise exception 'Retired Community exact work cannot be deleted before its retention hold closes.'
    using errcode = '55000';
end;
$$;

create trigger guard_retired_community_storage_work_delete
  before delete on private.retired_community_storage_work
  for each row execute function private.guard_retired_community_work_delete();
create trigger guard_retired_community_credential_work_delete
  before delete on private.retired_community_credential_work
  for each row execute function private.guard_retired_community_work_delete();

create function private.retired_community_manifest_payload(
  target_batch_id uuid,
  target_executed_at timestamptz
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'batchId', batch_row.id,
    'reason', batch_row.reason,
    'executedAt', target_executed_at,
    'expiresAt', target_executed_at + interval '180 days',
    't0SourceSha256', batch_row.t0_source_sha256,
    'sourceSha256', batch_row.source_sha256,
    'bundleSha256', proof.bundle_sha256,
    'counts', jsonb_build_object(
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    )
  )
  from private.retired_community_deletion_batches batch_row
  join private.retired_community_backup_proofs proof on proof.batch_id = batch_row.id
  where batch_row.id = target_batch_id;
$$;

create function private.record_retired_community_purge_manifest(
  target_batch_id uuid,
  target_executed_at timestamptz
)
returns void language plpgsql security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
declare payload jsonb;
begin
  payload := private.retired_community_manifest_payload(target_batch_id, target_executed_at);
  if payload is null then
    raise exception 'A verified backup is required before recording a purge manifest.' using errcode = '55000';
  end if;
  insert into private.retired_community_purge_manifests (
    batch_id, reason, executed_at, expires_at, t0_source_sha256, source_sha256,
    bundle_sha256, post_count, comment_count, like_count, object_count,
    credential_count, manifest_sha256
  )
  select batch_row.id, batch_row.reason, target_executed_at,
    target_executed_at + interval '180 days', batch_row.t0_source_sha256,
    batch_row.source_sha256, proof.bundle_sha256, batch_row.post_count,
    batch_row.comment_count, batch_row.like_count, batch_row.object_count,
    batch_row.credential_count, private.retired_community_sha256(payload::text)
  from private.retired_community_deletion_batches batch_row
  join private.retired_community_backup_proofs proof on proof.batch_id = batch_row.id
  where batch_row.id = target_batch_id
  on conflict (batch_id) do nothing;
end;
$$;

do $retired_community_manifest_backfill$
declare execution record;
begin
  for execution in
    select ledger.batch_id, min(ledger.event_at) as executed_at
    from private.retired_community_deletion_ledger ledger
    join private.retired_community_backup_proofs proof on proof.batch_id = ledger.batch_id
    where ledger.event_type = 'executed'
    group by ledger.batch_id
  loop
    perform private.record_retired_community_purge_manifest(
      execution.batch_id,
      execution.executed_at
    );
  end loop;
end;
$retired_community_manifest_backfill$;

create function private.guard_retired_community_purge_manifest_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE' or old.expires_at > clock_timestamp() then
    raise exception 'Retired Community purge manifests are immutable for 180 days.' using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger guard_retired_community_purge_manifest_mutation
  before update or delete on private.retired_community_purge_manifests
  for each row execute function private.guard_retired_community_purge_manifest_mutation();

create function private.block_retired_community_backup_reverification_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE' and (
    not exists (
      select 1 from private.retired_community_purge_manifests manifest
      where manifest.batch_id = old.batch_id
    ) or exists (
      select 1 from private.retired_community_purge_manifests manifest
      where manifest.batch_id = old.batch_id and manifest.expires_at <= clock_timestamp()
    )
  ) then
    return old;
  end if;
  raise exception 'Retired Community backup reverifications are append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_backup_reverification_mutation
  before update or delete on private.retired_community_backup_reverifications
  for each row execute function private.block_retired_community_backup_reverification_mutation();

create function public.verify_retired_community_backup_after_30_days(
  target_batch_id uuid,
  target_bundle_sha256 text,
  target_verification_reference_sha256 text,
  target_verified_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
declare manifest_row private.retired_community_purge_manifests%rowtype;
declare normalized_verifier text := private.normalize_retired_community_operator(target_verified_by);
begin
  select * into strict manifest_row from private.retired_community_purge_manifests
    where batch_id = target_batch_id;
  if clock_timestamp() < manifest_row.executed_at + interval '30 days' then
    raise exception 'Backup age verification cannot be recorded before purge plus 30 days.' using errcode = '55000';
  end if;
  if target_bundle_sha256 is distinct from manifest_row.bundle_sha256 then
    raise exception 'Backup age verification does not match the purged bundle.' using errcode = '22023';
  end if;
  if target_verification_reference_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(normalized_verifier) not between 3 and 160 then
    raise exception 'A verification reference and named verifier are required.' using errcode = '22023';
  end if;
  insert into private.retired_community_backup_reverifications (
    batch_id, verified_at, bundle_sha256, verification_reference_sha256,
    verifier_identity_sha256
  ) values (
    target_batch_id, clock_timestamp(), target_bundle_sha256,
    target_verification_reference_sha256,
    private.retired_community_sha256(normalized_verifier)
  );
  return private.retired_community_batch_result(target_batch_id);
end;
$$;

create function public.purge_expired_retired_community_manifests()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare expired_batch_ids uuid[];
declare affected_count bigint;
declare evidence_deleted bigint := 0;
declare scan_items_deleted bigint := 0;
declare manifests_deleted bigint := 0;
declare t0_batch_id uuid;
declare t0_source_sha text;
declare t0_post_count bigint := 0;
declare t0_comment_count bigint := 0;
declare t0_like_count bigint := 0;
declare t0_total_object_count bigint := 0;
declare t0_referenced_object_count bigint := 0;
declare t0_identity_rows_deleted bigint := 0;
declare t0_record_payload jsonb;
declare evidence_batch_id uuid;
declare identity_rows_redacted bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  select coalesce(array_agg(batch_row.id order by batch_row.id), '{}'::uuid[])
  into expired_batch_ids
  from private.retired_community_deletion_batches batch_row
  where private.retired_community_evidence_is_releasable(batch_row.id)
    and not exists (
      select 1 from private.retired_community_batch_identity_redactions redaction
      where redaction.batch_id = batch_row.id
    );

  select batch_row.id into t0_batch_id
  from private.retired_community_deletion_batches batch_row
  where batch_row.id = any(expired_batch_ids)
    and batch_row.reason = 'aged_retention'
    and not exists (select 1 from private.retired_community_t0_purge_records)
    and exists (
      select 1 from private.retired_community_purge_manifests manifest
      where manifest.batch_id = batch_row.id
        and manifest.reason = 'aged_retention'
        and manifest.expires_at <= clock_timestamp()
    )
  order by batch_row.requested_at, batch_row.id
  limit 1;

  foreach evidence_batch_id in array expired_batch_ids loop
    perform private.assert_retired_community_batch_evidence_complete(evidence_batch_id);
  end loop;

  if t0_batch_id is not null then
    select census.source_sha256 into strict t0_source_sha
    from private.retired_community_t0_census census where census.singleton;
    select count(*) into t0_post_count
    from private.retired_community_t0_post_inventory;
    select count(*) into t0_comment_count
    from private.retired_community_t0_comment_inventory;
    select count(*) into t0_like_count
    from private.retired_community_t0_like_inventory;
    select count(*), count(*) filter (where cardinality(referenced_post_ids) > 0)
    into t0_total_object_count, t0_referenced_object_count
    from private.retired_community_t0_object_inventory;
    if not exists (
      select 1 from private.retired_community_deletion_batches batch_row
      where batch_row.id = t0_batch_id
        and batch_row.sealed
        and batch_row.t0_source_sha256 = t0_source_sha
        and batch_row.post_count = t0_post_count
        and batch_row.comment_count = t0_comment_count
        and batch_row.like_count = t0_like_count
        and batch_row.object_count = t0_referenced_object_count
        and batch_row.credential_count = 0
        and exists (
          select 1 from private.retired_community_deletion_ledger execution
          where execution.batch_id = batch_row.id and execution.event_type = 'executed'
        )
    ) then
      raise exception 'T0 identity retention cannot close without the exact executed aged batch.'
        using errcode = '55000';
    end if;
  end if;

  insert into private.retired_community_batch_identity_redactions (
    batch_id, reason, redacted_at, subject_identity_removed,
    crew_identity_removed, record_sha256
  )
  select batch_row.id, batch_row.reason, clock_timestamp(),
    batch_row.subject_user_id is not null, batch_row.crew_id is not null,
    private.retired_community_sha256(jsonb_build_object(
      'batchId', batch_row.id,
      'reason', batch_row.reason,
      'subjectIdentityRemoved', batch_row.subject_user_id is not null,
      'crewIdentityRemoved', batch_row.crew_id is not null,
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    )::text)
  from private.retired_community_deletion_batches batch_row
  where batch_row.id = any(expired_batch_ids)
  on conflict (batch_id) do nothing;

  update private.retired_community_deletion_ledger
  set actor = 'redacted-after-retention'
  where batch_id = any(expired_batch_ids)
    and actor <> 'redacted-after-retention';
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;
  delete from private.retired_community_backup_proofs
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;
  evidence_deleted := evidence_deleted + affected_count;
  delete from private.retired_community_batch_approvals
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;
  evidence_deleted := evidence_deleted + affected_count;
  update private.retired_community_deletion_batches set
    requested_by = 'redacted-after-retention',
    subject_user_id = case when reason = 'account_erasure'
      then '00000000-0000-0000-0000-000000000000'::uuid else null end,
    crew_id = case when reason = 'group_deletion'
      then '00000000-0000-0000-0000-000000000000'::uuid else null end
  where id = any(expired_batch_ids)
    and requested_by <> 'redacted-after-retention';
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;

  delete from private.retired_community_deletion_items
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  evidence_deleted := evidence_deleted + affected_count;
  delete from private.retired_community_storage_work
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  evidence_deleted := evidence_deleted + affected_count;
  delete from private.retired_community_credential_work
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  evidence_deleted := evidence_deleted + affected_count;

  delete from private.retired_community_orphan_scan_items scan_item
  where exists (
      select 1 from private.retired_community_orphan_scans scan
      where scan.id = scan_item.scan_id
        and scan.scanned_at <= clock_timestamp() - interval '180 days'
    )
    and not exists (
      select 1
      from private.retired_community_deletion_batches batch_row
      where (batch_row.orphan_first_scan_id = scan_item.scan_id
          or batch_row.orphan_second_scan_id = scan_item.scan_id)
        and (
          not exists (
            select 1 from private.retired_community_deletion_ledger terminal
            where terminal.batch_id = batch_row.id
              and terminal.event_type in ('cancelled', 'executed')
          )
          or exists (
            select 1 from private.retired_community_purge_manifests manifest
            where manifest.batch_id = batch_row.id
              and manifest.expires_at > clock_timestamp()
          )
        )
    );
  get diagnostics scan_items_deleted = row_count;

  if t0_batch_id is not null then
    t0_record_payload := jsonb_build_object(
      'agedBatchId', t0_batch_id,
      't0SourceSha256', t0_source_sha,
      'posts', t0_post_count,
      'comments', t0_comment_count,
      'likes', t0_like_count,
      'totalObjects', t0_total_object_count,
      'referencedObjects', t0_referenced_object_count
    );
    insert into private.retired_community_t0_purge_records (
      singleton, aged_batch_id, purged_at, t0_source_sha256,
      post_count, comment_count, like_count, total_object_count,
      referenced_object_count, record_sha256
    ) values (
      true, t0_batch_id, clock_timestamp(), t0_source_sha,
      t0_post_count, t0_comment_count, t0_like_count, t0_total_object_count,
      t0_referenced_object_count,
      private.retired_community_sha256(t0_record_payload::text)
    );
    delete from private.retired_community_t0_comment_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
    delete from private.retired_community_t0_like_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
    delete from private.retired_community_t0_object_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
    delete from private.retired_community_t0_post_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
  end if;

  delete from private.retired_community_purge_manifests
  where batch_id = any(expired_batch_ids);
  get diagnostics manifests_deleted = row_count;
  return jsonb_build_object('status', 'complete',
    'counts', jsonb_build_object(
      'manifestsDeleted', manifests_deleted,
      'exactEvidenceRowsDeleted', evidence_deleted,
      'orphanScanItemsDeleted', scan_items_deleted,
      'identityRowsRedacted', identity_rows_redacted,
      't0IdentityRowsDeleted', t0_identity_rows_deleted,
      't0SnapshotPurged', t0_batch_id is not null
    ));
end;
$$;

create table private.retired_community_dr_reapplications (
  source_batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  reapply_batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  imported_manifest_sha256 text not null check (imported_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null,
  reapplied_at timestamptz,
  unique (source_batch_id, imported_manifest_sha256)
);

create table private.retired_community_dr_quarantined_crews (
  crew_id uuid primary key references public.crews(id) on delete cascade,
  source_batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  quarantined_at timestamptz not null
);

create table private.retired_community_dr_quarantined_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  source_batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  quarantined_at timestamptz not null
);

create function private.validate_retired_community_dr_quarantine()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if not exists (
    select 1
    from private.retired_community_deletion_batches batch_row
    join private.retired_community_deletion_ledger execution
      on execution.batch_id = batch_row.id and execution.event_type = 'executed'
    where batch_row.id = new.source_batch_id
      and batch_row.sealed
      and batch_row.reason = 'group_deletion'
      and batch_row.crew_id = new.crew_id
  ) then
    raise exception 'DR quarantine must match an executed group deletion batch.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger validate_retired_community_dr_quarantine
  before insert or update on private.retired_community_dr_quarantined_crews
  for each row execute function private.validate_retired_community_dr_quarantine();

create function private.validate_retired_community_dr_user_quarantine()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if not exists (
    select 1
    from private.retired_community_deletion_batches batch_row
    join private.retired_community_deletion_ledger execution
      on execution.batch_id = batch_row.id and execution.event_type = 'executed'
    where batch_row.id = new.source_batch_id
      and batch_row.sealed
      and batch_row.reason = 'account_erasure'
      and batch_row.subject_user_id = new.user_id
  ) then
    raise exception 'DR user quarantine must match an executed account erasure batch.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger validate_retired_community_dr_user_quarantine
  before insert or update on private.retired_community_dr_quarantined_users
  for each row execute function private.validate_retired_community_dr_user_quarantine();

create function private.block_retired_community_dr_reapplication_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if old.reapplied_at is null and new.reapplied_at is not null
     and new.source_batch_id = old.source_batch_id
     and new.reapply_batch_id = old.reapply_batch_id
     and new.imported_manifest_sha256 = old.imported_manifest_sha256
     and new.imported_at = old.imported_at then
    return new;
  end if;
  raise exception 'Retired Community DR reapplication state is immutable.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_dr_reapplication_mutation
  before update or delete on private.retired_community_dr_reapplications
  for each row execute function private.block_retired_community_dr_reapplication_mutation();

create or replace function public.is_crew_member(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
  select not exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) and exists (
    select 1 from public.crew_members member_row
    where member_row.crew_id = target_crew_id and member_row.user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_crew(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
  select not exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) and exists (
    select 1 from public.crew_members member_row
    where member_row.crew_id = target_crew_id and member_row.user_id = auth.uid()
      and member_row.role in ('owner', 'admin')
  );
$$;

create function public.retired_community_crew_is_quarantined(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  );
$$;

create function public.retired_community_user_is_quarantined(target_user_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = target_user_id
  );
$$;

create function private.retired_community_account_erasure_is_pending(target_user_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_deletion_batches batch_row
    where batch_row.reason = 'account_erasure'
      and batch_row.subject_user_id = target_user_id
      and batch_row.sealed
      and not exists (
        select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id
          and terminal.event_type in ('cancelled', 'executed')
      )
  );
$$;

create function public.retired_community_current_account_erasure_is_pending()
returns boolean language sql stable security definer
set search_path = pg_catalog, private, auth, pg_temp as $$
  select auth.uid() is not null
    and private.retired_community_account_erasure_is_pending(auth.uid());
$$;

create function private.retired_community_group_deletion_is_pending(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_deletion_batches batch_row
    where batch_row.reason = 'group_deletion'
      and batch_row.crew_id = target_crew_id
      and batch_row.sealed
      and not exists (
        select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id
          and terminal.event_type in ('cancelled', 'executed')
      )
  );
$$;

create function private.block_retired_community_pending_account_storage_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, storage, pg_temp as $$
begin
  if (
    new.bucket_id in ('community-post-images', 'profile-photos', 'journal-progress')
    and exists (
      select 1 from private.retired_community_deletion_batches batch_row
      where private.retired_community_account_erasure_is_pending(batch_row.subject_user_id)
        and (
          new.owner = batch_row.subject_user_id
          or (new.bucket_id in ('profile-photos', 'journal-progress')
            and (storage.foldername(new.name))[1] = batch_row.subject_user_id::text)
          or (new.bucket_id = 'community-post-images'
            and (storage.foldername(new.name))[2] = batch_row.subject_user_id::text)
        )
    )
  ) or (
    tg_op = 'UPDATE'
    and old.bucket_id in ('community-post-images', 'profile-photos', 'journal-progress')
    and exists (
      select 1 from private.retired_community_deletion_batches batch_row
      where private.retired_community_account_erasure_is_pending(batch_row.subject_user_id)
        and (
          old.owner = batch_row.subject_user_id
          or (old.bucket_id in ('profile-photos', 'journal-progress')
            and (storage.foldername(old.name))[1] = batch_row.subject_user_id::text)
          or (old.bucket_id = 'community-post-images'
            and (storage.foldername(old.name))[2] = batch_row.subject_user_id::text)
        )
    )
  ) then
    raise exception 'Storage assets are frozen while account erasure is pending.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_pending_account_storage_write
  before insert or update on storage.objects
  for each row execute function private.block_retired_community_pending_account_storage_write();

create function private.block_retired_community_pending_image_reference()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
begin
  if new.image_path is not null
     and (tg_op = 'INSERT' or new.image_path is distinct from old.image_path)
     and exists (
       select 1
       from private.retired_community_storage_work work
       join private.retired_community_deletion_batches batch_row on batch_row.id = work.batch_id
       where work.bucket_id = 'community-post-images'
         and work.object_name = new.image_path
         and batch_row.sealed
         and not exists (
           select 1 from private.retired_community_deletion_ledger terminal
           where terminal.batch_id = batch_row.id
             and terminal.event_type in ('cancelled', 'executed')
         )
     ) then
    raise exception 'Community image references are frozen while deletion is pending.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_pending_retired_community_image_reference
  before insert or update of image_path on public.community_posts
  for each row execute function private.block_retired_community_pending_image_reference();

create policy "Pending account erasure blocks personal asset uploads"
  on storage.objects as restrictive for insert to authenticated
  with check (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  );

create policy "Pending account erasure freezes personal asset updates"
  on storage.objects as restrictive for update to authenticated
  using (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  )
  with check (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  );

create function private.block_retired_community_quarantined_crew_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = new.crew_id
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = old.crew_id
  )) then
    raise exception 'This restored group is quarantined pending deletion reapplication.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_crew_member_write
  before insert or update on public.crew_members
  for each row execute function private.block_retired_community_quarantined_crew_write();
create trigger block_quarantined_crew_invite_write
  before insert or update on public.crew_invites
  for each row execute function private.block_retired_community_quarantined_crew_write();

create function private.block_retired_community_quarantined_user_membership_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = new.user_id
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = old.user_id
  )) then
    raise exception 'This restored account is quarantined pending deletion reapplication.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_user_membership_write
  before insert or update on public.crew_members
  for each row execute function private.block_retired_community_quarantined_user_membership_write();

create function private.block_retired_community_quarantined_inviter_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = new.created_by
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = old.created_by
  )) then
    raise exception 'This restored account cannot create invitations while quarantined.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_inviter_write
  before insert or update on public.crew_invites
  for each row execute function private.block_retired_community_quarantined_inviter_write();

create function private.block_retired_community_quarantined_destination_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare old_crew_id uuid;
declare new_crew_id uuid;
declare old_pending boolean := false;
declare new_pending boolean := false;
declare old_quarantined boolean := false;
declare new_quarantined boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_crew_id := old.crew_id;
    old_pending := private.retired_community_group_deletion_is_pending(old_crew_id);
    old_quarantined := exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = old_crew_id
    );
  end if;
  if tg_op <> 'DELETE' then
    new_crew_id := new.crew_id;
    new_pending := private.retired_community_group_deletion_is_pending(new_crew_id);
    new_quarantined := exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = new_crew_id
    );
  end if;

  if tg_op = 'DELETE' then
    if old_pending and not exists (
      select 1
      from private.retired_community_deletion_batches batch_row
      join private.retired_community_credential_work work
        on work.batch_id = batch_row.id and work.destination_id = old.id
      where batch_row.reason = 'group_deletion'
        and batch_row.crew_id = old_crew_id
        and batch_row.sealed
        and work.status = 'confirmed'
        and not exists (
          select 1 from private.retired_community_deletion_ledger terminal
          where terminal.batch_id = batch_row.id
            and terminal.event_type in ('cancelled', 'executed')
        )
    ) then
      raise exception 'Integration credentials are frozen while group deletion is pending.'
        using errcode = '55000';
    end if;
    if old_quarantined and not old_pending then
      raise exception 'This restored group cannot change an integration while quarantined.'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old_crew_id is distinct from new_crew_id
     and (old_pending or new_pending or old_quarantined or new_quarantined) then
    if old_quarantined or new_quarantined then
      raise exception 'This restored group cannot change an integration while quarantined.'
        using errcode = '55000';
    end if;
    raise exception 'Integration credentials are frozen while group deletion is pending.'
      using errcode = '55000';
  end if;

  if new_pending then
    if tg_op = 'INSERT' then
      raise exception 'Integration credentials are frozen while group deletion is pending.'
        using errcode = '55000';
    elsif row(
      new.id, new.crew_id, new.provider, new.provider_workspace_id,
      new.provider_destination_id, new.credential_ciphertext,
      new.credential_nonce, new.credential_key_version,
      new.credential_fingerprint, new.scopes
    ) is distinct from row(
      old.id, old.crew_id, old.provider, old.provider_workspace_id,
      old.provider_destination_id, old.credential_ciphertext,
      old.credential_nonce, old.credential_key_version,
      old.credential_fingerprint, old.scopes
    ) and not (
      new.status = 'revoked'
      and row(
        new.id, new.crew_id, new.provider,
        new.provider_workspace_id, new.provider_destination_id
      ) is not distinct from row(
        old.id, old.crew_id, old.provider,
        old.provider_workspace_id, old.provider_destination_id
      )
      and new.credential_ciphertext is null
      and new.credential_nonce is null
      and new.credential_key_version is null
      and new.credential_fingerprint is null
      and new.scopes = '{}'
    ) then
      raise exception 'Integration credentials are frozen while group deletion is pending.'
        using errcode = '55000';
    end if;
  end if;
  if old_quarantined or new_quarantined then
    if tg_op = 'INSERT'
       or (new.status = 'active' and old.status is distinct from 'active') then
      raise exception 'This restored group cannot activate an integration while quarantined.'
        using errcode = '55000';
    end if;
    if row(
      new.id, new.crew_id, new.provider, new.provider_workspace_id,
      new.provider_destination_id, new.credential_ciphertext,
      new.credential_nonce, new.credential_key_version,
      new.credential_fingerprint, new.scopes
    ) is distinct from row(
      old.id, old.crew_id, old.provider, old.provider_workspace_id,
      old.provider_destination_id, old.credential_ciphertext,
      old.credential_nonce, old.credential_key_version,
      old.credential_fingerprint, old.scopes
    ) and not (
      new.status = 'revoked'
      and row(
        new.id, new.crew_id, new.provider,
        new.provider_workspace_id, new.provider_destination_id
      ) is not distinct from row(
        old.id, old.crew_id, old.provider,
        old.provider_workspace_id, old.provider_destination_id
      )
      and new.credential_ciphertext is null
      and new.credential_nonce is null
      and new.credential_key_version is null
      and new.credential_fingerprint is null
      and new.scopes = '{}'
    ) then
      raise exception 'This restored group cannot change an integration while quarantined.'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger block_quarantined_integration_destination_write
  before insert or update or delete on private.integration_destinations
  for each row execute function private.block_retired_community_quarantined_destination_write();

create function private.block_retired_community_quarantined_preference_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = new.crew_id
  ) or exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = new.user_id
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = old.crew_id
  )) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = old.user_id
  )) then
    raise exception 'Outbound consent cannot be enabled while deletion reapplication is quarantined.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_outbound_preference_write
  before insert or update on public.outbound_update_preferences
  for each row execute function private.block_retired_community_quarantined_preference_write();

create function private.block_retired_community_quarantined_delivery_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.status in ('queued', 'processing', 'retry')
     and (
       (new.subject_user_id is not null
        and private.retired_community_account_erasure_is_pending(new.subject_user_id))
       or (tg_op = 'UPDATE' and old.subject_user_id is not null
        and private.retired_community_account_erasure_is_pending(old.subject_user_id))
     ) then
    raise exception 'Outbound delivery is blocked while account erasure is pending.'
      using errcode = '55000';
  end if;
  if new.status in ('queued', 'processing', 'retry') and (
    exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = new.crew_id
    ) or (
      new.subject_user_id is not null and exists (
        select 1 from private.retired_community_dr_quarantined_users quarantine
        where quarantine.user_id = new.subject_user_id
      )
    ) or (tg_op = 'UPDATE' and exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = old.crew_id
    )) or (tg_op = 'UPDATE' and old.subject_user_id is not null and exists (
      select 1 from private.retired_community_dr_quarantined_users quarantine
      where quarantine.user_id = old.subject_user_id
    ))
  ) then
    raise exception 'Outbound delivery is blocked while deletion reapplication is quarantined.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_outbound_delivery_write
  before insert or update on private.outbound_deliveries
  for each row execute function private.block_retired_community_quarantined_delivery_write();

create function private.anonymize_retired_community_outbound_subject(target_user_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  update private.outbound_deliveries set
    status = 'cancelled', cancelled_at = clock_timestamp(),
    last_error_code = 'account_erasure',
    last_error_summary = 'Delivery cancelled because its subject account was erased.',
    lock_token = null, locked_at = null
  where subject_user_id = target_user_id
    and status in ('queued', 'processing', 'retry');
  update private.outbound_deliveries set
    subject_user_id = null, source_reference = null
  where subject_user_id = target_user_id;
end;
$$;

create policy "DR quarantine hides restored crews"
  on public.crews as restrictive for all to authenticated
  using (not public.retired_community_crew_is_quarantined(id))
  with check (not public.retired_community_crew_is_quarantined(id));

create policy "DR quarantine hides restored crew members"
  on public.crew_members as restrictive for all to authenticated
  using (not public.retired_community_crew_is_quarantined(crew_id))
  with check (not public.retired_community_crew_is_quarantined(crew_id));

create policy "DR quarantine hides restored crew invites"
  on public.crew_invites as restrictive for all to authenticated
  using (not public.retired_community_crew_is_quarantined(crew_id))
  with check (not public.retired_community_crew_is_quarantined(crew_id));

create policy "DR quarantine hides restored account feed activity"
  on public.community_feed_items as restrictive for all to authenticated
  using (not public.retired_community_user_is_quarantined(user_id))
  with check (not public.retired_community_user_is_quarantined(user_id));

create policy "DR quarantine hides restored account memberships"
  on public.crew_members as restrictive for all to authenticated
  using (not public.retired_community_user_is_quarantined(user_id))
  with check (not public.retired_community_user_is_quarantined(user_id));

create function public.export_retired_community_dr_ledger()
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
  select coalesce(jsonb_agg(
    private.retired_community_manifest_payload(manifest.batch_id, manifest.executed_at)
      || jsonb_build_object('manifestSha256', manifest.manifest_sha256)
    order by manifest.executed_at, manifest.batch_id
  ), '[]'::jsonb)
  from private.retired_community_purge_manifests manifest;
$$;

create function public.import_retired_community_dr_manifest(
  target_manifest jsonb,
  target_imported_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, storage, auth, pg_temp as $$
declare source_batch private.retired_community_deletion_batches%rowtype;
declare source_proof private.retired_community_backup_proofs%rowtype;
declare source_approval private.retired_community_batch_approvals%rowtype;
declare source_batch_id uuid;
declare source_executed_at timestamptz;
declare expected_payload jsonb;
declare expected_manifest_sha text;
declare new_batch_id uuid := gen_random_uuid();
declare request_time timestamptz := clock_timestamp();
declare normalized_importer text := private.normalize_retired_community_operator(target_imported_by);
declare existing_batch_id uuid;
begin
  if jsonb_typeof(target_manifest) <> 'object'
     or not (target_manifest ?& array['batchId', 'executedAt', 'manifestSha256'])
     or char_length(normalized_importer) not between 3 and 160 then
    raise exception 'A redacted DR manifest and named importer are required.' using errcode = '22023';
  end if;
  source_batch_id := (target_manifest->>'batchId')::uuid;
  source_executed_at := (target_manifest->>'executedAt')::timestamptz;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  select * into strict source_batch from private.retired_community_deletion_batches
    where id = source_batch_id and sealed;
  select * into strict source_proof from private.retired_community_backup_proofs
    where batch_id = source_batch.id;
  select * into strict source_approval from private.retired_community_batch_approvals
    where batch_id = source_batch.id;
  expected_payload := private.retired_community_manifest_payload(source_batch.id, source_executed_at);
  expected_manifest_sha := private.retired_community_sha256(expected_payload::text);
  if target_manifest - 'manifestSha256' is distinct from expected_payload
     or target_manifest->>'manifestSha256' is distinct from expected_manifest_sha then
    raise exception 'The DR manifest does not match the local sealed batch.' using errcode = '22023';
  end if;

  select reapplication.reapply_batch_id into existing_batch_id
  from private.retired_community_dr_reapplications reapplication
  where reapplication.source_batch_id = source_batch.id
    and reapplication.imported_manifest_sha256 = expected_manifest_sha;
  if existing_batch_id is not null then
    return private.retired_community_batch_result(existing_batch_id);
  end if;
  perform private.assert_retired_community_batch_evidence_complete(source_batch.id);
  if not exists (
    select 1 from private.retired_community_deletion_ledger
    where batch_id = source_batch.id and event_type = 'executed'
  ) then
    insert into private.retired_community_deletion_ledger
      (batch_id, event_type, actor, event_at, details)
    values (source_batch.id, 'executed', normalized_importer, source_executed_at,
      jsonb_build_object('reason', source_batch.reason, 'posts', source_batch.post_count,
        'comments', source_batch.comment_count, 'likes', source_batch.like_count,
        'objects', source_batch.object_count, 'credentials', source_batch.credential_count,
        'drLedgerImported', true));
  end if;
  perform private.record_retired_community_purge_manifest(
    source_batch.id,
    source_executed_at
  );
  if not exists (
    select 1 from private.retired_community_purge_manifests manifest
    where manifest.batch_id = source_batch.id
      and manifest.executed_at = source_executed_at
      and manifest.manifest_sha256 = expected_manifest_sha
  ) then
    raise exception 'The DR manifest conflicts with retained local purge evidence.'
      using errcode = '55000';
  end if;

  insert into private.retired_community_deletion_batches (
    id, reason, requested_by, requested_at, execute_after, deadline_at,
    subject_user_id, crew_id, t0_source_sha256, orphan_first_scan_id,
    orphan_second_scan_id
  ) values (
    new_batch_id, source_batch.reason, 'dr-ledger-reapply',
    case when source_batch.reason = 'group_deletion' then request_time - interval '30 days'
      else request_time end,
    request_time,
    case when source_batch.reason = 'account_erasure' then request_time + interval '24 hours' end,
    source_batch.subject_user_id, source_batch.crew_id, source_batch.t0_source_sha256,
    source_batch.orphan_first_scan_id, source_batch.orphan_second_scan_id
  );

  insert into private.retired_community_deletion_items
    (batch_id, item_kind, item_key, post_id, row_sha256)
  select new_batch_id, item_kind, item_key, post_id, row_sha256
  from private.retired_community_deletion_items where batch_id = source_batch.id;

  insert into private.retired_community_storage_work (
    batch_id, object_id, bucket_id, object_name, expected_row_sha256,
    status, confirmed_at
  )
  select new_batch_id, work.object_id, work.bucket_id, work.object_name,
    work.expected_row_sha256,
    case when object_row.id is null then 'confirmed' else 'queued' end,
    case when object_row.id is null then request_time end
  from private.retired_community_storage_work work
  left join storage.objects object_row
    on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
  where work.batch_id = source_batch.id;

  update private.integration_destinations destination set
    status = 'revoked', credential_ciphertext = null, credential_nonce = null,
    credential_key_version = null, credential_fingerprint = null, scopes = '{}',
    last_error_code = null, last_error_summary = null
  from private.retired_community_credential_work source_work
  where source_batch.reason = 'group_deletion'
    and source_work.batch_id = source_batch.id
    and source_work.destination_id = destination.id
    and destination.credential_ciphertext is null
    and destination.credential_nonce is null
    and destination.credential_key_version is null;

  insert into private.retired_community_credential_work (
    batch_id, destination_id, provider, expected_row_sha256, status, confirmed_at,
    provider_revocation_reference
  )
  select new_batch_id, work.destination_id, work.provider, work.expected_row_sha256,
    case when destination.id is null or destination.credential_ciphertext is null
      then 'confirmed' else 'queued' end,
    case when destination.id is null or destination.credential_ciphertext is null
      then request_time end,
    case when destination.id is null or destination.credential_ciphertext is null
      then 'dr-already-revoked' end
  from private.retired_community_credential_work work
  left join private.integration_destinations destination on destination.id = work.destination_id
  where work.batch_id = source_batch.id;

  update private.retired_community_deletion_batches set
    source_sha256 = source_batch.source_sha256,
    post_count = source_batch.post_count,
    comment_count = source_batch.comment_count,
    like_count = source_batch.like_count,
    object_count = source_batch.object_count,
    credential_count = source_batch.credential_count,
    sealed = true
  where id = new_batch_id;

  insert into private.retired_community_backup_proofs (
    batch_id, backup_name, backup_version, source_sha256, bundle_sha256,
    bundle_bytes, verified_by, verified_at
  ) values (
    new_batch_id, 'dr-ledger-reapply', 'manifest-v1', source_batch.source_sha256,
    source_proof.bundle_sha256, source_proof.bundle_bytes, 'dr-ledger-verifier', request_time
  );
  insert into private.retired_community_batch_approvals (
    batch_id, approved_by, approved_at, source_sha256, bundle_sha256,
    post_count, comment_count, like_count, object_count, credential_count
  ) values (
    new_batch_id, 'dr-ledger-approver', request_time, source_batch.source_sha256,
    source_proof.bundle_sha256, source_batch.post_count, source_batch.comment_count,
    source_batch.like_count, source_batch.object_count, source_batch.credential_count
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values
    (new_batch_id, 'created', 'dr-ledger-reapply', request_time,
      jsonb_build_object('reason', source_batch.reason, 'posts', source_batch.post_count,
        'comments', source_batch.comment_count, 'likes', source_batch.like_count,
        'objects', source_batch.object_count, 'credentials', source_batch.credential_count)),
    (new_batch_id, 'backup_verified', 'dr-ledger-verifier', request_time,
      jsonb_build_object('sourceSha256', source_batch.source_sha256,
        'bundleSha256', source_proof.bundle_sha256, 'drLedgerImported', true)),
    (new_batch_id, 'approved', 'dr-ledger-approver', request_time,
      jsonb_build_object('sourceSha256', source_batch.source_sha256,
        'bundleSha256', source_proof.bundle_sha256, 'drLedgerImported', true));
  insert into private.retired_community_dr_reapplications (
    source_batch_id, reapply_batch_id, imported_manifest_sha256, imported_at
  ) values (source_batch.id, new_batch_id, expected_manifest_sha, request_time);

  if source_batch.reason = 'group_deletion' then
    insert into private.retired_community_dr_quarantined_crews (
      crew_id, source_batch_id, quarantined_at
    ) select source_batch.crew_id, source_batch.id, request_time
    where exists (select 1 from public.crews where id = source_batch.crew_id)
    on conflict (crew_id) do nothing;
    update private.integration_destinations set
      status = 'reconnect_required',
      last_error_code = 'dr_reapplication_quarantine',
      last_error_summary = 'Destination disabled while a restored purge is reapplied.'
    where crew_id = source_batch.crew_id and status = 'active';
    update private.outbound_deliveries set
      status = 'cancelled', cancelled_at = request_time,
      last_error_code = 'dr_reapplication_quarantine',
      last_error_summary = 'Delivery cancelled while a restored purge is reapplied.',
      lock_token = null, locked_at = null
    where crew_id = source_batch.crew_id and status in ('queued', 'processing', 'retry');
    delete from private.integration_oauth_states where crew_id = source_batch.crew_id;
    delete from private.pending_integration_connections where crew_id = source_batch.crew_id;
    delete from public.crew_invites where crew_id = source_batch.crew_id;
    delete from public.crew_members where crew_id = source_batch.crew_id;
  elsif source_batch.reason = 'account_erasure' then
    insert into private.retired_community_dr_quarantined_users (
      user_id, source_batch_id, quarantined_at
    ) select source_batch.subject_user_id, source_batch.id, request_time
    where exists (select 1 from auth.users where id = source_batch.subject_user_id)
    on conflict (user_id) do nothing;
    update auth.users set banned_until = 'infinity'::timestamptz
    where id = source_batch.subject_user_id;
    perform private.anonymize_retired_community_outbound_subject(
      source_batch.subject_user_id
    );
    delete from private.integration_oauth_states
      where initiated_by = source_batch.subject_user_id;
    delete from private.pending_integration_connections
      where initiated_by = source_batch.subject_user_id;
    delete from public.crew_invites where created_by = source_batch.subject_user_id;
    delete from public.crew_members where user_id = source_batch.subject_user_id;
    update public.crews set created_by = null
      where created_by = source_batch.subject_user_id;
    update private.integration_destinations set installed_by = null
      where installed_by = source_batch.subject_user_id;
  end if;
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function private.guard_retired_community_orphan_scan_identity()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.orphan_first_scan_id is distinct from old.orphan_first_scan_id
     or new.orphan_second_scan_id is distinct from old.orphan_second_scan_id then
    raise exception 'A deletion batch cannot change its orphan scan proof while sealing.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger b_guard_retired_community_orphan_scan_identity
  before update on private.retired_community_deletion_batches
  for each row execute function private.guard_retired_community_orphan_scan_identity();

create function private.preflight_retired_community_work_claim()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  return new;
end;
$$;

create trigger preflight_retired_community_storage_claim
  before update of status on private.retired_community_storage_work
  for each row execute function private.preflight_retired_community_work_claim();
create trigger preflight_retired_community_credential_claim
  before update of status on private.retired_community_credential_work
  for each row execute function private.preflight_retired_community_work_claim();

create or replace function public.claim_retired_community_storage_work(
  target_batch_id uuid,
  target_worker_token uuid,
  target_limit integer default 100
)
returns table (
  work_id uuid,
  bucket_id text,
  object_name text,
  expected_row_sha256 text
)
language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if target_worker_token is null or target_limit not between 1 and 100 then
    raise exception 'A worker token and limit from 1 to 100 are required.' using errcode = '22023';
  end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id) then
    raise exception 'Backup proof and independent approval are required before work begins.' using errcode = '55000';
  end if;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed')
     or clock_timestamp() < batch_row.execute_after then
    raise exception 'This deletion batch is not executable.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_batch_evidence_complete(batch_row.id);
  perform private.assert_retired_community_cascade_scope(batch_row.id);
  if exists (
    select 1 from private.retired_community_storage_work work
    join storage.objects object_row
      on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
    where work.batch_id = batch_row.id and work.status <> 'confirmed'
      and private.retired_community_sha256(to_jsonb(object_row)::text) <> work.expected_row_sha256
  ) then
    raise exception 'A queued Storage object no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  return query
  with claims as (
    select work.id from private.retired_community_storage_work work
    where work.batch_id = batch_row.id
      and (work.status = 'queued' or (work.status = 'claimed' and
        (work.claim_token = target_worker_token
          or work.claimed_at <= clock_timestamp() - interval '15 minutes')))
    order by work.object_name limit target_limit for update skip locked
  )
  update private.retired_community_storage_work work set
    status = 'claimed', claim_token = target_worker_token, claimed_at = clock_timestamp()
  from claims where work.id = claims.id
  returning work.id, work.bucket_id, work.object_name, work.expected_row_sha256;
end;
$$;

create function public.verify_retired_community_storage_work(
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private, storage, pg_temp as $$
declare work_row private.retired_community_storage_work%rowtype;
begin
  select * into strict work_row from private.retired_community_storage_work
    where id = target_work_id and batch_id = target_batch_id for update;
  if work_row.status <> 'claimed' or work_row.claim_token is distinct from target_worker_token then
    raise exception 'Storage work is not claimed by this worker.' using errcode = '42501';
  end if;
  if private.retired_community_batch_status(work_row.batch_id) in ('cancelled', 'executed') then
    raise exception 'This deletion batch is terminal.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_cascade_scope(work_row.batch_id);
  if not exists (
    select 1 from storage.objects object_row
    where object_row.bucket_id = work_row.bucket_id and object_row.name = work_row.object_name
      and private.retired_community_sha256(to_jsonb(object_row)::text) = work_row.expected_row_sha256
  ) then
    raise exception 'The Storage object no longer matches its claimed inventory.' using errcode = '55000';
  end if;
  return true;
end;
$$;

create or replace function public.claim_retired_community_credential_work(
  target_batch_id uuid,
  target_worker_token uuid,
  target_limit integer default 20
)
returns table (
  work_id uuid,
  destination_id uuid,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version smallint
)
language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if target_worker_token is null or target_limit not between 1 and 20 then
    raise exception 'A worker token and limit from 1 to 20 are required.' using errcode = '22023';
  end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  if batch_row.reason <> 'group_deletion' then
    return;
  end if;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id)
     or clock_timestamp() < batch_row.execute_after
     or private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'This credential batch is not executable.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_batch_evidence_complete(batch_row.id);
  perform private.assert_retired_community_cascade_scope(batch_row.id);
  if exists (
    select 1 from private.retired_community_credential_work work
    left join private.integration_destinations destination on destination.id = work.destination_id
    where work.batch_id = batch_row.id and work.status <> 'confirmed'
      and (destination.id is null
        or private.retired_community_credential_sha256(destination) <> work.expected_row_sha256)
  ) then
    raise exception 'A provider destination no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  return query
  with claims as (
    select work.id from private.retired_community_credential_work work
    where work.batch_id = batch_row.id
      and (work.status = 'queued' or (work.status = 'claimed' and
        (work.claim_token = target_worker_token
          or work.claimed_at <= clock_timestamp() - interval '15 minutes')))
    order by work.destination_id limit target_limit for update skip locked
  ), claimed as (
    update private.retired_community_credential_work work set
      status = 'claimed', claim_token = target_worker_token, claimed_at = clock_timestamp()
    from claims where work.id = claims.id returning work.*
  )
  select claimed.id, destination.id, destination.provider,
    destination.provider_workspace_id, destination.provider_destination_id,
    destination.credential_ciphertext, destination.credential_nonce,
    destination.credential_key_version
  from claimed join private.integration_destinations destination
    on destination.id = claimed.destination_id;
end;
$$;

create function public.fail_retired_community_work(
  target_work_kind text,
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid,
  target_error_code text
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if target_work_kind = 'storage'
     and target_error_code = 'storage_retry_exhausted' then
    update private.retired_community_storage_work set
      status = 'queued', claim_token = null, claimed_at = null,
      last_failed_at = clock_timestamp(), last_error_code = target_error_code
    where id = target_work_id and batch_id = target_batch_id
      and status = 'claimed' and claim_token = target_worker_token;
    if found then return true; end if;
    if exists (
      select 1 from private.retired_community_storage_work
      where id = target_work_id and batch_id = target_batch_id
        and (status = 'confirmed'
          or (status = 'queued' and last_error_code = target_error_code))
    ) then return true; end if;
  elsif target_work_kind = 'credential'
        and target_error_code = 'credential_retry_exhausted' then
    update private.retired_community_credential_work set
      status = 'queued', claim_token = null, claimed_at = null,
      last_failed_at = clock_timestamp(), last_error_code = target_error_code
    where id = target_work_id and batch_id = target_batch_id
      and status = 'claimed' and claim_token = target_worker_token;
    if found then return true; end if;
    if exists (
      select 1 from private.retired_community_credential_work
      where id = target_work_id and batch_id = target_batch_id
        and (status = 'confirmed'
          or (status = 'queued' and last_error_code = target_error_code))
    ) then return true; end if;
  else
    raise exception 'Invalid retention work failure code.' using errcode = '22023';
  end if;
  raise exception 'Retention work is not claimed by this worker.' using errcode = '42501';
end;
$$;

create function public.retired_community_deletion_health()
returns jsonb language sql security definer
set search_path = pg_catalog, private, pg_temp as $$
  with active_batches as materialized (
    select batch_row.*
    from private.retired_community_deletion_batches batch_row
    where not exists (
      select 1 from private.retired_community_deletion_ledger terminal
      where terminal.batch_id = batch_row.id
        and terminal.event_type in ('cancelled', 'executed')
    )
  ), metrics as (
    select
      (select count(*) from active_batches) as active_batches,
      (select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed') as storage_pending,
      (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed') as credential_pending,
      ((select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status = 'claimed'
          and work.claimed_at <= clock_timestamp() - interval '15 minutes')
       + (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status = 'claimed'
          and work.claimed_at <= clock_timestamp() - interval '15 minutes')) as stale_claims,
      ((select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.last_failed_at is not null)
       + (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.last_failed_at is not null)) as work_failures,
      ((select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.attempt_count >= 3)
       + (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.attempt_count >= 3)) as repeated_failures,
      (select count(*) from active_batches batch_row
        where batch_row.reason = 'account_erasure'
          and batch_row.deadline_at <= clock_timestamp()) as account_erasures_overdue,
      (select count(*) from active_batches batch_row
        where batch_row.reason = 'account_erasure'
          and batch_row.deadline_at > clock_timestamp()
          and batch_row.deadline_at <= clock_timestamp() + interval '2 hours')
        as account_erasures_due_soon,
      (select count(*)
        from private.retired_community_purge_manifests manifest
        where manifest.executed_at + interval '30 days' <= clock_timestamp()
          and not exists (
            select 1 from private.retired_community_backup_reverifications verification
            where verification.batch_id = manifest.batch_id
          )) as backup_reverification_due,
      (select count(*) from private.retired_community_purge_manifests manifest
        where manifest.expires_at > clock_timestamp()
          and manifest.expires_at <= clock_timestamp() + interval '7 days')
        as manifests_expiring_soon,
      (select count(*) from private.retired_community_purge_manifests manifest
        where manifest.expires_at <= clock_timestamp()) as expired_manifests,
      (select count(*)
        from private.retired_community_deletion_batches batch_row
        join private.retired_community_deletion_ledger cancellation
          on cancellation.batch_id = batch_row.id and cancellation.event_type = 'cancelled'
        where cancellation.event_at + interval '180 days' <= clock_timestamp()
          and not exists (
            select 1 from private.retired_community_batch_identity_redactions redaction
            where redaction.batch_id = batch_row.id
          )) as cancelled_evidence_due,
      ((select count(*) from private.retired_community_t0_post_inventory)
       + (select count(*) from private.retired_community_t0_comment_inventory)
       + (select count(*) from private.retired_community_t0_like_inventory)
       + (select count(*) from private.retired_community_t0_object_inventory))
        as t0_identity_rows_retained,
      (select count(*) from private.retired_community_t0_purge_records)
        as t0_snapshot_purged,
      (select count(*) from private.retired_community_dr_reapplications
        where reapplied_at is null) as dr_reapplications_pending,
      (select count(*) from private.retired_community_dr_quarantined_crews)
        as dr_quarantined_crews,
      (select count(*) from private.retired_community_dr_quarantined_users)
        as dr_quarantined_users,
      (select count(*) from active_batches batch_row
        where batch_row.reason = 'orphan_cleanup' and batch_row.sealed
          and (batch_row.orphan_first_scan_id is null
            or batch_row.orphan_second_scan_id is null)) as legacy_orphan_batches
  )
  select jsonb_build_object(
    'status', case when
      metrics.stale_claims > 0
      or metrics.work_failures > 0
      or metrics.account_erasures_due_soon > 0
      or metrics.account_erasures_overdue > 0
      or metrics.backup_reverification_due > 0
      or metrics.manifests_expiring_soon > 0
      or metrics.expired_manifests > 0
      or metrics.cancelled_evidence_due > 0
      or metrics.dr_reapplications_pending > 0
      or metrics.dr_quarantined_crews > 0
      or metrics.dr_quarantined_users > 0
      or metrics.legacy_orphan_batches > 0
      then 'attention' else 'ok' end,
    'counts', jsonb_build_object(
      'activeBatches', metrics.active_batches,
      'storagePending', metrics.storage_pending,
      'credentialPending', metrics.credential_pending,
      'staleClaims', metrics.stale_claims,
      'workFailures', metrics.work_failures,
      'repeatedFailures', metrics.repeated_failures,
      'accountErasuresDueSoon', metrics.account_erasures_due_soon,
      'accountErasuresOverdue', metrics.account_erasures_overdue,
      'backupReverificationDue', metrics.backup_reverification_due,
      'manifestsExpiringSoon', metrics.manifests_expiring_soon,
      'expiredManifests', metrics.expired_manifests,
      'cancelledEvidenceDue', metrics.cancelled_evidence_due,
      't0IdentityRowsRetained', metrics.t0_identity_rows_retained,
      't0SnapshotPurged', metrics.t0_snapshot_purged,
      'drReapplicationsPending', metrics.dr_reapplications_pending,
      'drQuarantinedCrews', metrics.dr_quarantined_crews,
      'drQuarantinedUsers', metrics.dr_quarantined_users,
      'legacyOrphanBatches', metrics.legacy_orphan_batches
    ),
    'orphanScan', jsonb_build_object(
      'pairReady', exists (select 1 from private.retired_community_orphan_scan_pair()),
      'latestCompletedAt', (select max(scanned_at)
        from private.retired_community_orphan_scans)
    )
  ) from metrics;
$$;

create or replace function public.execute_retired_community_deletion_batch(
  target_batch_id uuid,
  target_operator text,
  target_confirmation text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare census_row private.retired_community_t0_census%rowtype;
declare executed_time timestamptz;
declare normalized_operator text := private.normalize_retired_community_operator(target_operator);
begin
  if target_confirmation is distinct from 'EXECUTE SEALED RETIRED COMMUNITY DELETION' then
    raise exception 'The exact destructive confirmation is required.' using errcode = '22023';
  end if;
  if char_length(normalized_operator) not between 3 and 160 then
    raise exception 'A named execution operator is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed for update;
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if private.retired_community_batch_status(batch_row.id) = 'executed' then
    return private.retired_community_batch_result(batch_row.id);
  end if;
  if private.retired_community_batch_status(batch_row.id) <> 'ready' then
    raise exception 'The deletion batch is not ready.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_batch_evidence_complete(batch_row.id);
  if batch_row.reason = 'aged_retention'
     and clock_timestamp() < census_row.captured_at + interval '91 days' then
    raise exception 'Aged retention cannot execute before T0 plus 91 days.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_cascade_scope(batch_row.id);
  if exists (
    select 1 from private.retired_community_deletion_items item
    left join public.community_posts post_row
      on item.item_kind = 'post' and post_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and ((post_row.id is not null
          and private.retired_community_sha256(to_jsonb(post_row)::text) <> item.row_sha256)
        or (post_row.id is null and not private.retired_community_item_was_executed(
          batch_row.id, item.item_kind, item.item_key, item.row_sha256)))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_comments comment_row
      on item.item_kind = 'comment' and comment_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and ((comment_row.id is not null
          and private.retired_community_sha256(to_jsonb(comment_row)::text) <> item.row_sha256)
        or (comment_row.id is null and not private.retired_community_item_was_executed(
          batch_row.id, item.item_kind, item.item_key, item.row_sha256)))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_likes like_row on item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and ((like_row.post_id is not null
          and private.retired_community_sha256(to_jsonb(like_row)::text) <> item.row_sha256)
        or (like_row.post_id is null and not private.retired_community_item_was_executed(
          batch_row.id, item.item_kind, item.item_key, item.row_sha256)))
  ) then
    raise exception 'A relational source row no longer matches the sealed batch.' using errcode = '55000';
  end if;

  if batch_row.reason = 'account_erasure' then
    perform private.anonymize_retired_community_outbound_subject(
      batch_row.subject_user_id
    );
    delete from public.post_comments comment_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and comment_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from public.post_likes like_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid;
    delete from public.community_posts post_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and post_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from auth.users where id = batch_row.subject_user_id;
  elsif batch_row.reason = 'group_deletion' then
    delete from public.crews where id = batch_row.crew_id;
  elsif batch_row.reason = 'aged_retention' then
    delete from public.post_comments comment_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and comment_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from public.post_likes like_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid;
    delete from public.community_posts post_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and post_row.id = split_part(item.item_key, ':', 1)::uuid;
  end if;

  executed_time := clock_timestamp();
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'executed', normalized_operator, executed_time,
    jsonb_build_object('reason', batch_row.reason, 'posts', batch_row.post_count,
      'comments', batch_row.comment_count, 'likes', batch_row.like_count,
      'objects', batch_row.object_count, 'credentials', batch_row.credential_count));
  perform private.record_retired_community_purge_manifest(batch_row.id, executed_time);
  update private.retired_community_dr_reapplications set reapplied_at = executed_time
  where reapply_batch_id = batch_row.id and reapplied_at is null;
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create index retired_community_orphan_scans_scanned_idx
  on private.retired_community_orphan_scans (scanned_at desc);
create index retired_community_purge_manifests_expires_idx
  on private.retired_community_purge_manifests (expires_at);
create index retired_community_dr_reapplications_pending_idx
  on private.retired_community_dr_reapplications (imported_at)
  where reapplied_at is null;
create index retired_community_storage_failures_idx
  on private.retired_community_storage_work (last_failed_at desc)
  where status <> 'confirmed' and last_failed_at is not null;
create index retired_community_credential_failures_idx
  on private.retired_community_credential_work (last_failed_at desc)
  where status <> 'confirmed' and last_failed_at is not null;

revoke all on private.retired_community_orphan_scans
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_orphan_scan_items
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_orphan_scan_audit
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_purge_manifests
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_backup_reverifications
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_purge_records
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_batch_identity_redactions
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_dr_reapplications
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_dr_quarantined_crews
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_dr_quarantined_users
  from public, anon, authenticated, service_role;
revoke all on sequence private.retired_community_orphan_scan_audit_id_seq
  from public, anon, authenticated, service_role;

revoke all on function private.normalize_retired_community_operator(text)
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_t0_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_batch_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_record_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_evidence_is_releasable(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_item_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_work_delete()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_batch_requester()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_backup_verifier()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_approver()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_ledger_actor()
  from public, anon, authenticated, service_role;
revoke all on function private.record_retired_community_work_attempt()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_created_ledger_counts()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_item_was_executed(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_object_was_executed(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.assert_retired_community_batch_evidence_complete(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.assert_retired_community_cascade_scope(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.assert_retired_community_scope_when_sealed()
  from public, anon, authenticated, service_role;
revoke all on function private.add_retired_community_account_assets_when_sealing()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_retired_community_mutation_scope_when_creating()
  from public, anon, authenticated, service_role;
revoke all on function private.confirm_retired_community_credentialless_when_sealing()
  from public, anon, authenticated, service_role;
revoke all on function private.cancel_retired_community_account_deliveries_when_sealing()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_orphan_scan_audit_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_orphan_scan_pair()
  from public, anon, authenticated, service_role;
revoke all on function private.preview_retired_community_orphan_deletion()
  from public, anon, authenticated, service_role;
revoke all on function private.create_retired_community_orphan_batch(text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_manifest_payload(uuid,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.record_retired_community_purge_manifest(uuid,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_purge_manifest_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_backup_reverification_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_dr_reapplication_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_retired_community_dr_quarantine()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_retired_community_dr_user_quarantine()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_orphan_scan_identity()
  from public, anon, authenticated, service_role;
revoke all on function private.preflight_retired_community_work_claim()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_crew_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_user_membership_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_inviter_write()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_account_erasure_is_pending(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_group_deletion_is_pending(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_pending_account_storage_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_pending_image_reference()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_destination_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_preference_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_delivery_write()
  from public, anon, authenticated, service_role;
revoke all on function private.anonymize_retired_community_outbound_subject(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.record_retired_community_orphan_scan(uuid,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.verify_retired_community_storage_work(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.verify_retired_community_backup_after_30_days(uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.purge_expired_retired_community_manifests()
  from public, anon, authenticated;
revoke all on function public.retired_community_deletion_health()
  from public, anon, authenticated;
revoke all on function public.export_retired_community_dr_ledger()
  from public, anon, authenticated;
revoke all on function public.import_retired_community_dr_manifest(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.fail_retired_community_work(text,uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.retired_community_crew_is_quarantined(uuid)
  from public, anon, service_role;
revoke all on function public.retired_community_user_is_quarantined(uuid)
  from public, anon, service_role;
revoke all on function public.retired_community_current_account_erasure_is_pending()
  from public, anon, service_role;

grant execute on function public.record_retired_community_orphan_scan(uuid,text,jsonb)
  to service_role;
grant execute on function public.verify_retired_community_storage_work(uuid,uuid,uuid)
  to service_role;
grant execute on function public.verify_retired_community_backup_after_30_days(uuid,text,text,text)
  to service_role;
grant execute on function public.purge_expired_retired_community_manifests()
  to service_role;
grant execute on function public.retired_community_deletion_health()
  to service_role;
grant execute on function public.export_retired_community_dr_ledger()
  to service_role;
grant execute on function public.import_retired_community_dr_manifest(jsonb,text)
  to service_role;
grant execute on function public.fail_retired_community_work(text,uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.retired_community_crew_is_quarantined(uuid)
  to authenticated;
grant execute on function public.retired_community_user_is_quarantined(uuid)
  to authenticated;
grant execute on function public.retired_community_current_account_erasure_is_pending()
  to authenticated;

comment on table private.retired_community_orphan_scans is
  'Complete exact community-post-images inventories; a scan may be atomically replaced only before batch binding.';
comment on table private.retired_community_purge_manifests is
  'Redacted count/digest-only purge manifests retained for exactly 180 days.';
comment on table private.retired_community_t0_purge_records is
  'Aggregate proof that direct identifiers and object paths were removed from the T0 inventory after the global aged-purge evidence window.';
comment on table private.retired_community_batch_identity_redactions is
  'Count/digest-only proof that requester, subject, crew, and operator identities were removed after exact evidence retention closed.';
comment on function public.record_retired_community_orphan_scan(uuid,text,jsonb) is
  'Worker-only atomic replacement of one complete, exact Storage bucket inventory.';
comment on function public.verify_retired_community_storage_work(uuid,uuid,uuid) is
  'Rechecks claimed Storage identity and metadata immediately before the worker calls the Storage API.';
comment on function public.export_retired_community_dr_ledger() is
  'Exports only redacted count/digest manifests for HMAC signing and off-platform DR custody.';
comment on function public.import_retired_community_dr_manifest(jsonb,text) is
  'Validates an Edge-verified DR manifest, quarantines restored product access, and creates an immediate reapplication batch.';
comment on function public.fail_retired_community_work(text,uuid,uuid,uuid,text) is
  'Worker-only release and durable aggregate telemetry after an exact Storage or credential claim exhausts retries.';

begin;

create table if not exists public.reward_catalog_meta (
  catalog_key text primary key check (catalog_key = 'primary'),
  catalog_version bigint not null default 1 check (catalog_version > 0),
  updated_at timestamptz not null default now()
);

insert into public.reward_catalog_meta (catalog_key, catalog_version)
values ('primary', 1)
on conflict (catalog_key) do nothing;

create table if not exists public.reward_definitions (
  reward_key text primary key
    check (reward_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  reward_type text not null
    check (reward_type ~ '^[a-z][a-z0-9_]*$'),
  state_model text not null
    check (state_model in ('challenge_lifecycle', 'ownership')),
  title text not null check (btrim(title) <> ''),
  description text not null default '',
  points_required integer not null check (points_required >= 0),
  fulfillment_key text not null
    check (fulfillment_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  challenge_key text unique references public.challenge_definitions(challenge_key),
  required_entitlement_key text,
  icon text not null default 'gift'
    check (icon ~ '^[a-z][a-z0-9-]*$'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  display_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(display_metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      state_model = 'challenge_lifecycle'
      and reward_type = 'challenge'
      and challenge_key is not null
      and fulfillment_key = challenge_key
    )
    or (
      state_model = 'ownership'
      and reward_type <> 'challenge'
      and challenge_key is null
    )
  )
);

create table if not exists public.user_reward_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null references public.reward_definitions(reward_key) on delete restrict,
  owned_at timestamptz not null default now(),
  source_type text not null default 'point_threshold'
    check (source_type ~ '^[a-z][a-z0-9_]*$'),
  source_id text,
  celebration_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, reward_key)
);

create index if not exists reward_definitions_active_order_idx
  on public.reward_definitions (points_required, sort_order, reward_key)
  where is_active;

create index if not exists user_reward_entitlements_user_owned_idx
  on public.user_reward_entitlements (user_id, owned_at desc, reward_key);

create index if not exists user_reward_entitlements_pending_celebration_idx
  on public.user_reward_entitlements (user_id, owned_at, reward_key)
  where celebration_seen_at is null;

alter table public.reward_catalog_meta enable row level security;
alter table public.reward_definitions enable row level security;
alter table public.user_reward_entitlements enable row level security;

drop policy if exists "Authenticated users can read active reward definitions"
  on public.reward_definitions;
create policy "Authenticated users can read active reward definitions"
  on public.reward_definitions
  for select
  to authenticated
  using (is_active);

drop policy if exists "Users can read own reward entitlements"
  on public.user_reward_entitlements;
create policy "Users can read own reward entitlements"
  on public.user_reward_entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.bump_reward_catalog_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.reward_catalog_meta (
    catalog_key,
    catalog_version,
    updated_at
  ) values (
    'primary',
    1,
    now()
  )
  on conflict (catalog_key) do update set
    catalog_version = reward_catalog_meta.catalog_version + 1,
    updated_at = now();

  return null;
end;
$$;

drop trigger if exists bump_reward_catalog_version
  on public.reward_definitions;
create trigger bump_reward_catalog_version
  after insert or update or delete on public.reward_definitions
  for each statement execute function public.bump_reward_catalog_version();

create or replace function public.enforce_reward_entitlement_definition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.reward_definitions definition
    where definition.reward_key = new.reward_key
      and definition.state_model = 'ownership'
  ) then
    raise exception 'Only ownership rewards can create permanent entitlements.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_reward_entitlement_definition
  on public.user_reward_entitlements;
create trigger enforce_reward_entitlement_definition
  before insert or update of reward_key on public.user_reward_entitlements
  for each row execute function public.enforce_reward_entitlement_definition();

create or replace function public.protect_reward_definition_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.reward_key is distinct from old.reward_key
    or new.reward_type is distinct from old.reward_type
    or new.state_model is distinct from old.state_model
    or new.fulfillment_key is distinct from old.fulfillment_key
    or new.challenge_key is distinct from old.challenge_key then
    raise exception 'Reward identity fields are immutable.'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_reward_definition_identity
  on public.reward_definitions;
create trigger protect_reward_definition_identity
  before update of reward_key, reward_type, state_model, fulfillment_key, challenge_key
  on public.reward_definitions
  for each row execute function public.protect_reward_definition_identity();

create or replace function public.sync_challenge_reward_definition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.reward_definitions (
    reward_key,
    reward_type,
    state_model,
    title,
    description,
    points_required,
    fulfillment_key,
    challenge_key,
    required_entitlement_key,
    icon,
    sort_order,
    is_active,
    display_metadata,
    created_at,
    updated_at
  ) values (
    new.challenge_key,
    'challenge',
    'challenge_lifecycle',
    new.title,
    new.teaser,
    new.points_required,
    new.challenge_key,
    new.challenge_key,
    new.entitlement_key,
    new.icon,
    new.sort_order,
    new.is_active,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'challengeType', new.challenge_type,
      'durationDays', new.duration_days
    ),
    new.created_at,
    now()
  )
  on conflict (reward_key) do update set
    reward_type = 'challenge',
    state_model = 'challenge_lifecycle',
    title = excluded.title,
    description = excluded.description,
    points_required = excluded.points_required,
    fulfillment_key = excluded.fulfillment_key,
    challenge_key = excluded.challenge_key,
    required_entitlement_key = excluded.required_entitlement_key,
    icon = excluded.icon,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    display_metadata = excluded.display_metadata,
    updated_at = now();

  return new;
end;
$$;

insert into public.reward_definitions (
  reward_key,
  reward_type,
  state_model,
  title,
  description,
  points_required,
  fulfillment_key,
  challenge_key,
  required_entitlement_key,
  icon,
  sort_order,
  is_active,
  display_metadata,
  created_at,
  updated_at
)
select
  definition.challenge_key,
  'challenge',
  'challenge_lifecycle',
  definition.title,
  definition.teaser,
  definition.points_required,
  definition.challenge_key,
  definition.challenge_key,
  definition.entitlement_key,
  definition.icon,
  definition.sort_order,
  definition.is_active,
  coalesce(definition.metadata, '{}'::jsonb) || jsonb_build_object(
    'challengeType', definition.challenge_type,
    'durationDays', definition.duration_days
  ),
  definition.created_at,
  definition.updated_at
from public.challenge_definitions definition
on conflict (reward_key) do update set
  reward_type = excluded.reward_type,
  state_model = excluded.state_model,
  title = excluded.title,
  description = excluded.description,
  points_required = excluded.points_required,
  fulfillment_key = excluded.fulfillment_key,
  challenge_key = excluded.challenge_key,
  required_entitlement_key = excluded.required_entitlement_key,
  icon = excluded.icon,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  display_metadata = excluded.display_metadata,
  updated_at = excluded.updated_at;

drop trigger if exists sync_challenge_reward_definition
  on public.challenge_definitions;
create trigger sync_challenge_reward_definition
  after insert or update of title, teaser, challenge_type, points_required,
    duration_days, entitlement_key, icon, sort_order, is_active, metadata
  on public.challenge_definitions
  for each row execute function public.sync_challenge_reward_definition();

create or replace function public.grant_reward_entitlement(
  target_user_id uuid,
  target_reward_key text,
  target_source_type text default 'point_threshold',
  target_source_id text default null,
  target_celebration_seen boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_user_id uuid;
begin
  if target_user_id is null
    or target_reward_key is null
    or target_source_type is null
    or target_source_type !~ '^[a-z][a-z0-9_]*$' then
    return false;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id,
    celebration_seen_at
  )
  select
    stats.user_id,
    definition.reward_key,
    now(),
    target_source_type,
    coalesce(target_source_id, definition.reward_key),
    case when target_celebration_seen then now() else null end
  from public.user_game_stats stats
  join public.reward_definitions definition
    on definition.reward_key = target_reward_key
   and definition.state_model = 'ownership'
   and definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
  where stats.user_id = target_user_id
  on conflict (user_id, reward_key) do nothing
  returning user_id into inserted_user_id;

  return inserted_user_id is not null;
end;
$$;

create or replace function public.reconcile_user_reward_entitlements(
  target_user_id uuid,
  target_celebration_seen boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer := 0;
begin
  if target_user_id is null then
    return 0;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id,
    celebration_seen_at
  )
  select
    stats.user_id,
    definition.reward_key,
    now(),
    'point_threshold',
    definition.reward_key,
    case when target_celebration_seen then now() else null end
  from public.user_game_stats stats
  join public.reward_definitions definition
    on definition.state_model = 'ownership'
   and definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
  where stats.user_id = target_user_id
  on conflict (user_id, reward_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.sync_user_reward_entitlements_from_stats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
    and new.total_points is not distinct from old.total_points then
    return new;
  end if;

  perform public.reconcile_user_reward_entitlements(new.user_id);
  return new;
end;
$$;

drop trigger if exists sync_user_reward_entitlements_from_stats
  on public.user_game_stats;
create trigger sync_user_reward_entitlements_from_stats
  after insert or update of total_points on public.user_game_stats
  for each row execute function public.sync_user_reward_entitlements_from_stats();

create or replace function public.sync_reward_definition_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not new.is_active or new.state_model <> 'ownership' then
    return new;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id
  )
  select
    stats.user_id,
    new.reward_key,
    now(),
    'catalog_threshold',
    new.reward_key
  from public.user_game_stats stats
  where greatest(stats.total_points, 0) >= new.points_required
  on conflict (user_id, reward_key) do nothing;

  return new;
end;
$$;

drop trigger if exists sync_reward_definition_entitlements
  on public.reward_definitions;
create trigger sync_reward_definition_entitlements
  after insert or update of points_required, is_active, state_model
  on public.reward_definitions
  for each row execute function public.sync_reward_definition_entitlements();

create or replace function public.reward_catalog_item_for_user(
  target_user_id uuid,
  target_reward_key text,
  target_current_points integer
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with item as (
    select
      definition.*,
      challenge_state.status as challenge_status,
      challenge_state.unlock_points,
      challenge_state.unlocked_at,
      challenge_state.started_at,
      challenge_state.completed_at,
      challenge_state.celebration_seen_at as challenge_celebration_seen_at,
      reward_entitlement.owned_at,
      reward_entitlement.celebration_seen_at as ownership_celebration_seen_at,
      (
        definition.required_entitlement_key is null
        or exists (
          select 1
          from public.entitlements access_entitlement
          where access_entitlement.user_id = target_user_id
            and access_entitlement.entitlement_key = definition.required_entitlement_key
            and access_entitlement.status = 'active'
            and (
              access_entitlement.starts_at is null
              or access_entitlement.starts_at <= now()
            )
            and (
              access_entitlement.ends_at is null
              or access_entitlement.ends_at > now()
            )
        )
      ) as can_access,
      case
        when definition.state_model = 'challenge_lifecycle'
          then coalesce(challenge_state.status, 'locked')
        when reward_entitlement.reward_key is not null then 'owned'
        else 'locked'
      end as current_status
    from public.reward_definitions definition
    left join public.user_challenge_states challenge_state
      on challenge_state.user_id = target_user_id
     and challenge_state.challenge_key = definition.challenge_key
    left join public.user_reward_entitlements reward_entitlement
      on reward_entitlement.user_id = target_user_id
     and reward_entitlement.reward_key = definition.reward_key
    where definition.reward_key = target_reward_key
  )
  select jsonb_build_object(
    'key', item.reward_key,
    'rewardType', item.reward_type,
    'stateModel', item.state_model,
    'status', item.current_status,
    'title', item.title,
    'description', item.description,
    'pointsRequired', item.points_required,
    'currentPoints', greatest(coalesce(target_current_points, 0), 0),
    'pointsRemaining', case
      when item.current_status <> 'locked' then 0
      else greatest(item.points_required - greatest(coalesce(target_current_points, 0), 0), 0)
    end,
    'progressPercent', case
      when item.current_status <> 'locked' or item.points_required = 0 then 100
      else least(
        round(
          greatest(coalesce(target_current_points, 0), 0)::numeric
            / item.points_required::numeric * 100,
          2
        ),
        100
      )
    end,
    'fulfillmentKey', item.fulfillment_key,
    'requiredEntitlementKey', item.required_entitlement_key,
    'icon', item.icon,
    'sortOrder', item.sort_order,
    'active', item.is_active,
    'metadata', item.display_metadata,
    'canAccess', item.can_access,
    'accessReason', case
      when not item.can_access then 'entitlement_required'
      when item.current_status = 'locked' then 'points_required'
      else null
    end,
    'allowedActions', case
      when item.state_model = 'challenge_lifecycle'
        and item.current_status = 'available'
        and item.can_access
        then jsonb_build_array('start')
      else '[]'::jsonb
    end,
    'unlockPoints', item.unlock_points,
    'unlockedAt', item.unlocked_at,
    'startedAt', item.started_at,
    'completedAt', item.completed_at,
    'ownedAt', item.owned_at,
    'celebrationSeenAt', case
      when item.state_model = 'challenge_lifecycle'
        then item.challenge_celebration_seen_at
      else item.ownership_celebration_seen_at
    end
  )
  from item;
$$;

create or replace function public.reward_catalog_for_user(
  target_user_id uuid,
  target_page_size integer default 50,
  target_after_sort_order integer default null,
  target_after_reward_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  current_total_points integer := 0;
  normalized_page_size integer;
  catalog_version bigint := 1;
  total_items integer := 0;
  item_rows jsonb := '[]'::jsonb;
  next_unlock jsonb := null;
  next_cursor jsonb := null;
  has_more boolean := false;
  last_item jsonb;
begin
  if target_user_id is null then
    raise exception 'A user is required for the reward catalog.'
      using errcode = '22023';
  end if;

  normalized_page_size := least(greatest(coalesce(target_page_size, 50), 1), 100);
  if (target_after_sort_order is null) <> (target_after_reward_key is null)
    or (
      target_after_reward_key is not null
      and target_after_reward_key !~ '^[a-z0-9][a-z0-9_.:-]*$'
    ) then
    raise exception 'The reward catalog cursor is invalid.'
      using errcode = '22023';
  end if;

  select greatest(coalesce(stats.total_points, 0), 0)
    into current_total_points
  from public.user_game_stats stats
  where stats.user_id = target_user_id;
  current_total_points := coalesce(current_total_points, 0);

  select coalesce(meta.catalog_version, 1)
    into catalog_version
  from public.reward_catalog_meta meta
  where meta.catalog_key = 'primary';
  catalog_version := coalesce(catalog_version, 1);

  select count(*)::integer
    into total_items
  from public.reward_definitions definition
  left join public.user_reward_entitlements reward_entitlement
    on reward_entitlement.user_id = target_user_id
   and reward_entitlement.reward_key = definition.reward_key
  where definition.is_active
    or (
      definition.state_model = 'ownership'
      and reward_entitlement.reward_key is not null
    );

  with candidates as (
    select
      definition.sort_order,
      definition.reward_key,
      public.reward_catalog_item_for_user(
        target_user_id,
        definition.reward_key,
        current_total_points
      ) as reward
    from public.reward_definitions definition
    left join public.user_reward_entitlements reward_entitlement
      on reward_entitlement.user_id = target_user_id
     and reward_entitlement.reward_key = definition.reward_key
    where (
        definition.is_active
        or (
          definition.state_model = 'ownership'
          and reward_entitlement.reward_key is not null
        )
      )
      and (
        target_after_sort_order is null
        or (definition.sort_order, definition.reward_key)
          > (target_after_sort_order, target_after_reward_key)
      )
    order by definition.sort_order, definition.reward_key
    limit normalized_page_size + 1
  ), numbered as (
    select
      candidates.*,
      row_number() over (
        order by candidates.sort_order, candidates.reward_key
      ) as row_number
    from candidates
  )
  select
    coalesce(
      jsonb_agg(numbered.reward order by numbered.sort_order, numbered.reward_key)
        filter (where numbered.row_number <= normalized_page_size),
      '[]'::jsonb
    ),
    coalesce(bool_or(numbered.row_number > normalized_page_size), false)
  into item_rows, has_more
  from numbered;

  if has_more and jsonb_array_length(item_rows) > 0 then
    last_item := item_rows -> (jsonb_array_length(item_rows) - 1);
    next_cursor := jsonb_build_object(
      'sortOrder', (last_item ->> 'sortOrder')::integer,
      'key', last_item ->> 'key'
    );
  end if;

  select state.reward
    into next_unlock
  from public.reward_definitions definition
  cross join lateral (
    select public.reward_catalog_item_for_user(
      target_user_id,
      definition.reward_key,
      current_total_points
    ) as reward
  ) state
  where definition.is_active
    and state.reward ->> 'status' = 'locked'
    and coalesce((state.reward ->> 'canAccess')::boolean, false)
  order by definition.points_required, definition.sort_order, definition.reward_key
  limit 1;

  return jsonb_build_object(
    'schemaVersion', 1,
    'catalogVersion', catalog_version,
    'totalPoints', current_total_points,
    'items', item_rows,
    'nextUnlock', next_unlock,
    'page', jsonb_build_object(
      'limit', normalized_page_size,
      'totalItems', total_items,
      'hasMore', has_more,
      'nextCursor', next_cursor
    )
  );
end;
$$;

create or replace function public.get_reward_catalog(
  target_page_size integer default 50,
  target_after_sort_order integer default null,
  target_after_reward_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You need to log in to view rewards.'
      using errcode = '42501';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);
  perform public.reconcile_user_reward_entitlements(current_user_id);

  return public.reward_catalog_for_user(
    current_user_id,
    target_page_size,
    target_after_sort_order,
    target_after_reward_key
  );
end;
$$;

create or replace function public.claim_reward_entitlement_unlocks()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  claimed_keys jsonb := '[]'::jsonb;
begin
  if current_user_id is null then
    raise exception 'You need to log in to claim reward unlocks.'
      using errcode = '42501';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_reward_entitlements(current_user_id);

  with pending as materialized (
    select reward_entitlement.user_id, reward_entitlement.reward_key
    from public.user_reward_entitlements reward_entitlement
    join public.reward_definitions definition
      on definition.reward_key = reward_entitlement.reward_key
     and definition.state_model = 'ownership'
    where reward_entitlement.user_id = current_user_id
      and reward_entitlement.celebration_seen_at is null
    order by definition.points_required, definition.sort_order, definition.reward_key
    for update of reward_entitlement skip locked
  ), claimed as (
    update public.user_reward_entitlements reward_entitlement
    set celebration_seen_at = now(),
        updated_at = now()
    from pending
    where reward_entitlement.user_id = pending.user_id
      and reward_entitlement.reward_key = pending.reward_key
      and reward_entitlement.celebration_seen_at is null
    returning reward_entitlement.reward_key
  )
  select coalesce(
      jsonb_agg(claimed.reward_key order by definition.points_required, definition.sort_order, claimed.reward_key),
      '[]'::jsonb
    )
    into claimed_keys
  from claimed
  join public.reward_definitions definition
    on definition.reward_key = claimed.reward_key;

  return jsonb_build_object(
    'claimedKeys', claimed_keys,
    'catalog', public.reward_catalog_for_user(current_user_id, 100, null, null)
  );
end;
$$;

revoke all on public.reward_catalog_meta from public, anon, authenticated;
revoke all on public.reward_definitions from public, anon, authenticated;
revoke all on public.user_reward_entitlements from public, anon, authenticated;

grant select, insert, update, delete on public.reward_catalog_meta to service_role;
grant select, insert, update, delete on public.reward_definitions to service_role;
grant select, insert, update, delete on public.user_reward_entitlements to service_role;
grant select on public.user_reward_entitlements to authenticated;

revoke execute on function public.bump_reward_catalog_version() from public, anon, authenticated;
revoke execute on function public.enforce_reward_entitlement_definition() from public, anon, authenticated;
revoke execute on function public.protect_reward_definition_identity() from public, anon, authenticated;
revoke execute on function public.sync_challenge_reward_definition() from public, anon, authenticated;
revoke execute on function public.grant_reward_entitlement(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.reconcile_user_reward_entitlements(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.sync_user_reward_entitlements_from_stats() from public, anon, authenticated;
revoke execute on function public.sync_reward_definition_entitlements() from public, anon, authenticated;
revoke execute on function public.reward_catalog_item_for_user(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.reward_catalog_for_user(uuid, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.get_reward_catalog(integer, integer, text) from public, anon;
revoke execute on function public.claim_reward_entitlement_unlocks() from public, anon;

grant execute on function public.grant_reward_entitlement(uuid, text, text, text, boolean) to service_role;
grant execute on function public.reconcile_user_reward_entitlements(uuid, boolean) to service_role;
grant execute on function public.get_reward_catalog(integer, integer, text) to authenticated;
grant execute on function public.claim_reward_entitlement_unlocks() to authenticated;

commit;

-- Privacy-safe, immutable public snapshots for streak, challenge-progress, and
-- general Dominion shares. Public tokens are returned once and stored only as
-- SHA-256 digests so a database read cannot recover usable share URLs.

create table if not exists public.public_share_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  public_token_digest bytea not null unique,
  snapshot_version integer not null default 1 check (snapshot_version = 1),
  share_kind text not null check (share_kind in ('streak', 'progress', 'general')),
  snapshot_payload jsonb not null check (jsonb_typeof(snapshot_payload) = 'object'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in ('user', 'challenge_reset', 'safety')),
  aggregate_view_count bigint not null default 0 check (aggregate_view_count >= 0),
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(public_token_digest) = 32),
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_reason is null))
);

create index if not exists public_share_snapshots_user_created_idx
  on public.public_share_snapshots (user_id, created_at desc);

create index if not exists public_share_snapshots_expiry_idx
  on public.public_share_snapshots (expires_at)
  where revoked_at is null;

alter table public.public_share_snapshots enable row level security;

revoke all on table public.public_share_snapshots from public, anon, authenticated;

create or replace function public.build_share_snapshot_payload(
  target_user_id uuid,
  target_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  stats_row public.user_game_stats%rowtype;
  current_challenge_day integer := 0;
begin
  if target_user_id is null then
    raise exception 'A user is required.';
  end if;
  if target_kind is null or target_kind not in ('streak', 'progress', 'general') then
    raise exception 'Unsupported share type.';
  end if;

  if target_kind = 'streak' then
    select *
      into stats_row
      from public.user_game_stats
     where user_id = target_user_id;

    return jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'streak',
      'appStreak', greatest(coalesce(stats_row.current_app_streak, 0), 0),
      'fullStandardStreak', greatest(coalesce(stats_row.current_full_day_streak, 0), 0)
    );
  end if;

  if target_kind = 'progress' then
    select least(greatest(coalesce(max(challenge_day), 0), 0), 77)
      into current_challenge_day
      from public.check_ins
     where user_id = target_user_id;

    return jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'progress',
      'currentChallengeDay', current_challenge_day,
      'challengeLength', 77,
      'percentComplete', round((current_challenge_day::numeric / 77::numeric) * 100, 1)
    );
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'general',
    'challengeLength', 77,
    'dailyStandards', 7
  );
end;
$$;

create or replace function public.preview_share_snapshot(target_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'kind', target_kind,
    'payload', public.build_share_snapshot_payload(current_user_id, target_kind),
    'defaultExpirationDays', 30,
    'privacy', jsonb_build_object(
      'includesIdentity', false,
      'includesGroup', false,
      'includesActivityHistory', false
    )
  );
end;
$$;

create or replace function public.create_share_snapshot(
  target_kind text,
  target_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_user_id uuid := auth.uid();
  raw_token text;
  new_snapshot_id uuid;
  normalized_expires_at timestamptz := coalesce(target_expires_at, now() + interval '30 days');
  payload jsonb;
  recent_count integer;
  active_count integer;
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if target_kind is null or target_kind not in ('streak', 'progress', 'general') then
    raise exception 'Unsupported share type.';
  end if;
  if normalized_expires_at < now() + interval '1 hour'
     or normalized_expires_at > now() + interval '90 days' then
    raise exception 'Share expiration must be between one hour and 90 days.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('share-snapshot:' || current_user_id::text, 0));

  select count(*)::integer
    into recent_count
    from public.public_share_snapshots
   where user_id = current_user_id
     and created_at > now() - interval '1 hour';
  if recent_count >= 10 then
    raise exception 'Share link rate limit reached. Try again later.' using errcode = 'P0001';
  end if;

  select count(*)::integer
    into active_count
    from public.public_share_snapshots
   where user_id = current_user_id
     and revoked_at is null
     and expires_at > now();
  if active_count >= 25 then
    raise exception 'Revoke an existing share link before creating another.' using errcode = 'P0001';
  end if;

  payload := public.build_share_snapshot_payload(current_user_id, target_kind);
  raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.public_share_snapshots (
    user_id,
    public_token_digest,
    snapshot_version,
    share_kind,
    snapshot_payload,
    expires_at
  ) values (
    current_user_id,
    digest(raw_token, 'sha256'),
    1,
    target_kind,
    payload,
    normalized_expires_at
  )
  returning id into new_snapshot_id;

  return jsonb_build_object(
    'schemaVersion', 1,
    'snapshotId', new_snapshot_id,
    'token', raw_token,
    'kind', target_kind,
    'payload', payload,
    'expiresAt', normalized_expires_at
  );
end;
$$;

create or replace function public.revoke_share_snapshot(target_snapshot_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_user_id uuid := auth.uid();
  changed_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  update public.public_share_snapshots
     set revoked_at = now(),
         revoked_reason = 'user',
         updated_at = now()
   where id = target_snapshot_id
     and user_id = current_user_id
     and revoked_at is null;
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

create or replace function public.get_public_share_snapshot(target_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  result jsonb;
begin
  -- Invalid, revoked, expired, and unknown links intentionally share one null
  -- response so callers cannot distinguish or enumerate owner state.
  if target_token is null or target_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  update public.public_share_snapshots
     set aggregate_view_count = case
           when aggregate_view_count < 9223372036854775807 then aggregate_view_count + 1
           else aggregate_view_count
         end,
         last_viewed_at = now(),
         updated_at = now()
   where public_token_digest = digest(target_token, 'sha256')
     and revoked_at is null
     and expires_at > now()
  returning jsonb_build_object(
    'schemaVersion', snapshot_version,
    'kind', share_kind,
    'payload', snapshot_payload,
    'expiresAt', expires_at
  ) into result;

  return result;
end;
$$;

create or replace function public.revoke_share_snapshots_after_challenge_reset()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.challenge_start_date is distinct from old.challenge_start_date then
    update public.public_share_snapshots
       set revoked_at = now(),
           revoked_reason = 'challenge_reset',
           updated_at = now()
     where user_id = new.user_id
       and share_kind in ('streak', 'progress')
       and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists revoke_share_snapshots_after_challenge_reset on public.profiles;
create trigger revoke_share_snapshots_after_challenge_reset
  after update of challenge_start_date on public.profiles
  for each row
  execute function public.revoke_share_snapshots_after_challenge_reset();

create or replace function public.purge_retired_share_snapshots(
  target_retention interval default interval '30 days'
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  deleted_count bigint;
begin
  if target_retention < interval '1 day' or target_retention > interval '365 days' then
    raise exception 'Share retention must be between one and 365 days.';
  end if;

  delete from public.public_share_snapshots
   where (expires_at <= now() or revoked_at is not null)
     and coalesce(revoked_at, expires_at) <= now() - target_retention;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.build_share_snapshot_payload(uuid, text) from public, anon, authenticated;
revoke all on function public.preview_share_snapshot(text) from public, anon;
revoke all on function public.create_share_snapshot(text, timestamptz) from public, anon;
revoke all on function public.revoke_share_snapshot(uuid) from public, anon;
revoke all on function public.get_public_share_snapshot(text) from public;
revoke all on function public.revoke_share_snapshots_after_challenge_reset() from public, anon, authenticated;
revoke all on function public.purge_retired_share_snapshots(interval) from public, anon, authenticated;

grant execute on function public.preview_share_snapshot(text) to authenticated;
grant execute on function public.create_share_snapshot(text, timestamptz) to authenticated;
grant execute on function public.revoke_share_snapshot(uuid) to authenticated;
grant execute on function public.get_public_share_snapshot(text) to anon, authenticated, service_role;
grant execute on function public.purge_retired_share_snapshots(interval) to service_role;

begin;

create extension if not exists pgcrypto with schema extensions;

-- The legacy RPC joined immediately from a reusable plaintext token. Remove it
-- before replacing the token column so opening a link can never mutate membership.
drop function if exists public.join_crew_by_invite(text);

alter table public.crews
  add column if not exists member_limit smallint not null default 50;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crews_member_limit_check'
      and conrelid = 'public.crews'::regclass
  ) then
    alter table public.crews
      add constraint crews_member_limit_check check (member_limit between 2 and 500);
  end if;
end;
$$;

alter table public.crew_invites
  add column if not exists token_hash text,
  add column if not exists token_hint text,
  add column if not exists redeemed_by uuid references auth.users(id) on delete set null,
  add column if not exists redeemed_at timestamptz,
  add column if not exists preview_window_started_at timestamptz,
  add column if not exists preview_count integer not null default 0;

-- Preserve deployed links during migration, then remove every plaintext secret.
update public.crew_invites
set token_hash = encode(extensions.digest(token, 'sha256'), 'hex'),
    token_hint = right(token, 6)
where token_hash is null
  and token is not null;

alter table public.crew_invites
  alter column token_hash set not null;

alter table public.crew_invites
  drop column if exists token;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_token_hash_key'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_token_hash_key unique (token_hash);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_token_hash_format_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_token_hash_format_check check (token_hash ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_token_hint_format_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_token_hint_format_check check (token_hint is null or token_hint ~ '^[A-Za-z0-9_-]{1,6}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_redemption_pair_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_redemption_pair_check check (
        (redeemed_by is null and redeemed_at is null)
        or (redeemed_by is not null and redeemed_at is not null)
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_preview_count_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_preview_count_check check (preview_count >= 0);
  end if;
end;
$$;

create table if not exists public.crew_invite_sessions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.crew_invites(id) on delete cascade,
  continuation_hash text not null unique check (continuation_hash ~ '^[0-9a-f]{64}$'),
  bound_user_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  confirmation_attempts smallint not null default 0 check (confirmation_attempts between 0 and 6),
  confirmed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.crew_invite_attributions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null unique references public.crew_invites(id) on delete cascade,
  crew_id uuid not null references public.crews(id) on delete cascade,
  inviter_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (crew_id, recipient_user_id),
  check (inviter_user_id <> recipient_user_id)
);

create or replace function public.reject_crew_invite_attribution_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.invite_id is distinct from old.invite_id
    or new.crew_id is distinct from old.crew_id
    or new.inviter_user_id is distinct from old.inviter_user_id
    or new.recipient_user_id is distinct from old.recipient_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Crew invite attribution identity is immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists keep_crew_invite_attributions_immutable on public.crew_invite_attributions;
create trigger keep_crew_invite_attributions_immutable
  before update on public.crew_invite_attributions
  for each row execute function public.reject_crew_invite_attribution_mutation();

create index if not exists crew_invites_active_crew_idx
  on public.crew_invites (crew_id, created_at desc)
  where revoked_at is null and redeemed_at is null;

create index if not exists crew_invite_sessions_invite_idx
  on public.crew_invite_sessions (invite_id, created_at desc);

create index if not exists crew_invite_sessions_expiry_idx
  on public.crew_invite_sessions (expires_at);

create index if not exists crew_invite_attributions_inviter_idx
  on public.crew_invite_attributions (inviter_user_id, created_at desc);

create or replace function public.crew_invite_secret_hash(secret_value text)
returns text
language sql
immutable
strict
set search_path = public, extensions
as $$
  select encode(digest(secret_value, 'sha256'), 'hex');
$$;

create or replace function public.issue_crew_invite(target_crew_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller_id uuid := auth.uid();
  issued_token text;
  issued_invite public.crew_invites%rowtype;
  recent_count integer;
  latest_created_at timestamptz;
begin
  if caller_id is null then
    return jsonb_build_object('status', 'authentication_required');
  end if;

  if not public.has_active_entitlement('membership_active')
    or not public.can_manage_crew(target_crew_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('crew-invite:' || target_crew_id::text, 0));

  select count(*)::integer, max(created_at)
    into recent_count, latest_created_at
    from public.crew_invites
    where crew_id = target_crew_id
      and created_by = caller_id
      and created_at between now() - interval '1 hour' and now() + interval '1 minute';

  if recent_count >= 10
    or (latest_created_at is not null and latest_created_at > now() - interval '5 seconds') then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  update public.crew_invites
  set revoked_at = now()
  where crew_id = target_crew_id
    and revoked_at is null
    and redeemed_at is null;

  issued_token := encode(gen_random_bytes(32), 'hex');
  insert into public.crew_invites (
    crew_id,
    token_hash,
    token_hint,
    created_by,
    expires_at
  ) values (
    target_crew_id,
    public.crew_invite_secret_hash(issued_token),
    right(issued_token, 6),
    caller_id,
    now() + interval '14 days'
  )
  returning * into issued_invite;

  return jsonb_build_object(
    'status', 'issued',
    'inviteId', issued_invite.id,
    'token', issued_token,
    'tokenHint', issued_invite.token_hint,
    'expiresAt', issued_invite.expires_at
  );
end;
$$;

create or replace function public.revoke_crew_invite(target_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  target_crew_id uuid;
begin
  if caller_id is null then
    return jsonb_build_object('status', 'authentication_required');
  end if;

  select crew_id
    into target_crew_id
    from public.crew_invites
    where id = target_invite_id;

  if target_crew_id is null
    or not public.has_active_entitlement('membership_active')
    or not public.can_manage_crew(target_crew_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update public.crew_invites
  set revoked_at = coalesce(revoked_at, now())
  where id = target_invite_id
    and redeemed_at is null;

  return jsonb_build_object('status', 'revoked');
end;
$$;

create or replace function public.preview_crew_invite(
  invite_token text default null,
  continuation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller_id uuid := auth.uid();
  invite_row public.crew_invites%rowtype;
  session_row public.crew_invite_sessions%rowtype;
  crew_row public.crews%rowtype;
  continuation_secret text;
  inviter_first_name text;
  invite_status text;
  preview_payload jsonb;
  member_count integer;
begin
  if (invite_token is null) = (continuation_token is null) then
    return jsonb_build_object('status', 'invalid');
  end if;

  if invite_token is not null then
    if char_length(invite_token) < 16 or char_length(invite_token) > 256
      or invite_token !~ '^[A-Za-z0-9_-]+$' then
      return jsonb_build_object('status', 'invalid');
    end if;

    select *
      into invite_row
      from public.crew_invites
      where token_hash = public.crew_invite_secret_hash(invite_token)
      limit 1
      for update;

    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;

    if invite_row.preview_window_started_at is null
      or invite_row.preview_window_started_at <= now() - interval '1 hour' then
      update public.crew_invites
      set preview_window_started_at = now(), preview_count = 1
      where id = invite_row.id
      returning * into invite_row;
    elsif invite_row.preview_count >= 120 then
      return jsonb_build_object('status', 'rate_limited');
    else
      update public.crew_invites
      set preview_count = preview_count + 1
      where id = invite_row.id
      returning * into invite_row;
    end if;
  else
    if char_length(continuation_token) < 16 or char_length(continuation_token) > 256
      or continuation_token !~ '^[A-Za-z0-9_-]+$' then
      return jsonb_build_object('status', 'invalid');
    end if;

    select *
      into session_row
      from public.crew_invite_sessions
      where continuation_hash = public.crew_invite_secret_hash(continuation_token)
      limit 1
      for update;

    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;

    if session_row.expires_at <= now() then
      return jsonb_build_object('status', 'session_expired');
    end if;

    if caller_id is not null and session_row.bound_user_id is not null
      and session_row.bound_user_id <> caller_id then
      return jsonb_build_object('status', 'wrong_account');
    end if;

    if caller_id is not null and session_row.bound_user_id is null then
      update public.crew_invite_sessions
      set bound_user_id = caller_id, last_seen_at = now()
      where id = session_row.id
      returning * into session_row;
    else
      update public.crew_invite_sessions
      set last_seen_at = now()
      where id = session_row.id;
    end if;

    select *
      into invite_row
      from public.crew_invites
      where id = session_row.invite_id
      for update;

    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;

  if invite_row.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  if invite_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  select * into crew_row
    from public.crews
    where id = invite_row.crew_id;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select split_part(coalesce(nullif(trim(name), ''), 'Dominion member'), ' ', 1)
    into inviter_first_name
    from public.profiles
    where user_id = invite_row.created_by;

  preview_payload := jsonb_build_object(
    'groupName', crew_row.name,
    'inviterName', coalesce(inviter_first_name, 'Dominion member'),
    'expiresAt', invite_row.expires_at
  );

  if invite_row.redeemed_by is not null then
    if caller_id = invite_row.redeemed_by and exists (
      select 1 from public.crew_members
      where crew_id = invite_row.crew_id and user_id = caller_id
    ) then
      return jsonb_build_object('status', 'already_member', 'preview', preview_payload);
    end if;
    return jsonb_build_object('status', 'already_used');
  end if;

  if caller_id is not null and exists (
    select 1 from public.crew_members
    where crew_id = invite_row.crew_id and user_id = caller_id
  ) then
    return jsonb_build_object('status', 'already_member', 'preview', preview_payload);
  end if;

  select count(*)::integer into member_count
    from public.crew_members
    where crew_id = invite_row.crew_id;

  invite_status := case when member_count >= crew_row.member_limit then 'full' else 'ready' end;

  if invite_token is not null and invite_status in ('ready', 'full') then
    continuation_secret := encode(gen_random_bytes(32), 'hex');
    insert into public.crew_invite_sessions (
      invite_id,
      continuation_hash,
      bound_user_id,
      expires_at
    ) values (
      invite_row.id,
      public.crew_invite_secret_hash(continuation_secret),
      caller_id,
      now() + interval '2 hours'
    );
  end if;

  if invite_status = 'ready' then
    return jsonb_strip_nulls(jsonb_build_object(
      'status', invite_status,
      'preview', preview_payload,
      'continuationToken', continuation_secret
    ));
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', invite_status,
    'continuationToken', continuation_secret
  ));
end;
$$;

create or replace function public.confirm_crew_invite(continuation_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller_id uuid := auth.uid();
  session_row public.crew_invite_sessions%rowtype;
  invite_row public.crew_invites%rowtype;
  crew_row public.crews%rowtype;
  member_name text;
  member_avatar_url text;
  inviter_first_name text;
  redemption_id uuid;
  member_count integer;
  preview_payload jsonb;
begin
  if caller_id is null then
    return jsonb_build_object('status', 'authentication_required');
  end if;

  if continuation_token is null
    or char_length(continuation_token) < 16
    or char_length(continuation_token) > 256
    or continuation_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  select *
    into session_row
    from public.crew_invite_sessions
    where continuation_hash = public.crew_invite_secret_hash(continuation_token)
    limit 1
    for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if session_row.expires_at <= now() then
    return jsonb_build_object('status', 'session_expired');
  end if;

  if session_row.bound_user_id is not null and session_row.bound_user_id <> caller_id then
    return jsonb_build_object('status', 'wrong_account');
  end if;

  if session_row.confirmation_attempts >= 5 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  update public.crew_invite_sessions
  set bound_user_id = caller_id,
      confirmation_attempts = confirmation_attempts + 1,
      last_seen_at = now()
  where id = session_row.id
  returning * into session_row;

  select *
    into invite_row
    from public.crew_invites
    where id = session_row.invite_id
    for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if invite_row.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  if invite_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  select * into crew_row
    from public.crews
    where id = invite_row.crew_id
    for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select split_part(coalesce(nullif(trim(name), ''), 'Dominion member'), ' ', 1)
    into inviter_first_name
    from public.profiles
    where user_id = invite_row.created_by;
  preview_payload := jsonb_build_object(
    'groupName', crew_row.name,
    'inviterName', coalesce(inviter_first_name, 'Dominion member'),
    'expiresAt', invite_row.expires_at
  );

  if exists (
    select 1 from public.crew_members
    where crew_id = invite_row.crew_id and user_id = caller_id
  ) then
    return jsonb_build_object('status', 'already_member', 'preview', preview_payload);
  end if;

  if invite_row.redeemed_by is not null then
    return jsonb_build_object('status', 'already_used');
  end if;

  if not public.has_active_entitlement('membership_active') then
    return jsonb_build_object('status', 'subscription_required');
  end if;

  select count(*)::integer into member_count
    from public.crew_members
    where crew_id = invite_row.crew_id;
  if member_count >= crew_row.member_limit then
    return jsonb_build_object('status', 'full');
  end if;

  if exists (
    select 1 from public.crew_invite_attributions
    where crew_id = invite_row.crew_id and recipient_user_id = caller_id
  ) then
    return jsonb_build_object('status', 'already_used');
  end if;

  select coalesce(nullif(p.name, ''), 'Member'), coalesce(p.avatar_url, '')
    into member_name, member_avatar_url
    from public.profiles p
    where p.user_id = caller_id;

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
    invite_row.crew_id,
    caller_id,
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'member'
  );

  insert into public.crew_invite_attributions (
    invite_id,
    crew_id,
    inviter_user_id,
    recipient_user_id
  ) values (
    invite_row.id,
    invite_row.crew_id,
    invite_row.created_by,
    caller_id
  )
  returning id into redemption_id;

  update public.crew_invites
  set redeemed_by = caller_id,
      redeemed_at = now()
  where id = invite_row.id;

  update public.crew_invite_sessions
  set confirmed_at = now()
  where id = session_row.id;

  return jsonb_build_object(
    'status', 'joined',
    'crewId', invite_row.crew_id,
    'redemptionId', redemption_id,
    'preview', preview_payload
  );
end;
$$;

alter table public.crew_invite_sessions enable row level security;
alter table public.crew_invite_attributions enable row level security;

drop policy if exists "Crew admins can create invites" on public.crew_invites;
drop policy if exists "Crew admins can update invites" on public.crew_invites;

revoke all on table public.crew_invites from anon;
revoke all on table public.crew_invites from authenticated;
grant select (id, crew_id, created_by, expires_at, revoked_at, redeemed_at, created_at)
  on public.crew_invites to authenticated;

revoke all on table public.crew_invite_sessions from anon;
revoke all on table public.crew_invite_sessions from authenticated;
revoke all on table public.crew_invite_attributions from anon;
revoke all on table public.crew_invite_attributions from authenticated;

revoke execute on function public.crew_invite_secret_hash(text) from public;
revoke execute on function public.crew_invite_secret_hash(text) from anon;
revoke execute on function public.crew_invite_secret_hash(text) from authenticated;
revoke execute on function public.reject_crew_invite_attribution_mutation() from public;
revoke execute on function public.reject_crew_invite_attribution_mutation() from anon;
revoke execute on function public.reject_crew_invite_attribution_mutation() from authenticated;

revoke execute on function public.issue_crew_invite(uuid) from public;
revoke execute on function public.issue_crew_invite(uuid) from anon;
grant execute on function public.issue_crew_invite(uuid) to authenticated;

revoke execute on function public.revoke_crew_invite(uuid) from public;
revoke execute on function public.revoke_crew_invite(uuid) from anon;
grant execute on function public.revoke_crew_invite(uuid) to authenticated;

revoke execute on function public.preview_crew_invite(text, text) from public;
grant execute on function public.preview_crew_invite(text, text) to anon;
grant execute on function public.preview_crew_invite(text, text) to authenticated;

revoke execute on function public.confirm_crew_invite(text) from public;
revoke execute on function public.confirm_crew_invite(text) from anon;
grant execute on function public.confirm_crew_invite(text) to authenticated;

commit;

-- Grant the lifetime Sharing reward from bounded, auditable completion evidence.

create table if not exists public.sharing_reward_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  share_kind text not null check (share_kind in ('native_share', 'copy_link')),
  completion_token_hash bytea not null unique check (octet_length(completion_token_hash) = 32),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (completed_at is null or completed_at >= created_at)
);

create table if not exists public.sharing_reward_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  evidence_kind text not null check (
    evidence_kind in ('native_share', 'copy_link', 'confirmed_group_invite')
  ),
  intent_id uuid references public.sharing_reward_intents(id) on delete cascade,
  source_reference_hash bytea not null check (octet_length(source_reference_hash) = 32),
  recorded_at timestamptz not null default now(),
  unique (evidence_kind, source_reference_hash),
  check (
    (evidence_kind in ('native_share', 'copy_link') and intent_id is not null)
    or (evidence_kind = 'confirmed_group_invite' and intent_id is null)
  )
);

create table if not exists public.sharing_reward_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  evidence_id uuid not null unique references public.sharing_reward_evidence(id) on delete cascade,
  point_event_id uuid not null unique references public.game_point_events(id) on delete cascade,
  badge_key text not null default 'sharing' references public.badge_definitions(badge_key) on delete restrict,
  points integer not null default 14 check (points = 14),
  granted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists sharing_reward_intents_user_created_idx
  on public.sharing_reward_intents (user_id, created_at desc);

create index if not exists sharing_reward_intents_active_idx
  on public.sharing_reward_intents (user_id, expires_at)
  where completed_at is null;

create unique index if not exists sharing_reward_evidence_intent_unique
  on public.sharing_reward_evidence (intent_id)
  where intent_id is not null;

create index if not exists sharing_reward_evidence_user_recorded_idx
  on public.sharing_reward_evidence (user_id, recorded_at desc);

insert into public.badge_definitions (
  badge_key,
  name,
  description,
  category,
  tier,
  icon,
  sort_order
)
values (
  'sharing',
  'Share the Challenge',
  'Shared the challenge or brought another person into a private group.',
  'community',
  'bronze',
  'share',
  35
)
on conflict (badge_key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  tier = excluded.tier,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

create or replace function public.grant_sharing_reward_for_evidence(
  target_user_id uuid,
  target_evidence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  evidence_row public.sharing_reward_evidence%rowtype;
  existing_grant public.sharing_reward_grants%rowtype;
  points_inserted boolean := false;
  point_event_id uuid;
begin
  if target_user_id is null or target_evidence_id is null then
    raise exception 'Verified sharing evidence is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));

  select * into evidence_row
  from public.sharing_reward_evidence
  where id = target_evidence_id
    and user_id = target_user_id;

  if evidence_row.id is null then
    raise exception 'Verified sharing evidence is required.';
  end if;

  select * into existing_grant
  from public.sharing_reward_grants
  where user_id = target_user_id;

  if existing_grant.user_id is not null then
    return jsonb_build_object(
      'granted', false,
      'alreadyGranted', true,
      'points', existing_grant.points,
      'badgeKey', existing_grant.badge_key,
      'grantedAt', existing_grant.granted_at
    );
  end if;

  points_inserted := public.add_game_points(
    target_user_id,
    'sharing_bonus',
    14,
    null,
    null,
    null,
    jsonb_build_object(
      'reward', 'sharing',
      'evidenceKind', evidence_row.evidence_kind,
      'dailyCap', false
    ),
    'sharing_bonus:' || target_user_id::text
  );

  if not points_inserted then
    raise exception 'The Sharing reward ledger could not be written.';
  end if;

  select id into point_event_id
  from public.game_point_events
  where idempotency_key = 'sharing_bonus:' || target_user_id::text
    and user_id = target_user_id
    and event_type = 'sharing_bonus'
    and points = 14;

  if point_event_id is null then
    raise exception 'The Sharing reward ledger could not be verified.';
  end if;

  perform public.award_badge(
    target_user_id,
    'sharing',
    null,
    jsonb_build_object('source', evidence_row.evidence_kind)
  );

  if not exists (
    select 1
    from public.user_badges
    where user_id = target_user_id
      and badge_key = 'sharing'
  ) then
    raise exception 'The Sharing badge could not be awarded.';
  end if;

  insert into public.sharing_reward_grants (
    user_id,
    evidence_id,
    point_event_id,
    badge_key,
    points,
    metadata
  ) values (
    target_user_id,
    target_evidence_id,
    point_event_id,
    'sharing',
    14,
    jsonb_build_object('evidenceKind', evidence_row.evidence_kind)
  )
  returning * into existing_grant;

  return jsonb_build_object(
    'granted', true,
    'alreadyGranted', false,
    'points', existing_grant.points,
    'badgeKey', existing_grant.badge_key,
    'grantedAt', existing_grant.granted_at
  );
end;
$$;

create or replace function public.create_sharing_reward_intent(target_share_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_kind text := lower(btrim(coalesce(target_share_kind, '')));
  completion_token text;
  inserted_intent public.sharing_reward_intents%rowtype;
begin
  if current_user_id is null then
    raise exception 'You need to log in to share the challenge.';
  end if;

  if normalized_kind not in ('native_share', 'copy_link') then
    raise exception 'This share method cannot earn the Sharing reward.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sharing-intent:' || current_user_id::text, 0));

  if exists (
    select 1
    from public.sharing_reward_grants
    where user_id = current_user_id
  ) then
    return jsonb_build_object(
      'eligible', false,
      'alreadyGranted', true,
      'shareKind', normalized_kind
    );
  end if;

  if (
    select count(*)
    from public.sharing_reward_intents
    where user_id = current_user_id
      and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'Too many share attempts. Please try again later.';
  end if;

  if (
    select count(*)
    from public.sharing_reward_intents
    where user_id = current_user_id
      and completed_at is null
      and expires_at > now()
  ) >= 5 then
    raise exception 'Finish or wait for an earlier share attempt before starting another.';
  end if;

  completion_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.sharing_reward_intents (
    user_id,
    share_kind,
    completion_token_hash,
    expires_at
  ) values (
    current_user_id,
    normalized_kind,
    extensions.digest(completion_token, 'sha256'),
    now() + interval '15 minutes'
  )
  returning * into inserted_intent;

  return jsonb_build_object(
    'eligible', true,
    'alreadyGranted', false,
    'intentId', inserted_intent.id,
    'shareKind', inserted_intent.share_kind,
    'completionToken', completion_token,
    'expiresAt', inserted_intent.expires_at
  );
end;
$$;

create or replace function public.complete_sharing_reward(target_completion_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  intent_row public.sharing_reward_intents%rowtype;
  evidence_id uuid;
begin
  if current_user_id is null then
    raise exception 'You need to log in to complete a share.';
  end if;

  if coalesce(target_completion_token, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'This share confirmation is invalid or expired.';
  end if;

  select * into intent_row
  from public.sharing_reward_intents
  where user_id = current_user_id
    and completion_token_hash = extensions.digest(target_completion_token, 'sha256')
  for update;

  if intent_row.id is null then
    raise exception 'This share confirmation is invalid or expired.';
  end if;

  if intent_row.completed_at is null and intent_row.expires_at <= now() then
    raise exception 'This share confirmation is invalid or expired.';
  end if;

  if intent_row.completed_at is null then
    update public.sharing_reward_intents
    set completed_at = now()
    where id = intent_row.id;
  end if;

  insert into public.sharing_reward_evidence (
    user_id,
    evidence_kind,
    intent_id,
    source_reference_hash
  ) values (
    current_user_id,
    intent_row.share_kind,
    intent_row.id,
    extensions.digest('sharing_intent:' || intent_row.id::text, 'sha256')
  )
  on conflict (intent_id) where intent_id is not null do nothing
  returning id into evidence_id;

  if evidence_id is null then
    select id into evidence_id
    from public.sharing_reward_evidence
    where intent_id = intent_row.id
      and user_id = current_user_id;
  end if;

  if evidence_id is null then
    raise exception 'This share confirmation could not be verified.';
  end if;

  return public.grant_sharing_reward_for_evidence(current_user_id, evidence_id);
end;
$$;

create or replace function public.record_confirmed_group_invite_share(
  target_inviter_user_id uuid,
  target_redemption_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  evidence_id uuid;
  existing_user_id uuid;
  authoritative_inviter_user_id uuid;
  source_hash bytea;
begin
  if target_inviter_user_id is null or target_redemption_id is null then
    raise exception 'Confirmed invite attribution is required.';
  end if;

  if not exists (select 1 from auth.users where id = target_inviter_user_id) then
    raise exception 'Confirmed invite attribution is invalid.';
  end if;

  select attribution.inviter_user_id
    into authoritative_inviter_user_id
    from public.crew_invite_attributions attribution
    where attribution.id = target_redemption_id;

  if authoritative_inviter_user_id is null then
    raise exception 'Confirmed invite attribution is invalid.';
  end if;

  if authoritative_inviter_user_id <> target_inviter_user_id then
    raise exception 'Confirmed invite attribution does not match its original inviter.';
  end if;

  source_hash := extensions.digest('confirmed_group_invite:' || target_redemption_id::text, 'sha256');

  select user_id into existing_user_id
  from public.sharing_reward_evidence
  where evidence_kind = 'confirmed_group_invite'
    and source_reference_hash = source_hash;

  if existing_user_id is not null and existing_user_id <> target_inviter_user_id then
    raise exception 'Confirmed invite attribution does not match its original inviter.';
  end if;

  insert into public.sharing_reward_evidence (
    user_id,
    evidence_kind,
    source_reference_hash
  ) values (
    target_inviter_user_id,
    'confirmed_group_invite',
    source_hash
  )
  on conflict (evidence_kind, source_reference_hash) do nothing
  returning id into evidence_id;

  if evidence_id is null then
    select id, user_id into evidence_id, existing_user_id
    from public.sharing_reward_evidence
    where evidence_kind = 'confirmed_group_invite'
      and source_reference_hash = source_hash;

    if existing_user_id is distinct from target_inviter_user_id then
      raise exception 'Confirmed invite attribution does not match its original inviter.';
    end if;
  end if;

  if evidence_id is null then
    raise exception 'Confirmed invite attribution could not be recorded.';
  end if;

  return public.grant_sharing_reward_for_evidence(target_inviter_user_id, evidence_id);
end;
$$;

create or replace function public.record_confirmed_group_invite_share(
  target_redemption_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inviter_user_id uuid;
begin
  select attribution.inviter_user_id
    into inviter_user_id
    from public.crew_invite_attributions attribution
    where attribution.id = target_redemption_id;

  if inviter_user_id is null then
    raise exception 'Confirmed invite attribution is invalid.';
  end if;

  return public.record_confirmed_group_invite_share(inviter_user_id, target_redemption_id);
end;
$$;

create or replace function public.grant_sharing_reward_after_invite_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_confirmed_group_invite_share(new.inviter_user_id, new.id);
  return new;
end;
$$;

drop trigger if exists grant_sharing_reward_after_invite_redemption
  on public.crew_invite_attributions;
create trigger grant_sharing_reward_after_invite_redemption
  after insert on public.crew_invite_attributions
  for each row execute function public.grant_sharing_reward_after_invite_redemption();

alter table public.sharing_reward_intents enable row level security;
alter table public.sharing_reward_evidence enable row level security;
alter table public.sharing_reward_grants enable row level security;

create policy "Users can read own sharing reward grant"
  on public.sharing_reward_grants
  for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.sharing_reward_intents from public, anon, authenticated;
revoke all on public.sharing_reward_evidence from public, anon, authenticated;
revoke all on public.sharing_reward_grants from public, anon, authenticated;
grant select on public.sharing_reward_grants to authenticated;
grant select, insert, update, delete on public.sharing_reward_intents to service_role;
grant select, insert, update, delete on public.sharing_reward_evidence to service_role;
grant select, insert, update, delete on public.sharing_reward_grants to service_role;

revoke execute on function public.grant_sharing_reward_for_evidence(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.create_sharing_reward_intent(text) from public, anon;
grant execute on function public.create_sharing_reward_intent(text) to authenticated;
revoke execute on function public.complete_sharing_reward(text) from public, anon;
grant execute on function public.complete_sharing_reward(text) to authenticated;
revoke execute on function public.record_confirmed_group_invite_share(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_confirmed_group_invite_share(uuid, uuid) to service_role;
revoke execute on function public.record_confirmed_group_invite_share(uuid) from public, anon, authenticated;
grant execute on function public.record_confirmed_group_invite_share(uuid) to service_role;
revoke execute on function public.grant_sharing_reward_after_invite_redemption() from public, anon, authenticated, service_role;

-- Canonical Dominion Night reward additions are replayed after the combined
-- typed-catalog, invitation, sharing, and Community lifecycle definitions.
\ir migrations/20260720220000_dominion_night_theme_reward.sql
\ir migrations/20260720240000_user_theme_preferences.sql
