begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(44);

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
    where version = '20260721010000'
  ),
  'the Sharing reward migration was replayed'
);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260721000000'
  ),
  'the hardened private-group invite migration was replayed'
);

select ok(to_regclass('public.profiles') is not null, 'profiles exists');
select ok(to_regclass('public.challenge_entries') is not null, 'challenge_entries exists');
select ok(to_regclass('public.check_ins') is not null, 'check_ins exists');
select ok(to_regclass('public.game_point_events') is not null, 'game_point_events exists');
select ok(to_regclass('public.crews') is not null, 'crews exists');
select ok(to_regclass('public.crew_invite_sessions') is not null, 'invite continuations exist');
select ok(to_regclass('public.crew_invite_attributions') is not null, 'invite attribution audit records exist');
select ok(to_regclass('public.challenge_definitions') is not null, 'challenge_definitions exists');
select ok(to_regclass('public.sharing_reward_intents') is not null, 'sharing_reward_intents exists');
select ok(to_regclass('public.sharing_reward_evidence') is not null, 'sharing_reward_evidence exists');
select ok(to_regclass('public.sharing_reward_grants') is not null, 'sharing_reward_grants exists');

select ok(
  to_regprocedure('public.submit_daily_check_in(text,text[],jsonb,text,date)') is not null,
  'the check-in RPC has the expected signature'
);
select ok(to_regprocedure('public.record_app_visit()') is not null, 'the app-visit RPC exists');
select ok(to_regprocedure('public.create_sharing_reward_intent(text)') is not null, 'the Sharing intent RPC exists');
select ok(to_regprocedure('public.complete_sharing_reward(text)') is not null, 'the Sharing completion RPC exists');
select ok(
  to_regprocedure('public.record_confirmed_group_invite_share(uuid,uuid)') is not null,
  'the confirmed-invite Sharing hook exists'
);
select ok(
  to_regprocedure('public.record_confirmed_group_invite_share(uuid)') is not null,
  'the attribution-only Sharing hook exists'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.crew_invite_attributions'::regclass
      and tgname = 'grant_sharing_reward_after_invite_redemption'
      and not tgisinternal
  ),
  'confirmed invite attribution automatically invokes the Sharing reward'
);
select ok(to_regprocedure('public.issue_crew_invite(uuid)') is not null, 'the server-authoritative invite issuance RPC exists');
select ok(to_regprocedure('public.revoke_crew_invite(uuid)') is not null, 'the server-authoritative invite revocation RPC exists');
select ok(to_regprocedure('public.preview_crew_invite(text,text)') is not null, 'the privacy-safe invite preview RPC exists');
select ok(to_regprocedure('public.confirm_crew_invite(text)') is not null, 'the explicit invite confirmation RPC exists');

select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.challenge_entries'::regclass), 'challenge_entries has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.check_ins'::regclass), 'check_ins has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.game_point_events'::regclass), 'game_point_events has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.crews'::regclass), 'crews has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.community_posts'::regclass), 'community_posts has RLS enabled');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sharing_reward_intents'::regclass),
  'sharing_reward_intents has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sharing_reward_evidence'::regclass),
  'sharing_reward_evidence has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sharing_reward_grants'::regclass),
  'sharing_reward_grants has RLS enabled'
);

select ok(
  exists (select 1 from public.badge_definitions where badge_key = 'sharing'),
  'the all-badges catalog includes the permanent Sharing badge'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.crew_invite_sessions'::regclass),
  'invite continuations have RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.crew_invite_attributions'::regclass),
  'invite attributions have RLS enabled'
);
select ok(
  not has_column_privilege('authenticated', 'public.crew_invites', 'token_hash', 'select'),
  'authenticated clients cannot select invite token hashes'
);

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
