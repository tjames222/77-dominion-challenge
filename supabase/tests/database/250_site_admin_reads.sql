begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(20);
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
select has_index('auth','users','site_admin_users_created_id_idx','created timestamp/UUID keyset has a matching index');
select has_index('auth','users','site_admin_users_email_prefix_idx','canonical email prefix has a matching index');
select has_index('public','profiles','site_admin_profiles_name_prefix_idx','profile name prefix has a matching index');
select has_index('public','subscriptions','site_admin_subscriptions_latest_idx','latest subscription snapshot has a matching index');
select has_index('private','site_admin_audit','site_admin_audit_target_sequence_idx','target audit pages have a matching index');
select ok((select count(*)=4 and bool_and(p.provolatile='s' and p.prosecdef and p.proconfig=array['search_path=""'])
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('site_admin_get_user','site_admin_list_users','site_admin_get_audit_event','site_admin_list_audit')),
  'all read RPCs retain a stable statement snapshot and empty search path');
select * from finish();
rollback;
