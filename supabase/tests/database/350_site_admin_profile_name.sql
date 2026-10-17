begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(36);
select has_function('public','site_admin_get_profile_name',array['uuid','uuid'],'exact profile name read is actor and target bound');
select has_function('public','site_admin_correct_profile_name',array['uuid','uuid','uuid','text','uuid','uuid'],'correction accepts only fixed identity, UUID CAS, bounded name and operation IDs');
select ok(has_function_privilege('authenticated','public.site_admin_get_profile_name(uuid,uuid)','execute'),'members can enter the guarded reader');
select ok(not has_function_privilege('anon','public.site_admin_get_profile_name(uuid,uuid)','execute'),'anonymous reader denied');
select ok(not has_function_privilege('service_role','public.site_admin_get_profile_name(uuid,uuid)','execute'),'service reader denied');
select ok(has_function_privilege('authenticated','public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)','execute'),'members can enter the guarded writer');
select ok(not has_function_privilege('anon','public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)','execute'),'anonymous writer denied');
select ok(not has_function_privilege('service_role','public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)','execute'),'service writer denied');
select ok(not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
  where p.oid in('public.site_admin_get_profile_name(uuid,uuid)'::regprocedure,'public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure)and a.grantee=0),'PUBLIC has no RPC grant');
select ok((select bool_and(prosecdef and provolatile='v' and proconfig @> array['search_path=""'])from pg_proc
  where oid in('public.site_admin_get_profile_name(uuid,uuid)'::regprocedure,'public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure)),'RPCs use fresh snapshots and empty search paths');
select ok((select proconfig @> array['lock_timeout=5s']from pg_proc where oid='public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure),'writer has a bounded lock setting');
select ok((select relrowsecurity from pg_class where oid='private.site_admin_profile_name_versions'::regclass),'private version table has RLS');
select is((select count(*)from information_schema.columns where table_schema='private' and table_name='site_admin_profile_name_versions'),2::bigint,'sidecar stores only ID and UUID version');
select ok(not has_table_privilege('anon','private.site_admin_profile_name_versions','select'),'anonymous sidecar reads denied');
select ok(not has_table_privilege('authenticated','private.site_admin_profile_name_versions','select'),'member sidecar reads denied');
select ok(not has_table_privilege('service_role','private.site_admin_profile_name_versions','select'),'service sidecar reads denied');
select ok(not has_table_privilege('authenticated','private.site_admin_profile_name_versions','update'),'members cannot forge versions');
select ok(not has_table_privilege('service_role','private.site_admin_profile_name_versions','insert'),'service keys cannot mint versions');
select ok(exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgname='sync_site_admin_profile_name_version'and tgtype=21 and not tgisinternal),'AFTER INSERT/UPDATE row trigger owns version changes');
select ok(exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgname='sync_site_admin_profile_name_version'and tgenabled='O'
  and tgfoid='private.sync_site_admin_profile_name_version()'::regprocedure),'profile trigger is enabled and bound to its fixed private function');
select ok(not exists(select 1 from pg_proc p cross join(values('anon'),('authenticated'),('service_role'))r(name)
  where p.oid in('private.sync_site_admin_profile_name_version()'::regprocedure,'private.site_admin_profile_name_valid(text)'::regprocedure,
  'private.site_admin_profile_name_snapshot(uuid,uuid,uuid,boolean)'::regprocedure)and has_function_privilege(r.name,p.oid,'execute')),'all new internal helpers are client/service inaccessible');
select ok(exists(select 1 from pg_constraint where conrelid='private.site_admin_profile_name_versions'::regclass and contype='f'
  and confrelid='public.profiles'::regclass and confdeltype='c'and convalidated),'sidecar cascades only from its profile');
select has_index('private','site_admin_profile_name_versions','site_admin_profile_name_versions_pkey','one UUID lookup per profile');
select col_has_default('private','site_admin_profile_name_versions','version','server generates UUID insert versions');
select has_column('private','site_admin_audit','before_profile_name_version','audit stores previous version metadata');
select has_column('private','site_admin_audit','after_profile_name_version','audit stores resulting version metadata');
select has_column('private','site_admin_audit','profile_name_changed','audit distinguishes no-op without storing names');
select ok((select convalidated from pg_constraint where conrelid='private.site_admin_audit'::regclass and conname='site_admin_audit_typed_action_check'),'typed audit constraint is validated');
select ok(exists(select 1 from pg_trigger where tgrelid='private.site_admin_audit'::regclass and tgname='site_admin_audit_immutable'and tgenabled='O'),'audit immutability remains active');
select ok(not has_function_privilege('authenticated','private.require_site_admin(text,uuid,boolean)','execute'),'canonical guard remains private');
select ok(private.site_admin_profile_name_valid(repeat('😀',120)),'name bound counts scalar code points, not UTF-16 units');
select ok(not private.site_admin_profile_name_valid(repeat('x',121)),'121 code points are rejected');
select ok(not private.site_admin_profile_name_valid(U&'\00A0Name'),'edge nonbreaking whitespace is rejected, not silently trimmed');
select ok(not private.site_admin_profile_name_valid(U&'A\2028B'),'Unicode line separators are rejected anywhere');
grant usage on schema extensions to authenticated;
set local request.jwt.claims='{}';
set local request.jwt.claim.sub='';
set local role authenticated;
select throws_ok($$select public.site_admin_get_profile_name('15020000-0000-4000-8000-000000000001','15020000-0000-4000-8000-000000000002')$$,
  'PT401','admin_authentication_required','missing actor cannot enter reader');
select throws_ok($$select public.site_admin_correct_profile_name('15020000-0000-4000-8000-000000000001','15020000-0000-4000-8000-000000000002',gen_random_uuid(),'Name',gen_random_uuid(),gen_random_uuid())$$,
  'PT401','admin_authentication_required','missing actor cannot enter writer');
reset role;
select * from finish();
rollback;
