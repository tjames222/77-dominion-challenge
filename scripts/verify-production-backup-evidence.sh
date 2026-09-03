#!/usr/bin/env bash
set -euo pipefail
set +x

[[ "${DOMINION_CLEAN_ENV_LAUNCHER:-}" == "dominion-production-operator/v1" ]] || {
  echo "Production backup operator: invoke through the reviewed clean-environment launcher." >&2
  exit 64
}
ulimit -c 0

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
# shellcheck source=production-backup-common.sh
source "$script_directory/production-backup-common.sh"
production_backup_require_clean_environment "$script_directory" verify-evidence

usage() {
  cat >&2 <<'USAGE'
Usage: verify-production-backup-evidence.sh
  --destination <absolute-mounted-encrypted-directory>
  --capture-id <safe-id> --restore-id <lowercase-hyphen-id>
  --project-ref <20-char-ref>
  --expected-branch <branch> --expected-commit <40hex>
  --supabase-cli <absolute-executable> --supabase-cli-sha256 <64hex>
  --credential-validator-sha256 <64hex>
  --dump-script-transformer-sha256 <64hex>
  --approved-tool-manifest <absolute-reviewed-json> --approved-tool-manifest-sha256 <64hex>
  --operator-pack-clean-environment-launcher <absolute-executable>
  --macos-tcb-attestation <absolute-private-json>
  --edge-functions-inventory-hook <absolute-executable> --edge-functions-inventory-hook-sha256 <64hex>
  --storage-inventory-hook <absolute-executable> --storage-inventory-hook-sha256 <64hex>
  --source-manifest-hook <absolute-executable> --source-manifest-hook-sha256 <64hex>
  --source-fingerprint-hook <absolute-executable> --source-fingerprint-hook-sha256 <64hex>
  --relation-counts-hook <absolute-executable> --relation-counts-hook-sha256 <64hex>
  --migration-history-hook <absolute-executable> --migration-history-hook-sha256 <64hex>
  --managed-application-ddl-hook <absolute-executable> --managed-application-ddl-hook-sha256 <64hex>
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141
  --postgres-image-id sha256:<64hex>
  --encrypted-volume-attestation <absolute-private-json-inside-destination>
  --encrypted-volume-attestation-sha256 <64hex>
  --encrypted-volume-check-hook <absolute-executable> --encrypted-volume-check-hook-sha256 <64hex>
  --docker-bin <absolute-executable> --docker-bin-sha256 <64hex>
  --docker-socket <absolute-canonical-unix-socket>
  --docker-socket-device <decimal> --docker-socket-inode <decimal>
  --docker-socket-owner-uid <decimal> --docker-socket-owner-mode 384
  --docker-shared-home-root <absolute-canonical-owner-directory>
  --offline-pgsodium-getkey <absolute-executable> --offline-pgsodium-getkey-sha256 <64hex>
  --restore-verification-hook <absolute-executable> --restore-verification-hook-sha256 <64hex>
USAGE
  exit 64
}

destination=""
capture_id=""
restore_id=""
project_ref=""
expected_branch=""
expected_commit=""
supabase_cli=""
supabase_cli_sha256=""
credential_validator_sha256=""
dump_script_transformer_sha256=""
approved_tool_manifest=""
approved_tool_manifest_sha256=""
operator_pack_clean_environment_launcher=""
macos_tcb_attestation=""
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

if [[ "${1:-}" == "--" ]]; then
  shift
fi

while (( $# > 0 )); do
  (( $# >= 2 )) || usage
  case "$1" in
    --destination) destination="$2" ;;
    --capture-id) capture_id="$2" ;;
    --restore-id) restore_id="$2" ;;
    --project-ref) project_ref="$2" ;;
    --expected-branch) expected_branch="$2" ;;
    --expected-commit) expected_commit="$2" ;;
    --supabase-cli) supabase_cli="$2" ;;
    --supabase-cli-sha256) supabase_cli_sha256="$2" ;;
    --credential-validator-sha256) credential_validator_sha256="$2" ;;
    --dump-script-transformer-sha256) dump_script_transformer_sha256="$2" ;;
    --approved-tool-manifest) approved_tool_manifest="$2" ;;
    --approved-tool-manifest-sha256) approved_tool_manifest_sha256="$2" ;;
    --operator-pack-clean-environment-launcher) operator_pack_clean_environment_launcher="$2" ;;
    --macos-tcb-attestation) macos_tcb_attestation="$2" ;;
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
  "production evidence verification requires the main branch."
production_backup_require_commit "$expected_commit"
production_backup_reject_ambient_database_environment
production_backup_reject_ambient_runtime_environment
[[ "$postgres_image" == "$DOMINION_POSTGRES_IMAGE" ]] || production_backup_fail \
  "PostgreSQL image must be exactly $DOMINION_POSTGRES_IMAGE."
production_backup_require_image_id "$postgres_image_id"
production_backup_hashed_executable \
  "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
credential_validator="$script_directory/validate-postgres-credentials.mjs"
production_backup_hashed_regular_file \
  "$credential_validator" "$credential_validator_sha256" \
  "database credential validator"
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
  "$source_fingerprint_hook" "$source_fingerprint_hook_sha256" \
  "source fingerprint hook"
production_backup_hashed_executable \
  "$relation_counts_hook" "$relation_counts_hook_sha256" \
  "relation/sequence counts hook"
production_backup_hashed_executable \
  "$migration_history_hook" "$migration_history_hook_sha256" \
  "migration-history hook"
production_backup_hashed_executable \
  "$managed_application_ddl_hook" "$managed_application_ddl_hook_sha256" \
  "managed application DDL hook"
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
macos_tcb_attestation_sha256="$DOMINION_MACOS_TCB_ATTESTATION_SHA256"
input_pinning_helper="$script_directory/pin-production-input.mjs"
input_pinning_helper_sha256="$(production_backup_sha256_file "$input_pinning_helper")"
production_backup_hashed_executable "$node_bin" "$node_bin_sha256" "Node binary"
production_backup_hashed_regular_file \
  "$input_pinning_helper" "$input_pinning_helper_sha256" "input pinning helper"
production_backup_require_hash \
  "$macos_tcb_attestation_sha256" "macOS TCB attestation SHA-256"
production_backup_require_hash \
  "$encrypted_volume_attestation_sha256" \
  "encrypted-volume attestation SHA-256"
operator_pack_clean_environment_launcher_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$expected_commit" \
    --toolset capture \
    --name operatorPackCleanEnvironmentLauncherSha256
)"
approved_macos_tcb_attestation_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$expected_commit" \
    --toolset capture \
    --name macosTcbAttestationSha256
)"
[[ "$macos_tcb_attestation_sha256" == "$approved_macos_tcb_attestation_sha256" ]] \
  || production_backup_fail \
    "clean-launch macOS TCB attestation identity is not independently approved."
production_backup_hashed_executable \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "operator-pack clean-environment launcher"

capture_toolset_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    capture-toolset-sha256 \
    --clean-environment-launcher-sha256 "$clean_environment_launcher_sha256" \
    --credential-validator-sha256 "$credential_validator_sha256" \
    --docker-bin-sha256 "$docker_bin_sha256" \
    --dump-script-transformer-sha256 "$dump_script_transformer_sha256" \
    --edge-functions-inventory-hook-sha256 "$edge_functions_inventory_hook_sha256" \
    --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
    --input-pinning-helper-sha256 "$input_pinning_helper_sha256" \
    --macos-tcb-attestation-sha256 "$macos_tcb_attestation_sha256" \
    --managed-application-ddl-hook-sha256 "$managed_application_ddl_hook_sha256" \
    --migration-history-hook-sha256 "$migration_history_hook_sha256" \
    --node-bin-sha256 "$node_bin_sha256" \
    --operator-pack-clean-environment-launcher-sha256 \
      "$operator_pack_clean_environment_launcher_sha256" \
    --relation-counts-hook-sha256 "$relation_counts_hook_sha256" \
    --source-fingerprint-hook-sha256 "$source_fingerprint_hook_sha256" \
    --source-manifest-hook-sha256 "$source_manifest_hook_sha256" \
    --storage-inventory-hook-sha256 "$storage_inventory_hook_sha256" \
    --supabase-cli-sha256 "$supabase_cli_sha256"
)"
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
production_backup_require_hash "$capture_toolset_sha256" "capture toolset SHA-256"
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
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export SUPABASE_TELEMETRY_DISABLED=1
actual_cli_version="$($supabase_cli --version)"
[[ "$actual_cli_version" == "$DOMINION_SUPABASE_CLI_VERSION" ]] \
  || production_backup_fail \
    "expected Supabase CLI $DOMINION_SUPABASE_CLI_VERSION, found $actual_cli_version."
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
  "the release worktree must be clean before evidence verification."

destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || production_backup_fail "destination cannot be the filesystem root."
docker_shared_home_root="$(
  production_backup_canonical_directory \
    "$docker_shared_home_root" "Docker-shared home root"
)"
case "$destination/" in
  "$docker_shared_home_root/"*) ;;
  *) production_backup_fail \
    "encrypted destination must be contained by the reviewed Docker-shared home root." ;;
esac
production_backup_require_private_directory \
  "$destination" "encrypted destination"
production_backup_require_private_directory \
  "$destination/private" "encrypted private runtime parent"
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
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
capture_directory="$(
  production_backup_canonical_directory "$destination/$capture_id" "capture directory"
)"
restore_directory="$(
  production_backup_canonical_directory \
    "$destination/restore-$capture_id-$restore_id" "restore evidence directory"
)"
case "$capture_directory/" in
  "$destination/"*) ;;
  *) production_backup_fail "capture directory escaped the encrypted destination." ;;
esac
case "$restore_directory/" in
  "$destination/"*) ;;
  *) production_backup_fail "restore evidence directory escaped the encrypted destination." ;;
esac

backup_manifest_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-capture \
    --directory "$capture_directory" \
    --capture-id "$capture_id" \
    --capture-toolset-sha256 "$capture_toolset_sha256" \
    --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256" \
    --project-ref "$project_ref" \
    --git-branch "$expected_branch" \
    --git-commit "$expected_commit" \
    --cli-sha256 "$supabase_cli_sha256" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    --docker-shared-home-root "$docker_shared_home_root"
)"
database_suffix="$(printf '%s' "$restore_id" | tr '-' '_')"
database_name="dominion_restore_$database_suffix"
restore_manifest_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-restore \
    --directory "$restore_directory" \
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
    --docker-shared-home-root "$docker_shared_home_root"
)"

capture_summary="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    capture-summary --directory "$capture_directory" --project-ref "$project_ref"
)"
capture_summary_value() {
  capture_summary_key="$1"
  capture_summary_result="$(printf '%s\n' "$capture_summary" \
    | sed -n "s/^${capture_summary_key}=//p")"
  [[ -n "$capture_summary_result" \
    && "$(printf '%s\n' "$capture_summary_result" | wc -l | tr -d '[:space:]')" == "1" ]] \
    || production_backup_fail "authenticated capture summary is incomplete or duplicated."
  printf '%s\n' "$capture_summary_result"
}
summary_backup_manifest_sha256="$(capture_summary_value BACKUP_MANIFEST_SHA256)"
[[ "$summary_backup_manifest_sha256" == "$backup_manifest_sha256" ]] \
  || production_backup_fail "authenticated capture summary changed after verification."
source_manifest_sha256="$(capture_summary_value SOURCE_MANIFEST_SHA256)"
source_fingerprint_sha256="$(capture_summary_value SOURCE_FINGERPRINT_SHA256)"
relation_counts_sha256="$(capture_summary_value RELATION_SEQUENCE_COUNTS_SHA256)"
migration_history_sha256="$(capture_summary_value MIGRATION_HISTORY_SHA256)"
managed_application_ddl_sha256="$(capture_summary_value MANAGED_APPLICATION_DDL_SHA256)"
migration_history_state="$(capture_summary_value MIGRATION_HISTORY_STATE)"
writer_quiesced_at="$(capture_summary_value WRITER_QUIESCED_AT)"
capture_started_at="$(capture_summary_value CAPTURE_STARTED_AT)"
captured_at="$(capture_summary_value CAPTURED_AT)"
database_host="$(capture_summary_value DATABASE_HOST)"
ssl_root_cert_sha256="$(capture_summary_value SSL_ROOT_CERT_SHA256)"
ssl_root_cert_relative_path="$(capture_summary_value SSL_ROOT_CERT_RELATIVE_PATH)"
captured_encrypted_volume_attestation_sha256="$(
  capture_summary_value ENCRYPTED_VOLUME_ATTESTATION_SHA256
)"
[[ "$captured_encrypted_volume_attestation_sha256" \
  == "$encrypted_volume_attestation_sha256" ]] || production_backup_fail \
  "capture metadata does not bind the supplied encrypted-volume attestation."
production_backup_verify_encrypted_destination \
  "$destination" "$encrypted_volume_attestation" \
  "$encrypted_volume_attestation_sha256" "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "$destination/private" "$macos_tcb_attestation" \
  "$macos_tcb_attestation_sha256"

# Keep stdout stable for downstream release gates. Diagnostics use stderr.
echo "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256"
echo "RESTORE_EVIDENCE_MANIFEST_SHA256=$restore_manifest_sha256"
echo "SOURCE_MANIFEST_SHA256=$source_manifest_sha256"
echo "SOURCE_FINGERPRINT_SHA256=$source_fingerprint_sha256"
echo "RELATION_SEQUENCE_COUNTS_SHA256=$relation_counts_sha256"
echo "MIGRATION_HISTORY_SHA256=$migration_history_sha256"
echo "MANAGED_APPLICATION_DDL_SHA256=$managed_application_ddl_sha256"
echo "CAPTURE_TOOLSET_SHA256=$capture_toolset_sha256"
echo "RESTORE_TOOLSET_SHA256=$restore_toolset_sha256"
echo "APPROVED_TOOL_MANIFEST_SHA256=$approved_tool_manifest_sha256"
echo "MIGRATION_HISTORY_STATE=$migration_history_state"
echo "SUPABASE_CLI_SHA256=$supabase_cli_sha256"
echo "POSTGRES_IMAGE_ID=$postgres_image_id"
echo "WRITER_QUIESCED_AT=$writer_quiesced_at"
echo "CAPTURE_STARTED_AT=$capture_started_at"
echo "CAPTURED_AT=$captured_at"
echo "CAPTURE_DIRECTORY=$capture_directory"
echo "RESTORE_DIRECTORY=$restore_directory"
echo "DATABASE_HOST=$database_host"
echo "SSL_ROOT_CERT_SHA256=$ssl_root_cert_sha256"
echo "SSL_ROOT_CERT_RELATIVE_PATH=$ssl_root_cert_relative_path"
echo "ENCRYPTED_VOLUME_ATTESTATION_SHA256=$encrypted_volume_attestation_sha256"
echo "DOCKER_SHARED_HOME_ROOT=$docker_shared_home_root"
echo "MACOS_TCB_ATTESTATION_SHA256=$macos_tcb_attestation_sha256"
