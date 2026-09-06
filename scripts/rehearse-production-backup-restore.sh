#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

[[ "${DOMINION_CLEAN_ENV_LAUNCHER:-}" == "dominion-production-operator/v1" ]] || {
  echo "Production backup operator: invoke through the reviewed clean-environment launcher." >&2
  exit 64
}
ulimit -c 0

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
# shellcheck source=production-backup-common.sh
source "$script_directory/production-backup-common.sh"
production_backup_require_clean_environment "$script_directory" restore

usage() {
  cat >&2 <<'USAGE'
Usage: rehearse-production-backup-restore.sh
  --capture-id <safe-id> --restore-id <lowercase-hyphen-id>
  --project-ref <20-char-ref>
  --expected-branch <branch> --expected-commit <40hex>
  --supabase-cli-sha256 <64hex>
  --capture-toolset-sha256 <64hex>
  --approved-tool-manifest <absolute-reviewed-json> --approved-tool-manifest-sha256 <64hex>
  --operator-pack-clean-environment-launcher <absolute-executable>
  --macos-tcb-attestation <absolute-private-json>
  --destination <absolute-mounted-encrypted-directory>
  --encrypted-volume-attestation <absolute-private-json-inside-destination>
  --encrypted-volume-attestation-sha256 <64hex>
  --encrypted-volume-check-hook <absolute-executable> --encrypted-volume-check-hook-sha256 <64hex>
  --docker-bin <absolute-executable> --docker-bin-sha256 <64hex>
  --docker-socket <absolute-canonical-unix-socket>
  --docker-socket-device <decimal> --docker-socket-inode <decimal>
  --docker-socket-owner-uid <decimal> --docker-socket-owner-mode 384
  --docker-shared-home-root <canonical-user-home-root>
  --offline-pgsodium-getkey <absolute-executable> --offline-pgsodium-getkey-sha256 <64hex>
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
operator_pack_clean_environment_launcher=""
macos_tcb_attestation=""
destination=""
encrypted_volume_attestation=""
encrypted_volume_attestation_sha256=""
encrypted_volume_check_hook=""
encrypted_volume_check_hook_sha256=""
docker_bin=""
docker_bin_sha256=""
docker_socket=""
docker_socket_device=""
docker_socket_inode=""
docker_socket_owner_uid=""
docker_socket_owner_mode=""
docker_shared_home_root=""
offline_pgsodium_getkey=""
offline_pgsodium_getkey_sha256=""
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
    --operator-pack-clean-environment-launcher) operator_pack_clean_environment_launcher="$2" ;;
    --macos-tcb-attestation) macos_tcb_attestation="$2" ;;
    --destination) destination="$2" ;;
    --encrypted-volume-attestation) encrypted_volume_attestation="$2" ;;
    --encrypted-volume-attestation-sha256) encrypted_volume_attestation_sha256="$2" ;;
    --encrypted-volume-check-hook) encrypted_volume_check_hook="$2" ;;
    --encrypted-volume-check-hook-sha256) encrypted_volume_check_hook_sha256="$2" ;;
    --docker-bin) docker_bin="$2" ;;
    --docker-bin-sha256) docker_bin_sha256="$2" ;;
    --docker-socket) docker_socket="$2" ;;
    --docker-socket-device) docker_socket_device="$2" ;;
    --docker-socket-inode) docker_socket_inode="$2" ;;
    --docker-socket-owner-uid) docker_socket_owner_uid="$2" ;;
    --docker-socket-owner-mode) docker_socket_owner_mode="$2" ;;
    --docker-shared-home-root) docker_shared_home_root="$2" ;;
    --offline-pgsodium-getkey) offline_pgsodium_getkey="$2" ;;
    --offline-pgsodium-getkey-sha256) offline_pgsodium_getkey_sha256="$2" ;;
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
production_backup_require_local_docker_context \
  "$docker_bin" "$docker_socket" "$docker_socket_device" \
  "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"
production_backup_hashed_executable \
  "$offline_pgsodium_getkey" "$offline_pgsodium_getkey_sha256" \
  "offline pgsodium getkey helper"
production_backup_hashed_executable \
  "$restore_verification_hook" "$restore_verification_hook_sha256" \
  "restore verification hook"
node_bin="$NODE_BIN"
node_bin_sha256="$NODE_BIN_SHA256"
clean_environment_launcher_sha256="$DOMINION_CLEAN_ENV_LAUNCHER_SHA256"
input_pinning_helper="$script_directory/pin-production-input.mjs"
input_pinning_helper_sha256="$(production_backup_sha256_file "$input_pinning_helper")"
production_backup_hashed_executable "$node_bin" "$node_bin_sha256" "Node binary"
production_backup_hashed_regular_file \
  "$input_pinning_helper" "$input_pinning_helper_sha256" "input pinning helper"
operator_pack_clean_environment_launcher_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$expected_commit" \
    --toolset restore \
    --name operatorPackCleanEnvironmentLauncherSha256
)"
macos_tcb_attestation_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$expected_commit" \
    --toolset restore \
    --name macosTcbAttestationSha256
)"
production_backup_hashed_executable \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "operator-pack clean-environment launcher"
[[ "${DOMINION_MACOS_TCB_ATTESTATION_SHA256:-}" \
  == "$macos_tcb_attestation_sha256" ]] || production_backup_fail \
  "clean-launch macOS TCB attestation identity is not independently approved."
production_backup_require_hash \
  "$encrypted_volume_attestation_sha256" \
  "encrypted-volume attestation SHA-256"

restore_toolset_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    restore-toolset-sha256 \
    --clean-environment-launcher-sha256 "$clean_environment_launcher_sha256" \
    --docker-bin-sha256 "$docker_bin_sha256" \
    --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
    --input-pinning-helper-sha256 "$input_pinning_helper_sha256" \
    --macos-tcb-attestation-sha256 "$macos_tcb_attestation_sha256" \
    --node-bin-sha256 "$node_bin_sha256" \
    --offline-pgsodium-getkey-sha256 "$offline_pgsodium_getkey_sha256" \
    --operator-pack-clean-environment-launcher-sha256 \
      "$operator_pack_clean_environment_launcher_sha256" \
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
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root" \
  >/dev/null

# Establish the encrypted, Docker-shared storage boundary before creating any
# runtime state or copying an executable that will operate on production data.
destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || production_backup_fail "destination cannot be the filesystem root."
docker_shared_home_root="$(production_backup_canonical_directory \
  "$docker_shared_home_root" "Docker shared-home root")"
production_backup_require_owned_directory \
  "$docker_shared_home_root" "Docker shared-home root"
case "$destination" in
  "$docker_shared_home_root"/*) ;;
  *) production_backup_fail \
    "encrypted destination must be inside the approved Docker shared-home root." ;;
esac
production_backup_require_private_directory "$destination" "encrypted destination"
production_backup_require_private_directory \
  "$destination/private" "encrypted private runtime parent"
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
esac
case "$destination" in
  *,*) production_backup_fail \
    "destination cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
production_backup_private_file "$macos_tcb_attestation" "macOS TCB attestation"
macos_tcb_attestation="$(production_backup_canonical_file \
  "$macos_tcb_attestation" "macOS TCB attestation")"
case "$macos_tcb_attestation" in
  "$destination"/*) ;;
  *) production_backup_fail \
    "macOS TCB attestation must be sealed inside the encrypted destination." ;;
esac
[[ "$(production_backup_sha256_file "$macos_tcb_attestation")" \
  == "$macos_tcb_attestation_sha256" ]] || production_backup_fail \
  "macOS TCB attestation SHA-256 does not match the approved manifest."
production_backup_verify_encrypted_destination \
  "$destination" "$encrypted_volume_attestation" \
  "$encrypted_volume_attestation_sha256" "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "$destination/private" "$macos_tcb_attestation" \
  "$macos_tcb_attestation_sha256"

restore_runtime="$(mktemp -d \
  "$destination/private/dominion-production-restore.XXXXXX")"
case "$restore_runtime" in
  "$destination"/private/dominion-production-restore.*) ;;
  *) production_backup_fail "mktemp returned an unsafe restore runtime directory." ;;
esac
restore_runtime="$(cd "$restore_runtime" && pwd -P)"
chmod 700 "$restore_runtime"
mkdir -m 700 "$restore_runtime/home" "$restore_runtime/docker-config"
export HOME="$restore_runtime/home"
export DOCKER_CONFIG="$restore_runtime/docker-config"
export DOCKER_HOST="unix://$docker_socket"
pre_restore_cleanup() {
  pre_restore_status=$?
  pre_restore_cleanup_failed=false
  trap - EXIT
  # A second process-group signal must not interrupt removal after EXIT has
  # been cleared. Ignored dispositions are inherited by /bin/rm.
  trap '' HUP INT QUIT TERM
  if production_backup_operator_pack_runtime_needs_preservation \
      "$restore_runtime"; then
    echo "Production backup operator: preserving restore runtime with nested operator-pack recovery authority at $restore_runtime" >&2
    pre_restore_cleanup_failed=true
    pre_restore_status=1
    exit "$pre_restore_status"
  fi
  case "$restore_runtime" in
    "$destination"/private/dominion-production-restore.*)
      /bin/rm -rf -- "$restore_runtime" || pre_restore_cleanup_failed=true
      [[ ! -e "$restore_runtime" && ! -L "$restore_runtime" ]] \
        || pre_restore_cleanup_failed=true
      ;;
    *)
      echo "Production backup operator: refused unsafe restore-runtime cleanup." >&2
      pre_restore_cleanup_failed=true
      ;;
  esac
  if [[ "$pre_restore_cleanup_failed" == "true" ]]; then
    echo "Production backup operator: private restore-runtime cleanup was incomplete." >&2
    pre_restore_status=1
  fi
  exit "$pre_restore_status"
}
trap pre_restore_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
pin_identity="$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$node_bin" "$input_pinning_helper" \
    --source "$docker_bin" --sha256 "$docker_bin_sha256" \
    --destination "$restore_runtime/docker" --kind executable)" \
  || production_backup_fail "could not pin the approved Docker executable."
[[ "$pin_identity" == "PINNED_INPUT_SHA256=$docker_bin_sha256" ]] \
  || production_backup_fail "Docker executable pinning emitted an invalid identity."
docker_bin="$restore_runtime/docker"
pin_identity="$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$node_bin" "$input_pinning_helper" \
    --source "$offline_pgsodium_getkey" \
    --sha256 "$offline_pgsodium_getkey_sha256" \
    --destination "$restore_runtime/offline-pgsodium-getkey" \
    --kind executable)" \
  || production_backup_fail "could not pin the approved offline pgsodium getkey helper."
[[ "$pin_identity" == "PINNED_INPUT_SHA256=$offline_pgsodium_getkey_sha256" ]] \
  || production_backup_fail \
    "offline pgsodium getkey helper pinning emitted an invalid identity."
offline_pgsodium_getkey="$restore_runtime/offline-pgsodium-getkey"
git_bin="$(command -v git || true)"
[[ -n "$git_bin" && -x "$git_bin" ]] || production_backup_fail "Git is required."

actual_branch="$(production_backup_git "$git_bin" -C "$repository_root" \
  rev-parse --abbrev-ref HEAD)"
actual_commit="$(production_backup_git "$git_bin" -C "$repository_root" \
  rev-parse HEAD)"
[[ "$actual_branch" == "$expected_branch" ]] || production_backup_fail \
  "expected branch $expected_branch, found $actual_branch."
[[ "$actual_commit" == "$expected_commit" ]] || production_backup_fail \
  "expected commit $expected_commit, found $actual_commit."
[[ -z "$(production_backup_git "$git_bin" -C "$repository_root" \
  status --porcelain=v1 --untracked-files=all)" ]] || production_backup_fail \
  "the release worktree must be clean before restore rehearsal."

destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || production_backup_fail "destination cannot be the filesystem root."
docker_shared_home_root="$(production_backup_canonical_directory \
  "$docker_shared_home_root" "Docker shared-home root")"
case "$destination" in
  "$docker_shared_home_root"/*) ;;
  *) production_backup_fail \
    "encrypted destination must be inside the approved Docker shared-home root." ;;
esac
production_backup_require_private_directory "$destination" "encrypted destination"
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
esac
case "$destination" in
  *,*) production_backup_fail "destination cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$encrypted_volume_attestation" \
  "$encrypted_volume_attestation_sha256" "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "$restore_runtime" "$macos_tcb_attestation" \
  "$macos_tcb_attestation_sha256"

backup_directory="$destination/$capture_id"
backup_directory="$(production_backup_canonical_directory "$backup_directory" "capture directory")"
case "$backup_directory/" in
  "$destination/"*) ;;
  *) production_backup_fail "capture directory escaped the encrypted destination." ;;
esac

verify_capture_directory() {
  verified_capture_directory="$1"
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-capture \
    --directory "$verified_capture_directory" \
    --capture-id "$capture_id" \
    --capture-toolset-sha256 "$capture_toolset_sha256" \
    --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
    --project-ref "$project_ref" \
    --git-branch "$expected_branch" \
    --git-commit "$expected_commit" \
    --docker-shared-home-root "$docker_shared_home_root" \
    --cli-sha256 "$supabase_cli_sha256" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id"
}
backup_manifest_sha256="$(verify_capture_directory "$backup_directory")"
production_backup_require_hash "$backup_manifest_sha256" "backup manifest SHA-256"
backup_evidence_identity="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    evidence-identity --directory "$backup_directory" --kind capture
)"
production_backup_require_hash "$backup_evidence_identity" "backup evidence identity"
pinned_backup_directory="$restore_runtime/authenticated-backup"
pinned_backup_content_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    pin-evidence --source "$backup_directory" \
    --destination "$pinned_backup_directory" --kind capture
)"
production_backup_require_hash \
  "$pinned_backup_content_sha256" "pinned backup content SHA-256"
pinned_backup_directory="$(production_backup_canonical_directory \
  "$pinned_backup_directory" "pinned backup directory")"
case "$pinned_backup_directory/" in
  "$restore_runtime/"*) ;;
  *) production_backup_fail "pinned backup directory escaped the private restore runtime." ;;
esac
pinned_backup_manifest_sha256="$(
  verify_capture_directory "$pinned_backup_directory"
)"
[[ "$pinned_backup_manifest_sha256" == "$backup_manifest_sha256" ]] \
  || production_backup_fail "pinned backup manifest differs from the authenticated source."
pinned_backup_evidence_identity="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    evidence-identity --directory "$pinned_backup_directory" --kind capture
)"
production_backup_require_hash \
  "$pinned_backup_evidence_identity" "pinned backup evidence identity"

assert_backup_evidence_stable() {
  current_backup_identity="$(
    "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
      evidence-identity --directory "$backup_directory" --kind capture
  )" || return 1
  current_pinned_identity="$(
    "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
      evidence-identity --directory "$pinned_backup_directory" --kind capture
  )" || return 1
  [[ "$current_backup_identity" == "$backup_evidence_identity" \
    && "$current_pinned_identity" == "$pinned_backup_evidence_identity" ]]
}

evidence_directory="$destination/restore-$capture_id-$restore_id"
[[ ! -e "$evidence_directory" ]] || production_backup_fail \
  "restore evidence directory already exists: $evidence_directory."
mkdir "$evidence_directory"
printf '%s\n' "restore rehearsal did not complete" >"$evidence_directory/RESTORE_INCOMPLETE"
container_id_file="$evidence_directory/.restore-container-id"

container_name="dominion-restore-$restore_id"
database_suffix="$(printf '%s' "$restore_id" | tr '-' '_')"
database_name="dominion_restore_$database_suffix"
ownership_token="$($node_bin -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
[[ "$ownership_token" =~ ^[a-f0-9]{64}$ ]] || production_backup_fail \
  "could not create an unguessable restore container ownership token."
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
  recovery_attempt=0
  while (( recovery_attempt < 50 )); do
    candidate_container_id=""
    if [[ -f "$container_id_file" && ! -L "$container_id_file" \
      && "$(wc -l <"$container_id_file" | tr -d '[:space:]')" == "1" ]]; then
      candidate_container_id="$(cat "$container_id_file")"
    fi
    if [[ ! "$candidate_container_id" =~ ^[a-f0-9]{64}$ ]]; then
      candidate_container_id="$($docker_bin container inspect "$container_name" \
        --format '{{.Id}}' 2>/dev/null || true)"
    fi
    if [[ "$candidate_container_id" =~ ^[a-f0-9]{64}$ ]]; then
      container_id="$candidate_container_id"
      if inspect_owned_container; then
        container_created=true
        return 0
      fi
    fi
    recovery_attempt=$((recovery_attempt + 1))
    sleep 0.1
  done
  return 1
}

remove_owned_container() {
  inspect_owned_container || {
    echo "Production backup operator: refusing cleanup because container ownership changed." >&2
    return 1
  }
  cleanup_ownership_verified=true
  restore_container_cleanup_ok=true
  container_diff_file="$restore_runtime/container.diff"
  container_diff_error="$restore_runtime/container.diff.stderr"
  : >"$container_diff_file"
  : >"$container_diff_error"
  "$docker_bin" diff "$container_id" \
    >"$container_diff_file" 2>"$container_diff_error" &
  container_diff_pid=$!
  container_diff_wait=0
  while kill -0 "$container_diff_pid" 2>/dev/null \
      && (( container_diff_wait < 50 )); do
    sleep 0.1
    container_diff_wait=$((container_diff_wait + 1))
  done
  if kill -0 "$container_diff_pid" 2>/dev/null; then
    kill -KILL "$container_diff_pid" 2>/dev/null || true
    wait "$container_diff_pid" 2>/dev/null || true
    restore_container_cleanup_ok=false
  elif ! wait "$container_diff_pid"; then
    restore_container_cleanup_ok=false
  elif [[ -s "$container_diff_file" ]]; then
    restore_container_cleanup_ok=false
  fi

  # Teardown and absence proof are authoritative and must never be skipped by
  # overlay-diagnostic failure or drift.
  "$docker_bin" rm --force "$container_id" >/dev/null || return 1
  remaining_container="$($docker_bin ps --all --quiet --filter "id=$container_id")" \
    || return 1
  if [[ -n "$remaining_container" ]]; then
    echo "Production backup operator: isolated restore container still exists after cleanup." >&2
    return 1
  fi
  container_removed=true
  container_created=false
  container_creation_attempted=false
  if [[ "$restore_container_cleanup_ok" != "true" ]]; then
    echo "Production backup operator: owned restore container overlay evidence was unavailable or nonempty." >&2
  fi
  [[ "$restore_container_cleanup_ok" == "true" ]]
}

cleanup() {
  restore_status=$?
  trap - EXIT
  # Keep cleanup non-interruptible for trappable signals so a second
  # process-group signal cannot strand the authenticated backup or a
  # credential-mounted container after the EXIT trap has been removed.
  trap '' HUP INT QUIT TERM
  preserve_restore_runtime=false
  if [[ "$container_created" == "true" ]]; then
    if ! remove_owned_container; then
      restore_status=1
      if [[ "$container_created" == "true" \
        || "$container_creation_attempted" == "true" ]]; then
        preserve_restore_runtime=true
      fi
    fi
  elif [[ "$container_creation_attempted" == "true" ]]; then
    if adopt_attempted_container_for_cleanup; then
      if ! remove_owned_container; then
        restore_status=1
        if [[ "$container_created" == "true" \
          || "$container_creation_attempted" == "true" ]]; then
          preserve_restore_runtime=true
        fi
      fi
    elif "$docker_bin" container inspect "$container_name" >/dev/null 2>&1; then
      echo "Production backup operator: refusing an unverified container left by the create attempt." >&2
      restore_status=1
      preserve_restore_runtime=true
    else
      # A failed create can materialize after the immediate call returns. Keep
      # the encrypted ownership state for bounded recovery instead of deleting
      # the only cleanup authority.
      preserve_restore_runtime=true
    fi
  fi
  if [[ "$restore_status" -ne 0 \
    && -d "$evidence_directory" && ! -L "$evidence_directory" \
    && ! -e "$evidence_directory/RESTORE_INCOMPLETE" ]]; then
    printf '%s\n' "restore rehearsal did not complete" \
      >"$evidence_directory/RESTORE_INCOMPLETE" 2>/dev/null || true
  fi
  chmod -R go-rwx "$evidence_directory" >/dev/null 2>&1 || true
  if production_backup_operator_pack_runtime_needs_preservation \
      "$restore_runtime"; then
    preserve_restore_runtime=true
    restore_status=1
  fi
  if [[ "$preserve_restore_runtime" != "true" \
    && -n "${pinned_backup_directory:-}" \
    && -n "${pinned_backup_evidence_identity:-}" \
    && -d "$pinned_backup_directory" && ! -L "$pinned_backup_directory" ]]; then
    if ! "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
        unseal-evidence --directory "$pinned_backup_directory" --kind capture \
        --expected-identity "$pinned_backup_evidence_identity"; then
      echo "Production backup operator: could not authenticate pinned evidence for cleanup." >&2
      restore_status=1
      preserve_restore_runtime=true
    fi
  fi
  if [[ "$preserve_restore_runtime" == "true" ]]; then
    echo "Production backup operator: preserved encrypted restore recovery state at $restore_runtime" >&2
  else
    if ! /bin/rm -rf -- "$restore_runtime"; then
      echo "Production backup operator: could not remove the private restore runtime." >&2
      restore_status=1
    fi
    if [[ -e "$restore_runtime" || -L "$restore_runtime" ]]; then
      echo "Production backup operator: private restore runtime remains after cleanup." >&2
      restore_status=1
    fi
  fi
  exit "$restore_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

# The image must already be present. --pull never and --network none keep this
# rehearsal local and prevent a typo from becoming a registry or database call.
production_backup_require_local_docker_context \
  "$docker_bin" "$docker_socket" "$docker_socket_device" \
  "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"
actual_image_id="$($docker_bin image inspect "$postgres_image" --format '{{.Id}}')" \
  || production_backup_fail "the exact PostgreSQL image is not present locally."
[[ "$actual_image_id" == "$postgres_image_id" ]] || production_backup_fail \
  "local PostgreSQL image ID does not match the captured image ID."
if "$docker_bin" container inspect "$container_name" >/dev/null 2>&1; then
  production_backup_fail "refusing to reuse existing container $container_name."
fi
assert_backup_evidence_stable || production_backup_fail \
  "backup evidence changed before isolated restore consumption."

restore_recovery_state="$restore_runtime/restore-container-recovery.json"
if ! {
  printf '%s\n' \
    "$ownership_token" "$container_name" "$container_id_file" \
    "$postgres_image_id" "$docker_socket" "$docker_socket_device" \
    "$docker_socket_inode" "$docker_socket_owner_uid" \
    "$docker_socket_owner_mode" "$pinned_backup_directory" \
    "$offline_pgsodium_getkey" "$capture_id" "$restore_id" "$$"
} | "$node_bin" -e '
const { readFileSync, writeFileSync } = require("node:fs");
const output = process.argv[1];
const fields = readFileSync(0, "utf8").trimEnd().split("\n");
if (fields.length !== 14) process.exit(1);
const [ownershipToken, containerName, cidfile, imageId, socketPath,
  socketDevice, socketInode, socketOwnerUid, socketOwnerMode,
  backupDirectory, getkeyHelper, captureId, restoreId, operatorPid] = fields;
const value = {
  schemaVersion: 1,
  artifactContract: "dominion-production-restore-container-recovery/v1",
  status: "create-pending",
  ownershipToken,
  containerName,
  cidfile,
  captureId,
  restoreId,
  imageId,
  dockerContext: {
    endpoint: `unix://${socketPath}`,
    socketPath,
    device: socketDevice,
    inode: socketInode,
    ownerUid: Number(socketOwnerUid),
    ownerMode: Number(socketOwnerMode),
  },
  mounts: {
    backupDirectory: {
      source: backupDirectory,
      target: "/tmp/dominion-runtime/backup",
      readOnly: true,
    },
    getkeyHelper: {
      source: getkeyHelper,
      target: "/tmp/dominion-runtime/bin/offline-pgsodium-getkey",
      readOnly: true,
    },
  },
  operatorPid: Number(operatorPid),
};
writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
' "$restore_recovery_state"
then
  production_backup_fail "could not seal restore container recovery authority."
fi
chmod 600 "$restore_recovery_state"

container_creation_attempted=true
container_run_output="$($docker_bin run \
  --detach \
  --cidfile "$container_id_file" \
  --pull never \
  --network none \
  --log-driver none \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --user 100:101 \
  --stop-timeout 10 \
  --name "$container_name" \
  --label "com.dominion.production-backup-restore=true" \
  --label "com.dominion.capture-id=$capture_id" \
  --label "com.dominion.restore-id=$restore_id" \
  --label "com.dominion.ownership-token=$ownership_token" \
  --mount "type=bind,source=$pinned_backup_directory,target=/tmp/dominion-runtime/backup,readonly" \
  --mount "type=bind,source=$offline_pgsodium_getkey,target=/tmp/dominion-runtime/bin/offline-pgsodium-getkey,readonly" \
  --tmpfs "/var/lib/postgresql/data:rw,nosuid,nodev,uid=100,gid=101,mode=0700" \
  --tmpfs "/var/run/postgresql:rw,noexec,nosuid,nodev,uid=100,gid=101,mode=0700" \
  --tmpfs "/tmp:rw,nosuid,nodev,uid=100,gid=101,mode=0700,size=576m" \
  --env "PGDATA=/var/lib/postgresql/data" \
  --env "POSTGRES_HOST_AUTH_METHOD=trust" \
  "$postgres_image_id" \
    -c pgsodium.getkey_script=/tmp/dominion-runtime/bin/offline-pgsodium-getkey \
    -c vault.getkey_script=/tmp/dominion-runtime/bin/offline-pgsodium-getkey)"
[[ "$container_run_output" =~ ^[a-f0-9]{64}$ ]] || production_backup_fail \
  "Docker did not return an exact full container ID."
container_id="$container_run_output"
inspect_owned_container || production_backup_fail \
  "new restore container failed the ownership and image inspection."
container_created=true
[[ -f "$container_id_file" && ! -L "$container_id_file" \
  && "$(wc -l <"$container_id_file" | tr -d '[:space:]')" == "1" \
  && "$(cat "$container_id_file")" == "$container_id" ]] \
  || production_backup_fail "Docker cidfile did not bind the exact full container ID."

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
      --file /tmp/dominion-runtime/backup/roles.sql \
      --file /tmp/dominion-runtime/backup/schema.sql \
      --file /tmp/dominion-runtime/backup/managed-application-ddl.sql \
      --file /tmp/dominion-runtime/backup/history-schema.sql \
      --command 'SET session_replication_role = replica' \
      --file /tmp/dominion-runtime/backup/data.sql \
      --file /tmp/dominion-runtime/backup/history-data.sql \
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
  production_backup_run_operator_pack_entrypoint \
    "$operator_pack_clean_environment_launcher" \
    "$operator_pack_clean_environment_launcher_sha256" \
    restore-verification "$restore_verification_hook_sha256" \
    "$restore_runtime" "$macos_tcb_attestation" \
    "$macos_tcb_attestation_sha256" \
    --docker-bin "$docker_bin" \
    --docker-bin-sha256 "$docker_bin_sha256" \
    --docker-socket "$docker_socket" \
    --docker-socket-device "$docker_socket_device" \
    --docker-socket-inode "$docker_socket_inode" \
    --docker-socket-owner-uid "$docker_socket_owner_uid" \
    --docker-socket-owner-mode "$docker_socket_owner_mode" \
    --container "$container_id" \
    --database "$database_name" \
    --capture-directory "$pinned_backup_directory" \
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

assert_backup_evidence_stable || production_backup_fail \
  "backup evidence changed during isolated restore consumption."

remove_owned_container || production_backup_fail \
  "could not prove ownership and remove only the isolated restore container."
[[ "$cleanup_ownership_verified" == "true" && "$container_removed" == "true" ]] \
  || production_backup_fail "cleanup evidence is incomplete."
rm "$container_id_file"

production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$encrypted_volume_attestation" \
  "$encrypted_volume_attestation_sha256" "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "$restore_runtime" "$macos_tcb_attestation" \
  "$macos_tcb_attestation_sha256"

completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-restore-metadata \
  --output "$evidence_directory/restore.json" \
  --capture-id "$capture_id" \
  --restore-id "$restore_id" \
  --completed-at "$completed_at" \
  --project-ref "$project_ref" \
  --backup-manifest-sha256 "$backup_manifest_sha256" \
  --clean-environment-launcher-sha256 "$clean_environment_launcher_sha256" \
  --docker-bin-sha256 "$docker_bin_sha256" \
  --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
  --input-pinning-helper-sha256 "$input_pinning_helper_sha256" \
  --macos-tcb-attestation-sha256 "$macos_tcb_attestation_sha256" \
  --node-bin-sha256 "$node_bin_sha256" \
  --offline-pgsodium-getkey-sha256 "$offline_pgsodium_getkey_sha256" \
  --operator-pack-clean-environment-launcher-sha256 \
    "$operator_pack_clean_environment_launcher_sha256" \
  --restore-verification-hook-sha256 "$restore_verification_hook_sha256" \
  --restore-toolset-sha256 "$restore_toolset_sha256" \
  --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
  --postgres-image "$postgres_image" \
  --postgres-image-id "$postgres_image_id" \
  --database-name "$database_name" \
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root"

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
    --docker-socket "$docker_socket" \
    --docker-socket-device "$docker_socket_device" \
    --docker-socket-inode "$docker_socket_inode" \
    --docker-socket-owner-uid "$docker_socket_owner_uid" \
    --docker-socket-owner-mode "$docker_socket_owner_mode" \
    --docker-shared-home-root "$docker_shared_home_root" \
    "$@"
}
staged_restore_manifest_sha256="$(
  verify_restore_evidence --allow-incomplete-marker true
)"
rm "$evidence_directory/RESTORE_INCOMPLETE"
sealed_restore_content_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    seal-evidence --directory "$evidence_directory" --kind restore
)"
production_backup_require_hash \
  "$sealed_restore_content_sha256" "sealed restore content SHA-256"
restore_manifest_sha256="$(verify_restore_evidence)"
[[ "$restore_manifest_sha256" == "$staged_restore_manifest_sha256" ]] \
  || production_backup_fail "staged and completed restore evidence digests differ."

"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  unseal-evidence --directory "$pinned_backup_directory" --kind capture \
  --expected-identity "$pinned_backup_evidence_identity"
case "$restore_runtime" in
  "$destination"/private/dominion-production-restore.*)
    rm -rf -- "$restore_runtime"
    ;;
  *) production_backup_fail "refused unsafe restore-runtime cleanup." ;;
esac
[[ ! -e "$restore_runtime" ]] || production_backup_fail \
  "private restore runtime still exists after successful cleanup."
trap - EXIT
echo "Production backup restore rehearsal passed and removed its isolated container."
echo "RESTORE_EVIDENCE_DIRECTORY=$evidence_directory"
echo "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256"
echo "RESTORE_EVIDENCE_MANIFEST_SHA256=$restore_manifest_sha256"
echo "RESTORE_TOOLSET_SHA256=$restore_toolset_sha256"
echo "APPROVED_TOOL_MANIFEST_SHA256=$approved_tool_manifest_sha256"
