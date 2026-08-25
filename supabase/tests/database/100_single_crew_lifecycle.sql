begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(36);

create temporary table lifecycle_test_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on lifecycle_test_results to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '81000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'lifecycle-owner@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Lifecycle Owner"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '82000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'lifecycle-member@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Lifecycle Member"}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, name, email, time_zone)
values
  ('81000000-0000-4000-8000-000000000001', 'Lifecycle Owner', 'lifecycle-owner@example.test', 'UTC'),
  ('82000000-0000-4000-8000-000000000002', 'Lifecycle Member', 'lifecycle-member@example.test', 'UTC');

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
values
  ('81000000-0000-4000-8000-000000000001', 'membership_active', 'active', 'test', 'lifecycle-owner', now(), now() + interval '1 day'),
  ('82000000-0000-4000-8000-000000000002', 'membership_active', 'active', 'test', 'lifecycle-member', now(), now() + interval '1 day');

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'crew_members'
      and indexname = 'crew_members_one_crew_per_user_idx'
      and indexdef like 'CREATE UNIQUE INDEX%'
  ),
  'the database has one authoritative membership per user'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'private.crew_lifecycle_requests'::regclass),
  'the private lifecycle audit has RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'private.crew_lifecycle_requests', 'select'),
  'clients cannot read private lifecycle audit evidence'
);
select ok(
  has_function_privilege('authenticated', 'public.create_crew(uuid,text,text,date)', 'execute'),
  'authenticated users can execute the create RPC'
);
select ok(
  not has_function_privilege('anon', 'public.create_crew(uuid,text,text,date)', 'execute'),
  'anonymous users cannot execute the create RPC'
);
select ok(
  (select proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.create_crew(uuid,text,text,date)'::regprocedure),
  'create RPC pins an empty search path'
);
select ok(
  not has_table_privilege('authenticated', 'public.crews', 'insert'),
  'clients cannot bypass creation with a direct crew insert'
);
select ok(
  not has_table_privilege('authenticated', 'public.crew_members', 'insert'),
  'clients cannot bypass lifecycle RPCs with a direct membership insert'
);
select ok(
  position(
    'retired-community-deletion'
    in pg_get_functiondef('public.delete_crew(uuid,uuid)'::regprocedure)
  ) < position(
    'single-crew:'
    in pg_get_functiondef('public.delete_crew(uuid,uuid)'::regprocedure)
  ),
  'delete takes the retention advisory lock before account and crew locks'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '81000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated","email":"lifecycle-owner@example.test"}';

insert into lifecycle_test_results (key, payload)
select 'create', to_jsonb(created)
from public.create_crew(
  '81100000-0000-4000-8000-000000000001',
  'Lifecycle Crew',
  'Database lifecycle coverage',
  '2026-07-23'
) created;

select is(
  (select payload ->> 'created_new' from lifecycle_test_results where key = 'create'),
  'true',
  'first create request creates the crew'
);

insert into lifecycle_test_results (key, payload)
select 'create-replay', to_jsonb(created)
from public.create_crew(
  '81100000-0000-4000-8000-000000000001',
  'Lifecycle Crew',
  'Database lifecycle coverage',
  '2026-07-23'
) created;

select is(
  (select payload ->> 'created_new' from lifecycle_test_results where key = 'create-replay'),
  'false',
  'retrying the same create request is idempotent'
);

reset role;
select is(
  (select count(*)::integer from public.crews
   where id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')),
  1,
  'create retry leaves exactly one crew'
);
select is(
  (select count(*)::integer from public.crew_members
   where user_id = '81000000-0000-4000-8000-000000000001'),
  1,
  'create retry leaves exactly one owner membership'
);
select is(
  (select count(*)::integer from private.crew_lifecycle_requests
   where request_id = '81100000-0000-4000-8000-000000000001'),
  1,
  'create retry leaves one auditable request'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '81000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select * from public.create_crew(
    '81200000-0000-4000-8000-000000000002', 'Second Crew', '', null
  )$$,
  '23505',
  'Leave or delete your current crew before creating another.',
  'a second crew is rejected by the authoritative RPC'
);

insert into lifecycle_test_results (key, payload)
select 'invite-preview', public.preview_crew_invite('seed-bravo-invite', null);
insert into lifecycle_test_results (key, payload)
select 'invite-conflict', public.confirm_crew_invite(
  (select payload ->> 'continuationToken' from lifecycle_test_results where key = 'invite-preview')
);
select is(
  (select payload ->> 'status' from lifecycle_test_results where key = 'invite-conflict'),
  'current_crew_conflict',
  'invite confirmation refuses to add an account with another crew'
);

reset role;
select is(
  (select count(*)::integer from public.crew_members
   where crew_id = 'b0000000-0000-4000-8000-000000000002'
     and user_id = '81000000-0000-4000-8000-000000000001'),
  0,
  'a crew conflict creates no target membership'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
select (payload ->> 'crew_id')::uuid,
       '82000000-0000-4000-8000-000000000002',
       'Lifecycle Member',
       'member'
from lifecycle_test_results where key = 'create';

set local role authenticated;
set local "request.jwt.claim.sub" = '82000000-0000-4000-8000-000000000002';
insert into lifecycle_test_results (key, payload)
select 'leave', public.leave_crew(
  (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create'),
  '82100000-0000-4000-8000-000000000001'
);
insert into lifecycle_test_results (key, payload)
select 'leave-replay', public.leave_crew(
  (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create'),
  '82100000-0000-4000-8000-000000000001'
);
select is(
  (select payload ->> 'status' from lifecycle_test_results where key = 'leave'),
  'left',
  'a non-admin member can leave'
);
select is(
  (select payload::text from lifecycle_test_results where key = 'leave-replay'),
  (select payload::text from lifecycle_test_results where key = 'leave'),
  'leave retries return the original result'
);

reset role;
select is(
  (select count(*)::integer from public.crew_members
   where user_id = '82000000-0000-4000-8000-000000000002'),
  0,
  'leave removes only the caller membership'
);
select is(
  (select count(*)::integer from public.profiles
   where user_id = '82000000-0000-4000-8000-000000000002'),
  1,
  'leave preserves the member profile'
);
select is(
  (select count(*)::integer from private.crew_lifecycle_requests
   where request_id = '82100000-0000-4000-8000-000000000001'),
  1,
  'leave writes one private audit record'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
select (payload ->> 'crew_id')::uuid,
       '82000000-0000-4000-8000-000000000002',
       'Lifecycle Member',
       'member'
from lifecycle_test_results where key = 'create';

insert into public.crew_invites (
  crew_id, token_hash, token_hint, created_by, expires_at
)
select (payload ->> 'crew_id')::uuid,
       public.crew_invite_secret_hash('lifecycle-delete-invite-12345'),
       '12345',
       '81000000-0000-4000-8000-000000000001',
       now() + interval '1 day'
from lifecycle_test_results where key = 'create';

insert into private.integration_destinations (
  id, crew_id, provider, provider_workspace_id, provider_destination_id,
  display_name, credential_ciphertext, credential_nonce,
  credential_key_version, credential_fingerprint, status, installed_by
)
select '83100000-0000-4000-8000-000000000001',
       (payload ->> 'crew_id')::uuid,
       'slack', 'workspace-lifecycle', 'channel-lifecycle', 'Lifecycle Channel',
       decode(repeat('ab', 17), 'hex'), decode(repeat('cd', 12), 'hex'),
       1, repeat('e', 64), 'active',
       '81000000-0000-4000-8000-000000000001'
from lifecycle_test_results where key = 'create';

select public.enqueue_outbound_delivery(
  (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create'),
  '83100000-0000-4000-8000-000000000001',
  'synthetic.delivery',
  'lifecycle-delete-delivery',
  '{"text":"Lifecycle delete coverage"}'::jsonb
);

set local role authenticated;
set local "request.jwt.claim.sub" = '81000000-0000-4000-8000-000000000001';
insert into lifecycle_test_results (key, payload)
select 'delete', public.delete_crew(
  (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create'),
  '84100000-0000-4000-8000-000000000001'
);
insert into lifecycle_test_results (key, payload)
select 'delete-replay', public.delete_crew(
  (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create'),
  '84100000-0000-4000-8000-000000000001'
);
select is(
  (select payload ->> 'status' from lifecycle_test_results where key = 'delete'),
  'deleted',
  'an owner can delete the crew'
);
select is(
  (select payload::text from lifecycle_test_results where key = 'delete-replay'),
  (select payload::text from lifecycle_test_results where key = 'delete'),
  'delete retries return the original retained-deletion result'
);

reset role;
select ok(
  (select deleted_at is not null from public.crews
   where id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')),
  'delete immediately marks the retained crew inaccessible'
);
select is(
  (select deleted_by from public.crews
   where id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')),
  '81000000-0000-4000-8000-000000000001'::uuid,
  'delete records the authenticated actor'
);
select is(
  (select count(*)::integer from public.crew_members
   where crew_id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')),
  0,
  'delete removes access for every member'
);
select ok(
  (select bool_and(revoked_at is not null) from public.crew_invites
   where crew_id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')),
  'delete revokes outstanding invitations'
);
select is(
  (select status from private.outbound_deliveries
   where destination_id = '83100000-0000-4000-8000-000000000001'),
  'cancelled',
  'delete cancels queued external delivery'
);
select is(
  (select status from private.integration_destinations
   where id = '83100000-0000-4000-8000-000000000001'),
  'revoked',
  'delete disables the external destination'
);
select ok(
  (select credential_ciphertext is not null and credential_nonce is not null
   from private.integration_destinations
   where id = '83100000-0000-4000-8000-000000000001'),
  'FOU-559 credential evidence remains for worker revocation'
);
select is(
  (select count(*)::integer
   from private.retired_community_deletion_batches batch_row
   where batch_row.reason = 'group_deletion'
     and batch_row.crew_id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')
     and batch_row.sealed),
  1,
  'delete starts exactly one sealed FOU-559 retained-deletion batch'
);
select is(
  (select count(*)::integer from public.crews
   where id = (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')),
  1,
  'the crew remains retained instead of being hard-deleted'
);
select is(
  (select count(*)::integer from public.profiles
   where user_id in (
     '81000000-0000-4000-8000-000000000001',
     '82000000-0000-4000-8000-000000000002'
   )),
  2,
  'crew deletion preserves every personal profile'
);
select is(
  (select count(*)::integer from private.crew_lifecycle_requests
   where request_id = '84100000-0000-4000-8000-000000000001'),
  1,
  'delete writes one private audit record'
);
select ok(
  not public.is_crew_member(
    (select (payload ->> 'crew_id')::uuid from lifecycle_test_results where key = 'create')
  ),
  'deleted crews are inaccessible through the membership helper'
);

select * from finish();
rollback;
