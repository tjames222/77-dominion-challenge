begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

select ok(exists(select 1 from supabase_migrations.schema_migrations where version = '20260913023402'), 'early-access migration was replayed');
select ok((select relrowsecurity from pg_class where oid = 'private.early_access_requests'::regclass), 'requests have RLS');
select ok((select relrowsecurity from pg_class where oid = 'private.early_access_intake_attempts'::regclass), 'attempts have RLS');
select ok(not has_table_privilege('anon', 'private.early_access_requests', 'select'), 'anonymous visitors cannot list requests');
select ok(not has_table_privilege('authenticated', 'private.early_access_requests', 'select'), 'members cannot list requests');
select ok(not has_table_privilege('anon', 'private.early_access_requests', 'insert'), 'anonymous visitors cannot directly insert');
select ok(not has_table_privilege('authenticated', 'private.early_access_requests', 'insert'), 'members cannot directly insert');
select ok(not has_function_privilege('anon', 'public.submit_early_access_request_service(text,text,uuid)', 'execute'), 'anon cannot call service RPC');
select ok(not has_function_privilege('authenticated', 'public.submit_early_access_request_service(text,text,uuid)', 'execute'), 'members cannot call service RPC');
select ok(has_function_privilege('service_role', 'public.submit_early_access_request_service(text,text,uuid)', 'execute'), 'service can submit intake');
select ok((select not prosecdef from pg_proc where oid = 'public.submit_early_access_request_service(text,text,uuid)'::regprocedure), 'RPC is INVOKER');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.submit_early_access_request_service(text,text,uuid)'::regprocedure), 'RPC pins an empty search path');
select ok((select indisunique from pg_index where indexrelid = 'private.early_access_requests_pending_user_idx'::regclass), 'one pending request per account is enforced');
select ok(not has_column_privilege('service_role', 'private.early_access_requests', 'status', 'update'), 'intake cannot approve access');
select ok(not has_column_privilege('service_role', 'private.early_access_requests', 'status', 'insert'), 'intake cannot insert an approved request');

select is(public.submit_early_access_request_service('Test Request', 'early-access-fixture@example.test', null), '{"received":true}'::jsonb, 'valid anonymous intake returns a generic receipt');
select is(public.submit_early_access_request_service('Different Name', 'EARLY-ACCESS-FIXTURE@example.test', null), '{"received":true}'::jsonb, 'duplicate intake returns the same receipt');
select is((select count(*)::integer from private.early_access_requests where email = 'early-access-fixture@example.test'), 1, 'duplicate has one stored request');
select is((select status from private.early_access_requests where email = 'early-access-fixture@example.test'), 'pending', 'intake begins pending');
select is((select form_version from private.early_access_requests where email = 'early-access-fixture@example.test'), 1, 'request has an extensible form version');
select throws_ok($$select public.submit_early_access_request_service('', 'invalid', null)$$, '22023', null, 'invalid input is rejected by SQL');
select ok((select count(*) >= 2 from private.early_access_intake_attempts), 'duplicates count toward the shared budget');

select * from finish();
rollback;
