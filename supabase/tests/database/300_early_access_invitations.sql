begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(45);

create temporary table invitation_smoke_tables(name text primary key);
insert into invitation_smoke_tables values ('early_access_invitations'),('early_access_invitation_deliveries'),('early_access_acceptance_operations');
select ok(c.oid is not null and c.relkind='r' and c.relrowsecurity,t.name||' exists with RLS')
from invitation_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;
select ok(c.oid is not null and not exists(select 1 from pg_policy p where p.polrelid=c.oid)
  and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner)
  and not exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) p where a.attrelid=c.oid and p.grantee<>c.relowner)
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),t.name||' denies all non-owner table/column access')
from invitation_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;
select is((select count(*) from private.early_access_invitations),0::bigint,'migration issues no invitations');
select is((select count(*) from private.early_access_invitation_deliveries),0::bigint,'migration queues no mail');
select is((select count(*) from private.early_access_acceptance_operations),0::bigint,'migration accepts no people');

create temporary table invitation_smoke_helpers(signature text primary key,definer boolean not null);
insert into invitation_smoke_helpers values
  ('private.require_early_access_invitation_admin(uuid)',true),
  ('private.early_access_invitation_account(text)',true),
  ('private.early_access_invitation_token_digest(text)',false),
  ('private.early_access_invitation_material_valid(jsonb,jsonb,text,text,text,uuid,text)',false),
  ('private.write_early_access_invitation(uuid,text,uuid,bigint,uuid,uuid,jsonb,text,text,text,jsonb)',true),
  ('private.expire_early_access_invitation(uuid)',true),
  ('private.accept_early_access_invitation(uuid,uuid,text,uuid,uuid)',true),
  ('private.require_early_access_invitation_worker()',true);
select ok(p.oid is not null and p.prosecdef=h.definer and p.proconfig @> array['search_path=""']
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner)
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,p.oid,'execute')),
  h.signature||' is internal with exact security mode')
from invitation_smoke_helpers h left join pg_proc p on p.oid=to_regprocedure(h.signature) order by h.signature;

create temporary table invitation_smoke_rpcs(signature text primary key,allowed_role text not null,call_sql text not null);
insert into invitation_smoke_rpcs values
  ('public.site_admin_write_early_access_invitation(uuid,text,uuid,bigint,uuid,uuid,jsonb,text,text,text,jsonb)','authenticated',
    'select public.site_admin_write_early_access_invitation(''30000000-0000-4000-8000-000000000001'',''revoke'',''30000000-0000-4000-8000-000000000002'',0,''30000000-0000-4000-8000-000000000003'',''30000000-0000-4000-8000-000000000004'')'),
  ('public.accept_early_access_invitation(uuid,uuid,text,uuid,uuid)','authenticated',
    'select public.accept_early_access_invitation(''30000000-0000-4000-8000-000000000001'',''30000000-0000-4000-8000-000000000002'',''not-a-token'',''30000000-0000-4000-8000-000000000003'',''30000000-0000-4000-8000-000000000004'')'),
  ('public.claim_early_access_invitation_deliveries(uuid,integer)','service_role',
    'select public.claim_early_access_invitation_deliveries(''30000000-0000-4000-8000-000000000003'',1)'),
  ('public.mark_early_access_invitation_dispatched(uuid,uuid,text,text)','service_role',
    'select public.mark_early_access_invitation_dispatched(''30000000-0000-4000-8000-000000000002'',''30000000-0000-4000-8000-000000000003'',repeat(''a'',64),repeat(''b'',64))'),
  ('public.settle_early_access_invitation_delivery(uuid,uuid,text,text,uuid)','service_role',
    'select public.settle_early_access_invitation_delivery(''30000000-0000-4000-8000-000000000002'',''30000000-0000-4000-8000-000000000003'',''uncertain'',''delivery_unconfirmed'',null)');
select ok(p.oid is not null and p.prosecdef and p.proconfig @> array['search_path=""']
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee<>p.proowner and (a.grantee<>to_regrole(r.allowed_role) or a.is_grantable))
  and has_function_privilege(r.allowed_role,p.oid,'execute')
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
    where role_name<>r.allowed_role and has_function_privilege(role_name,p.oid,'execute')),
  r.signature||' exposes only its original caller/worker role')
from invitation_smoke_rpcs r left join pg_proc p on p.oid=to_regprocedure(r.signature) order by r.signature;

select ok(to_regprocedure('private.serialize_early_access_auth_authority()') is null,'no extra Auth lifecycle serialization helper is installed');
create temporary table invitation_smoke_triggers(relation_name text,name text primary key);
insert into invitation_smoke_triggers values
  ('auth.users','serialize_early_access_user_identity'),
  ('auth.sessions','serialize_early_access_session_authority'),
  ('auth.mfa_factors','serialize_early_access_factor_authority'),
  ('auth.mfa_amr_claims','serialize_early_access_amr_authority');
select ok(t.oid is null,expected.name||' does not introduce native Auth FK lock coupling')
from invitation_smoke_triggers expected left join pg_trigger t on t.tgrelid=to_regclass(expected.relation_name) and t.tgname=expected.name order by expected.name;
select ok(exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='guard_final_site_admin_auth'
  and tgfoid='private.guard_site_admin_recovery()'::regprocedure and tgenabled='O'),'existing final-admin recovery trigger remains intact');
select ok(not exists(select 1 from pg_constraint where conrelid='private.early_access_invitations'::regclass and contype='f'
  and confrelid='auth.users'::regclass),'historical invitation UUID adds no reverse-order Auth FK lock');

grant usage on schema extensions to anon,authenticated,service_role;
grant select on invitation_smoke_rpcs to anon,authenticated,service_role;
set local request.jwt.claims='{}';set local request.headers='{}';
set local role anon;
select throws_ok(call_sql,'42501',null,signature||' rejects anonymous execution') from invitation_smoke_rpcs order by signature;
reset role;
set local role authenticated;
select throws_ok(call_sql,case when allowed_role='authenticated' then 'PT401' else '42501' end,null,
  signature||' requires native identity or denies member execution') from invitation_smoke_rpcs order by signature;
reset role;
set local request.jwt.claims='{"role":"service_role"}';set local role service_role;
select throws_ok(call_sql,'42501',null,signature||' cannot substitute service identity for actor')
from invitation_smoke_rpcs where allowed_role='authenticated' order by signature;
select is(public.claim_early_access_invitation_deliveries('30000000-0000-4000-8000-000000000003',1),'[]'::jsonb,'pure worker sees an empty queue without creating work');
reset role;
set local request.jwt.claims='{"role":"service_role","sub":"30000000-0000-4000-8000-000000000001"}';set local role service_role;
select throws_ok(call_sql,'42501',null,signature||' denies mixed worker/member identity')
from invitation_smoke_rpcs where allowed_role='service_role' order by signature;
reset role;
select * from finish();
rollback;
