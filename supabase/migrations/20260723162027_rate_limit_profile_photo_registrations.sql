begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create index profile_photo_objects_user_created_at_idx
  on private.profile_photo_objects (user_id, created_at desc);

create or replace function public.register_profile_photo_upload(target_storage_path text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  server_now timestamptz;
  existing_registration private.profile_photo_objects%rowtype;
  registration_id uuid;
  pending_count integer;
  cleanup_count integer;
  hourly_count integer;
  daily_count integer;
begin
  if caller_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if target_storage_path is null or target_storage_path !~ (
    '^' || caller_id::text
    || '/avatar-[0-9]{13}-[a-f0-9]{32}[.](jpg|webp)$'
  ) then
    raise exception 'Invalid profile-photo upload path.' using errcode = '22023';
  end if;

  -- Every admission decision for an account is serialized on the same mutex
  -- used by commit, cleanup, and account-erasure sealing.
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

  server_now := clock_timestamp();

  select registry.* into existing_registration
  from private.profile_photo_objects registry
  where registry.user_id = caller_id
    and registry.storage_path = target_storage_path;
  if found then
    if existing_registration.state = 'pending_upload'
      and existing_registration.upload_expires_at > server_now
    then
      return existing_registration.id;
    end if;
    raise exception 'Profile-photo paths are immutable and cannot be reused.'
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
  where registry.user_id = caller_id;

  if pending_count >= 3 then
    raise exception
      'Too many profile-photo uploads are pending. Wait for one to expire or finish before retrying.'
      using errcode = 'P8001';
  end if;
  if cleanup_count >= 20 then
    raise exception
      'Profile-photo cleanup backlog is full. Finish cleanup before registering another upload.'
      using errcode = 'P8002';
  end if;
  if hourly_count >= 6 then
    raise exception
      'Profile-photo hourly registration limit reached. Try again later.'
      using errcode = 'P8003';
  end if;
  if daily_count >= 24 then
    raise exception
      'Profile-photo daily registration limit reached. Try again tomorrow.'
      using errcode = 'P8004';
  end if;

  -- Only a successful new-path admission commits lifecycle normalization.
  -- Rejected calls remain mutation-free, while expired pending rows still
  -- consume the prospective cleanup budget above and cannot be reactivated.
  update private.profile_photo_objects registry
  set
    state = 'cleanup',
    upload_expires_at = null,
    claim_token = null,
    claim_expires_at = null,
    updated_at = server_now
  where registry.user_id = caller_id
    and registry.state = 'pending_upload'
    and registry.upload_expires_at <= server_now;

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
    ) values (
      caller_id,
      target_storage_path,
      'pending_upload',
      server_now + interval '15 minutes'
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

create or replace function public.profile_photo_registration_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with per_user as materialized (
    select
      registry.user_id,
      count(*) filter (
        where registry.created_at >= now() - interval '1 hour'
      ) as hourly_registrations,
      count(*) filter (
        where registry.created_at >= now() - interval '24 hours'
      ) as daily_registrations,
      count(*) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at > now()
      )
        as pending_registrations,
      count(*) filter (
        where registry.state = 'cleanup'
          or (
            registry.state = 'pending_upload'
            and registry.upload_expires_at <= now()
          )
      )
        as cleanup_registrations
    from private.profile_photo_objects registry
    group by registry.user_id
  ), lifecycle as materialized (
    select
      count(*) as total_rows,
      count(*) filter (
        where registry.created_at >= now() - interval '1 hour'
      ) as registrations_last_hour,
      count(*) filter (
        where registry.created_at >= now() - interval '24 hours'
      ) as registrations_last_day,
      count(*) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at > now()
      )
        as pending_registrations,
      count(*) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at <= now()
      ) as expired_pending_registrations,
      count(*) filter (where registry.state = 'cleanup')
        as cleanup_registrations,
      count(*) filter (
        where registry.state = 'cleanup'
          or (
            registry.state = 'pending_upload'
            and registry.upload_expires_at <= now()
          )
      ) as effective_cleanup_registrations,
      min(registry.created_at) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at > now()
      )
        as oldest_pending_created_at,
      min(registry.created_at) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at <= now()
      ) as oldest_expired_pending_created_at,
      min(registry.created_at) filter (where registry.state = 'cleanup')
        as oldest_cleanup_created_at
    from private.profile_photo_objects registry
  ), object_counts as materialized (
    select
      count(*) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at > now()
      )
        as pending_objects,
      count(*) filter (
        where registry.state = 'pending_upload'
          and registry.upload_expires_at <= now()
      ) as expired_pending_objects,
      count(*) filter (where registry.state = 'cleanup') as cleanup_objects,
      count(*) filter (
        where registry.state = 'cleanup'
          or (
            registry.state = 'pending_upload'
            and registry.upload_expires_at <= now()
          )
      ) as effective_cleanup_objects
    from private.profile_photo_objects registry
    join storage.objects object_row
      on object_row.id = registry.storage_object_id
     and object_row.bucket_id = 'profile-photos'
     and object_row.name = registry.storage_path
  )
  select jsonb_build_object(
    'thresholds', jsonb_build_object(
      'pending', 3,
      'cleanup', 20,
      'perHour', 6,
      'perDay', 24
    ),
    'totalLifecycleRows', lifecycle.total_rows,
    'totalPathTombstones', (
      select count(*) from private.profile_photo_path_tombstones
    ),
    'registrationsLastHour', lifecycle.registrations_last_hour,
    'registrationsLastDay', lifecycle.registrations_last_day,
    'pendingRegistrations', lifecycle.pending_registrations,
    'pendingObjects', object_counts.pending_objects,
    'expiredPendingRegistrations', lifecycle.expired_pending_registrations,
    'expiredPendingObjects', object_counts.expired_pending_objects,
    'cleanupRegistrations', lifecycle.cleanup_registrations,
    'cleanupObjects', object_counts.cleanup_objects,
    'effectiveCleanupRegistrations',
      lifecycle.effective_cleanup_registrations,
    'effectiveCleanupObjects', object_counts.effective_cleanup_objects,
    'oldestPendingCreatedAt', lifecycle.oldest_pending_created_at,
    'oldestExpiredPendingCreatedAt',
      lifecycle.oldest_expired_pending_created_at,
    'oldestCleanupCreatedAt', lifecycle.oldest_cleanup_created_at,
    'maxRegistrationsPerUserLastHour', coalesce((
      select max(per_user.hourly_registrations) from per_user
    ), 0),
    'maxRegistrationsPerUserLastDay', coalesce((
      select max(per_user.daily_registrations) from per_user
    ), 0),
    'usersAtPendingLimit', (
      select count(*) from per_user where per_user.pending_registrations >= 3
    ),
    'usersAtCleanupLimit', (
      select count(*) from per_user where per_user.cleanup_registrations >= 20
    ),
    'usersAtHourlyLimit', (
      select count(*) from per_user where per_user.hourly_registrations >= 6
    ),
    'usersAtDailyLimit', (
      select count(*) from per_user where per_user.daily_registrations >= 24
    ),
    'generatedAt', now()
  )
  from lifecycle
  cross join object_counts;
$$;

revoke all on function public.register_profile_photo_upload(text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_profile_photo_upload(text) to authenticated;

revoke all on function public.profile_photo_registration_health()
  from public, anon, authenticated, service_role;
grant execute on function public.profile_photo_registration_health() to service_role;

comment on function public.register_profile_photo_upload(text) is
  'Idempotently reserves one immutable path under per-user pending, cleanup, hourly, and daily admission limits.';
comment on function public.profile_photo_registration_health() is
  'Service-only aggregate profile-photo admission and cleanup health without user IDs, object paths, or member content.';

commit;
