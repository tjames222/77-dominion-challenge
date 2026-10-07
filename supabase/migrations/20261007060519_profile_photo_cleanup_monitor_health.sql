set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- FOU-802: expose only bounded operational metadata, never Cron commands,
-- return_message, connection identity, Vault values or Storage/member data.
-- Cron success proves SQL enqueue only, not pg_net HTTP delivery.
create function public.profile_photo_cleanup_monitor_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  observed_at timestamptz := statement_timestamp();
  extension_available boolean;
  catalog_available boolean;
  job_count integer := 0;
  target_job_id bigint;
  job_active boolean;
  schedule_matches boolean;
  recent_runs jsonb := '[]'::jsonb;
  latest_started_at timestamptz;
begin
  if auth.uid() is not null then
    raise exception using errcode = '42501', message = 'Service identity required.';
  end if;

  select exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
    into extension_available;
  catalog_available := extension_available
    and pg_catalog.to_regclass('cron.job') is not null
    and pg_catalog.to_regclass('cron.job_run_details') is not null;
  if catalog_available then
    -- Fixed identifiers only. Dynamic SQL permits a safe missing-extension
    -- snapshot without creating extensions or granting callers Cron access.
    execute $query$
      select count(*)::integer, min(jobid), bool_and(active),
        bool_and(schedule = '*/5 * * * *')
      from cron.job where jobname = 'process-profile-photo-cleanup'
    $query$ into job_count, target_job_id, job_active, schedule_matches;
    if job_count = 1 then
      execute $query$
        select coalesce(jsonb_agg(jsonb_build_object(
          'runId', runid::text,
          'status', case when status in
            ('starting','connecting','sending','running','succeeded','failed')
            then status else 'unknown' end,
          'startedAt', start_time,
          'endedAt', end_time
        ) order by runid desc), '[]'::jsonb), max(start_time)
        from (select runid, status, start_time, end_time
          from cron.job_run_details where jobid = $1
          order by runid desc limit 2) recent
      $query$ into recent_runs, latest_started_at using target_job_id;
    else
      job_active := null;
      schedule_matches := null;
    end if;
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', observed_at,
    'cleanup', public.profile_photo_cleanup_health(),
    'cron', jsonb_build_object(
      'extensionAvailable', extension_available,
      'catalogAvailable', catalog_available,
      'jobState', case when not catalog_available then 'unavailable'
        when job_count = 0 then 'missing'
        when job_count = 1 then 'present' else 'ambiguous' end,
      'active', job_active,
      'scheduleMatches', schedule_matches,
      'historyAvailable', jsonb_array_length(recent_runs) > 0,
      'stale', latest_started_at is null
        or latest_started_at < observed_at - interval '15 minutes'
        or latest_started_at > observed_at,
      'staleAfterSeconds', 900,
      'lastRuns', recent_runs,
      'transportEvidence', 'enqueue-only'
    )
  );
end;
$$;

revoke all on function public.profile_photo_cleanup_monitor_health()
  from public, anon, authenticated, service_role;
grant execute on function public.profile_photo_cleanup_monitor_health()
  to service_role;
