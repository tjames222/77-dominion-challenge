begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create schema if not exists private;

alter table public.profiles
  add column if not exists avatar_url text not null default '';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  true,
  153600,
  array['image/jpeg', 'image/webp']
)
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
declare
  multipart_count bigint := 0;
begin
  if to_regclass('storage.s3_multipart_uploads') is not null then
    execute 'lock table storage.s3_multipart_uploads in share row exclusive mode';
    execute $query$
      select count(*)
      from storage.s3_multipart_uploads
      where bucket_id = 'profile-photos'
    $query$ into multipart_count;
  end if;

  if multipart_count > 0 then
    raise exception
      'FOU-752 blocked: profile-photos has % active multipart upload(s). Finish or abort them through the Storage API before retrying.',
      multipart_count
      using errcode = '55000';
  end if;
end;
$$;

-- Quiesce the legacy two-request upload flow while inventory, backfill, and the
-- new guards are installed. These locks are held until the migration commits.
lock table storage.objects in share row exclusive mode;
lock table public.profiles in share row exclusive mode;

create or replace function private.profile_photo_path_from_value(
  target_avatar_value text,
  target_user_id uuid,
  require_new_path boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  marker constant text := '/storage/v1/object/public/profile-photos/';
  clean_value text;
  storage_path text;
begin
  if coalesce(target_avatar_value, '') = '' or target_user_id is null then
    return null;
  end if;

  clean_value := split_part(target_avatar_value, '?', 1);
  if position(marker in clean_value) > 0 then
    storage_path := split_part(clean_value, marker, 2);
  else
    storage_path := clean_value;
  end if;

  if require_new_path then
    if storage_path !~ (
      '^' || target_user_id::text
      || '/avatar-[0-9]{13}-[a-f0-9]{32}[.](jpg|webp)$'
    ) then
      return null;
    end if;
  elsif storage_path !~ (
    '^' || target_user_id::text
    || '/avatar-[A-Za-z0-9_-]+[.](jpe?g|png|webp|heic|heif)$'
  ) then
    return null;
  end if;

  return storage_path;
end;
$$;

revoke all on function private.profile_photo_path_from_value(text, uuid, boolean)
  from public, anon, authenticated, service_role;

do $$
declare
  invalid_profile_count integer;
  unowned_object_count integer;
begin
  select count(*) into invalid_profile_count
  from public.profiles profile
  where coalesce(profile.avatar_url, '') <> ''
    and (
      private.profile_photo_path_from_value(profile.avatar_url, profile.user_id, false) is null
      or not exists (
        select 1
        from storage.objects object_row
        where object_row.bucket_id = 'profile-photos'
          and object_row.name = private.profile_photo_path_from_value(
            profile.avatar_url,
            profile.user_id,
            false
          )
      )
    );

  if invalid_profile_count > 0 then
    raise exception
      'FOU-752 blocked: % profile avatar value(s) do not map to an existing owned Storage object.',
      invalid_profile_count
      using errcode = '55000';
  end if;

  select count(*) into unowned_object_count
  from storage.objects object_row
  where object_row.bucket_id = 'profile-photos'
    and not exists (
      select 1
      from public.profiles profile
      where profile.user_id::text = split_part(object_row.name, '/', 1)
        and private.profile_photo_path_from_value(
          object_row.name,
          profile.user_id,
          false
        ) = object_row.name
        and (
          object_row.owner is null
          or object_row.owner = profile.user_id
        )
        and (
          nullif(to_jsonb(object_row)->>'owner_id', '') is null
          or to_jsonb(object_row)->>'owner_id' = profile.user_id::text
        )
    );

  if unowned_object_count > 0 then
    raise exception
      'FOU-752 blocked: profile-photos contains % unowned or malformed object(s). Inventory them before retrying.',
      unowned_object_count
      using errcode = '55000';
  end if;
end;
$$;

create table private.profile_photo_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  storage_object_id uuid,
  state text not null check (
    state in ('pending_upload', 'canonical', 'cleanup', 'retired')
  ),
  upload_expires_at timestamptz,
  claim_token uuid,
  claim_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  retired_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    storage_path ~ (
      '^' || user_id::text
      || '/avatar-[A-Za-z0-9_-]+[.](jpe?g|png|webp|heic|heif)$'
    )
  ),
  check (
    (
      state = 'pending_upload'
      and upload_expires_at is not null
      and claim_token is null
      and claim_expires_at is null
      and retired_at is null
    )
    or (
      state = 'canonical'
      and upload_expires_at is null
      and storage_object_id is not null
      and claim_token is null
      and claim_expires_at is null
      and retired_at is null
    )
    or (
      state = 'cleanup'
      and upload_expires_at is null
      and ((claim_token is null) = (claim_expires_at is null))
      and retired_at is null
    )
    or (
      state = 'retired'
      and upload_expires_at is null
      and claim_token is null
      and claim_expires_at is null
      and retired_at is not null
    )
  )
);

create table private.profile_photo_path_tombstones (
  path_sha256 text primary key check (path_sha256 ~ '^[0-9a-f]{64}$'),
  first_registered_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  reason text not null default 'registered' check (
    reason in ('registered', 'cleanup', 'account_erasure', 'legacy_backfill')
  )
);

alter table private.profile_photo_objects enable row level security;
alter table private.profile_photo_path_tombstones enable row level security;
revoke all on private.profile_photo_objects from public, anon, authenticated, service_role;
revoke all on private.profile_photo_path_tombstones
  from public, anon, authenticated, service_role;

create unique index profile_photo_objects_one_canonical_idx
  on private.profile_photo_objects (user_id)
  where state = 'canonical';
create unique index profile_photo_objects_storage_object_idx
  on private.profile_photo_objects (storage_object_id)
  where storage_object_id is not null;
create index profile_photo_objects_claim_idx
  on private.profile_photo_objects (user_id, claim_expires_at, created_at, id)
  where state = 'cleanup';
create index profile_photo_objects_expiry_idx
  on private.profile_photo_objects (upload_expires_at, user_id, id)
  where state = 'pending_upload';

create or replace function private.profile_photo_path_sha256(target_path text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(convert_to(coalesce(target_path, ''), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

revoke all on function private.profile_photo_path_sha256(text)
  from public, anon, authenticated, service_role;

insert into private.profile_photo_path_tombstones (
  path_sha256,
  reason
)
select
  private.profile_photo_path_sha256(object_row.name),
  'legacy_backfill'
from storage.objects object_row
where object_row.bucket_id = 'profile-photos';

insert into private.profile_photo_objects (
  user_id,
  storage_path,
  storage_object_id,
  state,
  upload_expires_at
)
select
  profile.user_id,
  object_row.name,
  object_row.id,
  case
    when private.profile_photo_path_from_value(
      profile.avatar_url,
      profile.user_id,
      false
    ) = object_row.name then 'canonical'
    else 'cleanup'
  end,
  null
from storage.objects object_row
join public.profiles profile
  on profile.user_id::text = split_part(object_row.name, '/', 1)
where object_row.bucket_id = 'profile-photos'
  and private.profile_photo_path_from_value(
    object_row.name,
    profile.user_id,
    false
  ) = object_row.name;

update public.profiles profile
set avatar_url = private.profile_photo_path_from_value(
  profile.avatar_url,
  profile.user_id,
  false
)
where coalesce(profile.avatar_url, '') <> '';

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

create trigger guard_profile_photo_object_transition
  before update on private.profile_photo_objects
  for each row execute function private.guard_profile_photo_object_transition();

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

  if new.avatar_url is not distinct from old.avatar_url then
    return new;
  end if;

  if coalesce(new.avatar_url, '') = '' then
    return new;
  end if;

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
  ) then
    raise exception 'Profile avatar is not an active registered object.'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_profile_avatar_value()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_owned_profile_avatar_url on public.profiles;
drop trigger if exists enforce_profile_avatar_value on public.profiles;
create trigger enforce_profile_avatar_value
  before insert or update of avatar_url, user_id on public.profiles
  for each row execute function private.enforce_profile_avatar_value();

create or replace function public.register_profile_photo_upload(target_storage_path text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  registration_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if target_storage_path !~ (
    '^' || caller_id::text
    || '/avatar-[0-9]{13}-[a-f0-9]{32}[.](jpg|webp)$'
  ) then
    raise exception 'Invalid profile-photo upload path.' using errcode = '22023';
  end if;

  perform 1
  from public.profiles profile
  where profile.user_id = caller_id
  for update;
  if not found then
    raise exception 'Create the profile before registering a photo.'
      using errcode = '23503';
  end if;
  if public.retired_community_current_account_erasure_is_pending() then
    raise exception 'Profile assets are frozen while account erasure is pending.'
      using errcode = '55000';
  end if;

  begin
    insert into private.profile_photo_path_tombstones (
      path_sha256,
      reason
    ) values (
      private.profile_photo_path_sha256(target_storage_path),
      'registered'
    );

    insert into private.profile_photo_objects (
      user_id,
      storage_path,
      state,
      upload_expires_at
    )
    values (
      caller_id,
      target_storage_path,
      'pending_upload',
      clock_timestamp() + interval '15 minutes'
    )
    returning id into registration_id;
  exception
    when unique_violation then
      raise exception 'Profile-photo paths are immutable and cannot be reused.'
        using errcode = '55000';
  end;

  return registration_id;
end;
$$;

create or replace function public.commit_profile_photo_upload(
  target_storage_path text,
  target_expected_updated_at timestamptz,
  target_update_text boolean default false,
  target_name text default null,
  target_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  current_profile public.profiles%rowtype;
  saved_profile public.profiles%rowtype;
  registered_object private.profile_photo_objects%rowtype;
  target_object_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if target_storage_path !~ (
    '^' || caller_id::text
    || '/avatar-[0-9]{13}-[a-f0-9]{32}[.](jpg|webp)$'
  ) then
    raise exception 'Invalid profile-photo upload path.' using errcode = '22023';
  end if;
  if target_update_text and (
    nullif(btrim(coalesce(target_name, '')), '') is null
    or nullif(btrim(coalesce(target_email, '')), '') is null
  ) then
    raise exception 'Name and email are required.' using errcode = '22023';
  end if;

  select profile.* into current_profile
  from public.profiles profile
  where profile.user_id = caller_id
  for update;
  if not found then
    raise exception 'Profile does not exist.' using errcode = '23503';
  end if;
  if current_profile.updated_at is distinct from target_expected_updated_at then
    return jsonb_build_object(
      'committed', false,
      'profile', to_jsonb(current_profile)
    );
  end if;
  if public.retired_community_current_account_erasure_is_pending() then
    raise exception 'Profile assets are frozen while account erasure is pending.'
      using errcode = '55000';
  end if;

  select object_row.id into target_object_id
  from storage.objects object_row
  where object_row.bucket_id = 'profile-photos'
    and object_row.name = target_storage_path
  for update;
  if target_object_id is null then
    raise exception 'Profile avatar object does not exist.'
      using errcode = '23503';
  end if;

  perform 1
  from private.profile_photo_objects registry
  where registry.user_id = caller_id
    and (
      registry.storage_path = target_storage_path
      or registry.state = 'canonical'
    )
  order by registry.id
  for update;

  select registry.* into registered_object
  from private.profile_photo_objects registry
  where registry.user_id = caller_id
    and registry.storage_path = target_storage_path;
  if not found
    or registered_object.state <> 'pending_upload'
    or registered_object.upload_expires_at <= clock_timestamp()
    or registered_object.storage_object_id is distinct from target_object_id
  then
    raise exception 'Profile-photo registration is no longer active.'
      using errcode = '55000';
  end if;

  update private.profile_photo_objects registry
  set
    state = 'cleanup',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where registry.user_id = caller_id
    and registry.state = 'canonical'
    and registry.id <> registered_object.id;

  update private.profile_photo_objects registry
  set
    state = 'canonical',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where registry.id = registered_object.id;

  update public.profiles profile
  set
    avatar_url = target_storage_path,
    name = case when target_update_text then btrim(target_name) else profile.name end,
    email = case when target_update_text then btrim(target_email) else profile.email end
  where profile.user_id = caller_id
  returning profile.* into saved_profile;

  return jsonb_build_object(
    'committed', true,
    'profile', to_jsonb(saved_profile)
  );
end;
$$;

create or replace function public.abandon_profile_photo_upload(target_storage_path text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  perform 1
  from public.profiles profile
  where profile.user_id = caller_id
  for update;
  if not found then
    raise exception 'Profile does not exist.' using errcode = '23503';
  end if;

  update private.profile_photo_objects registry
  set
    state = 'cleanup',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where registry.user_id = caller_id
    and registry.storage_path = target_storage_path
    and registry.state = 'pending_upload';
  return found;
end;
$$;

create or replace function public.expire_profile_photo_uploads(
  target_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  expired_count integer := 0;
begin
  for candidate in
    select registry.id, registry.user_id
    from private.profile_photo_objects registry
    where registry.state = 'pending_upload'
      and registry.upload_expires_at <= clock_timestamp()
    order by registry.upload_expires_at, registry.id
    limit greatest(1, least(coalesce(target_limit, 100), 500))
  loop
    perform 1
    from public.profiles profile
    where profile.user_id = candidate.user_id
    for update;

    update private.profile_photo_objects registry
    set
      state = 'cleanup',
      upload_expires_at = null,
      claim_token = null,
      claim_expires_at = null,
      updated_at = clock_timestamp()
    where registry.id = candidate.id
      and registry.state = 'pending_upload'
      and registry.upload_expires_at <= clock_timestamp();
    if found then
      expired_count := expired_count + 1;
    end if;
  end loop;

  return expired_count;
end;
$$;

create or replace function public.claim_profile_photo_cleanup(target_limit integer default 20)
returns table (job_id uuid, storage_path text, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  current_avatar_path text;
begin
  if caller_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select profile.avatar_url into current_avatar_path
  from public.profiles profile
  where profile.user_id = caller_id
  for update;
  if not found then
    raise exception 'Profile does not exist.' using errcode = '23503';
  end if;

  -- A browser can disappear after Storage accepted the object but before the
  -- commit/abandon request arrives. Reclassify only this caller's expired
  -- registrations while the per-user profile mutex is held so the ordinary
  -- cleanup visit is sufficient to make those objects collectible. The
  -- service sweep remains available for users who never return.
  update private.profile_photo_objects registry
  set
    state = 'cleanup',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where registry.user_id = caller_id
    and registry.state = 'pending_upload'
    and registry.upload_expires_at <= clock_timestamp();

  return query
  with candidates as (
    select registry.id
    from private.profile_photo_objects registry
    where registry.user_id = caller_id
      and registry.state = 'cleanup'
      and registry.storage_path is distinct from current_avatar_path
      and (
        registry.claim_expires_at is null
        or registry.claim_expires_at <= clock_timestamp()
      )
    order by registry.created_at, registry.id
    for update skip locked
    limit greatest(1, least(coalesce(target_limit, 20), 50))
  ), claimed as (
    update private.profile_photo_objects registry set
      state = 'cleanup',
      upload_expires_at = null,
      claim_token = gen_random_uuid(),
      claim_expires_at = clock_timestamp() + interval '5 minutes',
      attempts = registry.attempts + 1,
      updated_at = clock_timestamp()
    from candidates
    where registry.id = candidates.id
    returning registry.id, registry.storage_path, registry.claim_token
  )
  select claimed.id, claimed.storage_path, claimed.claim_token
  from claimed;
end;
$$;

create or replace function public.confirm_profile_photo_cleanup(
  target_job_id uuid,
  target_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  registry_path text;
  registry_object_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  perform 1
  from public.profiles profile
  where profile.user_id = caller_id
  for update;
  if not found then
    raise exception 'Profile does not exist.' using errcode = '23503';
  end if;

  select registry.storage_path, registry.storage_object_id
    into registry_path, registry_object_id
  from private.profile_photo_objects registry
  where registry.id = target_job_id
    and registry.user_id = caller_id
    and registry.state = 'cleanup'
    and registry.claim_token = target_claim_token
    and registry.claim_expires_at > clock_timestamp()
  for update;
  if registry_path is null then
    return false;
  end if;
  if exists (
    select 1
    from storage.objects object_row
    where object_row.bucket_id = 'profile-photos'
      and object_row.name = registry_path
      and (
        registry_object_id is null
        or object_row.id = registry_object_id
      )
  ) then
    raise exception 'Profile-photo object still exists; cleanup is not confirmed.'
      using errcode = '55000';
  end if;

  update private.profile_photo_objects registry
  set
    state = 'retired',
    claim_token = null,
    claim_expires_at = null,
    retired_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where registry.id = target_job_id
    and registry.user_id = caller_id
    and registry.state = 'cleanup'
    and registry.claim_token = target_claim_token
    and registry.claim_expires_at > clock_timestamp();
  if found then
    update private.profile_photo_path_tombstones tombstone
    set
      retired_at = coalesce(tombstone.retired_at, clock_timestamp()),
      reason = 'cleanup'
    where tombstone.path_sha256 = private.profile_photo_path_sha256(registry_path);
  end if;
  return found;
end;
$$;

create or replace function private.lock_profile_photo_account_scope_when_sealing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sealed
    and not old.sealed
    and new.reason = 'account_erasure'
    and new.subject_user_id is not null
  then
    perform 1
    from public.profiles profile
    where profile.user_id = new.subject_user_id
    for update;
  end if;
  return new;
end;
$$;

revoke all on function private.lock_profile_photo_account_scope_when_sealing()
  from public, anon, authenticated, service_role;

drop trigger if exists a_profile_photo_lock_account_scope_when_sealing
  on private.retired_community_deletion_batches;
create trigger a_profile_photo_lock_account_scope_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.lock_profile_photo_account_scope_when_sealing();

revoke all on function public.register_profile_photo_upload(text)
  from public, anon, authenticated, service_role;
revoke all on function public.commit_profile_photo_upload(text, timestamptz, boolean, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.abandon_profile_photo_upload(text)
  from public, anon, authenticated, service_role;
revoke all on function public.expire_profile_photo_uploads(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_profile_photo_cleanup(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_profile_photo_cleanup(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.register_profile_photo_upload(text) to authenticated;
grant execute on function public.commit_profile_photo_upload(text, timestamptz, boolean, text, text)
  to authenticated;
grant execute on function public.abandon_profile_photo_upload(text) to authenticated;
grant execute on function public.expire_profile_photo_uploads(integer) to service_role;
grant execute on function public.claim_profile_photo_cleanup(integer) to authenticated;
grant execute on function public.confirm_profile_photo_cleanup(uuid, uuid) to authenticated;

create or replace function private.guard_profile_photo_storage_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_object storage.objects%rowtype;
  caller_id uuid := auth.uid();
  path_user_id uuid;
  registry_row private.profile_photo_objects%rowtype;
  fou_delete_allowed boolean := false;
begin
  if tg_op = 'UPDATE' then
    if old.bucket_id = 'profile-photos' or new.bucket_id = 'profile-photos' then
      raise exception 'Profile-photo objects are immutable and cannot be overwritten.'
        using errcode = '55000';
    end if;
    return new;
  end if;

  target_object := case when tg_op = 'DELETE' then old else new end;
  if target_object.bucket_id <> 'profile-photos' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  begin
    path_user_id := split_part(target_object.name, '/', 1)::uuid;
  exception
    when invalid_text_representation then
      raise exception 'Invalid profile-photo Storage path.' using errcode = '22023';
  end;
  if private.profile_photo_path_from_value(
      target_object.name,
      path_user_id,
      tg_op = 'INSERT'
    ) is distinct from target_object.name
  then
    raise exception 'Invalid profile-photo Storage path.' using errcode = '22023';
  end if;
  if (
      target_object.owner is not null
      and target_object.owner <> path_user_id
    ) or (
      nullif(to_jsonb(target_object)->>'owner_id', '') is not null
      and to_jsonb(target_object)->>'owner_id' <> path_user_id::text
    )
  then
    raise exception 'Profile-photo Storage owner does not match its path owner.'
      using errcode = '42501';
  end if;
  if caller_id is not null and path_user_id <> caller_id then
    raise exception 'Profile-photo objects can only be changed by their owner.'
      using errcode = '42501';
  end if;

  select registry.* into registry_row
  from private.profile_photo_objects registry
  where registry.user_id = path_user_id
    and registry.storage_path = target_object.name
  for update;

  if tg_op = 'INSERT' then
    if registry_row.id is null
      or registry_row.state <> 'pending_upload'
      or registry_row.upload_expires_at <= clock_timestamp()
      or registry_row.storage_object_id is not null
    then
      raise exception 'Profile-photo upload is not registered or has expired.'
        using errcode = '55000';
    end if;

    update private.profile_photo_objects registry
    set
      storage_object_id = new.id,
      updated_at = clock_timestamp()
    where registry.id = registry_row.id
      and registry.state = 'pending_upload'
      and registry.storage_object_id is null
      and registry.upload_expires_at > clock_timestamp();
    if not found then
      raise exception 'Profile-photo upload is not registered or has expired.'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if caller_id = path_user_id
    and registry_row.id is not null
    and registry_row.state = 'cleanup'
    and registry_row.storage_object_id = old.id
    and registry_row.claim_token is not null
    and registry_row.claim_expires_at > clock_timestamp()
  then
    return old;
  end if;

  select exists (
    select 1
    from private.retired_community_storage_work work
    join private.retired_community_deletion_batches batch_row
      on batch_row.id = work.batch_id
    where work.object_id = old.id
      and work.bucket_id = old.bucket_id
      and work.object_name = old.name
      and work.expected_row_sha256 = private.retired_community_sha256(
        to_jsonb(target_object)::text
      )
      and work.status = 'claimed'
      and work.claim_token is not null
      and work.claimed_at > clock_timestamp() - interval '15 minutes'
      and batch_row.reason = 'account_erasure'
      and batch_row.subject_user_id = path_user_id
      and batch_row.sealed
      and batch_row.execute_after <= clock_timestamp()
      and not exists (
        select 1
        from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id
          and terminal.event_type in ('cancelled', 'executed')
      )
  ) into fou_delete_allowed;

  if not fou_delete_allowed then
    raise exception 'Only an actively claimed non-canonical profile photo can be deleted.'
      using errcode = '55000';
  end if;

  if registry_row.id is not null and registry_row.state <> 'retired' then
    update private.profile_photo_objects registry
    set
      state = 'retired',
      upload_expires_at = null,
      claim_token = null,
      claim_expires_at = null,
      retired_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where registry.id = registry_row.id
      and registry.state <> 'retired';
  end if;
  update private.profile_photo_path_tombstones tombstone
  set
    retired_at = coalesce(tombstone.retired_at, clock_timestamp()),
    reason = 'account_erasure'
  where tombstone.path_sha256 = private.profile_photo_path_sha256(old.name);
  return old;
end;
$$;

revoke all on function private.guard_profile_photo_storage_object()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_profile_photo_storage_insert on storage.objects;
create trigger guard_profile_photo_storage_insert
  before insert on storage.objects
  for each row execute function private.guard_profile_photo_storage_object();

drop trigger if exists guard_profile_photo_storage_update on storage.objects;
create trigger guard_profile_photo_storage_update
  before update on storage.objects
  for each row execute function private.guard_profile_photo_storage_object();

drop trigger if exists guard_profile_photo_storage_delete on storage.objects;
create trigger guard_profile_photo_storage_delete
  before delete on storage.objects
  for each row execute function private.guard_profile_photo_storage_object();

create or replace function public.profile_photo_storage_insert_is_allowed(
  target_object_id uuid,
  target_storage_path text
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and private.profile_photo_path_from_value(
      target_storage_path,
      auth.uid(),
      true
    ) = target_storage_path
    and exists (
      select 1
      from private.profile_photo_objects registry
      where registry.user_id = auth.uid()
        and registry.storage_path = target_storage_path
        and registry.state = 'pending_upload'
        and registry.upload_expires_at > clock_timestamp()
        and (
          registry.storage_object_id is null
          or registry.storage_object_id = target_object_id
        )
    );
$$;

create or replace function public.profile_photo_storage_delete_is_allowed(
  target_object_id uuid,
  target_storage_path text
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from private.profile_photo_objects registry
      where registry.user_id = auth.uid()
        and registry.storage_path = target_storage_path
        and registry.storage_object_id = target_object_id
        and registry.state = 'cleanup'
        and registry.claim_token is not null
        and registry.claim_expires_at > clock_timestamp()
    );
$$;

revoke all on function public.profile_photo_storage_insert_is_allowed(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.profile_photo_storage_delete_is_allowed(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.profile_photo_storage_insert_is_allowed(uuid, text)
  to authenticated;
grant execute on function public.profile_photo_storage_delete_is_allowed(uuid, text)
  to authenticated;

drop policy if exists "Profile photos are publicly readable" on storage.objects;
drop policy if exists "Users can read own profile photo objects" on storage.objects;
create policy "Users can read own profile photo objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload own profile photo objects" on storage.objects;
create policy "Users can upload own profile photo objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.profile_photo_storage_insert_is_allowed(id, name)
  );

drop policy if exists "Users can update own profile photo objects" on storage.objects;
drop policy if exists "Users can delete own profile photo objects" on storage.objects;
create policy "Users can delete own profile photo objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.profile_photo_storage_delete_is_allowed(id, name)
  );

drop policy if exists "Canonical profile photos cannot be deleted" on storage.objects;
create policy "Canonical profile photos cannot be deleted"
  on storage.objects
  as restrictive
  for delete
  to authenticated
  using (
    bucket_id <> 'profile-photos'
    or public.profile_photo_storage_delete_is_allowed(
      storage.objects.id,
      storage.objects.name
    )
  );

drop policy if exists "Pending account erasure blocks personal asset deletes" on storage.objects;
create policy "Pending account erasure blocks personal asset deletes"
  on storage.objects
  as restrictive
  for delete
  to authenticated
  using (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  );

revoke insert, update on public.profiles from authenticated;
revoke update (user_id, name, email, avatar_url, challenge_start_date, time_zone)
  on public.profiles from authenticated;
grant insert (user_id, name, email, challenge_start_date, time_zone)
  on public.profiles to authenticated;
grant update (name, email, challenge_start_date, time_zone)
  on public.profiles to authenticated;

comment on table private.profile_photo_objects is
  'Profile-photo lifecycle registry. Legal edges are pending_upload -> canonical/cleanup, canonical -> cleanup, and cleanup -> retired.';
comment on table private.profile_photo_path_tombstones is
  'Irreversible SHA-256 path reservations that survive account deletion and prevent profile-photo path reuse.';
comment on function public.register_profile_photo_upload(text) is
  'Creates a short-lived immutable registration before a profile-photo Storage upload.';
comment on function public.commit_profile_photo_upload(text, timestamptz, boolean, text, text) is
  'Atomically activates one uploaded object, queues its predecessor, and optionally applies versioned text edits.';
comment on function public.abandon_profile_photo_upload(text) is
  'Moves an uncommitted upload registration into durable cleanup after an ambiguous or failed upload.';
comment on function public.claim_profile_photo_cleanup(integer) is
  'Expires the caller''s stale registrations, then claims only non-canonical cleanup work; the service sweep handles users who never return.';
comment on function public.confirm_profile_photo_cleanup(uuid, uuid) is
  'Retires a claimed path permanently only after its Storage metadata row is absent.';
comment on function public.expire_profile_photo_uploads(integer) is
  'Service-only transition from expired pending uploads to cleanup; it never claims or deletes them.';

commit;
