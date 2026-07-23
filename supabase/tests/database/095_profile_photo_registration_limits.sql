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
select ok(has_function_privilege(
  'authenticated', 'public.register_profile_photo_upload(text)', 'execute'
), 'authenticated members retain the bounded registration RPC');
select ok(has_function_privilege(
  'service_role', 'public.profile_photo_registration_health()', 'execute'
), 'the service role can read aggregate registration health');
select ok(not has_function_privilege(
  'authenticated', 'public.profile_photo_registration_health()', 'execute'
), 'members cannot query aggregate registration health');
select ok(not has_function_privilege(
  'anon', 'public.profile_photo_registration_health()', 'execute'
), 'anonymous callers cannot query aggregate registration health');
select ok((
  select procedure_row.prosecdef
  from pg_proc procedure_row
  where procedure_row.oid =
    'public.profile_photo_registration_health()'::regprocedure
), 'aggregate health is a security-definer boundary over private state');

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
  challenge_start_date,
  time_zone
)
values
  ('f8000000-0000-4000-8000-000000000001',
    'Hourly Limit', 'hourly-limit@example.test', current_date, 'UTC'),
  ('f8000000-0000-4000-8000-000000000002',
    'Daily Limit', 'daily-limit@example.test', current_date, 'UTC'),
  ('f8000000-0000-4000-8000-000000000003',
    'Erasure Limit', 'erasure-limit@example.test', current_date, 'UTC');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok($$
  select public.register_profile_photo_upload(null)
$$, '22023', 'Invalid profile-photo upload path.',
  'a null path is rejected by the explicit path boundary');

create temp table first_registration as
select
  public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1730000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'
  ) as id;
reset role;
alter table first_registration add column upload_expires_at timestamptz;
update first_registration result
set upload_expires_at = registry.upload_expires_at
from private.profile_photo_objects registry
where registry.id = result.id;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table retried_registration as
select
  public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1730000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'
  ) as id;
reset role;

select is(
  (select id from retried_registration),
  (select id from first_registration),
  'an unexpired same-path retry returns the original registration id'
);
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where storage_path like '%aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'
), 1, 'an idempotent retry creates one lifecycle row');
select is((
  select count(*)::integer
  from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    '10000000-0000-4000-8000-000000000001/avatar-1730000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'
  )
), 1, 'an idempotent retry creates one permanent path reservation');
select is((
  select registry.upload_expires_at
  from private.profile_photo_objects registry
  where registry.id = (select id from first_registration)
), (select upload_expires_at from first_registration),
  'an idempotent retry never extends the upload expiry');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$
  do $block$
  begin
    perform public.register_profile_photo_upload(
      '10000000-0000-4000-8000-000000000001/avatar-1730000000002-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp'
    );
    perform public.register_profile_photo_upload(
      '10000000-0000-4000-8000-000000000001/avatar-1730000000003-cccccccccccccccccccccccccccccccc.jpg'
    );
  end;
  $block$
$$, 'two more registrations can fill the three-pending budget');
create temp table capped_retry_registration as
select public.register_profile_photo_upload(
  '10000000-0000-4000-8000-000000000001/avatar-1730000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'
) as id;
select throws_ok($$
  select public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1730000000004-dddddddddddddddddddddddddddddddd.webp'
  )
$$, 'P8001',
  'Too many profile-photo uploads are pending. Wait for one to expire or finish before retrying.',
  'a fourth active pending registration fails closed');
reset role;
select is(
  (select id from capped_retry_registration),
  (select id from first_registration),
  'same-path idempotency takes precedence even when the pending cap is full'
);
select is((
  select count(*)::integer
  from private.profile_photo_objects
  where user_id = '10000000-0000-4000-8000-000000000001'
), 3, 'a pending-cap rejection creates no lifecycle row');
select is((
  select count(*)::integer
  from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    '10000000-0000-4000-8000-000000000001/avatar-1730000000004-dddddddddddddddddddddddddddddddd.webp'
  )
), 0, 'a pending-cap rejection creates no tombstone');

insert into private.profile_photo_path_tombstones (path_sha256, reason)
select private.profile_photo_path_sha256(path_value), 'registered'
from (values
  ('30000000-0000-4000-8000-000000000003/avatar-1730000000010-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp'),
  ('30000000-0000-4000-8000-000000000003/avatar-1730000000011-ffffffffffffffffffffffffffffffff.webp')
) as paths(path_value);
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at, created_at
)
select
  '30000000-0000-4000-8000-000000000003',
  path_value,
  'pending_upload',
  clock_timestamp() - interval '1 minute',
  clock_timestamp() - interval '2 hours'
from (values
  ('30000000-0000-4000-8000-000000000003/avatar-1730000000010-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp'),
  ('30000000-0000-4000-8000-000000000003/avatar-1730000000011-ffffffffffffffffffffffffffffffff.webp')
) as paths(path_value);
set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
select lives_ok($$
  select public.register_profile_photo_upload(
    '30000000-0000-4000-8000-000000000003/avatar-1730000000012-11111111111111111111111111111111.webp'
  )
$$, 'a new registration can replace expired pending budget');
select throws_ok($$
  select public.register_profile_photo_upload(
    '30000000-0000-4000-8000-000000000003/avatar-1730000000010-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp'
  )
$$, '55000', 'Profile-photo paths are immutable and cannot be reused.',
  'an expired path cannot be reactivated after its one-way cleanup transition');
reset role;
select is((
  select state::text
  from private.profile_photo_objects
  where storage_path =
    '30000000-0000-4000-8000-000000000003/avatar-1730000000010-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp'
), 'cleanup',
  'a successful different-path admission normalizes the expired path before reuse is rejected');
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
set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
select throws_ok($$
  select public.register_profile_photo_upload(
    '20000000-0000-4000-8000-000000000002/avatar-1730000000021-22222222222222222222222222222222.webp'
  )
$$, 'P8002',
  'Profile-photo cleanup backlog is full. Finish cleanup before registering another upload.',
  'a full cleanup backlog blocks another registration');
reset role;
select is((
  select count(*)::integer from private.profile_photo_objects
  where storage_path like '%22222222222222222222222222222222.webp'
), 0, 'a cleanup-cap rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    '20000000-0000-4000-8000-000000000002/avatar-1730000000021-22222222222222222222222222222222.webp'
  )
), 0, 'a cleanup-cap rejection creates no tombstone');

set local role authenticated;
set local "request.jwt.claim.sub" = 'f8000000-0000-4000-8000-000000000001';
select lives_ok($$
  do $block$
  declare
    sequence_number integer;
    path_value text;
  begin
    for sequence_number in 1..6 loop
      path_value := 'f8000000-0000-4000-8000-000000000001/avatar-'
        || (1731000000000 + sequence_number)::text || '-'
        || md5('hourly-limit-' || sequence_number::text) || '.webp';
      perform public.register_profile_photo_upload(path_value);
      perform public.abandon_profile_photo_upload(path_value);
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
set local role authenticated;
set local "request.jwt.claim.sub" = 'f8000000-0000-4000-8000-000000000001';
select throws_ok($$
  select public.register_profile_photo_upload(
    'f8000000-0000-4000-8000-000000000001/avatar-1731000000007-33333333333333333333333333333333.webp'
  )
$$, 'P8003',
  'Profile-photo hourly registration limit reached. Try again later.',
  'the seventh rapid registration is rate limited');
reset role;
select is((
  select count(*)::integer from private.profile_photo_objects
  where storage_path like '%33333333333333333333333333333333.webp'
), 0, 'an hourly rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    'f8000000-0000-4000-8000-000000000001/avatar-1731000000007-33333333333333333333333333333333.webp'
  )
), 0, 'an hourly rejection creates no tombstone');

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
set local role authenticated;
set local "request.jwt.claim.sub" = 'f8000000-0000-4000-8000-000000000002';
select lives_ok($$
  do $block$
  begin
    perform public.register_profile_photo_upload(
      'f8000000-0000-4000-8000-000000000002/avatar-1732000000024-77777777777777777777777777777777.webp'
    );
    perform public.abandon_profile_photo_upload(
      'f8000000-0000-4000-8000-000000000002/avatar-1732000000024-77777777777777777777777777777777.webp'
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
set local role authenticated;
set local "request.jwt.claim.sub" = 'f8000000-0000-4000-8000-000000000002';
select throws_ok($$
  select public.register_profile_photo_upload(
    'f8000000-0000-4000-8000-000000000002/avatar-1732000000025-44444444444444444444444444444444.jpg'
  )
$$, 'P8004',
  'Profile-photo daily registration limit reached. Try again tomorrow.',
  'the twenty-fifth daily registration is rate limited');
reset role;
select is((
  select count(*)::integer from private.profile_photo_objects
  where storage_path like '%44444444444444444444444444444444.jpg'
), 0, 'a daily rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    'f8000000-0000-4000-8000-000000000002/avatar-1732000000025-44444444444444444444444444444444.jpg'
  )
), 0, 'a daily rejection creates no tombstone');

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

set local role authenticated;
set local "request.jwt.claim.sub" = 'f8000000-0000-4000-8000-000000000003';
select throws_ok($$
  select public.register_profile_photo_upload(
    'f8000000-0000-4000-8000-000000000003/avatar-1733000000001-55555555555555555555555555555555.webp'
  )
$$, '55000', 'Profile assets are frozen while account erasure is pending.',
  'account-erasure freeze takes precedence over registration admission');
reset role;
select is((
  select state::text
  from private.profile_photo_objects
  where storage_path =
    'f8000000-0000-4000-8000-000000000003/avatar-1733000000000-66666666666666666666666666666666.webp'
), 'pending_upload',
  'account-erasure rejection occurs before expired pending rows are mutated');
select is((
  select count(*)::integer from private.profile_photo_objects
  where storage_path like '%55555555555555555555555555555555.webp'
), 0, 'an account-erasure rejection creates no lifecycle row');
select is((
  select count(*)::integer from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    'f8000000-0000-4000-8000-000000000003/avatar-1733000000001-55555555555555555555555555555555.webp'
  )
), 0, 'an account-erasure rejection creates no tombstone');

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
