#!/usr/bin/env bash
set -euo pipefail
umask 077

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
# shellcheck source=production-backup-common.sh
source "$script_directory/production-backup-common.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: rehearse-production-backup-restore.sh
  --capture-id <safe-id> --restore-id <lowercase-hyphen-id>
  --project-ref <20-char-ref>
  --expected-branch <branch> --expected-commit <40hex>
  --supabase-cli-sha256 <64hex>
  --capture-toolset-sha256 <64hex>
  --approved-tool-manifest <absolute-reviewed-json> --approved-tool-manifest-sha256 <64hex>
  --destination <absolute-mounted-encrypted-directory>
  --passphrase-file <absolute-private-file> --passphrase-sha256 <64hex>
  --encrypted-volume-check-hook <absolute-executable> --encrypted-volume-check-hook-sha256 <64hex>
  --docker-bin <absolute-executable> --docker-bin-sha256 <64hex>
  --restore-verification-hook <absolute-executable> --restore-verification-hook-sha256 <64hex>
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141
  --postgres-image-id sha256:<64hex>
  --confirm-local-restore "RESTORE <capture-id> <restore-id>"
USAGE
  exit 64
}

capture_id=""
restore_id=""
project_ref=""
expected_branch=""
expected_commit=""
supabase_cli_sha256=""
capture_toolset_sha256=""
approved_tool_manifest=""
approved_tool_manifest_sha256=""
destination=""
passphrase_file=""
passphrase_sha256=""
encrypted_volume_check_hook=""
encrypted_volume_check_hook_sha256=""
docker_bin=""
docker_bin_sha256=""
restore_verification_hook=""
restore_verification_hook_sha256=""
postgres_image=""
postgres_image_id=""
confirmation=""

if [[ "${1:-}" == "--" ]]; then
  shift
fi

while (( $# > 0 )); do
  (( $# >= 2 )) || usage
  case "$1" in
    --capture-id) capture_id="$2" ;;
    --restore-id) restore_id="$2" ;;
    --project-ref) project_ref="$2" ;;
    --expected-branch) expected_branch="$2" ;;
    --expected-commit) expected_commit="$2" ;;
    --supabase-cli-sha256) supabase_cli_sha256="$2" ;;
    --capture-toolset-sha256) capture_toolset_sha256="$2" ;;
    --approved-tool-manifest) approved_tool_manifest="$2" ;;
    --approved-tool-manifest-sha256) approved_tool_manifest_sha256="$2" ;;
    --destination) destination="$2" ;;
    --passphrase-file) passphrase_file="$2" ;;
    --passphrase-sha256) passphrase_sha256="$2" ;;
    --encrypted-volume-check-hook) encrypted_volume_check_hook="$2" ;;
    --encrypted-volume-check-hook-sha256) encrypted_volume_check_hook_sha256="$2" ;;
    --docker-bin) docker_bin="$2" ;;
    --docker-bin-sha256) docker_bin_sha256="$2" ;;
    --restore-verification-hook) restore_verification_hook="$2" ;;
    --restore-verification-hook-sha256) restore_verification_hook_sha256="$2" ;;
    --postgres-image) postgres_image="$2" ;;
    --postgres-image-id) postgres_image_id="$2" ;;
    --confirm-local-restore) confirmation="$2" ;;
    *) usage ;;
  esac
  shift 2
done

production_backup_require_safe_id "$capture_id" "capture ID"
production_backup_require_safe_id "$restore_id" "restore ID"
[[ "$restore_id" =~ ^[a-z0-9][a-z0-9-]{2,30}$ ]] || production_backup_fail \
  "restore ID must use 3-31 lowercase letters, digits, or hyphens."
production_backup_require_project_ref "$project_ref"
production_backup_require_branch "$expected_branch"
[[ "$expected_branch" == "main" ]] || production_backup_fail \
  "production restore evidence requires the main branch."
production_backup_require_commit "$expected_commit"
production_backup_require_hash "$supabase_cli_sha256" "Supabase CLI SHA-256"
production_backup_require_hash "$capture_toolset_sha256" "capture toolset SHA-256"
production_backup_hashed_regular_file \
  "$approved_tool_manifest" "$approved_tool_manifest_sha256" \
  "independently approved tool manifest"
[[ "$postgres_image" == "$DOMINION_POSTGRES_IMAGE" ]] || production_backup_fail \
  "PostgreSQL image must be exactly $DOMINION_POSTGRES_IMAGE."
production_backup_require_image_id "$postgres_image_id"
[[ "$confirmation" == "RESTORE $capture_id $restore_id" ]] \
  || production_backup_fail "local restore confirmation does not match the exact capture and restore IDs."
production_backup_reject_ambient_database_environment
production_backup_reject_ambient_runtime_environment

production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_hashed_executable "$docker_bin" "$docker_bin_sha256" "Docker CLI"
production_backup_hashed_executable \
  "$restore_verification_hook" "$restore_verification_hook_sha256" \
  "restore verification hook"
production_backup_private_file "$passphrase_file" "encrypted volume passphrase file"
production_backup_require_hash "$passphrase_sha256" "passphrase file SHA-256"
[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file SHA-256 does not match."

node_bin="$(command -v node || true)"
[[ -n "$node_bin" && -x "$node_bin" ]] || production_backup_fail "Node.js is required."
restore_toolset_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    restore-toolset-sha256 \
    --docker-bin-sha256 "$docker_bin_sha256" \
    --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
    --restore-verification-hook-sha256 "$restore_verification_hook_sha256"
)"
production_backup_require_hash "$restore_toolset_sha256" "restore toolset SHA-256"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  verify-approved-tool-manifest \
  --file "$approved_tool_manifest" \
  --file-sha256 "$approved_tool_manifest_sha256" \
  --release-commit "$expected_commit" \
  --capture-toolset-sha256 "$capture_toolset_sha256" \
  --restore-toolset-sha256 "$restore_toolset_sha256" \
  >/dev/null
git_bin="$(command -v git || true)"
[[ -n "$git_bin" && -x "$git_bin" ]] || production_backup_fail "Git is required."

actual_branch="$($git_bin -C "$repository_root" rev-parse --abbrev-ref HEAD)"
actual_commit="$($git_bin -C "$repository_root" rev-parse HEAD)"
[[ "$actual_branch" == "$expected_branch" ]] || production_backup_fail \
  "expected branch $expected_branch, found $actual_branch."
[[ "$actual_commit" == "$expected_commit" ]] || production_backup_fail \
  "expected commit $expected_commit, found $actual_commit."
[[ -z "$($git_bin -C "$repository_root" status --porcelain)" ]] || production_backup_fail \
  "the release worktree must be clean before restore rehearsal."

destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || production_backup_fail "destination cannot be the filesystem root."
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
esac
case "$destination" in
  *,*) production_backup_fail "destination cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
canonical_passphrase_file="$(
  production_backup_canonical_file "$passphrase_file" "encrypted volume passphrase file"
)"
case "$canonical_passphrase_file" in
  "$destination/"*) production_backup_fail \
    "the passphrase must be stored separately from the encrypted backup." ;;
  "$repository_root/"*) production_backup_fail \
    "the passphrase must be stored outside the repository." ;;
esac
[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file changed before encrypted destination verification."
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$passphrase_file" "$encrypted_volume_check_hook"

backup_directory="$destination/$capture_id"
backup_directory="$(production_backup_canonical_directory "$backup_directory" "capture directory")"
case "$backup_directory/" in
  "$destination/"*) ;;
  *) production_backup_fail "capture directory escaped the encrypted destination." ;;
esac

backup_manifest_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-capture \
    --directory "$backup_directory" \
    --capture-id "$capture_id" \
    --capture-toolset-sha256 "$capture_toolset_sha256" \
    --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
    --project-ref "$project_ref" \
    --git-branch "$expected_branch" \
    --git-commit "$expected_commit" \
    --cli-sha256 "$supabase_cli_sha256" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id"
)"
production_backup_require_hash "$backup_manifest_sha256" "backup manifest SHA-256"

evidence_directory="$destination/restore-$capture_id-$restore_id"
[[ ! -e "$evidence_directory" ]] || production_backup_fail \
  "restore evidence directory already exists: $evidence_directory."
mkdir "$evidence_directory"
printf '%s\n' "restore rehearsal did not complete" >"$evidence_directory/RESTORE_INCOMPLETE"
container_id_file="$evidence_directory/.restore-container-id"

container_name="dominion-restore-$restore_id"
database_suffix="$(printf '%s' "$restore_id" | tr '-' '_')"
database_name="dominion_restore_$database_suffix"
ownership_token="$backup_manifest_sha256:$restore_id"
container_id=""
container_created=false
container_creation_attempted=false
cleanup_ownership_verified=false
container_removed=false

inspect_owned_container() {
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  owned_snapshot="$($docker_bin container inspect "$container_id" --format \
    '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "com.dominion.production-backup-restore"}}|{{index .Config.Labels "com.dominion.capture-id"}}|{{index .Config.Labels "com.dominion.restore-id"}}|{{index .Config.Labels "com.dominion.ownership-token"}}' \
    2>/dev/null)" || return 1
  expected_snapshot="$container_id|$postgres_image_id|$postgres_image_id|true|$capture_id|$restore_id|$ownership_token"
  [[ "$owned_snapshot" == "$expected_snapshot" ]]
}

adopt_attempted_container_for_cleanup() {
  [[ -f "$container_id_file" && ! -L "$container_id_file" ]] || return 1
  [[ "$(wc -l <"$container_id_file" | tr -d '[:space:]')" == "1" ]] || return 1
  candidate_container_id="$(cat "$container_id_file")"
  [[ "$candidate_container_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  container_id="$candidate_container_id"
  inspect_owned_container || return 1
  container_created=true
}

remove_owned_container() {
  inspect_owned_container || {
    echo "Production backup operator: refusing cleanup because container ownership changed." >&2
    return 1
  }
  cleanup_ownership_verified=true
  "$docker_bin" rm --force "$container_id" >/dev/null || return 1
  remaining_container="$($docker_bin ps --all --quiet --filter "id=$container_id")" \
    || return 1
  if [[ -n "$remaining_container" ]]; then
    echo "Production backup operator: isolated restore container still exists after cleanup." >&2
    return 1
  fi
  container_removed=true
  container_created=false
}

cleanup() {
  restore_status=$?
  trap - EXIT
  if [[ "$container_created" == "true" ]]; then
    if ! remove_owned_container; then
      restore_status=1
    fi
  elif [[ "$container_creation_attempted" == "true" ]]; then
    if adopt_attempted_container_for_cleanup; then
      if ! remove_owned_container; then
        restore_status=1
      fi
    elif "$docker_bin" container inspect "$container_name" >/dev/null 2>&1; then
      echo "Production backup operator: refusing an unverified container left by the create attempt." >&2
      restore_status=1
    fi
  fi
  if [[ "$restore_status" -ne 0 \
    && -d "$evidence_directory" && ! -L "$evidence_directory" \
    && ! -e "$evidence_directory/RESTORE_INCOMPLETE" ]]; then
    printf '%s\n' "restore rehearsal did not complete" \
      >"$evidence_directory/RESTORE_INCOMPLETE" 2>/dev/null || true
  fi
  chmod -R go-rwx "$evidence_directory" >/dev/null 2>&1 || true
  exit "$restore_status"
}
trap cleanup EXIT

# The image must already be present. --pull never and --network none keep this
# rehearsal local and prevent a typo from becoming a registry or database call.
production_backup_require_local_docker_context "$docker_bin"
actual_image_id="$($docker_bin image inspect "$postgres_image" --format '{{.Id}}')" \
  || production_backup_fail "the exact PostgreSQL image is not present locally."
[[ "$actual_image_id" == "$postgres_image_id" ]] || production_backup_fail \
  "local PostgreSQL image ID does not match the captured image ID."
if "$docker_bin" container inspect "$container_name" >/dev/null 2>&1; then
  production_backup_fail "refusing to reuse existing container $container_name."
fi

container_creation_attempted=true
container_run_output="$($docker_bin run \
  --detach \
  --cidfile "$container_id_file" \
  --pull never \
  --network none \
  --log-driver none \
  --name "$container_name" \
  --label "com.dominion.production-backup-restore=true" \
  --label "com.dominion.capture-id=$capture_id" \
  --label "com.dominion.restore-id=$restore_id" \
  --label "com.dominion.ownership-token=$ownership_token" \
  --mount "type=bind,source=$backup_directory,target=/dominion-backup,readonly" \
  --tmpfs "/var/lib/postgresql/data:rw,nosuid,nodev" \
  --env "PGDATA=/var/lib/postgresql/data/pgdata" \
  --env "POSTGRES_HOST_AUTH_METHOD=trust" \
  "$postgres_image_id")"
[[ "$container_run_output" =~ ^[a-f0-9]{64}$ ]] || production_backup_fail \
  "Docker did not return an exact full container ID."
container_id="$container_run_output"
[[ -f "$container_id_file" && ! -L "$container_id_file" \
  && "$(wc -l <"$container_id_file" | tr -d '[:space:]')" == "1" \
  && "$(cat "$container_id_file")" == "$container_id" ]] \
  || production_backup_fail "Docker cidfile did not bind the exact full container ID."
container_created=true
inspect_owned_container || production_backup_fail \
  "new restore container failed the ownership and image inspection."

ready=false
readiness_attempt=0
while (( readiness_attempt < 60 )); do
  if "$docker_bin" exec "$container_id" \
      pg_isready --username postgres --dbname postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  readiness_attempt=$((readiness_attempt + 1))
  sleep 1
done
[[ "$ready" == "true" ]] || production_backup_fail \
  "isolated PostgreSQL container did not become ready."

actual_server_version="$($docker_bin exec "$container_id" \
  psql --username postgres --dbname postgres --no-psqlrc \
    --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command 'show server_version_num')"
actual_server_version="$(printf '%s' "$actual_server_version" | tr -d '[:space:]')"
[[ "$actual_server_version" == "$DOMINION_POSTGRES_SERVER_VERSION_NUM" ]] \
  || production_backup_fail \
    "expected PostgreSQL server_version_num $DOMINION_POSTGRES_SERVER_VERSION_NUM, found $actual_server_version."

"$docker_bin" exec "$container_id" \
  createdb --username postgres --owner postgres --template template0 "$database_name"

# Roles are cluster scoped, but the entire cluster is unique, no-network, and
# tmpfs-backed. The reviewed backup files remain mounted read-only throughout.
restore_log="$evidence_directory/.restore.log"
if ! "$docker_bin" exec "$container_id" \
    psql \
      --username postgres \
      --dbname "$database_name" \
      --no-psqlrc \
      --single-transaction \
      --set ON_ERROR_STOP=1 \
      --file /dominion-backup/roles.sql \
      --file /dominion-backup/schema.sql \
      --file /dominion-backup/managed-application-ddl.sql \
      --file /dominion-backup/history-schema.sql \
      --command 'SET session_replication_role = replica' \
      --file /dominion-backup/data.sql \
      --file /dominion-backup/history-data.sql \
      >"$restore_log" 2>&1; then
  production_backup_fail \
    "restore failed; inspect its log only inside the encrypted destination."
fi
rm "$restore_log"

verification_partial="$evidence_directory/.restore-verification.json.partial"
verification_log="$evidence_directory/.restore-verification.hook.log"
production_backup_hashed_executable \
  "$restore_verification_hook" "$restore_verification_hook_sha256" \
  "restore verification hook"
if ! (
  cd "$evidence_directory"
  "$restore_verification_hook" \
    --docker-bin "$docker_bin" \
    --container "$container_id" \
    --database "$database_name" \
    --capture-directory "$backup_directory" \
    --capture-id "$capture_id" \
    --restore-id "$restore_id" \
    --output "$verification_partial" \
    >"$verification_log" 2>&1
); then
  production_backup_fail \
    "restore verification hook failed; inspect its log only inside the encrypted destination."
fi
[[ -s "$verification_partial" && ! -L "$verification_partial" ]] \
  || production_backup_fail \
    "restore verification hook did not create a nonempty regular file."
mv "$verification_partial" "$evidence_directory/restore-verification.json"
rm "$verification_log"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-restore-verification \
  --file "$evidence_directory/restore-verification.json" \
  --capture-id "$capture_id" \
  --restore-id "$restore_id" \
  --database-name "$database_name"

remove_owned_container || production_backup_fail \
  "could not prove ownership and remove only the isolated restore container."
[[ "$cleanup_ownership_verified" == "true" && "$container_removed" == "true" ]] \
  || production_backup_fail "cleanup evidence is incomplete."
rm "$container_id_file"

[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file changed before restore completion."
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$passphrase_file" "$encrypted_volume_check_hook"

completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-restore-metadata \
  --output "$evidence_directory/restore.json" \
  --capture-id "$capture_id" \
  --restore-id "$restore_id" \
  --completed-at "$completed_at" \
  --project-ref "$project_ref" \
  --backup-manifest-sha256 "$backup_manifest_sha256" \
  --docker-bin-sha256 "$docker_bin_sha256" \
  --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
  --restore-verification-hook-sha256 "$restore_verification_hook_sha256" \
  --restore-toolset-sha256 "$restore_toolset_sha256" \
  --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
  --postgres-image "$postgres_image" \
  --postgres-image-id "$postgres_image_id" \
  --database-name "$database_name"

"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-manifest --directory "$evidence_directory" --kind restore
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-restore-marker \
  --directory "$evidence_directory" \
  --capture-id "$capture_id" \
  --restore-id "$restore_id" \
  --backup-manifest-sha256 "$backup_manifest_sha256" \
  --restore-toolset-sha256 "$restore_toolset_sha256" \
  --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256"
verify_restore_evidence() {
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-restore \
    --directory "$evidence_directory" \
    --capture-id "$capture_id" \
    --restore-id "$restore_id" \
    --restore-toolset-sha256 "$restore_toolset_sha256" \
    --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
    --project-ref "$project_ref" \
    --backup-manifest-sha256 "$backup_manifest_sha256" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    --database-name "$database_name" \
    "$@"
}
staged_restore_manifest_sha256="$(
  verify_restore_evidence --allow-incomplete-marker true
)"
rm "$evidence_directory/RESTORE_INCOMPLETE"
restore_manifest_sha256="$(verify_restore_evidence)"
[[ "$restore_manifest_sha256" == "$staged_restore_manifest_sha256" ]] \
  || production_backup_fail "staged and completed restore evidence digests differ."

trap - EXIT
echo "Production backup restore rehearsal passed and removed its isolated container."
echo "RESTORE_EVIDENCE_DIRECTORY=$evidence_directory"
echo "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256"
echo "RESTORE_EVIDENCE_MANIFEST_SHA256=$restore_manifest_sha256"
echo "RESTORE_TOOLSET_SHA256=$restore_toolset_sha256"
echo "APPROVED_TOOL_MANIFEST_SHA256=$approved_tool_manifest_sha256"
