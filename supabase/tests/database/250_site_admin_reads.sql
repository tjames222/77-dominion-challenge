begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(28);
select ok(has_function_privilege('authenticated','public.site_admin_get_user(uuid,uuid)','execute'),'account detail enters the guarded RPC');
select ok(has_function_privilege('authenticated','public.site_admin_list_users(uuid,integer,text,text,text,text,jsonb)','execute'),'account list enters the guarded RPC');
select ok(has_function_privilege('authenticated','public.site_admin_get_audit_event(uuid,text)','execute'),'audit detail enters the guarded RPC');
select ok(has_function_privilege('authenticated','public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb)','execute'),'audit list enters the guarded RPC');
select ok(not has_function_privilege('anon','public.site_admin_get_user(uuid,uuid)','execute'),'anonymous account detail is denied');
select ok(not has_function_privilege('anon','public.site_admin_list_users(uuid,integer,text,text,text,text,jsonb)','execute'),'anonymous account list is denied');
select ok(not has_function_privilege('anon','public.site_admin_get_audit_event(uuid,text)','execute'),'anonymous audit detail is denied');
select ok(not has_function_privilege('anon','public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb)','execute'),'anonymous audit list is denied');
select ok(not has_function_privilege('service_role','public.site_admin_get_user(uuid,uuid)','execute'),'a service key is not account-read authorization');
select ok(not has_function_privilege('service_role','public.site_admin_list_users(uuid,integer,text,text,text,text,jsonb)','execute'),'a service key is not account-list authorization');
select ok(not has_function_privilege('service_role','public.site_admin_get_audit_event(uuid,text)','execute'),'a service key is not audit-read authorization');
select ok(not has_function_privilege('service_role','public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb)','execute'),'a service key is not audit-list authorization');
select ok(not has_function_privilege('authenticated','private.site_admin_user_payload(uuid)','execute'),'account serializer is private');
select ok(not has_function_privilege('authenticated','private.site_admin_audit_payload(bigint)','execute'),'audit serializer is private');
select has_index('private','site_admin_user_directory','site_admin_users_created_id_idx','private created timestamp/UUID keyset has a matching index');
select has_index('private','site_admin_user_directory','site_admin_users_email_prefix_idx','private canonical email prefix has a matching index');
select has_index('public','profiles','site_admin_profiles_name_prefix_idx','profile name prefix has a matching index');
select has_index('public','subscriptions','site_admin_subscriptions_latest_idx','latest subscription snapshot has a matching index');
select has_index('private','site_admin_audit','site_admin_audit_target_sequence_idx','target audit pages have a matching index');
select ok((select count(*)=4 and bool_and(p.provolatile='s' and p.prosecdef and p.proconfig=array['search_path=""'])
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('site_admin_get_user','site_admin_list_users','site_admin_get_audit_event','site_admin_list_audit')),
  'all read RPCs retain a stable statement snapshot and empty search path');
select ok((select relrowsecurity from pg_class where oid='private.site_admin_user_directory'::regclass),'search projection has RLS');
select ok(not has_table_privilege('authenticated','private.site_admin_user_directory','select'),'members cannot directly read the search projection');
select ok(not has_table_privilege('service_role','private.site_admin_user_directory','select'),'service keys cannot directly read the search projection');
select ok(not has_function_privilege('authenticated','private.sync_site_admin_user_directory()','execute'),'the search synchronization helper is private');
select is((select count(*) from pg_indexes where schemaname='auth' and indexname like 'site_admin_%'),0::bigint,'no application search indexes are installed on provider-owned Auth');
select ok((select p.prosecdef and p.proconfig=array['search_path=""'] from pg_proc p where p.oid='private.sync_site_admin_user_directory()'::regprocedure),'search synchronization uses a fixed empty search path');
select is((select count(*) from information_schema.columns where table_schema='private' and table_name='site_admin_user_directory'),3::bigint,'the search projection contains only UUID, canonical email and created timestamp');
select ok(exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='sync_site_admin_user_directory' and not tgisinternal),'Auth writes have a transactional projection trigger');
select * from finish();
rollback;
