begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(47);

create temporary table bootstrap_smoke_tables(name text primary key);
insert into bootstrap_smoke_tables values('early_access_account_bootstraps'),('early_access_account_setup_deliveries');
select ok(c.oid is not null and c.relrowsecurity,t.name||' exists with RLS')
from bootstrap_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;
select ok(c.oid is not null and not exists(select 1 from pg_policy p where p.polrelid=c.oid)
  and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner)
  and not exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) p where a.attrelid=c.oid and p.grantee<>c.relowner)
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),t.name||' denies direct table and column access')
from bootstrap_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;
select is((select count(*) from private.early_access_account_bootstraps),0::bigint,'migration reserves no native identities');
select is((select count(*) from private.early_access_account_setup_deliveries),0::bigint,'migration queues no native mail');

create temporary table bootstrap_smoke_helpers(signature text primary key);
insert into bootstrap_smoke_helpers values
  ('private.queue_early_access_account_bootstrap()'),('private.retire_early_access_account_bootstrap()'),
  ('private.lock_early_access_account_bootstrap(uuid)'),('private.early_access_account_setup_current(uuid)'),
  ('private.early_access_account_setup_material_valid(jsonb,jsonb,text,text,uuid)');
select ok(p.oid is not null and p.prosecdef and p.proconfig @> array['search_path=""']
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner)
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,p.oid,'execute')),
  h.signature||' remains internal with empty search path')
from bootstrap_smoke_helpers h left join pg_proc p on p.oid=to_regprocedure(h.signature) order by h.signature;

create temporary table bootstrap_smoke_rpcs(signature text primary key,call_sql text not null);
insert into bootstrap_smoke_rpcs values
 ('public.claim_early_access_account_bootstraps(uuid,integer)',
  'select public.claim_early_access_account_bootstraps(''31000000-0000-4000-8000-000000000001'',1)'),
 ('public.start_early_access_account_bootstrap(uuid,uuid)',
  'select public.start_early_access_account_bootstrap(''31000000-0000-4000-8000-000000000001'',''31000000-0000-4000-8000-000000000002'')'),
 ('public.persist_early_access_account_setup(uuid,uuid,jsonb,jsonb,text,text)',
  'select public.persist_early_access_account_setup(''31000000-0000-4000-8000-000000000001'',''31000000-0000-4000-8000-000000000002'',null,null,null,null)'),
 ('public.settle_early_access_account_bootstrap(uuid,uuid,text)',
  'select public.settle_early_access_account_bootstrap(''31000000-0000-4000-8000-000000000001'',''31000000-0000-4000-8000-000000000002'',''bootstrap_unavailable'')'),
 ('public.claim_early_access_account_setup_deliveries(uuid,integer)',
  'select public.claim_early_access_account_setup_deliveries(''31000000-0000-4000-8000-000000000001'',1)'),
 ('public.mark_early_access_account_setup_dispatched(uuid,uuid,text)',
  'select public.mark_early_access_account_setup_dispatched(''31000000-0000-4000-8000-000000000001'',''31000000-0000-4000-8000-000000000002'',repeat(''b'',64))'),
 ('public.settle_early_access_account_setup_delivery(uuid,uuid,text,text,uuid)',
  'select public.settle_early_access_account_setup_delivery(''31000000-0000-4000-8000-000000000001'',''31000000-0000-4000-8000-000000000002'',''uncertain'',''delivery_unconfirmed'',null)');
select ok(p.oid is not null and p.prosecdef and p.proconfig @> array['search_path=""']
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee<>p.proowner and (a.grantee<>to_regrole('service_role') or a.is_grantable))
  and has_function_privilege('service_role',p.oid,'execute')
  and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute'),
  r.signature||' exposes only service worker execution')
from bootstrap_smoke_rpcs r left join pg_proc p on p.oid=to_regprocedure(r.signature) order by r.signature;

select ok(exists(select 1 from pg_trigger where tgrelid='private.early_access_invitations'::regclass
  and tgname='queue_early_access_account_bootstrap' and tgfoid='private.queue_early_access_account_bootstrap()'::regprocedure
  and tgenabled='O'),'private issuance trigger queues only approved new-account work');
select ok(exists(select 1 from pg_trigger where tgrelid='private.early_access_invitations'::regclass
  and tgname='retire_early_access_account_bootstrap' and tgfoid='private.retire_early_access_account_bootstrap()'::regprocedure
  and tgenabled='O'),'private generation retirement purges unsent native mail');
select ok(not exists(select 1 from pg_constraint where conrelid in('private.early_access_account_bootstraps'::regclass,'private.early_access_account_setup_deliveries'::regclass)
  and contype='f' and confrelid='auth.users'::regclass),'private reserved UUIDs add no reverse-order native Auth FK');

grant usage on schema extensions to anon,authenticated,service_role;
grant select on bootstrap_smoke_rpcs to anon,authenticated,service_role;
set local request.jwt.claims='{}';set local role anon;
select throws_ok(call_sql,'42501',null,signature||' rejects anonymous execution') from bootstrap_smoke_rpcs order by signature;
reset role;set local role authenticated;
select throws_ok(call_sql,'42501',null,signature||' rejects member execution') from bootstrap_smoke_rpcs order by signature;
reset role;set local request.jwt.claims='{"role":"service_role","sub":"31000000-0000-4000-8000-000000000003"}';set local role service_role;
select throws_ok(call_sql,'42501',null,signature||' rejects mixed service/member identity') from bootstrap_smoke_rpcs order by signature;
reset role;set local request.jwt.claims='{"role":"service_role"}';set local role service_role;
select is(public.claim_early_access_account_bootstraps('31000000-0000-4000-8000-000000000001',1),'[]'::jsonb,'worker sees no native create work after migration');
select is(public.claim_early_access_account_setup_deliveries('31000000-0000-4000-8000-000000000001',1),'[]'::jsonb,'worker sees no setup mail after migration');
select throws_ok($$select public.claim_early_access_account_bootstraps(null,1)$$,'22023',null,'native claim requires a worker lease token');
select throws_ok($$select public.claim_early_access_account_setup_deliveries('31000000-0000-4000-8000-000000000001',2)$$,'22023',null,'setup-mail claim cannot exceed batch one');
select throws_ok($$select public.settle_early_access_account_bootstrap('31000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002','raw provider details')$$,'22023',null,'terminal bootstrap failure cannot store provider prose');
reset role;
select * from finish();
rollback;
