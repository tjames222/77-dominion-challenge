set search_path=pg_catalog;
set TimeZone='UTC';
set DateStyle='ISO, YMD';
with functions as (
  select p.oid,p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,l.lanname as language,
    p.provolatile::text as volatility,p.prosecdef as "securityDefiner",p.proconfig as config,
    p.proretset as "returnsSet",p.proisstrict as strict,p.proparallel::text as parallel,p.procost as cost,p.prorows as rows,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') as "definitionSha256",
    (select jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable)
      order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable)
      from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a) as acl
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid in (
    'private.sync_site_admin_profile_name_version()'::regprocedure,'private.site_admin_profile_name_valid(text)'::regprocedure,
    'private.site_admin_profile_name_snapshot(uuid,uuid,uuid,boolean)'::regprocedure,
    'public.site_admin_get_profile_name(uuid,uuid)'::regprocedure,
    'public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure,
    'private.site_admin_audit_payload(bigint)'::regprocedure,'public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb)'::regprocedure,
    'private.require_site_admin(text,uuid,boolean)'::regprocedure,'private.site_admin_request_identity(uuid)'::regprocedure,
    'private.site_admin_mfa_ready(uuid,uuid,boolean)'::regprocedure,'private.require_member_current_session(uuid,uuid)'::regprocedure,
    'private.site_admin_immutable()'::regprocedure
  )
), relations as (
  select c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner,
    (select jsonb_agg(jsonb_build_array(a.attname,a.atttypid::regtype::text,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
    (select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable)
      order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable),'[]')
      from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a) as acl,
    (select jsonb_agg(jsonb_build_object('name',n.conname,'type',n.contype::text,'validated',n.convalidated,
      'definition',pg_get_constraintdef(n.oid),'definitionSha256',encode(sha256(convert_to(pg_get_constraintdef(n.oid),'UTF8')),'hex')) order by n.conname)
      from pg_constraint n where n.conrelid=c.oid) as constraints,
    (select jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'valid',i.indisvalid,'ready',i.indisready,
      'definition',pg_get_indexdef(i.indexrelid),'definitionSha256',encode(sha256(convert_to(pg_get_indexdef(i.indexrelid),'UTF8')),'hex')) order by i.indexrelid::regclass::text)
      from pg_index i where i.indrelid=c.oid) as indexes
  from pg_class c where c.oid in('private.site_admin_profile_name_versions'::regclass,'private.site_admin_audit'::regclass)
), triggers as (
  select t.tgname as name,t.tgrelid::regclass::text as relation,t.tgfoid::regprocedure::text as function,
    t.tgenabled::text as enabled,pg_get_triggerdef(t.oid) as definition,
    encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex') as "definitionSha256"
  from pg_trigger t where not t.tgisinternal and (
    (t.tgrelid='public.profiles'::regclass and t.tgname='sync_site_admin_profile_name_version')
    or (t.tgrelid='private.site_admin_audit'::regclass and t.tgname='site_admin_audit_immutable'))
)
select jsonb_build_object('functions',(select jsonb_agg(to_jsonb(f)-'oid' order by signature)from functions f),
  'sidecar',(select to_jsonb(r)-'oid' from relations r where r.relname='site_admin_profile_name_versions'),
  'audit',(select to_jsonb(r)-'oid' from relations r where r.relname='site_admin_audit'),
  'triggers',(select jsonb_agg(to_jsonb(t)order by name)from triggers t));
