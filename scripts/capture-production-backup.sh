#!/usr/bin/env bash
set -euo pipefail
umask 077

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
# shellcheck source=production-backup-common.sh
source "$script_directory/production-backup-common.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: capture-production-backup.sh
  --capture-id <safe-id>
  --project-ref <20-char-ref>
  --expected-branch <branch> --expected-commit <40hex>
  --supabase-cli <absolute-path> --supabase-cli-sha256 <64hex>
  --database-url-file <absolute-private-file> --database-url-sha256 <64hex>
  --database-passfile <absolute-private-file> --database-passfile-sha256 <64hex>
  --credential-validator-sha256 <64hex>
  --docker-bin <absolute-executable> --docker-bin-sha256 <64hex>
  --dump-script-transformer-sha256 <64hex>
  --approved-tool-manifest <absolute-reviewed-json> --approved-tool-manifest-sha256 <64hex>
  --access-token-file <absolute-private-file> --access-token-sha256 <64hex>
  --destination <absolute-mounted-encrypted-directory>
  --passphrase-file <absolute-private-file> --passphrase-sha256 <64hex>
  --encrypted-volume-check-hook <absolute-executable> --encrypted-volume-check-hook-sha256 <64hex>
  --edge-functions-inventory-hook <absolute-executable> --edge-functions-inventory-hook-sha256 <64hex>
  --storage-inventory-hook <absolute-executable> --storage-inventory-hook-sha256 <64hex>
  --source-manifest-hook <absolute-executable> --source-manifest-hook-sha256 <64hex>
  --source-fingerprint-hook <absolute-executable> --source-fingerprint-hook-sha256 <64hex>
  --relation-counts-hook <absolute-executable> --relation-counts-hook-sha256 <64hex>
  --migration-history-hook <absolute-executable> --migration-history-hook-sha256 <64hex>
  --managed-application-ddl-hook <absolute-executable> --managed-application-ddl-hook-sha256 <64hex>
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141
  --postgres-image-id sha256:<64hex>
  --writer-quiesced-at <RFC3339-UTC-second>
  --confirm-read-only-capture "CAPTURE <project-ref> <expected-commit>"
USAGE
  exit 64
}

capture_id=""
project_ref=""
expected_branch=""
expected_commit=""
supabase_cli=""
supabase_cli_sha256=""
database_url_file=""
database_url_sha256=""
database_passfile=""
database_passfile_sha256=""
credential_validator_sha256=""
docker_bin=""
docker_bin_sha256=""
dump_script_transformer_sha256=""
approved_tool_manifest=""
approved_tool_manifest_sha256=""
access_token_file=""
access_token_sha256=""
destination=""
passphrase_file=""
passphrase_sha256=""
encrypted_volume_check_hook=""
encrypted_volume_check_hook_sha256=""
edge_functions_inventory_hook=""
edge_functions_inventory_hook_sha256=""
storage_inventory_hook=""
storage_inventory_hook_sha256=""
source_manifest_hook=""
source_manifest_hook_sha256=""
source_fingerprint_hook=""
source_fingerprint_hook_sha256=""
relation_counts_hook=""
relation_counts_hook_sha256=""
migration_history_hook=""
migration_history_hook_sha256=""
managed_application_ddl_hook=""
managed_application_ddl_hook_sha256=""
postgres_image=""
postgres_image_id=""
writer_quiesced_at=""
confirmation=""

if [[ "${1:-}" == "--" ]]; then
  shift
fi

while (( $# > 0 )); do
  (( $# >= 2 )) || usage
  case "$1" in
    --capture-id) capture_id="$2" ;;
    --project-ref) project_ref="$2" ;;
    --expected-branch) expected_branch="$2" ;;
    --expected-commit) expected_commit="$2" ;;
    --supabase-cli) supabase_cli="$2" ;;
    --supabase-cli-sha256) supabase_cli_sha256="$2" ;;
    --database-url-file) database_url_file="$2" ;;
    --database-url-sha256) database_url_sha256="$2" ;;
    --database-passfile) database_passfile="$2" ;;
    --database-passfile-sha256) database_passfile_sha256="$2" ;;
    --credential-validator-sha256) credential_validator_sha256="$2" ;;
    --docker-bin) docker_bin="$2" ;;
    --docker-bin-sha256) docker_bin_sha256="$2" ;;
    --dump-script-transformer-sha256) dump_script_transformer_sha256="$2" ;;
    --approved-tool-manifest) approved_tool_manifest="$2" ;;
    --approved-tool-manifest-sha256) approved_tool_manifest_sha256="$2" ;;
    --access-token-file) access_token_file="$2" ;;
    --access-token-sha256) access_token_sha256="$2" ;;
    --destination) destination="$2" ;;
    --passphrase-file) passphrase_file="$2" ;;
    --passphrase-sha256) passphrase_sha256="$2" ;;
    --encrypted-volume-check-hook) encrypted_volume_check_hook="$2" ;;
    --encrypted-volume-check-hook-sha256) encrypted_volume_check_hook_sha256="$2" ;;
    --edge-functions-inventory-hook) edge_functions_inventory_hook="$2" ;;
    --edge-functions-inventory-hook-sha256) edge_functions_inventory_hook_sha256="$2" ;;
    --storage-inventory-hook) storage_inventory_hook="$2" ;;
    --storage-inventory-hook-sha256) storage_inventory_hook_sha256="$2" ;;
    --source-manifest-hook) source_manifest_hook="$2" ;;
    --source-manifest-hook-sha256) source_manifest_hook_sha256="$2" ;;
    --source-fingerprint-hook) source_fingerprint_hook="$2" ;;
    --source-fingerprint-hook-sha256) source_fingerprint_hook_sha256="$2" ;;
    --relation-counts-hook) relation_counts_hook="$2" ;;
    --relation-counts-hook-sha256) relation_counts_hook_sha256="$2" ;;
    --migration-history-hook) migration_history_hook="$2" ;;
    --migration-history-hook-sha256) migration_history_hook_sha256="$2" ;;
    --managed-application-ddl-hook) managed_application_ddl_hook="$2" ;;
    --managed-application-ddl-hook-sha256) managed_application_ddl_hook_sha256="$2" ;;
    --postgres-image) postgres_image="$2" ;;
    --postgres-image-id) postgres_image_id="$2" ;;
    --writer-quiesced-at) writer_quiesced_at="$2" ;;
    --confirm-read-only-capture) confirmation="$2" ;;
    *) usage ;;
  esac
  shift 2
done

# This complete preflight intentionally precedes the first remote-capable hook
# or database dump. Missing, ambiguous, mutable, or mismatched inputs stop here.
production_backup_require_safe_id "$capture_id" "capture ID"
production_backup_require_project_ref "$project_ref"
production_backup_require_branch "$expected_branch"
[[ "$expected_branch" == "main" ]] || production_backup_fail \
  "production capture requires the main branch."
production_backup_require_commit "$expected_commit"
[[ "$postgres_image" == "$DOMINION_POSTGRES_IMAGE" ]] || production_backup_fail \
  "PostgreSQL image must be exactly $DOMINION_POSTGRES_IMAGE."
production_backup_require_image_id "$postgres_image_id"
[[ "$confirmation" == "CAPTURE $project_ref $expected_commit" ]] \
  || production_backup_fail "read-only capture confirmation does not match the exact project and commit."
production_backup_reject_ambient_database_environment
production_backup_reject_ambient_runtime_environment

production_backup_hashed_executable \
  "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
credential_validator="$script_directory/validate-postgres-credentials.mjs"
production_backup_hashed_regular_file \
  "$credential_validator" "$credential_validator_sha256" \
  "database credential validator"
production_backup_hashed_executable "$docker_bin" "$docker_bin_sha256" "Docker CLI"
dump_script_transformer="$script_directory/prepare-supabase-dump-script.mjs"
production_backup_hashed_regular_file \
  "$dump_script_transformer" "$dump_script_transformer_sha256" \
  "Supabase dump-script transformer"
production_backup_hashed_regular_file \
  "$approved_tool_manifest" "$approved_tool_manifest_sha256" \
  "independently approved tool manifest"
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_hashed_executable \
  "$edge_functions_inventory_hook" "$edge_functions_inventory_hook_sha256" \
  "Edge Functions inventory hook"
production_backup_hashed_executable \
  "$storage_inventory_hook" "$storage_inventory_hook_sha256" \
  "Storage inventory hook"
production_backup_hashed_executable \
  "$source_manifest_hook" "$source_manifest_hook_sha256" "source manifest hook"
production_backup_hashed_executable \
  "$source_fingerprint_hook" "$source_fingerprint_hook_sha256" "source fingerprint hook"
production_backup_hashed_executable \
  "$relation_counts_hook" "$relation_counts_hook_sha256" "relation/sequence counts hook"
production_backup_hashed_executable \
  "$migration_history_hook" "$migration_history_hook_sha256" "migration-history hook"
production_backup_hashed_executable \
  "$managed_application_ddl_hook" "$managed_application_ddl_hook_sha256" \
  "managed application DDL hook"

production_backup_private_file "$database_url_file" "database URL file"
production_backup_private_file "$database_passfile" "database passfile"
production_backup_private_file "$access_token_file" "access token file"
production_backup_private_file "$passphrase_file" "encrypted volume passphrase file"
production_backup_require_hash "$database_url_sha256" "database URL file SHA-256"
production_backup_require_hash "$database_passfile_sha256" "database passfile SHA-256"
production_backup_require_hash "$access_token_sha256" "access token file SHA-256"
production_backup_require_hash "$passphrase_sha256" "passphrase file SHA-256"
[[ "$(production_backup_sha256_file "$database_url_file")" == "$database_url_sha256" ]] \
  || production_backup_fail "database URL file SHA-256 does not match."
[[ "$(production_backup_sha256_file "$database_passfile")" == "$database_passfile_sha256" ]] \
  || production_backup_fail "database passfile SHA-256 does not match."
[[ "$(production_backup_sha256_file "$access_token_file")" == "$access_token_sha256" ]] \
  || production_backup_fail "access token file SHA-256 does not match."
[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file SHA-256 does not match."

node_bin="$(command -v node || true)"
[[ -n "$node_bin" && -x "$node_bin" ]] || production_backup_fail "Node.js is required."
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-timestamp --value "$writer_quiesced_at"
git_bin="$(command -v git || true)"
[[ -n "$git_bin" && -x "$git_bin" ]] || production_backup_fail "Git is required."

actual_branch="$($git_bin -C "$repository_root" rev-parse --abbrev-ref HEAD)"
actual_commit="$($git_bin -C "$repository_root" rev-parse HEAD)"
[[ "$actual_branch" == "$expected_branch" ]] || production_backup_fail \
  "expected branch $expected_branch, found $actual_branch."
[[ "$actual_commit" == "$expected_commit" ]] || production_backup_fail \
  "expected commit $expected_commit, found $actual_commit."
[[ -z "$($git_bin -C "$repository_root" status --porcelain)" ]] || production_backup_fail \
  "the release worktree must be clean before capture."

# Validate the independently reviewed inventory before executing even a
# nominally local operator hook. This prevents a self-supplied hook hash from
# becoming authority to run arbitrary code.
capture_toolset_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    capture-toolset-sha256 \
    --credential-validator-sha256 "$credential_validator_sha256" \
    --docker-bin-sha256 "$docker_bin_sha256" \
    --dump-script-transformer-sha256 "$dump_script_transformer_sha256" \
    --edge-functions-inventory-hook-sha256 "$edge_functions_inventory_hook_sha256" \
    --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
    --managed-application-ddl-hook-sha256 "$managed_application_ddl_hook_sha256" \
    --migration-history-hook-sha256 "$migration_history_hook_sha256" \
    --relation-counts-hook-sha256 "$relation_counts_hook_sha256" \
    --source-fingerprint-hook-sha256 "$source_fingerprint_hook_sha256" \
    --source-manifest-hook-sha256 "$source_manifest_hook_sha256" \
    --storage-inventory-hook-sha256 "$storage_inventory_hook_sha256" \
    --supabase-cli-sha256 "$supabase_cli_sha256"
)"
production_backup_require_hash "$capture_toolset_sha256" "capture toolset SHA-256"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  verify-approved-tool-manifest \
  --file "$approved_tool_manifest" \
  --file-sha256 "$approved_tool_manifest_sha256" \
  --release-commit "$expected_commit" \
  --capture-toolset-sha256 "$capture_toolset_sha256" \
  >/dev/null

database_url="$(
  "$node_bin" "$credential_validator" \
    --database-url-file "$database_url_file" \
    --database-passfile "$database_passfile" \
    --project-ref "$project_ref"
)"
export SUPABASE_TELEMETRY_DISABLED=1
actual_cli_version="$($supabase_cli --version)"
[[ "$actual_cli_version" == "$DOMINION_SUPABASE_CLI_VERSION" ]] \
  || production_backup_fail \
    "expected Supabase CLI $DOMINION_SUPABASE_CLI_VERSION, found $actual_cli_version."

destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || production_backup_fail "destination cannot be the filesystem root."
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
esac
case "$destination" in
  *,*) production_backup_fail \
    "destination cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
case "$database_passfile" in
  *,*) production_backup_fail \
    "database passfile path cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
for private_input_file in \
  "$database_url_file" "$database_passfile" "$access_token_file" "$passphrase_file"; do
  canonical_private_input="$(
    production_backup_canonical_file "$private_input_file" "private input file"
  )"
  case "$canonical_private_input" in
    "$destination/"*) production_backup_fail \
      "credentials and passphrases must be stored separately from the encrypted backup." ;;
    "$repository_root/"*) production_backup_fail \
      "credentials and passphrases must be stored outside the repository." ;;
  esac
done
[[ -w "$destination" ]] || production_backup_fail "encrypted destination is not writable."
[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file changed before encrypted destination verification."
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$passphrase_file" "$encrypted_volume_check_hook"

capture_directory="$destination/$capture_id"
[[ ! -e "$capture_directory" ]] || production_backup_fail \
  "capture directory already exists: $capture_directory."
mkdir "$capture_directory"
capture_complete=false
capture_failure_marker="$capture_directory/CAPTURE_INCOMPLETE"
printf '%s\n' "capture did not complete" >"$capture_failure_marker"
cleanup() {
  capture_status=$?
  trap - EXIT
  if [[ "$capture_complete" != "true" ]]; then
    if [[ -d "$capture_directory" && ! -L "$capture_directory" \
      && ! -e "$capture_failure_marker" ]]; then
      printf '%s\n' "capture did not complete" >"$capture_failure_marker" \
        2>/dev/null || true
    fi
    chmod -R go-rwx "$capture_directory" >/dev/null 2>&1 || true
  fi
  exit "$capture_status"
}
trap cleanup EXIT

production_backup_require_local_docker_context "$docker_bin"
actual_image_id="$($docker_bin image inspect "$postgres_image" --format '{{.Id}}')" \
  || production_backup_fail "the exact PostgreSQL image is not present locally."
[[ "$actual_image_id" == "$postgres_image_id" ]] || production_backup_fail \
  "local PostgreSQL image ID does not match the approved capture image ID."

# Prove the pinned CLI's Auth/Storage scope from a passwordless, non-secret
# localhost dry run. This call cannot connect and is run outside the repository
# with an empty environment so ambient libpq and project dotenv values cannot
# alter the generated contract.
data_scope_dry_run="$(
  cd "$capture_directory"
  env -i \
    PATH="$PATH" \
    SUPABASE_TELEMETRY_DISABLED=1 \
    "$supabase_cli" db dump \
      --db-url "postgresql://postgres.${project_ref}@127.0.0.1:5432/postgres?sslmode=require" \
      --data-only \
      --use-copy \
      --exclude "storage.buckets_vectors" \
      --exclude "storage.vector_indexes" \
      --dry-run 2>&1
)" || production_backup_fail \
  "pinned Supabase CLI passwordless data-dump dry-run contract failed."
data_scope_exclusion="$(
  printf '%s\n' "$data_scope_dry_run" | sed -n '/--exclude-schema /p' | head -n 1
)"
[[ -n "$data_scope_exclusion" ]] || production_backup_fail \
  "pinned Supabase CLI dry run omitted its excluded-schema contract."
case "$data_scope_exclusion" in
  *auth*|*storage*) production_backup_fail \
    "pinned Supabase CLI data dump unexpectedly excludes Auth or Storage." ;;
esac
for required_scope_fragment in \
  '--schema "*"' \
  '--exclude-table "auth.schema_migrations"' \
  '--exclude-table "storage.migrations"' \
  '--exclude-table \"storage\".\"buckets_vectors\"' \
  '--exclude-table \"storage\".\"vector_indexes\"'; do
  case "$data_scope_dry_run" in
    *"$required_scope_fragment"*) ;;
    *) production_backup_fail \
      "pinned Supabase CLI data-dump dry run is missing a required scope boundary." ;;
  esac
done
unset data_scope_dry_run data_scope_exclusion required_scope_fragment

cp "$approved_tool_manifest" "$capture_directory/approved-tool-manifest.json"
chmod 600 "$capture_directory/approved-tool-manifest.json"
production_backup_hashed_regular_file \
  "$capture_directory/approved-tool-manifest.json" \
  "$approved_tool_manifest_sha256" \
  "captured approved tool manifest"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  verify-approved-tool-manifest \
  --file "$capture_directory/approved-tool-manifest.json" \
  --file-sha256 "$approved_tool_manifest_sha256" \
  --release-commit "$expected_commit" \
  --capture-toolset-sha256 "$capture_toolset_sha256" \
  >/dev/null

capture_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-capture-time-order \
  --writer-quiesced-at "$writer_quiesced_at" \
  --capture-started-at "$capture_started_at" \
  --captured-at "$capture_started_at"

run_database_inventory_hook() {
  inventory_hook="$1"
  inventory_hook_sha256="$2"
  inventory_output="$3"
  production_backup_hashed_executable \
    "$inventory_hook" "$inventory_hook_sha256" "$inventory_output hook"
  inventory_partial="$capture_directory/.${inventory_output}.partial"
  inventory_log="$capture_directory/.${inventory_output}.hook.log"
  if ! (
    cd "$capture_directory"
    "$inventory_hook" \
      --database-client-contract exact-docker-pgpass/v1 \
      --database-url-file "$database_url_file" \
      --database-passfile "$database_passfile" \
      --project-ref "$project_ref" \
      --docker-bin "$docker_bin" \
      --postgres-image "$postgres_image" \
      --postgres-image-id "$postgres_image_id" \
      --output "$inventory_partial" \
      >"$inventory_log" 2>&1
  ); then
    production_backup_fail \
      "$inventory_output hook failed; inspect its log only inside the encrypted destination."
  fi
  [[ -s "$inventory_partial" && ! -L "$inventory_partial" ]] || production_backup_fail \
    "$inventory_output hook did not create a nonempty regular file."
  mv "$inventory_partial" "$capture_directory/$inventory_output"
  rm "$inventory_log"
}

storage_partial="$capture_directory/.storage-metadata.json.partial"
storage_log="$capture_directory/.storage-metadata.json.hook.log"
production_backup_hashed_executable \
  "$storage_inventory_hook" "$storage_inventory_hook_sha256" "Storage inventory hook"
if ! (
  cd "$capture_directory"
  "$storage_inventory_hook" \
    --database-client-contract exact-docker-pgpass/v1 \
    --database-url-file "$database_url_file" \
    --database-passfile "$database_passfile" \
    --project-ref "$project_ref" \
    --docker-bin "$docker_bin" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    --output "$storage_partial" \
    >"$storage_log" 2>&1
); then
  production_backup_fail \
    "Storage inventory hook failed; inspect its log only inside the encrypted destination."
fi
[[ -s "$storage_partial" && ! -L "$storage_partial" ]] || production_backup_fail \
  "Storage inventory hook did not create a nonempty regular file."
mv "$storage_partial" "$capture_directory/storage-metadata.json"
rm "$storage_log"

edge_partial="$capture_directory/.edge-functions.json.partial"
edge_log="$capture_directory/.edge-functions.json.hook.log"
production_backup_hashed_executable \
  "$edge_functions_inventory_hook" "$edge_functions_inventory_hook_sha256" \
  "Edge Functions inventory hook"
production_backup_hashed_executable \
  "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
if ! (
  cd "$capture_directory"
  "$edge_functions_inventory_hook" \
    --supabase-cli "$supabase_cli" \
    --access-token-file "$access_token_file" \
    --project-ref "$project_ref" \
    --output "$edge_partial" \
    >"$edge_log" 2>&1
); then
  production_backup_fail \
    "Edge Functions inventory hook failed; inspect its log only inside the encrypted destination."
fi
[[ -s "$edge_partial" && ! -L "$edge_partial" ]] || production_backup_fail \
  "Edge Functions inventory hook did not create a nonempty regular file."
mv "$edge_partial" "$capture_directory/edge-functions.json"
rm "$edge_log"

run_database_inventory_hook \
  "$source_manifest_hook" "$source_manifest_hook_sha256" "source-manifest.jsonl"
run_database_inventory_hook \
  "$source_fingerprint_hook" "$source_fingerprint_hook_sha256" \
  "source-fingerprint.jsonl"
run_database_inventory_hook \
  "$relation_counts_hook" "$relation_counts_hook_sha256" \
  "relation-sequence-counts.json"
run_database_inventory_hook \
  "$migration_history_hook" "$migration_history_hook_sha256" \
  "migration-history.json"
run_database_inventory_hook \
  "$managed_application_ddl_hook" "$managed_application_ddl_hook_sha256" \
  "managed-application-ddl.sql"

"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-inventories \
  --edge "$capture_directory/edge-functions.json" \
  --storage "$capture_directory/storage-metadata.json" \
  --manifest "$capture_directory/source-manifest.jsonl" \
  --fingerprint "$capture_directory/source-fingerprint.jsonl" \
  --counts "$capture_directory/relation-sequence-counts.json" \
  --history "$capture_directory/migration-history.json" \
  --managed-ddl "$capture_directory/managed-application-ddl.sql" \
  --project-ref "$project_ref"

# Recheck credential file hashes at the remote boundary. The values already in
# memory are used below, so a path swap cannot silently change the target.
[[ "$(production_backup_sha256_file "$database_url_file")" == "$database_url_sha256" ]] \
  || production_backup_fail "database URL file changed during inventory."
[[ "$(production_backup_sha256_file "$database_passfile")" == "$database_passfile_sha256" ]] \
  || production_backup_fail "database passfile changed during inventory."
[[ "$(production_backup_sha256_file "$access_token_file")" == "$access_token_sha256" ]] \
  || production_backup_fail "access token file changed during inventory."

dump_contract_entries="$capture_directory/.dump-contract.entries"
: >"$dump_contract_entries"

run_dump() {
  dump_name="$1"
  shift
  dump_partial="$capture_directory/.${dump_name}.partial"
  dump_log="$capture_directory/.${dump_name}.dump.log"
  dump_script_raw="$capture_directory/.${dump_name}.supabase-dry-run.sh"
  dump_script="$capture_directory/.${dump_name}.run.sh"
  production_backup_hashed_regular_file \
    "$credential_validator" "$credential_validator_sha256" \
    "database credential validator"
  [[ "$(production_backup_sha256_file "$database_url_file")" == "$database_url_sha256" ]] \
    || production_backup_fail "database URL file changed before $dump_name."
  [[ "$(production_backup_sha256_file "$database_passfile")" == "$database_passfile_sha256" ]] \
    || production_backup_fail "database passfile changed before $dump_name."
  current_database_url="$(
    "$node_bin" "$credential_validator" \
      --database-url-file "$database_url_file" \
      --database-passfile "$database_passfile" \
      --project-ref "$project_ref"
  )"
  [[ "$current_database_url" == "$database_url" ]] || production_backup_fail \
    "database credential scope changed before $dump_name."
  production_backup_hashed_executable \
    "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
  production_backup_hashed_executable "$docker_bin" "$docker_bin_sha256" "Docker CLI"
  production_backup_hashed_regular_file \
    "$dump_script_transformer" "$dump_script_transformer_sha256" \
    "Supabase dump-script transformer"
  if ! (cd "$capture_directory" && env -i \
      PATH="$PATH" \
      SUPABASE_TELEMETRY_DISABLED=1 \
      "$supabase_cli" db dump \
        --db-url "$database_url" \
        "$@" \
        --dry-run) \
      >"$dump_script_raw" 2>"$dump_log"; then
    production_backup_fail \
      "$dump_name canonical dry run failed; inspect its log only inside the encrypted destination."
  fi
  if ! "$node_bin" "$dump_script_transformer" \
      --database-url-file "$database_url_file" \
      --input "$dump_script_raw" \
      --output "$dump_script" \
      >>"$dump_log" 2>&1; then
    production_backup_fail \
      "$dump_name canonical dump script failed validation."
  fi
  if ! "$docker_bin" run \
      --rm \
      --pull never \
      --network bridge \
      --log-driver none \
      --mount "type=bind,source=$dump_script,target=/dominion-dump/run.sh,readonly" \
      --mount "type=bind,source=$database_passfile,target=/dominion-private/pgpass,readonly" \
      --env "PGPASSFILE=/dominion-private/pgpass" \
      --entrypoint bash \
      "$postgres_image_id" \
      /dominion-dump/run.sh \
      >"$dump_partial" 2>"$dump_log"; then
    production_backup_fail \
      "$dump_name failed in the exact pinned PostgreSQL image; inspect its encrypted log."
  fi
  printf '%s\t%s\t%s\n' \
    "$dump_name" \
    "$(production_backup_sha256_file "$dump_script_raw")" \
    "$(production_backup_sha256_file "$dump_script")" \
    >>"$dump_contract_entries"
  [[ -s "$dump_partial" && ! -L "$dump_partial" ]] || production_backup_fail \
    "$dump_name was not created as a nonempty regular file."
  mv "$dump_partial" "$capture_directory/$dump_name"
  rm "$dump_log" "$dump_script_raw" "$dump_script"
}

run_dump "roles.sql" --role-only
run_dump "schema.sql"
run_dump "data.sql" --use-copy --data-only \
  --exclude "storage.buckets_vectors" \
  --exclude "storage.vector_indexes"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-data-dump --file "$capture_directory/data.sql"
history_state="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    history-state \
    --file "$capture_directory/migration-history.json" \
    --project-ref "$project_ref"
)"
case "$history_state" in
  absent)
    "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
      write-absent-history \
      --inventory "$capture_directory/migration-history.json" \
      --project-ref "$project_ref" \
      --schema-output "$capture_directory/history-schema.sql" \
      --data-output "$capture_directory/history-data.sql"
    ;;
  present)
    run_dump "history-schema.sql" --schema "supabase_migrations"
    run_dump "history-data.sql" --use-copy --data-only --schema "supabase_migrations"
    ;;
  *) production_backup_fail "unsupported migration-history state." ;;
esac
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-history-artifacts \
  --inventory "$capture_directory/migration-history.json" \
  --project-ref "$project_ref" \
  --schema "$capture_directory/history-schema.sql" \
  --data "$capture_directory/history-data.sql" \
  >/dev/null
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-dump-contract \
  --input "$dump_contract_entries" \
  --output "$capture_directory/dump-contract.json" \
  --history-state "$history_state" \
  --cli-sha256 "$supabase_cli_sha256" \
  --postgres-image-id "$postgres_image_id"
rm "$dump_contract_entries"

# Re-attest the same mount before sealing completion evidence. A volume that
# disappeared or changed during the read-only capture cannot produce a valid
# completion marker.
[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file changed before capture completion."
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$passphrase_file" "$encrypted_volume_check_hook"

captured_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-capture-metadata \
  --output "$capture_directory/capture.json" \
  --capture-id "$capture_id" \
  --writer-quiesced-at "$writer_quiesced_at" \
  --capture-started-at "$capture_started_at" \
  --captured-at "$captured_at" \
  --project-ref "$project_ref" \
  --git-branch "$expected_branch" \
  --git-commit "$expected_commit" \
  --cli-sha256 "$supabase_cli_sha256" \
  --credential-validator-sha256 "$credential_validator_sha256" \
  --docker-bin-sha256 "$docker_bin_sha256" \
  --dump-script-transformer-sha256 "$dump_script_transformer_sha256" \
  --edge-functions-inventory-hook-sha256 "$edge_functions_inventory_hook_sha256" \
  --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
  --managed-application-ddl-hook-sha256 "$managed_application_ddl_hook_sha256" \
  --migration-history-hook-sha256 "$migration_history_hook_sha256" \
  --relation-counts-hook-sha256 "$relation_counts_hook_sha256" \
  --source-fingerprint-hook-sha256 "$source_fingerprint_hook_sha256" \
  --source-manifest-hook-sha256 "$source_manifest_hook_sha256" \
  --storage-inventory-hook-sha256 "$storage_inventory_hook_sha256" \
  --capture-toolset-sha256 "$capture_toolset_sha256" \
  --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
  --postgres-image "$postgres_image" \
  --postgres-image-id "$postgres_image_id"

"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-manifest --directory "$capture_directory" --kind capture
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-capture-marker \
  --directory "$capture_directory" \
  --capture-id "$capture_id" \
  --writer-quiesced-at "$writer_quiesced_at" \
  --capture-started-at "$capture_started_at" \
  --capture-toolset-sha256 "$capture_toolset_sha256" \
  --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
  --captured-at "$captured_at" \
  --project-ref "$project_ref" \
  --git-commit "$expected_commit"
verify_capture_evidence() {
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-capture \
    --directory "$capture_directory" \
    --capture-id "$capture_id" \
    --capture-toolset-sha256 "$capture_toolset_sha256" \
    --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
    --cli-sha256 "$supabase_cli_sha256" \
    --project-ref "$project_ref" \
    --git-branch "$expected_branch" \
    --git-commit "$expected_commit" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    "$@"
}
staged_backup_manifest_sha256="$(
  verify_capture_evidence --allow-incomplete-marker true
)"
rm "$capture_failure_marker"
backup_manifest_sha256="$(verify_capture_evidence)"
[[ "$backup_manifest_sha256" == "$staged_backup_manifest_sha256" ]] \
  || production_backup_fail "staged and completed backup evidence digests differ."

capture_complete=true
trap - EXIT
unset database_url
echo "Production backup capture completed inside the encrypted destination."
echo "CAPTURE_DIRECTORY=$capture_directory"
echo "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256"
echo "CAPTURE_TOOLSET_SHA256=$capture_toolset_sha256"
echo "APPROVED_TOOL_MANIFEST_SHA256=$approved_tool_manifest_sha256"
