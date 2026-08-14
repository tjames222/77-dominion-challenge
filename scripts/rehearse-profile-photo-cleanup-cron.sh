#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FOU-802 local rehearsal: $1" >&2
  exit 1
}

if [[ "$#" -ne 1 || "$1" != "--confirm-local-reset" ]]; then
  echo "FOU-802 local rehearsal: this proof destroys and rebuilds only the pinned local Supabase database." >&2
  echo "Re-run with --confirm-local-reset after confirming no local data must be kept." >&2
  exit 2
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
project_id="77-dominion-challenge"
database_container="supabase_db_${project_id}"
edge_container="supabase_edge_runtime_${project_id}"
storage_container="supabase_storage_${project_id}"
kong_container="supabase_kong_${project_id}"
network_name="supabase_network_${project_id}"
runtime_container="fou802-profile-photo-cleanup-rehearsal"
runtime_alias="fou802-profile-photo-cleanup-worker"
expected_edge_image="public.ecr.aws/supabase/edge-runtime:v1.74.2"
expected_storage_image="public.ecr.aws/supabase/storage-api:v1.61.7"
expected_kong_image="public.ecr.aws/supabase/kong:2.8.1"
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

export SUPABASE_TELEMETRY_DISABLED=1
DOCKER_BIN="$docker_cli" SUPABASE_CLI_BIN="$supabase_cli" \
  bash "$script_directory/reset-local-database.sh" \
    --database-only-runtime-check

assert_local_container "$database_container" "$expected_postgres_image"
assert_local_container "$edge_container" "$expected_edge_image"
assert_local_container "$storage_container" "$expected_storage_image"
assert_local_container "$kong_container" "$expected_kong_image"

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
cron_job_id=""
cron_was_installed=false
runtime_started=false
fixtures_created=false
fixtures_cleaned=false
cleanup_request_id=""
readiness_request_id=""
worker_request_id=""

best_effort_database_cleanup() {
  local cleanup_path
  set +e
  if [[ -n "$cron_job_id" ]]; then
    db_query --command \
      "select cron.unschedule(${cron_job_id}) where exists (select 1 from cron.job where jobid = ${cron_job_id});" \
      >/dev/null 2>&1
  fi
  # Authorize exact fixture paths before asking the Storage API to remove the
  # bytes. This keeps failure cleanup from leaving orphan files in the local
  # Storage volume; no volume-level command is ever used.
  db_exec >/dev/null 2>&1 <<'SQL'
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
  retired_at = case when registry.state = 'retired' then registry.retired_at else null end,
  updated_at = clock_timestamp()
from private.fou802_profile_photo_cleanup_fixtures fixture
where registry.id = fixture.registration_id
  and fixture.actual_object_id is not null;
set session_replication_role = origin;
select public.claim_profile_photo_cleanup_service(100);
select public.verify_profile_photo_cleanup_service(
  registry.id,
  registry.claim_token
)
from private.profile_photo_objects registry
join private.fou802_profile_photo_cleanup_fixtures fixture
  on fixture.registration_id = registry.id
where registry.state = 'cleanup'
  and registry.claim_actor = 'service';
SQL

  if [[ -f "$curl_config" ]]; then
    while IFS= read -r cleanup_path; do
      [[ "$cleanup_path" =~ ^[0-9a-f-]{36}/avatar-[0-9]{13}-[a-f0-9]{32}\.webp$ ]] \
        || continue
      curl --config "$curl_config" \
        --request DELETE \
        --data "{\"prefixes\":[\"${cleanup_path}\"]}" \
        "${local_api_origin}/storage/v1/object/profile-photos" \
        >/dev/null 2>&1
    done < <(db_query --command \
      'select storage_path from private.fou802_profile_photo_cleanup_fixtures order by fixture_kind;' \
      2>/dev/null)
  fi

  db_exec >/dev/null 2>&1 <<'SQL'
set session_replication_role = replica;
do $$
declare target_batch_ids uuid[];
begin
  if to_regclass('private.fou802_profile_photo_cleanup_fixtures') is null then
    return;
  end if;
  select coalesce(array_agg(erasure_batch_id) filter (
    where erasure_batch_id is not null
  ), '{}'::uuid[])
  into target_batch_ids
  from private.fou802_profile_photo_cleanup_fixtures;

  delete from private.retired_community_deletion_ledger
  where batch_id = any(target_batch_ids);
  delete from private.retired_community_storage_work
  where batch_id = any(target_batch_ids);
  delete from private.retired_community_credential_work
  where batch_id = any(target_batch_ids);
  delete from private.retired_community_deletion_items
  where batch_id = any(target_batch_ids);
end;
$$;
delete from private.retired_community_deletion_batches
where id in (
  select erasure_batch_id
  from private.fou802_profile_photo_cleanup_fixtures
  where erasure_batch_id is not null
);
set session_replication_role = origin;
delete from private.profile_photo_objects
where user_id in (
  select user_id from private.fou802_profile_photo_cleanup_fixtures
);
delete from private.profile_photo_path_tombstones tombstone
where exists (
  select 1
  from private.fou802_profile_photo_cleanup_fixtures fixture
  where tombstone.path_sha256 = private.profile_photo_path_sha256(
    fixture.storage_path
  )
);
delete from auth.users
where id in (
  select user_id from private.fou802_profile_photo_cleanup_fixtures
);
drop table if exists private.fou802_profile_photo_cleanup_fixtures;
drop table if exists private.fou802_profile_photo_cleanup_rehearsal;
SQL
  if [[ "$cron_was_installed" == "false" ]]; then
    db_exec --command 'drop extension if exists pg_cron;' >/dev/null 2>&1
  fi
  set -e
}

cleanup() {
  local test_status=$?
  trap - EXIT INT TERM
  set +e

  if [[ "$fixtures_created" == "true" && "$fixtures_cleaned" != "true" ]]; then
    best_effort_database_cleanup
  else
    if [[ -n "$cron_job_id" ]]; then
      db_query --command \
        "select cron.unschedule(${cron_job_id}) where exists (select 1 from cron.job where jobid = ${cron_job_id});" \
        >/dev/null 2>&1
    fi
    db_exec --command \
      'drop table if exists private.fou802_profile_photo_cleanup_rehearsal;' \
      >/dev/null 2>&1
    if [[ "$cron_was_installed" == "false" ]]; then
      db_exec --command 'drop extension if exists pg_cron;' >/dev/null 2>&1
    fi
  fi

  if [[ "$runtime_started" == "true" ]]; then
    "$docker_cli" rm --force "$runtime_container" >/dev/null 2>&1
  fi
  rm -rf -- "$temporary_root"
  set -e

  if (( test_status != 0 )); then
    exit "$test_status"
  fi
}
trap cleanup EXIT INT TERM

service_role_key=""
while IFS= read -r environment_line; do
  case "$environment_line" in
    SUPABASE_SERVICE_ROLE_KEY=*)
      service_role_key="${environment_line#SUPABASE_SERVICE_ROLE_KEY=}"
      ;;
  esac
done < <(inspect_value "$edge_container" \
  '{{range .Config.Env}}{{println .}}{{end}}')
[[ "${#service_role_key}" -ge 32 ]] \
  || fail "the exact local Edge Runtime did not expose a usable service key."

worker_secret="$(node --input-type=module --eval \
  "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'));" \
)"
[[ "$worker_secret" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the disposable worker secret was not generated safely."

cron_installed_value="$(db_query --command \
  "select exists (select 1 from pg_extension where extname = 'pg_cron');")"
if [[ "$cron_installed_value" == "t" ]]; then
  cron_was_installed=true
elif [[ "$cron_installed_value" != "f" ]]; then
  fail "could not determine local pg_cron state."
fi

db_exec >/dev/null <<SQL
create extension if not exists pg_cron;

do \$\$
declare stale_job_id bigint;
begin
  for stale_job_id in
    select jobid from cron.job where jobname = '$cron_job_name'
  loop
    perform cron.unschedule(stale_job_id);
    delete from cron.job_run_details where jobid = stale_job_id;
  end loop;
end;
\$\$;

drop table if exists $secret_table;
drop table if exists $fixture_table;

create unlogged table $secret_table (
  singleton boolean primary key default true check (singleton),
  worker_secret text not null check (char_length(worker_secret) >= 32),
  invoked_at timestamptz,
  request_id bigint
);
revoke all on $secret_table from public, anon, authenticated, service_role;
insert into $secret_table (worker_secret) values ('$worker_secret');

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
SQL
fixtures_created=true

cp "$repository_root/public/images/science-bible-training.jpg" "$payload_file"
payload_size="$(wc -c <"$payload_file" | tr -d ' ')"
payload_sha256="$(shasum -a 256 "$payload_file" | awk '{print $1}')"
[[ "$payload_size" =~ ^[1-9][0-9]*$ && "$payload_size" -le 153600 ]] \
  || fail "the local Storage payload is outside the trusted upload size limit."
[[ "$payload_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the local Storage payload digest is invalid."

umask 077
{
  printf 'silent\n'
  printf 'show-error\n'
  printf 'fail\n'
  printf 'header = "Authorization: Bearer %s"\n' "$service_role_key"
  printf 'header = "apikey: %s"\n' "$service_role_key"
  printf 'header = "Content-Type: image/webp"\n'
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
  if ! curl --config "$curl_config" --request POST --data-binary "@$payload_file" \
    "$storage_url" >"$upload_response"; then
    fail "the local Storage API rejected a fixture upload."
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

mkdir -p "$runtime_source/functions/_rehearsal" "$runtime_cache"
cp -R "$repository_root/supabase/functions/_shared" \
  "$runtime_source/functions/_shared"
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
  printf 'HTTP_PROXY=http://127.0.0.1:9\n'
  printf 'HTTPS_PROXY=http://127.0.0.1:9\n'
  printf 'ALL_PROXY=http://127.0.0.1:9\n'
  printf 'NO_PROXY=127.0.0.1,localhost,%s,%s,%s\n' \
    "$kong_container" "$storage_container" "supabase_rest_${project_id}"
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
runtime_started=true

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
  select net.http_post(
    url := 'http://${runtime_alias}:8081/',
    headers := '{\"Content-Type\":\"application/json\"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
")"
[[ "$readiness_request_id" =~ ^[0-9]+$ ]] \
  || fail "pg_net did not queue the isolated runtime readiness request."
wait_for_http_response "$readiness_request_id" "401"
readiness_body="$(db_query --command \
  "select content::jsonb ->> 'error' from net._http_response where id = ${readiness_request_id};")"
[[ "$readiness_body" == "Not authorized." ]] \
  || fail "the no-JWT readiness request did not reach the worker's own auth gate."
db_exec --command \
  "delete from net._http_response where id = ${readiness_request_id};" >/dev/null
readiness_request_id=""

cron_job_id="$(db_query --command "
  select cron.schedule(
    '${cron_job_name}',
    '1 second',
    \$job\$
    update $secret_table rehearsal
    set
      invoked_at = clock_timestamp(),
      request_id = net.http_post(
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
  );
")"
[[ "$cron_job_id" =~ ^[0-9]+$ ]] \
  || fail "pg_cron did not return a job ID."

for attempt in $(seq 1 150); do
  worker_request_id="$(db_query --command \
    "select coalesce(request_id::text, '') from $secret_table where singleton;")"
  [[ "$worker_request_id" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
[[ "$worker_request_id" =~ ^[0-9]+$ ]] \
  || fail "the scheduled Cron command did not queue its one local worker request."

wait_for_http_response "$worker_request_id" "200"

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
  if health ->> 'expiredPending' <> '0'
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
[[ "$cron_evidence" == *'"status": "succeeded"'* \
  && "$worker_evidence" == *'"workerStatus": "processed"'* ]] \
  || fail "sanitized evidence could not be recorded."

printf 'FOU-802 cron evidence: %s\n' "$cron_evidence"
printf 'FOU-802 worker evidence: %s\n' "$worker_evidence"

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
  select net.http_post(
    url := 'http://${runtime_alias}:8081/',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dominion-worker-key', (select worker_secret from $secret_table)
    ),
    body := '{\"limit\":10}'::jsonb,
    timeout_milliseconds := 10000
  );
")"
[[ "$cleanup_request_id" =~ ^[0-9]+$ ]] \
  || fail "the local teardown worker request was not queued."
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

delete from net._http_response
where id in ($worker_request_id, $cleanup_request_id);
delete from cron.job_run_details where jobid = $cron_job_id;

set session_replication_role = replica;
do \$\$
declare target_batch_ids uuid[];
begin
  select coalesce(array_agg(erasure_batch_id) filter (
    where erasure_batch_id is not null
  ), '{}'::uuid[])
  into target_batch_ids
  from $fixture_table;
  delete from private.retired_community_deletion_ledger
  where batch_id = any(target_batch_ids);
  delete from private.retired_community_storage_work
  where batch_id = any(target_batch_ids);
  delete from private.retired_community_credential_work
  where batch_id = any(target_batch_ids);
  delete from private.retired_community_deletion_items
  where batch_id = any(target_batch_ids);
end;
\$\$;

delete from private.retired_community_deletion_batches
where id in (
  select erasure_batch_id from $fixture_table where erasure_batch_id is not null
);
set session_replication_role = origin;

delete from private.profile_photo_objects
where user_id in (select user_id from $fixture_table);
delete from private.profile_photo_path_tombstones tombstone
where exists (
  select 1 from $fixture_table fixture
  where tombstone.path_sha256 = private.profile_photo_path_sha256(
    fixture.storage_path
  )
);
delete from auth.users where id in (select user_id from $fixture_table);
drop table $fixture_table;
drop table $secret_table;
SQL
fixtures_cleaned=true

if [[ "$cron_was_installed" == "false" ]]; then
  db_exec --command 'drop extension pg_cron;' >/dev/null
fi

"$docker_cli" rm --force "$runtime_container" >/dev/null
runtime_started=false

printf '%s\n' \
  'FOU-802 local rehearsal passed: Cron invoked the self-auth worker, exact cleanup was terminal, protected objects survived, aggregate health stayed non-alerting, and all disposable state was removed.'
