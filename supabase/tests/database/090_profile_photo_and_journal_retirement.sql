begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(98);

select ok(exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20260722152851'
), 'the profile-thumbnail hardening migration was replayed');
select ok(exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20260722152953'
), 'the journal-photo retirement migration was replayed');

select ok(to_regclass('public.journal_photos') is null,
  'journal photo metadata is absent from the final schema');
select is((select count(*)::integer from storage.buckets where id = 'journal-progress'), 0,
  'the journal-progress bucket is absent');
select is((select count(*)::integer from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and (coalesce(qual, '') like '%journal-progress%'
      or coalesce(with_check, '') like '%journal-progress%')
    and policyname like '%journal photo%'), 0,
  'journal-specific Storage policies are absent');
select ok(to_regclass('public.journal_entries') is not null,
  'text journal entries remain');
select ok((select relrowsecurity from pg_class where oid = 'public.journal_entries'::regclass),
  'text journal RLS remains enabled');
select ok(has_table_privilege('authenticated', 'public.journal_entries', 'select'),
  'authenticated members retain journal-entry access through RLS');

select is((select file_size_limit from storage.buckets where id = 'profile-photos'), 153600::bigint,
  'profile-photo objects are capped at 150 KiB');
select is((select allowed_mime_types from storage.buckets where id = 'profile-photos'),
  array['image/jpeg', 'image/webp']::text[],
  'only encoded JPEG and WebP avatar outputs are accepted');
select ok(not exists (select 1 from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'Profile photos are publicly readable'),
  'public serving no longer relies on a broad object SELECT policy');
select ok(not exists (select 1 from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'Users can update own profile photo objects'),
  'immutable avatar paths cannot be overwritten through UPDATE');
select ok(exists (select 1 from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'Users can read own profile photo objects'
    and cmd = 'SELECT'),
  'owners can select exact cleanup targets without exposing another member''s objects');

select ok(to_regclass('private.profile_photo_objects') is not null,
  'the immutable profile-photo lifecycle registry exists');
select ok(to_regclass('private.profile_photo_path_tombstones') is not null,
  'the irreversible digest-only path ledger exists');
select ok((select relrowsecurity from pg_class
  where oid = 'private.profile_photo_objects'::regclass),
  'the lifecycle registry has RLS enabled as defense in depth');
select ok((select relrowsecurity from pg_class
  where oid = 'private.profile_photo_path_tombstones'::regclass),
  'the path ledger has RLS enabled as defense in depth');
select ok(not has_table_privilege('authenticated',
  'private.profile_photo_objects', 'select'),
  'authenticated clients cannot read the lifecycle registry directly');
select ok(not has_table_privilege('service_role',
  'private.profile_photo_objects', 'select'),
  'service role receives no direct lifecycle-table privilege');
select ok(not has_table_privilege('authenticated',
  'private.profile_photo_path_tombstones', 'select'),
  'authenticated clients cannot read path reservations directly');
select ok(not has_table_privilege('service_role',
  'private.profile_photo_path_tombstones', 'select'),
  'service role receives no direct path-ledger privilege');
select ok(not exists (
  select 1
  from information_schema.columns
  where table_schema = 'private'
    and table_name = 'profile_photo_path_tombstones'
    and column_name in ('user_id', 'storage_path')
), 'permanent path reservations retain neither a user id nor a raw path');
select ok(exists (
  select 1 from pg_trigger
  where tgrelid = 'private.profile_photo_objects'::regclass
    and tgname = 'guard_profile_photo_object_transition' and not tgisinternal
), 'the lifecycle registry enforces legal state transitions');
select ok(exists (
  select 1
  from pg_index index_row
  where index_row.indexrelid =
      'private.profile_photo_objects_one_canonical_idx'::regclass
    and index_row.indisunique
    and pg_get_expr(index_row.indpred, index_row.indrelid) like '%canonical%'
), 'a partial unique index permits only one canonical object per member');
select ok(exists (
  select 1
  from pg_index index_row
  where index_row.indexrelid =
      'private.profile_photo_objects_storage_object_idx'::regclass
    and index_row.indisunique
), 'one Storage object cannot be bound to multiple registrations');
select ok(has_function_privilege('authenticated',
  'public.register_profile_photo_upload(text)', 'execute'),
  'authenticated owners can pre-register an immutable upload');
select ok(has_function_privilege('authenticated',
  'public.commit_profile_photo_upload(text,timestamp with time zone,boolean,text,text)', 'execute'),
  'authenticated owners can atomically activate a registered upload');
select ok(has_function_privilege('authenticated',
  'public.abandon_profile_photo_upload(text)', 'execute'),
  'authenticated owners can durably abandon an ambiguous upload');
select ok(has_function_privilege('authenticated',
  'public.claim_profile_photo_cleanup(integer)', 'execute'),
  'authenticated owners can claim non-canonical cleanup work');
select ok(has_function_privilege('authenticated',
  'public.confirm_profile_photo_cleanup(uuid,uuid)', 'execute'),
  'authenticated owners can retire an absent object');
select ok(not has_function_privilege('anon',
  'public.register_profile_photo_upload(text)', 'execute'),
  'anonymous callers cannot register upload paths');
select ok(has_function_privilege('service_role',
  'public.expire_profile_photo_uploads(integer)', 'execute'),
  'the service role can sweep stale registrations for users who never return');
select ok(not has_function_privilege('authenticated',
  'public.expire_profile_photo_uploads(integer)', 'execute'),
  'members cannot run the global stale-registration sweep');
select ok(not has_function_privilege('authenticated',
  'private.profile_photo_path_from_value(text,uuid,boolean)', 'execute'),
  'the internal path parser is not a public data interface');
select ok(not has_column_privilege(
  'authenticated',
  'public.profiles',
  'avatar_url',
  'update'
), 'authenticated clients cannot bypass the avatar commit RPC');
select ok(has_column_privilege(
  'authenticated', 'public.profiles', 'name', 'update'
), 'authenticated clients retain direct access to safe profile text updates');
select ok(has_column_privilege(
  'authenticated', 'public.profiles', 'challenge_start_date', 'update'
), 'authenticated clients retain direct challenge-date updates');
select ok(not has_column_privilege(
  'authenticated', 'public.profiles', 'user_id', 'update'
), 'authenticated clients cannot rewrite profile ownership');
select ok(has_column_privilege(
  'authenticated', 'public.profiles', 'user_id', 'insert'
), 'authenticated clients can still create their own safe profile row');
select ok(not has_column_privilege(
  'authenticated', 'public.profiles', 'avatar_url', 'insert'
), 'authenticated clients cannot seed an unregistered avatar during profile creation');

select ok(exists (select 1 from pg_trigger
  where tgrelid = 'public.profiles'::regclass
    and tgname = 'enforce_profile_avatar_value' and not tgisinternal),
  'profile insert and update values are defended by a trigger');
select ok(exists (select 1 from pg_trigger
  where tgrelid = 'storage.objects'::regclass
    and tgname = 'guard_profile_photo_storage_insert' and not tgisinternal),
  'Storage inserts lock and validate the pending registration');
select ok(exists (select 1 from pg_trigger
  where tgrelid = 'storage.objects'::regclass
    and tgname = 'guard_profile_photo_storage_update' and not tgisinternal),
  'Storage updates are rejected before an immutable object can be overwritten');
select ok(exists (select 1 from pg_trigger
  where tgrelid = 'storage.objects'::regclass
    and tgname = 'guard_profile_photo_storage_delete' and not tgisinternal),
  'Storage deletes lock and validate cleanup state');
select ok(
  position(
    'batch_row.reason = ''account_erasure'''
    in pg_get_functiondef('private.guard_profile_photo_storage_object()'::regprocedure)
  ) > 0
  and position(
    'batch_row.subject_user_id = path_user_id'
    in pg_get_functiondef('private.guard_profile_photo_storage_object()'::regprocedure)
  ) > 0,
  'privileged deletion work is bound to the path owner''s account-erasure batch'
);
select ok(exists (
  select 1
  from pg_policy policy_row
  join pg_class table_row on table_row.oid = policy_row.polrelid
  join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
  where schema_row.nspname = 'storage' and table_row.relname = 'objects'
    and policy_row.polname = 'Canonical profile photos cannot be deleted'
    and policy_row.polcmd = 'd' and not policy_row.polpermissive
), 'canonical avatar deletion is blocked by a restrictive policy');
select ok(exists (
  select 1
  from pg_policy policy_row
  join pg_class table_row on table_row.oid = policy_row.polrelid
  join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
  where schema_row.nspname = 'storage' and table_row.relname = 'objects'
    and policy_row.polname = 'Pending account erasure blocks personal asset deletes'
    and policy_row.polcmd = 'd' and not policy_row.polpermissive
), 'pending account erasure freezes authenticated personal-asset deletes');

select is(private.profile_photo_path_from_value(
    '10000000-0000-4000-8000-000000000001/'
      || 'avatar-1720000000000-0123456789abcdef0123456789abcdef.webp',
    '10000000-0000-4000-8000-000000000001', true),
  '10000000-0000-4000-8000-000000000001/'
    || 'avatar-1720000000000-0123456789abcdef0123456789abcdef.webp',
  'a strict new owned path is recognized without storing a caller-controlled origin');
select is(private.profile_photo_path_from_value(
    'https://legacy.example/storage/v1/object/public/profile-photos/'
      || '10000000-0000-4000-8000-000000000001/avatar-1720000000000.jpg',
    '10000000-0000-4000-8000-000000000001', false),
  '10000000-0000-4000-8000-000000000001/avatar-1720000000000.jpg',
  'legacy URLs can be canonicalized to an owned path during migration');
select is(private.profile_photo_path_from_value(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000.jpg',
    '10000000-0000-4000-8000-000000000001', true),
  null::text,
  'legacy paths cannot be activated as a new canonical avatar');

select throws_ok($$
  update public.profiles
  set avatar_url = 'https://privileged.invalid/avatar.jpg'
  where user_id = '10000000-0000-4000-8000-000000000001'
$$, '23514', 'Profile avatar must be a registered owned thumbnail path.',
  'the database owner cannot bypass the canonical avatar invariant');
set local role service_role;
select throws_ok($$
  update public.profiles
  set avatar_url = 'https://service.invalid/avatar.jpg'
  where user_id = '10000000-0000-4000-8000-000000000001'
$$, '42501', 'permission denied for table profiles',
  'the service role has no direct profile-table mutation path');
reset role;

select throws_ok($$
  insert into storage.objects (id, bucket_id, name, owner) values (
    'f7520000-0000-4000-8000-000000000098',
    'profile-photos',
    '10000000-0000-4000-8000-000000000001/avatar-1720000000098-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp',
    '10000000-0000-4000-8000-000000000001'
  )
$$, '55000', 'Profile-photo upload is not registered or has expired.',
  'the database owner cannot insert an unregistered profile-photo object');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

select throws_ok($$
  insert into public.profiles (user_id, name, email, avatar_url)
  values (
    '10000000-0000-4000-8000-000000000001',
    'Malicious duplicate',
    'malicious@example.test',
    'https://untrusted.example/avatar.jpg'
  )
$$, '42501', 'permission denied for table profiles',
  'column grants reject an authenticated profile INSERT that supplies an avatar');

select lives_ok($$
  select public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp'
  )
$$, 'an owner can pre-register a strict immutable path');
select is((select count(*)::integer from public.claim_profile_photo_cleanup(20)), 0,
  'an active pending upload cannot be claimed for cleanup');
reset role;
select is((select state from private.profile_photo_objects
  where storage_path like '%0123456789abcdef0123456789abcdef.webp'),
  'pending_upload',
  'registration starts in pending-upload state');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
select throws_ok($$
  insert into storage.objects (id, bucket_id, name, owner) values (
    'f7520000-0000-4000-8000-000000000099',
    'profile-photos',
    '10000000-0000-4000-8000-000000000001/avatar-1720000000099-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp',
    '10000000-0000-4000-8000-000000000001'
  )
$$, '55000', 'Profile-photo upload is not registered or has expired.',
  'Storage INSERT cannot create an unregistered object');

select throws_ok($$
  insert into storage.objects (id, bucket_id, name, owner) values (
    'f7520000-0000-4000-8000-000000000097',
    'profile-photos',
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp',
    '20000000-0000-4000-8000-000000000002'
  )
$$, '42501', 'Profile-photo Storage owner does not match its path owner.',
  'Storage INSERT rejects ownership metadata that disagrees with the path owner');

select lives_ok($$
  insert into storage.objects (id, bucket_id, name, owner) values (
    'f7520000-0000-4000-8000-000000000001',
    'profile-photos',
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp',
    '10000000-0000-4000-8000-000000000001'
  )
$$, 'the registered pending object can be uploaded');

select is((
  public.commit_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp',
    (select updated_at from public.profiles
      where user_id = '10000000-0000-4000-8000-000000000001'),
    false,
    null,
    null
  ) ->> 'committed'
), 'true', 'the first registered upload commits atomically');
reset role;

select is((select avatar_url from public.profiles
  where user_id = '10000000-0000-4000-8000-000000000001'),
  '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp',
  'the canonical profile stores only the owned path');
select is((select state from private.profile_photo_objects
  where storage_path like '%0123456789abcdef0123456789abcdef.webp'),
  'canonical',
  'the committed registration becomes canonical');
select throws_ok($$
  update storage.objects
  set bucket_id = 'community-post-images'
  where id = 'f7520000-0000-4000-8000-000000000001'
$$, '55000', 'Profile-photo objects are immutable and cannot be overwritten.',
  'the database owner cannot move a canonical object out of the protected bucket');
set local storage.allow_delete_query = 'true';
select throws_ok($$
  delete from storage.objects
  where id = 'f7520000-0000-4000-8000-000000000001'
$$, '55000', 'Only an actively claimed non-canonical profile photo can be deleted.',
  'the database owner cannot delete a canonical object without exact deletion work');
reset storage.allow_delete_query;
select ok(exists (
  select 1 from storage.objects
  where id = 'f7520000-0000-4000-8000-000000000001'
), 'the canonical object survives a privileged delete attempt');
select throws_ok($$
  update private.profile_photo_objects
  set state = 'pending_upload', upload_expires_at = clock_timestamp() + interval '15 minutes'
  where storage_path like '%0123456789abcdef0123456789abcdef.webp'
$$, '55000', 'Illegal profile-photo lifecycle transition: canonical -> pending_upload.',
  'direct table access cannot reverse the lifecycle state machine');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
select throws_ok($$
  select public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp'
  )
$$, '55000', 'Profile-photo paths are immutable and cannot be reused.',
  'a canonical path cannot be registered again');

select lives_ok($$
  select public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000001-fedcba9876543210fedcba9876543210.jpg'
  )
$$, 'a second immutable upload can be registered');
select lives_ok($$
  insert into storage.objects (id, bucket_id, name, owner) values (
    'f7520000-0000-4000-8000-000000000002',
    'profile-photos',
    '10000000-0000-4000-8000-000000000001/avatar-1720000000001-fedcba9876543210fedcba9876543210.jpg',
    '10000000-0000-4000-8000-000000000001'
  )
$$, 'the second registered object can be uploaded');
select is((
  public.commit_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000001-fedcba9876543210fedcba9876543210.jpg',
    (select updated_at from public.profiles
      where user_id = '10000000-0000-4000-8000-000000000001'),
    true,
    'Alice New',
    'alice-new@example.test'
  ) ->> 'committed'
), 'true', 'a second commit atomically updates text and avatar');
reset role;

select is((select name from public.profiles
  where user_id = '10000000-0000-4000-8000-000000000001'),
  'Alice New',
  'the atomic commit applies intentional text edits');
select is((select state from private.profile_photo_objects
  where storage_path like '%0123456789abcdef0123456789abcdef.webp'),
  'cleanup',
  'the predecessor moves to cleanup state');
select is((select state from private.profile_photo_objects
  where storage_path like '%fedcba9876543210fedcba9876543210.jpg'),
  'canonical',
  'the replacement is the only canonical object');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
create temp table claimed_profile_cleanup as
select * from public.claim_profile_photo_cleanup(20);
select ok((select count(*) = 1
  and min(storage_path) like '%0123456789abcdef0123456789abcdef.webp'
  and bool_and(storage_path not like '%fedcba9876543210fedcba9876543210.jpg')
  from claimed_profile_cleanup),
  'claim returns the predecessor and excludes the canonical object');
select is((select public.confirm_profile_photo_cleanup(
  job_id,
  'ffffffff-ffff-4fff-8fff-ffffffffffff'
) from claimed_profile_cleanup), false,
  'a wrong cleanup token cannot retire the path');
select throws_ok($$
  select public.confirm_profile_photo_cleanup(job_id, claim_token)
  from claimed_profile_cleanup
$$, '55000', 'Profile-photo object still exists; cleanup is not confirmed.',
  'cleanup cannot be confirmed before Storage reports the object absent');

set local storage.allow_delete_query = 'true';
select lives_ok($$
  delete from storage.objects
  where bucket_id = 'profile-photos'
    and name like '%fedcba9876543210fedcba9876543210.jpg'
$$, 'deleting the canonical object is a harmless no-op through Storage RLS');
reset role;
reset storage.allow_delete_query;
select ok(exists (
  select 1 from storage.objects
  where bucket_id = 'profile-photos'
    and name like '%fedcba9876543210fedcba9876543210.jpg'
), 'the canonical object remains after the restricted delete');
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
set local storage.allow_delete_query = 'true';
select throws_ok($$
  delete from storage.objects
  where bucket_id = 'profile-photos'
    and name like '%0123456789abcdef0123456789abcdef.webp'
$$, '55000', 'Only an actively claimed non-canonical profile photo can be deleted.',
  'a privileged caller cannot piggyback on the member''s cleanup claim');
reset storage.allow_delete_query;
select ok(exists (
  select 1 from storage.objects
  where bucket_id = 'profile-photos'
    and name like '%0123456789abcdef0123456789abcdef.webp'
), 'the claimed predecessor remains until its owning member deletes it');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
set local storage.allow_delete_query = 'true';
select lives_ok($$
  delete from storage.objects
  where bucket_id = 'profile-photos'
    and name like '%0123456789abcdef0123456789abcdef.webp'
$$, 'an actively claimed predecessor can be removed through Storage RLS');
reset storage.allow_delete_query;
select is((select public.confirm_profile_photo_cleanup(job_id, claim_token)
  from claimed_profile_cleanup), true,
  'an exact claim retires the path after Storage reports it absent');
reset role;

select is((select state from private.profile_photo_objects
  where storage_path like '%0123456789abcdef0123456789abcdef.webp'),
  'retired',
  'confirmed cleanup preserves a permanent retired tombstone');
select ok((select retired_at is not null from private.profile_photo_objects
  where storage_path like '%0123456789abcdef0123456789abcdef.webp'),
  'the retired tombstone records its terminal time');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
select throws_ok($$
  select public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp'
  )
$$, '55000', 'Profile-photo paths are immutable and cannot be reused.',
  'a retired path can never be re-registered');

select lives_ok($$
  select public.register_profile_photo_upload(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000002-11111111111111111111111111111111.webp'
  )
$$, 'an ambiguous third upload can be registered');
select is(public.abandon_profile_photo_upload(
  '10000000-0000-4000-8000-000000000001/avatar-1720000000002-11111111111111111111111111111111.webp'
), true, 'an uncommitted registration can be abandoned durably');
reset role;
select is((select state from private.profile_photo_objects
  where storage_path like '%11111111111111111111111111111111.webp'),
  'cleanup',
  'abandonment makes the path cleanup-eligible without reusing it');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
select ok((select count(*) = 1 from public.claim_profile_photo_cleanup(20)
  where storage_path like '%11111111111111111111111111111111.webp'),
  'an abandoned registration can be claimed');
reset role;

select is((select avatar_url from public.profiles
  where user_id = '10000000-0000-4000-8000-000000000001'),
  '10000000-0000-4000-8000-000000000001/avatar-1720000000001-fedcba9876543210fedcba9876543210.jpg',
  'cleanup and abandonment never change the canonical profile');

insert into private.profile_photo_path_tombstones (path_sha256, reason)
values (
  private.profile_photo_path_sha256(
    '10000000-0000-4000-8000-000000000001/avatar-1720000000003-22222222222222222222222222222222.webp'
  ),
  'registered'
);
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at
) values (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001/avatar-1720000000003-22222222222222222222222222222222.webp',
  'pending_upload',
  clock_timestamp() - interval '1 minute'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';
create temp table claimed_expired_profile_upload as
select * from public.claim_profile_photo_cleanup(20)
where storage_path like '%22222222222222222222222222222222.webp';
select is((select count(*)::integer from claimed_expired_profile_upload), 1,
  'a returning member atomically expires and claims their stale upload');
select is((select public.confirm_profile_photo_cleanup(job_id, claim_token)
  from claimed_expired_profile_upload), true,
  'an absent stale upload can be permanently retired immediately');
reset role;
select is((select state from private.profile_photo_objects
  where storage_path like '%22222222222222222222222222222222.webp'),
  'retired',
  'member-driven expiry cannot leave a stale registration pending forever');

insert into private.profile_photo_path_tombstones (path_sha256, reason)
values (
  private.profile_photo_path_sha256(
    '20000000-0000-4000-8000-000000000002/avatar-1720000000004-33333333333333333333333333333333.webp'
  ),
  'registered'
);
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at
) values (
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002/avatar-1720000000004-33333333333333333333333333333333.webp',
  'pending_upload',
  clock_timestamp() - interval '1 minute'
);
set local role service_role;
select is(public.expire_profile_photo_uploads(100), 1,
  'the service sweep expires stale uploads for members who do not return');
reset role;
select is((select state from private.profile_photo_objects
  where storage_path like '%33333333333333333333333333333333.webp'),
  'cleanup',
  'the service sweep only makes an expired object cleanup-eligible');

insert into private.profile_photo_path_tombstones (path_sha256, reason)
values (
  private.profile_photo_path_sha256(
    '30000000-0000-4000-8000-000000000003/avatar-1720000000005-44444444444444444444444444444444.webp'
  ),
  'registered'
);
insert into private.profile_photo_objects (
  user_id, storage_path, state, upload_expires_at
) values (
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000003/avatar-1720000000005-44444444444444444444444444444444.webp',
  'pending_upload',
  clock_timestamp() + interval '15 minutes'
);
delete from auth.users
where id = '30000000-0000-4000-8000-000000000003';
select ok(not exists (
  select 1 from private.profile_photo_objects
  where storage_path like '%44444444444444444444444444444444.webp'
), 'account deletion removes the user-linked operational registry row');
select ok(exists (
  select 1 from private.profile_photo_path_tombstones
  where path_sha256 = private.profile_photo_path_sha256(
    '30000000-0000-4000-8000-000000000003/avatar-1720000000005-44444444444444444444444444444444.webp'
  )
), 'the digest-only path reservation survives account deletion permanently');

select * from finish();
rollback;
