begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(44);

select ok(exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20260723162027'
), 'the profile-photo admission-limit migration was replayed');
select ok(exists (
  select 1
  from pg_index index_row
  where index_row.indexrelid =
    'private.profile_photo_objects_user_created_at_idx'::regclass
), 'registration history has a per-user server-time index');
select ok(not has_function_privilege(
  'authenticated', 'public.register_profile_photo_upload(text)', 'execute'
), 'authenticated members cannot call the deprecated browser registration RPC');
select ok(has_function_privilege(
  'service_role',
  'public.reserve_profile_photo_upload_service(uuid,uuid,text)',
  'execute'
), 'the service role can reserve a trusted profile-photo upload');
select ok(not has_function_privilege(
  'authenticated', 'public.profile_photo_registration_health()', 'execute'
), 'members cannot query aggregate registration health');
select ok(not has_function_privilege(
  'anon', 'public.profile_photo_registration_health()', 'execute'
), 'anonymous callers cannot query aggregate registration health');
select ok((
  select procedure_row.prosecdef
    and has_function_privilege(
      'service_role',
      'public.profile_photo_registration_health()',
      'execute'
    )
  from pg_proc procedure_row
  where procedure_row.oid =
    'public.profile_photo_registration_health()'::regprocedure
), 'aggregate health is a service-only security-definer boundary over private state');

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
select
  '00000000-0000-0000-0000-000000000000',
  fixture.id,
  'authenticated',
  'authenticated',
  fixture.email,
  '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('name', fixture.name),
  clock_timestamp(),
  clock_timestamp()
from (values
  ('f8000000-0000-4000-8000-000000000001'::uuid,
    'hourly-limit@example.test', 'Hourly Limit'),
  ('f8000000-0000-4000-8000-000000000002'::uuid,
    'daily-limit@example.test', 'Daily Limit'),
  ('f8000000-0000-4000-8000-000000000003'::uuid,
    'erasure-limit@example.test', 'Erasure Limit')
) as fixture(id, email, name);

insert into public.profiles (
  user_id,
  name,
  email,
  time_zone
)
values
  ('f8000000-0000-4000-8000-000000000001',
    'Hourly Limit', 'hourly-limit@example.test', 'UTC'),
  ('f8000000-0000-4000-8000-000000000002',
    'Daily Limit', 'daily-limit@example.test', 'UTC'),
  ('f8000000-0000-4000-8000-000000000003',
    'Erasure Limit', 'erasure-limit@example.test', 'UTC');

set local role service_role;

select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    '10000000-0000-4000-8000-000000000001',
    null,
    repeat('0', 64)
  )
$$, '22023', 'Invalid trusted profile-photo reservation.',
  'a null request ID is rejected by the trusted reservation boundary');

create temp table first_registration as
select
  public.reserve_profile_photo_upload_service(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000001',
    repeat('a', 64)
  ) as id;
reset role;
alter table first_registration add column upload_expires_at timestamptz;
update first_registration result
set upload_expires_at = registry.upload_expires_at
from private.profile_photo_objects registry
where registry.id = (result.id->>'registrationId')::uuid;

set local role service_role;
create temp table retried_registration as
select
  public.reserve_profile_photo_upload_service(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000001',
    repeat('a', 64)
  ) as id;
reset role;

select is(
  (select id->>'registrationId' from retried_registration),
  (select id->>'registrationId' from first_registration),
  'an unexpired same-request retry returns the original registration id'
);
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where upload_request_id = '95000000-0000-4000-8000-000000000001'
), 1, 'an idempotent retry creates one lifecycle row');
select is((
  select count(*)::integer
  from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    (select id->>'storagePath' from first_registration)
  )
), 1, 'an idempotent retry creates one permanent path reservation');
select is((
  select registry.upload_expires_at
  from private.profile_photo_objects registry
  where registry.id = (
    select (id->>'registrationId')::uuid from first_registration
  )
), (select upload_expires_at from first_registration),
  'an idempotent retry never extends the upload expiry');

set local role service_role;
select lives_ok($$
  do $block$
  begin
    perform public.reserve_profile_photo_upload_service(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000002',
      repeat('b', 64)
    );
    perform public.reserve_profile_photo_upload_service(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000003',
      repeat('c', 64)
    );
  end;
  $block$
$$, 'two more registrations can fill the three-pending budget');
reset role;
create temp table pending_cap_tombstones_before as
select count(*)::integer as count from private.profile_photo_path_tombstones;

set local role service_role;
create temp table capped_retry_registration as
select public.reserve_profile_photo_upload_service(
  '10000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  repeat('a', 64)
) as id;
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000004',
    repeat('d', 64)
  )
$$, 'P8001', 'Too many profile-photo uploads are pending.',
  'a fourth active pending registration fails closed');
reset role;
select is(
  (select id->>'registrationId' from capped_retry_registration),
  (select id->>'registrationId' from first_registration),
  'same-request idempotency takes precedence even when the pending cap is full'
);
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = '10000000-0000-4000-8000-000000000001'
), 3, 'a pending-cap rejection creates no lifecycle row');
select is((
  select count(*)::integer
  from private.profile_photo_path_tombstones
), (select count from pending_cap_tombstones_before),
  'a pending-cap rejection creates no tombstone');

insert into private.profile_photo_path_tombstones (path_sha256, reason)
select private.profile_photo_path_sha256(path_value), 'registered'
from (values
  ('30000000-0000-4000-8000-000000000003/avatar-1730000000010-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp'),
  ('30000000-0000-4000-8000-000000000003/avatar-1730000000011-ffffffffffffffffffffffffffffffff.webp')
) as paths(path_value);
insert into private.profile_photo_objects (
  user_id,
  storage_path,
  state,
  upload_expires_at,
  upload_request_id,
  source_sha256,
  created_at
)
select
  '30000000-0000-4000-8000-000000000003',
  path_value,
  'pending_upload',
  clock_timestamp() - interval '1 minute',
  request_id,
  source_sha256,
  clock_timestamp() - interval '2 hours'
from (values
  (
    '30000000-0000-4000-8000-000000000003/avatar-1730000000010-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp',
    '95000000-0000-4000-8300-000000000010'::uuid,
    repeat('e', 64)
  ),
  (
    '30000000-0000-4000-8000-000000000003/avatar-1730000000011-ffffffffffffffffffffffffffffffff.webp',
    '95000000-0000-4000-8300-000000000011'::uuid,
    repeat('f', 64)
  )
) as paths(path_value, request_id, source_sha256);
set local role service_role;
select lives_ok($$
  select public.reserve_profile_photo_upload_service(
    '30000000-0000-4000-8000-000000000003',
    '95000000-0000-4000-8300-000000000012',
    repeat('1', 64)
  )
$$, 'a new registration can replace expired pending budget');
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    '30000000-0000-4000-8000-000000000003',
    '95000000-0000-4000-8300-000000000010',
    repeat('e', 64)
  )
$$, '55000', 'The profile-photo request is no longer active.',
  'an expired request cannot be reactivated after its one-way cleanup transition');
reset role;
select is((
  select state::text
  from private.profile_photo_objects
  where upload_request_id = '95000000-0000-4000-8300-000000000010'
), 'cleanup',
  'a successful different-request admission normalizes expired work before reuse is rejected');
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = '30000000-0000-4000-8000-000000000003'
    and state = 'cleanup'
), 2, 'expired pending registrations move one-way into cleanup');
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = '30000000-0000-4000-8000-000000000003'
    and state = 'pending_upload'
), 1, 'the newly admitted path is the only pending registration');

with paths as (
  select
    '20000000-0000-4000-8000-000000000002/avatar-'
      || lpad(sequence_number::text, 13, '0') || '-'
      || md5('cleanup-limit-' || sequence_number::text) || '.webp' as path_value
  from generate_series(1, 20) sequence_number
)
insert into private.profile_photo_path_tombstones (path_sha256, reason)
select private.profile_photo_path_sha256(path_value), 'registered' from paths;
with paths as (
  select
    '20000000-0000-4000-8000-000000000002/avatar-'
      || lpad(sequence_number::text, 13, '0') || '-'
      || md5('cleanup-limit-' || sequence_number::text) || '.webp' as path_value
  from generate_series(1, 20) sequence_number
)
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at, created_at
)
select
  '20000000-0000-4000-8000-000000000002',
  path_value,
  'cleanup',
  null,
  clock_timestamp() - interval '2 days'
from paths;
create temp table cleanup_cap_tombstones_before as
select count(*)::integer as count from private.profile_photo_path_tombstones;

set local role service_role;
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    '20000000-0000-4000-8000-000000000002',
    '95000000-0000-4000-8200-000000000021',
    repeat('2', 64)
  )
$$, 'P8002', 'Profile-photo cleanup backlog is full.',
  'a full cleanup backlog blocks another registration');
reset role;
select is((
  select count(*)::integer from private.profile_photo_objects
  where upload_request_id = '95000000-0000-4000-8200-000000000021'
), 0, 'a cleanup-cap rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
), (select count from cleanup_cap_tombstones_before),
  'a cleanup-cap rejection creates no tombstone');

set local role service_role;
select lives_ok($$
  do $block$
  declare
    sequence_number integer;
    registration jsonb;
    request_id uuid;
    source_sha256 text;
  begin
    for sequence_number in 1..6 loop
      request_id := (
        '95000000-0000-4000-8400-'
        || lpad(sequence_number::text, 12, '0')
      )::uuid;
      source_sha256 := md5('hourly-limit-' || sequence_number::text)
        || md5('hourly-limit-' || sequence_number::text);
      registration := public.reserve_profile_photo_upload_service(
        'f8000000-0000-4000-8000-000000000001',
        request_id,
        source_sha256
      );
      perform public.abandon_profile_photo_upload_service(
        'f8000000-0000-4000-8000-000000000001',
        (registration->>'registrationId')::uuid
      );
    end loop;
  end;
  $block$
$$, 'six rapid sequential registrations are admitted and abandoned safely');
reset role;
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = 'f8000000-0000-4000-8000-000000000001'
    and created_at >= clock_timestamp() - interval '1 hour'
), 6, 'the hourly window counts successful distinct registrations');
create temp table hourly_tombstones_before as
select count(*)::integer as count from private.profile_photo_path_tombstones;

set local role service_role;
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    'f8000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8400-000000000007',
    repeat('3', 64)
  )
$$, 'P8003', 'Profile-photo hourly registration limit reached.',
  'the seventh rapid registration is rate limited');
reset role;
select is((
  select count(*)::integer from private.profile_photo_objects
  where upload_request_id = '95000000-0000-4000-8400-000000000007'
), 0, 'an hourly rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
), (select count from hourly_tombstones_before),
  'an hourly rejection creates no tombstone');

with paths as (
  select
    'f8000000-0000-4000-8000-000000000002/avatar-'
      || (1732000000000 + sequence_number)::text || '-'
      || md5('daily-limit-' || sequence_number::text) || '.webp' as path_value
  from generate_series(1, 23) sequence_number
)
insert into private.profile_photo_path_tombstones (
  path_sha256, retired_at, reason
)
select
  private.profile_photo_path_sha256(path_value),
  clock_timestamp() - interval '2 hours',
  'cleanup'
from paths;
with paths as (
  select
    'f8000000-0000-4000-8000-000000000002/avatar-'
      || (1732000000000 + sequence_number)::text || '-'
      || md5('daily-limit-' || sequence_number::text) || '.webp' as path_value
  from generate_series(1, 23) sequence_number
)
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at, retired_at, created_at
)
select
  'f8000000-0000-4000-8000-000000000002',
  path_value,
  'retired',
  null,
  clock_timestamp() - interval '2 hours',
  clock_timestamp() - interval '2 hours'
from paths;
set local role service_role;
select lives_ok($$
  do $block$
  declare
    registration jsonb;
  begin
    registration := public.reserve_profile_photo_upload_service(
      'f8000000-0000-4000-8000-000000000002',
      '95000000-0000-4000-8500-000000000024',
      repeat('7', 64)
    );
    perform public.abandon_profile_photo_upload_service(
      'f8000000-0000-4000-8000-000000000002',
      (registration->>'registrationId')::uuid
    );
  end;
  $block$
$$, 'the twenty-fourth daily registration is admitted at the exact boundary');
reset role;
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = 'f8000000-0000-4000-8000-000000000002'
    and created_at >= clock_timestamp() - interval '24 hours'
), 24, 'the rolling daily window counts all twenty-four admitted paths');
create temp table daily_tombstones_before as
select count(*)::integer as count from private.profile_photo_path_tombstones;

set local role service_role;
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    'f8000000-0000-4000-8000-000000000002',
    '95000000-0000-4000-8500-000000000025',
    repeat('4', 64)
  )
$$, 'P8004', 'Profile-photo daily registration limit reached.',
  'the twenty-fifth daily registration is rate limited');
reset role;
select is((
  select count(*)::integer from private.profile_photo_objects
  where upload_request_id = '95000000-0000-4000-8500-000000000025'
), 0, 'a daily rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
), (select count from daily_tombstones_before),
  'a daily rejection creates no tombstone');

set local role authenticated;
set local "request.jwt.claim.sub" = 'f8000000-0000-4000-8000-000000000003';
select lives_ok($$
  select public.request_retired_community_account_erasure(false)
$$, 'account erasure can seal before a registration attempt');
reset role;

insert into private.profile_photo_path_tombstones (path_sha256, reason)
values (
  private.profile_photo_path_sha256(
    'f8000000-0000-4000-8000-000000000003/avatar-1733000000000-66666666666666666666666666666666.webp'
  ),
  'registered'
);
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at, created_at
)
values (
  'f8000000-0000-4000-8000-000000000003',
  'f8000000-0000-4000-8000-000000000003/avatar-1733000000000-66666666666666666666666666666666.webp',
  'pending_upload',
  clock_timestamp() - interval '1 minute',
  clock_timestamp() - interval '2 days'
);
create temp table erasure_tombstones_before as
select count(*)::integer as count from private.profile_photo_path_tombstones;

set local role service_role;
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    'f8000000-0000-4000-8000-000000000003',
    '95000000-0000-4000-8600-000000000001',
    repeat('5', 64)
  )
$$, '55000', 'Profile assets are frozen while account erasure is pending.',
  'account-erasure freeze takes precedence over registration admission');
reset role;
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = 'f8000000-0000-4000-8000-000000000003'
    and state = 'pending_upload'
), 1,
  'account-erasure rejection occurs before expired pending rows are mutated');
select is((
  select count(*)::integer from private.profile_photo_objects
  where upload_request_id = '95000000-0000-4000-8600-000000000001'
), 0, 'an account-erasure rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
), (select count from erasure_tombstones_before),
  'an account-erasure rejection creates no tombstone');

create temp table profile_photo_health_result as
select public.profile_photo_registration_health() as result;
select is(
  (select result -> 'thresholds' from profile_photo_health_result),
  '{"pending":3,"cleanup":20,"perHour":6,"perDay":24}'::jsonb,
  'aggregate health reports the reviewed admission thresholds'
);
select ok((
  select result ?& array[
    'totalLifecycleRows',
    'totalPathTombstones',
    'registrationsLastHour',
    'registrationsLastDay',
    'pendingRegistrations',
    'pendingObjects',
    'expiredPendingRegistrations',
    'expiredPendingObjects',
    'cleanupRegistrations',
    'cleanupObjects',
    'effectiveCleanupRegistrations',
    'effectiveCleanupObjects',
    'oldestExpiredPendingCreatedAt',
    'usersAtPendingLimit',
    'usersAtCleanupLimit',
    'usersAtHourlyLimit',
    'usersAtDailyLimit',
    'generatedAt'
  ]
  from profile_photo_health_result
), 'aggregate health includes admission, object, cleanup, and saturation signals');
select ok((
  select result::text !~ 'avatar-[0-9]'
    and result::text not like '%10000000-0000-4000-8000-000000000001%'
    and result::text not like '%f8000000-0000-4000-8000-000000000001%'
  from profile_photo_health_result
), 'aggregate health exposes no object path or user identifier');
select is(
  (select jsonb_build_object(
    'usersAtPendingLimit', result -> 'usersAtPendingLimit',
    'usersAtCleanupLimit', result -> 'usersAtCleanupLimit',
    'usersAtHourlyLimit', result -> 'usersAtHourlyLimit',
    'usersAtDailyLimit', result -> 'usersAtDailyLimit'
  ) from profile_photo_health_result),
  '{"usersAtPendingLimit":1,"usersAtCleanupLimit":1,"usersAtHourlyLimit":1,"usersAtDailyLimit":1}'::jsonb,
  'aggregate saturation counts identify bounded abuse without identifying members'
);

select * from finish();
rollback;
