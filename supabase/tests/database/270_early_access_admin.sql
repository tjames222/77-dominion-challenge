begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(34);

select has_column('private','early_access_requests','revision','review decisions have an optimistic revision');
select has_column('private','early_access_requests','invitation_sent_at','actual invitation sent evidence is nullable');
select has_column('private','early_access_requests','invitation_expires_at','actual invitation expiry evidence is nullable');
select has_column('private','early_access_requests','accepted_at','actual acceptance evidence is nullable');
select ok((select relrowsecurity from pg_class where oid='private.early_access_requests'::regclass),'request RLS remains enabled');
select ok((select relrowsecurity from pg_class where oid='private.site_admin_role_requests'::regclass),'shared idempotency registry remains private with RLS');
select ok(has_function_privilege('authenticated','public.site_admin_list_early_access_requests(uuid,integer,text,text,text,jsonb)','execute'),'authorized queue requests enter a guarded RPC');
select ok(has_function_privilege('authenticated','public.site_admin_get_early_access_request(uuid,uuid)','execute'),'authorized detail requests enter a guarded RPC');
select ok(has_function_privilege('authenticated','public.site_admin_list_early_access_history(uuid,uuid,integer,jsonb)','execute'),'authorized history requests enter a guarded RPC');
select ok(has_function_privilege('authenticated','public.site_admin_deny_early_access_request(uuid,uuid,bigint,uuid,uuid)','execute'),'denial enters a guarded RPC');
select ok(not has_function_privilege('anon','public.site_admin_list_early_access_requests(uuid,integer,text,text,text,jsonb)','execute'),'anonymous queue calls are denied');
select ok(not has_function_privilege('anon','public.site_admin_get_early_access_request(uuid,uuid)','execute'),'anonymous detail calls are denied');
select ok(not has_function_privilege('anon','public.site_admin_list_early_access_history(uuid,uuid,integer,jsonb)','execute'),'anonymous history calls are denied');
select ok(not has_function_privilege('anon','public.site_admin_deny_early_access_request(uuid,uuid,bigint,uuid,uuid)','execute'),'anonymous denial calls are denied');
select ok(not has_function_privilege('service_role','public.site_admin_list_early_access_requests(uuid,integer,text,text,text,jsonb)','execute'),'service keys alone cannot review the queue');
select ok(not has_function_privilege('service_role','public.site_admin_get_early_access_request(uuid,uuid)','execute'),'service keys alone cannot read request detail');
select ok(not has_function_privilege('service_role','public.site_admin_list_early_access_history(uuid,uuid,integer,jsonb)','execute'),'service keys alone cannot read request history');
select ok(not has_function_privilege('service_role','public.site_admin_deny_early_access_request(uuid,uuid,bigint,uuid,uuid)','execute'),'service keys alone cannot deny requests');
select ok(not has_function_privilege('authenticated','private.site_admin_early_access_payload(uuid)','execute'),'the fixed-field serializer is not public');
select ok(not has_table_privilege('authenticated','private.early_access_requests','select'),'members cannot list the private table directly');
select ok(not has_column_privilege('service_role','private.early_access_requests','status','update'),'intake cannot change review status');
select ok(not has_column_privilege('service_role','private.early_access_requests','revision','update'),'intake cannot change review revision');
select ok(not has_column_privilege('service_role','private.early_access_requests','invitation_sent_at','update'),'intake cannot invent delivery timestamps');
select ok(exists(select 1 from pg_trigger where tgrelid='private.site_admin_audit'::regclass and tgname='site_admin_audit_immutable' and not tgisinternal),'the immutable audit trigger is retained');
select has_index('private','early_access_requests','early_access_admin_created_id_idx','request keyset pages have an ordered index');
select has_index('private','early_access_requests','early_access_admin_email_prefix_idx','request email prefix has an index');
select has_index('private','early_access_requests','early_access_admin_name_prefix_idx','request name prefix has an index');
select has_index('private','site_admin_audit','site_admin_audit_early_access_sequence_idx','request audit history has an index');
select ok((select count(*)=3 and bool_and(provolatile='s' and prosecdef and proconfig=array['search_path=""']) from pg_proc
  where oid in ('public.site_admin_list_early_access_requests(uuid,integer,text,text,text,jsonb)'::regprocedure,
    'public.site_admin_get_early_access_request(uuid,uuid)'::regprocedure,
    'public.site_admin_list_early_access_history(uuid,uuid,integer,jsonb)'::regprocedure)), 'all reads use a stable snapshot and empty search path');
select ok((select prosecdef and proconfig @> array['search_path=""','lock_timeout=5s'] from pg_proc
  where oid='public.site_admin_deny_early_access_request(uuid,uuid,bigint,uuid,uuid)'::regprocedure),'denial has a fixed search path and bounded lock wait');

-- Assertion-library access only; it grants no access to application/Auth data.
grant usage on schema extensions to authenticated;
set local request.jwt.claims='{}';
set local role authenticated;
select throws_ok($$select public.site_admin_list_early_access_requests('17420000-0000-4000-8000-000000000001')$$,'PT401',null,'queue rejects a missing live actor before any payload');
select throws_ok($$select public.site_admin_get_early_access_request('17420000-0000-4000-8000-000000000001','17420000-0000-4000-8000-000000000002')$$,'PT401',null,'detail rejects a missing live actor before any payload');
select throws_ok($$select public.site_admin_list_early_access_history('17420000-0000-4000-8000-000000000001','17420000-0000-4000-8000-000000000002')$$,'PT401',null,'history rejects a missing live actor before any payload');
select throws_ok($$select public.site_admin_deny_early_access_request('17420000-0000-4000-8000-000000000001','17420000-0000-4000-8000-000000000002',0,gen_random_uuid(),gen_random_uuid())$$,'PT401',null,'denial rejects a missing live actor before mutation');
reset role;
select * from finish();
rollback;
