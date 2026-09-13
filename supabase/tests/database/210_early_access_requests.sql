begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(34);

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

select ok((select prosecdef and provolatile='s' and proconfig=array['search_path=""'] from pg_proc
  where oid='private.early_access_verified_identity_matches(uuid,text)'::regprocedure), 'private identity helper is stable with fixed definer search path');
select is(pg_get_function_result('private.early_access_verified_identity_matches(uuid,text)'::regprocedure), 'boolean', 'identity helper exposes only a boolean');
select ok(has_function_privilege('service_role','private.early_access_verified_identity_matches(uuid,text)','execute'), 'trusted server can check verified identity');
select ok(not has_function_privilege('anon','private.early_access_verified_identity_matches(uuid,text)','execute'), 'anonymous clients cannot probe identities');
select ok(not has_function_privilege('authenticated','private.early_access_verified_identity_matches(uuid,text)','execute'), 'members cannot probe identities');
select ok(not has_table_privilege('service_role','auth.users','select'), 'intake does not depend on direct service Auth reads');

-- Synthetic fixture only; all rows and assertion-library grants roll back.
insert into auth.users(id,email,email_confirmed_at,is_anonymous)
  values('17410000-0000-4000-8000-000000000001','early-access-verified-fixture@example.test',now(),false);
grant usage on schema extensions to service_role;
set local request.jwt.claims='{"role":"service_role"}';
set local role service_role;
select is(private.early_access_verified_identity_matches('17410000-0000-4000-8000-000000000001','early-access-verified-fixture@example.test'),true,'verified identity matches in the server request context');
select is(public.submit_early_access_request_service('Verified Fixture','early-access-verified-fixture@example.test','17410000-0000-4000-8000-000000000001'),'{"received":true}'::jsonb,'actual signed-in intake succeeds with service privileges');
select throws_ok($$select public.submit_early_access_request_service('Wrong Fixture','wrong-verified-fixture@example.test','17410000-0000-4000-8000-000000000001')$$,'42501','Verified account mismatch.','a forged subject/email pair is rejected');
select is(private.early_access_verified_identity_matches(null,'early-access-verified-fixture@example.test'),false,'missing identity cannot match');
set local request.jwt.claims='{"role":"service_role","sub":"17410000-0000-4000-8000-000000000001"}';
select is(private.early_access_verified_identity_matches('17410000-0000-4000-8000-000000000001','early-access-verified-fixture@example.test'),false,'a forwarded user context cannot stand in for the service client');
reset role;
set local request.jwt.claims='{}';
select is(private.early_access_verified_identity_matches('17410000-0000-4000-8000-000000000001','early-access-verified-fixture@example.test'),false,'a privileged non-service SQL session is not an applicant');

select * from finish();
rollback;
