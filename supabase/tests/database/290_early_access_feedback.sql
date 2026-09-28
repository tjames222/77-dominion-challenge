begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(63);

-- Fixed inventories deliberately produce one assertion per named object: a
-- missing table/function cannot disappear from an aggregate and pass.
create temporary table ea_smoke_tables(name text primary key);
insert into ea_smoke_tables values
  ('early_access_programs'), ('early_access_grants'), ('early_access_price_qualifications'),
  ('early_access_feedback'), ('early_access_feedback_deliveries'), ('transactional_email_reservations');

-- 18 assertions: six exact private tables, RLS, no table/column grants, no
-- policies. An unexposed schema alone is not the authorization boundary.
select ok(c.oid is not null and c.relkind='r' and c.relrowsecurity, t.name || ' exists with RLS')
from ea_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;
select ok(c.oid is not null and not exists (
    select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner
  ) and not exists (
    select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) p
    where a.attrelid=c.oid and p.grantee<>c.relowner
  ) and not exists (
    select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ), t.name || ' denies all non-owner table and column access')
from ea_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;
select ok(c.oid is not null and not exists(select 1 from pg_policy p where p.polrelid=c.oid),
  t.name || ' has no client policies')
from ea_smoke_tables t left join pg_class c on c.oid=to_regclass('private.'||t.name) order by t.name;

-- Four migration-state assertions. No real person, qualification, delivery or
-- email quota is seeded. This smoke is for a freshly replayed local database.
select is((select jsonb_agg(to_jsonb(p)-'created_at' order by program_key) from private.early_access_programs p),
  '[{"program_key":"early_access_v1","policy_version":1,"configured":true,"free_access_rule":"until_beta","beta_starts_at":null,"price_retention":"lifetime_including_returners"}]'::jsonb,
  'only the approved until-beta/lifetime-returner policy is configured; beta remains unstarted');
select is((select count(*) from private.early_access_grants),0::bigint,'migration seeds no member grants');
select is((select count(*) from private.early_access_price_qualifications),0::bigint,'migration seeds no price qualifications');
select ok(not exists(select 1 from private.early_access_feedback)
  and not exists(select 1 from private.early_access_feedback_deliveries)
  and not exists(select 1 from private.transactional_email_reservations),'migration seeds no feedback, deliveries or quota');

create temporary table ea_smoke_helpers(signature text primary key, definer boolean not null);
insert into ea_smoke_helpers values
  ('private.guard_early_access_grant()',true),
  ('private.record_early_access_price_qualification()',true),
  ('private.guard_early_access_price_qualification()',false),
  ('private.early_access_active_for_user(uuid,timestamp with time zone)',true),
  ('private.require_member_current_session(uuid,uuid)',true),
  ('private.require_member_request_identity(uuid)',true),
  ('private.member_access_context(uuid)',true),
  ('private.member_beta_price_eligibility(uuid,uuid)',true),
  ('private.feedback_utf16_length(text)',false),
  ('private.reserve_transactional_email(uuid)',true),
  ('private.submit_early_access_feedback(uuid,uuid,jsonb,jsonb)',true),
  ('private.require_feedback_worker()',true);

-- 12 assertions: exact helper mode, empty search path and owner-only execute,
-- including PUBLIC and inherited application-role grants.
select ok(p.oid is not null and p.prosecdef=h.definer and p.proconfig @> array['search_path=""']
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner)
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_function_privilege(r,p.oid,'execute')), h.signature || ' remains internal with exact security mode')
from ea_smoke_helpers h left join pg_proc p on p.oid=to_regprocedure(h.signature) order by h.signature;

create temporary table ea_smoke_rpcs(signature text primary key, allowed_role text not null, call_sql text not null);
insert into ea_smoke_rpcs values
  ('public.get_member_access_context(uuid)','authenticated',
    'select public.get_member_access_context(''29000000-0000-4000-8000-000000000001'')'),
  ('public.submit_early_access_feedback(uuid,uuid,jsonb,jsonb)','authenticated',
    'select public.submit_early_access_feedback(''29000000-0000-4000-8000-000000000001'',''29000000-0000-4000-8000-000000000002'',''{}'',''{}'')'),
  ('public.get_beta_price_eligibility(uuid,uuid)','service_role',
    'select public.get_beta_price_eligibility(''29000000-0000-4000-8000-000000000001'',''29000000-0000-4000-8000-000000000002'')'),
  ('public.claim_early_access_feedback_deliveries(uuid,text,integer)','service_role',
    'select public.claim_early_access_feedback_deliveries(''29000000-0000-4000-8000-000000000002'',''linear'',5)'),
  ('public.bind_early_access_feedback_delivery(uuid,uuid,jsonb,text)','service_role',
    'select public.bind_early_access_feedback_delivery(''29000000-0000-4000-8000-000000000001'',''29000000-0000-4000-8000-000000000002'',''{}'',repeat(''a'',64))'),
  ('public.mark_early_access_feedback_dispatched(uuid,uuid,text)','service_role',
    'select public.mark_early_access_feedback_dispatched(''29000000-0000-4000-8000-000000000001'',''29000000-0000-4000-8000-000000000002'',repeat(''a'',64))'),
  ('public.settle_early_access_feedback_delivery(uuid,uuid,text,text,uuid,text)','service_role',
    'select public.settle_early_access_feedback_delivery(''29000000-0000-4000-8000-000000000001'',''29000000-0000-4000-8000-000000000002'',''uncertain'',''delivery_unconfirmed'',null,null)');

-- Seven assertions: no default PUBLIC EXECUTE or opposite application role;
-- the intended role has EXECUTE but never grant option.
select ok(p.oid is not null and p.prosecdef and p.proconfig @> array['search_path=""']
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee<>p.proowner and (a.grantee<>to_regrole(r.allowed_role) or a.is_grantable))
  and has_function_privilege(r.allowed_role,p.oid,'execute')
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
    where role_name<>r.allowed_role and has_function_privilege(role_name,p.oid,'execute')),
  r.signature || ' exposes only its intended guarded role with empty search path')
from ea_smoke_rpcs r left join pg_proc p on p.oid=to_regprocedure(r.signature) order by r.signature;

-- Assertion-library/temporary-inventory access only, not application data.
grant usage on schema extensions to anon,authenticated,service_role;
grant select on ea_smoke_rpcs to anon,authenticated,service_role;
set local request.jwt.claims='{}';
set local request.headers='{}';
set local role anon;
select throws_ok(call_sql,'42501',null,signature || ' rejects anonymous execution')
from ea_smoke_rpcs order by signature;
reset role;

set local role authenticated;
select throws_ok(call_sql,case when allowed_role='authenticated' then 'PT401' else '42501' end,null,
  signature || ' requires the live member or rejects member execution')
from ea_smoke_rpcs order by signature;
reset role;

set local request.jwt.claims='{"role":"service_role"}';
set local role service_role;
select throws_ok(call_sql,'42501',null,signature || ' rejects service-only member access')
from ea_smoke_rpcs where allowed_role='authenticated' order by signature;
-- A service credential does not invent the supplied member/session identity.
-- This is included below in the mixed-identity set, while native tests cover
-- healthy/expired/suspended sessions and complete submission/lease behavior.
select is(public.claim_early_access_feedback_deliveries('29000000-0000-4000-8000-000000000002','linear',5),
  '[]'::jsonb,'pure worker identity can read an empty queue without creating work');
reset role;

set local request.jwt.claims='{"role":"service_role","sub":"29000000-0000-4000-8000-000000000001"}';
set local role service_role;
select throws_ok(call_sql,'42501',null,signature || ' rejects a mixed service/member identity')
from ea_smoke_rpcs where allowed_role='service_role' order by signature;
reset role;

select * from finish();
rollback;
