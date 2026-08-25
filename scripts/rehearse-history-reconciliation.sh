#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "History reconciliation rehearsal: $1" >&2
  exit 1
}

usage() {
  echo "usage: $0 --release-commit <40-character-sha> [--regenerate]" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
fixture_directory="$repository_root/supabase/tests/reconciliation"
stage_preparer="$script_directory/prepare-reconciliation-stage.mjs"
compatibility_gate="$script_directory/check-migration-compatibility.mjs"
capture_helper="$script_directory/capture-database-manifest.sh"
manifest_comparator="$script_directory/compare-database-manifests.mjs"
source_manifest="$fixture_directory/legacy-migration-2.source.manifest.jsonl"
migration_3_manifest="$fixture_directory/migration-3.target.manifest.jsonl"
migration_3_fingerprint="$fixture_directory/migration-3.target.fingerprint.jsonl"
migration_13_manifest="$fixture_directory/migration-13.target.manifest.jsonl"
migration_13_fingerprint="$fixture_directory/migration-13.target.fingerprint.jsonl"
generation_sentinel="REGENERATE_AFTER_HISTORY_RECONCILIATION_REHEARSAL"
expected_cli_version="2.109.0"
expected_postgres_version="17.6.1.141"
expected_postgres_image="public.ecr.aws/supabase/postgres:${expected_postgres_version}"
expected_server_version_num="170006"
expected_project_id="77-dominion-challenge"
expected_database_container="supabase_db_${expected_project_id}"
fixed_checkpoint_timestamp="2000-01-01 00:00:00+00"
expected_fixture_user_id="90000000-0000-4000-8000-000000000009"

migration_versions=(
  20260707170000
  20260708154000
  20260708155500
  20260708160000
  20260709163000
  20260710120000
  20260710123000
  20260713120000
  20260714120000
  20260715190000
  20260716061500
  20260716153000
  20260716163000
)

release_commit=""
mode="verify"

# pnpm forwards the conventional argument separator as a literal first
# argument for this script. Accept exactly that one leading separator so the
# documented package command and direct Bash invocation share one parser.
if [[ "${1:-}" == "--" ]]; then
  shift
fi

while (( $# > 0 )); do
  case "$1" in
    --release-commit)
      (( $# >= 2 )) || usage
      [[ -z "$release_commit" ]] || fail "--release-commit may be supplied only once."
      release_commit="$2"
      shift 2
      ;;
    --regenerate)
      [[ "$mode" == "verify" ]] || fail "--regenerate may be supplied only once."
      mode="regenerate"
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]] \
  || fail "--release-commit must be an exact lowercase 40-character Git SHA."

# A local literal database URL is assembled below. Refuse every common hosted
# credential or PostgreSQL routing override before invoking any external tool,
# so a caller cannot redirect this rehearsal through ambient configuration.
for prohibited_variable in \
  SUPABASE_ACCESS_TOKEN \
  SUPABASE_DB_PASSWORD \
  SUPABASE_DB_URL \
  SUPABASE_PROJECT_REF \
  SUPABASE_URL \
  SUPABASE_ANON_KEY \
  SUPABASE_SERVICE_ROLE_KEY \
  DATABASE_URL \
  POSTGRES_URL \
  PGHOST \
  PGPORT \
  PGDATABASE \
  PGUSER \
  PGPASSWORD \
  PGPASSFILE \
  PGSERVICE \
  PGSERVICEFILE; do
  if printenv "$prohibited_variable" >/dev/null 2>&1; then
    fail "$prohibited_variable must be unset; this rehearsal accepts no hosted credentials or connection overrides."
  fi
done

if [[ -n "${NODE_BIN:-}" ]]; then
  [[ -x "$NODE_BIN" ]] || fail "NODE_BIN is not executable: $NODE_BIN."
  node_cli="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  node_cli="$(command -v node)"
else
  fail "Node.js is required."
fi

if [[ -n "${SUPABASE_CLI_BIN:-}" ]]; then
  [[ -x "$SUPABASE_CLI_BIN" ]] || fail "SUPABASE_CLI_BIN is not executable: $SUPABASE_CLI_BIN."
  supabase_cli="$SUPABASE_CLI_BIN"
elif [[ -x "$repository_root/node_modules/.bin/supabase" ]]; then
  supabase_cli="$repository_root/node_modules/.bin/supabase"
elif command -v supabase >/dev/null 2>&1; then
  supabase_cli="$(command -v supabase)"
else
  fail "Supabase CLI is required. Run pnpm install --frozen-lockfile first."
fi

if [[ -n "${DOCKER_BIN:-}" ]]; then
  [[ -x "$DOCKER_BIN" ]] || fail "DOCKER_BIN is not executable: $DOCKER_BIN."
  docker_cli="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  docker_cli="$(command -v docker)"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  docker_cli="/opt/homebrew/bin/docker"
else
  fail "Docker is required."
fi

export SUPABASE_TELEMETRY_DISABLED=1

resolved_release_commit="$(git -C "$repository_root" rev-parse --verify "${release_commit}^{commit}")" \
  || fail "release commit does not resolve to a commit."
[[ "$resolved_release_commit" == "$release_commit" ]] \
  || fail "release commit resolved to $resolved_release_commit instead of the exact requested SHA."

assert_release_file_matches() {
  local relative_path="$1"
  local release_blob
  local working_blob
  release_blob="$(git -C "$repository_root" rev-parse "${release_commit}:${relative_path}")" \
    || fail "release commit is missing $relative_path."
  working_blob="$(git -C "$repository_root" hash-object "$repository_root/$relative_path")" \
    || fail "could not hash $relative_path."
  [[ "$working_blob" == "$release_blob" ]] \
    || fail "$relative_path does not match the immutable release commit."
}

assert_head_file_matches() {
  local relative_path="$1"
  local head_blob
  local working_blob
  head_blob="$(git -C "$repository_root" rev-parse "HEAD:${relative_path}")" \
    || fail "current commit is missing $relative_path."
  working_blob="$(git -C "$repository_root" hash-object "$repository_root/$relative_path")" \
    || fail "could not hash $relative_path."
  [[ "$working_blob" == "$head_blob" ]] \
    || fail "$relative_path does not match the current committed integration head."
}

# The sanitized legacy fixture is part of the release boundary. Capture and
# comparison tooling can be hardened independently, so require those files to
# match the current committed integration head instead of freezing old tooling.
assert_release_file_matches \
  supabase/tests/reconciliation/legacy-migration-2-overlay.sql
for integration_fixture in \
  scripts/baseline-data-fingerprint.sql \
  scripts/capture-database-manifest.sh \
  scripts/check-migration-compatibility.mjs \
  scripts/compare-database-manifests.mjs \
  scripts/database-manifest.sql \
  scripts/prepare-reconciliation-stage.mjs \
  scripts/rehearse-history-reconciliation.sh \
  supabase/tests/reconciliation/legacy-migration-2.source.manifest.jsonl \
  supabase/tests/reconciliation/migration-3.target.manifest.jsonl; do
  assert_head_file_matches "$integration_fixture"
done

[[ -f "$stage_preparer" ]] || fail "missing $stage_preparer."
[[ -f "$capture_helper" ]] || fail "missing $capture_helper."
[[ -f "$manifest_comparator" ]] || fail "missing $manifest_comparator."

cli_version="$($supabase_cli --version)"
[[ "$cli_version" == "$expected_cli_version" ]] \
  || fail "expected pinned Supabase CLI $expected_cli_version, found $cli_version."

config_project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ "$config_project_id" == "$expected_project_id" ]] \
  || fail "expected local project $expected_project_id, found $config_project_id."
config_database_port="$(sed -n '/^\[db\]$/,/^\[/ s/^port = \([0-9][0-9]*\)$/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ "$config_database_port" == "54322" ]] \
  || fail "expected the pinned local database port 54322, found $config_database_port."
postgres_version_file="$repository_root/supabase/.temp/postgres-version"
[[ -f "$postgres_version_file" ]] || fail "missing $postgres_version_file."
[[ "$(tr -d '\r\n' <"$postgres_version_file")" == "$expected_postgres_version" ]] \
  || fail "the repository does not pin PostgreSQL $expected_postgres_version."

actual_container_image="$($docker_cli container inspect "$expected_database_container" \
  --format '{{.Config.Image}}')" \
  || fail "the pinned local Supabase database container is not running."
[[ "$actual_container_image" == "$expected_postgres_image" ]] \
  || fail "expected local image $expected_postgres_image, found $actual_container_image."
actual_supabase_project="$($docker_cli container inspect "$expected_database_container" \
  --format '{{index .Config.Labels "com.supabase.cli.project"}}')"
[[ "$actual_supabase_project" == "$expected_project_id" ]] \
  || fail "the database container is not owned by local Supabase project $expected_project_id."
actual_compose_project="$($docker_cli container inspect "$expected_database_container" \
  --format '{{index .Config.Labels "com.docker.compose.project"}}')"
[[ "$actual_compose_project" == "$expected_project_id" ]] \
  || fail "the database container is not owned by Docker Compose project $expected_project_id."
server_version_num="$($docker_cli exec "$expected_database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align --no-psqlrc \
    --set ON_ERROR_STOP=1 --command 'show server_version_num')"
[[ "$server_version_num" == "$expected_server_version_num" ]] \
  || fail "expected PostgreSQL server version 17.6, found $server_version_num."

if [[ "$mode" == "verify" ]]; then
  for frozen_file in \
    "$migration_3_fingerprint" \
    "$migration_13_manifest" \
    "$migration_13_fingerprint"; do
    [[ -f "$frozen_file" ]] || fail "missing frozen checkpoint file $frozen_file."
    assert_head_file_matches "${frozen_file#"$repository_root/"}"
    if grep -Fqx "$generation_sentinel" "$frozen_file"; then
      fail "frozen checkpoints have not been generated. Run this exact isolated rehearsal with --regenerate, review all three artifacts, and commit them."
    fi
    "$node_cli" "$manifest_comparator" --validate "$frozen_file" >/dev/null
  done
  "$node_cli" "$manifest_comparator" --validate "$migration_3_manifest" >/dev/null
  "$node_cli" "$manifest_comparator" --validate "$source_manifest" >/dev/null
fi

rehearsal_parent="/tmp"
rehearsal_root="$(mktemp -d "${rehearsal_parent}/fou762-history-reconciliation.XXXXXX")"
[[ "$rehearsal_root" == "${rehearsal_parent}/fou762-history-reconciliation."* ]] \
  || fail "mktemp returned an unexpected rehearsal path."
database_name="fou762_history_${RANDOM}_${RANDOM}_$$"
ownership_token="fou762_${RANDOM}_${RANDOM}_$$"
[[ "$database_name" =~ ^fou762_history_[0-9]+_[0-9]+_[0-9]+$ ]] \
  || fail "generated an unsafe disposable database name."
[[ "$ownership_token" =~ ^fou762_[0-9]+_[0-9]+_[0-9]+$ ]] \
  || fail "generated an unsafe ownership token."
created_databases=()
database_tokens=()

verify_owned_database() {
  local candidate_name="$1"
  local candidate_token="$2"
  local marker_count
  [[ "$candidate_name" =~ ^fou762_history_[0-9]+_[0-9]+_[0-9]+$ ]] || return 1
  [[ "$candidate_token" =~ ^fou762_[0-9]+_[0-9]+_[0-9]+$ ]] || return 1
  marker_count="$($docker_cli exec "$expected_database_container" \
    psql --username postgres --dbname "$candidate_name" --tuples-only --no-align \
      --no-psqlrc --set ON_ERROR_STOP=1 \
      --command "select count(*) from fou762_history_rehearsal.ownership where token = '${candidate_token}'")" \
    || return 1
  [[ "$marker_count" == "1" ]]
}

drop_owned_database() {
  local candidate_name="$1"
  local candidate_token="$2"
  verify_owned_database "$candidate_name" "$candidate_token" \
    || return 1
  "$docker_cli" exec "$expected_database_container" \
    psql --username postgres --dbname postgres --no-psqlrc --quiet \
      --set ON_ERROR_STOP=1 \
      --command "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${candidate_name}' and pid <> pg_backend_pid();" \
      >/dev/null
  "$docker_cli" exec "$expected_database_container" \
    dropdb --username postgres "$candidate_name" >/dev/null
}

cleanup() {
  exit_status=$?
  trap - EXIT
  cleanup_status=0
  database_index=0
  for candidate_name in "${created_databases[@]-}"; do
    [[ -n "$candidate_name" ]] || continue
    candidate_token="${database_tokens[database_index]}"
    if ! drop_owned_database "$candidate_name" "$candidate_token"; then
      echo "History reconciliation rehearsal: refused or failed to remove owned disposable database $candidate_name." >&2
      cleanup_status=1
    fi
    database_index=$((database_index + 1))
  done
  if [[ -n "$rehearsal_root" \
    && "$rehearsal_root" == "${rehearsal_parent}/fou762-history-reconciliation."* ]]; then
    rm -rf -- "$rehearsal_root"
  else
    echo "History reconciliation rehearsal: refused to remove an unexpected temporary path." >&2
    cleanup_status=1
  fi
  if (( exit_status == 0 && cleanup_status != 0 )); then
    exit "$cleanup_status"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

database_exists="$($docker_cli exec "$expected_database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --command "select count(*) from pg_database where datname = '${database_name}'")"
[[ "$database_exists" == "0" ]] || fail "randomized database name unexpectedly already exists."

"$docker_cli" exec "$expected_database_container" \
  createdb --username postgres --template template0 "$database_name"
if ! "$docker_cli" exec "$expected_database_container" \
    psql --username postgres --dbname "$database_name" --no-psqlrc --quiet \
      --set ON_ERROR_STOP=1 --command "
        create schema fou762_history_rehearsal;
        create table fou762_history_rehearsal.ownership (
          token text primary key,
          created_at timestamptz not null default now()
        );
        insert into fou762_history_rehearsal.ownership (token)
        values ('${ownership_token}');"; then
  fail "created $database_name but could not install its ownership marker; it was left in place for manual inspection."
fi
created_databases+=("$database_name")
database_tokens+=("$ownership_token")

# Recreate only the pinned Supabase-managed platform surface in the disposable
# database. Application schemas and migration history are deliberately absent.
"$docker_cli" exec "$expected_database_container" \
  pg_dump \
    --username postgres \
    --dbname postgres \
    --schema-only \
    --no-owner \
    --no-privileges \
    --exclude-schema public \
    --exclude-schema supabase_migrations \
    --exclude-schema graphql \
    --exclude-schema graphql_public \
    --exclude-schema net \
    --exclude-schema pgbouncer \
    --exclude-schema pgsodium \
    --exclude-schema private \
    --exclude-schema realtime \
    --exclude-schema supabase_functions \
    --exclude-schema vault \
  | sed \
      -e '/^CREATE EXTENSION IF NOT EXISTS supabase_vault /d' \
      -e '/^COMMENT ON EXTENSION supabase_vault /d' \
  | awk '
      function is_inventory_relation(line) {
        return line ~ / ON storage\.(buckets|buckets_analytics|buckets_vectors|iceberg_namespaces|iceberg_tables|objects|s3_multipart_uploads|s3_multipart_uploads_parts|vector_indexes)( |;)/
      }
      /^CREATE POLICY / && is_inventory_relation($0) { next }
      /^CREATE (CONSTRAINT )?TRIGGER / && is_inventory_relation($0) {
        if ($0 ~ /^CREATE TRIGGER enforce_bucket_name_length_trigger / \
            || $0 ~ /^CREATE TRIGGER protect_buckets_delete / \
            || $0 ~ /^CREATE TRIGGER protect_objects_delete / \
            || $0 ~ /^CREATE TRIGGER update_objects_updated_at /) {
          print
        }
        next
      }
      { print }
    ' \
  | "$docker_cli" exec -i "$expected_database_container" \
      psql \
        --username postgres \
        --dbname "$database_name" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1

"$docker_cli" exec "$expected_database_container" \
  psql --username supabase_admin --dbname "$database_name" --no-psqlrc --quiet \
    --set ON_ERROR_STOP=1 --command "
      alter table storage.buckets_vectors owner to supabase_storage_admin;
      alter table storage.vector_indexes owner to supabase_storage_admin;
      revoke all on table storage.buckets_vectors, storage.vector_indexes
        from public, anon, authenticated, service_role, postgres;
      grant select on table storage.buckets_vectors, storage.vector_indexes
        to anon, authenticated, service_role;"

platform_inventory_count="$($docker_cli exec "$expected_database_container" \
  psql --username postgres --dbname "$database_name" --tuples-only --no-align \
    --no-psqlrc --set ON_ERROR_STOP=1 --command "
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'storage'
        and relation.relname in (
          'buckets', 'buckets_analytics', 'buckets_vectors',
          'iceberg_namespaces', 'iceberg_tables', 'objects',
          's3_multipart_uploads', 's3_multipart_uploads_parts', 'vector_indexes'
        )
        and relation.relkind in ('r', 'p');")"
[[ "$platform_inventory_count" == "9" ]] \
  || fail "expected all nine pinned Storage inventory relations, found $platform_inventory_count."

"$docker_cli" exec -i "$expected_database_container" \
  psql --username postgres --dbname "$database_name" --no-psqlrc --quiet \
    --set ON_ERROR_STOP=1 --single-transaction --file - \
  <"$fixture_directory/legacy-migration-2-overlay.sql"

history_versions() {
  local target_database="$1"
  local history_relation
  history_relation="$($docker_cli exec "$expected_database_container" \
    psql --username postgres --dbname "$target_database" --tuples-only --no-align \
      --no-psqlrc --set ON_ERROR_STOP=1 \
      --command "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"
  if [[ -n "$history_relation" ]]; then
    "$docker_cli" exec "$expected_database_container" \
      psql --username postgres --dbname "$target_database" --tuples-only --no-align \
        --no-psqlrc --set ON_ERROR_STOP=1 \
        --command 'select version from supabase_migrations.schema_migrations order by version'
  fi
}

assert_history_prefix() {
  local expected_count="$1"
  local actual_history=()
  local history_version
  local history_index
  while IFS= read -r history_version; do
    [[ -n "$history_version" ]] && actual_history+=("$history_version")
  done < <(history_versions "$database_name")
  (( ${#actual_history[@]} == expected_count )) \
    || fail "expected $expected_count migration-history row(s), found ${#actual_history[@]}."
  for (( history_index = 0; history_index < expected_count; history_index += 1 )); do
    [[ "${actual_history[history_index]}" == "${migration_versions[history_index]}" ]] \
      || fail "migration history does not match the exact approved prefix at position $((history_index + 1))."
  done
}

capture_manifest() {
  local output_file="$1"
  DOCKER_BIN="$docker_cli" bash "$capture_helper" \
    --container "$expected_database_container" \
    --database "$database_name" \
    --output "$output_file" >/dev/null
}

capture_fingerprint() {
  local output_file="$1"
  DOCKER_BIN="$docker_cli" bash "$capture_helper" \
    --container "$expected_database_container" \
    --database "$database_name" \
    --fingerprint \
    --output "$output_file" >/dev/null
}

source_actual_manifest="$rehearsal_root/legacy-source.manifest.jsonl"
capture_manifest "$source_actual_manifest"
"$node_cli" "$manifest_comparator" "$source_manifest" "$source_actual_manifest" >/dev/null
assert_history_prefix 0

normalize_checkpoint_rows() {
  local checkpoint_number="$1"
  local expected_bucket_ids="journal-progress"
  local actual_bucket_ids
  local auth_user_ids
  local storage_object_count
  local user_state_count
  local workout_values
  local challenge_count
  local normalization_sql

  if [[ "$checkpoint_number" == "13" ]]; then
    expected_bucket_ids="community-post-images,journal-progress,profile-photos"
  fi
  actual_bucket_ids="$($docker_cli exec "$expected_database_container" \
    psql --username postgres --dbname "$database_name" --tuples-only --no-align \
      --no-psqlrc --set ON_ERROR_STOP=1 \
      --command "select coalesce(string_agg(id, ',' order by id), '') from storage.buckets")"
  [[ "$actual_bucket_ids" == "$expected_bucket_ids" ]] \
    || fail "checkpoint $checkpoint_number has unexpected Storage buckets: $actual_bucket_ids."
  auth_user_ids="$($docker_cli exec "$expected_database_container" \
    psql --username postgres --dbname "$database_name" --tuples-only --no-align \
      --no-psqlrc --set ON_ERROR_STOP=1 \
      --command "select coalesce(string_agg(id::text, ',' order by id), '') from auth.users")"
  [[ "$auth_user_ids" == "$expected_fixture_user_id" ]] \
    || fail "checkpoint fixture does not contain exactly the immutable synthetic Auth user."
  storage_object_count="$($docker_cli exec "$expected_database_container" \
    psql --username postgres --dbname "$database_name" --tuples-only --no-align \
      --no-psqlrc --set ON_ERROR_STOP=1 \
      --command 'select count(*) from storage.objects')"
  [[ "$storage_object_count" == "0" ]] \
    || fail "checkpoint fixture unexpectedly contains Storage objects."

  if [[ "$checkpoint_number" == "13" ]]; then
    workout_values="$($docker_cli exec "$expected_database_container" \
      psql --username postgres --dbname "$database_name" --tuples-only --no-align \
        --no-psqlrc --set ON_ERROR_STOP=1 \
        --command "select string_agg(difficulty || ':' || points::text, ',' order by difficulty) from public.workout_difficulty_point_values")"
    [[ "$workout_values" == "easy:2,extreme:15,hard:10,medium:5" ]] \
      || fail "checkpoint 13 has unexpected workout point configuration."
    challenge_count="$($docker_cli exec "$expected_database_container" \
      psql --username postgres --dbname "$database_name" --tuples-only --no-align \
        --no-psqlrc --set ON_ERROR_STOP=1 \
        --command 'select count(*) from public.challenge_definitions')"
    [[ "$challenge_count" == "5" ]] \
      || fail "checkpoint 13 has unexpected challenge-definition rows."
    user_state_count="$($docker_cli exec "$expected_database_container" \
      psql --username postgres --dbname "$database_name" --tuples-only --no-align \
        --no-psqlrc --set ON_ERROR_STOP=1 \
        --command 'select count(*) from public.user_challenge_states')"
    [[ "$user_state_count" == "0" ]] \
      || fail "checkpoint fixture unexpectedly contains user challenge state."
  fi

  # The deterministic fixture has no member rows. Normalize only timestamps on
  # its known configuration rows so a frozen fingerprint does not encode wall
  # clock time from now() defaults. Triggers are disabled only for this local
  # transaction; application shapes and values remain unchanged.
  if [[ "$checkpoint_number" == "3" ]]; then
    normalization_sql="
      begin;
      set local session_replication_role = replica;
      update storage.buckets
      set created_at = '${fixed_checkpoint_timestamp}',
          updated_at = '${fixed_checkpoint_timestamp}';
      commit;"
  else
    normalization_sql="
      begin;
      set local session_replication_role = replica;
      update storage.buckets
      set created_at = '${fixed_checkpoint_timestamp}',
          updated_at = '${fixed_checkpoint_timestamp}';
      update public.workout_difficulty_point_values
      set updated_at = '${fixed_checkpoint_timestamp}';
      update public.challenge_definitions
      set created_at = '${fixed_checkpoint_timestamp}',
          updated_at = '${fixed_checkpoint_timestamp}';
      commit;"
  fi
  "$docker_cli" exec "$expected_database_container" \
    psql --username postgres --dbname "$database_name" --no-psqlrc --quiet \
      --set ON_ERROR_STOP=1 --command "$normalization_sql"
}

stage_3_actual_manifest=""
stage_3_actual_fingerprint=""
stage_13_actual_manifest=""
stage_13_actual_fingerprint=""

checkpoint_stage() {
  local checkpoint_number="$1"
  local checkpoint_manifest="$rehearsal_root/migration-${checkpoint_number}.manifest.jsonl"
  local checkpoint_fingerprint="$rehearsal_root/migration-${checkpoint_number}.fingerprint.jsonl"
  normalize_checkpoint_rows "$checkpoint_number"
  capture_manifest "$checkpoint_manifest"
  capture_fingerprint "$checkpoint_fingerprint"
  if [[ "$checkpoint_number" == "3" ]]; then
    "$node_cli" "$manifest_comparator" "$migration_3_manifest" "$checkpoint_manifest" >/dev/null
    stage_3_actual_manifest="$checkpoint_manifest"
    stage_3_actual_fingerprint="$checkpoint_fingerprint"
    if [[ "$mode" == "verify" ]]; then
      "$node_cli" "$manifest_comparator" "$migration_3_fingerprint" "$checkpoint_fingerprint" >/dev/null
    fi
  else
    stage_13_actual_manifest="$checkpoint_manifest"
    stage_13_actual_fingerprint="$checkpoint_fingerprint"
    if [[ "$mode" == "verify" ]]; then
      "$node_cli" "$manifest_comparator" "$migration_13_manifest" "$checkpoint_manifest" >/dev/null
      "$node_cli" "$manifest_comparator" "$migration_13_fingerprint" "$checkpoint_fingerprint" >/dev/null
    fi
  fi
}

stage_number=0
for migration_version in "${migration_versions[@]}"; do
  stage_number=$((stage_number + 1))
  assert_history_prefix $((stage_number - 1))
  stage_root="$rehearsal_root/stage-$(printf '%02d' "$stage_number")"
  "$node_cli" "$stage_preparer" \
    --release-commit "$release_commit" \
    --through-version "$migration_version" \
    --output "$stage_root" >/dev/null
  "$node_cli" "$stage_preparer" \
    --release-commit "$release_commit" \
    --through-version "$migration_version" \
    --verify-stage "$stage_root" >/dev/null
  "$node_cli" "$compatibility_gate" "$stage_root/supabase/migrations" >/dev/null
  staged_migration_count="$(find "$stage_root/supabase/migrations" \
    -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
  [[ "$staged_migration_count" == "$stage_number" ]] \
    || fail "stage $stage_number contains $staged_migration_count migrations."
  current_migration_count="$(find "$stage_root/supabase/migrations" \
    -maxdepth 1 -type f -name "${migration_version}_*.sql" | wc -l | tr -d '[:space:]')"
  [[ "$current_migration_count" == "1" ]] \
    || fail "stage $stage_number does not contain exactly one migration for $migration_version."

  local_database_url="postgresql://postgres:postgres@127.0.0.1:54322/${database_name}"
  "$supabase_cli" migration up \
    --db-url "$local_database_url" \
    --include-all \
    --agent no \
    --output-format text \
    --workdir "$stage_root" \
    >"$rehearsal_root/stage-$(printf '%02d' "$stage_number").log"
  assert_history_prefix "$stage_number"

  if [[ "$stage_number" == "3" || "$stage_number" == "13" ]]; then
    checkpoint_stage "$stage_number"
  fi
done

assert_history_prefix 13
[[ -n "$stage_3_actual_manifest" && -n "$stage_3_actual_fingerprint" \
  && -n "$stage_13_actual_manifest" && -n "$stage_13_actual_fingerprint" ]] \
  || fail "both required checkpoints were not captured."

if [[ "$mode" == "regenerate" ]]; then
  cp "$stage_3_actual_fingerprint" "$migration_3_fingerprint"
  cp "$stage_13_actual_manifest" "$migration_13_manifest"
  cp "$stage_13_actual_fingerprint" "$migration_13_fingerprint"
  "$node_cli" "$manifest_comparator" --validate "$migration_3_fingerprint" >/dev/null
  "$node_cli" "$manifest_comparator" --validate "$migration_13_manifest" >/dev/null
  "$node_cli" "$manifest_comparator" --validate "$migration_13_fingerprint" >/dev/null
  echo "Regenerated deterministic migration-3 and migration-13 checkpoint artifacts from the exact isolated local fixture. Review every record before committing."
else
  echo "History reconciliation rehearsal passed: exact release $release_commit advanced one version at a time through all 13 historical migrations and matched both frozen checkpoints."
fi
