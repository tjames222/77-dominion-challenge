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
    where version = '20260720100000'
  ),
  'the outbound consent migration was replayed'
);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260720110000'
  ),
  'the canonical outbound event migration was replayed'
);

select ok(
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'integration_destinations'
      and column_name in (
        'check_ins_enabled',
        'streak_milestones_enabled',
        'badges_rewards_enabled',
        'membership_enabled',
        'recap_cadence',
        'include_safe_link'
      )
  ) = 6,
  'provider destinations expose the six outbound event settings'
);

select ok(
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'outbound_deliveries'
      and column_name in ('subject_user_id', 'source_reference')
  ) = 2,
  'outbound deliveries retain a consent subject and private source reference'
);

select ok(
  to_regprocedure('private.outbound_event_payload_is_safe(text,jsonb)') is not null,
  'the strict outbound payload validator exists'
);
select ok(
  to_regprocedure('public.queue_due_leaderboard_recaps()') is not null,
  'the anonymous weekly recap queue RPC exists'
);
select ok(
  to_regprocedure('public.resolve_claimed_outbound_delivery(uuid,uuid)') is not null,
  'the send-time delivery resolver exists'
);
select ok(
  to_regprocedure('public.cancel_claimed_outbound_delivery(uuid,uuid,text)') is not null,
  'the claimed delivery cancellation RPC exists'
);
select ok(
  to_regprocedure('public.update_integration_destination_settings(uuid,uuid,boolean,boolean,boolean,boolean,text,boolean)') is not null,
  'the destination event settings RPC has the Edge contract signature'
);
select ok(
  to_regprocedure('public.claim_outbound_deliveries(uuid,integer)') is not null,
  'the delivery claim RPC remains available after adding consent context'
);
select ok(
  to_regprocedure('public.list_crew_integration_destinations(uuid)') is not null,
  'the member-readable destination list RPC remains available'
);
select ok(
  (
    select count(*)
    from pg_trigger trigger_row
    where not trigger_row.tgisinternal
      and trigger_row.tgname in (
        'emit_check_in_outbound_event',
        'emit_badge_outbound_event',
        'emit_challenge_reward_outbound_event',
        'emit_streak_milestone_outbound_event'
      )
  ) = 4,
  'canonical source tables have outbound event emitters'
);
select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where not trigger_row.tgisinternal
      and trigger_row.tgname = 'apply_outbound_preference_to_deliveries'
  ),
  'consent changes synchronously cancel pending member deliveries'
);
select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conname = 'integration_delivery_attempts_outcome_check'
      and pg_get_constraintdef(constraint_row.oid) like '%cancelled%'
  ),
  'delivery attempt history records send-time cancellations'
);

select ok(to_regclass('public.profiles') is not null, 'profiles exists');
select ok(to_regclass('public.challenge_entries') is not null, 'challenge_entries exists');
select ok(to_regclass('public.check_ins') is not null, 'check_ins exists');
select ok(to_regclass('public.game_point_events') is not null, 'game_point_events exists');
select ok(to_regclass('public.crews') is not null, 'crews exists');
select ok(to_regclass('public.challenge_definitions') is not null, 'challenge_definitions exists');
select ok(to_regclass('public.outbound_update_preferences') is not null, 'outbound_update_preferences exists');
select ok(to_regclass('public.outbound_update_preference_audit') is not null, 'outbound consent audit exists');

select ok(
  to_regprocedure('public.submit_daily_check_in(text,text[],jsonb,text,date)') is not null,
  'the check-in RPC has the expected signature'
);
select ok(to_regprocedure('public.record_app_visit()') is not null, 'the app-visit RPC exists');
select ok(to_regprocedure('public.join_crew_by_invite(text)') is not null, 'the crew invite RPC exists');
select ok(
  to_regprocedure('public.get_current_outbound_consent(uuid,uuid,text)') is not null,
  'the send-time consent RPC has the expected signature'
);
select ok(
  to_regprocedure('public.set_outbound_update_consent(uuid,boolean,text,boolean,boolean,boolean,boolean)') is not null,
  'the member consent RPC has the expected signature'
);
select is(
  (
    select procedure_row.pronargdefaults::integer
    from pg_proc procedure_row
    where procedure_row.oid = 'public.add_game_points(uuid,text,integer,date,integer,uuid,jsonb,text)'::regprocedure
  ),
  5,
  'the compatibility migration preserves the five trailing point-helper defaults'
);
select is(
  (
    select procedure_row.proargnames[3]
    from pg_proc procedure_row
    where procedure_row.oid = 'public.award_badge(uuid,text,date,jsonb)'::regprocedure
  ),
  'target_earned_date',
  'the daily-badge migration preserves the deployed badge-helper parameter name'
);

select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.challenge_entries'::regclass), 'challenge_entries has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.check_ins'::regclass), 'check_ins has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.game_point_events'::regclass), 'game_point_events has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.crews'::regclass), 'crews has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.community_posts'::regclass), 'community_posts has RLS enabled');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.outbound_update_preferences'::regclass),
  'outbound_update_preferences has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.outbound_update_preference_audit'::regclass),
  'outbound consent audit has RLS enabled'
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
