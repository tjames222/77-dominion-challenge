begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260707170000'
  ),
  'the pre-gamification baseline migration was replayed'
);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260708160000'
  ),
  'the gamification compatibility migration was replayed'
);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260716163000'
  ),
  'the latest develop migration was replayed'
);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260720210000'
  ),
  'the typed reward catalog migration was replayed'
);

select ok(to_regclass('public.profiles') is not null, 'profiles exists');
select ok(to_regclass('public.challenge_entries') is not null, 'challenge_entries exists');
select ok(to_regclass('public.check_ins') is not null, 'check_ins exists');
select ok(to_regclass('public.game_point_events') is not null, 'game_point_events exists');
select ok(to_regclass('public.crews') is not null, 'crews exists');
select ok(to_regclass('public.challenge_definitions') is not null, 'challenge_definitions exists');
select ok(to_regclass('public.reward_definitions') is not null, 'reward_definitions exists');
select ok(to_regclass('public.user_reward_entitlements') is not null, 'user_reward_entitlements exists');

select ok(
  to_regprocedure('public.submit_daily_check_in(text,text[],jsonb,text,date)') is not null,
  'the check-in RPC has the expected signature'
);
select ok(to_regprocedure('public.record_app_visit()') is not null, 'the app-visit RPC exists');
select ok(to_regprocedure('public.join_crew_by_invite(text)') is not null, 'the crew invite RPC exists');
select ok(
  to_regprocedure('public.get_reward_catalog(integer,integer,text)') is not null,
  'the typed reward catalog RPC exists'
);

select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.challenge_entries'::regclass), 'challenge_entries has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.check_ins'::regclass), 'check_ins has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.game_point_events'::regclass), 'game_point_events has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.crews'::regclass), 'crews has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.community_posts'::regclass), 'community_posts has RLS enabled');

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'check_ins'
      and indexname = 'check_ins_user_entry_date_unique_idx'
      and indexdef like 'CREATE UNIQUE INDEX%'
  ),
  'one check-in per user and entry date is enforced'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'check_ins'
      and indexname = 'check_ins_user_challenge_day_unique_idx'
      and indexdef like 'CREATE UNIQUE INDEX%'
  ),
  'one check-in per user and challenge day is enforced'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    join pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relname = 'game_point_events'
      and constraint_row.contype = 'u'
      and pg_get_constraintdef(constraint_row.oid) like '%idempotency_key%'
  ),
  'point-event idempotency keys are unique'
);

select is(
  (
    select count(*)::integer
    from auth.identities
    where provider = 'email'
      and user_id in (
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000003'
      )
  ),
  3,
  'the deterministic seed creates one email identity per fixture user'
);

select * from finish();
rollback;
