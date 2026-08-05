begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

create temporary table group_start_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert on group_start_results to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'fa000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'group-start@example.test', 'fixture', now(),
    '{"provider":"email"}', '{"name":"Group Starter"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fa000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'group-rollback@example.test', 'fixture', now(),
    '{"provider":"email"}', '{"name":"Rollback Starter"}', now(), now()
  );

insert into public.profiles (user_id, name, email, time_zone)
values
  ('fa000000-0000-4000-8000-000000000001', 'Group Starter', 'group-start@example.test', 'UTC'),
  ('fa000000-0000-4000-8000-000000000002', 'Rollback Starter', 'group-rollback@example.test', 'UTC');

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
values
  ('fa000000-0000-4000-8000-000000000001', 'membership_active', 'active', 'test', 'group-start', now(), now() + interval '1 day'),
  ('fa000000-0000-4000-8000-000000000002', 'membership_active', 'active', 'test', 'group-rollback', now(), now() + interval '1 day');

select ok(
  has_function_privilege(
    'authenticated',
    'public.create_crew_and_activate_group(uuid,uuid,text,text,date,text,uuid)',
    'execute'
  ) and not has_function_privilege(
    'anon',
    'public.create_crew_and_activate_group(uuid,uuid,text,text,date,text,uuid)',
    'execute'
  ),
  'only authenticated clients can invoke the combined Group-start RPC'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc
   where oid = 'public.create_crew_and_activate_group(uuid,uuid,text,text,date,text,uuid)'::regprocedure),
  'the combined Group-start RPC is a pinned security-definer boundary'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'fa000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated","email":"group-start@example.test"}';

select throws_ok(
  $$select public.create_crew_and_activate_group(
    'fb000000-0000-4000-8000-000000000001',
    'fc000000-0000-4000-8000-000000000001',
    'Wrong Actor Crew', '', current_date, 'UTC',
    'fa000000-0000-4000-8000-000000000002'
  )$$,
  '40001',
  'The signed-in account changed. Refresh and try again.',
  'the combined boundary rejects a stale captured actor before creation'
);

insert into group_start_results (key, payload)
values (
  'created',
  public.create_crew_and_activate_group(
    'fb000000-0000-4000-8000-000000000001',
    'fc000000-0000-4000-8000-000000000001',
    'Atomic Group Start',
    'FOU-1443 coverage',
    current_date,
    'UTC',
    'fa000000-0000-4000-8000-000000000001'
  )
);

select ok(
  (select payload -> 'activation' @> '{"status":"active","mode":"group","groupMembershipActive":true}'::jsonb
     and payload -> 'crew' ->> 'createdNew' = 'true'
   from group_start_results where key = 'created'),
  'one explicit request creates the crew and returns an active Group contract'
);

select is(
  (select count(*)::integer from public.crews
   where created_by = 'fa000000-0000-4000-8000-000000000001'),
  1,
  'the combined request creates exactly one crew'
);

select ok(
  (select count(*) = 1 and bool_and(role = 'owner')
   from public.crew_members
   where user_id = 'fa000000-0000-4000-8000-000000000001'),
  'the creator receives exactly one owner membership before activation'
);

select ok(
  (select challenge_participation_mode = 'group'
      and challenge_group_attribution_crew_id =
        (select id from public.crews where created_by = 'fa000000-0000-4000-8000-000000000001')
      and challenge_start_date = current_date
   from public.profiles
   where user_id = 'fa000000-0000-4000-8000-000000000001'),
  'activation inherits the persisted crew date and attribution'
);

reset role;

select is(
  (select count(*)::integer from private.crew_lifecycle_requests
   where actor_id = 'fa000000-0000-4000-8000-000000000001'),
  1,
  'creation leaves one private lifecycle request'
);

select is(
  (select count(*)::integer from private.challenge_activation_requests
   where actor_id = 'fa000000-0000-4000-8000-000000000001'
     and action = 'group_activate'),
  1,
  'activation leaves one private retry record'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'fa000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated","email":"group-start@example.test"}';

insert into group_start_results (key, payload)
values (
  'replay',
  public.create_crew_and_activate_group(
    'fb000000-0000-4000-8000-000000000001',
    'fc000000-0000-4000-8000-000000000001',
    'Atomic Group Start',
    'FOU-1443 coverage',
    current_date,
    'UTC',
    'fa000000-0000-4000-8000-000000000001'
  )
);

select ok(
  (select payload -> 'crew' ->> 'createdNew' = 'false'
      and (payload -> 'activation' ->> 'revision')::integer = 1
   from group_start_results where key = 'replay'),
  'a matching replay returns the same activation without another transition'
);

select is(
  (select count(*)::integer from public.crew_members
   where user_id = 'fa000000-0000-4000-8000-000000000001'),
  1,
  'a matching replay still leaves one membership'
);

select throws_ok(
  $$select public.create_crew_and_activate_group(
    'fb000000-0000-4000-8000-000000000001',
    'fc000000-0000-4000-8000-000000000001',
    'Changed Name', 'FOU-1443 coverage', current_date, 'UTC',
    'fa000000-0000-4000-8000-000000000001'
  )$$,
  '23505',
  'This request ID was already used for another operation.',
  'a crew request ID cannot be reused with changed inputs'
);

set local "request.jwt.claim.sub" = 'fa000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"fa000000-0000-4000-8000-000000000002","role":"authenticated","email":"group-rollback@example.test"}';

select throws_ok(
  $$select public.create_crew_and_activate_group(
    'fb000000-0000-4000-8000-000000000002',
    'fc000000-0000-4000-8000-000000000002',
    'Rollback Group', '', current_date - 77, 'UTC',
    'fa000000-0000-4000-8000-000000000002'
  )$$,
  '22023',
  'The crew start date is outside the current 77-day challenge window.',
  'an invalid Group activation aborts the combined request'
);

reset role;

select is(
  (select count(*)::integer from public.crews
   where created_by = 'fa000000-0000-4000-8000-000000000002'),
  0,
  'activation failure rolls back the crew'
);

select ok(
  not exists (
    select 1 from public.crew_members
    where user_id = 'fa000000-0000-4000-8000-000000000002'
  ) and not exists (
    select 1 from private.crew_lifecycle_requests
    where actor_id = 'fa000000-0000-4000-8000-000000000002'
  ) and not exists (
    select 1 from private.challenge_activation_requests
    where actor_id = 'fa000000-0000-4000-8000-000000000002'
  ),
  'activation failure leaves no membership or request evidence'
);

select ok(
  not exists (
    select 1
    from public.profiles profile
    where profile.challenge_participation_mode = 'group'
      and profile.user_id in (
        'fa000000-0000-4000-8000-000000000001',
        'fa000000-0000-4000-8000-000000000002'
      )
      and not exists (
        select 1 from public.crew_members member_row
        where member_row.user_id = profile.user_id
          and member_row.crew_id = profile.challenge_group_attribution_crew_id
      )
  ),
  'the combined flow never leaves a live Group activation without membership'
);

select * from finish();
rollback;
