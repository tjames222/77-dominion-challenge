begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(48);

create temporary table crew_training_test_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on crew_training_test_results to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'training-owner@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Training Owner"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a2000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'training-admin@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Training Admin"}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, name, email, time_zone)
values
  ('a1000000-0000-4000-8000-000000000001', 'Training Owner', 'training-owner@example.test', 'UTC'),
  ('a2000000-0000-4000-8000-000000000002', 'Training Admin', 'training-admin@example.test', 'UTC');

insert into public.crews (id, name, description, created_by)
values (
  'aa000000-0000-4000-8000-000000000001',
  'Training Contract Crew',
  'Versioned creator walkthrough coverage',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
values
  (
    'aa000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Training Owner',
    'owner'
  ),
  (
    'aa000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002',
    'Training Admin',
    'admin'
  );

-- 01-08: private storage and direct-client boundaries.
select ok(to_regclass('private.crew_training_progress') is not null,
  'crew training progress has private storage');
select ok((select relrowsecurity from pg_class
  where oid = 'private.crew_training_progress'::regclass),
  'crew training progress has RLS enabled');
select ok(not has_table_privilege('authenticated', 'private.crew_training_progress', 'select'),
  'authenticated clients cannot read private progress directly');
select ok(not has_table_privilege('authenticated', 'private.crew_training_progress', 'insert'),
  'authenticated clients cannot insert private progress directly');
select ok(not has_table_privilege('authenticated', 'private.crew_training_progress', 'update'),
  'authenticated clients cannot update private progress directly');
select ok(not has_table_privilege('authenticated', 'private.crew_training_progress', 'delete'),
  'authenticated clients cannot delete private progress directly');
select ok(has_table_privilege('service_role', 'private.crew_training_progress', 'select'),
  'the service role can inspect private progress operationally');
select ok(exists (
  select 1
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'private.crew_training_progress'::regclass
    and constraint_row.contype = 'f'
    and constraint_row.confrelid = 'public.crew_members'::regclass
    and constraint_row.confdeltype = 'c'
), 'progress cascades with the exact crew membership');

-- 09-18: RPC exposure, definer hardening, and published-version boundary.
select ok(has_function_privilege('authenticated',
  'public.get_crew_training_progress(uuid,integer)', 'execute'),
  'authenticated creators can read training progress');
select ok(has_function_privilege('authenticated',
  'public.claim_crew_training(uuid,integer)', 'execute'),
  'authenticated creators can claim training');
select ok(has_function_privilege('authenticated',
  'public.advance_crew_training(uuid,integer,text,integer)', 'execute'),
  'authenticated creators can advance training');
select ok(not has_function_privilege('anon',
  'public.get_crew_training_progress(uuid,integer)', 'execute'),
  'anonymous callers cannot read training progress');
select ok(not has_function_privilege('anon',
  'public.claim_crew_training(uuid,integer)', 'execute'),
  'anonymous callers cannot claim training');
select ok(not has_function_privilege('anon',
  'public.advance_crew_training(uuid,integer,text,integer)', 'execute'),
  'anonymous callers cannot advance training');
select ok((select procedure_row.prosecdef
    and procedure_row.proconfig @> array['search_path=""']
  from pg_proc procedure_row
  where procedure_row.oid =
    'public.get_crew_training_progress(uuid,integer)'::regprocedure),
  'the read RPC is a hardened security-definer boundary');
select ok((select procedure_row.prosecdef
    and procedure_row.proconfig @> array['search_path=""']
  from pg_proc procedure_row
  where procedure_row.oid =
    'public.claim_crew_training(uuid,integer)'::regprocedure),
  'the claim RPC is a hardened security-definer boundary');
select ok((select procedure_row.prosecdef
    and procedure_row.proconfig @> array['search_path=""']
  from pg_proc procedure_row
  where procedure_row.oid =
    'public.advance_crew_training(uuid,integer,text,integer)'::regprocedure),
  'the mutation RPC is a hardened security-definer boundary');
select ok(exists (
  select 1
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'private.crew_training_progress'::regclass
    and constraint_row.contype = 'c'
    and pg_get_constraintdef(constraint_row.oid) like '%content_version = 1%'
), 'only the explicitly published training content version is accepted');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into crew_training_test_results (key, payload)
values (
  'read-before-claim',
  public.get_crew_training_progress('aa000000-0000-4000-8000-000000000001', 1)
);

-- 19-22: reading an unseen version is deterministic and has no write side effect.
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'read-before-claim'), 'not_started',
  'unclaimed progress reads as not started');
select is((select (payload ->> 'contentVersion')::integer from crew_training_test_results
    where key = 'read-before-claim'), 1,
  'the read payload names its content version');
select is((select (payload ->> 'stepCount')::integer from crew_training_test_results
    where key = 'read-before-claim'), 7,
  'the published syllabus reports seven steps');
reset role;
select is((select count(*)::integer from private.crew_training_progress), 0,
  'reading training progress never claims or creates a row');

-- 23: admin authority alone is insufficient; the caller must be the creator.
set local role authenticated;
set local "request.jwt.claim.sub" = 'a2000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.get_crew_training_progress(
    'aa000000-0000-4000-8000-000000000001', 1
  )$$,
  '42501',
  'Crew training is available only to the active crew creator.',
  'a noncreator admin cannot access creator training'
);

set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
insert into crew_training_test_results (key, payload)
values (
  'first-claim',
  public.claim_crew_training('aa000000-0000-4000-8000-000000000001', 1)
);

-- 24-26: the first claim is singular and persisted.
select is((select payload ->> 'claimedNow' from crew_training_test_results
    where key = 'first-claim'), 'true',
  'the first successful claim reports claimedNow');
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'first-claim'), 'in_progress',
  'the first claim starts training');
reset role;
select is((select count(*)::integer from private.crew_training_progress), 1,
  'the first claim persists exactly one progress row');

insert into crew_training_test_results (key, payload)
values (
  'claim-sentinel',
  jsonb_build_object('startedAt', now() - interval '1 hour')
);
update private.crew_training_progress
set created_at = now() - interval '2 hours',
    started_at = (select (payload ->> 'startedAt')::timestamptz
      from crew_training_test_results where key = 'claim-sentinel'),
    updated_at = now() - interval '1 hour';

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
insert into crew_training_test_results (key, payload)
values (
  'claim-retry',
  public.claim_crew_training('aa000000-0000-4000-8000-000000000001', 1)
);

-- 27-28: a retry never reclaims or rewrites the original start.
select is((select payload ->> 'claimedNow' from crew_training_test_results
    where key = 'claim-retry'), 'false',
  'a repeated claim reports that it did not claim again');
select is((select payload ->> 'startedAt' from crew_training_test_results
    where key = 'claim-retry'),
  (select payload ->> 'startedAt' from crew_training_test_results
    where key = 'claim-sentinel'),
  'a repeated claim preserves the original start time');

-- 29-30: unknown versions and out-of-order movement fail closed.
select throws_ok(
  $$select public.get_crew_training_progress(
    'aa000000-0000-4000-8000-000000000001', 2
  )$$,
  '22023',
  'A valid crew and training version are required.',
  'an unpublished training version is rejected'
);
select throws_ok(
  $$select public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'advance', 2
  )$$,
  '22023',
  'Crew training steps must be completed in order.',
  'the server rejects a leap over an unseen step'
);

insert into crew_training_test_results (key, payload)
values (
  'advance-one',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'advance', 1
  )
);

-- 31-32: ordered progress updates both authoritative step fields.
select is((select (payload ->> 'currentStep')::integer from crew_training_test_results
    where key = 'advance-one'), 1,
  'advancing updates the current step');
select is((select (payload ->> 'furthestStep')::integer from crew_training_test_results
    where key = 'advance-one'), 1,
  'advancing updates the furthest step monotonically');

reset role;
insert into crew_training_test_results (key, payload)
values (
  'advance-sentinel',
  jsonb_build_object('updatedAt', now() - interval '30 minutes')
);
update private.crew_training_progress
set updated_at = (select (payload ->> 'updatedAt')::timestamptz
  from crew_training_test_results where key = 'advance-sentinel');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
insert into crew_training_test_results (key, payload)
values (
  'advance-retry',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'advance', 1
  )
);

-- 33-35: retries and delayed lower-step skips cannot regress live progress.
select is((select payload ->> 'updatedAt' from crew_training_test_results
    where key = 'advance-retry'),
  (select payload ->> 'updatedAt' from crew_training_test_results
    where key = 'advance-sentinel'),
  'an advance retry preserves the authoritative update time');
insert into crew_training_test_results (key, payload)
values (
  'stale-skip',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'skip', 0
  )
);
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'stale-skip'), 'in_progress',
  'a delayed lower-step skip cannot regress active progress');
insert into crew_training_test_results (key, payload)
values (
  'current-skip',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'skip', 1
  )
);
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'current-skip'), 'skipped',
  'skipping the authoritative current step persists a resumable state');

reset role;
insert into crew_training_test_results (key, payload)
values (
  'skip-sentinel',
  jsonb_build_object(
    'skippedAt', now() - interval '20 minutes',
    'updatedAt', now() - interval '20 minutes'
  )
);
update private.crew_training_progress
set skipped_at = (select (payload ->> 'skippedAt')::timestamptz
      from crew_training_test_results where key = 'skip-sentinel'),
    updated_at = (select (payload ->> 'updatedAt')::timestamptz
      from crew_training_test_results where key = 'skip-sentinel');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
insert into crew_training_test_results (key, payload)
values (
  'skip-retry',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'skip', 1
  )
);

-- 36-39: skipped progress is idempotent, gated, resumable, and not complete.
select is((select payload ->> 'skippedAt' from crew_training_test_results
    where key = 'skip-retry'),
  (select payload ->> 'skippedAt' from crew_training_test_results
    where key = 'skip-sentinel'),
  'a skip retry preserves its original timestamp');
select throws_ok(
  $$select public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'advance', 2
  )$$,
  '55000',
  'Resume crew training before advancing.',
  'skipped training must be resumed before it advances'
);
insert into crew_training_test_results (key, payload)
values (
  'resume',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'resume', 1
  )
);
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'resume'), 'in_progress',
  'skipped training resumes at authoritative progress');
select throws_ok(
  $$select public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'complete', 6
  )$$,
  '55000',
  'Finish the final crew training step before completing it.',
  'completion is rejected before all seven steps are reached'
);

-- 40-41: every remaining step can advance only in order.
select lives_ok(
  $$do $block$
  begin
    perform public.advance_crew_training(
      'aa000000-0000-4000-8000-000000000001', 1, 'advance', 2
    );
    perform public.advance_crew_training(
      'aa000000-0000-4000-8000-000000000001', 1, 'advance', 3
    );
    perform public.advance_crew_training(
      'aa000000-0000-4000-8000-000000000001', 1, 'advance', 4
    );
    perform public.advance_crew_training(
      'aa000000-0000-4000-8000-000000000001', 1, 'advance', 5
    );
    perform public.advance_crew_training(
      'aa000000-0000-4000-8000-000000000001', 1, 'advance', 6
    );
  end;
  $block$
  $$,
  'the remaining walkthrough steps advance in order'
);
reset role;
select is((select jsonb_build_array(current_step, furthest_step)::text
    from private.crew_training_progress), '[6, 6]',
  'the final lesson is authoritative in both step fields');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
insert into crew_training_test_results (key, payload)
values (
  'complete',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'complete', 6
  )
);

-- 42: completion is explicit after the final lesson.
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'complete'), 'completed',
  'the final explicit finish marks training complete');

reset role;
insert into crew_training_test_results (key, payload)
values (
  'complete-sentinel',
  jsonb_build_object(
    'completedAt', now() - interval '10 minutes',
    'updatedAt', now() - interval '10 minutes'
  )
);
update private.crew_training_progress
set completed_at = (select (payload ->> 'completedAt')::timestamptz
      from crew_training_test_results where key = 'complete-sentinel'),
    updated_at = (select (payload ->> 'updatedAt')::timestamptz
      from crew_training_test_results where key = 'complete-sentinel');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
insert into crew_training_test_results (key, payload)
values (
  'stale-skip-after-complete',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'skip', 5
  )
), (
  'complete-retry',
  public.advance_crew_training(
    'aa000000-0000-4000-8000-000000000001', 1, 'complete', 6
  )
);

-- 43-45: completed is terminal for stale tabs and retries.
select is((select payload ->> 'status' from crew_training_test_results
    where key = 'stale-skip-after-complete'), 'completed',
  'a stale skip cannot undo completion');
select is((select payload ->> 'completedAt' from crew_training_test_results
    where key = 'stale-skip-after-complete'),
  (select payload ->> 'completedAt' from crew_training_test_results
    where key = 'complete-sentinel'),
  'a stale action preserves the completion timestamp');
select is((select payload ->> 'updatedAt' from crew_training_test_results
    where key = 'complete-retry'),
  (select payload ->> 'updatedAt' from crew_training_test_results
    where key = 'complete-sentinel'),
  'a completion retry preserves the authoritative update timestamp');

-- 46: a creator who is no longer owner/admin loses access immediately.
reset role;
update public.crew_members
set role = 'member'
where crew_id = 'aa000000-0000-4000-8000-000000000001'
  and user_id = 'a1000000-0000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_training_progress(
    'aa000000-0000-4000-8000-000000000001', 1
  )$$,
  '42501',
  'Crew training is available only to the active crew creator.',
  'a creator without an owner or admin role cannot access training'
);

-- 47-48: membership retirement removes progress and blocks stale access.
reset role;
delete from public.crew_members
where crew_id = 'aa000000-0000-4000-8000-000000000001'
  and user_id = 'a1000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from private.crew_training_progress), 0,
  'membership deletion cascades all creator training progress');
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_training_progress(
    'aa000000-0000-4000-8000-000000000001', 1
  )$$,
  '42501',
  'Crew training is available only to the active crew creator.',
  'a stale tab cannot read training after membership removal'
);

reset role;
select * from finish();
rollback;
