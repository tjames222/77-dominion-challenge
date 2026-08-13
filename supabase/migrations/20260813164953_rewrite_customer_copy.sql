-- FOU-1464: publish natural customer-facing language without changing stable
-- challenge, badge, reward, training, API, or analytics identifiers.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

update public.challenge_definitions as definition
set teaser = copy.teaser,
    updated_at = pg_catalog.statement_timestamp()
from (
  values
    ('seven_day_reset', 'A focused week to rebuild your habits and get moving again.'),
    ('forty_day_fast', 'Follow a guided pattern of fasting, prayer, and reflection.')
) as copy(challenge_key, teaser)
where definition.challenge_key = copy.challenge_key;

-- Keep the typed reward catalog in sync even if its statement trigger is not
-- present in an older prelaunch database snapshot.
update public.reward_definitions as reward
set description = definition.teaser,
    updated_at = pg_catalog.statement_timestamp()
from public.challenge_definitions as definition
where reward.reward_key = definition.challenge_key
  and reward.state_model = 'challenge_lifecycle';

update public.reward_definitions
set description = 'Earn a dark app theme, then select it from Profile.',
    updated_at = pg_catalog.statement_timestamp()
where reward_key = 'dominion_night_theme';

update public.badge_definitions as badge
set name = copy.name,
    description = copy.description
from (
  values
    ('faithful_start', 'Faithful Start', 'Posted your first check-in.'),
    ('honest_partial', 'Honest Check-In', 'Posted a partial check-in instead of skipping the day.'),
    ('first_sweat', 'Easy Workout', 'Completed a workout set to Easy.'),
    ('steady_grind', 'Medium Workout', 'Completed a workout set to Medium.'),
    ('iron_standard', 'Seven for Seven', 'Completed all seven daily actions in one day.'),
    ('hard_path', 'Hard Workout', 'Completed a workout set to Hard.'),
    ('extreme_fire', 'Extreme Workout', 'Completed a workout set to Extreme.'),
    ('seven_day_start', 'Seven Days Complete', 'Reached day 7 of the challenge.'),
    ('streak_flame', '3-Day Perfect Streak', 'Completed all seven daily actions for three days in a row.'),
    ('seven_sealed', '7-Day Perfect Streak', 'Completed all seven daily actions for seven days in a row.'),
    ('full_streak_14', '14-Day Perfect Streak', 'Completed all seven daily actions for fourteen days in a row.'),
    ('full_streak_21', '21-Day Perfect Streak', 'Completed all seven daily actions for twenty-one days in a row.'),
    ('full_streak_28', '28-Day Perfect Streak', 'Completed all seven daily actions for twenty-eight days in a row.'),
    ('full_streak_35', '35-Day Perfect Streak', 'Completed all seven daily actions for thirty-five days in a row.'),
    ('full_streak_42', '42-Day Perfect Streak', 'Completed all seven daily actions for forty-two days in a row.'),
    ('full_streak_49', '49-Day Perfect Streak', 'Completed all seven daily actions for forty-nine days in a row.'),
    ('full_streak_56', '56-Day Perfect Streak', 'Completed all seven daily actions for fifty-six days in a row.'),
    ('full_streak_63', '63-Day Perfect Streak', 'Completed all seven daily actions for sixty-three days in a row.'),
    ('full_streak_70', '70-Day Perfect Streak', 'Completed all seven daily actions for seventy days in a row.'),
    ('two_week_guard', 'Two Weeks Complete', 'Reached day 14 of the challenge.'),
    ('three_week_wall', 'Three Weeks Complete', 'Reached day 21 of the challenge.'),
    ('third_way', 'One-Third Complete', 'Reached one-third of the 77-day challenge.'),
    ('deep_roots', 'Day 33', 'Reached day 33 of the challenge.'),
    ('halfway_fire', 'Halfway', 'Reached the halfway point of the 77-day challenge.'),
    ('fifty_faithful', 'Day 50', 'Reached day 50 of the challenge.'),
    ('sixty_strong', 'Day 60', 'Reached day 60 of the challenge.'),
    ('final_watch', 'Final Week', 'Reached day 70 of the challenge.'),
    ('morning_watch', '3-Day App Streak', 'Opened the app three days in a row.'),
    ('watchman_week', '7-Day App Streak', 'Opened the app seven days in a row.'),
    ('day_77_finisher', '77 Days Complete', 'Finished day 77 of the challenge.')
) as copy(badge_key, name, description)
where badge.badge_key = copy.badge_key;

do $$
begin
  if not exists (
    select 1
    from private.site_training_program_versions
    where program_id = 'solo-first-run'
      and program_version = 2
  ) then
    raise exception 'Solo walkthrough version 2 is required before publishing the natural-language copy.';
  end if;
end;
$$;

update private.site_training_page_versions
set is_current = false,
    retired_at = pg_catalog.statement_timestamp()
where page_id in (
  'dashboard', 'bible-reading', 'morning-prayer', 'worship',
  'evening-prayer', 'workout-one', 'intentional-walk', 'workout-two',
  'badges-rewards', 'community', 'private-journal', 'profile', 'billing',
  'science'
)
  and is_current;

insert into private.site_training_page_versions (
  page_id,
  content_version,
  canonical_route,
  step_ids
)
values
  ('dashboard', 3, '/dashboard.html', array['orientation', 'global-navigation', 'sharing', 'app-streak', 'progress-gauges', 'daily-standards', 'check-in', 'levels-points', 'community-entry']::text[]),
  ('bible-reading', 2, '/bible-reading.html', array['orientation', 'completion', 'reading-guidance', 'youversion-resource']::text[]),
  ('morning-prayer', 2, '/morning-prayer.html', array['orientation', 'completion', 'prayer-guidance', 'guided-prayer-resource']::text[]),
  ('worship', 2, '/worship.html', array['orientation', 'completion', 'worship-guidance', 'spotify-resource']::text[]),
  ('evening-prayer', 2, '/evening-prayer.html', array['orientation', 'completion', 'reflection-guidance', 'guided-prayer-resource']::text[]),
  ('workout-one', 2, '/workout-one.html', array['orientation', 'completion', 'recommendation', 'difficulty', 'native-health']::text[]),
  ('intentional-walk', 2, '/intentional-walk.html', array['orientation', 'completion', 'walk-guidance', 'alarm-and-steps']::text[]),
  ('workout-two', 2, '/workout-two.html', array['orientation', 'completion', 'recommendation', 'difficulty', 'native-health']::text[]),
  ('badges-rewards', 2, '/badges-rewards.html', array['orientation', 'tabs', 'next-unlock', 'reward-catalog', 'badges', 'sharing']::text[]),
  ('community', 3, '/community.html', array['orientation', 'tabs', 'create-or-join', 'roles-and-roster', 'leaderboard', 'integrations', 'private-journal']::text[]),
  ('private-journal', 2, '/private-journal.html', array['orientation', 'navigation', 'entry', 'timeline']::text[]),
  ('profile', 3, '/profile.html', array['orientation', 'account', 'challenge-status', 'billing', 'themes']::text[]),
  ('billing', 2, '/billing.html', array['orientation', 'membership-access', 'billing-management', 'membership-includes']::text[]),
  ('science', 2, '/science.html', array['orientation', 'repetition', 'scripture', 'standards', 'sources', 'training-complete']::text[]);

update private.site_training_program_versions
set is_current = false,
    retired_at = pg_catalog.statement_timestamp()
where program_id = 'solo-first-run'
  and is_current;

insert into private.site_training_program_versions (
  program_id,
  program_version,
  audience
)
values ('solo-first-run', 3, 'solo');

insert into private.site_training_program_pages (
  program_id,
  program_version,
  page_id,
  page_content_version,
  page_index
)
values
  ('solo-first-run', 3, 'dashboard', 3, 0),
  ('solo-first-run', 3, 'bible-reading', 2, 1),
  ('solo-first-run', 3, 'morning-prayer', 2, 2),
  ('solo-first-run', 3, 'worship', 2, 3),
  ('solo-first-run', 3, 'evening-prayer', 2, 4),
  ('solo-first-run', 3, 'workout-one', 2, 5),
  ('solo-first-run', 3, 'intentional-walk', 2, 6),
  ('solo-first-run', 3, 'workout-two', 2, 7),
  ('solo-first-run', 3, 'badges-rewards', 2, 8),
  ('solo-first-run', 3, 'community', 3, 9),
  ('solo-first-run', 3, 'private-journal', 2, 10),
  ('solo-first-run', 3, 'profile', 3, 11),
  ('solo-first-run', 3, 'billing', 2, 12),
  ('solo-first-run', 3, 'science', 2, 13);

commit;
