#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FOU-802 local rehearsal: $1" >&2
  exit 1
}

fault_phases=(
  tracking_ready
  fixtures_ready
  first_upload_stored
  runtime_created
  readiness_queued
  cron_scheduled
  worker_completed
  health_queued
  teardown_started
  cleanup_queued
)

is_fault_phase() {
  local candidate="$1"
  local known_phase
  for known_phase in "${fault_phases[@]}"; do
    [[ "$candidate" == "$known_phase" ]] && return 0
  done
  return 1
}

maybe_inject_fault() {
  local phase="$1"
  if [[ "${FOU802_REHEARSAL_FAULT_AFTER:-}" == "$phase" ]]; then
    echo "FOU-802 local rehearsal: injected failure after ${phase}." >&2
    return 86
  fi
}

# This internal mode executes the same fault dispatcher without touching
# Docker, Supabase, or the filesystem. The Node regression test invokes every
# supported phase so renamed/dead checkpoints fail CI.
if [[ "${FOU802_REHEARSAL_FAULT_SELF_TEST:-}" == "1" ]]; then
  [[ "$#" -eq 1 ]] || fail "the fault self-test requires exactly one phase."
  is_fault_phase "$1" || fail "the fault self-test received an unknown phase."
  FOU802_REHEARSAL_FAULT_AFTER="$1"
  maybe_inject_fault "$1"
  fail "the fault self-test did not inject its failure."
fi

confirmation_valid=false
case "$#" in
  1)
    [[ "$1" == "--confirm-local-reset" ]] && confirmation_valid=true
    ;;
  2)
    [[ "$1" == "--" && "$2" == "--confirm-local-reset" ]] \
      && confirmation_valid=true
    ;;
esac
if [[ "$confirmation_valid" != "true" ]]; then
  echo "FOU-802 local rehearsal: this proof destroys and rebuilds only the pinned local Supabase database." >&2
  echo "Re-run with --confirm-local-reset after confirming no local data must be kept." >&2
  exit 2
fi

if [[ -n "${FOU802_REHEARSAL_FAULT_AFTER:-}" ]] \
  && ! is_fault_phase "$FOU802_REHEARSAL_FAULT_AFTER"; then
  fail "FOU802_REHEARSAL_FAULT_AFTER names an unsupported checkpoint."
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
cleanup_orchestrator="$script_directory/fixtures/profile-photo-cleanup-cron-cleanup.sh"
[[ -f "$cleanup_orchestrator" ]] \
  || fail "the reviewed cleanup orchestrator is missing."
# shellcheck source=fixtures/profile-photo-cleanup-cron-cleanup.sh
source "$cleanup_orchestrator"
cleanup_failed=false
project_id="77-dominion-challenge"
database_container="supabase_db_${project_id}"
edge_container="supabase_edge_runtime_${project_id}"
storage_container="supabase_storage_${project_id}"
kong_container="supabase_kong_${project_id}"
rest_container="supabase_rest_${project_id}"
network_name="supabase_network_${project_id}"
runtime_container="fou802-profile-photo-cleanup-rehearsal"
runtime_alias="fou802-profile-photo-cleanup-worker"
expected_edge_image="public.ecr.aws/supabase/edge-runtime:v1.74.2"
expected_storage_image="public.ecr.aws/supabase/storage-api:v1.61.7"
expected_kong_image="public.ecr.aws/supabase/kong:2.8.1"
expected_rest_image="public.ecr.aws/supabase/postgrest:v14.14"
local_api_origin="http://127.0.0.1:54321"
container_api_origin="http://${kong_container}:8000"
cron_job_name="fou802-profile-photo-cleanup-local"
secret_table="private.fou802_profile_photo_cleanup_rehearsal"
fixture_table="private.fou802_profile_photo_cleanup_fixtures"

case "$local_api_origin" in
  http://127.0.0.1:54321|http://localhost:54321) ;;
  *) fail "the Storage fixture origin is not the pinned loopback API." ;;
esac
[[ "$container_api_origin" == "http://${kong_container}:8000" ]] \
  || fail "the worker API origin is not the exact local Kong container."

if [[ -n "${DOCKER_BIN:-}" ]]; then
  [[ -x "$DOCKER_BIN" ]] || fail "DOCKER_BIN is not executable."
  docker_cli="$DOCKER_BIN"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  docker_cli="/opt/homebrew/bin/docker"
elif command -v docker >/dev/null 2>&1; then
  docker_cli="$(command -v docker)"
else
  fail "Docker is required."
fi

# Ask the CLI for the endpoint it would actually use so DOCKER_HOST, the
# selected context, and Docker's own precedence rules cannot be interpreted
# differently by this rehearsal. Resolving context metadata is read-only and
# must happen before the first container inspection, lock, reset, or mutation.
if ! effective_docker_endpoint="$(
  "$docker_cli" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null
)"; then
  fail "the effective Docker endpoint could not be resolved."
fi
case "$effective_docker_endpoint" in
  *$'\n'*|*$'\r'*|'')
    fail "the effective Docker endpoint must be one existing local absolute unix:// socket."
    ;;
  unix:///*)
    docker_socket_path="${effective_docker_endpoint#unix://}"
    ;;
  *)
    fail "the effective Docker endpoint must be one existing local absolute unix:// socket."
    ;;
esac
case "$docker_socket_path" in
  /*) ;;
  *)
    fail "the effective Docker endpoint must use an absolute unix:// socket path."
    ;;
esac
[[ -S "$docker_socket_path" ]] \
  || fail "the effective Docker endpoint does not name an existing local Unix socket."

# Pin every subsequent Docker and Supabase-CLI subprocess to the endpoint that
# passed the local-socket check. A context change during the rehearsal cannot
# redirect later destructive commands to another daemon.
export DOCKER_HOST="$effective_docker_endpoint"
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH

if [[ -n "${SUPABASE_CLI_BIN:-}" ]]; then
  supabase_cli="$SUPABASE_CLI_BIN"
elif [[ -x "$repository_root/node_modules/.bin/supabase" ]]; then
  supabase_cli="$repository_root/node_modules/.bin/supabase"
else
  fail "the repository-pinned Supabase CLI is required."
fi

[[ "$($supabase_cli --version)" == "2.109.0" ]] \
  || fail "the Supabase CLI must be exactly 2.109.0."

config_project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ "$config_project_id" == "$project_id" ]] \
  || fail "the local project ID is not the pinned rehearsal project."
grep -Eq '^port = 54322$' "$repository_root/supabase/config.toml" \
  || fail "the local database port is not pinned to 54322."
config_api_port="$(sed -n \
  '/^\[api\]$/,/^\[/s/^port = \([0-9][0-9]*\)$/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ "$config_api_port" == "54321" ]] \
  || fail "the local API port is not pinned to 54321."
grep -Eq '^\[functions\.process-profile-photo-cleanup\]$' \
  "$repository_root/supabase/config.toml" \
  || fail "the cleanup Function configuration is missing."
grep -A1 -E '^\[functions\.process-profile-photo-cleanup\]$' \
  "$repository_root/supabase/config.toml" | grep -Eq '^verify_jwt = false$' \
  || fail "the cleanup Function must keep platform JWT verification disabled."

expected_postgres_version="$(tr -d '\r\n' \
  <"$repository_root/supabase/.temp/postgres-version")"
[[ "$expected_postgres_version" == "17.6.1.141" ]] \
  || fail "the local Postgres image version is not pinned."
expected_postgres_image="public.ecr.aws/supabase/postgres:${expected_postgres_version}"

inspect_value() {
  local container="$1"
  local format="$2"
  "$docker_cli" inspect "$container" --format "$format"
}

docker_command() {
  "$docker_cli" "$@"
}

remove_tree_command() {
  rm -rf -- "$1"
}

remove_file_command() {
  rm -f -- "$1"
}

rmdir_command() {
  rmdir "$1" 2>/dev/null
}

assert_local_container() {
  local container="$1"
  local expected_image="$2"
  local actual_image
  local project_label
  local networks
  local running

  actual_image="$(inspect_value "$container" '{{.Config.Image}}')" \
    || fail "required local container $container is not running."
  [[ "$actual_image" == "$expected_image" ]] \
    || fail "$container is not using $expected_image."
  project_label="$(inspect_value "$container" \
    '{{index .Config.Labels "com.supabase.cli.project"}}')"
  [[ "$project_label" == "$project_id" ]] \
    || fail "$container does not belong to the pinned local project."
  networks="$(inspect_value "$container" \
    '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{println}}{{end}}')"
  [[ "$networks" == "$network_name" ]] \
    || fail "$container is not isolated to the exact local Supabase network."
  running="$(inspect_value "$container" '{{.State.Running}}')"
  [[ "$running" == "true" ]] || fail "$container is not running."
}

assert_local_container "$database_container" "$expected_postgres_image"
assert_local_container "$edge_container" "$expected_edge_image"
assert_local_container "$storage_container" "$expected_storage_image"
assert_local_container "$kong_container" "$expected_kong_image"
assert_local_container "$rest_container" "$expected_rest_image"

kong_api_ports="$(inspect_value "$kong_container" \
  '{{range (index .NetworkSettings.Ports "8000/tcp")}}{{println .HostPort}}{{end}}')"
[[ "$kong_api_ports" == "$config_api_port" ]] \
  || fail "Kong port 8000 is not published only on the pinned local API port."

assert_pg_net_alias_bypasses_proxy() {
  local environment_line
  local proxy_configured=false
  local no_proxy_values=","
  while IFS= read -r environment_line; do
    case "$environment_line" in
      HTTP_PROXY=?*|HTTPS_PROXY=?*|ALL_PROXY=?*|http_proxy=?*|https_proxy=?*|all_proxy=?*)
        proxy_configured=true
        ;;
      NO_PROXY=*|no_proxy=*)
        no_proxy_values+="${environment_line#*=},"
        ;;
    esac
  done < <(inspect_value "$database_container" \
    '{{range .Config.Env}}{{println .}}{{end}}')
  if [[ "$proxy_configured" == "true" \
    && "$no_proxy_values" != *",${runtime_alias},"* ]]; then
    fail "the database proxy configuration does not bypass the exact pg_net runtime alias."
  fi
}

assert_pg_net_alias_bypasses_proxy

umask 077
lock_directory="${TMPDIR:-/tmp}/fou802-${project_id}.lock"
lock_owner_file="$lock_directory/owner"
if ! mkdir "$lock_directory" 2>/dev/null; then
  fail "another FOU-802 rehearsal owns the exact local-project lock."
fi
printf '%s\n' "$$" >"$lock_owner_file"

early_cleanup() {
  local test_status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "${temporary_root:-}" ]]; then
    remove_temporary_artifacts
  fi
  release_lock
  exit "$test_status"
}
trap early_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export SUPABASE_TELEMETRY_DISABLED=1
DOCKER_BIN="$docker_cli" SUPABASE_CLI_BIN="$supabase_cli" \
  bash "$script_directory/reset-local-database.sh" \
    --database-only-runtime-check

assert_local_container "$database_container" "$expected_postgres_image"
assert_local_container "$edge_container" "$expected_edge_image"
assert_local_container "$storage_container" "$expected_storage_image"
assert_local_container "$kong_container" "$expected_kong_image"
assert_local_container "$rest_container" "$expected_rest_image"
kong_api_ports="$(inspect_value "$kong_container" \
  '{{range (index .NetworkSettings.Ports "8000/tcp")}}{{println .HostPort}}{{end}}')"
[[ "$kong_api_ports" == "$config_api_port" ]] \
  || fail "Kong changed its exact local API port during reset."
assert_pg_net_alias_bypasses_proxy

db_exec() {
  "$docker_cli" exec -i "$database_container" \
    psql --username postgres --dbname postgres --set=ON_ERROR_STOP=1 "$@"
}

db_query() {
  db_exec --tuples-only --no-align --quiet "$@"
}

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/fou802-cron-rehearsal.XXXXXX")"
runtime_source="$temporary_root/runtime"
runtime_cache="$temporary_root/cache"
runtime_env="$temporary_root/runtime.env"
curl_config="$temporary_root/curl.conf"
upload_response="$temporary_root/upload-response.json"
payload_file="$temporary_root/profile-photo.webp"
stdout_capture="$temporary_root/stdout.log"
stderr_capture="$temporary_root/stderr.log"
cron_job_id=""
cron_extension_state="unknown"
cron_installed_by_rehearsal=false
cleanup_request_id=""
readiness_request_id=""
worker_request_id=""
health_request_id=""
worker_secret=""
service_role_key=""
cleanup_failed=false
capture_active=false
runtime_cleanup_complete=false
cron_cleanup_complete=false
pgnet_cleanup_complete=false
fixture_objects_cleanup_complete=false
fixture_database_cleanup_complete=false

if command -v curl >/dev/null 2>&1; then
  curl_cli="$(command -v curl)"
else
  fail "curl is required for exact local Storage cleanup."
fi

storage_curl() {
  "$curl_cli" --disable --config "$curl_config" \
    --noproxy '*' \
    --proxy '' \
    --proto '=http' \
    --proto-redir '=http' \
    --max-redirs 0 \
    --connect-timeout 5 \
    --max-time 20 \
    --fail-with-body \
    --silent \
    --show-error \
    "$@"
}

cleanup() {
  local test_status=$?
  local leaked=false
  trap - EXIT INT TERM
  set +e

  run_rehearsal_resource_cleanup

  if [[ "$capture_active" == "true" ]]; then
    exec 1>&3 2>&4
    capture_active=false
  fi
  for sensitive_value in "$worker_secret" "$service_role_key"; do
    [[ -n "$sensitive_value" ]] || continue
    grep -Fq -- "$sensitive_value" "$stdout_capture" 2>/dev/null && leaked=true
    grep -Fq -- "$sensitive_value" "$stderr_capture" 2>/dev/null && leaked=true
  done
  if [[ "$leaked" == "true" ]]; then
    echo "FOU-802 local rehearsal: captured diagnostics contained a protected secret and were suppressed." >&2
    cleanup_failed=true
  else
    [[ -f "$stdout_capture" ]] && cat "$stdout_capture"
    [[ -f "$stderr_capture" ]] && cat "$stderr_capture" >&2
  fi

  fou802_run_cleanup_steps remove_temporary_artifacts release_lock

  if [[ "$cleanup_failed" == "true" ]]; then
    echo "FOU-802 local rehearsal: cleanup could not prove that every tracked disposable resource was removed." >&2
  fi
  if (( test_status != 0 )); then
    exit "$test_status"
  fi
  if [[ "$cleanup_failed" == "true" ]]; then
    exit 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

exec 3>&1 4>&2
exec >"$stdout_capture" 2>"$stderr_capture"
capture_active=true

while IFS= read -r environment_line; do
  case "$environment_line" in
    SUPABASE_SERVICE_ROLE_KEY=*)
      service_role_key="${environment_line#SUPABASE_SERVICE_ROLE_KEY=}"
      ;;
  esac
done < <(inspect_value "$edge_container" \
  '{{range .Config.Env}}{{println .}}{{end}}')
[[ "${#service_role_key}" -ge 32 \
  && "$service_role_key" =~ ^[A-Za-z0-9._-]+$ ]] \
  || fail "the exact local Edge Runtime did not expose a usable service key."

cron_installed_value="$(db_query --command \
  "select exists (select 1 from pg_extension where extname = 'pg_cron');")"
if [[ "$cron_installed_value" == "t" ]]; then
  cron_extension_state="preexisting"
elif [[ "$cron_installed_value" == "f" ]]; then
  cron_extension_state="absent"
  # Set the ownership flag before creation so even a signal in the
  # command/assignment gap cannot cause us to retain an extension that the
  # rehearsal proved was absent beforehand.
  cron_installed_by_rehearsal=true
  db_exec --command 'create extension pg_cron;' >/dev/null
else
  fail "could not determine local pg_cron state without changing it."
fi

unschedule_and_drain_rehearsal_jobs
[[ "$cleanup_failed" == "false" ]] \
  || fail "a stale rehearsal Cron job could not be drained safely."

db_exec >/dev/null <<SQL
begin;
drop table if exists $secret_table;
drop table if exists $fixture_table;

create unlogged table $secret_table (
  singleton boolean primary key default true check (singleton),
  worker_secret text not null check (worker_secret ~ '^[0-9a-f]{64}$'),
  pg_cron_installed_by_rehearsal boolean not null,
  cron_job_id bigint,
  invoked_at timestamptz,
  readiness_request_id bigint,
  worker_request_id bigint,
  health_request_id bigint,
  cleanup_request_id bigint
);
revoke all on $secret_table from public, anon, authenticated, service_role;
insert into $secret_table (
  worker_secret,
  pg_cron_installed_by_rehearsal
) values (
  encode(gen_random_bytes(32), 'hex'),
  $cron_installed_by_rehearsal
);
commit;
SQL

worker_secret="$(db_query --command \
  "select worker_secret from ${secret_table} where singleton;")"
[[ "$worker_secret" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the database did not generate a valid disposable worker secret."
maybe_inject_fault tracking_ready

db_exec >/dev/null <<SQL
begin;
create unlogged table $fixture_table (
  fixture_kind text primary key check (
    fixture_kind in ('abandoned', 'canonical', 'wrong_identity', 'account_erasure')
  ),
  user_id uuid not null unique,
  registration_id uuid not null unique,
  storage_path text not null unique,
  actual_object_id uuid,
  erasure_batch_id uuid
);
revoke all on $fixture_table from public, anon, authenticated, service_role;

do \$\$
declare
  fixture_kind text;
  fixture_user_id uuid;
  reservation jsonb;
begin
  foreach fixture_kind in array array[
    'abandoned', 'canonical', 'wrong_identity', 'account_erasure'
  ]
  loop
    fixture_user_id := gen_random_uuid();
    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000',
      fixture_user_id,
      'authenticated',
      'authenticated',
      fixture_user_id::text || '@fou802-local.example.test',
      '\$2b\$10\$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
      clock_timestamp(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"FOU-802 local rehearsal"}'::jsonb,
      clock_timestamp(),
      clock_timestamp()
    );

    insert into public.profiles (
      user_id,
      name,
      email,
      challenge_start_date,
      time_zone,
      challenge_activation_status,
      challenge_participation_mode,
      challenge_activation_time_zone,
      challenge_activated_at,
      challenge_confirmed_at,
      challenge_activated_by,
      challenge_confirmed_by,
      challenge_activation_revision,
      challenge_activation_updated_at
    ) values (
      fixture_user_id,
      'FOU-802 local rehearsal',
      fixture_user_id::text || '@fou802-local.example.test',
      current_date,
      'UTC',
      'active',
      'solo',
      'UTC',
      clock_timestamp(),
      clock_timestamp(),
      fixture_user_id,
      fixture_user_id,
      1,
      clock_timestamp()
    );

    reservation := public.reserve_profile_photo_upload_service(
      fixture_user_id,
      gen_random_uuid(),
      encode(gen_random_bytes(32), 'hex')
    );
    insert into $fixture_table (
      fixture_kind,
      user_id,
      registration_id,
      storage_path
    ) values (
      fixture_kind,
      fixture_user_id,
      (reservation ->> 'registrationId')::uuid,
      reservation ->> 'storagePath'
    );
  end loop;
end;
\$\$;
commit;
SQL
maybe_inject_fault fixtures_ready

cp "$repository_root/public/images/science-bible-training.jpg" "$payload_file"
payload_size="$(wc -c <"$payload_file" | tr -d ' ')"
payload_sha256="$(shasum -a 256 "$payload_file" | awk '{print $1}')"
[[ "$payload_size" =~ ^[1-9][0-9]*$ && "$payload_size" -le 153600 ]] \
  || fail "the local Storage payload is outside the trusted upload size limit."
[[ "$payload_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the local Storage payload digest is invalid."

{
  printf 'header = "Authorization: Bearer %s"\n' "$service_role_key"
  printf 'header = "apikey: %s"\n' "$service_role_key"
} >"$curl_config"

for fixture_kind in abandoned canonical wrong_identity account_erasure; do
  storage_path="$(db_query --command \
    "select storage_path from $fixture_table where fixture_kind = '${fixture_kind}';")"
  [[ "$storage_path" =~ ^[0-9a-f-]{36}/avatar-[0-9]{13}-[a-f0-9]{32}\.webp$ ]] \
    || fail "a trusted reservation returned an invalid local Storage path."
  storage_url="${local_api_origin}/storage/v1/object/profile-photos/${storage_path}"
  case "$storage_url" in
    http://127.0.0.1:54321/storage/v1/object/profile-photos/*) ;;
    *) fail "a fixture upload attempted to leave the loopback Storage API." ;;
  esac
  if ! storage_curl \
    --request POST \
    --header 'Content-Type: image/webp' \
    --data-binary "@$payload_file" \
    "$storage_url" >"$upload_response"; then
    fail "the local Storage API rejected a fixture upload."
  fi
  if [[ "$fixture_kind" == "abandoned" ]]; then
    # Exercise the otherwise tiny failure gap between Storage commit and the
    # registry-ID observation below. Trap cleanup must recover by bucket/path.
    maybe_inject_fault first_upload_stored
  fi
  db_exec --command "
    update $fixture_table fixture
    set actual_object_id = registry.storage_object_id
    from private.profile_photo_objects registry
    where fixture.fixture_kind = '${fixture_kind}'
      and registry.id = fixture.registration_id;
    do \$\$
    begin
      if not exists (
        select 1
        from $fixture_table fixture
        join storage.objects object_row
          on object_row.id = fixture.actual_object_id
         and object_row.bucket_id = 'profile-photos'
         and object_row.name = fixture.storage_path
        where fixture.fixture_kind = '${fixture_kind}'
      ) then
        raise exception 'FOU-802 local Storage object was not materialized.';
      end if;
    end;
    \$\$;
  " >/dev/null
done

db_exec >/dev/null <<SQL
do \$\$
declare
  canonical_fixture $fixture_table%rowtype;
  fixture_row $fixture_table%rowtype;
begin
  select * into strict canonical_fixture
  from $fixture_table where fixture_kind = 'canonical';

  perform public.finalize_profile_photo_upload_service(
    canonical_fixture.user_id,
    canonical_fixture.registration_id,
    canonical_fixture.storage_path,
    '$payload_sha256',
    $payload_size,
    32,
    32
  );
  perform set_config(
    'request.jwt.claim.sub', canonical_fixture.user_id::text, true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', canonical_fixture.user_id,
      'role', 'authenticated'
    )::text,
    true
  );
  perform public.commit_profile_photo_upload(
    canonical_fixture.storage_path,
    (select updated_at from public.profiles
      where user_id = canonical_fixture.user_id),
    false,
    null,
    null
  );

  for fixture_row in
    select * from $fixture_table
    where fixture_kind in ('abandoned', 'wrong_identity', 'account_erasure')
  loop
    if not public.abandon_profile_photo_upload_service(
      fixture_row.user_id,
      fixture_row.registration_id
    ) then
      raise exception 'FOU-802 fixture abandon failed.';
    end if;
  end loop;

  select * into strict fixture_row
  from $fixture_table where fixture_kind = 'account_erasure';
  perform set_config('request.jwt.claim.sub', fixture_row.user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', fixture_row.user_id, 'role', 'authenticated')::text,
    true
  );
  perform public.request_retired_community_account_erasure(false);

  update $fixture_table fixture
  set erasure_batch_id = batch_row.id
  from private.retired_community_deletion_batches batch_row
  where fixture.fixture_kind = 'account_erasure'
    and batch_row.reason = 'account_erasure'
    and batch_row.subject_user_id = fixture.user_id
    and batch_row.sealed;
end;
\$\$;

set session_replication_role = replica;
update private.profile_photo_objects registry
set storage_object_id = gen_random_uuid()
from $fixture_table fixture
where fixture.fixture_kind = 'wrong_identity'
  and registry.id = fixture.registration_id;
set session_replication_role = origin;
SQL

mkdir -p \
  "$runtime_source/functions/_rehearsal" \
  "$runtime_source/functions/_shared" \
  "$runtime_cache"
cp "$repository_root/supabase/functions/_shared/supabase.ts" \
  "$runtime_source/functions/_shared/supabase.ts"
cp "$repository_root/supabase/functions/_shared/http.ts" \
  "$runtime_source/functions/_shared/http.ts"
cp -R "$repository_root/supabase/functions/process-profile-photo-cleanup" \
  "$runtime_source/functions/process-profile-photo-cleanup"
cp "$script_directory/fixtures/profile-photo-cleanup-supabase-bridge.ts" \
  "$runtime_source/functions/_rehearsal/supabase-js-bridge.ts"
{
  printf '{\n'
  printf '  "imports": {\n'
  printf '    "jsr:@supabase/supabase-js@2.110.7": "../_rehearsal/supabase-js-bridge.ts"\n'
  printf '  }\n'
  printf '}\n'
} >"$runtime_source/functions/process-profile-photo-cleanup/deno.json"

{
  printf 'SUPABASE_URL=%s\n' "$container_api_origin"
  printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$service_role_key"
  printf 'PROFILE_PHOTO_WORKER_SECRET=%s\n' "$worker_secret"
  printf 'DENO_NO_UPDATE_CHECK=1\n'
  printf 'HTTP_PROXY=\n'
  printf 'HTTPS_PROXY=\n'
  printf 'ALL_PROXY=\n'
  printf 'http_proxy=\n'
  printf 'https_proxy=\n'
  printf 'all_proxy=\n'
  printf 'NO_PROXY=127.0.0.1,localhost,%s,%s,%s\n' \
    "$kong_container" "$storage_container" "$rest_container"
  printf 'no_proxy=127.0.0.1,localhost,%s,%s,%s\n' \
    "$kong_container" "$storage_container" "$rest_container"
} >"$runtime_env"

if "$docker_cli" inspect "$runtime_container" >/dev/null 2>&1; then
  stale_label="$(inspect_value "$runtime_container" \
    '{{index .Config.Labels "fou802.rehearsal"}}')"
  [[ "$stale_label" == "true" ]] \
    || fail "an unrelated container already uses the rehearsal name."
  "$docker_cli" rm --force "$runtime_container" >/dev/null
fi

"$docker_cli" image inspect "$expected_edge_image" >/dev/null \
  || fail "the pinned Edge Runtime image is not already local."
"$docker_cli" run --detach --pull=never \
  --name "$runtime_container" \
  --label fou802.rehearsal=true \
  --network "$network_name" \
  --network-alias "$runtime_alias" \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=512m \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,source=${runtime_source}/functions,target=/workspace/functions,readonly" \
  --mount "type=bind,source=${runtime_cache},target=/root/.cache/deno" \
  --env-file "$runtime_env" \
  --entrypoint edge-runtime \
  "$expected_edge_image" \
  start \
  --main-service=/workspace/functions/process-profile-photo-cleanup \
  --port=8081 \
  --policy=per_worker \
  --quiet >/dev/null
maybe_inject_fault runtime_created

[[ "$(inspect_value "$runtime_container" '{{.Config.Image}}')" \
  == "$expected_edge_image" ]] \
  || fail "the isolated runtime image changed after launch."
[[ "$(inspect_value "$runtime_container" '{{.State.Running}}')" == "true" ]] \
  || fail "the isolated runtime did not stay running."
runtime_networks="$(inspect_value "$runtime_container" \
  '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{println}}{{end}}')"
[[ "$runtime_networks" == "$network_name" ]] \
  || fail "the isolated runtime joined an unexpected network."
runtime_aliases="$(inspect_value "$runtime_container" \
  '{{range $_, $network := .NetworkSettings.Networks}}{{json $network.Aliases}}{{end}}')"
[[ "$runtime_aliases" == *"\"$runtime_alias\""* ]] \
  || fail "the isolated runtime did not receive its exact local alias."
runtime_environment="$(inspect_value "$runtime_container" \
  '{{range .Config.Env}}{{println .}}{{end}}')"
for proxy_name in \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
  grep -Fxq "${proxy_name}=" <<<"$runtime_environment" \
    || fail "the isolated runtime retained a ${proxy_name} value."
done
runtime_no_proxy="127.0.0.1,localhost,${kong_container},${storage_container},${rest_container}"
grep -Fxq "NO_PROXY=${runtime_no_proxy}" <<<"$runtime_environment" \
  || fail "the isolated runtime uppercase no-proxy boundary changed."
grep -Fxq "no_proxy=${runtime_no_proxy}" <<<"$runtime_environment" \
  || fail "the isolated runtime lowercase no-proxy boundary changed."

wait_for_http_response() {
  local request_id="$1"
  local expected_status="$2"
  local attempt
  local response_state
  for attempt in $(seq 1 150); do
    response_state="$(db_query --field-separator='|' --command "
      select coalesce(status_code::text, ''),
        coalesce(timed_out::integer::text, ''),
        coalesce(error_msg, '')
      from net._http_response
      where id = ${request_id};
    ")"
    if [[ -n "$response_state" ]]; then
      IFS='|' read -r response_status response_timed_out response_error \
        <<<"$response_state"
      [[ "$response_status" == "$expected_status" \
        && "$response_timed_out" == "0" \
        && -z "$response_error" ]] \
        || fail "a local pg_net request returned an unexpected result."
      return 0
    fi
    sleep 0.1
  done
  fail "timed out waiting for a local pg_net response."
}

readiness_request_id="$(db_query --command "
  update ${secret_table} rehearsal
  set readiness_request_id = net.http_post(
      url := 'http://${runtime_alias}:8081/',
      headers := '{\"Content-Type\":\"application/json\"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    )
  where rehearsal.singleton
  returning readiness_request_id;
")"
[[ "$readiness_request_id" =~ ^[0-9]+$ ]] \
  || fail "pg_net did not queue the isolated runtime readiness request."
maybe_inject_fault readiness_queued
wait_for_http_response "$readiness_request_id" "401"
readiness_body="$(db_query --command \
  "select content::jsonb ->> 'error' from net._http_response where id = ${readiness_request_id};")"
[[ "$readiness_body" == "Not authorized." ]] \
  || fail "the no-JWT readiness request did not reach the worker's own auth gate."

cron_job_id="$(db_query --command "
  with scheduled as (
    select cron.schedule(
      '${cron_job_name}',
      '1 second',
      \$job\$
      update $secret_table rehearsal
      set
        invoked_at = clock_timestamp(),
        worker_request_id = net.http_post(
          url := 'http://${runtime_alias}:8081/',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-dominion-worker-key', rehearsal.worker_secret
          ),
          body := '{\"limit\":10}'::jsonb,
          timeout_milliseconds := 10000
        )
      where rehearsal.singleton
        and rehearsal.invoked_at is null;
      \$job\$
    ) as jobid
  )
  update ${secret_table} rehearsal
  set cron_job_id = scheduled.jobid
  from scheduled
  where rehearsal.singleton
  returning rehearsal.cron_job_id;
")"
[[ "$cron_job_id" =~ ^[0-9]+$ ]] \
  || fail "pg_cron did not return a job ID."
maybe_inject_fault cron_scheduled

for attempt in $(seq 1 150); do
  worker_request_id="$(db_query --command \
    "select coalesce(worker_request_id::text, '') from $secret_table where singleton;")"
  [[ "$worker_request_id" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
[[ "$worker_request_id" =~ ^[0-9]+$ ]] \
  || fail "the scheduled Cron command did not queue its one local worker request."

wait_for_http_response "$worker_request_id" "200"
maybe_inject_fault worker_completed

for attempt in $(seq 1 100); do
  cron_run_id="$(db_query --command "
    select coalesce(min(runid)::text, '')
    from cron.job_run_details
    where jobid = ${cron_job_id}
      and status = 'succeeded'
      and return_message = 'UPDATE 1';
  ")"
  [[ "$cron_run_id" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
[[ "$cron_run_id" =~ ^[0-9]+$ ]] \
  || fail "cron.job_run_details did not record the request-queuing run."

db_query --command "select cron.unschedule(${cron_job_id});" >/dev/null
cron_quiet_observations=0
for attempt in $(seq 1 150); do
  remaining_cron_jobs="$(db_query --command "
    select count(*) from cron.job
    where jobid = ${cron_job_id} or jobname = '${cron_job_name}';
  ")"
  active_cron_runs="$(db_query --command "
    select count(*) from cron.job_run_details
    where jobid = ${cron_job_id} and end_time is null;
  ")"
  if [[ "$remaining_cron_jobs" == "0" && "$active_cron_runs" == "0" ]]; then
    cron_quiet_observations=$((cron_quiet_observations + 1))
    [[ "$cron_quiet_observations" -ge 20 ]] && break
  else
    cron_quiet_observations=0
  fi
  sleep 0.1
done
[[ "$cron_quiet_observations" -ge 20 ]] \
  || fail "the rehearsal Cron job did not drain after unscheduling."

db_exec >/dev/null <<SQL
do \$\$
declare
  worker_response jsonb;
  health jsonb;
  evidence_text text;
begin
  select content::jsonb into strict worker_response
  from net._http_response
  where id = $worker_request_id
    and status_code = 200
    and not timed_out
    and error_msg is null;

  if worker_response ->> 'status' <> 'processed'
    or worker_response #>> '{counts,claimed}' <> '2'
    or worker_response #>> '{counts,confirmed}' <> '1'
    or worker_response #>> '{counts,failed}' <> '1'
  then
    raise exception 'FOU-802 worker counts were not deterministic.';
  end if;

  health := worker_response -> 'health';
  if health ->> 'oldestReadyAt' is null
    or health ->> 'expiredPending' <> '0'
    or health ->> 'ready' <> '1'
    or health ->> 'leased' <> '0'
    or health ->> 'staleLeases' <> '0'
    or health ->> 'backingOff' <> '1'
    or health ->> 'failuresLastHour' <> '1'
    or (health ->> 'oldestReadyAt')::timestamptz
      < clock_timestamp() - interval '15 minutes'
  then
    raise exception 'FOU-802 aggregate health entered an alerting state.';
  end if;

  if not exists (
    select 1
    from $fixture_table fixture
    join private.profile_photo_objects registry
      on registry.id = fixture.registration_id
    join private.profile_photo_path_tombstones tombstone
      on tombstone.path_sha256 = private.profile_photo_path_sha256(
        fixture.storage_path
      )
    where fixture.fixture_kind = 'abandoned'
      and registry.state = 'retired'
      and registry.retired_at is not null
      and tombstone.reason = 'cleanup'
      and tombstone.retired_at is not null
      and not exists (
        select 1 from storage.objects object_row
        where object_row.bucket_id = 'profile-photos'
          and object_row.name = fixture.storage_path
      )
  ) then
    raise exception 'FOU-802 abandoned exact object did not retire terminally.';
  end if;

  if not exists (
    select 1
    from $fixture_table fixture
    join private.profile_photo_objects registry
      on registry.id = fixture.registration_id
    join public.profiles profile on profile.user_id = fixture.user_id
    join storage.objects object_row
      on object_row.id = fixture.actual_object_id
     and object_row.bucket_id = 'profile-photos'
     and object_row.name = fixture.storage_path
    where fixture.fixture_kind = 'canonical'
      and registry.state = 'canonical'
      and registry.storage_object_id = fixture.actual_object_id
      and profile.avatar_url = fixture.storage_path
  ) then
    raise exception 'FOU-802 canonical object was not preserved exactly.';
  end if;

  if not exists (
    select 1
    from $fixture_table fixture
    join private.profile_photo_objects registry
      on registry.id = fixture.registration_id
    join storage.objects object_row
      on object_row.id = fixture.actual_object_id
     and object_row.bucket_id = 'profile-photos'
     and object_row.name = fixture.storage_path
    where fixture.fixture_kind = 'wrong_identity'
      and registry.state = 'cleanup'
      and registry.storage_object_id <> fixture.actual_object_id
      and registry.last_error_code = 'storage_retry_exhausted'
      and registry.next_attempt_at > clock_timestamp()
  ) then
    raise exception 'FOU-802 wrong-identity object was not preserved with backoff.';
  end if;

  if not exists (
    select 1
    from $fixture_table fixture
    join private.profile_photo_objects registry
      on registry.id = fixture.registration_id
    join storage.objects object_row
      on object_row.id = fixture.actual_object_id
     and object_row.bucket_id = 'profile-photos'
     and object_row.name = fixture.storage_path
    where fixture.fixture_kind = 'account_erasure'
      and registry.state = 'cleanup'
      and private.retired_community_account_erasure_is_pending(fixture.user_id)
  ) then
    raise exception 'FOU-802 account-erasure object was not preserved.';
  end if;

  select response.content
      || coalesce(run_detail.return_message, '')
      || coalesce(run_detail.command, '')
    into evidence_text
  from net._http_response response
  cross join cron.job_run_details run_detail
  where response.id = $worker_request_id
    and run_detail.runid = $cron_run_id;

  if position((select worker_secret from $secret_table) in evidence_text) > 0
    or exists (
      select 1 from $fixture_table fixture
      where position(fixture.user_id::text in evidence_text) > 0
        or position(fixture.storage_path in evidence_text) > 0
        or position(fixture.actual_object_id::text in evidence_text) > 0
    )
  then
    raise exception 'FOU-802 evidence leaked fixture identity or secret data.';
  end if;

end;
\$\$;
SQL

health_request_id="$(db_query --command "
  update ${secret_table} rehearsal
  set health_request_id = net.http_post(
      url := 'http://${runtime_alias}:8081/',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dominion-worker-key', rehearsal.worker_secret
      ),
      body := '{\"mode\":\"health\"}'::jsonb,
      timeout_milliseconds := 10000
    )
  where rehearsal.singleton
  returning health_request_id;
")"
[[ "$health_request_id" =~ ^[0-9]+$ ]] \
  || fail "the authenticated health request was not tracked atomically."
maybe_inject_fault health_queued
wait_for_http_response "$health_request_id" "200"

db_exec >/dev/null <<SQL
do \$\$
declare
  health_response jsonb;
  aggregate_health jsonb;
  response_created_at timestamptz;
begin
  select content::jsonb, created
    into strict health_response, response_created_at
  from net._http_response
  where id = $health_request_id
    and status_code = 200
    and not timed_out
    and error_msg is null;

  aggregate_health := health_response -> 'health';
  if health_response ->> 'status' <> 'ok'
    or response_created_at is null
    or response_created_at < clock_timestamp() - interval '1 minute'
    or aggregate_health ->> 'oldestReadyAt' is null
    or (aggregate_health ->> 'oldestReadyAt')::timestamptz
      < clock_timestamp() - interval '15 minutes'
    or aggregate_health ->> 'expiredPending' <> '0'
    or aggregate_health ->> 'ready' <> '1'
    or aggregate_health ->> 'leased' <> '0'
    or aggregate_health ->> 'staleLeases' <> '0'
    or aggregate_health ->> 'backingOff' <> '1'
    or aggregate_health ->> 'failuresLastHour' <> '1'
  then
    raise exception 'FOU-802 authenticated health proof was stale or alerting.';
  end if;
end;
\$\$;
SQL

db_exec >/dev/null <<SQL
do \$\$
declare diagnostic_text text;
begin
  select concat_ws(
      '',
      (
        select string_agg(coalesce(content, ''), '')
        from net._http_response
        where id in (
          $readiness_request_id,
          $worker_request_id,
          $health_request_id
        )
      ),
      (
        select concat_ws('', return_message, command)
        from cron.job_run_details
        where runid = $cron_run_id
      )
    )
    into diagnostic_text;

  if position((select worker_secret from $secret_table) in diagnostic_text) > 0
    or exists (
      select 1 from $fixture_table fixture
      where position(fixture.user_id::text in diagnostic_text) > 0
        or position(fixture.storage_path in diagnostic_text) > 0
        or position(fixture.actual_object_id::text in diagnostic_text) > 0
    )
  then
    raise exception 'FOU-802 SQL diagnostics leaked protected rehearsal data.';
  end if;
end;
\$\$;
SQL

cron_evidence="$(db_query --command "
  select jsonb_build_object(
    'source', 'cron.job_run_details',
    'runId', runid,
    'status', status,
    'returnMessage', return_message,
    'durationMs', round(extract(epoch from (end_time - start_time)) * 1000)
  )
  from cron.job_run_details
  where runid = ${cron_run_id};
")"
worker_evidence="$(db_query --command "
  select jsonb_build_object(
    'source', 'net._http_response',
    'httpStatus', status_code,
    'workerStatus', content::jsonb ->> 'status',
    'counts', content::jsonb -> 'counts',
    'health', content::jsonb -> 'health'
  )
  from net._http_response
  where id = ${worker_request_id};
")"
health_evidence="$(db_query --command "
  select jsonb_build_object(
    'source', 'net._http_response.health',
    'httpStatus', status_code,
    'workerStatus', content::jsonb ->> 'status',
    'observedAt', created,
    'oldestReadyAt', content::jsonb #>> '{health,oldestReadyAt}',
    'ready', content::jsonb #>> '{health,ready}',
    'staleLeases', content::jsonb #>> '{health,staleLeases}',
    'failuresLastHour', content::jsonb #>> '{health,failuresLastHour}'
  )
  from net._http_response
  where id = ${health_request_id};
")"
[[ "$cron_evidence" == *'"status": "succeeded"'* \
  && "$worker_evidence" == *'"workerStatus": "processed"'* \
  && "$health_evidence" == *'"workerStatus": "ok"'* \
  && "$health_evidence" == *'"observedAt":'* ]] \
  || fail "sanitized evidence could not be recorded."

printf 'FOU-802 cron evidence: %s\n' "$cron_evidence"
printf 'FOU-802 worker evidence: %s\n' "$worker_evidence"
printf 'FOU-802 health evidence: %s\n' "$health_evidence"

maybe_inject_fault teardown_started

db_exec >/dev/null <<SQL
insert into private.retired_community_deletion_ledger (
  batch_id,
  event_type,
  actor,
  event_at,
  details
)
select
  fixture.erasure_batch_id,
  'cancelled',
  'fou802-local-rehearsal',
  clock_timestamp(),
  jsonb_build_object('reason', 'local_rehearsal_cleanup')
from $fixture_table fixture
where fixture.fixture_kind = 'account_erasure'
  and fixture.erasure_batch_id is not null
  and not exists (
    select 1 from private.retired_community_deletion_ledger terminal
    where terminal.batch_id = fixture.erasure_batch_id
      and terminal.event_type in ('cancelled', 'executed')
  );

update public.profiles profile
set avatar_url = ''
from $fixture_table fixture
where fixture.fixture_kind = 'canonical'
  and profile.user_id = fixture.user_id;

set session_replication_role = replica;
update private.profile_photo_objects registry
set
  storage_object_id = fixture.actual_object_id,
  state = case when registry.state = 'retired' then 'retired' else 'cleanup' end,
  upload_expires_at = null,
  claim_token = null,
  claim_expires_at = null,
  claim_actor = null,
  delete_authorized_at = null,
  next_attempt_at = clock_timestamp(),
  last_error_code = null,
  last_failed_at = null,
  retired_at = case when registry.state = 'retired' then registry.retired_at else null end,
  updated_at = clock_timestamp()
from $fixture_table fixture
where registry.id = fixture.registration_id;
set session_replication_role = origin;
SQL

cleanup_request_id="$(db_query --command "
  update ${secret_table} rehearsal
  set cleanup_request_id = net.http_post(
      url := 'http://${runtime_alias}:8081/',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dominion-worker-key', rehearsal.worker_secret
      ),
      body := '{\"limit\":10}'::jsonb,
      timeout_milliseconds := 10000
    )
  where rehearsal.singleton
  returning cleanup_request_id;
")"
[[ "$cleanup_request_id" =~ ^[0-9]+$ ]] \
  || fail "the local teardown worker request was not queued."
maybe_inject_fault cleanup_queued
wait_for_http_response "$cleanup_request_id" "200"

db_exec >/dev/null <<SQL
do \$\$
declare cleanup_response jsonb;
begin
  select content::jsonb into strict cleanup_response
  from net._http_response where id = $cleanup_request_id;
  if cleanup_response ->> 'status' <> 'processed'
    or cleanup_response #>> '{counts,claimed}' <> '3'
    or cleanup_response #>> '{counts,confirmed}' <> '3'
    or cleanup_response #>> '{counts,failed}' <> '0'
    or exists (
      select 1
      from $fixture_table fixture
      join storage.objects object_row
        on object_row.bucket_id = 'profile-photos'
       and object_row.name = fixture.storage_path
    )
    or exists (
      select 1
      from $fixture_table fixture
      join private.profile_photo_objects registry
        on registry.id = fixture.registration_id
      where registry.state <> 'retired'
    )
  then
    raise exception 'FOU-802 fixture Storage cleanup was incomplete.';
  end if;
end;
\$\$;
SQL

# Run the same idempotent cleanup used by every trap path, then assert the
# result before printing success. The EXIT trap repeats it safely.
set +e
run_rehearsal_resource_cleanup
set -e
[[ "$cleanup_failed" == "false" ]] \
  || fail "disposable database, Cron, pg_net, or Storage state remained."
if "$docker_cli" inspect "$runtime_container" >/dev/null 2>&1; then
  fail "the exact labeled runtime container remained after teardown."
fi
[[ "$(db_query --command "
  select
    (to_regclass('${secret_table}') is not null)::integer
    + (to_regclass('${fixture_table}') is not null)::integer;
")" == "0" ]] \
  || fail "a disposable rehearsal table remained after teardown."

printf '%s\n' \
  'FOU-802 local rehearsal passed: Cron invoked the self-auth worker, authenticated health was fresh, exact cleanup was terminal, protected objects survived, and every tracked disposable resource was removed.'
