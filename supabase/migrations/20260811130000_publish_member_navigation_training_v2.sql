-- FOU-1455: publish the four-destination member navigation training contract.
--
-- Dashboard and Community copy/targets changed, so their immutable content
-- definitions advance to version 2. Private Journal becomes a first-class
-- version-1 page, and the Solo first-run program advances to the ordered
-- fourteen-page version 2 while retaining every version-1 history row.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $$
begin
  if not exists (
    select 1
    from private.site_training_page_versions
    where page_id = 'dashboard' and content_version = 1 and is_current
  ) or not exists (
    select 1
    from private.site_training_page_versions
    where page_id = 'community' and content_version = 1 and is_current
  ) or not exists (
    select 1
    from private.site_training_program_versions
    where program_id = 'solo-first-run' and program_version = 1 and is_current
  ) then
    raise exception 'The current Solo version-1 training catalog is required before publishing FOU-1455.';
  end if;
end;
$$;

update private.site_training_page_versions
set is_current = false,
    retired_at = pg_catalog.statement_timestamp()
where (page_id, content_version) in (('dashboard', 1), ('community', 1))
  and is_current;

insert into private.site_training_page_versions (
  page_id,
  content_version,
  canonical_route,
  step_ids
)
values
  (
    'dashboard',
    2,
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
    'community',
    2,
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
    'private-journal',
    1,
    '/private-journal.html',
    array[
      'orientation',
      'navigation',
      'entry',
      'timeline'
    ]::text[]
  );

update private.site_training_program_versions
set is_current = false,
    retired_at = pg_catalog.statement_timestamp()
where program_id = 'solo-first-run'
  and program_version = 1
  and is_current;

insert into private.site_training_program_versions (
  program_id,
  program_version,
  audience
)
values ('solo-first-run', 2, 'solo');

insert into private.site_training_program_pages (
  program_id,
  program_version,
  page_id,
  page_content_version,
  page_index
)
values
  ('solo-first-run', 2, 'dashboard', 2, 0),
  ('solo-first-run', 2, 'bible-reading', 1, 1),
  ('solo-first-run', 2, 'morning-prayer', 1, 2),
  ('solo-first-run', 2, 'worship', 1, 3),
  ('solo-first-run', 2, 'evening-prayer', 1, 4),
  ('solo-first-run', 2, 'workout-one', 1, 5),
  ('solo-first-run', 2, 'intentional-walk', 1, 6),
  ('solo-first-run', 2, 'workout-two', 1, 7),
  ('solo-first-run', 2, 'badges-rewards', 1, 8),
  ('solo-first-run', 2, 'community', 2, 9),
  ('solo-first-run', 2, 'private-journal', 1, 10),
  ('solo-first-run', 2, 'profile', 1, 11),
  ('solo-first-run', 2, 'billing', 1, 12),
  ('solo-first-run', 2, 'science', 1, 13);

commit;
