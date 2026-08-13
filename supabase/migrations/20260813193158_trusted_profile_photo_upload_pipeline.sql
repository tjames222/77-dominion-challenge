-- FOU-801: authenticated clients submit a small prepared JPEG/WebP to an Edge
-- Function. Only that trusted service can write the stripped WebP object.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table public.profiles in share row exclusive mode;
lock table private.profile_photo_objects in share row exclusive mode;
lock table storage.objects in share row exclusive mode;

alter table private.profile_photo_objects
  add column upload_request_id uuid,
  add column source_sha256 text,
  add column verified_output_sha256 text,
  add column verified_size_bytes integer,
  add column verified_width integer,
  add column verified_height integer,
  add column verified_at timestamptz,
  add constraint profile_photo_objects_source_sha256_check check (
    source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint profile_photo_objects_verified_sha256_check check (
    verified_output_sha256 is null
    or verified_output_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint profile_photo_objects_upload_request_check check (
    (upload_request_id is null) = (source_sha256 is null)
  ),
  add constraint profile_photo_objects_verified_output_check check (
    (
      verified_at is null
      and verified_output_sha256 is null
      and verified_size_bytes is null
      and verified_width is null
      and verified_height is null
    ) or (
      verified_at is not null
      and verified_output_sha256 is not null
      and verified_size_bytes between 1 and 153600
      and verified_width between 1 and 256
      and verified_height between 1 and 256
      and verified_width = verified_height
      and verified_width * verified_height <= 65536
    )
  ),
  add constraint profile_photo_objects_canonical_verified_check check (
    state <> 'canonical'
    or (
      upload_request_id is not null
      and verified_at is not null
      and storage_path ~ (
        '^' || user_id::text
        || '/avatar-[0-9]{13}-[a-f0-9]{32}[.]webp$'
      )
    )
  ) not valid;

create unique index profile_photo_objects_upload_request_idx
  on private.profile_photo_objects (user_id, upload_request_id)
  where upload_request_id is not null;

create or replace function private.guard_profile_photo_object_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.storage_path is distinct from old.storage_path
    or new.created_at is distinct from old.created_at
    or new.upload_request_id is distinct from old.upload_request_id
    or new.source_sha256 is distinct from old.source_sha256
  then
    raise exception 'Profile-photo registry identity is immutable.'
      using errcode = '55000';
  end if;

  if new.storage_object_id is distinct from old.storage_object_id
    and not (
      old.storage_object_id is null
      and new.storage_object_id is not null
      and old.state = 'pending_upload'
      and new.state = 'pending_upload'
    )
  then
    raise exception 'Profile-photo Storage object identity is immutable once bound.'
      using errcode = '55000';
  end if;

  if (
    new.verified_output_sha256 is distinct from old.verified_output_sha256
    or new.verified_size_bytes is distinct from old.verified_size_bytes
    or new.verified_width is distinct from old.verified_width
    or new.verified_height is distinct from old.verified_height
    or new.verified_at is distinct from old.verified_at
  ) and not (
    old.state = 'pending_upload'
    and new.state = 'pending_upload'
    and old.verified_at is null
    and old.verified_output_sha256 is null
    and old.verified_size_bytes is null
    and old.verified_width is null
    and old.verified_height is null
    and new.verified_at is not null
    and new.verified_output_sha256 is not null
    and new.verified_size_bytes is not null
    and new.verified_width is not null
    and new.verified_height is not null
  ) then
    raise exception 'Verified profile-photo output metadata is immutable.'
      using errcode = '55000';
  end if;

  if old.state = 'retired' and new is distinct from old then
    raise exception 'Retired profile-photo paths are terminal.'
      using errcode = '55000';
  end if;

  if new.state is distinct from old.state and not (
    (old.state = 'pending_upload' and new.state in ('canonical', 'cleanup', 'retired'))
    or (old.state = 'canonical' and new.state in ('cleanup', 'retired'))
    or (old.state = 'cleanup' and new.state = 'retired')
  ) then
    raise exception 'Illegal profile-photo lifecycle transition: % -> %.',
      old.state,
      new.state
      using errcode = '55000';
  end if;

  if old.state = 'pending_upload'
    and new.state = 'pending_upload'
    and new.upload_expires_at is distinct from old.upload_expires_at
  then
    raise exception 'A profile-photo upload expiry cannot be extended.'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_profile_photo_object_transition()
  from public, anon, authenticated, service_role;

-- This is a prelaunch hard cutover. No browser-written or otherwise
-- unverified object remains canonical or eligible to become canonical.
update public.profiles profile
set avatar_url = ''
where coalesce(profile.avatar_url, '') <> '';

update private.profile_photo_objects registry
set
  state = 'cleanup',
  upload_expires_at = null,
  claim_token = null,
  claim_expires_at = null,
  claim_actor = null,
  delete_authorized_at = null,
  next_attempt_at = clock_timestamp(),
  updated_at = clock_timestamp()
where registry.verified_at is null
  and registry.state in ('pending_upload', 'canonical');

alter table private.profile_photo_objects
  validate constraint profile_photo_objects_canonical_verified_check;

create or replace function public.reserve_profile_photo_upload_service(
  target_user_id uuid,
  target_request_id uuid,
  target_source_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  server_now timestamptz := clock_timestamp();
  existing_registration private.profile_photo_objects%rowtype;
  registration_id uuid;
  storage_path text;
  expires_at timestamptz;
  pending_count integer;
  cleanup_count integer;
  hourly_count integer;
  daily_count integer;
begin
  if target_user_id is null
    or target_request_id is null
    or coalesce(target_source_sha256, '') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Invalid trusted profile-photo reservation.'
      using errcode = '22023';
  end if;

  perform 1
  from public.profiles profile
  where profile.user_id = target_user_id
  for update;
  if not found then
    raise exception 'Profile does not exist.' using errcode = '23503';
  end if;
  if private.retired_community_account_erasure_is_pending(target_user_id) then
    raise exception 'Profile assets are frozen while account erasure is pending.'
      using errcode = '55000';
  end if;

  select registry.* into existing_registration
  from private.profile_photo_objects registry
  where registry.user_id = target_user_id
    and registry.upload_request_id = target_request_id;
  if found then
    if existing_registration.source_sha256 is distinct from target_source_sha256 then
      raise exception 'A profile-photo request ID cannot be reused for different bytes.'
        using errcode = '55000';
    end if;
    if existing_registration.state in ('pending_upload', 'canonical')
      and (
        existing_registration.state = 'canonical'
        or existing_registration.upload_expires_at > server_now
      )
    then
      return jsonb_build_object(
        'registrationId', existing_registration.id,
        'storagePath', existing_registration.storage_path,
        'expiresAt', coalesce(
          existing_registration.upload_expires_at,
          existing_registration.verified_at
        )
      );
    end if;
    raise exception 'The profile-photo request is no longer active.'
      using errcode = '55000';
  end if;

  select
    count(*) filter (
      where registry.state = 'pending_upload'
        and registry.upload_expires_at > server_now
    ),
    count(*) filter (
      where registry.state = 'cleanup'
        or (
          registry.state = 'pending_upload'
          and registry.upload_expires_at <= server_now
        )
    ),
    count(*) filter (
      where registry.created_at >= server_now - interval '1 hour'
    ),
    count(*) filter (
      where registry.created_at >= server_now - interval '24 hours'
    )
  into pending_count, cleanup_count, hourly_count, daily_count
  from private.profile_photo_objects registry
  where registry.user_id = target_user_id;

  if pending_count >= 3 then
    raise exception 'Too many profile-photo uploads are pending.'
      using errcode = 'P8001';
  end if;
  if cleanup_count >= 20 then
    raise exception 'Profile-photo cleanup backlog is full.'
      using errcode = 'P8002';
  end if;
  if hourly_count >= 6 then
    raise exception 'Profile-photo hourly registration limit reached.'
      using errcode = 'P8003';
  end if;
  if daily_count >= 24 then
    raise exception 'Profile-photo daily registration limit reached.'
      using errcode = 'P8004';
  end if;

  update private.profile_photo_objects registry
  set
    state = 'cleanup',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    claim_actor = null,
    delete_authorized_at = null,
    next_attempt_at = server_now,
    updated_at = server_now
  where registry.user_id = target_user_id
    and registry.state = 'pending_upload'
    and registry.upload_expires_at <= server_now;

  storage_path := target_user_id::text
    || '/avatar-'
    || lpad(
      (floor(extract(epoch from server_now) * 1000)::bigint)::text,
      13,
      '0'
    )
    || '-'
    || replace(gen_random_uuid()::text, '-', '')
    || '.webp';
  expires_at := server_now + interval '15 minutes';

  begin
    insert into private.profile_photo_path_tombstones (
      path_sha256,
      reason
    ) values (
      private.profile_photo_path_sha256(storage_path),
      'registered'
    );

    insert into private.profile_photo_objects (
      user_id,
      storage_path,
      state,
      upload_expires_at,
      upload_request_id,
      source_sha256
    ) values (
      target_user_id,
      storage_path,
      'pending_upload',
      expires_at,
      target_request_id,
      target_source_sha256
    ) returning id into registration_id;
  exception
    when unique_violation then
      raise exception 'Profile-photo reservation collision. Retry the request.'
        using errcode = '40001';
  end;

  return jsonb_build_object(
    'registrationId', registration_id,
    'storagePath', storage_path,
    'expiresAt', expires_at
  );
end;
$$;

create or replace function public.finalize_profile_photo_upload_service(
  target_user_id uuid,
  target_registration_id uuid,
  target_storage_path text,
  target_output_sha256 text,
  target_size_bytes integer,
  target_width integer,
  target_height integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  server_now timestamptz := clock_timestamp();
  registry_row private.profile_photo_objects%rowtype;
  object_row storage.objects%rowtype;
  object_size bigint;
  object_mime text;
begin
  if target_user_id is null
    or target_registration_id is null
    or target_storage_path !~ (
      '^' || target_user_id::text
      || '/avatar-[0-9]{13}-[a-f0-9]{32}[.]webp$'
    )
    or coalesce(target_output_sha256, '') !~ '^[0-9a-f]{64}$'
    or target_size_bytes is null
    or target_size_bytes not between 1 and 153600
    or target_width is null
    or target_width not between 1 and 256
    or target_height is null
    or target_height not between 1 and 256
    or target_width <> target_height
    or target_width * target_height > 65536
  then
    raise exception 'Invalid trusted profile-photo finalization.'
      using errcode = '22023';
  end if;

  perform 1
  from public.profiles profile
  where profile.user_id = target_user_id
  for update;
  if not found then
    raise exception 'Profile does not exist.' using errcode = '23503';
  end if;
  if private.retired_community_account_erasure_is_pending(target_user_id) then
    raise exception 'Profile assets are frozen while account erasure is pending.'
      using errcode = '55000';
  end if;

  select registry.* into registry_row
  from private.profile_photo_objects registry
  where registry.id = target_registration_id
    and registry.user_id = target_user_id
    and registry.storage_path = target_storage_path
  for update;
  if not found
    or registry_row.state not in ('pending_upload', 'canonical')
    or (
      registry_row.state = 'pending_upload'
      and registry_row.upload_expires_at <= server_now
    )
  then
    raise exception 'Profile-photo reservation is no longer active.'
      using errcode = '55000';
  end if;

  select object_value.* into object_row
  from storage.objects object_value
  where object_value.id = registry_row.storage_object_id
    and object_value.bucket_id = 'profile-photos'
    and object_value.name = target_storage_path
  for update;
  if not found then
    raise exception 'The trusted profile-photo object does not exist.'
      using errcode = '23503';
  end if;

  object_mime := lower(coalesce(object_row.metadata->>'mimetype', ''));
  if coalesce(object_row.metadata->>'size', '') !~ '^[0-9]+$' then
    raise exception 'The trusted profile-photo object size is missing.'
      using errcode = '55000';
  end if;
  object_size := (object_row.metadata->>'size')::bigint;
  if object_mime <> 'image/webp' or object_size <> target_size_bytes then
    raise exception 'The trusted profile-photo object metadata does not match.'
      using errcode = '55000';
  end if;

  if registry_row.verified_at is not null then
    if registry_row.verified_output_sha256 is distinct from target_output_sha256
      or registry_row.verified_size_bytes is distinct from target_size_bytes
      or registry_row.verified_width is distinct from target_width
      or registry_row.verified_height is distinct from target_height
    then
      raise exception 'Verified profile-photo metadata is immutable.'
        using errcode = '55000';
    end if;
  else
    update private.profile_photo_objects registry
    set
      verified_output_sha256 = target_output_sha256,
      verified_size_bytes = target_size_bytes,
      verified_width = target_width,
      verified_height = target_height,
      verified_at = server_now,
      updated_at = server_now
    where registry.id = target_registration_id;
  end if;

  return jsonb_build_object(
    'finalized', true,
    'registrationId', target_registration_id,
    'storagePath', target_storage_path
  );
end;
$$;

create or replace function public.abandon_profile_photo_upload_service(
  target_user_id uuid,
  target_registration_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  server_now timestamptz := clock_timestamp();
begin
  if target_user_id is null or target_registration_id is null then
    return false;
  end if;

  perform 1
  from public.profiles profile
  where profile.user_id = target_user_id
  for update;
  if not found then return false; end if;

  update private.profile_photo_objects registry
  set
    state = 'cleanup',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    claim_actor = null,
    delete_authorized_at = null,
    next_attempt_at = server_now,
    updated_at = server_now
  where registry.id = target_registration_id
    and registry.user_id = target_user_id
    and registry.upload_request_id is not null
    and registry.state = 'pending_upload'
    and registry.verified_at is null;
  return found;
end;
$$;

create or replace function private.enforce_profile_avatar_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_storage_path text;
begin
  if tg_op = 'INSERT' then
    if coalesce(new.avatar_url, '') <> '' then
      raise exception 'New profiles must start without an avatar.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'Profile identity is immutable.' using errcode = '55000';
  end if;
  if new.avatar_url is not distinct from old.avatar_url then return new; end if;
  if coalesce(new.avatar_url, '') = '' then return new; end if;

  canonical_storage_path := private.profile_photo_path_from_value(
    new.avatar_url,
    new.user_id,
    true
  );
  if canonical_storage_path is null or new.avatar_url <> canonical_storage_path then
    raise exception 'Profile avatar must be a registered owned thumbnail path.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from private.profile_photo_objects registry
    join storage.objects object_row
      on object_row.id = registry.storage_object_id
     and object_row.bucket_id = 'profile-photos'
     and object_row.name = registry.storage_path
    where registry.user_id = new.user_id
      and registry.storage_path = canonical_storage_path
      and registry.state = 'canonical'
      and registry.upload_request_id is not null
      and registry.verified_at is not null
      and registry.verified_width = registry.verified_height
      and registry.storage_path ~ (
        '^' || new.user_id::text
        || '/avatar-[0-9]{13}-[a-f0-9]{32}[.]webp$'
      )
      and lower(coalesce(object_row.metadata->>'mimetype', '')) = 'image/webp'
      and coalesce(object_row.metadata->>'size', '') ~ '^[0-9]+$'
      and (object_row.metadata->>'size')::integer = registry.verified_size_bytes
  ) then
    raise exception 'Profile avatar is not an active verified object.'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_profile_avatar_value()
  from public, anon, authenticated, service_role;

drop policy if exists "Users can upload own profile photo objects"
  on storage.objects;
revoke all on function public.profile_photo_storage_insert_is_allowed(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.register_profile_photo_upload(text)
  from public, anon, authenticated, service_role;

revoke all on function public.reserve_profile_photo_upload_service(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_profile_photo_upload_service(
  uuid, uuid, text, text, integer, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.abandon_profile_photo_upload_service(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.reserve_profile_photo_upload_service(uuid, uuid, text)
  to service_role;
grant execute on function public.finalize_profile_photo_upload_service(
  uuid, uuid, text, text, integer, integer, integer
) to service_role;
grant execute on function public.abandon_profile_photo_upload_service(uuid, uuid)
  to service_role;

update storage.buckets
set
  file_size_limit = 153600,
  allowed_mime_types = array['image/webp']
where id = 'profile-photos';

comment on function public.reserve_profile_photo_upload_service(uuid, uuid, text) is
  'Service-only, actor-scoped, idempotent reservation for one immutable WebP path after authenticated Edge validation.';
comment on function public.finalize_profile_photo_upload_service(
  uuid, uuid, text, text, integer, integer, integer
) is
  'Service-only finalization of an exact Storage object and immutable server-verified image metadata.';
comment on function public.abandon_profile_photo_upload_service(uuid, uuid) is
  'Service-only fail-safe that makes an unverified reservation immediately eligible for cleanup.';
comment on function public.register_profile_photo_upload(text) is
  'Deprecated browser reservation entry point. Execution is revoked after the trusted Edge upload cutover.';

commit;
