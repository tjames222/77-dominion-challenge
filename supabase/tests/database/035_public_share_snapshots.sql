begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(35);

select ok(
  exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '20260720230000'
  ),
  'the public share snapshot migration was replayed'
);
select ok(to_regclass('public.public_share_snapshots') is not null, 'the public share snapshot table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.public_share_snapshots'::regclass),
  'public share snapshots have RLS enabled'
);
select is(
  (select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.public_share_snapshots'::regclass and attname = 'public_token_digest'),
  'bytea',
  'only a binary token digest is stored'
);
select ok(
  not has_function_privilege('authenticated', 'public.build_share_snapshot_payload(uuid,text)', 'execute'),
  'the internal payload builder is not client executable'
);
select ok(
  has_function_privilege('anon', 'public.get_public_share_snapshot(text)', 'execute'),
  'anonymous recipients can resolve an opaque public token'
);

insert into public.challenge_entries (
  user_id,
  entry_date,
  completed,
  workout_difficulty
) values (
  '10000000-0000-4000-8000-000000000001',
  '2026-07-10',
  array['bible', 'workoutOne', 'walk'],
  '{}'::jsonb
) on conflict (user_id, entry_date) do update set
  completed = excluded.completed,
  workout_difficulty = excluded.workout_difficulty;

insert into public.check_ins (
  id,
  user_id,
  entry_date,
  challenge_day,
  status,
  completed_count,
  points_awarded,
  created_at
) values (
  '51000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '2026-07-10',
  10,
  'partial',
  3,
  3,
  '2026-07-10 12:00:00+00'
) on conflict (user_id, entry_date) do nothing;

update public.user_game_stats
set current_app_streak = 12,
    best_app_streak = 18,
    current_full_day_streak = 5,
    best_full_day_streak = 9
where user_id = '10000000-0000-4000-8000-000000000001';

create temporary table share_test_values (
  label text primary key,
  snapshot_id uuid,
  token text not null
) on commit drop;
grant select, insert on share_test_values to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

select is(public.preview_share_snapshot('streak') ->> 'kind', 'streak', 'streak preview uses a typed payload');
select is((public.preview_share_snapshot('streak') #>> '{payload,appStreak}')::integer, 12, 'streak preview uses server app-streak state');
select is((public.preview_share_snapshot('streak') #>> '{payload,fullStandardStreak}')::integer, 5, 'streak preview uses server full-standard state');
select is((public.preview_share_snapshot('streak') #>> '{privacy,includesIdentity}')::boolean, false, 'the preview declares that identity is excluded');
select ok(public.preview_share_snapshot('streak')::text not ilike '%alice%', 'the preview does not expose a name or email');
select is((public.preview_share_snapshot('progress') #>> '{payload,currentChallengeDay}')::integer, 10, 'progress uses the authoritative latest challenge day');
select is((public.preview_share_snapshot('progress') #>> '{payload,challengeLength}')::integer, 77, 'progress includes the public challenge length');
select is((public.preview_share_snapshot('general') #>> '{payload,dailyStandards}')::integer, 7, 'general shares contain only fixed product facts');

with created as (
  select public.create_share_snapshot('streak') as result
)
insert into share_test_values (label, snapshot_id, token)
select 'alice-streak', (result ->> 'snapshotId')::uuid, result ->> 'token' from created;

select is(length((select token from share_test_values where label = 'alice-streak')), 64, 'created public tokens contain 256 bits of entropy');
select ok((select token from share_test_values where label = 'alice-streak') ~ '^[0-9a-f]{64}$', 'created public tokens are URL-safe lowercase hex');
reset role;
select ok(
  (
    select encode(public_token_digest, 'hex') <> values_row.token
    from public.public_share_snapshots snapshot_row
    join share_test_values values_row on values_row.snapshot_id = snapshot_row.id
    where values_row.label = 'alice-streak'
  ),
  'the usable public token is not stored'
);
set local role authenticated;
select throws_ok(
  $$ select count(*) from public.public_share_snapshots $$,
  '42501',
  'permission denied for table public_share_snapshots',
  'the current user cannot query snapshots directly'
);

reset role;

select is(
  public.get_public_share_snapshot((select token from share_test_values where label = 'alice-streak')) ->> 'kind',
  'streak',
  'a valid opaque token resolves the immutable snapshot'
);
select ok(
  public.get_public_share_snapshot((select token from share_test_values where label = 'alice-streak'))::text !~* 'alice|email|crew|journal|user_id',
  'the public response contains no identity, group, journal, or owner fields'
);
select is(
  (select aggregate_view_count from public.public_share_snapshots where id = (select snapshot_id from share_test_values where label = 'alice-streak')),
  2::bigint,
  'only an aggregate view counter is retained'
);
select is(public.get_public_share_snapshot('not-a-token'), null::jsonb, 'an invalid token fails closed');

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';
select is(
  public.revoke_share_snapshot((select snapshot_id from share_test_values where label = 'alice-streak')),
  false,
  'another user cannot revoke or infer ownership of a snapshot'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
select is(
  public.revoke_share_snapshot((select snapshot_id from share_test_values where label = 'alice-streak')),
  true,
  'the owner can revoke a snapshot'
);

reset role;
select is(
  public.get_public_share_snapshot((select token from share_test_values where label = 'alice-streak')),
  null::jsonb,
  'a revoked snapshot fails exactly like an unknown snapshot'
);

set local role authenticated;
select throws_ok(
  $$ select public.create_share_snapshot('general', now() + interval '91 days') $$,
  'P0001',
  'Share expiration must be between one hour and 90 days.',
  'client-selected expiration is bounded'
);
reset role;

insert into public.public_share_snapshots (
  user_id,
  public_token_digest,
  share_kind,
  snapshot_payload,
  expires_at,
  created_at
)
select
  '10000000-0000-4000-8000-000000000001',
  digest('rate-limit-' || series::text, 'sha256'),
  'general',
  '{"schemaVersion":1,"kind":"general"}'::jsonb,
  now() + interval '30 days',
  now()
from generate_series(1, 10) as series;

set local role authenticated;
select throws_ok(
  $$ select public.create_share_snapshot('general') $$,
  'P0001',
  'Share link rate limit reached. Try again later.',
  'creation is rate limited under a per-user advisory lock'
);
reset role;

delete from public.public_share_snapshots
where public_token_digest in (select digest('rate-limit-' || series::text, 'sha256') from generate_series(1, 10) as series);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';
with created as (
  select public.create_share_snapshot('progress') as result
)
insert into share_test_values (label, snapshot_id, token)
select 'carol-progress', (result ->> 'snapshotId')::uuid, result ->> 'token' from created;
with created as (
  select public.create_share_snapshot('general') as result
)
insert into share_test_values (label, snapshot_id, token)
select 'carol-general', (result ->> 'snapshotId')::uuid, result ->> 'token' from created;
reset role;

update public.profiles
set challenge_start_date = challenge_start_date + 1
where user_id = '30000000-0000-4000-8000-000000000003';

select is(
  (select revoked_reason from public.public_share_snapshots where id = (select snapshot_id from share_test_values where label = 'carol-progress')),
  'challenge_reset',
  'a challenge reset revokes progress and streak snapshots'
);
select is(
  (select revoked_reason from public.public_share_snapshots where id = (select snapshot_id from share_test_values where label = 'carol-general')),
  null::text,
  'a general advertisement remains valid across challenge resets'
);

insert into public.public_share_snapshots (
  user_id,
  public_token_digest,
  share_kind,
  snapshot_payload,
  expires_at,
  created_at
) values (
  '30000000-0000-4000-8000-000000000003',
  digest('expired-cleanup-fixture', 'sha256'),
  'general',
  '{"schemaVersion":1,"kind":"general"}'::jsonb,
  now() - interval '60 days',
  now() - interval '90 days'
);

select is(public.purge_retired_share_snapshots(interval '30 days'), 1::bigint, 'the bounded purge removes retired snapshots after retention');
select is(
  (select count(*)::integer from public.public_share_snapshots where public_token_digest = digest('expired-cleanup-fixture', 'sha256')),
  0,
  'the expired snapshot is removed without touching active links'
);
select throws_ok(
  $$ select public.purge_retired_share_snapshots(interval '1 hour') $$,
  'P0001',
  'Share retention must be between one and 365 days.',
  'retention cannot be shortened below the documented floor'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.public_share_snapshots'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%auth.users(id)%on delete cascade%'
  ),
  'account deletion cascades every owned snapshot'
);
select ok(
  not has_table_privilege('anon', 'public.public_share_snapshots', 'select')
  and not has_table_privilege('authenticated', 'public.public_share_snapshots', 'select'),
  'clients cannot enumerate snapshots through the table API'
);
select ok(
  has_function_privilege('authenticated', 'public.preview_share_snapshot(text)', 'execute')
  and has_function_privilege('authenticated', 'public.create_share_snapshot(text,timestamp with time zone)', 'execute')
  and has_function_privilege('authenticated', 'public.revoke_share_snapshot(uuid)', 'execute'),
  'only the documented authenticated snapshot lifecycle is exposed'
);

select * from finish();
rollback;
