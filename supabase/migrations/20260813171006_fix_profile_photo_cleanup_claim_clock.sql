-- FOU-802 follow-up: a cleanup claim captures its eligibility clock only
-- after expiring pending uploads. The worker can therefore claim an upload
-- made ready by the same call instead of waiting for a later sweep.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

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
  server_now timestamptz;
begin
  perform public.expire_profile_photo_uploads(
    greatest(1, least(coalesce(target_limit, 25) * 2, 200))
  );

  -- expire_profile_photo_uploads assigns next_attempt_at from its own clock.
  -- Capture this function's comparison time afterwards so that work made
  -- ready above is eligible in this same transaction.
  server_now := clock_timestamp();

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

revoke all on function public.claim_profile_photo_cleanup_service(integer)
  from public, anon, authenticated;
grant execute on function public.claim_profile_photo_cleanup_service(integer)
  to service_role;

comment on function public.claim_profile_photo_cleanup_service(integer) is
  'Claims bounded, expiring service cleanup leases, including stale uploads expired by the same call.';

commit;
