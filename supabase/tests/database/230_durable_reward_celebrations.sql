begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

select ok(exists(select 1 from supabase_migrations.schema_migrations where version='20260913035046'), 'durable reward delivery migration was replayed');
select ok((select relrowsecurity from pg_class where oid='private.reward_celebration_claims'::regclass), 'private delivery claims have RLS enabled');
select ok(not has_table_privilege('authenticated','private.reward_celebration_claims','SELECT'), 'members cannot inspect delivery leases directly');
select ok(not has_table_privilege('authenticated','private.reward_celebration_claims','INSERT,UPDATE,DELETE'), 'members cannot write delivery leases directly');
select ok(has_function_privilege('authenticated','public.claim_reward_celebrations(uuid,uuid)','EXECUTE'), 'members can request actor-bound delivery');
select ok(has_function_privilege('authenticated','public.acknowledge_reward_celebrations(uuid,uuid,text[])','EXECUTE'), 'members can acknowledge actor-bound delivery');
select ok(not has_function_privilege('anon','public.claim_reward_celebrations(uuid,uuid)','EXECUTE'), 'anonymous callers cannot claim rewards');
select ok(not has_function_privilege('anon','public.acknowledge_reward_celebrations(uuid,uuid,text[])','EXECUTE'), 'anonymous callers cannot acknowledge rewards');
select trigger_is('public','user_reward_entitlements','stamp_reward_celebration_milestone','private','stamp_reward_celebration_milestone','new grants snapshot their actual point milestone');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.claim_reward_celebrations(uuid,uuid)'::regprocedure), 'claim uses a pinned definer search path');
select throws_ok($$select public.claim_reward_celebrations('99999999-0000-4000-8000-000000000099','99999999-0000-4000-8000-000000000098')$$,
  '42501','The signed-in account changed. Try again.','a missing authenticated actor cannot acquire a lease');
select throws_ok($$select public.acknowledge_reward_celebrations('99999999-0000-4000-8000-000000000099','99999999-0000-4000-8000-000000000098',array['dominion_night_theme'])$$,
  '42501','The signed-in account changed. Try again.','a missing authenticated actor cannot mark a reward seen');

select * from finish();
rollback;
