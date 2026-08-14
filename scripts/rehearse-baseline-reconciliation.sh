#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Baseline reconciliation rehearsal: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
fixture_directory="$repository_root/supabase/tests/reconciliation"
source_manifest="$fixture_directory/legacy-migration-2.source.manifest.jsonl"
target_manifest="$fixture_directory/migration-3.target.manifest.jsonl"
allowlist="$fixture_directory/platform-diff-allowlist.pg17.6.1.141.json"
expected_postgres_image="17.6.1.141"
helper_roles=(
  reconciliation_column_reader
  reconciliation_default_reader
  reconciliation_effective_reader
  reconciliation_unknown_direct
)

mode="verify"
case "${1:-}" in
  "") ;;
  --regenerate)
    mode="regenerate"
    shift
    ;;
  *) fail "usage: $0 [--regenerate]" ;;
esac
(( $# == 0 )) || fail "usage: $0 [--regenerate]"

if [[ -n "${SUPABASE_CLI_BIN:-}" ]]; then
  supabase_cli="$SUPABASE_CLI_BIN"
elif [[ -x "$repository_root/node_modules/.bin/supabase" ]]; then
  supabase_cli="$repository_root/node_modules/.bin/supabase"
elif command -v supabase >/dev/null 2>&1; then
  supabase_cli="$(command -v supabase)"
else
  fail "Supabase CLI is required. Run pnpm install --frozen-lockfile first."
fi
[[ -x "$supabase_cli" ]] || fail "Supabase CLI is not executable: $supabase_cli."

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
cli_version="$($supabase_cli --version)"
[[ "$cli_version" == "2.109.0" ]] \
  || fail "expected pinned Supabase CLI 2.109.0, found $cli_version."

postgres_version_file="$repository_root/supabase/.temp/postgres-version"
[[ -f "$postgres_version_file" ]] || fail "missing $postgres_version_file."
actual_postgres_image="$(tr -d '\r\n' <"$postgres_version_file")"
[[ "$actual_postgres_image" == "$expected_postgres_image" ]] \
  || fail "expected Postgres image $expected_postgres_image, found $actual_postgres_image."

migration_versions=(
  20260707170000
  20260708154000
  20260708155500
)
for version in "${migration_versions[@]}"; do
  migration_count="$(find "$repository_root/supabase/migrations" -maxdepth 1 \
    -type f -name "${version}_*.sql" | wc -l | tr -d '[:space:]')"
  [[ "$migration_count" == "1" ]] || fail "expected one migration for version $version."
done

node "$script_directory/check-migration-compatibility.mjs"
node "$script_directory/compare-database-manifests.mjs" --validate \
  <(printf '%s\n' '{"key":"rehearsal/preflight","kind":"fixture","identity":"preflight","definition":{}}') \
  >/dev/null

if [[ "$mode" == "verify" ]]; then
  if grep -Fqx 'REGENERATE_AFTER_BASELINE_MIGRATION_HARDENING' "$source_manifest" \
    || grep -Fqx 'REGENERATE_AFTER_BASELINE_MIGRATION_HARDENING' "$target_manifest"; then
    fail "frozen manifests have not been regenerated after migrations 1-3 were hardened. Run pnpm run generate:baseline-reconciliation, review every manifest and allowlist entry, then commit them."
  fi
  node "$script_directory/compare-database-manifests.mjs" --validate "$source_manifest"
  node "$script_directory/compare-database-manifests.mjs" --validate "$target_manifest"
fi

rehearsal_root="$(mktemp -d "${TMPDIR:-/tmp}/baseline-reconciliation.XXXXXX")"
database_prefix="baseline_reconciliation_${RANDOM}_$$"
created_databases=()
lock_pid=""

cleanup_helper_roles() {
  local cleanup_failed=false
  for helper_role in "${helper_roles[@]}"; do
    role_exists="$($docker_cli exec "$database_container" \
      psql \
        --username postgres \
        --dbname postgres \
        --no-psqlrc \
        --tuples-only \
        --no-align \
        --command "select count(*) from pg_roles where rolname = '${helper_role}'")"
    if [[ "$role_exists" == "0" ]]; then
      continue
    fi
    if ! "$docker_cli" exec "$database_container" \
        psql \
          --username postgres \
          --dbname postgres \
          --no-psqlrc \
          --quiet \
          --set ON_ERROR_STOP=1 \
          --command "revoke ${helper_role} from authenticated; drop role ${helper_role};" \
          >/dev/null 2>&1; then
      echo "Baseline reconciliation rehearsal: could not safely remove helper role ${helper_role}; inspect its dependencies before retrying." >&2
      cleanup_failed=true
    fi
  done
  [[ "$cleanup_failed" == "false" ]]
}

cleanup() {
  exit_status=$?
  trap - EXIT
  if [[ -n "$lock_pid" ]]; then
    kill "$lock_pid" >/dev/null 2>&1 || true
    wait "$lock_pid" >/dev/null 2>&1 || true
  fi
  cleanup_status=0
  for database_name in "${created_databases[@]}"; do
    if ! "$docker_cli" exec supabase_db_77-dominion-challenge \
      dropdb --username postgres --if-exists "$database_name" \
      >/dev/null 2>&1; then
      echo "Baseline reconciliation rehearsal: failed to remove disposable database ${database_name}." >&2
      cleanup_status=1
    fi
  done
  cleanup_helper_roles || cleanup_status=1
  rm -rf -- "$rehearsal_root"
  if (( exit_status == 0 && cleanup_status != 0 )); then
    exit "$cleanup_status"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

database_container="supabase_db_77-dominion-challenge"
container_image="$($docker_cli inspect "$database_container" --format '{{.Config.Image}}')"
postgres_image_registry="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}"
postgres_image_registry="${postgres_image_registry%/}"
[[ -n "$postgres_image_registry" ]] || fail "Postgres image registry cannot be empty."
expected_image_ref="${postgres_image_registry}/supabase/postgres:${expected_postgres_image}"
[[ "$container_image" == "$expected_image_ref" ]] \
  || fail "expected running image $expected_image_ref, found $container_image."
server_version_num="$($docker_cli exec "$database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align \
  --command 'show server_version_num')"
[[ "$server_version_num" == "170006" ]] \
  || fail "expected PostgreSQL server version 17.6, found $server_version_num."

# These fixed roles are owned solely by this harness. Recover a prior interrupted
# run only when PostgreSQL can prove they have no remaining dependencies. A
# failed DROP is a hard stop; the harness never REASSIGNs or DROP OWNED outside
# its disposable databases.
cleanup_helper_roles \
  || fail "stale reconciliation helper roles have dependencies outside disposable rehearsal databases."

create_database() {
  local database_name="$1"
  "$docker_cli" exec "$database_container" \
    createdb --username postgres --template template0 "$database_name"
  created_databases+=("$database_name")

  "$docker_cli" exec "$database_container" \
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
        -e '/^CREATE TRIGGER block_pending_account_storage_write /d' \
        -e '/^CREATE TRIGGER guard_profile_photo_storage_delete /d' \
        -e '/^CREATE TRIGGER guard_profile_photo_storage_insert /d' \
        -e '/^CREATE TRIGGER guard_profile_photo_storage_update /d' \
        -e '/^CREATE POLICY "Pending account erasure blocks personal asset deletes" /d' \
        -e '/^CREATE POLICY "Pending account erasure blocks personal asset uploads" /d' \
        -e '/^CREATE POLICY "Pending account erasure freezes personal asset updates" /d' \
    | "$docker_cli" exec -i "$database_container" \
      psql \
        --username postgres \
        --dbname "$database_name" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1
}

execute_sql() {
  local database_name="$1"
  local sql_file="$2"
  "$docker_cli" exec -i "$database_container" \
    psql \
      --username postgres \
      --dbname "$database_name" \
      --no-psqlrc \
      --quiet \
      --set ON_ERROR_STOP=1 \
      --single-transaction \
      --file - \
    <"$sql_file"
}

capture_manifest() {
  local database_name="$1"
  local output_file="$2"
  DOCKER_BIN="$docker_cli" bash "$script_directory/capture-database-manifest.sh" \
    --container "$database_container" \
    --database "$database_name" \
    --output "$output_file" \
    >/dev/null
}

capture_fingerprint() {
  local database_name="$1"
  local output_file="$2"
  DOCKER_BIN="$docker_cli" bash "$script_directory/capture-database-manifest.sh" \
    --container "$database_container" \
    --database "$database_name" \
    --fingerprint \
    --output "$output_file" \
    >/dev/null
}

history_versions() {
  local database_name="$1"
  local history_relation
  history_relation="$($docker_cli exec "$database_container" \
    psql --username postgres --dbname "$database_name" \
      --tuples-only --no-align --no-psqlrc \
      --command "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"
  if [[ -n "$history_relation" ]]; then
    "$docker_cli" exec "$database_container" \
      psql --username postgres --dbname "$database_name" \
        --tuples-only --no-align --no-psqlrc \
        --command 'select version from supabase_migrations.schema_migrations order by version'
  fi
}

new_source_database() {
  local database_name="$1"
  create_database "$database_name"
  if ! execute_sql "$database_name" "$fixture_directory/legacy-migration-2-overlay.sql" \
      >"$rehearsal_root/${database_name}.source.log" 2>&1; then
    cat "$rehearsal_root/${database_name}.source.log" >&2
    fail "could not construct the sanitized legacy source in $database_name."
  fi
  history_relation="$($docker_cli exec "$database_container" \
    psql --username postgres --dbname "$database_name" --tuples-only --no-align --no-psqlrc \
      --command "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"
  history_count=0
  if [[ -n "$history_relation" ]]; then
    history_count="$($docker_cli exec "$database_container" \
      psql --username postgres --dbname "$database_name" --tuples-only --no-align --no-psqlrc \
        --command 'select count(*) from supabase_migrations.schema_migrations')"
  fi
  [[ "$history_count" == "0" ]] || fail "source fixture unexpectedly has $history_count migration-history rows."
}

make_stage() {
  local stage_root="$1"
  local include_count="$2"
  mkdir -p "$stage_root/supabase/migrations"
  cp "$repository_root/supabase/config.toml" "$stage_root/supabase/config.toml"
  for (( index = 0; index < include_count; index += 1 )); do
    migration_path="$(find "$repository_root/supabase/migrations" -maxdepth 1 \
      -type f -name "${migration_versions[index]}_*.sql" -print)"
    cp "$migration_path" "$stage_root/supabase/migrations/"
  done
}

apply_stage() {
  local database_name="$1"
  local stage_root="$2"
  "$supabase_cli" migration up \
    --db-url "postgresql://postgres:postgres@127.0.0.1:54322/${database_name}" \
    --include-all \
    --workdir "$stage_root"
}

source_database="${database_prefix}_source"
new_source_database "$source_database"
capture_manifest "$source_database" "$rehearsal_root/source.manifest.jsonl"
capture_fingerprint "$source_database" "$rehearsal_root/source.fingerprint.jsonl"

if [[ "$mode" == "regenerate" ]]; then
  cp "$rehearsal_root/source.manifest.jsonl" "$source_manifest"
else
  node "$script_directory/compare-database-manifests.mjs" \
    "$source_manifest" "$rehearsal_root/source.manifest.jsonl"
fi

stage_root="$rehearsal_root/stage"
for migration_number in 1 2 3; do
  rm -rf -- "$stage_root"
  make_stage "$stage_root" "$migration_number"
  apply_stage "$source_database" "$stage_root"
  actual_history=()
  while IFS= read -r history_version; do
    [[ -n "$history_version" ]] && actual_history+=("$history_version")
  done < <(history_versions "$source_database")
  (( ${#actual_history[@]} == migration_number )) \
    || fail "expected $migration_number history row(s) after stage $migration_number."
  for (( index = 0; index < migration_number; index += 1 )); do
    [[ "${actual_history[index]}" == "${migration_versions[index]}" ]] \
      || fail "unexpected history prefix after stage $migration_number."
  done
done

capture_manifest "$source_database" "$rehearsal_root/target.manifest.jsonl"
capture_fingerprint "$source_database" "$rehearsal_root/target.fingerprint.jsonl"
node "$script_directory/compare-database-manifests.mjs" \
  "$rehearsal_root/source.fingerprint.jsonl" \
  "$rehearsal_root/target.fingerprint.jsonl"

if [[ "$mode" == "regenerate" ]]; then
  cp "$rehearsal_root/target.manifest.jsonl" "$target_manifest"
  temporary_allowlist="$rehearsal_root/platform-allowlist.json"
  node "$script_directory/build-platform-diff-allowlist.mjs" \
    "$target_manifest" "$target_manifest" \
    --postgres-image "$expected_postgres_image" \
    --output "$temporary_allowlist"
  cp "$temporary_allowlist" "$allowlist"
  echo "Regenerated source/target manifests. The zero-entry allowlist is intentional for the isolated .141 rehearsal; generate production-vs-target candidates only from reviewed read-only production exports."
  exit 0
fi

node "$script_directory/compare-database-manifests.mjs" \
  "$target_manifest" "$rehearsal_root/target.manifest.jsonl"

expect_failure_without_change() {
  local case_name="$1"
  local mutation_file="$2"
  local failing_stage_root="$rehearsal_root/${case_name}-stage"
  local database_name="${database_prefix}_${case_name}"
  local before_manifest="$rehearsal_root/${case_name}.before.manifest.jsonl"
  local before_fingerprint="$rehearsal_root/${case_name}.before.fingerprint.jsonl"
  local after_manifest="$rehearsal_root/${case_name}.after.manifest.jsonl"
  local after_fingerprint="$rehearsal_root/${case_name}.after.fingerprint.jsonl"
  local failure_log="$rehearsal_root/${case_name}.failure.log"

  new_source_database "$database_name"
  execute_sql "$database_name" "$mutation_file"
  capture_manifest "$database_name" "$before_manifest"
  capture_fingerprint "$database_name" "$before_fingerprint"
  make_stage "$failing_stage_root" 1

  if apply_stage "$database_name" "$failing_stage_root" >"$failure_log" 2>&1; then
    fail "$case_name unexpectedly succeeded."
  fi
  capture_manifest "$database_name" "$after_manifest"
  capture_fingerprint "$database_name" "$after_fingerprint"
  node "$script_directory/compare-database-manifests.mjs" "$before_manifest" "$after_manifest"
  node "$script_directory/compare-database-manifests.mjs" "$before_fingerprint" "$after_fingerprint"
  [[ -z "$(history_versions "$database_name")" ]] \
    || fail "$case_name wrote migration history despite failure."
}

expect_failure_without_change purchase_row "$fixture_directory/source-drift/purchase-row.sql"
expect_failure_without_change nonmembership_entitlement "$fixture_directory/source-drift/nonmembership-entitlement.sql"
expect_failure_without_change null_entitlement "$fixture_directory/source-drift/null-entitlement.sql"
expect_failure_without_change external_dependency "$fixture_directory/source-drift/external-dependency.sql"

for drift_case in \
  unknown-direct-privilege \
  unknown-column-privilege \
  role-derived-effective-privilege \
  default-privilege \
  changed-object \
  changed-policy \
  changed-relation \
  changed-column \
  changed-constraint \
  changed-index \
  changed-trigger; do
  database_name="${database_prefix}_${drift_case//-/_}"
  new_source_database "$database_name"
  execute_sql "$database_name" "$fixture_directory/source-drift/${drift_case}.sql"
  capture_manifest "$database_name" "$rehearsal_root/${drift_case}.manifest.jsonl"
  if node "$script_directory/compare-database-manifests.mjs" \
      "$source_manifest" "$rehearsal_root/${drift_case}.manifest.jsonl" \
      >"$rehearsal_root/${drift_case}.comparison.log" 2>&1; then
    fail "$drift_case was not detected by the source manifest gate."
  fi
done

# A forced statement failure added to migration 1 must roll back all prior DDL,
# source data, and its history insert together.
forced_database="${database_prefix}_forced_exception"
new_source_database "$forced_database"
capture_manifest "$forced_database" "$rehearsal_root/forced.before.manifest.jsonl"
capture_fingerprint "$forced_database" "$rehearsal_root/forced.before.fingerprint.jsonl"
forced_stage="$rehearsal_root/forced-stage"
make_stage "$forced_stage" 1
forced_migration="$(find "$forced_stage/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print)"
forced_patch="$(mktemp "$rehearsal_root/forced-migration-patch.XXXXXX")"
cp "$forced_migration" "$forced_patch"
sed -n '1,$p' "$fixture_directory/source-drift/forced-exception.sql" >>"$forced_patch"
cp "$forced_patch" "$forced_migration"
if apply_stage "$forced_database" "$forced_stage" >"$rehearsal_root/forced.failure.log" 2>&1; then
  fail "forced migration exception unexpectedly succeeded."
fi
capture_manifest "$forced_database" "$rehearsal_root/forced.after.manifest.jsonl"
capture_fingerprint "$forced_database" "$rehearsal_root/forced.after.fingerprint.jsonl"
node "$script_directory/compare-database-manifests.mjs" \
  "$rehearsal_root/forced.before.manifest.jsonl" "$rehearsal_root/forced.after.manifest.jsonl"
node "$script_directory/compare-database-manifests.mjs" \
  "$rehearsal_root/forced.before.fingerprint.jsonl" "$rehearsal_root/forced.after.fingerprint.jsonl"
[[ -z "$(history_versions "$forced_database")" ]] \
  || fail "forced exception wrote migration history."

# The bounded lock timeout in migration 1 must stop a concurrent writer instead
# of waiting indefinitely or applying around it.
lock_database="${database_prefix}_lock_contention"
new_source_database "$lock_database"
capture_manifest "$lock_database" "$rehearsal_root/lock.before.manifest.jsonl"
capture_fingerprint "$lock_database" "$rehearsal_root/lock.before.fingerprint.jsonl"
lock_stage="$rehearsal_root/lock-stage"
make_stage "$lock_stage" 1
"$docker_cli" exec "$database_container" \
  psql --username postgres --dbname "$lock_database" --no-psqlrc \
    --command "begin; lock table public.purchases in access exclusive mode; select pg_sleep(20); rollback;" \
    >"$rehearsal_root/lock-holder.log" 2>&1 &
lock_pid=$!
for (( lock_attempt = 0; lock_attempt < 50; lock_attempt += 1 )); do
  lock_seen="$($docker_cli exec "$database_container" \
    psql --username postgres --dbname "$lock_database" --tuples-only --no-align --no-psqlrc \
      --command "select count(*) from pg_locks where relation='public.purchases'::regclass and granted and mode='AccessExclusiveLock'")"
  [[ "$lock_seen" == "1" ]] && break
  sleep 0.1
done
[[ "${lock_seen:-0}" == "1" ]] || fail "could not establish the lock-contention fixture."
if apply_stage "$lock_database" "$lock_stage" >"$rehearsal_root/lock.failure.log" 2>&1; then
  fail "lock-contention migration unexpectedly succeeded."
fi
kill "$lock_pid" >/dev/null 2>&1 || true
wait "$lock_pid" >/dev/null 2>&1 || true
lock_pid=""
capture_manifest "$lock_database" "$rehearsal_root/lock.after.manifest.jsonl"
capture_fingerprint "$lock_database" "$rehearsal_root/lock.after.fingerprint.jsonl"
node "$script_directory/compare-database-manifests.mjs" \
  "$rehearsal_root/lock.before.manifest.jsonl" "$rehearsal_root/lock.after.manifest.jsonl"
node "$script_directory/compare-database-manifests.mjs" \
  "$rehearsal_root/lock.before.fingerprint.jsonl" "$rehearsal_root/lock.after.fingerprint.jsonl"
[[ -z "$(history_versions "$lock_database")" ]] \
  || fail "lock contention wrote migration history."

echo "Baseline reconciliation rehearsal passed on exact Postgres 17.6.1.141: source gate, migrations 1-3, target/data/history equivalence, and every fail-closed case."
