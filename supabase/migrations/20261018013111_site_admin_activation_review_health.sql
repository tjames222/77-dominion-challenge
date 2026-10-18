set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- FOU-1502: recorded legacy review state only, not all current v2 activation
-- blockers. This ordinary transactional index build holds a SHARE lock until
-- commit. Release size/lock preflights are separate from the visible-row cap.
create index challenge_activation_reviews_unresolved_created_idx
  on private.challenge_activation_migration_reviews (created_at, user_id)
  where resolved_at is null;

create function public.site_admin_get_activation_review_health(target_expected_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set lock_timeout = '1s'
set timezone = 'UTC'
as $$
declare
  observed_at timestamptz := statement_timestamp();
  sampled_count integer;
  oldest_recorded_at timestamptz;
  oldest_recorded_state text;
begin
  perform private.require_site_admin('operations.read', target_expected_actor_id, false);

  -- Exactly one oldest-first materialized prefix, with a deterministic tie key.
  -- LIMIT bounds visible sampled rows, not dead tuples, MVCC heap visits,
  -- planner choices or total physical work. No per-account rows or evidence
  -- are returned.
  -- BEGIN BOUNDED LEGACY REVIEWS
  with sampled as materialized (
    select created_at
    from private.challenge_activation_migration_reviews
    where resolved_at is null
    order by created_at, user_id
    limit 1001
  )
  select count(*)::integer, min(created_at)
    into sampled_count, oldest_recorded_at
    from sampled;
  -- END BOUNDED LEGACY REVIEWS

  if sampled_count = 0 then
    oldest_recorded_state := 'none';
    oldest_recorded_at := null;
  elsif isfinite(oldest_recorded_at)
    and oldest_recorded_at >= timestamptz '0001-01-01 00:00:00+00'
    and oldest_recorded_at < timestamptz '10000-01-01 00:00:00+00'
    and oldest_recorded_at <= observed_at then
    oldest_recorded_state := 'known';
  else
    -- Do not skip an invalid earliest record and mislabel the next as oldest.
    oldest_recorded_state := 'unknown';
    oldest_recorded_at := null;
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'actorId', target_expected_actor_id,
    'observedAt', observed_at,
    'coverage', 'legacy-activation-migration-reviews-only',
    'counterLimit', 1000,
    'unresolved', jsonb_build_object('count', least(sampled_count, 1000), 'hasMore', sampled_count > 1000),
    'oldestRecordedAt', oldest_recorded_at,
    'oldestRecordedState', oldest_recorded_state
  );
end;
$$;

revoke all on function public.site_admin_get_activation_review_health(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.site_admin_get_activation_review_health(uuid) to authenticated;
