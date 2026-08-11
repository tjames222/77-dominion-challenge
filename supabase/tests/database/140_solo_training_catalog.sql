begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(52);

create temporary table solo_training_test_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on solo_training_test_results to authenticated;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
select
  '00000000-0000-0000-0000-000000000000',
  fixture.id,
  'authenticated',
  'authenticated',
  fixture.email,
  'fixture',
  pg_catalog.statement_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  pg_catalog.jsonb_build_object('name', fixture.name),
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
from (values
  ('f1000000-0000-4000-8000-000000000001'::uuid,
    'solo-training-main@example.test', 'Solo Training Main'),
  ('f2000000-0000-4000-8000-000000000002'::uuid,
    'solo-training-isolated@example.test', 'Solo Training Isolated')
) as fixture(id, email, name);

-- The production program contract is singular, current, Solo-only,
-- complete, and ordered exactly as the reviewed first-run experience.
select is((
  select pg_catalog.count(*)::integer
  from private.site_training_program_versions program
  where program.program_id = 'solo-first-run'
    and program.program_version = 2
), 1, 'the Solo first-run program has one immutable version-2 definition');

select is((
  select program.audience
  from private.site_training_program_versions program
  where program.program_id = 'solo-first-run'
    and program.program_version = 2
), 'solo', 'the first-run program is restricted to the Solo audience');

select ok((
  select program.is_current and program.retired_at is null
  from private.site_training_program_versions program
  where program.program_id = 'solo-first-run'
    and program.program_version = 2
), 'the Solo first-run program is the current published version');

select ok((
  select not program.is_current and program.retired_at is not null
  from private.site_training_program_versions program
  where program.program_id = 'solo-first-run'
    and program.program_version = 1
), 'the immutable version-1 program remains retained and retired');

select is((
  select pg_catalog.count(*)::integer
  from private.site_training_program_pages page
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
), 14, 'the Solo first-run program publishes all fourteen reviewed pages');

select is((
  select pg_catalog.string_agg(page.page_id, ',' order by page.page_index)
  from private.site_training_program_pages page
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
),
  'dashboard,bible-reading,morning-prayer,worship,evening-prayer,workout-one,intentional-walk,workout-two,badges-rewards,community,private-journal,profile,billing,science',
  'the program page IDs match the exact reviewed order');

select is((
  select pg_catalog.string_agg(definition.canonical_route, ',' order by page.page_index)
  from private.site_training_program_pages page
  join private.site_training_page_versions definition
    on definition.page_id = page.page_id
   and definition.content_version = page.page_content_version
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
),
  '/dashboard.html,/bible-reading.html,/morning-prayer.html,/worship.html,/evening-prayer.html,/workout-one.html,/intentional-walk.html,/workout-two.html,/badges-rewards.html,/community.html,/private-journal.html,/profile.html,/billing.html,/science.html',
  'the program routes match the exact reviewed order');

select is((
  select pg_catalog.array_agg(page.page_index order by page.page_index)
  from private.site_training_program_pages page
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
), array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  'the program has contiguous zero-based page indexes');

select ok(not exists (
  select 1
  from private.site_training_program_pages page
  join private.site_training_page_versions definition
    on definition.page_id = page.page_id
   and definition.content_version = page.page_content_version
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
    and (
      not definition.is_current
      or (page.page_id in ('dashboard', 'community') and page.page_content_version <> 2)
      or (page.page_id not in ('dashboard', 'community') and page.page_content_version <> 1)
    )
), 'every program page pins its current immutable content version');

select is((
  select pg_catalog.count(*)::integer
  from private.site_training_page_versions definition
  where definition.page_id in (
    'dashboard', 'bible-reading', 'morning-prayer', 'worship',
    'evening-prayer', 'workout-one', 'intentional-walk', 'workout-two',
    'badges-rewards', 'community', 'private-journal', 'profile', 'billing', 'science'
  ) and definition.is_current
), 14, 'all fourteen current page definitions were published');

select ok(not exists (
  select 1
  from private.site_training_page_versions definition
  where definition.page_id in ('dashboard', 'community')
    and definition.content_version = 1
    and (definition.is_current or definition.retired_at is null)
), 'the immutable Dashboard and Community version-1 definitions remain retained and retired');

select ok(
  (
    select pg_catalog.string_agg(
      page.page_id || ':' || page.page_content_version::text,
      ',' order by page.page_index
    )
    from private.site_training_program_pages page
    where page.program_id = 'solo-first-run'
      and page.program_version = 1
  ) = 'dashboard:1,bible-reading:1,morning-prayer:1,worship:1,evening-prayer:1,workout-one:1,intentional-walk:1,workout-two:1,badges-rewards:1,community:1,profile:1,billing:1,science:1'
  and (
    select definition.step_ids
    from private.site_training_page_versions definition
    where definition.page_id = 'dashboard' and definition.content_version = 1
  ) = array[
    'orientation', 'global-navigation', 'sharing', 'app-streak',
    'progress-gauges', 'daily-standards', 'check-in', 'levels-points',
    'community-entry'
  ]::text[]
  and (
    select definition.step_ids
    from private.site_training_page_versions definition
    where definition.page_id = 'community' and definition.content_version = 1
  ) = array[
    'orientation', 'tabs', 'create-or-join', 'roles-and-roster',
    'leaderboard', 'integrations', 'private-journal'
  ]::text[],
  'the retired version-1 program order and changed page contracts remain immutable'
);

select ok(not exists (
  select 1
  from private.site_training_program_pages page
  join private.site_training_page_versions definition
    on definition.page_id = page.page_id
   and definition.content_version = page.page_content_version
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
    and definition.step_ids[1] <> 'orientation'
), 'every page starts with an untargeted orientation step contract');

-- Each page publishes the exact stable step IDs mirrored by the client
-- content registry. These assertions are the schema-drift tripwire.
select is((select step_ids from private.site_training_page_versions
  where page_id = 'dashboard' and content_version = 2),
  array['orientation', 'global-navigation', 'sharing', 'app-streak',
    'progress-gauges', 'daily-standards', 'check-in', 'levels-points',
    'community-entry']::text[], 'Dashboard step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'bible-reading' and content_version = 1),
  array['orientation', 'completion', 'reading-guidance',
    'youversion-resource']::text[], 'Bible Reading step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'morning-prayer' and content_version = 1),
  array['orientation', 'completion', 'prayer-guidance',
    'guided-prayer-resource']::text[], 'Morning Prayer step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'worship' and content_version = 1),
  array['orientation', 'completion', 'worship-guidance',
    'spotify-resource']::text[], 'Worship step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'evening-prayer' and content_version = 1),
  array['orientation', 'completion', 'reflection-guidance',
    'guided-prayer-resource']::text[], 'Evening Prayer step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'workout-one' and content_version = 1),
  array['orientation', 'completion', 'recommendation', 'difficulty',
    'native-health']::text[], 'Workout #1 step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'intentional-walk' and content_version = 1),
  array['orientation', 'completion', 'walk-guidance',
    'alarm-and-steps']::text[], 'Intentional Walk step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'workout-two' and content_version = 1),
  array['orientation', 'completion', 'recommendation', 'difficulty',
    'native-health']::text[], 'Workout #2 step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'badges-rewards' and content_version = 1),
  array['orientation', 'tabs', 'next-unlock', 'reward-catalog', 'badges',
    'sharing']::text[], 'Badges & Rewards step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'community' and content_version = 2),
  array['orientation', 'tabs', 'create-or-join', 'roles-and-roster',
    'leaderboard', 'integrations', 'private-journal']::text[],
  'Community step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'private-journal' and content_version = 1),
  array['orientation', 'navigation', 'entry', 'timeline']::text[],
  'Private Journal step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'profile' and content_version = 1),
  array['orientation', 'account', 'challenge-status', 'integration-privacy',
    'billing', 'themes']::text[], 'Profile step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'billing' and content_version = 1),
  array['orientation', 'membership-access', 'billing-management',
    'membership-includes']::text[], 'Billing step IDs match the reviewed contract');
select is((select step_ids from private.site_training_page_versions
  where page_id = 'science' and content_version = 1),
  array['orientation', 'repetition', 'scripture', 'standards', 'sources',
    'training-complete']::text[], 'Science step IDs match the reviewed contract');

-- Definitions stay behind the authenticated RPC boundary, completion
-- uniqueness is structural, and the first read is side-effect free.
select ok(not has_table_privilege(
  'authenticated', 'private.site_training_page_versions', 'select'
) and not has_table_privilege(
  'authenticated', 'private.site_training_page_versions', 'update'
) and not has_table_privilege(
  'authenticated', 'private.site_training_program_pages', 'insert'
), 'authenticated clients cannot read or mutate the private catalog directly');

select ok(exists (
  select 1
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'private.site_training_page_completions'::regclass
    and constraint_row.contype = 'u'
    and pg_catalog.pg_get_constraintdef(constraint_row.oid)
      = 'UNIQUE (user_id, page_id, content_version, attempt_number)'
), 'one user attempt can create only one page-completion record');

set local role authenticated;
set local "request.jwt.claim.sub" = 'f1000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into solo_training_test_results (key, payload)
values ('unclaimed', public.get_site_training_state(
  'dashboard', 2, 'solo-first-run', 2,
  'f1000000-0000-4000-8000-000000000001'
));

select ok((select payload #>> '{page,status}' = 'not_started'
    and payload #>> '{overall,status}' = 'not_started'
    and payload #>> '{page,currentStepId}' = 'orientation'
  from solo_training_test_results where key = 'unclaimed'),
  'an untouched Solo catalog starts at Dashboard orientation without claiming progress');

select throws_ok(
  $$select public.get_site_training_state(
    'dashboard', 2, 'solo-first-run', 2,
    'f2000000-0000-4000-8000-000000000002'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'the catalog read fails closed when the expected account changes'
);

-- Start has exact replay semantics, CAS rejects stale tabs, and Stop /
-- Resume preserve the durable Dashboard position.
insert into solo_training_test_results (key, payload)
values
  ('start', public.claim_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'start',
    'f1100000-0000-4000-8000-000000000001', 0, 0,
    'f1000000-0000-4000-8000-000000000001'
  )),
  ('start-replay', public.claim_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'start',
    'f1100000-0000-4000-8000-000000000001', 0, 0,
    'f1000000-0000-4000-8000-000000000001'
  ));

select ok((select payload #>> '{overall,status}' = 'in_progress'
    and payload #>> '{overall,currentPageId}' = 'dashboard'
    and payload #>> '{page,currentStepId}' = 'orientation'
  from solo_training_test_results where key = 'start'),
  'overall Start claims the Solo program at Dashboard orientation');
select is((select payload from solo_training_test_results where key = 'start-replay'),
  (select payload from solo_training_test_results where key = 'start'),
  'an identical Start request returns the exact stored response');

select throws_ok(
  $$select public.transition_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'stop',
    'f1100000-0000-4000-8000-000000000002', 0, 0,
    'f1000000-0000-4000-8000-000000000001'
  )$$,
  '40001',
  'Site training changed in another session. Refresh and try again.',
  'a stale Solo-program revision cannot overwrite the claimed state'
);

insert into solo_training_test_results (key, payload)
values
  ('stop', public.transition_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'stop',
    'f1100000-0000-4000-8000-000000000003', 1, 1,
    'f1000000-0000-4000-8000-000000000001'
  )),
  ('resume', public.claim_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'resume',
    'f1100000-0000-4000-8000-000000000004', 2, 2,
    'f1000000-0000-4000-8000-000000000001'
  ));

select ok((select payload #>> '{overall,status}' = 'stopped'
    and payload #>> '{page,status}' = 'stopped'
    and payload #>> '{page,currentStepId}' = 'orientation'
  from solo_training_test_results where key = 'stop'),
  'Stop durably pauses both Solo program and Dashboard at orientation');
select ok((select payload #>> '{overall,status}' = 'in_progress'
    and payload #>> '{page,status}' = 'in_progress'
    and payload #>> '{page,currentStepId}' = 'orientation'
  from solo_training_test_results where key = 'resume'),
  'Resume restores both scopes at the saved orientation step');
select is((select (payload #>> '{overall,revision}')::integer
    from solo_training_test_results where key = 'resume'), 3,
  'Start, Stop, and Resume each advance the overall revision once');
select is((select (payload #>> '{page,revision}')::integer
    from solo_training_test_results where key = 'resume'), 3,
  'Start, Stop, and Resume each advance the page revision once');

-- Move through the remaining Dashboard steps using the public lifecycle. The
-- generated UUIDs remain stable v4-shaped request IDs for deterministic tests.
do $$
declare
  step_number integer;
begin
  for step_number in 1..8 loop
    perform public.transition_site_training(
      'overall',
      'dashboard',
      2,
      'solo-first-run',
      2,
      'next',
      pg_catalog.format(
        'f1200000-0000-4000-8000-%s',
        pg_catalog.lpad(step_number::text, 12, '0')
      )::uuid,
      2 + step_number,
      2 + step_number,
      'f1000000-0000-4000-8000-000000000001'
    );
  end loop;
end;
$$;

insert into solo_training_test_results (key, payload)
values ('dashboard-final-step', public.get_site_training_state(
  'dashboard', 2, 'solo-first-run', 2,
  'f1000000-0000-4000-8000-000000000001'
));

-- Ordered movement reaches exactly the reviewed final Dashboard step;
-- Finish appends one immutable completion and advances to Bible Reading.
select ok((select payload #>> '{page,currentStepId}' = 'community-entry'
    and (payload #>> '{page,currentStepIndex}')::integer = 8
    and (payload #>> '{page,revision}')::integer = 11
  from solo_training_test_results where key = 'dashboard-final-step'),
  'ordered Next transitions reach only the final Dashboard step');

insert into solo_training_test_results (key, payload)
values
  ('finish', public.transition_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'finish',
    'f1300000-0000-4000-8000-000000000001', 11, 11,
    'f1000000-0000-4000-8000-000000000001'
  )),
  ('finish-replay', public.transition_site_training(
    'overall', 'dashboard', 2, 'solo-first-run', 2, 'finish',
    'f1300000-0000-4000-8000-000000000001', 11, 11,
    'f1000000-0000-4000-8000-000000000001'
  ));

select is((select payload #>> '{transition,nextRoute}'
    from solo_training_test_results where key = 'finish'),
  '/bible-reading.html', 'Dashboard completion returns the next canonical route');
select ok((select payload #>> '{overall,currentPageId}' = 'bible-reading'
    and (payload #>> '{overall,currentPageIndex}')::integer = 1
    and payload #>> '{page,currentStepId}' = 'orientation'
  from solo_training_test_results where key = 'finish'),
  'the overall cursor advances atomically to Bible Reading orientation');
select is((select payload from solo_training_test_results where key = 'finish-replay'),
  (select payload from solo_training_test_results where key = 'finish'),
  'a delayed Finish replay returns the exact original response');

reset role;
select is((
  select pg_catalog.count(*)::integer
  from private.site_training_page_completions completion
  where completion.user_id = 'f1000000-0000-4000-8000-000000000001'
    and completion.page_id = 'dashboard'
    and completion.content_version = 2
), 1, 'Finish and its replay retain exactly one Dashboard completion');
select is((
  select pg_catalog.count(*)::integer
  from private.site_training_transition_requests request
  where request.actor_id = 'f1000000-0000-4000-8000-000000000001'
    and request.request_id = 'f1300000-0000-4000-8000-000000000001'
), 1, 'Finish and its replay retain exactly one request-evidence row');
select ok((
  select completion.completed_step_id = 'community-entry'
    and completion.attempt_number = 1
  from private.site_training_page_completions completion
  where completion.user_id = 'f1000000-0000-4000-8000-000000000001'
    and completion.page_id = 'dashboard'
    and completion.content_version = 2
), 'the immutable completion records the final stable step and first attempt');

-- Another actor sees a clean state, account deletion cascades only that
-- actor's training rows, and training never writes product progress.
set local role authenticated;
set local "request.jwt.claim.sub" = 'f2000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" =
  '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated"}';

insert into solo_training_test_results (key, payload)
values ('isolated-unclaimed', public.get_site_training_state(
  'dashboard', 2, 'solo-first-run', 2,
  'f2000000-0000-4000-8000-000000000002'
));

select ok((select payload #>> '{page,status}' = 'not_started'
    and payload #>> '{overall,status}' = 'not_started'
    and (payload #>> '{page,completionCount}')::integer = 0
  from solo_training_test_results where key = 'isolated-unclaimed'),
  'another account cannot observe the first account progress or completion');

insert into solo_training_test_results (key, payload)
values ('isolated-start', public.claim_site_training(
  'page', 'dashboard', 2, null, null, 'start',
  'f2100000-0000-4000-8000-000000000001', 0, 0,
  'f2000000-0000-4000-8000-000000000002'
));

select is((select payload #>> '{page,status}'
    from solo_training_test_results where key = 'isolated-start'),
  'in_progress', 'the isolated account owns its own page progress');

reset role;
select is((
  select pg_catalog.count(*)::integer
  from private.site_training_page_progress progress
  where progress.page_id = 'dashboard'
    and progress.content_version = 2
    and progress.user_id in (
      'f1000000-0000-4000-8000-000000000001',
      'f2000000-0000-4000-8000-000000000002'
    )
), 2, 'the two actors retain distinct Dashboard progress rows');

delete from auth.users auth_user
where auth_user.id = 'f2000000-0000-4000-8000-000000000002';

select ok(not exists (
  select 1 from private.site_training_page_progress progress
  where progress.user_id = 'f2000000-0000-4000-8000-000000000002'
) and not exists (
  select 1 from private.site_training_program_progress progress
  where progress.user_id = 'f2000000-0000-4000-8000-000000000002'
) and not exists (
  select 1 from private.site_training_page_completions completion
  where completion.user_id = 'f2000000-0000-4000-8000-000000000002'
) and not exists (
  select 1 from private.site_training_transition_requests request
  where request.actor_id = 'f2000000-0000-4000-8000-000000000002'
), 'account deletion cascades all durable training state for that actor');

select is((
  select pg_catalog.count(*)::integer
  from private.site_training_page_completions completion
  where completion.user_id = 'f1000000-0000-4000-8000-000000000001'
), 1, 'deleting another account does not remove the retained actor completion');

select ok(not exists (
  select 1 from public.challenge_entries entry
  where entry.user_id in (
    'f1000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000002'
  )
) and not exists (
  select 1 from public.check_ins check_in
  where check_in.user_id in (
    'f1000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000002'
  )
) and not exists (
  select 1 from public.game_point_events point_event
  where point_event.user_id in (
    'f1000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000002'
  )
), 'Solo training never mutates challenge, check-in, or point product state');

select ok(not exists (
  select 1
  from private.site_training_program_pages page
  left join private.site_training_page_versions definition
    on definition.page_id = page.page_id
   and definition.content_version = page.page_content_version
  where page.program_id = 'solo-first-run'
    and page.program_version = 2
    and definition.page_id is null
), 'the published program has no dangling or drifted page-version references');

select * from finish();
rollback;
