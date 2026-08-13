begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

select ok(exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20260813163428'
), 'the account lifecycle request migration was replayed');

select ok(to_regclass('public.account_lifecycle_requests') is not null,
  'the account lifecycle request ledger exists');
select ok((select relrowsecurity from pg_class
  where oid = 'public.account_lifecycle_requests'::regclass),
  'account lifecycle request RLS is enabled');
select ok((select relforcerowsecurity from pg_class
  where oid = 'public.account_lifecycle_requests'::regclass),
  'account lifecycle request RLS is forced');
select ok(has_table_privilege('authenticated',
  'public.account_lifecycle_requests', 'select'),
  'authenticated members can select through RLS');
select ok(not has_table_privilege('authenticated',
  'public.account_lifecycle_requests', 'update'),
  'members cannot change request outcomes');
select ok(not has_table_privilege('authenticated',
  'public.account_lifecycle_requests', 'delete'),
  'members cannot erase request history');
select ok(has_column_privilege('authenticated',
  'public.account_lifecycle_requests', 'user_id', 'insert'),
  'members can submit their own id');
select ok(has_column_privilege('authenticated',
  'public.account_lifecycle_requests', 'request_type', 'insert'),
  'members can choose a supported request kind');
select ok(not has_column_privilege('authenticated',
  'public.account_lifecycle_requests', 'status', 'insert'),
  'members cannot forge a status during submission');
select ok(not has_column_privilege('authenticated',
  'public.account_lifecycle_requests', 'operator_note', 'insert'),
  'members cannot forge an operator outcome note');
select ok(not has_table_privilege('anon',
  'public.account_lifecycle_requests', 'select'),
  'anonymous callers cannot read request status');
select ok(not has_table_privilege('anon',
  'public.account_lifecycle_requests', 'insert'),
  'anonymous callers cannot submit account requests');
select ok(has_table_privilege('service_role',
  'public.account_lifecycle_requests', 'update'),
  'the service role can fulfill requests');
select ok(exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'account_lifecycle_requests'
    and policyname = 'Members can read own account requests'
    and cmd = 'SELECT'
), 'the owner-only select policy exists');
select ok(exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'account_lifecycle_requests'
    and policyname = 'Members can create own account requests'
    and cmd = 'INSERT'
), 'the owner-only insert policy exists');
select ok(exists (
  select 1 from pg_index index_row
  where index_row.indexrelid =
    'public.account_lifecycle_requests_one_active_kind_idx'::regclass
    and index_row.indisunique
), 'one active request per member and kind is enforced');
select ok(exists (
  select 1 from pg_trigger
  where tgrelid = 'public.account_lifecycle_requests'::regclass
    and tgname = 'set_account_lifecycle_requests_updated_at'
    and not tgisinternal
), 'operator updates refresh the status timestamp');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

insert into public.account_lifecycle_requests (user_id, request_type)
values ('10000000-0000-4000-8000-000000000001', 'data_export');

select is((select count(*)::integer from public.account_lifecycle_requests), 1,
  'a member can submit and read an owned request');
select is((select status from public.account_lifecycle_requests limit 1),
  'requested', 'new requests always begin in requested status');
select ok((select requested_at = updated_at
  from public.account_lifecycle_requests limit 1),
  'a new request has a coherent initial timeline');

select throws_ok($$
  insert into public.account_lifecycle_requests (user_id, request_type)
  values ('10000000-0000-4000-8000-000000000001', 'data_export')
$$, '23505', null, 'a retry cannot create a second active request of the same kind');

select throws_ok($$
  insert into public.account_lifecycle_requests (user_id, request_type)
  values ('20000000-0000-4000-8000-000000000002', 'account_deletion')
$$, '42501', 'new row violates row-level security policy for table "account_lifecycle_requests"',
  'a member cannot create a request for another account');

select throws_ok($$
  insert into public.account_lifecycle_requests (user_id, request_type)
  values ('10000000-0000-4000-8000-000000000001', 'unsupported')
$$, '23514', null, 'unsupported request kinds fail closed');

select throws_ok($$
  update public.account_lifecycle_requests set status = 'fulfilled'
$$, '42501', 'permission denied for table account_lifecycle_requests',
  'a member cannot fulfill their own request');

reset role;

insert into public.account_lifecycle_requests (user_id, request_type)
values ('20000000-0000-4000-8000-000000000002', 'account_deletion');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

select is((select count(*)::integer from public.account_lifecycle_requests), 1,
  'RLS hides another member request');

reset role;

update public.account_lifecycle_requests
set status = 'in_progress'
where user_id = '10000000-0000-4000-8000-000000000001';

select is((select status from public.account_lifecycle_requests
  where user_id = '10000000-0000-4000-8000-000000000001'),
  'in_progress', 'an operator can advance an active request');
select ok((select updated_at >= requested_at from public.account_lifecycle_requests
  where user_id = '10000000-0000-4000-8000-000000000001'),
  'status mutation advances the updated timestamp');

select throws_ok($$
  update public.account_lifecycle_requests
  set status = 'fulfilled'
  where user_id = '10000000-0000-4000-8000-000000000001'
$$, '23514', null, 'terminal status requires a resolution timestamp');

update public.account_lifecycle_requests
set status = 'fulfilled', resolved_at = clock_timestamp(),
  operator_note = 'Export delivered through the approved secure channel.'
where user_id = '10000000-0000-4000-8000-000000000001';

select is((select status from public.account_lifecycle_requests
  where user_id = '10000000-0000-4000-8000-000000000001'),
  'fulfilled', 'an operator can record a terminal fulfillment');

insert into public.account_lifecycle_requests (user_id, request_type)
values ('10000000-0000-4000-8000-000000000001', 'data_export');

select is((select count(*)::integer from public.account_lifecycle_requests
  where user_id = '10000000-0000-4000-8000-000000000001'
    and request_type = 'data_export'), 2,
  'a member can make a later request after the prior one is terminal');

select * from finish();
rollback;
