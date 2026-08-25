begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(87);

create temporary table site_training_test_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on site_training_test_results to authenticated;

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
  ('d1000000-0000-4000-8000-000000000001'::uuid, 'training-main@example.test', 'Training Main'),
  ('d2000000-0000-4000-8000-000000000002'::uuid, 'training-removed@example.test', 'Training Removed'),
  ('d3000000-0000-4000-8000-000000000003'::uuid, 'training-shared@example.test', 'Training Shared'),
  ('d4000000-0000-4000-8000-000000000004'::uuid, 'training-completed@example.test', 'Training Completed'),
  ('d5000000-0000-4000-8000-000000000005'::uuid, 'training-restart@example.test', 'Training Restart')
) as fixture(id, email, name);

insert into private.site_training_page_versions (
  page_id, content_version, canonical_route, step_ids,
  is_current, published_at, retired_at
)
values
  (
    'alpha', 1, '/alpha-v1', array['intro', 'shared', 'removed'],
    false, pg_catalog.statement_timestamp() - interval '2 days',
    pg_catalog.statement_timestamp() - interval '1 day'
  ),
  ('alpha', 2, '/alpha', array['intro', 'shared', 'new'], true, default, null),
  ('beta', 1, '/beta', array['only'], true, default, null),
  ('gamma', 1, '/gamma', array['first', 'second', 'third'], true, default, null);

insert into private.site_training_program_versions (
  program_id, program_version, audience
)
values ('foundation-tour', 1, 'all');

insert into private.site_training_program_pages (
  program_id, program_version, page_id, page_content_version, page_index
)
values
  ('foundation-tour', 1, 'alpha', 2, 0),
  ('foundation-tour', 1, 'beta', 1, 1);

insert into private.site_training_page_progress (
  user_id, page_id, content_version, status, current_step_id,
  current_step_index, furthest_step_index, revision,
  started_at, stopped_at, completed_at, updated_at
)
values
  (
    'd2000000-0000-4000-8000-000000000002', 'alpha', 1,
    'in_progress', 'removed', 2, 2, 7,
    pg_catalog.statement_timestamp() - interval '2 hours', null, null,
    pg_catalog.statement_timestamp() - interval '1 hour'
  ),
  (
    'd3000000-0000-4000-8000-000000000003', 'alpha', 1,
    'in_progress', 'shared', 1, 2, 8,
    pg_catalog.statement_timestamp() - interval '2 hours', null, null,
    pg_catalog.statement_timestamp() - interval '1 hour'
  ),
  (
    'd4000000-0000-4000-8000-000000000004', 'alpha', 1,
    'completed', 'removed', 2, 2, 9,
    pg_catalog.statement_timestamp() - interval '3 hours', null,
    pg_catalog.statement_timestamp() - interval '2 hours',
    pg_catalog.statement_timestamp() - interval '2 hours'
  );

insert into private.site_training_page_completions (
  user_id, page_id, content_version, attempt_number, completed_step_id,
  completed_request_id, completed_at
)
values (
  'd4000000-0000-4000-8000-000000000004', 'alpha', 1, 1, 'removed',
  'd4100000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 hours'
);

-- 01-07: the private foundation exists and is RLS protected.
select ok(to_regclass('private.site_training_page_versions') is not null,
  'versioned page definitions exist');
select ok(to_regclass('private.site_training_program_versions') is not null,
  'versioned program definitions exist');
select ok(to_regclass('private.site_training_program_pages') is not null,
  'ordered program pages exist');
select ok(to_regclass('private.site_training_page_progress') is not null,
  'per-user page progress exists');
select ok(to_regclass('private.site_training_program_progress') is not null,
  'per-user overall progress exists');
select ok(to_regclass('private.site_training_page_completions') is not null,
  'immutable page completion history exists');
select ok(to_regclass('private.site_training_transition_requests') is not null,
  'idempotency evidence exists');

-- 08-12: RLS, least privilege, and immutable-history boundaries.
select ok(not exists (
  select 1
  from (values
    ('private.site_training_page_versions'::regclass),
    ('private.site_training_program_versions'::regclass),
    ('private.site_training_program_pages'::regclass),
    ('private.site_training_page_progress'::regclass),
    ('private.site_training_program_progress'::regclass),
    ('private.site_training_page_completions'::regclass),
    ('private.site_training_transition_requests'::regclass)
  ) as expected(relation_id)
  join pg_catalog.pg_class relation on relation.oid = expected.relation_id
  where not relation.relrowsecurity
), 'every site-training table has RLS enabled');
select ok(not has_table_privilege(
  'authenticated', 'private.site_training_page_progress', 'select'
) and not has_table_privilege(
  'authenticated', 'private.site_training_program_progress', 'insert'
) and not has_table_privilege(
  'authenticated', 'private.site_training_page_completions', 'update'
), 'authenticated clients have no direct private-table privileges');
select ok(has_table_privilege(
  'service_role', 'private.site_training_page_progress', 'select'
) and has_table_privilege(
  'service_role', 'private.site_training_page_completions', 'select'
), 'the service role can inspect progress and completion evidence');
select ok(not has_table_privilege(
  'service_role', 'private.site_training_page_completions', 'update'
) and not has_table_privilege(
  'service_role', 'private.site_training_page_completions', 'delete'
), 'completion history is append-only at the operational boundary');
select ok(private.site_training_valid_step_ids(array['one', 'two'])
  and not private.site_training_valid_step_ids(array['same', 'same'])
  and not private.site_training_valid_step_ids(array['Invalid']),
  'published step IDs are stable, unique, and normalized');

-- 13-20: public RPC exposure is actor-only and search-path hardened.
select ok(to_regprocedure(
  'public.get_site_training_state(text,integer,text,integer,uuid)'
) is not null, 'the read RPC has the expected actor-bound signature');
select ok(to_regprocedure(
  'public.claim_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)'
) is not null, 'the claim RPC has the expected request and revision signature');
select ok(to_regprocedure(
  'public.transition_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)'
) is not null, 'the transition RPC has the expected request and revision signature');
select ok(has_function_privilege(
  'authenticated',
  'public.get_site_training_state(text,integer,text,integer,uuid)',
  'execute'
) and has_function_privilege(
  'authenticated',
  'public.claim_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)',
  'execute'
) and has_function_privilege(
  'authenticated',
  'public.transition_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)',
  'execute'
) and not has_function_privilege(
  'authenticated',
  'private.restart_site_training_page(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)',
  'execute'
), 'authenticated callers can use only the public lifecycle boundary');
select ok(not has_function_privilege(
  'anon', 'public.get_site_training_state(text,integer,text,integer,uuid)', 'execute'
) and not has_function_privilege(
  'anon',
  'public.claim_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)',
  'execute'
) and not has_function_privilege(
  'anon',
  'public.transition_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)',
  'execute'
), 'anonymous callers cannot use site training');
select ok((select procedure.prosecdef
    and procedure.proconfig @> array['search_path=""']
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'public.get_site_training_state(text,integer,text,integer,uuid)'::regprocedure),
  'the read RPC is a hardened security-definer boundary');
select ok((select procedure.prosecdef
    and procedure.proconfig @> array['search_path=""']
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'public.claim_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)'::regprocedure),
  'the claim RPC is a hardened security-definer boundary');
select ok((select procedure.prosecdef
    and procedure.proconfig @> array['search_path=""']
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'public.transition_site_training(text,text,integer,text,integer,text,uuid,bigint,bigint,uuid)'::regprocedure),
  'the transition RPC is a hardened security-definer boundary');

set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';

-- 21: authentication is checked even when postgres invokes the definer RPC.
select throws_ok(
  $$select public.get_site_training_state('gamma', 1, null, null, null)$$,
  '28000',
  'You need to log in to view site training.',
  'site training reads require authentication'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into site_training_test_results (key, payload)
values (
  'unclaimed-page',
  public.get_site_training_state(
    'gamma', 1, null, null, 'd1000000-0000-4000-8000-000000000001'
  )
);

-- 22-27: unclaimed reads are deterministic, fail-closed, and side-effect free.
select is((select (payload ->> 'schemaVersion')::integer
    from site_training_test_results where key = 'unclaimed-page'), 1,
  'the state contract is versioned');
select is((select payload ->> 'actorId'
    from site_training_test_results where key = 'unclaimed-page'),
  'd1000000-0000-4000-8000-000000000001',
  'the state contract identifies its actor');
select ok((select payload #>> '{page,status}' = 'not_started'
      and payload ->> 'claimedNow' = 'false'
    from site_training_test_results where key = 'unclaimed-page'),
  'an unclaimed page reads as not started and not newly claimed');
select is((select (payload #>> '{page,revision}')::integer
    from site_training_test_results where key = 'unclaimed-page'), 0,
  'an unclaimed page has synthetic revision zero');
select is((select (payload #>> '{page,attemptNumber}')::integer
    from site_training_test_results where key = 'unclaimed-page'), 0,
  'an unclaimed page has synthetic attempt zero');
select is((select payload ->> 'overall'
    from site_training_test_results where key = 'unclaimed-page'), null,
  'a page-only read has no overall lifecycle');
select throws_ok(
  $$select public.get_site_training_state(
    'gamma', 1, null, null, 'd2000000-0000-4000-8000-000000000002'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'an expected-actor mismatch fails closed'
);

insert into site_training_test_results (key, payload)
values (
  'page-start',
  public.claim_site_training(
    'page', 'gamma', 1, null, null, 'start',
    'e1000000-0000-4000-8000-000000000001', 0, 0,
    'd1000000-0000-4000-8000-000000000001'
  )
);
insert into site_training_test_results (key, payload)
values (
  'page-start-replay',
  public.claim_site_training(
    'page', 'gamma', 1, null, null, 'start',
    'e1000000-0000-4000-8000-000000000001', 0, 0,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 28-33: Start is singular, idempotent, collision-safe, and revision checked.
select is((select payload #>> '{page,status}' from site_training_test_results
    where key = 'page-start'), 'in_progress',
  'Start creates authoritative page progress');
select is((select (payload #>> '{page,revision}')::integer
    from site_training_test_results where key = 'page-start'), 1,
  'Start advances the page revision once');
select is((select (payload #>> '{page,attemptNumber}')::integer
    from site_training_test_results where key = 'page-start'), 1,
  'Start begins the first durable page attempt');
select ok((select payload #>> '{transition,applied}' = 'true'
      and payload ->> 'claimedNow' = 'true'
    from site_training_test_results where key = 'page-start'),
  'the first applied Start reports that it was newly claimed');
select is((select payload from site_training_test_results where key = 'page-start-replay'),
  (select payload from site_training_test_results where key = 'page-start'),
  'an identical request UUID returns the exact stored result');
select throws_ok(
  $$select public.transition_site_training(
    'page', 'gamma', 1, null, null, 'next',
    'e1000000-0000-4000-8000-000000000001', 1, 1,
    'd1000000-0000-4000-8000-000000000001'
  )$$,
  '23505',
  'This request ID was already used for another operation.',
  'a request UUID cannot be reused for another operation'
);
select throws_ok(
  $$select public.claim_site_training(
    'page', 'gamma', 1, null, null, 'start',
    'e1000000-0000-4000-8000-000000000002', 0, 0,
    'd1000000-0000-4000-8000-000000000001'
  )$$,
  '40001',
  'Site training changed in another session. Refresh and try again.',
  'a stale page revision cannot overwrite progress'
);

insert into site_training_test_results (key, payload)
values (
  'page-next-one',
  public.transition_site_training(
    'page', 'gamma', 1, null, null, 'next',
    'e1000000-0000-4000-8000-000000000003', 1, 1,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'page-next-two',
  public.transition_site_training(
    'page', 'gamma', 1, null, null, 'next',
    'e1000000-0000-4000-8000-000000000004', 2, 2,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'page-back',
  public.transition_site_training(
    'page', 'gamma', 1, null, null, 'back',
    'e1000000-0000-4000-8000-000000000005', 3, 3,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 34-38: ordered movement persists Back without regressing furthest progress.
select ok((select payload #>> '{page,currentStepId}' = 'second'
      and payload ->> 'claimedNow' = 'false'
    from site_training_test_results where key = 'page-next-one'),
  'Next advances by one stable step ID without reporting a new claim');
select is((select (payload #>> '{page,currentStepIndex}')::integer
    from site_training_test_results where key = 'page-next-two'), 2,
  'a second Next reaches only the final step');
select is((select payload #>> '{page,currentStepId}' from site_training_test_results
    where key = 'page-back'), 'second',
  'Back durably restores the prior stable step');
select is((select (payload #>> '{page,furthestStepIndex}')::integer
    from site_training_test_results where key = 'page-back'), 2,
  'Back never regresses furthest progress');
select is((select (payload #>> '{page,revision}')::integer
    from site_training_test_results where key = 'page-back'), 4,
  'each applied movement advances the page revision');

insert into site_training_test_results (key, payload)
values (
  'page-stop',
  public.transition_site_training(
    'page', 'gamma', 1, null, null, 'stop',
    'e1000000-0000-4000-8000-000000000006', 4, 4,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'page-resume',
  public.claim_site_training(
    'page', 'gamma', 1, null, null, 'resume',
    'e1000000-0000-4000-8000-000000000007', 5, 5,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 39-43: Stop is durable, Resume preserves position, and Finish is bounded.
select is((select payload #>> '{page,status}' from site_training_test_results
    where key = 'page-stop'), 'stopped',
  'Stop persists the stopped lifecycle');
select ok((select payload #>> '{page,stoppedAt}' from site_training_test_results
    where key = 'page-stop') is not null,
  'Stop records its authoritative timestamp');
select is((select payload #>> '{page,status}' from site_training_test_results
    where key = 'page-resume'), 'in_progress',
  'Resume returns stopped progress to in progress');
select is((select payload #>> '{page,currentStepId}' from site_training_test_results
    where key = 'page-resume'), 'second',
  'Resume preserves the durable current step');
select throws_ok(
  $$select public.transition_site_training(
    'page', 'gamma', 1, null, null, 'finish',
    'e1000000-0000-4000-8000-000000000008', 6, 6,
    'd1000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'Reach the final page training step before finishing.',
  'Finish fails before the final step'
);

insert into site_training_test_results (key, payload)
values (
  'page-final-step',
  public.transition_site_training(
    'page', 'gamma', 1, null, null, 'next',
    'e1000000-0000-4000-8000-000000000009', 6, 6,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'page-finish',
  public.transition_site_training(
    'page', 'gamma', 1, null, null, 'finish',
    'e1000000-0000-4000-8000-000000000010', 7, 7,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 44-49: completion is terminal evidence and does not fabricate overall state.
select is((select payload #>> '{page,status}' from site_training_test_results
    where key = 'page-finish'), 'completed',
  'Finish completes the page lifecycle');
select is((select (payload #>> '{page,revision}')::integer
    from site_training_test_results where key = 'page-finish'), 8,
  'Finish advances the page revision exactly once');
select is((select payload #>> '{page,everCompleted}' from site_training_test_results
    where key = 'page-finish'), 'true',
  'the state contract reports immutable completion history');
reset role;
select is((select count(*)::integer from private.site_training_page_completions
    where user_id = 'd1000000-0000-4000-8000-000000000001'
      and page_id = 'gamma'), 1,
  'Finish appends one completion record');
select throws_ok(
  $$update private.site_training_page_completions
    set completed_step_id = 'tampered'
    where user_id = 'd1000000-0000-4000-8000-000000000001'
      and page_id = 'gamma'$$,
  '55000',
  'Site training completion history is immutable.',
  'persisted completion evidence rejects updates'
);
select is((select count(*)::integer from private.site_training_program_progress
    where user_id = 'd1000000-0000-4000-8000-000000000001'), 0,
  'direct page training never creates overall progress');

-- Version reconciliation fixtures are read under each matching account.
set local role authenticated;
set local "request.jwt.claim.sub" = 'd3000000-0000-4000-8000-000000000003';
insert into site_training_test_results (key, payload)
values ('reconcile-shared', public.get_site_training_state(
  'alpha', 2, null, null, 'd3000000-0000-4000-8000-000000000003'
));
set local "request.jwt.claim.sub" = 'd2000000-0000-4000-8000-000000000002';
insert into site_training_test_results (key, payload)
values ('reconcile-removed', public.get_site_training_state(
  'alpha', 2, null, null, 'd2000000-0000-4000-8000-000000000002'
));
set local "request.jwt.claim.sub" = 'd4000000-0000-4000-8000-000000000004';
insert into site_training_test_results (key, payload)
values ('reconcile-completed', public.get_site_training_state(
  'alpha', 2, null, null, 'd4000000-0000-4000-8000-000000000004'
));

-- 50-57: new content resumes only by stable ID and never erases history.
select is((select payload #>> '{page,status}' from site_training_test_results
    where key = 'reconcile-shared'), 'stopped',
  'unfinished old content reconciles to a resumable stopped state');
select is((select payload #>> '{page,currentStepId}' from site_training_test_results
    where key = 'reconcile-shared'), 'shared',
  'a surviving stable step ID is preserved across versions');
select is((select (payload #>> '{page,currentStepIndex}')::integer
    from site_training_test_results where key = 'reconcile-shared'), 1,
  'the preserved step uses its new-version index');
select is((select payload #>> '{page,currentStepId}' from site_training_test_results
    where key = 'reconcile-removed'), 'intro',
  'a removed stable step safely falls back to the first new step');
select is((select (payload #>> '{page,currentStepIndex}')::integer
    from site_training_test_results where key = 'reconcile-removed'), 0,
  'removed-step fallback uses index zero');
select is((select payload #>> '{page,status}' from site_training_test_results
    where key = 'reconcile-completed'), 'not_started',
  'a completed old version is not silently reopened');
select is((select payload #>> '{page,everCompleted}' from site_training_test_results
    where key = 'reconcile-completed'), 'true',
  'old-version completion remains visible on new content');
reset role;
select is((select count(*)::integer from private.site_training_page_progress
    where page_id = 'alpha' and content_version = 1), 3,
  'content reconciliation never deletes historical progress');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-4000-8000-000000000001';

insert into site_training_test_results (key, payload)
values (
  'program-page-start',
  public.claim_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'start',
    'f1000000-0000-4000-8000-000000000001', 0, 0,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'program-page-next',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'next',
    'f1000000-0000-4000-8000-000000000002', 1, 1,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 58-60: page scope remains isolated even when the program is requested.
select is((select payload #>> '{overall,status}' from site_training_test_results
    where key = 'program-page-next'), 'not_started',
  'page scope returns but does not claim synthetic overall state');
reset role;
select is((select count(*)::integer from private.site_training_program_progress
    where user_id = 'd1000000-0000-4000-8000-000000000001'), 0,
  'page-scope Next does not mutate overall progress');
select is((select revision::integer from private.site_training_page_progress
    where user_id = 'd1000000-0000-4000-8000-000000000001'
      and page_id = 'alpha' and content_version = 2), 2,
  'page-scope movement updates only page revision');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-4000-8000-000000000001';
insert into site_training_test_results (key, payload)
values (
  'overall-start',
  public.claim_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'start',
    'f1000000-0000-4000-8000-000000000003', 0, 2,
    'd1000000-0000-4000-8000-000000000001'
  )
);

select throws_ok(
  $$select public.transition_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'next',
    'f1000000-0000-4000-8000-000000000008', 1, 1,
    'd1000000-0000-4000-8000-000000000001'
  )$$,
  '40001',
  'Site training changed in another session. Refresh and try again.',
  'overall movement rejects a stale shared page revision'
);

insert into site_training_test_results (key, payload)
values (
  'overall-alpha-next',
  public.transition_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'next',
    'f1000000-0000-4000-8000-000000000004', 1, 2,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'overall-alpha-finish',
  public.transition_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'finish',
    'f1000000-0000-4000-8000-000000000005', 2, 3,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 61-66: overall scope owns both revisions and advances atomically to the next route.
select is((select payload #>> '{overall,status}' from site_training_test_results
    where key = 'overall-start'), 'in_progress',
  'overall Start claims the program');
select is((select (payload #>> '{overall,revision}')::integer
    from site_training_test_results where key = 'overall-start'), 1,
  'overall Start begins at revision one');
select is((select payload #>> '{page,pageId}' from site_training_test_results
    where key = 'overall-alpha-finish'), 'beta',
  'finishing a program page returns the next page state');
select is((select payload #>> '{transition,nextRoute}' from site_training_test_results
    where key = 'overall-alpha-finish'), '/beta',
  'the server returns the next canonical route');
select is((select (payload #>> '{overall,revision}')::integer
    from site_training_test_results where key = 'overall-alpha-finish'), 3,
  'ordered page completion advances overall revision');

insert into site_training_test_results (key, payload)
values (
  'overall-beta-start',
  public.claim_site_training(
    'overall', 'beta', 1, 'foundation-tour', 1, 'start',
    'f1000000-0000-4000-8000-000000000006', 3, 0,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'overall-beta-finish',
  public.transition_site_training(
    'overall', 'beta', 1, 'foundation-tour', 1, 'finish',
    'f1000000-0000-4000-8000-000000000007', 4, 1,
    'd1000000-0000-4000-8000-000000000001'
  )
), (
  'overall-start-late-replay',
  public.claim_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'start',
    'f1000000-0000-4000-8000-000000000003', 0, 2,
    'd1000000-0000-4000-8000-000000000001'
  )
);

-- 67-71: exact replay survives newer state and completion does not touch product state.
select is((select (payload #>> '{overall,revision}')::integer
    from site_training_test_results where key = 'overall-beta-start'), 4,
  'starting the newly current page advances overall revision');
select ok((select payload #>> '{overall,status}' = 'completed'
      and payload #>> '{overall,currentPageId}' = 'beta'
      and (payload #>> '{overall,currentPageIndex}')::integer = 1
    from site_training_test_results where key = 'overall-beta-finish'),
  'completion retains the final overall page cursor');
select is((select payload from site_training_test_results where key = 'overall-start-late-replay'),
  (select payload from site_training_test_results where key = 'overall-start'),
  'an exact replay returns its stored result before either stale revision check');
reset role;
select is((select count(*)::integer from private.site_training_page_completions
    where user_id = 'd1000000-0000-4000-8000-000000000001'), 3,
  'page-only and overall completions are retained independently');

insert into private.site_training_page_progress (
  user_id, page_id, content_version, status, current_step_id,
  current_step_index, furthest_step_index, attempt_number, revision,
  started_at, stopped_at, completed_at, updated_at
) values (
  'd5000000-0000-4000-8000-000000000005', 'beta', 1, 'stopped', 'only',
  0, 0, 4, 9,
  pg_catalog.statement_timestamp() - interval '3 hours',
  pg_catalog.statement_timestamp() - interval '2 hours', null,
  pg_catalog.statement_timestamp() - interval '2 hours'
);
insert into site_training_test_results (key, payload)
select 'restart-other-page-before', pg_catalog.to_jsonb(progress)
from private.site_training_page_progress progress
where progress.user_id = 'd5000000-0000-4000-8000-000000000005'
  and progress.page_id = 'beta' and progress.content_version = 1;

set local role authenticated;
set local "request.jwt.claim.sub" = 'd5000000-0000-4000-8000-000000000005';
set local "request.jwt.claims" =
  '{"sub":"d5000000-0000-4000-8000-000000000005","role":"authenticated"}';

select throws_ok(
  $$select public.transition_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'restart',
    'a5000000-0000-4000-8000-000000000001', 0, 0,
    'd5000000-0000-4000-8000-000000000005'
  )$$,
  '22023',
  'Restart is available only for current page training.',
  'Restart rejects overall scope before changing either lifecycle'
);
select throws_ok(
  $$select public.transition_site_training(
    'page', 'alpha', 1, null, null, 'restart',
    'a5000000-0000-4000-8000-000000000002', 0, 0,
    'd5000000-0000-4000-8000-000000000005'
  )$$,
  '22023',
  'A current published page training version is required.',
  'Restart rejects retired content versions'
);

insert into site_training_test_results (key, payload)
values (
  'restart-overall-start',
  public.claim_site_training(
    'overall', 'alpha', 2, 'foundation-tour', 1, 'start',
    'a5000000-0000-4000-8000-000000000003', 0, 0,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'restart-page-next',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'next',
    'a5000000-0000-4000-8000-000000000004', 1, 1,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'restart-page-stop',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'stop',
    'a5000000-0000-4000-8000-000000000005', 2, 2,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'page-restart',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'restart',
    'a5000000-0000-4000-8000-000000000006', 3, 3,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'restart-post-next',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'next',
    'a5000000-0000-4000-8000-000000000007', 4, 4,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'page-restart-late-replay',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'restart',
    'a5000000-0000-4000-8000-000000000006', 3, 3,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'restart-final-step',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'next',
    'a5000000-0000-4000-8000-000000000008', 5, 5,
    'd5000000-0000-4000-8000-000000000005'
  )
), (
  'restart-finish',
  public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'finish',
    'a5000000-0000-4000-8000-000000000009', 6, 6,
    'd5000000-0000-4000-8000-000000000005'
  )
);

select ok((select payload #>> '{page,status}' = 'in_progress'
      and (payload #>> '{page,currentStepIndex}')::integer = 0
      and (payload #>> '{page,furthestStepIndex}')::integer = 0
      and payload #>> '{page,currentStepId}' = 'intro'
    from site_training_test_results where key = 'page-restart'),
  'Restart resets only the unfinished page cursor to its first stable step');
select is((select (payload #>> '{page,attemptNumber}')::integer
    from site_training_test_results where key = 'page-restart'), 2,
  'Restart begins a fresh durable attempt');
select is((select (payload #>> '{page,revision}')::integer
    from site_training_test_results where key = 'page-restart'), 4,
  'Restart advances the page revision exactly once');
select ok((select payload #>> '{page,startedAt}' is not null
      and payload #>> '{page,startedAt}' is distinct from (
        select started.payload #>> '{page,startedAt}'
        from site_training_test_results started
        where started.key = 'restart-overall-start'
      )
      and payload #>> '{page,stoppedAt}' is null
      and payload #>> '{page,completedAt}' is null
      and (payload #>> '{page,completionCount}')::integer = 0
    from site_training_test_results where key = 'page-restart'),
  'Restart records a fresh attempt timestamp without fabricating completion history');
select ok((select payload #>> '{overall,status}' = 'in_progress'
      and (payload #>> '{overall,revision}')::integer = 1
    from site_training_test_results where key = 'page-restart'),
  'Restart returns but does not change the active overall lifecycle');
select is((select (payload #>> '{page,attemptNumber}')::integer
    from site_training_test_results where key = 'restart-post-next'), 2,
  'navigation after Restart stays on the fresh attempt');
select is((select payload from site_training_test_results where key = 'page-restart-late-replay'),
  (select payload from site_training_test_results where key = 'page-restart'),
  'an exact Restart replay returns its stored result after newer progress');
select throws_ok(
  $$select public.transition_site_training(
    'page', 'alpha', 2, 'foundation-tour', 1, 'restart',
    'a5000000-0000-4000-8000-000000000010', 7, 7,
    'd5000000-0000-4000-8000-000000000005'
  )$$,
  '55000',
  'Only unfinished page training can be restarted.',
  'completed current content replays locally instead of restarting durably'
);

reset role;
select is(private.site_training_overall_payload(
    'd5000000-0000-4000-8000-000000000005', 'foundation-tour', 1
  ),
  (select payload -> 'overall' from site_training_test_results
    where key = 'restart-overall-start'),
  'every page-only Restart flow leaves the complete overall row unchanged');
select is((select pg_catalog.to_jsonb(progress)
    from private.site_training_page_progress progress
    where progress.user_id = 'd5000000-0000-4000-8000-000000000005'
      and progress.page_id = 'beta' and progress.content_version = 1),
  (select payload from site_training_test_results where key = 'restart-other-page-before'),
  'Restart leaves every other page progress row unchanged');
select ok((select status = 'completed'
      and current_step_index = 2
      and attempt_number = 2
      and revision = 7
    from private.site_training_page_progress
    where user_id = 'd5000000-0000-4000-8000-000000000005'
      and page_id = 'alpha' and content_version = 2),
  'late idempotent replay never rewinds newer page progress');
select ok((select pg_catalog.count(*) = 1
      and pg_catalog.max(attempt_number) = 2
    from private.site_training_page_completions
    where user_id = 'd5000000-0000-4000-8000-000000000005'
      and page_id = 'alpha'),
  'completion evidence records only the completed restarted attempt');

select ok(not exists (
  select 1 from public.profiles profile
  where profile.user_id between
    'd1000000-0000-4000-8000-000000000001'::uuid and
    'd5000000-0000-4000-8000-000000000005'::uuid
) and not exists (
  select 1 from public.check_ins check_in
  where check_in.user_id between
    'd1000000-0000-4000-8000-000000000001'::uuid and
    'd5000000-0000-4000-8000-000000000005'::uuid
), 'training transitions never mutate profile or product progress');

select * from finish();
rollback;
