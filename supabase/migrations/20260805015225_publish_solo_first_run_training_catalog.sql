-- FOU-1442: publish the immutable Solo first-run training catalog.
--
-- Content copy, coachmark targets, capability requirements, and accessible
-- fallbacks remain in the version-matched client registry. The database owns
-- the stable page/step contracts and exact program order used for durable
-- progress. A future content change must publish a new content/program version
-- rather than modifying these version-1 rows.

insert into private.site_training_page_versions (
  page_id,
  content_version,
  canonical_route,
  step_ids
)
values
  (
    'dashboard',
    1,
    '/dashboard.html',
    array[
      'orientation',
      'global-navigation',
      'sharing',
      'app-streak',
      'progress-gauges',
      'daily-standards',
      'check-in',
      'levels-points',
      'community-entry'
    ]::text[]
  ),
  (
    'bible-reading',
    1,
    '/bible-reading.html',
    array[
      'orientation',
      'completion',
      'reading-guidance',
      'youversion-resource'
    ]::text[]
  ),
  (
    'morning-prayer',
    1,
    '/morning-prayer.html',
    array[
      'orientation',
      'completion',
      'prayer-guidance',
      'guided-prayer-resource'
    ]::text[]
  ),
  (
    'worship',
    1,
    '/worship.html',
    array[
      'orientation',
      'completion',
      'worship-guidance',
      'spotify-resource'
    ]::text[]
  ),
  (
    'evening-prayer',
    1,
    '/evening-prayer.html',
    array[
      'orientation',
      'completion',
      'reflection-guidance',
      'guided-prayer-resource'
    ]::text[]
  ),
  (
    'workout-one',
    1,
    '/workout-one.html',
    array[
      'orientation',
      'completion',
      'recommendation',
      'difficulty',
      'native-health'
    ]::text[]
  ),
  (
    'intentional-walk',
    1,
    '/intentional-walk.html',
    array[
      'orientation',
      'completion',
      'walk-guidance',
      'alarm-and-steps'
    ]::text[]
  ),
  (
    'workout-two',
    1,
    '/workout-two.html',
    array[
      'orientation',
      'completion',
      'recommendation',
      'difficulty',
      'native-health'
    ]::text[]
  ),
  (
    'badges-rewards',
    1,
    '/badges-rewards.html',
    array[
      'orientation',
      'tabs',
      'next-unlock',
      'reward-catalog',
      'badges',
      'sharing'
    ]::text[]
  ),
  (
    'community',
    1,
    '/community.html',
    array[
      'orientation',
      'tabs',
      'create-or-join',
      'roles-and-roster',
      'leaderboard',
      'integrations',
      'private-journal'
    ]::text[]
  ),
  (
    'profile',
    1,
    '/profile.html',
    array[
      'orientation',
      'account',
      'challenge-status',
      'integration-privacy',
      'billing',
      'themes'
    ]::text[]
  ),
  (
    'billing',
    1,
    '/billing.html',
    array[
      'orientation',
      'membership-access',
      'billing-management',
      'membership-includes'
    ]::text[]
  ),
  (
    'science',
    1,
    '/science.html',
    array[
      'orientation',
      'repetition',
      'scripture',
      'standards',
      'sources',
      'training-complete'
    ]::text[]
  );

insert into private.site_training_program_versions (
  program_id,
  program_version,
  audience
)
values ('solo-first-run', 1, 'solo');

insert into private.site_training_program_pages (
  program_id,
  program_version,
  page_id,
  page_content_version,
  page_index
)
values
  ('solo-first-run', 1, 'dashboard', 1, 0),
  ('solo-first-run', 1, 'bible-reading', 1, 1),
  ('solo-first-run', 1, 'morning-prayer', 1, 2),
  ('solo-first-run', 1, 'worship', 1, 3),
  ('solo-first-run', 1, 'evening-prayer', 1, 4),
  ('solo-first-run', 1, 'workout-one', 1, 5),
  ('solo-first-run', 1, 'intentional-walk', 1, 6),
  ('solo-first-run', 1, 'workout-two', 1, 7),
  ('solo-first-run', 1, 'badges-rewards', 1, 8),
  ('solo-first-run', 1, 'community', 1, 9),
  ('solo-first-run', 1, 'profile', 1, 10),
  ('solo-first-run', 1, 'billing', 1, 11),
  ('solo-first-run', 1, 'science', 1, 12);
