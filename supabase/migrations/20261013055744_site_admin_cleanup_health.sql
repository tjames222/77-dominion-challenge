set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- FOU-1502: bounded, native-session/MFA guarded read-only operations metadata.
-- These partial indexes trade additional lifecycle-write work for ordered,
-- selective probes. Ordinary transactional builds take SHARE locks; the short
-- migration timeouts fail closed instead of waiting indefinitely for writers.
create index profile_photo_objects_cleanup_eligible_idx
  on private.profile_photo_objects
    ((greatest(next_attempt_at, coalesce(claim_expires_at, '-infinity'::timestamptz))), id)
  include (next_attempt_at, claim_expires_at)
  where state = 'cleanup';
create index profile_photo_objects_cleanup_service_lease_idx
  on private.profile_photo_objects (claim_expires_at, id)
  where state = 'cleanup' and claim_actor = 'service';
create index profile_photo_objects_cleanup_failure_idx
  on private.profile_photo_objects (last_failed_at desc, id)
  where last_failed_at is not null;

create function public.site_admin_get_cleanup_health(target_expected_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
  observed_at timestamptz := statement_timestamp();
  counters jsonb;
  oldest_eligible_at timestamptz;
  extension_available boolean;
  catalog_available boolean;
  job_count integer := 0;
  target_job_id bigint;
  job_active boolean;
  schedule_matches boolean;
  history_coverage text := 'unavailable';
  recent_runs jsonb := '[]'::jsonb;
  first_run_started_at timestamptz;
  freshness text := 'unknown';
begin
  perform private.require_site_admin('operations.read', target_expected_actor_id, false);

  -- Six independent ordered prefixes, each containing at most 1001 visible rows.
  -- The time predicate deliberately stays OUTSIDE LIMIT: qualifying rows form
  -- a prefix in each chosen direction. This preserves exact capped counts and
  -- avoids time-selectivity estimates for five probes. LIMIT is not a universal
  -- physical-work guarantee: churn/correlation can still yield bitmap+sort plans
  -- and MVCC heap visits. Release size/lock bounds and measured plans are separate.
  -- Counts overlap; failuresLastHour counts objects with a recent last failure,
  -- not failure events. The cap bounds visible results, not MVCC heap visits.
  -- BEGIN BOUNDED COUNTERS
  select jsonb_object_agg(bucket, jsonb_build_object(
    'count', least(amount, 1000), 'hasMore', amount > 1000)) into counters
  from (
    select 'expiredPending' as bucket, count(*) as amount from (
      select upload_expires_at from private.profile_photo_objects
      where state = 'pending_upload'
      order by upload_expires_at, user_id, id limit 1001
    ) expired_pending where upload_expires_at <= observed_at
    union all
    select 'ready', count(*) from (
      select greatest(next_attempt_at, coalesce(claim_expires_at, '-infinity'::timestamptz)) as eligible_at
      from private.profile_photo_objects
      where state = 'cleanup'
      order by greatest(next_attempt_at, coalesce(claim_expires_at, '-infinity'::timestamptz)), id limit 1001
    ) ready where eligible_at <= observed_at
    union all
    select 'leased', count(*) from (
      select claim_expires_at from private.profile_photo_objects
      where state = 'cleanup' and claim_actor = 'service'
      order by claim_expires_at desc, id desc limit 1001
    ) leased where claim_expires_at > observed_at
    union all
    select 'staleLeases', count(*) from (
      select claim_expires_at from private.profile_photo_objects
      where state = 'cleanup' and claim_actor = 'service'
      order by claim_expires_at, id limit 1001
    ) stale_leases where claim_expires_at <= observed_at
    union all
    select 'backingOff', count(*) from (
      select next_attempt_at from private.profile_photo_objects
      where state = 'cleanup'
      order by next_attempt_at desc, claim_expires_at desc, created_at desc, id desc limit 1001
    ) backing_off where next_attempt_at > observed_at
    union all
    select 'failuresLastHour', count(*) from (
      select last_failed_at from private.profile_photo_objects
      -- Future timestamps are not failures within the preceding hour. Apply
      -- this upper range bound in the descending index before taking a prefix;
      -- otherwise future anomalies could consume the cap and hide real rows.
      where last_failed_at is not null and last_failed_at <= observed_at
      order by last_failed_at desc, id limit 1001
    ) failures where last_failed_at >= observed_at - interval '1 hour'
  ) bounded;
  -- END BOUNDED COUNTERS

  -- BEGIN OLDEST ELIGIBLE
  select eligible_at into oldest_eligible_at from (
    select greatest(next_attempt_at, coalesce(claim_expires_at, '-infinity'::timestamptz)) as eligible_at
    from private.profile_photo_objects where state = 'cleanup'
    order by greatest(next_attempt_at, coalesce(claim_expires_at, '-infinity'::timestamptz)), id limit 1
  ) oldest where eligible_at <= observed_at;
  -- END OLDEST ELIGIBLE

  select exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
    into extension_available;
  catalog_available := extension_available
    and pg_catalog.to_regclass('cron.job') is not null
    and pg_catalog.to_regclass('cron.job_run_details') is not null;
  if catalog_available then
    -- Fixed identifiers, no caller-controlled SQL. The jobname/username native
    -- index bounds the same-name probe to two jobs, sufficient for ambiguity.
    execute $jobs$
      select count(*)::integer, min(jobid), bool_and(active),
        bool_and(schedule = '*/5 * * * *')
      from (select jobid, active, schedule from cron.job
        where jobname = 'process-profile-photo-cleanup'
        order by username limit 2) bounded_jobs
    $jobs$ into job_count, target_job_id, job_active, schedule_matches;
    if job_count = 1 then
      -- Bound the GLOBAL allocation-ID tail before filtering by job. Filtering
      -- first can scan an unbounded unrelated history even with LIMIT 2.
      -- Allocation order is explicitly not wall-clock start/end-time order.
      execute $history$
        with global_tail as materialized (
          select runid, jobid, status, start_time, end_time
          from cron.job_run_details order by runid desc limit 1001
        ), usable_tail as materialized (
          select * from global_tail order by runid desc limit 1000
        ), matching_runs as (
          select runid, status, start_time, end_time from usable_tail
          where jobid = $1 order by runid desc limit 2
        )
        select case when (select count(*) from global_tail) > 1000 then 'bounded' else 'complete' end,
          coalesce(jsonb_agg(jsonb_build_object(
            'status', case when status in ('starting','connecting','sending','running','succeeded','failed')
              then status else 'unknown' end,
            'startedAt', case when isfinite(start_time) then start_time else null end,
            'endedAt', case when isfinite(end_time) then end_time else null end
          ) order by runid desc), '[]'::jsonb)
        from matching_runs
      $history$ into history_coverage, recent_runs using target_job_id;
      -- An incomplete global history never earns a freshness claim. Even a
      -- fresh run proves SQL enqueue only, not HTTP delivery or object deletion.
      if history_coverage = 'complete' then
        if jsonb_array_length(recent_runs) = 0 then
          freshness := 'stale';
        else
          first_run_started_at := (recent_runs -> 0 ->> 'startedAt')::timestamptz;
          if first_run_started_at is not null and first_run_started_at <= observed_at then
            freshness := case when first_run_started_at >= observed_at - interval '15 minutes'
              then 'fresh' else 'stale' end;
          end if;
        end if;
      end if;
    else
      job_active := null;
      schedule_matches := null;
    end if;
  end if;

  return jsonb_build_object(
    'schemaVersion', 1, 'actorId', target_expected_actor_id, 'observedAt', observed_at,
    'counterLimit', 1000, 'counters', counters,
    'oldestEligibleAt', case when isfinite(oldest_eligible_at) then oldest_eligible_at else null end,
    'cron', jsonb_build_object(
      'extensionAvailable', extension_available, 'catalogAvailable', catalog_available,
      'jobState', case when not catalog_available then 'unavailable'
        when job_count = 0 then 'missing' when job_count = 1 then 'present' else 'ambiguous' end,
      'active', job_active, 'scheduleMatches', schedule_matches,
      'historyCoverage', history_coverage, 'historyLimit', 1000, 'lastRunsOrder', 'run-id-desc',
      'freshness', freshness, 'staleAfterSeconds', 900, 'lastRuns', recent_runs,
      'transportEvidence', 'enqueue-only'
    )
  );
end;
$$;

revoke all on function public.site_admin_get_cleanup_health(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.site_admin_get_cleanup_health(uuid) to authenticated;
