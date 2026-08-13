set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- FOU-802: cleanup must continue even when the member never returns to the
-- Profile page. Browser callers lose delete leases; a service worker receives
-- bounded, expiring, exact-object leases and must reverify immediately before
-- using the Storage API.

alter table private.profile_photo_objects
  add column claim_actor text,
  add column delete_authorized_at timestamptz,
  add column next_attempt_at timestamptz not null default clock_timestamp(),
  add column last_error_code text,
  add column last_failed_at timestamptz;

update private.profile_photo_objects registry
set claim_actor = 'member'
where registry.claim_token is not null;

alter table private.profile_photo_objects
  add constraint profile_photo_objects_claim_actor_check check (
    claim_actor is null or claim_actor in ('member', 'service')
  ),
  add constraint profile_photo_objects_claim_actor_presence_check check (
    (claim_token is null) = (claim_actor is null)
  ),
  add constraint profile_photo_objects_delete_authorization_check check (
    delete_authorized_at is null or claim_actor = 'service'
  ),
  add constraint profile_photo_objects_failure_code_check check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'
  );

create index profile_photo_objects_service_cleanup_idx
  on private.profile_photo_objects (
    next_attempt_at,
    claim_expires_at,
    created_at,
    id
  )
  where state = 'cleanup';

create or replace function private.normalize_profile_photo_cleanup_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.claim_token is null then
    new.claim_actor := null;
    new.delete_authorized_at := null;
  elsif new.claim_actor is null then
    new.claim_actor := 'member';
  end if;
  if new.state <> 'cleanup' then
    new.delete_authorized_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.normalize_profile_photo_cleanup_lease()
  from public, anon, authenticated, service_role;

drop trigger if exists b_normalize_profile_photo_cleanup_lease
  on private.profile_photo_objects;
create trigger b_normalize_profile_photo_cleanup_lease
  before insert or update on private.profile_photo_objects
  for each row execute function private.normalize_profile_photo_cleanup_lease();

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
  server_now timestamptz := clock_timestamp();
begin
  for candidate in
    select registry.id, registry.user_id
    from private.profile_photo_objects registry
    where registry.state = 'pending_upload'
      and registry.upload_expires_at <= server_now
    order by registry.upload_expires_at, registry.id
    limit greatest(1, least(coalesce(target_limit, 100), 500))
  loop
    -- Match commit, account-erasure sealing, and member admission lock order.
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
      claim_actor = null,
      delete_authorized_at = null,
      next_attempt_at = server_now,
      updated_at = server_now
    where registry.id = candidate.id
      and registry.state = 'pending_upload'
      and registry.upload_expires_at <= server_now;
    if found then expired_count := expired_count + 1; end if;
  end loop;
  return expired_count;
end;
$$;

create or replace function public.claim_profile_photo_cleanup_service(
  target_limit integer default 25
)
returns table (
  job_id uuid,
  user_id uuid,
  storage_path text,
  storage_object_id uuid,
  claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  server_now timestamptz := clock_timestamp();
begin
  perform public.expire_profile_photo_uploads(
    greatest(1, least(coalesce(target_limit, 25) * 2, 200))
  );

  return query
  with candidates as (
    select registry.id
    from private.profile_photo_objects registry
    join public.profiles profile on profile.user_id = registry.user_id
    where registry.state = 'cleanup'
      and registry.storage_path is distinct from profile.avatar_url
      and registry.next_attempt_at <= server_now
      and (
        registry.claim_expires_at is null
        or registry.claim_expires_at <= server_now
      )
      and not private.retired_community_account_erasure_is_pending(registry.user_id)
    order by registry.next_attempt_at, registry.created_at, registry.id
    for update of registry skip locked
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ), claimed as (
    update private.profile_photo_objects registry
    set
      claim_token = gen_random_uuid(),
      claim_expires_at = server_now + interval '5 minutes',
      claim_actor = 'service',
      delete_authorized_at = null,
      attempts = registry.attempts + 1,
      updated_at = server_now
    from candidates
    where registry.id = candidates.id
    returning
      registry.id,
      registry.user_id,
      registry.storage_path,
      registry.storage_object_id,
      registry.claim_token
  )
  select
    claimed.id,
    claimed.user_id,
    claimed.storage_path,
    claimed.storage_object_id,
    claimed.claim_token
  from claimed;
end;
$$;

create or replace function public.verify_profile_photo_cleanup_service(
  target_job_id uuid,
  target_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
  registry_path text;
begin
  select registry.user_id into target_user_id
  from private.profile_photo_objects registry
  where registry.id = target_job_id;
  if target_user_id is null then return false; end if;

  perform 1
  from public.profiles profile
  where profile.user_id = target_user_id
  for update;
  if not found then return false; end if;

  select registry.storage_path into registry_path
  from private.profile_photo_objects registry
  where registry.id = target_job_id
    and registry.user_id = target_user_id
    and registry.state = 'cleanup'
    and registry.claim_actor = 'service'
    and registry.claim_token = target_claim_token
    and registry.claim_expires_at > clock_timestamp()
  for update;
  if registry_path is null
    or private.retired_community_account_erasure_is_pending(target_user_id)
    or exists (
      select 1
      from public.profiles profile
      where profile.user_id = target_user_id
        and profile.avatar_url = registry_path
    )
  then
    return false;
  end if;

  update private.profile_photo_objects registry
  set
    delete_authorized_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where registry.id = target_job_id
    and registry.claim_token = target_claim_token;
  return found;
end;
$$;

create or replace function public.confirm_profile_photo_cleanup_service(
  target_job_id uuid,
  target_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
  registry_path text;
  registry_object_id uuid;
begin
  select registry.user_id into target_user_id
  from private.profile_photo_objects registry
  where registry.id = target_job_id;
  if target_user_id is null then return false; end if;

  perform 1
  from public.profiles profile
  where profile.user_id = target_user_id
  for update;
  if not found then return false; end if;

  select registry.storage_path, registry.storage_object_id
    into registry_path, registry_object_id
  from private.profile_photo_objects registry
  where registry.id = target_job_id
    and registry.user_id = target_user_id
    and registry.state = 'cleanup'
    and registry.claim_actor = 'service'
    and registry.claim_token = target_claim_token
    and registry.claim_expires_at > clock_timestamp()
  for update;
  if registry_path is null
    or private.retired_community_account_erasure_is_pending(target_user_id)
    or exists (
      select 1
      from public.profiles profile
      where profile.user_id = target_user_id
        and profile.avatar_url = registry_path
    )
  then
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
    claim_actor = null,
    delete_authorized_at = null,
    last_error_code = null,
    last_failed_at = null,
    retired_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where registry.id = target_job_id
    and registry.claim_token = target_claim_token;
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

create or replace function public.fail_profile_photo_cleanup_service(
  target_job_id uuid,
  target_claim_token uuid,
  target_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  retry_seconds integer;
begin
  if target_error_code is null
    or target_error_code !~ '^[a-z0-9_]{1,64}$'
  then
    raise exception 'Invalid cleanup failure code.' using errcode = '22023';
  end if;

  select least(
    21600,
    30 * power(2, least(registry.attempts, 10))::integer
  ) into retry_seconds
  from private.profile_photo_objects registry
  where registry.id = target_job_id
    and registry.state = 'cleanup'
    and registry.claim_actor = 'service'
    and registry.claim_token = target_claim_token
  for update;
  if retry_seconds is null then return false; end if;

  update private.profile_photo_objects registry
  set
    claim_token = null,
    claim_expires_at = null,
    claim_actor = null,
    delete_authorized_at = null,
    next_attempt_at = clock_timestamp() + make_interval(secs => retry_seconds),
    last_error_code = target_error_code,
    last_failed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where registry.id = target_job_id
    and registry.claim_token = target_claim_token;
  return found;
end;
$$;

create or replace function public.profile_photo_cleanup_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'expiredPending', count(*) filter (
      where registry.state = 'pending_upload'
        and registry.upload_expires_at <= now()
    ),
    'ready', count(*) filter (
      where registry.state = 'cleanup'
        and registry.next_attempt_at <= now()
        and (
          registry.claim_expires_at is null
          or registry.claim_expires_at <= now()
        )
    ),
    'leased', count(*) filter (
      where registry.state = 'cleanup'
        and registry.claim_actor = 'service'
        and registry.claim_expires_at > now()
    ),
    'staleLeases', count(*) filter (
      where registry.state = 'cleanup'
        and registry.claim_actor = 'service'
        and registry.claim_expires_at <= now()
    ),
    'backingOff', count(*) filter (
      where registry.state = 'cleanup'
        and registry.next_attempt_at > now()
    ),
    'oldestReadyAt', min(registry.next_attempt_at) filter (
      where registry.state = 'cleanup'
        and registry.next_attempt_at <= now()
    ),
    'failuresLastHour', count(*) filter (
      where registry.last_failed_at >= now() - interval '1 hour'
    ),
    'generatedAt', now()
  )
  from private.profile_photo_objects registry;
$$;

revoke all on function public.claim_profile_photo_cleanup(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_profile_photo_cleanup(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.profile_photo_storage_delete_is_allowed(uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.claim_profile_photo_cleanup_service(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_profile_photo_cleanup_service(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_profile_photo_cleanup_service(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_profile_photo_cleanup_service(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.profile_photo_cleanup_health()
  from public, anon, authenticated, service_role;

grant execute on function public.claim_profile_photo_cleanup_service(integer)
  to service_role;
grant execute on function public.verify_profile_photo_cleanup_service(uuid, uuid)
  to service_role;
grant execute on function public.confirm_profile_photo_cleanup_service(uuid, uuid)
  to service_role;
grant execute on function public.fail_profile_photo_cleanup_service(uuid, uuid, text)
  to service_role;
grant execute on function public.profile_photo_cleanup_health()
  to service_role;

drop policy if exists "Users can delete own profile photo objects" on storage.objects;
drop policy if exists "Canonical profile photos cannot be deleted" on storage.objects;

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
  account_erasure_delete_allowed boolean := false;
  cleanup_delete_allowed boolean := false;
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

  if caller_id is null
    and registry_row.id is not null
    and registry_row.state = 'cleanup'
    and registry_row.storage_object_id = old.id
    and registry_row.claim_actor = 'service'
    and registry_row.claim_token is not null
    and registry_row.claim_expires_at > clock_timestamp()
    and registry_row.delete_authorized_at > clock_timestamp() - interval '1 minute'
    and not private.retired_community_account_erasure_is_pending(path_user_id)
    and not exists (
      select 1
      from public.profiles profile
      where profile.user_id = path_user_id
        and profile.avatar_url = old.name
    )
  then
    cleanup_delete_allowed := true;
  end if;

  if cleanup_delete_allowed then return old; end if;

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
  ) into account_erasure_delete_allowed;

  if not account_erasure_delete_allowed then
    raise exception 'Only an exactly authorized non-canonical profile photo can be deleted.'
      using errcode = '55000';
  end if;

  if registry_row.id is not null and registry_row.state <> 'retired' then
    update private.profile_photo_objects registry
    set
      state = 'retired',
      upload_expires_at = null,
      claim_token = null,
      claim_expires_at = null,
      claim_actor = null,
      delete_authorized_at = null,
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

comment on function public.claim_profile_photo_cleanup_service(integer) is
  'Service-only bounded cleanup leasing with expired-upload collection and SKIP LOCKED concurrency.';
comment on function public.verify_profile_photo_cleanup_service(uuid, uuid) is
  'Rechecks an exact service lease, canonical pointer, and account-erasure state immediately before Storage deletion.';
comment on function public.profile_photo_cleanup_health() is
  'Service-only aggregate cleanup health without member IDs, object paths, or content.';
