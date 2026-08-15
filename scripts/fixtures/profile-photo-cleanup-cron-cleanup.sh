#!/usr/bin/env bash

# Production cleanup implementation for the FOU-802 local rehearsal. The main
# script provides the external boundaries (Docker, psql, curl, and filesystem
# commands). The isolated regression harness replaces only those boundaries,
# so it executes these exact discovery, authorization, drain, and teardown
# paths without touching Docker or a database.

mark_cleanup_failure() {
  local stage="${1:-unknown}"
  cleanup_failed=true
  [[ "$stage" =~ ^[a-z][a-z0-9-]*$ ]] || stage="unknown"
  case ",${cleanup_failure_stages:-}," in
    *",${stage},"*) ;;
    *)
      cleanup_failure_stages="${cleanup_failure_stages:+${cleanup_failure_stages},}${stage}"
      ;;
  esac
}

report_cleanup_failure_stages() {
  [[ -n "${cleanup_failure_stages:-}" ]] || return 0
  echo "FOU-802 local rehearsal: failed cleanup stages: ${cleanup_failure_stages}." >&2
}

tracking_table_exists() {
  local exists_result=""
  if ! exists_result="$(db_query --command \
    "select to_regclass('${secret_table}') is not null;" 2>/dev/null)"; then
    mark_cleanup_failure
    return 2
  fi
  case "$exists_result" in
    t) return 0 ;;
    f) return 1 ;;
    *) mark_cleanup_failure; return 2 ;;
  esac
}

fixture_table_exists() {
  local exists_result=""
  if ! exists_result="$(db_query --command \
    "select to_regclass('${fixture_table}') is not null;" 2>/dev/null)"; then
    mark_cleanup_failure
    return 2
  fi
  case "$exists_result" in
    t) return 0 ;;
    f) return 1 ;;
    *) mark_cleanup_failure; return 2 ;;
  esac
}

remove_exact_runtime_container() {
  local exact_names=""
  local runtime_label
  if docker_command inspect "$runtime_container" >/dev/null 2>&1; then
    runtime_label="$(inspect_value "$runtime_container" \
      '{{index .Config.Labels "fou802.rehearsal"}}' 2>/dev/null)"
    if [[ "$runtime_label" == "true" ]]; then
      if docker_command rm --force "$runtime_container" >/dev/null 2>&1; then
        runtime_cleanup_complete=true
      else
        mark_cleanup_failure
      fi
    else
      echo "FOU-802 local rehearsal: refusing to remove an unrelated runtime container." >&2
      mark_cleanup_failure
    fi
  else
    # `docker inspect` uses the same nonzero status for "not found" and daemon
    # failures. Only a successful exact-name listing can prove absence.
    if ! exact_names="$(docker_command ps --all \
      --filter "name=^/${runtime_container}$" \
      --format '{{.Names}}' 2>/dev/null)"; then
      mark_cleanup_failure
    elif [[ -z "$exact_names" ]]; then
      runtime_cleanup_complete=true
    else
      mark_cleanup_failure
    fi
  fi
}

tracked_job_ids() {
  local named_ids=""
  local recorded_id=""
  local combined_ids=""
  local unique_ids=""
  local candidate_id
  local candidate_job_ids=()
  local tracking_status=0
  if ! named_ids="$(db_query --command "
    select coalesce(string_agg(jobid::text, ',' order by jobid), '')
    from cron.job where jobname = '${cron_job_name}';
  " 2>/dev/null)"; then
    return 2
  fi
  if tracking_table_exists; then
    if ! recorded_id="$(db_query --command \
      "select coalesce(cron_job_id::text, '') from ${secret_table} where singleton;" \
      2>/dev/null)"; then
      return 2
    fi
  else
    tracking_status=$?
    [[ "$tracking_status" -eq 1 ]] || return 2
  fi
  combined_ids="${named_ids}${named_ids:+${recorded_id:+,}}${recorded_id}"
  if [[ -n "$combined_ids" ]]; then
    IFS=',' read -r -a candidate_job_ids <<<"$combined_ids"
    for candidate_id in "${candidate_job_ids[@]}"; do
      [[ -n "$candidate_id" ]] || continue
      if [[ ",$unique_ids," != *",${candidate_id},"* ]]; then
        unique_ids="${unique_ids:+${unique_ids},}${candidate_id}"
      fi
    done
  fi
  printf '%s\n' "$unique_ids"
}

unschedule_and_drain_rehearsal_jobs() {
  local job_ids
  local job_id
  local active_count=""
  local scheduled_count=""
  local residue_count=""
  local quiet_observations=0
  local extension_state=""
  local attempt
  cron_cleanup_complete=false
  if ! extension_state="$(db_query --command \
    "select exists (select 1 from pg_extension where extname = 'pg_cron');" \
    2>/dev/null)"; then
    mark_cleanup_failure
    return 0
  fi
  case "$extension_state" in
    t) ;;
    f) cron_cleanup_complete=true; return 0 ;;
    *) mark_cleanup_failure; return 0 ;;
  esac
  if ! job_ids="$(tracked_job_ids)"; then
    mark_cleanup_failure
    return 0
  fi
  if [[ -z "$job_ids" ]]; then
    cron_cleanup_complete=true
    return 0
  fi
  if [[ ! "$job_ids" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    mark_cleanup_failure
    return 0
  fi
  IFS=',' read -r -a job_id_values <<<"$job_ids"
  for job_id in "${job_id_values[@]}"; do
    db_query --command \
      "select cron.unschedule(${job_id}) where exists (select 1 from cron.job where jobid = ${job_id});" \
      >/dev/null 2>&1 || mark_cleanup_failure
  done

  # A pg_cron launcher can have accepted work immediately before unschedule
  # without having inserted job_run_details yet. Require both schedule absence
  # and a stable quiet window before pruning completed history.
  for attempt in $(seq 1 200); do
    scheduled_count="$(db_query --command "
      select count(*) from cron.job
      where jobid in (${job_ids}) or jobname = '${cron_job_name}';
    " 2>/dev/null)"
    active_count="$(db_query --command "
      select count(*) from cron.job_run_details
      where jobid in (${job_ids}) and end_time is null;
    " 2>/dev/null)"
    if [[ "$scheduled_count" == "0" && "$active_count" == "0" ]]; then
      quiet_observations=$((quiet_observations + 1))
      [[ "$quiet_observations" -ge 20 ]] && break
    else
      quiet_observations=0
    fi
    sleep 0.1
  done
  if [[ "$quiet_observations" -lt 20 ]]; then
    mark_cleanup_failure
    return 0
  fi
  db_exec --command \
    "delete from cron.job_run_details where jobid in (${job_ids}) and end_time is not null;" \
    >/dev/null 2>&1 || mark_cleanup_failure

  # Observe another quiet window after deletion. If a late run appears, wait
  # for its terminal row, remove only terminal history, and restart the window.
  quiet_observations=0
  for attempt in $(seq 1 200); do
    scheduled_count="$(db_query --command "
      select count(*) from cron.job
      where jobid in (${job_ids}) or jobname = '${cron_job_name}';
    " 2>/dev/null)"
    active_count="$(db_query --command "
      select count(*) from cron.job_run_details
      where jobid in (${job_ids}) and end_time is null;
    " 2>/dev/null)"
    if [[ "$scheduled_count" == "0" && "$active_count" == "0" ]]; then
      db_exec --command \
        "delete from cron.job_run_details where jobid in (${job_ids}) and end_time is not null;" \
        >/dev/null 2>&1 || mark_cleanup_failure
      residue_count="$(db_query --command \
        "select count(*) from cron.job_run_details where jobid in (${job_ids});" \
        2>/dev/null)"
      if [[ "$residue_count" == "0" ]]; then
        quiet_observations=$((quiet_observations + 1))
        [[ "$quiet_observations" -ge 20 ]] && break
      else
        quiet_observations=0
      fi
    else
      quiet_observations=0
    fi
    sleep 0.1
  done
  if [[ "$quiet_observations" -ge 20 ]]; then
    cron_cleanup_complete=true
  else
    mark_cleanup_failure
  fi
}

tracked_request_ids() {
  local recorded_ids=""
  local shell_ids=""
  local tracking_status=0
  if tracking_table_exists; then
    if ! recorded_ids="$(db_query --command "
      select coalesce(string_agg(request_id::text, ',' order by request_id), '')
      from (
        select distinct unnest(array_remove(array[
          readiness_request_id,
          worker_request_id,
          health_request_id,
          cleanup_request_id
        ], null)) as request_id
        from ${secret_table}
        where singleton
      ) tracked;
    " 2>/dev/null)"; then
      return 2
    fi
  else
    tracking_status=$?
    [[ "$tracking_status" -eq 1 ]] || return 2
  fi
  for shell_request_id in \
    "$readiness_request_id" "$worker_request_id" \
    "$health_request_id" "$cleanup_request_id"; do
    [[ "$shell_request_id" =~ ^[0-9]+$ ]] || continue
    if [[ ",$recorded_ids,$shell_ids," != *",${shell_request_id},"* ]]; then
      shell_ids="${shell_ids:+${shell_ids},}${shell_request_id}"
    fi
  done
  if [[ -n "$recorded_ids" && -n "$shell_ids" ]]; then
    printf '%s,%s\n' "$recorded_ids" "$shell_ids"
  else
    printf '%s%s\n' "$recorded_ids" "$shell_ids"
  fi
}

drain_and_delete_tracked_requests() {
  local request_ids
  local expected_count
  local terminal_count=""
  local residue_count=""
  local attempt
  pgnet_cleanup_complete=false
  if ! request_ids="$(tracked_request_ids)"; then
    mark_cleanup_failure
    return 0
  fi
  if [[ -z "$request_ids" ]]; then
    pgnet_cleanup_complete=true
    return 0
  fi
  if [[ ! "$request_ids" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    mark_cleanup_failure
    return 0
  fi
  expected_count="$(tr ',' '\n' <<<"$request_ids" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
  for attempt in $(seq 1 150); do
    terminal_count="$(db_query --command "
      select count(distinct id)
      from net._http_response
      where id in (${request_ids});
    " 2>/dev/null)"
    [[ "$terminal_count" == "$expected_count" ]] && break
    sleep 0.1
  done
  if [[ "$terminal_count" != "$expected_count" ]]; then
    # Keep both pg_net rows and the tracking table when terminality cannot be
    # proved; a worker may still publish a response after claiming its queue.
    mark_cleanup_failure
    return 0
  fi
  db_exec >/dev/null 2>&1 <<SQL || mark_cleanup_failure
delete from net.http_request_queue where id in (${request_ids});
delete from net._http_response where id in (${request_ids});
SQL
  for attempt in $(seq 1 20); do
    residue_count="$(db_query --command "
      select
        (select count(*) from net.http_request_queue where id in (${request_ids}))
        + (select count(*) from net._http_response where id in (${request_ids}));
    " 2>/dev/null)"
    [[ "$residue_count" == "0" ]] && break
    db_exec >/dev/null 2>&1 <<SQL
delete from net.http_request_queue where id in (${request_ids});
delete from net._http_response where id in (${request_ids});
SQL
    sleep 0.1
  done
  if [[ "$residue_count" == "0" ]]; then
    pgnet_cleanup_complete=true
  else
    mark_cleanup_failure
  fi
}

prepare_fixture_objects_for_exact_delete() {
  local fixture_status=0
  fixture_objects_cleanup_complete=false
  if fixture_table_exists; then
    :
  else
    fixture_status=$?
    if [[ "$fixture_status" -eq 1 ]]; then
      fixture_objects_cleanup_complete=true
    else
      mark_cleanup_failure
    fi
    return 0
  fi
  db_exec >/dev/null 2>&1 <<'SQL' \
    || mark_cleanup_failure "fixture-preparation"
begin;
do $$
begin
  insert into private.retired_community_deletion_ledger (
    batch_id, event_type, actor, event_at, details
  )
  select
    fixture.erasure_batch_id,
    'cancelled',
    'fou802-local-rehearsal',
    clock_timestamp(),
    jsonb_build_object('reason', 'failed_local_rehearsal_cleanup')
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.erasure_batch_id is not null
    and not exists (
      select 1 from private.retired_community_deletion_ledger terminal
      where terminal.batch_id = fixture.erasure_batch_id
        and terminal.event_type in ('cancelled', 'executed')
    );

  update public.profiles profile
  set avatar_url = ''
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where profile.user_id = fixture.user_id
    and coalesce(profile.avatar_url, '') <> '';

end;
$$;

do $$
begin
  if exists (
    select 1
    from private.fou802_profile_photo_cleanup_fixtures fixture
    join storage.objects object_row
      on object_row.bucket_id = 'profile-photos'
     and object_row.name = fixture.storage_path
    left join private.profile_photo_objects registry
      on registry.id = fixture.registration_id
    where (
      fixture.actual_object_id is not null
      and fixture.actual_object_id is distinct from object_row.id
    ) or (
      fixture.actual_object_id is null
      and registry.storage_object_id is distinct from object_row.id
    )
  ) then
    raise exception 'FOU-802 fixture path now belongs to a different Storage object.';
  end if;
end;
$$;

-- A crash can occur after the upload trigger records its immutable UUID in the
-- registry but before the fixture records it. Fill that null once only when the
-- same registry UUID still occupies the exact bucket/path.
update private.fou802_profile_photo_cleanup_fixtures fixture
set actual_object_id = registry.storage_object_id
from private.profile_photo_objects registry
join storage.objects object_row
  on object_row.id = registry.storage_object_id
 and object_row.bucket_id = 'profile-photos'
where fixture.actual_object_id is null
  and registry.id = fixture.registration_id
  and object_row.name = fixture.storage_path;

-- The pinned local postgres role is intentionally NOSUPERUSER. This image
-- permits direct SET in the migration/test session but denies set_config().
-- Keep the override transaction-local and restore origin before authorization.
set local session_replication_role = replica;
update private.profile_photo_objects registry
set
  storage_object_id = object_row.id,
  state = 'cleanup',
  upload_expires_at = null,
  claim_token = null,
  claim_expires_at = null,
  claim_actor = null,
  delete_authorized_at = null,
  next_attempt_at = clock_timestamp(),
  last_error_code = null,
  last_failed_at = null,
  retired_at = null,
  updated_at = clock_timestamp()
from private.fou802_profile_photo_cleanup_fixtures fixture
join storage.objects object_row
  on object_row.id = fixture.actual_object_id
 and object_row.bucket_id = 'profile-photos'
 and object_row.name = fixture.storage_path
where registry.id = fixture.registration_id;
set local session_replication_role = origin;

select public.claim_profile_photo_cleanup_service(100);

do $$
declare fixture_row record;
begin
  for fixture_row in
    select registry.id, registry.claim_token
    from private.fou802_profile_photo_cleanup_fixtures fixture
    join private.profile_photo_objects registry
      on registry.id = fixture.registration_id
    join storage.objects object_row
      on object_row.id = fixture.actual_object_id
     and object_row.bucket_id = 'profile-photos'
     and object_row.name = fixture.storage_path
  loop
    if fixture_row.claim_token is null
      or not public.verify_profile_photo_cleanup_service(
        fixture_row.id,
        fixture_row.claim_token
      )
    then
      raise exception 'FOU-802 could not authorize exact fixture cleanup.';
    end if;
  end loop;
end;
$$;
commit;
SQL
}

recover_and_remove_fixture_objects() {
  local cleanup_path
  local cleanup_paths=""
  local exact_object_id
  local recorded_object_id
  local authorization_result
  local object_residue=""
  local fixture_status=0
  prepare_fixture_objects_for_exact_delete
  if fixture_table_exists; then
    :
  else
    fixture_status=$?
    [[ "$fixture_status" -eq 1 ]] \
      || mark_cleanup_failure "fixture-inventory-probe"
    return 0
  fi

  if [[ -f "$curl_config" ]]; then
    if ! cleanup_paths="$(db_query --command \
      'select storage_path from private.fou802_profile_photo_cleanup_fixtures order by fixture_kind;' \
      2>/dev/null)"; then
      mark_cleanup_failure "fixture-path-inventory"
      return 0
    fi
    # Keep the path inventory off stdin. docker exec -i/psql commands inside
    # the loop inherit fd 0 and must never consume the remaining path records.
    while IFS= read -r cleanup_path <&7; do
      [[ -n "$cleanup_path" ]] || continue
      [[ "$cleanup_path" =~ ^[0-9a-f-]{36}/avatar-[0-9]{13}-[a-f0-9]{32}\.webp$ ]] \
        || { mark_cleanup_failure "fixture-path-validation"; continue; }
      if ! exact_object_id="$(db_query --command "
        select coalesce(object_row.id::text, '')
        from storage.objects object_row
        where object_row.bucket_id = 'profile-photos'
          and object_row.name = '${cleanup_path}';
      " </dev/null 2>/dev/null)"; then
        mark_cleanup_failure "fixture-object-lookup"
        continue
      fi
      [[ -n "$exact_object_id" ]] || continue
      if [[ ! "$exact_object_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        mark_cleanup_failure "fixture-object-identity"
        continue
      fi
      if ! recorded_object_id="$(db_query --command "
        select coalesce(fixture.actual_object_id::text, '')
        from private.fou802_profile_photo_cleanup_fixtures fixture
        where fixture.storage_path = '${cleanup_path}';
      " </dev/null 2>/dev/null)"; then
        mark_cleanup_failure "fixture-recorded-identity"
        continue
      fi
      if [[ "$recorded_object_id" != "$exact_object_id" ]]; then
        # Storage deletion is path-based. Never authorize it when the current
        # path occupant is not the exact immutable UUID retained by inventory.
        mark_cleanup_failure "fixture-object-identity"
        continue
      fi
      if ! authorization_result="$(db_query --command "
        select coalesce(public.verify_profile_photo_cleanup_service(
          registry.id,
          registry.claim_token
        )::text, 'false')
        from private.fou802_profile_photo_cleanup_fixtures fixture
        join private.profile_photo_objects registry
          on registry.id = fixture.registration_id
        join storage.objects object_row
          on object_row.id = fixture.actual_object_id
         and object_row.bucket_id = 'profile-photos'
         and object_row.name = fixture.storage_path
        where fixture.storage_path = '${cleanup_path}'
          and fixture.actual_object_id = '${exact_object_id}'::uuid
          and registry.storage_object_id = '${exact_object_id}'::uuid;
      " </dev/null 2>/dev/null)"; then
        mark_cleanup_failure "fixture-authorization"
        continue
      fi
      if [[ "$authorization_result" != "true" && "$authorization_result" != "t" ]]; then
        mark_cleanup_failure "fixture-authorization"
        continue
      fi
      storage_curl \
        --request DELETE \
        --header 'Content-Type: application/json' \
        --json "{\"prefixes\":[\"${cleanup_path}\"]}" \
        "${local_api_origin}/storage/v1/object/profile-photos" \
        </dev/null >/dev/null 2>&1 \
        || mark_cleanup_failure "fixture-storage-delete"
    done 7<<<"$cleanup_paths"
  fi

  if ! object_residue="$(db_query --command "
    select count(*)
    from storage.objects object_row
    join ${fixture_table} fixture
      on object_row.bucket_id = 'profile-photos'
     and object_row.name = fixture.storage_path;
  " 2>/dev/null)"; then
    mark_cleanup_failure "fixture-storage-residue-probe"
    return 0
  fi
  if [[ "$object_residue" == "0" ]]; then
    fixture_objects_cleanup_complete=true
  else
    mark_cleanup_failure "fixture-storage-residue"
  fi
}

remove_fixture_database_state() {
  local drop_rehearsal_cron="$cron_installed_by_rehearsal"
  local fixture_status=0
  local tracking_status=0
  local ownership_value=""
  fixture_database_cleanup_complete=false

  if fixture_table_exists; then
    if [[ "$fixture_objects_cleanup_complete" != "true" ]]; then
      mark_cleanup_failure
      return 0
    fi
    db_exec >/dev/null 2>&1 <<'SQL' || mark_cleanup_failure
begin;
set local session_replication_role = replica;
delete from private.retired_community_deletion_ledger ledger
where ledger.batch_id in (
  select fixture.erasure_batch_id
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.erasure_batch_id is not null
);
delete from private.retired_community_storage_work work
where work.batch_id in (
  select fixture.erasure_batch_id
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.erasure_batch_id is not null
);
delete from private.retired_community_credential_work work
where work.batch_id in (
  select fixture.erasure_batch_id
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.erasure_batch_id is not null
);
delete from private.retired_community_deletion_items item
where item.batch_id in (
  select fixture.erasure_batch_id
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.erasure_batch_id is not null
);
delete from private.retired_community_deletion_batches batch_row
where batch_row.id in (
  select fixture.erasure_batch_id
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.erasure_batch_id is not null
);
delete from private.profile_photo_objects registry
where exists (
  select 1 from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.user_id = registry.user_id
);
delete from private.profile_photo_path_tombstones tombstone
where exists (
  select 1
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where tombstone.path_sha256 = private.profile_photo_path_sha256(
    fixture.storage_path
  )
);
set local session_replication_role = origin;
delete from auth.users user_row
where exists (
  select 1 from private.fou802_profile_photo_cleanup_fixtures fixture
  where fixture.user_id = user_row.id
);

do $$
begin
  if exists (
      select 1 from auth.users user_row
      join private.fou802_profile_photo_cleanup_fixtures fixture
        on fixture.user_id = user_row.id
    )
    or exists (
      select 1 from public.profiles profile
      join private.fou802_profile_photo_cleanup_fixtures fixture
        on fixture.user_id = profile.user_id
    )
    or exists (
      select 1 from private.profile_photo_objects registry
      join private.fou802_profile_photo_cleanup_fixtures fixture
        on fixture.user_id = registry.user_id
    )
    or exists (
      select 1 from private.retired_community_deletion_batches batch_row
      join private.fou802_profile_photo_cleanup_fixtures fixture
        on fixture.erasure_batch_id = batch_row.id
    )
  then
    raise exception 'FOU-802 lifecycle fixture rows remained during cleanup.';
  end if;
end;
$$;
drop table private.fou802_profile_photo_cleanup_fixtures;
commit;
SQL
  else
    fixture_status=$?
    if [[ "$fixture_status" -ne 1 ]]; then
      mark_cleanup_failure
      return 0
    fi
  fi

  if fixture_table_exists; then
    mark_cleanup_failure
  else
    fixture_status=$?
    if [[ "$fixture_status" -eq 1 ]]; then
      fixture_database_cleanup_complete=true
    else
      mark_cleanup_failure
      return 0
    fi
  fi

  if tracking_table_exists; then
    if ! ownership_value="$(db_query --command \
      "select pg_cron_installed_by_rehearsal from ${secret_table} where singleton;" \
      2>/dev/null)"; then
      mark_cleanup_failure
      return 0
    fi
    case "$ownership_value" in
      t) drop_rehearsal_cron=true ;;
      f) ;;
      *) mark_cleanup_failure; return 0 ;;
    esac
  else
    tracking_status=$?
    if [[ "$tracking_status" -ne 1 ]]; then
      mark_cleanup_failure
      return 0
    fi
  fi

  if [[ "$runtime_cleanup_complete" == "true" \
    && "$cron_cleanup_complete" == "true" \
    && "$pgnet_cleanup_complete" == "true" \
    && "$fixture_database_cleanup_complete" == "true" ]]; then
    # Preserve the ownership record until a rehearsal-owned extension has
    # actually been removed. Otherwise a failed extension drop would make the
    # next cleanup mistake the leftover extension for pre-existing state.
    if [[ "$drop_rehearsal_cron" == "true" ]]; then
      if db_exec --command 'drop extension if exists pg_cron;' >/dev/null 2>&1; then
        cron_installed_by_rehearsal=false
      else
        mark_cleanup_failure
        return 0
      fi
    fi
    db_exec --command \
      'drop table if exists private.fou802_profile_photo_cleanup_rehearsal;' \
      >/dev/null 2>&1 || mark_cleanup_failure
    if tracking_table_exists; then
      mark_cleanup_failure
    else
      tracking_status=$?
      if [[ "$tracking_status" -eq 1 ]]; then
        cron_job_id=""
        readiness_request_id=""
        worker_request_id=""
        health_request_id=""
        cleanup_request_id=""
      else
        mark_cleanup_failure
      fi
    fi
  else
    mark_cleanup_failure
  fi
}

fou802_run_cleanup_steps() {
  local cleanup_step
  local errexit_was_enabled=false
  case "$-" in
    *e*) errexit_was_enabled=true ;;
  esac
  set +e
  for cleanup_step in "$@"; do
    "$cleanup_step"
  done
  if [[ "$errexit_was_enabled" == "true" ]]; then
    set -e
  else
    set +e
  fi
}

run_rehearsal_resource_cleanup() {
  fou802_run_cleanup_steps \
    remove_exact_runtime_container \
    unschedule_and_drain_rehearsal_jobs \
    drain_and_delete_tracked_requests \
    recover_and_remove_fixture_objects \
    remove_fixture_database_state
}

remove_temporary_artifacts() {
  remove_tree_command "$temporary_root" || mark_cleanup_failure
  if [[ -n "${runtime_mount_root:-}" \
    && "$runtime_mount_root" != "$temporary_root" ]]; then
    remove_tree_command "$runtime_mount_root" || mark_cleanup_failure
  fi
}

release_lock() {
  local lock_owner=""
  [[ -e "$lock_directory" ]] || return 0
  if [[ ! -f "$lock_owner_file" ]]; then
    mark_cleanup_failure
    return 0
  fi
  if ! lock_owner="$(tr -d '\r\n' <"$lock_owner_file" 2>/dev/null)"; then
    mark_cleanup_failure
    return 0
  fi
  if [[ "$lock_owner" != "$$" ]]; then
    mark_cleanup_failure
    return 0
  fi
  remove_file_command "$lock_owner_file" || mark_cleanup_failure
  rmdir_command "$lock_directory" || mark_cleanup_failure
}
