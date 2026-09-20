begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);
select has_function('public', 'get_daily_action_bootstrap', array['uuid','text','date']);
select ok(has_function_privilege('authenticated','public.get_daily_action_bootstrap(uuid,text,date)','execute'),'authenticated wrapper allowed');
select ok(not has_function_privilege('anon','public.get_daily_action_bootstrap(uuid,text,date)','execute'),'anon wrapper denied');
select ok(not has_function_privilege('service_role','public.get_daily_action_bootstrap(uuid,text,date)','execute'),'service wrapper denied');
select ok(not has_function_privilege('authenticated','private.daily_action_bootstrap(uuid,text,date)','execute'),'implementation private');
select is((select provolatile::text from pg_proc where oid='public.get_daily_action_bootstrap(uuid,text,date)'::regprocedure),'v','reconciliation is not marked stable');

insert into auth.users(id,email,raw_user_meta_data) values
  ('28000000-0000-4000-8000-000000000001','daily-bootstrap@example.test','{}'),
  ('28000000-0000-4000-8000-000000000002','daily-other@example.test','{}');
create temporary table daily_bootstrap_results(key text primary key,payload jsonb);
grant all on daily_bootstrap_results to authenticated;
set local request.jwt.claims='{"sub":"28000000-0000-4000-8000-000000000001","role":"authenticated","email":"daily-bootstrap@example.test"}';
set local role authenticated;
select throws_ok($$select public.get_daily_action_bootstrap(null,'UTC')$$,'40001',null,'expected actor required');
select throws_ok($$select public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000002','UTC')$$,'40001',null,'other actor denied');
select throws_ok($$select public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','Invalid/Zone')$$,'22023',null,'zone validated without access');
select throws_ok($$select public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','UTC','infinity')$$,'22023',null,'date validated without access');
insert into daily_bootstrap_results values('denied',public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','UTC'));
select is((select payload->>'appAccess' from daily_bootstrap_results where key='denied'),'false','no entitlement stays denied');
select is((select payload->'draft' from daily_bootstrap_results where key='denied'),'null'::jsonb,'denial contains no private draft');
select is(current_setting('response.headers')::jsonb,'[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]'::jsonb,'private no-store response');
reset role;
insert into public.entitlements(user_id,entitlement_key,status,source_type,source_id,ends_at)
values('28000000-0000-4000-8000-000000000001','membership_active','active','test','daily-bootstrap',null);
set local role authenticated;
insert into daily_bootstrap_results values('inert',public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','America/Los_Angeles'));
select is((select payload->>'appAccess' from daily_bootstrap_results where key='inert'),'true','membership distinct from activation');
select is((select payload->'activation'->>'status' from daily_bootstrap_results where key='inert'),'not_started','new member remains inert');
select is((select payload->'draft'->>'locked' from daily_bootstrap_results where key='inert'),'true','inert action locked');
select is((select payload->>'entryDate' from daily_bootstrap_results where key='inert'),
  (select ((payload->>'asOf')::timestamptz at time zone (payload->>'timeZone'))::date::text from daily_bootstrap_results where key='inert'),'canonical date selected by server');
reset role;
update public.profiles set challenge_activation_status='scheduled',challenge_participation_mode='solo',
  challenge_start_date=public.daily_standard_user_date(user_id),challenge_activation_time_zone='America/Los_Angeles',
  challenge_confirmed_at=statement_timestamp(),challenge_confirmed_by=user_id
where user_id='28000000-0000-4000-8000-000000000001';
set local role authenticated;
insert into daily_bootstrap_results values('due',public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','Pacific/Kiritimati'));
select is((select payload->'activation'->>'storedStatus' from daily_bootstrap_results where key='due'),'active','due schedule persisted');
select is((select payload->>'timeZone' from daily_bootstrap_results where key='due'),'America/Los_Angeles','activation time zone wins over browser');
select is((select payload->'draft'->>'locked' from daily_bootstrap_results where key='due'),'false','due current day unlocked');
select is((select array_agg(k order by k) from daily_bootstrap_results,jsonb_object_keys(payload)k where key='due'),
  array['activation','actorId','appAccess','asOf','draft','entryDate','schemaVersion','timeZone']::text[],'focused top-level allowlist only');
insert into daily_bootstrap_results values('past',public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','UTC',(select (payload->>'entryDate')::date-1 from daily_bootstrap_results where key='due')));
select is((select payload->'draft'->>'lock_reason' from daily_bootstrap_results where key='past'),'date_locked','requested historical day remains read-only');
reset role;
update public.entitlements set ends_at=now()-interval '1 second' where user_id='28000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','UTC')->>'appAccess','false','expired entitlement denied without client cache');
set local request.jwt.claims='{}';
select throws_ok($$select public.get_daily_action_bootstrap('28000000-0000-4000-8000-000000000001','UTC')$$,'28000',null,'missing actor rejected');
select * from finish();
rollback;
