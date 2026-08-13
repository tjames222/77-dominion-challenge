begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

select ok(exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20260813193158'
), 'the trusted profile-photo upload migration was replayed');
select is((select allowed_mime_types from storage.buckets
  where id = 'profile-photos'), array['image/webp']::text[],
  'the profile-photo bucket accepts only trusted WebP output');
select ok(not exists (
  select 1 from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'Users can upload own profile photo objects'
), 'authenticated browsers have no profile-photo Storage insert policy');
select ok(not has_function_privilege('authenticated',
  'public.profile_photo_storage_insert_is_allowed(uuid,text)', 'execute'),
  'the legacy browser Storage-insert helper is revoked');

select ok(has_function_privilege('service_role',
  'public.reserve_profile_photo_upload_service(uuid,uuid,text)', 'execute'),
  'the service role can reserve a trusted upload');
select ok(not has_function_privilege('authenticated',
  'public.reserve_profile_photo_upload_service(uuid,uuid,text)', 'execute'),
  'authenticated clients cannot reserve through the trusted service RPC');
select ok(not has_function_privilege('anon',
  'public.reserve_profile_photo_upload_service(uuid,uuid,text)', 'execute'),
  'anonymous clients cannot reserve through the trusted service RPC');
select ok(has_function_privilege('service_role',
  'public.finalize_profile_photo_upload_service(uuid,uuid,text,text,integer,integer,integer)',
  'execute'), 'the service role can finalize trusted output metadata');
select ok(not has_function_privilege('authenticated',
  'public.finalize_profile_photo_upload_service(uuid,uuid,text,text,integer,integer,integer)',
  'execute'), 'authenticated clients cannot forge trusted output metadata');
select ok(has_function_privilege('service_role',
  'public.abandon_profile_photo_upload_service(uuid,uuid)', 'execute'),
  'the service role can abandon an unverified upload');
select ok(not has_function_privilege('authenticated',
  'public.abandon_profile_photo_upload_service(uuid,uuid)', 'execute'),
  'authenticated clients cannot call the trusted abandon RPC');

select is((
  select count(*)::integer
  from information_schema.columns
  where table_schema = 'private'
    and table_name = 'profile_photo_objects'
    and column_name in (
      'upload_request_id',
      'source_sha256',
      'verified_output_sha256',
      'verified_size_bytes',
      'verified_width',
      'verified_height',
      'verified_at'
    )
), 7, 'the registry persists request and immutable verified-output metadata');
select ok(to_regclass('private.profile_photo_objects_upload_request_idx') is not null,
  'trusted upload request IDs have a per-user unique index');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'f8010000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'trusted-photo@example.test',
  '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
  clock_timestamp(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Trusted Photo"}'::jsonb, clock_timestamp(), clock_timestamp()
);
insert into public.profiles (user_id, name, email, time_zone) values (
  'f8010000-0000-4000-8000-000000000001',
  'Trusted Photo', 'trusted-photo@example.test', 'UTC'
);

set local role service_role;
create temp table trusted_reservation as
select public.reserve_profile_photo_upload_service(
  'f8010000-0000-4000-8000-000000000001',
  'f8010000-0000-4000-8000-000000000002',
  repeat('a', 64)
) as result;
reset role;
grant select on trusted_reservation to authenticated, service_role;

select ok((select (result->>'registrationId')::uuid is not null
  from trusted_reservation), 'the service reserves an opaque registration ID');
select ok((select result->>'storagePath' ~ (
  '^f8010000-0000-4000-8000-000000000001/'
  || 'avatar-[0-9]{13}-[a-f0-9]{32}[.]webp$'
) from trusted_reservation), 'the service creates an immutable owned WebP path');
select is((select registry.source_sha256
  from private.profile_photo_objects registry
  where registry.id = (select (result->>'registrationId')::uuid
    from trusted_reservation)), repeat('a', 64),
  'the reservation binds the exact source digest');

set local role service_role;
create temp table trusted_retry as
select public.reserve_profile_photo_upload_service(
  'f8010000-0000-4000-8000-000000000001',
  'f8010000-0000-4000-8000-000000000002',
  repeat('a', 64)
) as result;
grant select on trusted_retry to authenticated, service_role;
select throws_ok($$
  select public.reserve_profile_photo_upload_service(
    'f8010000-0000-4000-8000-000000000001',
    'f8010000-0000-4000-8000-000000000002',
    repeat('b', 64)
  )
$$, '55000', 'A profile-photo request ID cannot be reused for different bytes.',
  'a request ID cannot be replayed with different bytes');
reset role;
select is((select result->>'registrationId' from trusted_retry),
  (select result->>'registrationId' from trusted_reservation),
  'an exact request retry returns the same registration');
select is((select count(*)::integer from private.profile_photo_objects
  where upload_request_id = 'f8010000-0000-4000-8000-000000000002'), 1,
  'an exact request retry creates no duplicate registry row');

set local role authenticated;
set local "request.jwt.claim.sub" = 'f8010000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"f8010000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format($sql$
  insert into storage.objects (id, bucket_id, name, owner, metadata) values (
    'f8010000-0000-4000-8000-000000000003',
    'profile-photos', %L, 'f8010000-0000-4000-8000-000000000001',
    '{"mimetype":"image/webp","size":512}'::jsonb
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  '42501', 'new row violates row-level security policy for table "objects"',
  'an authenticated browser cannot upload even to a trusted reserved path');
reset role;

insert into storage.objects (id, bucket_id, name, owner, metadata) values (
  'f8010000-0000-4000-8000-000000000003',
  'profile-photos', (select result->>'storagePath' from trusted_reservation),
  'f8010000-0000-4000-8000-000000000001',
  '{"mimetype":"image/webp","size":512}'::jsonb
);
select is((select registry.storage_object_id
  from private.profile_photo_objects registry
  where registry.id = (select (result->>'registrationId')::uuid
    from trusted_reservation)),
  'f8010000-0000-4000-8000-000000000003'::uuid,
  'the Storage trigger binds the exact trusted object to its registration');

set local role authenticated;
set local "request.jwt.claim.sub" = 'f8010000-0000-4000-8000-000000000001';
select throws_ok(format($sql$
  select public.commit_profile_photo_upload(
    %L,
    (select updated_at from public.profiles
      where user_id = 'f8010000-0000-4000-8000-000000000001'),
    false, null, null
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  '23514',
  'new row for relation "profile_photo_objects" violates check constraint "profile_photo_objects_canonical_verified_check"',
  'the lifecycle constraint blocks an unverified object before avatar mutation');
reset role;

set local role service_role;
select throws_ok(format($sql$
  select public.finalize_profile_photo_upload_service(
    'f8010000-0000-4000-8000-000000000001',
    (select (result->>'registrationId')::uuid from trusted_reservation),
    %L, repeat('c', 64), 512, 64, 32
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  '22023', 'Invalid trusted profile-photo finalization.',
  'the service cannot finalize a non-square thumbnail');
select throws_ok(format($sql$
  select public.finalize_profile_photo_upload_service(
    'f8010000-0000-4000-8000-000000000099',
    (select (result->>'registrationId')::uuid from trusted_reservation),
    %L, repeat('c', 64), 512, 32, 32
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  '22023', 'Invalid trusted profile-photo finalization.',
  'the service cannot finalize a path under another actor');
select lives_ok(format($sql$
  select public.finalize_profile_photo_upload_service(
    'f8010000-0000-4000-8000-000000000001',
    (select (result->>'registrationId')::uuid from trusted_reservation),
    %L, repeat('c', 64), 512, 32, 32
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  'the service finalizes exact square WebP output metadata');
reset role;

select ok((select registry.verified_at is not null
  and registry.verified_output_sha256 = repeat('c', 64)
  and registry.verified_size_bytes = 512
  and registry.verified_width = 32
  and registry.verified_height = 32
  from private.profile_photo_objects registry
  where registry.id = (select (result->>'registrationId')::uuid
    from trusted_reservation)), 'verified output metadata is persisted exactly');

set local role authenticated;
set local "request.jwt.claim.sub" = 'f8010000-0000-4000-8000-000000000001';
create temp table committed_profile as
select public.commit_profile_photo_upload(
  (select result->>'storagePath' from trusted_reservation),
  (select updated_at from public.profiles
    where user_id = 'f8010000-0000-4000-8000-000000000001'),
  false, null, null
) as result;
reset role;
select ok((select (result->>'committed')::boolean from committed_profile),
  'the verified trusted object can be committed');
select is((select avatar_url from public.profiles
  where user_id = 'f8010000-0000-4000-8000-000000000001'),
  (select result->>'storagePath' from trusted_reservation),
  'the committed avatar points to the exact trusted path');

set local role service_role;
select lives_ok(format($sql$
  select public.finalize_profile_photo_upload_service(
    'f8010000-0000-4000-8000-000000000001',
    (select (result->>'registrationId')::uuid from trusted_reservation),
    %L, repeat('c', 64), 512, 32, 32
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  'an exact finalization retry is idempotent after commit');
select throws_ok(format($sql$
  select public.finalize_profile_photo_upload_service(
    'f8010000-0000-4000-8000-000000000001',
    (select (result->>'registrationId')::uuid from trusted_reservation),
    %L, repeat('d', 64), 512, 32, 32
  )
$sql$, (select result->>'storagePath' from trusted_reservation)),
  '55000', 'Verified profile-photo metadata is immutable.',
  'a finalization retry cannot change verified output metadata');
reset role;

select * from finish();
rollback;
