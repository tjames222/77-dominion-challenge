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
production_backup_require_clean_environment "$script_directory" capture

usage() {
  cat >&2 <<'USAGE'
Usage: capture-production-backup.sh
  --capture-id <safe-id>
  --project-ref <20-char-ref>
  --database-host <exact-dashboard-supavisor-host>
  --expected-branch <branch> --expected-commit <40hex>
  --supabase-cli <absolute-path> --supabase-cli-sha256 <64hex>
  --database-url-file <absolute-private-file> --database-url-sha256 <64hex>
  --database-passfile <absolute-private-file> --database-passfile-sha256 <64hex>
  --ssl-root-cert-file <absolute-reviewed-ca-file> --ssl-root-cert-file-sha256 <64hex>
  --credential-validator-sha256 <64hex>
  --docker-bin <absolute-executable> --docker-bin-sha256 <64hex>
  --docker-socket <absolute-canonical-unix-socket>
  --docker-socket-device <decimal> --docker-socket-inode <decimal>
  --docker-socket-owner-uid <decimal> --docker-socket-owner-mode 384
  --docker-shared-home-root <canonical-user-home-root>
  --dump-script-transformer-sha256 <64hex>
  --approved-tool-manifest <absolute-reviewed-json> --approved-tool-manifest-sha256 <64hex>
  --operator-pack-clean-environment-launcher <absolute-executable>
  --macos-tcb-attestation <absolute-private-json>
  --access-token-file <absolute-private-file> --access-token-sha256 <64hex>
  --destination <absolute-mounted-encrypted-directory>
  --encrypted-volume-attestation <absolute-private-json-inside-destination>
  --encrypted-volume-attestation-sha256 <64hex>
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
database_host=""
expected_branch=""
expected_commit=""
supabase_cli=""
supabase_cli_sha256=""
database_url_file=""
database_url_sha256=""
database_passfile=""
database_passfile_sha256=""
ssl_root_cert_file=""
ssl_root_cert_file_sha256=""
credential_validator_sha256=""
docker_bin=""
docker_bin_sha256=""
docker_socket=""
docker_socket_device=""
docker_socket_inode=""
docker_socket_owner_uid=""
docker_socket_owner_mode=""
docker_shared_home_root=""
dump_script_transformer_sha256=""
approved_tool_manifest=""
approved_tool_manifest_sha256=""
operator_pack_clean_environment_launcher=""
macos_tcb_attestation=""
access_token_file=""
access_token_sha256=""
destination=""
encrypted_volume_attestation=""
encrypted_volume_attestation_sha256=""
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
ssl_root_cert_relative_path="private/supabase-ca/prod-ca-2021.crt"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

while (( $# > 0 )); do
  (( $# >= 2 )) || usage
  case "$1" in
    --capture-id) capture_id="$2" ;;
    --project-ref) project_ref="$2" ;;
    --database-host) database_host="$2" ;;
    --expected-branch) expected_branch="$2" ;;
    --expected-commit) expected_commit="$2" ;;
    --supabase-cli) supabase_cli="$2" ;;
    --supabase-cli-sha256) supabase_cli_sha256="$2" ;;
    --database-url-file) database_url_file="$2" ;;
    --database-url-sha256) database_url_sha256="$2" ;;
    --database-passfile) database_passfile="$2" ;;
    --database-passfile-sha256) database_passfile_sha256="$2" ;;
    --ssl-root-cert-file) ssl_root_cert_file="$2" ;;
    --ssl-root-cert-file-sha256) ssl_root_cert_file_sha256="$2" ;;
    --credential-validator-sha256) credential_validator_sha256="$2" ;;
    --docker-bin) docker_bin="$2" ;;
    --docker-bin-sha256) docker_bin_sha256="$2" ;;
    --docker-socket) docker_socket="$2" ;;
    --docker-socket-device) docker_socket_device="$2" ;;
    --docker-socket-inode) docker_socket_inode="$2" ;;
    --docker-socket-owner-uid) docker_socket_owner_uid="$2" ;;
    --docker-socket-owner-mode) docker_socket_owner_mode="$2" ;;
    --docker-shared-home-root) docker_shared_home_root="$2" ;;
    --dump-script-transformer-sha256) dump_script_transformer_sha256="$2" ;;
    --approved-tool-manifest) approved_tool_manifest="$2" ;;
    --approved-tool-manifest-sha256) approved_tool_manifest_sha256="$2" ;;
    --operator-pack-clean-environment-launcher) operator_pack_clean_environment_launcher="$2" ;;
    --macos-tcb-attestation) macos_tcb_attestation="$2" ;;
    --access-token-file) access_token_file="$2" ;;
    --access-token-sha256) access_token_sha256="$2" ;;
    --destination) destination="$2" ;;
    --encrypted-volume-attestation) encrypted_volume_attestation="$2" ;;
    --encrypted-volume-attestation-sha256) encrypted_volume_attestation_sha256="$2" ;;
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
[[ "$database_host" =~ ^[a-z0-9-]+\.pooler\.supabase\.com$ ]] \
  || production_backup_fail "database host must be the exact dashboard-provided Supavisor hostname."
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
node_bin="$NODE_BIN"
node_bin_sha256="$NODE_BIN_SHA256"
clean_environment_launcher_sha256="$DOMINION_CLEAN_ENV_LAUNCHER_SHA256"
input_pinning_helper="$script_directory/pin-production-input.mjs"
input_pinning_helper_sha256="$(production_backup_sha256_file "$input_pinning_helper")"
production_backup_hashed_regular_file \
  "$input_pinning_helper" "$input_pinning_helper_sha256" "input pinning helper"
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
operator_pack_clean_environment_launcher_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$expected_commit" \
    --toolset capture \
    --name operatorPackCleanEnvironmentLauncherSha256
)"
macos_tcb_attestation_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$expected_commit" \
    --toolset capture \
    --name macosTcbAttestationSha256
)"
production_backup_hashed_executable \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "operator-pack clean-environment launcher"
[[ "${DOMINION_MACOS_TCB_ATTESTATION_SHA256:-}" \
  == "$macos_tcb_attestation_sha256" ]] || production_backup_fail \
  "clean-launch macOS TCB attestation identity is not independently approved."
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
production_backup_require_local_docker_context \
  "$docker_bin" "$docker_socket" "$docker_socket_device" \
  "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"

# Validate only caller-supplied digests here. Credential-bearing files are not
# opened until the destination has been canonicalized, containment-checked, and
# independently attested as the approved encrypted volume below.
production_backup_require_hash "$database_url_sha256" "database URL file SHA-256"
production_backup_require_hash "$database_passfile_sha256" "database passfile SHA-256"
production_backup_require_hash "$access_token_sha256" "access token file SHA-256"
production_backup_require_hash \
  "$encrypted_volume_attestation_sha256" \
  "encrypted-volume attestation SHA-256"
production_backup_require_hash "$ssl_root_cert_file_sha256" "TLS root certificate SHA-256"

production_backup_hashed_executable "$node_bin" "$node_bin_sha256" "Node binary"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  validate-timestamp --value "$writer_quiesced_at"
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
  "the release worktree must be clean before capture."

# Validate the independently reviewed inventory before executing even a
# nominally local operator hook. This prevents a self-supplied hook hash from
# becoming authority to run arbitrary code.
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
production_backup_require_hash "$capture_toolset_sha256" "capture toolset SHA-256"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  verify-approved-tool-manifest \
  --file "$approved_tool_manifest" \
  --file-sha256 "$approved_tool_manifest_sha256" \
  --release-commit "$expected_commit" \
  --capture-toolset-sha256 "$capture_toolset_sha256" \
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root" \
  >/dev/null

# Establish and attest the encrypted, Docker-shared storage boundary before
# opening or copying any credential-bearing input.
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
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
esac
case "$destination" in
  *,*) production_backup_fail \
    "destination cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
[[ -w "$destination" ]] || production_backup_fail "encrypted destination is not writable."
production_backup_require_private_directory \
  "$destination/private" "encrypted private runtime parent"
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

production_backup_private_file "$database_url_file" "database URL file"
production_backup_private_file "$database_passfile" "database passfile"
production_backup_private_file "$access_token_file" "access token file"
production_backup_hashed_tls_root_cert \
  "$ssl_root_cert_file" "$ssl_root_cert_file_sha256"
production_backup_require_hash "$database_url_sha256" "database URL file SHA-256"
production_backup_require_hash "$database_passfile_sha256" "database passfile SHA-256"
production_backup_require_hash "$access_token_sha256" "access token file SHA-256"
production_backup_require_hash "$ssl_root_cert_file_sha256" "TLS root certificate SHA-256"
[[ "$(production_backup_sha256_file "$database_url_file")" == "$database_url_sha256" ]] \
  || production_backup_fail "database URL file SHA-256 does not match."
[[ "$(production_backup_sha256_file "$database_passfile")" == "$database_passfile_sha256" ]] \
  || production_backup_fail "database passfile SHA-256 does not match."
[[ "$(production_backup_sha256_file "$access_token_file")" == "$access_token_sha256" ]] \
  || production_backup_fail "access token file SHA-256 does not match."
url_ssl_root_cert_file="$(
  production_backup_canonical_file "$ssl_root_cert_file" "TLS root certificate"
)"
[[ "$url_ssl_root_cert_file" == "$destination/$ssl_root_cert_relative_path" ]] \
  || production_backup_fail \
    "TLS root certificate must be the exact reviewed file inside the encrypted destination."
for private_input_file in \
  "$database_url_file" "$database_passfile" "$access_token_file" \
  "$ssl_root_cert_file" "$encrypted_volume_attestation"; do
  canonical_private_input="$(
    production_backup_canonical_file "$private_input_file" "private input file"
  )"
  case "$canonical_private_input" in
    "$destination"/*) ;;
    *) production_backup_fail \
      "all credential, CA, and attestation inputs must be inside the encrypted destination." ;;
  esac
done

production_backup_require_private_directory \
  "$destination/private" "encrypted private runtime parent"

operator_runtime="$(mktemp -d \
  "$destination/private/dominion-production-capture.XXXXXX")"
case "$operator_runtime" in
  "$destination"/private/dominion-production-capture.*) ;;
  *) production_backup_fail "mktemp returned an unsafe capture runtime directory." ;;
esac
operator_runtime="$(cd "$operator_runtime" && pwd -P)"
chmod 700 "$operator_runtime"
mkdir -m 700 "$operator_runtime/home" "$operator_runtime/docker-config"
export HOME="$operator_runtime/home"
export DOCKER_CONFIG="$operator_runtime/docker-config"
export DOCKER_HOST="unix://$docker_socket"
pre_capture_cleanup() {
  pre_capture_status=$?
  pre_capture_cleanup_failed=false
  trap - EXIT
  # A second process-group signal must not interrupt credential deletion after
  # EXIT has been cleared. Ignored dispositions are inherited by /bin/rm.
  trap '' HUP INT QUIT TERM
  if production_backup_operator_pack_runtime_needs_preservation \
      "$operator_runtime"; then
    echo "Production backup operator: preserving capture runtime with nested operator-pack recovery authority at $operator_runtime" >&2
    pre_capture_cleanup_failed=true
    pre_capture_status=1
    exit "$pre_capture_status"
  fi
  case "$operator_runtime" in
    "$destination"/private/dominion-production-capture.*)
      /bin/rm -rf -- "$operator_runtime" || pre_capture_cleanup_failed=true
      [[ ! -e "$operator_runtime" && ! -L "$operator_runtime" ]] \
        || pre_capture_cleanup_failed=true
      ;;
    *)
      echo "Production backup operator: refused unsafe capture-runtime cleanup." >&2
      pre_capture_cleanup_failed=true
      ;;
  esac
  if [[ "$pre_capture_cleanup_failed" == "true" ]]; then
    echo "Production backup operator: private capture-runtime cleanup was incomplete." >&2
    pre_capture_status=1
  fi
  exit "$pre_capture_status"
}
trap pre_capture_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

pin_capture_input() {
  pin_capture_source="$1"
  pin_capture_hash="$2"
  pin_capture_destination="$3"
  pin_capture_kind="$4"
  pin_capture_identity="$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$node_bin" "$input_pinning_helper" \
      --source "$pin_capture_source" --sha256 "$pin_capture_hash" \
      --destination "$pin_capture_destination" --kind "$pin_capture_kind")" \
    || production_backup_fail "could not pin an approved production input."
  [[ "$pin_capture_identity" == "PINNED_INPUT_SHA256=$pin_capture_hash" ]] \
    || production_backup_fail "input pinning helper emitted an invalid identity."
}

url_ssl_root_cert_file="$ssl_root_cert_file"
pin_capture_input "$database_url_file" "$database_url_sha256" \
  "$operator_runtime/database-url" private
pin_capture_input "$database_passfile" "$database_passfile_sha256" \
  "$operator_runtime/pgpass" private
pin_capture_input "$access_token_file" "$access_token_sha256" \
  "$operator_runtime/access-token" private
pin_capture_input "$ssl_root_cert_file" "$ssl_root_cert_file_sha256" \
  "$operator_runtime/supabase-ca.crt" tls-root-cert
pin_capture_input "$supabase_cli" "$supabase_cli_sha256" \
  "$operator_runtime/supabase" executable
pin_capture_input "$docker_bin" "$docker_bin_sha256" \
  "$operator_runtime/docker" executable
database_url_file="$operator_runtime/database-url"
database_passfile="$operator_runtime/pgpass"
access_token_file="$operator_runtime/access-token"
ssl_root_cert_file="$operator_runtime/supabase-ca.crt"
supabase_cli="$operator_runtime/supabase"
docker_bin="$operator_runtime/docker"

database_url="$(
  "$node_bin" "$credential_validator" \
    --database-url-file "$database_url_file" \
    --database-passfile "$database_passfile" \
    --database-host "$database_host" \
    --project-ref "$project_ref" \
    --ssl-root-cert-file "$ssl_root_cert_file" \
    --ssl-root-cert-file-sha256 "$ssl_root_cert_file_sha256" \
    --url-ssl-root-cert-file "$url_ssl_root_cert_file"
)"
export SUPABASE_TELEMETRY_DISABLED=1
actual_cli_version="$($supabase_cli --version)"
[[ "$actual_cli_version" == "$DOMINION_SUPABASE_CLI_VERSION" ]] \
  || production_backup_fail \
    "expected Supabase CLI $DOMINION_SUPABASE_CLI_VERSION, found $actual_cli_version."

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
  *,*) production_backup_fail \
    "destination cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
[[ "$url_ssl_root_cert_file" \
  == "$destination/$ssl_root_cert_relative_path" ]] || production_backup_fail \
  "TLS root certificate must be the exact reviewed file inside the encrypted destination."
case "$database_passfile" in
  *,*) production_backup_fail \
    "database passfile path cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
case "$ssl_root_cert_file" in
  *,*) production_backup_fail \
    "TLS root certificate path cannot contain a comma because Docker bind mounts use comma delimiters." ;;
esac
for private_input_file in \
  "$database_url_file" "$database_passfile" "$access_token_file"; do
  canonical_private_input="$(
    production_backup_canonical_file "$private_input_file" "private input file"
  )"
  case "$canonical_private_input" in
    "$destination/private/"*) ;;
    *) production_backup_fail \
      "pinned credential inputs must remain inside the encrypted private runtime." ;;
  esac
done
[[ -w "$destination" ]] || production_backup_fail "encrypted destination is not writable."
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$encrypted_volume_attestation" \
  "$encrypted_volume_attestation_sha256" "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "$operator_runtime" "$macos_tcb_attestation" \
  "$macos_tcb_attestation_sha256"

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
  # Keep cleanup non-interruptible for trappable signals. In particular, a
  # second process-group signal cannot kill a foreground Docker/rm child and
  # strand credential mounts after the EXIT trap has been removed.
  trap '' HUP INT QUIT TERM
  preserve_operator_runtime=false
  if [[ "${dump_container_active:-false}" == "true" ]]; then
    if ! remove_owned_dump_container; then
      capture_status=1
      if [[ "${dump_container_active:-false}" == "true" \
        || "${dump_container_creation_attempted:-false}" == "true" ]]; then
        preserve_operator_runtime=true
      fi
    fi
  elif [[ "${dump_container_creation_attempted:-false}" == "true" ]]; then
    if adopt_owned_dump_container; then
      if ! remove_owned_dump_container; then
        capture_status=1
        if [[ "${dump_container_active:-false}" == "true" \
          || "${dump_container_creation_attempted:-false}" == "true" ]]; then
          preserve_operator_runtime=true
        fi
      fi
    elif [[ -n "${dump_container_name:-}" ]] \
      && "$docker_bin" container inspect "$dump_container_name" >/dev/null 2>&1; then
      echo "Production backup operator: refusing to remove an unowned dump container." >&2
      capture_status=1
      preserve_operator_runtime=true
    else
      # A failed create can materialize after the bounded adoption window. Keep
      # the exact private ownership contract as future cleanup authority.
      capture_status=1
      preserve_operator_runtime=true
    fi
  fi
  if [[ "$capture_complete" != "true" ]]; then
    if [[ -d "$capture_directory" && ! -L "$capture_directory" \
      && ! -e "$capture_failure_marker" ]]; then
      printf '%s\n' "capture did not complete" >"$capture_failure_marker" \
        2>/dev/null || true
    fi
    chmod -R go-rwx "$capture_directory" >/dev/null 2>&1 || true
  fi
  if production_backup_operator_pack_runtime_needs_preservation \
      "$operator_runtime"; then
    preserve_operator_runtime=true
    capture_status=1
  fi
  if [[ "$preserve_operator_runtime" == "true" ]]; then
    echo "Production backup operator: preserved encrypted capture recovery state at $operator_runtime" >&2
  else
    if ! /bin/rm -rf -- "$operator_runtime"; then
      echo "Production backup operator: could not remove the private capture runtime." >&2
      capture_status=1
    fi
    if [[ -e "$operator_runtime" || -L "$operator_runtime" ]]; then
      echo "Production backup operator: private capture runtime remains after cleanup." >&2
      capture_status=1
    fi
  fi
  exit "$capture_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

production_backup_require_local_docker_context \
  "$docker_bin" "$docker_socket" "$docker_socket_device" \
  "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"
existing_capture_clients="$($docker_bin ps --all --quiet \
  --filter "label=com.dominion.production-backup-capture=true" \
  --filter "label=com.dominion.capture-id=$capture_id")" \
  || production_backup_fail "could not inspect prior capture client containers."
[[ -z "$existing_capture_clients" ]] || production_backup_fail \
  "an orphaned capture client exists; cleanup requires its exact private ownership evidence."
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
  encoded_ssl_root_cert="$($node_bin -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$ssl_root_cert_file")"
  env -i \
    PATH="$PATH" \
    HOME="$operator_runtime/home" \
    XDG_CONFIG_HOME="$operator_runtime/home" \
    SUPABASE_TELEMETRY_DISABLED=1 \
    "$supabase_cli" db dump \
      --db-url "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=verify-full&sslrootcert=$encoded_ssl_root_cert" \
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
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root" \
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
  inventory_entrypoint="$3"
  inventory_output="$4"
  production_backup_hashed_executable \
    "$inventory_hook" "$inventory_hook_sha256" "$inventory_output hook"
  inventory_partial="$capture_directory/.${inventory_output}.partial"
  inventory_log="$capture_directory/.${inventory_output}.hook.log"
  if ! (
    cd "$capture_directory"
    production_backup_run_operator_pack_entrypoint \
      "$operator_pack_clean_environment_launcher" \
      "$operator_pack_clean_environment_launcher_sha256" \
      "$inventory_entrypoint" "$inventory_hook_sha256" \
      "$operator_runtime" "$macos_tcb_attestation" \
      "$macos_tcb_attestation_sha256" \
      --database-client-contract "$DOMINION_DATABASE_CLIENT_CONTRACT" \
      --database-url-file "$database_url_file" \
      --database-url-file-sha256 "$database_url_sha256" \
      --database-passfile "$database_passfile" \
      --database-passfile-sha256 "$database_passfile_sha256" \
      --database-host "$database_host" \
      --ssl-root-cert-file "$ssl_root_cert_file" \
      --ssl-root-cert-file-sha256 "$ssl_root_cert_file_sha256" \
      --project-ref "$project_ref" \
      --docker-bin "$docker_bin" \
      --docker-bin-sha256 "$docker_bin_sha256" \
      --docker-socket "$docker_socket" \
      --docker-socket-device "$docker_socket_device" \
      --docker-socket-inode "$docker_socket_inode" \
      --docker-socket-owner-uid "$docker_socket_owner_uid" \
      --docker-socket-owner-mode "$docker_socket_owner_mode" \
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
  production_backup_run_operator_pack_entrypoint \
    "$operator_pack_clean_environment_launcher" \
    "$operator_pack_clean_environment_launcher_sha256" \
    storage-inventory "$storage_inventory_hook_sha256" \
    "$operator_runtime" "$macos_tcb_attestation" \
    "$macos_tcb_attestation_sha256" \
    --database-client-contract "$DOMINION_DATABASE_CLIENT_CONTRACT" \
    --database-url-file "$database_url_file" \
    --database-url-file-sha256 "$database_url_sha256" \
    --database-passfile "$database_passfile" \
    --database-passfile-sha256 "$database_passfile_sha256" \
    --database-host "$database_host" \
    --ssl-root-cert-file "$ssl_root_cert_file" \
    --ssl-root-cert-file-sha256 "$ssl_root_cert_file_sha256" \
    --project-ref "$project_ref" \
    --docker-bin "$docker_bin" \
    --docker-bin-sha256 "$docker_bin_sha256" \
    --docker-socket "$docker_socket" \
    --docker-socket-device "$docker_socket_device" \
    --docker-socket-inode "$docker_socket_inode" \
    --docker-socket-owner-uid "$docker_socket_owner_uid" \
    --docker-socket-owner-mode "$docker_socket_owner_mode" \
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
  production_backup_run_operator_pack_entrypoint \
    "$operator_pack_clean_environment_launcher" \
    "$operator_pack_clean_environment_launcher_sha256" \
    edge-functions-inventory "$edge_functions_inventory_hook_sha256" \
    "$operator_runtime" "$macos_tcb_attestation" \
    "$macos_tcb_attestation_sha256" \
    --supabase-cli "$supabase_cli" \
    --supabase-cli-sha256 "$supabase_cli_sha256" \
    --access-token-file "$access_token_file" \
    --access-token-file-sha256 "$access_token_sha256" \
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
  "$source_manifest_hook" "$source_manifest_hook_sha256" \
  source-manifest "source-manifest.jsonl"
run_database_inventory_hook \
  "$source_fingerprint_hook" "$source_fingerprint_hook_sha256" \
  source-fingerprint "source-fingerprint.jsonl"
run_database_inventory_hook \
  "$relation_counts_hook" "$relation_counts_hook_sha256" \
  relation-counts "relation-sequence-counts.json"
run_database_inventory_hook \
  "$migration_history_hook" "$migration_history_hook_sha256" \
  migration-history "migration-history.json"
run_database_inventory_hook \
  "$managed_application_ddl_hook" "$managed_application_ddl_hook_sha256" \
  managed-application-ddl "managed-application-ddl.sql"

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

dump_container_id=""
dump_container_name=""
dump_container_token=""
dump_container_operation=""
dump_container_active=false
dump_container_creation_attempted=false
dump_container_cidfile=""

inspect_owned_dump_container() {
  [[ "$dump_container_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  dump_container_snapshot="$($docker_bin container inspect "$dump_container_id" --format \
    '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "com.dominion.production-backup-capture"}}|{{index .Config.Labels "com.dominion.capture-id"}}|{{index .Config.Labels "com.dominion.ownership-token"}}|{{index .Config.Labels "com.dominion.operation"}}' \
    2>/dev/null)" || return 1
  [[ "$dump_container_snapshot" \
    == "$dump_container_id|$postgres_image_id|$postgres_image_id|true|$capture_id|$dump_container_token|$dump_container_operation" ]]
}

adopt_owned_dump_container() {
  dump_container_recovery_attempt=0
  while (( dump_container_recovery_attempt < 50 )); do
    dump_container_candidate=""
    if [[ -f "$dump_container_cidfile" && ! -L "$dump_container_cidfile" \
      && "$(wc -l <"$dump_container_cidfile" | tr -d '[:space:]')" == "1" ]]; then
      dump_container_candidate="$(cat "$dump_container_cidfile")"
    fi
    if [[ ! "$dump_container_candidate" =~ ^[a-f0-9]{64}$ ]]; then
      dump_container_candidate="$($docker_bin container inspect "$dump_container_name" \
        --format '{{.Id}}' 2>/dev/null || true)"
    fi
    if [[ "$dump_container_candidate" =~ ^[a-f0-9]{64}$ ]]; then
      dump_container_id="$dump_container_candidate"
      if inspect_owned_dump_container; then
        dump_container_active=true
        return 0
      fi
    fi
    dump_container_recovery_attempt=$((dump_container_recovery_attempt + 1))
    sleep 0.1
  done
  return 1
}

remove_owned_dump_container() {
  inspect_owned_dump_container || return 1
  dump_container_cleanup_ok=true
  dump_container_diff_file="$dump_container_runtime/container.diff"
  dump_container_diff_error="$dump_container_runtime/container.diff.stderr"
  : >"$dump_container_diff_file"
  : >"$dump_container_diff_error"
  "$docker_bin" diff "$dump_container_id" \
    >"$dump_container_diff_file" 2>"$dump_container_diff_error" &
  dump_container_diff_pid=$!
  dump_container_diff_wait=0
  while kill -0 "$dump_container_diff_pid" 2>/dev/null \
      && (( dump_container_diff_wait < 50 )); do
    sleep 0.1
    dump_container_diff_wait=$((dump_container_diff_wait + 1))
  done
  if kill -0 "$dump_container_diff_pid" 2>/dev/null; then
    kill -KILL "$dump_container_diff_pid" 2>/dev/null || true
    wait "$dump_container_diff_pid" 2>/dev/null || true
    dump_container_cleanup_ok=false
  elif ! wait "$dump_container_diff_pid"; then
    dump_container_cleanup_ok=false
  elif [[ -s "$dump_container_diff_file" ]]; then
    dump_container_cleanup_ok=false
  fi

  # Always force-remove and prove absence once ownership is established; a
  # failed or nonempty overlay diagnostic must not strand credential mounts.
  "$docker_bin" rm --force "$dump_container_id" >/dev/null || return 1
  remaining_dump_container="$($docker_bin ps --all --quiet \
    --filter "id=$dump_container_id")" || return 1
  if [[ -n "$remaining_dump_container" ]]; then
    echo "Production backup operator: owned dump client still exists after forced removal." >&2
    return 1
  fi
  dump_container_active=false
  dump_container_creation_attempted=false
  if [[ "$dump_container_cleanup_ok" != "true" ]]; then
    echo "Production backup operator: owned dump overlay evidence was unavailable or nonempty." >&2
  fi
  [[ "$dump_container_cleanup_ok" == "true" ]]
}

run_dump() {
  dump_name="$1"
  shift
  dump_partial="$capture_directory/.${dump_name}.partial"
  dump_log="$capture_directory/.${dump_name}.dump.log"
  dump_script_raw="$capture_directory/.${dump_name}.supabase-dry-run.sh"
  dump_script="$capture_directory/.${dump_name}.run.sh"
  dump_container_operation="dump-$dump_name"
  dump_container_token="$($node_bin -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  [[ "$dump_container_token" =~ ^[a-f0-9]{64}$ ]] \
    || production_backup_fail "could not create a dump container ownership token."
  dump_container_name="dominion-dump-${capture_id:0:24}-${dump_container_token:0:16}"
  dump_container_runtime="$operator_runtime/container-$dump_name"
  mkdir "$dump_container_runtime"
  dump_container_cidfile="$dump_container_runtime/cid"
  dump_container_id=""
  dump_container_active=false
  dump_container_creation_attempted=false
  if "$docker_bin" container inspect "$dump_container_name" >/dev/null 2>&1; then
    production_backup_fail "refusing an unexpected pre-existing dump container."
  fi
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
      --database-host "$database_host" \
      --project-ref "$project_ref" \
      --ssl-root-cert-file "$ssl_root_cert_file" \
      --ssl-root-cert-file-sha256 "$ssl_root_cert_file_sha256" \
      --url-ssl-root-cert-file "$url_ssl_root_cert_file"
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
      HOME="$operator_runtime/home" XDG_CONFIG_HOME="$operator_runtime/home" \
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
      --ssl-root-cert-file "$ssl_root_cert_file" \
      --input "$dump_script_raw" \
      --output "$dump_script" \
      >>"$dump_log" 2>&1; then
    production_backup_fail \
      "$dump_name canonical dump script failed validation."
  fi
  dump_recovery_state="$dump_container_runtime/container-recovery.json"
  {
    printf '%s\n' \
      "$dump_container_token" "$dump_container_name" "$dump_container_cidfile" \
      "$dump_container_operation" "$postgres_image_id" "$docker_socket" \
      "$docker_socket_device" "$docker_socket_inode" "$docker_socket_owner_uid" \
      "$docker_socket_owner_mode" "$dump_script" "$database_passfile" \
      "$ssl_root_cert_file" "$capture_id" "$$"
  } | "$node_bin" -e '
const { readFileSync, writeFileSync } = require("node:fs");
const output = process.argv[1];
const fields = readFileSync(0, "utf8").trimEnd().split("\n");
if (fields.length !== 15) process.exit(1);
const [ownershipToken, containerName, cidfile, operation, imageId,
  socketPath, socketDevice, socketInode, socketOwnerUid, socketOwnerMode,
  dumpScript, passfile, rootCert, captureId, operatorPid] = fields;
const value = {
  schemaVersion: 1,
  artifactContract: "dominion-production-capture-container-recovery/v1",
  status: "create-pending",
  ownershipToken,
  containerName,
  cidfile,
  operation,
  captureId,
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
    dumpScript: { source: dumpScript, target: "/tmp/dominion/run.sh", readOnly: true },
    passfile: { source: passfile, target: "/tmp/dominion/pgpass", readOnly: true },
    rootCert: { source: rootCert, target: "/tmp/dominion/supabase-ca.crt", readOnly: true },
  },
  operatorPid: Number(operatorPid),
};
writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
' "$dump_recovery_state" || production_backup_fail \
    "could not seal dump container recovery authority."
  chmod 600 "$dump_recovery_state"
  dump_run_status=0
  dump_container_creation_attempted=true
  "$docker_bin" run \
      --cidfile "$dump_container_cidfile" \
      --name "$dump_container_name" \
      --label "com.dominion.production-backup-capture=true" \
      --label "com.dominion.capture-id=$capture_id" \
      --label "com.dominion.ownership-token=$dump_container_token" \
      --label "com.dominion.operation=$dump_container_operation" \
      --pull never \
      --network bridge \
      --log-driver none \
      --read-only \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --user "$(id -u):$(id -g)" \
      --tmpfs "/tmp:rw,nosuid,nodev,noexec,mode=0700" \
      --mount "type=bind,source=$dump_script,target=/tmp/dominion/run.sh,readonly" \
      --mount "type=bind,source=$database_passfile,target=/tmp/dominion/pgpass,readonly" \
      --mount "type=bind,source=$ssl_root_cert_file,target=/tmp/dominion/supabase-ca.crt,readonly" \
      --env "PGPASSFILE=/tmp/dominion/pgpass" \
      --env "PGSSLMODE=verify-full" \
      --env "PGSSLROOTCERT=/tmp/dominion/supabase-ca.crt" \
      --env "PGCONNECT_TIMEOUT=15" \
      --entrypoint bash \
      "$postgres_image_id" \
      /tmp/dominion/run.sh \
      >"$dump_partial" 2>"$dump_log" || dump_run_status=$?
  adopt_owned_dump_container \
    || production_backup_fail "dump container identity could not be adopted for cleanup."
  remove_owned_dump_container \
    || production_backup_fail "dump container cleanup or overlay verification failed."
  if [[ "$dump_run_status" != "0" ]]; then
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
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_verify_encrypted_destination \
  "$destination" "$encrypted_volume_attestation" \
  "$encrypted_volume_attestation_sha256" "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" \
  "$operator_pack_clean_environment_launcher" \
  "$operator_pack_clean_environment_launcher_sha256" \
  "$operator_runtime" "$macos_tcb_attestation" \
  "$macos_tcb_attestation_sha256"

captured_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
"$node_bin" "$script_directory/production-backup-artifacts.mjs" \
  write-capture-metadata \
  --output "$capture_directory/capture.json" \
  --capture-id "$capture_id" \
  --writer-quiesced-at "$writer_quiesced_at" \
  --capture-started-at "$capture_started_at" \
  --captured-at "$captured_at" \
  --project-ref "$project_ref" \
  --database-host "$database_host" \
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root" \
  --encrypted-volume-attestation-sha256 "$encrypted_volume_attestation_sha256" \
  --git-branch "$expected_branch" \
  --git-commit "$expected_commit" \
  --cli-sha256 "$supabase_cli_sha256" \
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
  --ssl-root-cert-sha256 "$ssl_root_cert_file_sha256" \
  --ssl-root-cert-relative-path "$ssl_root_cert_relative_path" \
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
    --docker-shared-home-root "$docker_shared_home_root" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    "$@"
}
staged_backup_manifest_sha256="$(
  verify_capture_evidence --allow-incomplete-marker true
)"
rm "$capture_failure_marker"
sealed_capture_content_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    seal-evidence --directory "$capture_directory" --kind capture
)"
production_backup_require_hash \
  "$sealed_capture_content_sha256" "sealed capture content SHA-256"
backup_manifest_sha256="$(verify_capture_evidence)"
[[ "$backup_manifest_sha256" == "$staged_backup_manifest_sha256" ]] \
  || production_backup_fail "staged and completed backup evidence digests differ."

case "$operator_runtime" in
  "$destination"/private/dominion-production-capture.*)
    rm -rf -- "$operator_runtime"
    ;;
  *) production_backup_fail "refused unsafe capture-runtime cleanup." ;;
esac
[[ ! -e "$operator_runtime" ]] || production_backup_fail \
  "private capture runtime still exists after successful cleanup."
capture_complete=true
trap - EXIT
unset database_url
echo "Production backup capture completed inside the encrypted destination."
echo "CAPTURE_DIRECTORY=$capture_directory"
echo "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256"
echo "CAPTURE_TOOLSET_SHA256=$capture_toolset_sha256"
echo "APPROVED_TOOL_MANIFEST_SHA256=$approved_tool_manifest_sha256"
