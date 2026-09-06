#!/usr/bin/env bash
set -euo pipefail
set +x

[[ "${DOMINION_CLEAN_ENV_LAUNCHER:-}" == "dominion-production-operator/v1" ]] || {
  echo "Production reconciliation preflight: invoke through the reviewed clean-environment launcher." >&2
  exit 64
}
ulimit -c 0

# This is deliberately a non-hosted, non-authorizing approval-record builder.
# It consumes already-captured backup and restore evidence plus a read-only
# reconciliation stage/history snapshot. It never accepts a database URL and
# never invokes Supabase, Docker, or psql directly. The checked-in hosted
# entrypoint derives its own current time and live target history immediately
# before apply; this record alone is never authorization to mutate. Keep this
# helper compatible with the macOS-provided Bash 3.2.

umask 077

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
common_helper="$script_directory/production-backup-common.sh"
# shellcheck source=production-backup-common.sh
source "$common_helper"
production_backup_require_clean_environment "$script_directory" preflight
default_evidence_verifier="$script_directory/verify-production-backup-evidence.sh"
artifact_verifier="$script_directory/production-backup-artifacts.mjs"
reconciliation_artifact_helper="$script_directory/production-reconciliation-artifacts.mjs"
stage_verifier="$script_directory/prepare-reconciliation-stage.mjs"
history_verifier="$script_directory/verify-reconciliation-history.mjs"
preflight_schema="77-dominion-production-reconciliation-preflight/v2"
maximum_allowed_capture_age_seconds=3600

fail() {
  echo "Production reconciliation preflight: $1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: verify-production-reconciliation-preflight.sh
  --destination <absolute-mounted-encrypted-directory>
  --capture-id <safe-id> --restore-id <lowercase-hyphen-id>
  --project-ref <20-char-ref>
  --database-host <exact-dashboard-supavisor-host>
  --ssl-root-cert-sha256 <64hex>
  --expected-branch main --expected-commit <40hex>
  --supabase-cli <absolute-executable> --supabase-cli-sha256 <64hex>
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141
  --postgres-image-id sha256:<64hex>
  --encrypted-volume-attestation <absolute-private-json-inside-destination>
  --encrypted-volume-attestation-sha256 <64hex>
  --encrypted-volume-check-hook <absolute-executable>
  --encrypted-volume-check-hook-sha256 <64hex>
  --edge-functions-inventory-hook <absolute-executable>
  --edge-functions-inventory-hook-sha256 <64hex>
  --storage-inventory-hook <absolute-executable>
  --storage-inventory-hook-sha256 <64hex>
  --source-manifest-hook <absolute-executable>
  --source-manifest-hook-sha256 <64hex>
  --source-fingerprint-hook <absolute-executable>
  --source-fingerprint-hook-sha256 <64hex>
  --relation-counts-hook <absolute-executable>
  --relation-counts-hook-sha256 <64hex>
  --migration-history-hook <absolute-executable>
  --migration-history-hook-sha256 <64hex>
  --managed-application-ddl-hook <absolute-executable>
  --managed-application-ddl-hook-sha256 <64hex>
  --credential-validator-sha256 <64hex>
  --dump-script-transformer-sha256 <64hex>
  --docker-bin <absolute-executable> --docker-bin-sha256 <64hex>
  --docker-socket <absolute-canonical-unix-socket>
  --docker-socket-device <decimal> --docker-socket-inode <decimal>
  --docker-socket-owner-uid <decimal> --docker-socket-owner-mode 384
  --docker-shared-home-root <absolute-canonical-owner-directory>
  --operator-pack-clean-environment-launcher <absolute-executable>
  --macos-tcb-attestation <absolute-private-json-inside-destination>
  --macos-tcb-attestation-sha256 <64hex>
  --release-repository <absolute-canonical-clean-main-worktree>
  --offline-pgsodium-getkey <absolute-executable>
  --offline-pgsodium-getkey-sha256 <64hex>
  --restore-verification-hook <absolute-executable>
  --restore-verification-hook-sha256 <64hex>
  --approved-tool-manifest <absolute-regular-non-symlink-json>
  --approved-tool-manifest-sha256 <64hex>
  --expected-backup-manifest-sha256 <64hex>
  --expected-restore-evidence-manifest-sha256 <64hex>
  --expected-source-manifest-sha256 <64hex>
  --expected-source-fingerprint-sha256 <64hex>
  --expected-relation-sequence-counts-sha256 <64hex>
  --expected-migration-history-sha256 <64hex>
  --expected-managed-application-ddl-sha256 <64hex>
  --expected-capture-toolset-sha256 <64hex>
  --expected-restore-toolset-sha256 <64hex>
  --expected-migration-history-state <absent|present>
  --writer-quiesced-at <RFC3339-UTC-second>
  --max-capture-age-seconds <1-3600>
  --release-commit <40hex> --through-version <14-digits>
  --rehearsal-evidence-directory <absolute-sealed-evidence-directory>
  --expected-rehearsal-evidence-manifest-sha256 <64hex>
  --reconciliation-stage <absolute-immutable-stage-directory>
  --expected-reconciliation-stage-manifest-sha256 <64hex>
  --before-migration-history <absolute-pinned-cli-output-file>
  --expected-before-migration-history-sha256 <64hex>

For deterministic tests only, PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN may
replace the checked-in evidence verifier when accompanied by its exact
PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256.
The clock can be replaced only when that verifier override is active and
PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE is exactly offline-fixture-only;
the test clock executable and its SHA-256 are then required.

This command emits an offline approval record. It never authorizes or performs
a hosted migration; run-production-reconciliation-step.sh obtains its own live
clock and authoritative pre-apply history at the mutation boundary.
USAGE
  exit 64
}

sha256_file() {
  local filename="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$filename" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$filename" | awk '{print $1}'
  else
    fail "shasum or sha256sum is required."
  fi
}

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    fail "shasum or sha256sum is required."
  fi
}

require_hash() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$2 must be exactly 64 lowercase hexadecimal characters."
}

require_commit() {
  [[ "$1" =~ ^[a-f0-9]{40}$ ]] \
    || fail "$2 must be an exact lowercase 40-character Git SHA."
}

require_rfc3339_utc_second() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "$2 must be an RFC3339 UTC timestamp at whole-second precision."
}

require_absolute_path() {
  case "$1" in
    /*) ;;
    *) fail "$2 must be an absolute path." ;;
  esac
  case "$1" in
    *[[:cntrl:]]*) fail "$2 cannot contain control characters." ;;
  esac
}

require_regular_file() {
  require_absolute_path "$1" "$2"
  [[ -f "$1" && ! -L "$1" ]] \
    || fail "$2 must be a regular, non-symlink file."
}

require_executable() {
  require_regular_file "$1" "$2"
  [[ -x "$1" ]] || fail "$2 must be executable."
}

canonical_file() {
  local filename="$1"
  local parent
  parent="$(cd "$(dirname "$filename")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename "$filename")"
}

canonical_directory() {
  require_absolute_path "$1" "$2"
  [[ -d "$1" && ! -L "$1" ]] \
    || fail "$2 must be a real, non-symlink directory."
  (cd "$1" && pwd -P)
}

seen_options="|"
record_option() {
  local option="$1"
  case "$seen_options" in
    *"|$option|"*) fail "$option may be supplied only once." ;;
  esac
  seen_options="${seen_options}${option}|"
}

require_option() {
  case "$seen_options" in
    *"|$1|"*) ;;
    *) fail "$1 is required." ;;
  esac
}

destination=""
capture_id=""
restore_id=""
project_ref=""
database_host=""
ssl_root_cert_sha256=""
expected_branch=""
expected_commit=""
supabase_cli=""
supabase_cli_sha256=""
postgres_image=""
postgres_image_id=""
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
credential_validator_sha256=""
dump_script_transformer_sha256=""
docker_bin=""
docker_bin_sha256=""
docker_socket=""
docker_socket_device=""
docker_socket_inode=""
docker_socket_owner_uid=""
docker_socket_owner_mode=""
docker_shared_home_root=""
operator_pack_clean_environment_launcher=""
macos_tcb_attestation=""
macos_tcb_attestation_sha256=""
release_repository=""
offline_pgsodium_getkey=""
offline_pgsodium_getkey_sha256=""
restore_verification_hook=""
restore_verification_hook_sha256=""
approved_tool_manifest=""
approved_tool_manifest_sha256=""
expected_backup_manifest_sha256=""
expected_restore_evidence_manifest_sha256=""
expected_source_manifest_sha256=""
expected_source_fingerprint_sha256=""
expected_relation_sequence_counts_sha256=""
expected_migration_history_sha256=""
expected_managed_application_ddl_sha256=""
expected_capture_toolset_sha256=""
expected_restore_toolset_sha256=""
expected_migration_history_state=""
writer_quiesced_at=""
max_capture_age_seconds=""
release_commit=""
through_version=""
rehearsal_evidence_directory=""
expected_rehearsal_evidence_manifest_sha256=""
reconciliation_stage=""
expected_reconciliation_stage_manifest_sha256=""
before_migration_history=""
expected_before_migration_history_sha256=""

if [[ "${1:-}" == "--" ]]; then
  shift
fi

while (( $# > 0 )); do
  option="$1"
  (( $# >= 2 )) || usage
  value="$2"
  [[ -n "$value" && "$value" != --* ]] || usage
  record_option "$option"
  case "$option" in
    --destination) destination="$value" ;;
    --capture-id) capture_id="$value" ;;
    --restore-id) restore_id="$value" ;;
    --project-ref) project_ref="$value" ;;
    --database-host) database_host="$value" ;;
    --ssl-root-cert-sha256) ssl_root_cert_sha256="$value" ;;
    --expected-branch) expected_branch="$value" ;;
    --expected-commit) expected_commit="$value" ;;
    --supabase-cli) supabase_cli="$value" ;;
    --supabase-cli-sha256) supabase_cli_sha256="$value" ;;
    --postgres-image) postgres_image="$value" ;;
    --postgres-image-id) postgres_image_id="$value" ;;
    --encrypted-volume-attestation) encrypted_volume_attestation="$value" ;;
    --encrypted-volume-attestation-sha256) encrypted_volume_attestation_sha256="$value" ;;
    --encrypted-volume-check-hook) encrypted_volume_check_hook="$value" ;;
    --encrypted-volume-check-hook-sha256) encrypted_volume_check_hook_sha256="$value" ;;
    --edge-functions-inventory-hook) edge_functions_inventory_hook="$value" ;;
    --edge-functions-inventory-hook-sha256) edge_functions_inventory_hook_sha256="$value" ;;
    --storage-inventory-hook) storage_inventory_hook="$value" ;;
    --storage-inventory-hook-sha256) storage_inventory_hook_sha256="$value" ;;
    --source-manifest-hook) source_manifest_hook="$value" ;;
    --source-manifest-hook-sha256) source_manifest_hook_sha256="$value" ;;
    --source-fingerprint-hook) source_fingerprint_hook="$value" ;;
    --source-fingerprint-hook-sha256) source_fingerprint_hook_sha256="$value" ;;
    --relation-counts-hook) relation_counts_hook="$value" ;;
    --relation-counts-hook-sha256) relation_counts_hook_sha256="$value" ;;
    --migration-history-hook) migration_history_hook="$value" ;;
    --migration-history-hook-sha256) migration_history_hook_sha256="$value" ;;
    --managed-application-ddl-hook) managed_application_ddl_hook="$value" ;;
    --managed-application-ddl-hook-sha256) managed_application_ddl_hook_sha256="$value" ;;
    --credential-validator-sha256) credential_validator_sha256="$value" ;;
    --dump-script-transformer-sha256) dump_script_transformer_sha256="$value" ;;
    --docker-bin) docker_bin="$value" ;;
    --docker-bin-sha256) docker_bin_sha256="$value" ;;
    --docker-socket) docker_socket="$value" ;;
    --docker-socket-device) docker_socket_device="$value" ;;
    --docker-socket-inode) docker_socket_inode="$value" ;;
    --docker-socket-owner-uid) docker_socket_owner_uid="$value" ;;
    --docker-socket-owner-mode) docker_socket_owner_mode="$value" ;;
    --docker-shared-home-root) docker_shared_home_root="$value" ;;
    --operator-pack-clean-environment-launcher) operator_pack_clean_environment_launcher="$value" ;;
    --macos-tcb-attestation) macos_tcb_attestation="$value" ;;
    --macos-tcb-attestation-sha256) macos_tcb_attestation_sha256="$value" ;;
    --release-repository) release_repository="$value" ;;
    --offline-pgsodium-getkey) offline_pgsodium_getkey="$value" ;;
    --offline-pgsodium-getkey-sha256) offline_pgsodium_getkey_sha256="$value" ;;
    --restore-verification-hook) restore_verification_hook="$value" ;;
    --restore-verification-hook-sha256) restore_verification_hook_sha256="$value" ;;
    --approved-tool-manifest) approved_tool_manifest="$value" ;;
    --approved-tool-manifest-sha256) approved_tool_manifest_sha256="$value" ;;
    --expected-backup-manifest-sha256) expected_backup_manifest_sha256="$value" ;;
    --expected-restore-evidence-manifest-sha256) expected_restore_evidence_manifest_sha256="$value" ;;
    --expected-source-manifest-sha256) expected_source_manifest_sha256="$value" ;;
    --expected-source-fingerprint-sha256) expected_source_fingerprint_sha256="$value" ;;
    --expected-relation-sequence-counts-sha256) expected_relation_sequence_counts_sha256="$value" ;;
    --expected-migration-history-sha256) expected_migration_history_sha256="$value" ;;
    --expected-managed-application-ddl-sha256) expected_managed_application_ddl_sha256="$value" ;;
    --expected-capture-toolset-sha256) expected_capture_toolset_sha256="$value" ;;
    --expected-restore-toolset-sha256) expected_restore_toolset_sha256="$value" ;;
    --expected-migration-history-state) expected_migration_history_state="$value" ;;
    --writer-quiesced-at) writer_quiesced_at="$value" ;;
    --max-capture-age-seconds) max_capture_age_seconds="$value" ;;
    --release-commit) release_commit="$value" ;;
    --through-version) through_version="$value" ;;
    --rehearsal-evidence-directory) rehearsal_evidence_directory="$value" ;;
    --expected-rehearsal-evidence-manifest-sha256) expected_rehearsal_evidence_manifest_sha256="$value" ;;
    --reconciliation-stage) reconciliation_stage="$value" ;;
    --expected-reconciliation-stage-manifest-sha256) expected_reconciliation_stage_manifest_sha256="$value" ;;
    --before-migration-history) before_migration_history="$value" ;;
    --expected-before-migration-history-sha256) expected_before_migration_history_sha256="$value" ;;
    *) usage ;;
  esac
  shift 2
done

for required in \
  --destination \
  --capture-id \
  --restore-id \
  --project-ref \
  --database-host \
  --ssl-root-cert-sha256 \
  --expected-branch \
  --expected-commit \
  --supabase-cli \
  --supabase-cli-sha256 \
  --postgres-image \
  --postgres-image-id \
  --encrypted-volume-attestation \
  --encrypted-volume-attestation-sha256 \
  --encrypted-volume-check-hook \
  --encrypted-volume-check-hook-sha256 \
  --edge-functions-inventory-hook \
  --edge-functions-inventory-hook-sha256 \
  --storage-inventory-hook \
  --storage-inventory-hook-sha256 \
  --source-manifest-hook \
  --source-manifest-hook-sha256 \
  --source-fingerprint-hook \
  --source-fingerprint-hook-sha256 \
  --relation-counts-hook \
  --relation-counts-hook-sha256 \
  --migration-history-hook \
  --migration-history-hook-sha256 \
  --managed-application-ddl-hook \
  --managed-application-ddl-hook-sha256 \
  --credential-validator-sha256 \
  --dump-script-transformer-sha256 \
  --docker-bin \
  --docker-bin-sha256 \
  --docker-socket \
  --docker-socket-device \
  --docker-socket-inode \
  --docker-socket-owner-uid \
  --docker-socket-owner-mode \
  --docker-shared-home-root \
  --operator-pack-clean-environment-launcher \
  --macos-tcb-attestation \
  --macos-tcb-attestation-sha256 \
  --release-repository \
  --offline-pgsodium-getkey \
  --offline-pgsodium-getkey-sha256 \
  --restore-verification-hook \
  --restore-verification-hook-sha256 \
  --approved-tool-manifest \
  --approved-tool-manifest-sha256 \
  --expected-backup-manifest-sha256 \
  --expected-restore-evidence-manifest-sha256 \
  --expected-source-manifest-sha256 \
  --expected-source-fingerprint-sha256 \
  --expected-relation-sequence-counts-sha256 \
  --expected-migration-history-sha256 \
  --expected-managed-application-ddl-sha256 \
  --expected-capture-toolset-sha256 \
  --expected-restore-toolset-sha256 \
  --expected-migration-history-state \
  --writer-quiesced-at \
  --max-capture-age-seconds \
  --release-commit \
  --through-version \
  --rehearsal-evidence-directory \
  --expected-rehearsal-evidence-manifest-sha256 \
  --reconciliation-stage \
  --expected-reconciliation-stage-manifest-sha256 \
  --before-migration-history \
  --expected-before-migration-history-sha256; do
  require_option "$required"
done

[[ "$expected_branch" == "main" ]] \
  || fail "--expected-branch must be exactly main for a production reconciliation."
require_commit "$expected_commit" "--expected-commit"
require_commit "$release_commit" "--release-commit"
[[ "$database_host" =~ ^[a-z0-9-]+\.pooler\.supabase\.com$ ]] \
  || fail "--database-host must be the exact dashboard Supavisor hostname."
[[ "$release_commit" == "$expected_commit" ]] \
  || fail "--release-commit must equal the evidence --expected-commit."
[[ "$through_version" =~ ^[0-9]{14}$ ]] \
  || fail "--through-version must be exactly 14 digits."
[[ "$postgres_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "--postgres-image-id must be sha256 plus 64 lowercase hexadecimal characters."
case "$expected_migration_history_state" in
  absent|present) ;;
  *) fail "--expected-migration-history-state must be absent or present." ;;
esac
[[ "$max_capture_age_seconds" =~ ^[1-9][0-9]*$ ]] \
  || fail "--max-capture-age-seconds must be a positive integer."
(( max_capture_age_seconds <= maximum_allowed_capture_age_seconds )) \
  || fail "--max-capture-age-seconds cannot exceed $maximum_allowed_capture_age_seconds."
require_rfc3339_utc_second "$writer_quiesced_at" "--writer-quiesced-at"

for hash_and_label in \
  "$supabase_cli_sha256|--supabase-cli-sha256" \
  "$ssl_root_cert_sha256|--ssl-root-cert-sha256" \
  "$encrypted_volume_attestation_sha256|--encrypted-volume-attestation-sha256" \
  "$encrypted_volume_check_hook_sha256|--encrypted-volume-check-hook-sha256" \
  "$edge_functions_inventory_hook_sha256|--edge-functions-inventory-hook-sha256" \
  "$storage_inventory_hook_sha256|--storage-inventory-hook-sha256" \
  "$source_manifest_hook_sha256|--source-manifest-hook-sha256" \
  "$source_fingerprint_hook_sha256|--source-fingerprint-hook-sha256" \
  "$relation_counts_hook_sha256|--relation-counts-hook-sha256" \
  "$migration_history_hook_sha256|--migration-history-hook-sha256" \
  "$managed_application_ddl_hook_sha256|--managed-application-ddl-hook-sha256" \
  "$credential_validator_sha256|--credential-validator-sha256" \
  "$dump_script_transformer_sha256|--dump-script-transformer-sha256" \
  "$docker_bin_sha256|--docker-bin-sha256" \
  "$macos_tcb_attestation_sha256|--macos-tcb-attestation-sha256" \
  "$offline_pgsodium_getkey_sha256|--offline-pgsodium-getkey-sha256" \
  "$restore_verification_hook_sha256|--restore-verification-hook-sha256" \
  "$approved_tool_manifest_sha256|--approved-tool-manifest-sha256" \
  "$expected_backup_manifest_sha256|--expected-backup-manifest-sha256" \
  "$expected_restore_evidence_manifest_sha256|--expected-restore-evidence-manifest-sha256" \
  "$expected_source_manifest_sha256|--expected-source-manifest-sha256" \
  "$expected_source_fingerprint_sha256|--expected-source-fingerprint-sha256" \
  "$expected_relation_sequence_counts_sha256|--expected-relation-sequence-counts-sha256" \
  "$expected_migration_history_sha256|--expected-migration-history-sha256" \
  "$expected_managed_application_ddl_sha256|--expected-managed-application-ddl-sha256" \
  "$expected_capture_toolset_sha256|--expected-capture-toolset-sha256" \
  "$expected_restore_toolset_sha256|--expected-restore-toolset-sha256" \
  "$expected_rehearsal_evidence_manifest_sha256|--expected-rehearsal-evidence-manifest-sha256" \
  "$expected_reconciliation_stage_manifest_sha256|--expected-reconciliation-stage-manifest-sha256" \
  "$expected_before_migration_history_sha256|--expected-before-migration-history-sha256"; do
  require_hash "${hash_and_label%%|*}" "${hash_and_label#*|}"
done

node_bin="$NODE_BIN"
production_backup_hashed_executable "$node_bin" "$NODE_BIN_SHA256" "Node binary"
[[ "${DOMINION_MACOS_TCB_ATTESTATION_SHA256:-}" == "$macos_tcb_attestation_sha256" ]] \
  || fail "clean-launcher macOS TCB identity does not match this preflight."
production_backup_require_local_docker_context \
  "$docker_bin" "$docker_socket" "$docker_socket_device" \
  "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"
production_backup_hashed_executable \
  "$offline_pgsodium_getkey" "$offline_pgsodium_getkey_sha256" \
  "offline pgsodium getkey helper"
require_regular_file "$stage_verifier" "reconciliation stage verifier"
require_regular_file "$history_verifier" "reconciliation history verifier"
require_regular_file "$artifact_verifier" "production backup artifact verifier"
require_regular_file "$reconciliation_artifact_helper" "production reconciliation artifact helper"
stage_verifier_sha256="$(sha256_file "$stage_verifier")"
history_verifier_sha256="$(sha256_file "$history_verifier")"
artifact_verifier_sha256="$(sha256_file "$artifact_verifier")"
reconciliation_artifact_helper_sha256="$(sha256_file "$reconciliation_artifact_helper")"

if [[ -n "${PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN:-}" ]]; then
  [[ "${PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE:-}" \
      == "offline-fixture-only" \
    && -n "${PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_BIN:-}" \
    && -n "${PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256:-}" ]] \
    || fail "an evidence-verifier override requires PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE=offline-fixture-only and the complete hashed test clock boundary."
  evidence_verifier="$PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN"
  require_executable "$evidence_verifier" "override evidence verifier"
  override_evidence_verifier_sha256="${PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256:-}"
  require_hash "$override_evidence_verifier_sha256" \
    "PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256"
  evidence_verifier_sha256="$(sha256_file "$evidence_verifier")"
  [[ "$evidence_verifier_sha256" == "$override_evidence_verifier_sha256" ]] \
    || fail "override evidence verifier SHA-256 does not match."
else
  [[ -z "${PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256:-}" ]] \
    || fail "PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256 requires PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN."
  evidence_verifier="$default_evidence_verifier"
  require_executable "$evidence_verifier" "checked-in evidence verifier"
  [[ "$evidence_verifier" == "$script_directory/verify-production-backup-evidence.sh" ]] \
    || fail "the production evidence verifier must be the exact checked-in helper."
  evidence_verifier_sha256="$(sha256_file "$evidence_verifier")"
fi

test_clock_mode="${PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE:-}"
test_clock_bin="${PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_BIN:-}"
test_clock_sha256="${PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256:-}"
if [[ -n "$test_clock_mode" || -n "$test_clock_bin" || -n "$test_clock_sha256" ]]; then
  [[ "$test_clock_mode" == "offline-fixture-only" ]] \
    || fail "test clock requires PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE=offline-fixture-only."
  [[ -n "${PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN:-}" ]] \
    || fail "test clock is forbidden with the production evidence verifier."
  require_executable "$test_clock_bin" "test-only preflight clock"
  require_hash "$test_clock_sha256" \
    "PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256"
  clock_sha256="$(sha256_file "$test_clock_bin")"
  [[ "$clock_sha256" == "$test_clock_sha256" ]] \
    || fail "test-only preflight clock SHA-256 does not match."
  current_time="$($test_clock_bin)" \
    || fail "test-only preflight clock failed."
  clock_source="test-only-hashed-override"
  preflight_identity_key="TEST_ONLY_RECONCILIATION_PREFLIGHT_SHA256"
else
  system_date_bin="/bin/date"
  require_executable "$system_date_bin" "system UTC clock"
  clock_sha256="$(sha256_file "$system_date_bin")"
  current_time="$($system_date_bin -u '+%Y-%m-%dT%H:%M:%SZ')" \
    || fail "could not derive the current UTC time."
  clock_source="system-utc"
  preflight_identity_key="PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256"
fi
require_rfc3339_utc_second "$current_time" "derived current UTC time"

destination="$(canonical_directory "$destination" "encrypted destination")"
docker_shared_home_root="$(
  canonical_directory "$docker_shared_home_root" "Docker-shared home root"
)"
production_backup_require_owned_directory \
  "$docker_shared_home_root" "Docker-shared home root"
production_backup_require_private_directory "$destination" "encrypted destination"
case "$destination/" in
  "$docker_shared_home_root/"*) ;;
  *) fail "encrypted destination must be contained by the Docker-shared home root." ;;
esac
release_repository="$(canonical_directory "$release_repository" "release repository")"
[[ "$release_repository" == "$repository_root" ]] \
  || fail "release repository does not match the preflight implementation repository."
case "$release_repository/" in
  "$docker_shared_home_root/"*) ;;
  *) fail "release repository must be contained by the Docker-shared home root." ;;
esac
production_backup_private_file "$macos_tcb_attestation" "macOS TCB attestation"
macos_tcb_attestation="$(canonical_file "$macos_tcb_attestation")"
[[ "$(sha256_file "$macos_tcb_attestation")" == "$macos_tcb_attestation_sha256" ]] \
  || fail "macOS TCB attestation SHA-256 does not match."
case "$macos_tcb_attestation" in
  "$destination"/*) ;;
  *) fail "macOS TCB attestation must be inside the encrypted destination." ;;
esac
reconciliation_stage="$(canonical_directory "$reconciliation_stage" "reconciliation stage")"
rehearsal_evidence_directory="$(canonical_directory \
  "$rehearsal_evidence_directory" "sealed rehearsal evidence")"
case "$rehearsal_evidence_directory" in
  "$destination"/*) ;;
  *) fail "sealed rehearsal evidence must be contained by the encrypted destination." ;;
esac
require_regular_file "$approved_tool_manifest" "approved tool manifest"
approved_tool_manifest="$(canonical_file "$approved_tool_manifest")"
actual_approved_tool_manifest_sha256="$(sha256_file "$approved_tool_manifest")"
[[ "$actual_approved_tool_manifest_sha256" == "$approved_tool_manifest_sha256" ]] \
  || fail "approved tool manifest SHA-256 does not match the approved value."
if ! "$node_bin" "$artifact_verifier" \
  verify-approved-tool-manifest \
  --file "$approved_tool_manifest" \
  --file-sha256 "$approved_tool_manifest_sha256" \
  --release-commit "$release_commit" \
  --capture-toolset-sha256 "$expected_capture_toolset_sha256" \
  --restore-toolset-sha256 "$expected_restore_toolset_sha256" \
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root" \
  >/dev/null; then
  fail "approved tool manifest contract verification failed."
fi
capture_operator_pack_launcher_sha256="$(
  "$node_bin" "$artifact_verifier" approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$release_commit" \
    --toolset capture \
    --name operatorPackCleanEnvironmentLauncherSha256
)"
restore_operator_pack_launcher_sha256="$(
  "$node_bin" "$artifact_verifier" approved-tool-hash \
    --file "$approved_tool_manifest" \
    --file-sha256 "$approved_tool_manifest_sha256" \
    --release-commit "$release_commit" \
    --toolset restore \
    --name operatorPackCleanEnvironmentLauncherSha256
)"
[[ "$capture_operator_pack_launcher_sha256" \
  == "$restore_operator_pack_launcher_sha256" ]] || fail \
  "approved capture and restore toolsets disagree on the operator-pack launcher."
production_backup_hashed_executable \
  "$operator_pack_clean_environment_launcher" \
  "$capture_operator_pack_launcher_sha256" \
  "operator-pack clean-environment launcher"
require_regular_file "$before_migration_history" "before migration-history snapshot"
before_migration_history="$(canonical_file "$before_migration_history")"
stage_manifest="$reconciliation_stage/reconciliation-stage.json"
require_regular_file "$stage_manifest" "reconciliation stage manifest"

temporary_directory="$(mktemp -d /tmp/dominion-production-reconciliation-preflight.XXXXXX)"
case "$temporary_directory" in
  /tmp/dominion-production-reconciliation-preflight.*) ;;
  *) fail "mktemp returned an unsafe temporary directory." ;;
esac
verifier_stdout="$temporary_directory/evidence-verifier.stdout"

cleanup() {
  local exit_status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "${temporary_directory:-}" ]]; then
    case "$temporary_directory" in
      /tmp/dominion-production-reconciliation-preflight.*)
        rm -rf "$temporary_directory" || exit 1
        ;;
      *)
        echo "Production reconciliation preflight: refused unsafe temporary cleanup." >&2
        exit 1
        ;;
    esac
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rehearsal_stdout="$temporary_directory/rehearsal-evidence.stdout"
if ! "$node_bin" "$reconciliation_artifact_helper" verify-rehearsal-evidence \
  --directory "$rehearsal_evidence_directory" \
  --expected-sha256 "$expected_rehearsal_evidence_manifest_sha256" \
  >"$rehearsal_stdout"; then
  fail "sealed offline rehearsal evidence verification failed."
fi
rehearsal_line_number=0
while IFS= read -r rehearsal_line || [[ -n "$rehearsal_line" ]]; do
  rehearsal_line_number=$((rehearsal_line_number + 1))
  case "$rehearsal_line_number" in
    1) rehearsal_key="REHEARSAL_EVIDENCE_MANIFEST_SHA256" ;;
    2) rehearsal_key="PROJECT_REF" ;;
    3) rehearsal_key="EXPECTED_BRANCH" ;;
    4) rehearsal_key="RELEASE_COMMIT" ;;
    5) rehearsal_key="THROUGH_VERSION" ;;
    6) rehearsal_key="STAGE_NUMBER" ;;
    7) rehearsal_key="CAPTURE_ID" ;;
    8) rehearsal_key="RESTORE_ID" ;;
    9) rehearsal_key="PRE_STATE_SHA256" ;;
    10) rehearsal_key="POST_STATE_SHA256" ;;
    11) rehearsal_key="DOCKER_SHARED_HOME_ROOT" ;;
    12) rehearsal_key="MACOS_TCB_ATTESTATION_SHA256" ;;
    13) rehearsal_key="RELEASE_REPOSITORY" ;;
    *) fail "rehearsal evidence verifier emitted extra stdout." ;;
  esac
  case "$rehearsal_line" in
    "$rehearsal_key="*) rehearsal_value="${rehearsal_line#*=}" ;;
    *) fail "rehearsal evidence verifier line $rehearsal_line_number is invalid." ;;
  esac
  [[ -n "$rehearsal_value" ]] || fail "rehearsal evidence verifier emitted an empty value."
  case "$rehearsal_key" in
    REHEARSAL_EVIDENCE_MANIFEST_SHA256) rehearsal_evidence_manifest_sha256="$rehearsal_value" ;;
    PROJECT_REF) rehearsal_project_ref="$rehearsal_value" ;;
    EXPECTED_BRANCH) rehearsal_expected_branch="$rehearsal_value" ;;
    RELEASE_COMMIT) rehearsal_release_commit="$rehearsal_value" ;;
    THROUGH_VERSION) rehearsal_through_version="$rehearsal_value" ;;
    STAGE_NUMBER) rehearsal_stage_number="$rehearsal_value" ;;
    CAPTURE_ID) rehearsal_capture_id="$rehearsal_value" ;;
    RESTORE_ID) rehearsal_restore_id="$rehearsal_value" ;;
    PRE_STATE_SHA256) rehearsal_pre_state_sha256="$rehearsal_value" ;;
    POST_STATE_SHA256) rehearsal_post_state_sha256="$rehearsal_value" ;;
    DOCKER_SHARED_HOME_ROOT) rehearsal_docker_shared_home_root="$rehearsal_value" ;;
    MACOS_TCB_ATTESTATION_SHA256) rehearsal_macos_tcb_attestation_sha256="$rehearsal_value" ;;
    RELEASE_REPOSITORY) rehearsal_release_repository="$rehearsal_value" ;;
  esac
done <"$rehearsal_stdout"
[[ "$rehearsal_line_number" == "13" ]] \
  || fail "rehearsal evidence verifier output is incomplete."
require_hash "$rehearsal_evidence_manifest_sha256" "rehearsal evidence manifest SHA-256"
require_hash "$rehearsal_pre_state_sha256" "rehearsal pre-state SHA-256"
require_hash "$rehearsal_post_state_sha256" "rehearsal post-state SHA-256"
[[ "$rehearsal_evidence_manifest_sha256" == "$expected_rehearsal_evidence_manifest_sha256" \
  && "$rehearsal_project_ref" == "$project_ref" \
  && "$rehearsal_expected_branch" == "$expected_branch" \
  && "$rehearsal_release_commit" == "$release_commit" \
  && "$rehearsal_through_version" == "$through_version" \
  && "$rehearsal_capture_id" == "$capture_id" \
  && "$rehearsal_restore_id" == "$restore_id" \
  && "$rehearsal_docker_shared_home_root" == "$docker_shared_home_root" \
  && "$rehearsal_macos_tcb_attestation_sha256" == "$macos_tcb_attestation_sha256" \
  && "$rehearsal_release_repository" == "$release_repository" ]] \
  || fail "sealed rehearsal evidence identity does not match this preflight."

evidence_verifier_arguments=(
  --destination "$destination" \
  --capture-id "$capture_id" \
  --restore-id "$restore_id" \
  --project-ref "$project_ref" \
  --expected-branch "$expected_branch" \
  --expected-commit "$expected_commit" \
  --supabase-cli "$supabase_cli" \
  --supabase-cli-sha256 "$supabase_cli_sha256" \
  --postgres-image "$postgres_image" \
  --postgres-image-id "$postgres_image_id" \
  --encrypted-volume-attestation "$encrypted_volume_attestation" \
  --encrypted-volume-attestation-sha256 "$encrypted_volume_attestation_sha256" \
  --encrypted-volume-check-hook "$encrypted_volume_check_hook" \
  --encrypted-volume-check-hook-sha256 "$encrypted_volume_check_hook_sha256" \
  --edge-functions-inventory-hook "$edge_functions_inventory_hook" \
  --edge-functions-inventory-hook-sha256 "$edge_functions_inventory_hook_sha256" \
  --storage-inventory-hook "$storage_inventory_hook" \
  --storage-inventory-hook-sha256 "$storage_inventory_hook_sha256" \
  --source-manifest-hook "$source_manifest_hook" \
  --source-manifest-hook-sha256 "$source_manifest_hook_sha256" \
  --source-fingerprint-hook "$source_fingerprint_hook" \
  --source-fingerprint-hook-sha256 "$source_fingerprint_hook_sha256" \
  --relation-counts-hook "$relation_counts_hook" \
  --relation-counts-hook-sha256 "$relation_counts_hook_sha256" \
  --migration-history-hook "$migration_history_hook" \
  --migration-history-hook-sha256 "$migration_history_hook_sha256" \
  --managed-application-ddl-hook "$managed_application_ddl_hook" \
  --managed-application-ddl-hook-sha256 "$managed_application_ddl_hook_sha256" \
  --credential-validator-sha256 "$credential_validator_sha256" \
  --dump-script-transformer-sha256 "$dump_script_transformer_sha256" \
  --docker-bin "$docker_bin" \
  --docker-bin-sha256 "$docker_bin_sha256" \
  --docker-socket "$docker_socket" \
  --docker-socket-device "$docker_socket_device" \
  --docker-socket-inode "$docker_socket_inode" \
  --docker-socket-owner-uid "$docker_socket_owner_uid" \
  --docker-socket-owner-mode "$docker_socket_owner_mode" \
  --docker-shared-home-root "$docker_shared_home_root" \
  --operator-pack-clean-environment-launcher \
    "$operator_pack_clean_environment_launcher" \
  --macos-tcb-attestation "$macos_tcb_attestation" \
  --offline-pgsodium-getkey "$offline_pgsodium_getkey" \
  --offline-pgsodium-getkey-sha256 "$offline_pgsodium_getkey_sha256" \
  --restore-verification-hook "$restore_verification_hook" \
  --restore-verification-hook-sha256 "$restore_verification_hook_sha256" \
  --approved-tool-manifest "$approved_tool_manifest" \
  --approved-tool-manifest-sha256 "$approved_tool_manifest_sha256"
)
if [[ -n "${PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN:-}" ]]; then
  if ! env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    DOMINION_CLEAN_ENV_LAUNCHER="$DOMINION_CLEAN_ENV_CONTRACT" \
    DOMINION_CLEAN_ENV_LAUNCHER_PATH="$DOMINION_CLEAN_ENV_LAUNCHER_PATH" \
    DOMINION_CLEAN_ENV_LAUNCHER_SHA256="$DOMINION_CLEAN_ENV_LAUNCHER_SHA256" \
    DOMINION_MACOS_TCB_ATTESTATION_SHA256="$macos_tcb_attestation_sha256" \
    NODE_BIN="$NODE_BIN" NODE_BIN_SHA256="$NODE_BIN_SHA256" \
    NODE_ARCHIVE="$NODE_ARCHIVE" NODE_ARCHIVE_SHA256="$NODE_ARCHIVE_SHA256" \
    "$evidence_verifier" "${evidence_verifier_arguments[@]}" \
    >"$verifier_stdout"; then
    fail "production backup evidence verification failed."
  fi
else
  if ! production_backup_run_repository_operation \
    verify-evidence "${evidence_verifier_arguments[@]}" \
    >"$verifier_stdout"; then
    fail "production backup evidence verification failed."
  fi
fi

line_number=0
parsed_value=""
while IFS= read -r evidence_line || [[ -n "$evidence_line" ]]; do
  line_number=$((line_number + 1))
  case "$line_number" in
    1) expected_key="BACKUP_MANIFEST_SHA256" ;;
    2) expected_key="RESTORE_EVIDENCE_MANIFEST_SHA256" ;;
    3) expected_key="SOURCE_MANIFEST_SHA256" ;;
    4) expected_key="SOURCE_FINGERPRINT_SHA256" ;;
    5) expected_key="RELATION_SEQUENCE_COUNTS_SHA256" ;;
    6) expected_key="MIGRATION_HISTORY_SHA256" ;;
    7) expected_key="MANAGED_APPLICATION_DDL_SHA256" ;;
    8) expected_key="CAPTURE_TOOLSET_SHA256" ;;
    9) expected_key="RESTORE_TOOLSET_SHA256" ;;
    10) expected_key="APPROVED_TOOL_MANIFEST_SHA256" ;;
    11) expected_key="MIGRATION_HISTORY_STATE" ;;
    12) expected_key="SUPABASE_CLI_SHA256" ;;
    13) expected_key="POSTGRES_IMAGE_ID" ;;
    14) expected_key="WRITER_QUIESCED_AT" ;;
    15) expected_key="CAPTURE_STARTED_AT" ;;
    16) expected_key="CAPTURED_AT" ;;
    17) expected_key="CAPTURE_DIRECTORY" ;;
    18) expected_key="RESTORE_DIRECTORY" ;;
    19) expected_key="DATABASE_HOST" ;;
    20) expected_key="SSL_ROOT_CERT_SHA256" ;;
    21) expected_key="SSL_ROOT_CERT_RELATIVE_PATH" ;;
    22) expected_key="ENCRYPTED_VOLUME_ATTESTATION_SHA256" ;;
    23) expected_key="DOCKER_SHARED_HOME_ROOT" ;;
    24) expected_key="MACOS_TCB_ATTESTATION_SHA256" ;;
    *) fail "evidence verifier emitted extra stdout." ;;
  esac
  case "$evidence_line" in
    "$expected_key="*) parsed_value="${evidence_line#*=}" ;;
    *) fail "evidence verifier stdout line $line_number must be exactly $expected_key=<value>." ;;
  esac
  [[ -n "$parsed_value" ]] \
    || fail "evidence verifier stdout line $line_number has an empty value."
  case "$line_number" in
    1) backup_manifest_sha256="$parsed_value" ;;
    2) restore_evidence_manifest_sha256="$parsed_value" ;;
    3) source_manifest_sha256="$parsed_value" ;;
    4) source_fingerprint_sha256="$parsed_value" ;;
    5) relation_sequence_counts_sha256="$parsed_value" ;;
    6) migration_history_sha256="$parsed_value" ;;
    7) managed_application_ddl_sha256="$parsed_value" ;;
    8) capture_toolset_sha256="$parsed_value" ;;
    9) restore_toolset_sha256="$parsed_value" ;;
    10) verified_approved_tool_manifest_sha256="$parsed_value" ;;
    11) migration_history_state="$parsed_value" ;;
    12) verified_supabase_cli_sha256="$parsed_value" ;;
    13) verified_postgres_image_id="$parsed_value" ;;
    14) captured_writer_quiesced_at="$parsed_value" ;;
    15) capture_started_at="$parsed_value" ;;
    16) captured_at="$parsed_value" ;;
    17) capture_directory="$parsed_value" ;;
    18) restore_directory="$parsed_value" ;;
    19) verified_database_host="$parsed_value" ;;
    20) verified_ssl_root_cert_sha256="$parsed_value" ;;
    21) verified_ssl_root_cert_relative_path="$parsed_value" ;;
    22) verified_encrypted_volume_attestation_sha256="$parsed_value" ;;
    23) verified_docker_shared_home_root="$parsed_value" ;;
    24) verified_macos_tcb_attestation_sha256="$parsed_value" ;;
  esac
done <"$verifier_stdout"
[[ "$line_number" == "24" ]] \
  || fail "evidence verifier emitted $line_number stdout lines; expected exactly 24."

for verified_hash_and_label in \
  "$backup_manifest_sha256|BACKUP_MANIFEST_SHA256" \
  "$restore_evidence_manifest_sha256|RESTORE_EVIDENCE_MANIFEST_SHA256" \
  "$source_manifest_sha256|SOURCE_MANIFEST_SHA256" \
  "$source_fingerprint_sha256|SOURCE_FINGERPRINT_SHA256" \
  "$relation_sequence_counts_sha256|RELATION_SEQUENCE_COUNTS_SHA256" \
  "$migration_history_sha256|MIGRATION_HISTORY_SHA256" \
  "$managed_application_ddl_sha256|MANAGED_APPLICATION_DDL_SHA256" \
  "$capture_toolset_sha256|CAPTURE_TOOLSET_SHA256" \
  "$restore_toolset_sha256|RESTORE_TOOLSET_SHA256" \
  "$verified_approved_tool_manifest_sha256|APPROVED_TOOL_MANIFEST_SHA256" \
  "$verified_supabase_cli_sha256|SUPABASE_CLI_SHA256"; do
  require_hash "${verified_hash_and_label%%|*}" "${verified_hash_and_label#*|}"
done
require_hash "$verified_ssl_root_cert_sha256" "SSL_ROOT_CERT_SHA256"
require_hash \
  "$verified_encrypted_volume_attestation_sha256" \
  "ENCRYPTED_VOLUME_ATTESTATION_SHA256"
require_hash "$verified_macos_tcb_attestation_sha256" "MACOS_TCB_ATTESTATION_SHA256"
[[ "$verified_database_host" == "$database_host" \
  && "$verified_ssl_root_cert_sha256" == "$ssl_root_cert_sha256" \
  && "$verified_ssl_root_cert_relative_path" \
    == "private/supabase-ca/prod-ca-2021.crt" \
  && "$verified_encrypted_volume_attestation_sha256" \
    == "$encrypted_volume_attestation_sha256" \
  && "$verified_docker_shared_home_root" == "$docker_shared_home_root" \
  && "$verified_macos_tcb_attestation_sha256" == "$macos_tcb_attestation_sha256" ]] \
  || fail "captured database, TLS, or encrypted-volume identity does not match this preflight."
[[ "$verified_postgres_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "POSTGRES_IMAGE_ID has an invalid format."
case "$migration_history_state" in
  absent|present) ;;
  *) fail "MIGRATION_HISTORY_STATE must be absent or present." ;;
esac
require_rfc3339_utc_second "$captured_writer_quiesced_at" "WRITER_QUIESCED_AT"
require_rfc3339_utc_second "$capture_started_at" "CAPTURE_STARTED_AT"
require_rfc3339_utc_second "$captured_at" "CAPTURED_AT"
require_absolute_path "$capture_directory" "CAPTURE_DIRECTORY"
require_absolute_path "$restore_directory" "RESTORE_DIRECTORY"

[[ "$backup_manifest_sha256" == "$expected_backup_manifest_sha256" ]] \
  || fail "BACKUP_MANIFEST_SHA256 does not match the approved value."
[[ "$restore_evidence_manifest_sha256" == "$expected_restore_evidence_manifest_sha256" ]] \
  || fail "RESTORE_EVIDENCE_MANIFEST_SHA256 does not match the approved value."
[[ "$source_manifest_sha256" == "$expected_source_manifest_sha256" ]] \
  || fail "SOURCE_MANIFEST_SHA256 does not match the approved value."
[[ "$source_fingerprint_sha256" == "$expected_source_fingerprint_sha256" ]] \
  || fail "SOURCE_FINGERPRINT_SHA256 does not match the approved value."
[[ "$relation_sequence_counts_sha256" == "$expected_relation_sequence_counts_sha256" ]] \
  || fail "RELATION_SEQUENCE_COUNTS_SHA256 does not match the approved value."
[[ "$migration_history_sha256" == "$expected_migration_history_sha256" ]] \
  || fail "MIGRATION_HISTORY_SHA256 does not match the approved value."
[[ "$managed_application_ddl_sha256" == "$expected_managed_application_ddl_sha256" ]] \
  || fail "MANAGED_APPLICATION_DDL_SHA256 does not match the approved value."
[[ "$capture_toolset_sha256" == "$expected_capture_toolset_sha256" ]] \
  || fail "CAPTURE_TOOLSET_SHA256 does not match the approved value."
[[ "$restore_toolset_sha256" == "$expected_restore_toolset_sha256" ]] \
  || fail "RESTORE_TOOLSET_SHA256 does not match the approved value."
[[ "$verified_approved_tool_manifest_sha256" == "$approved_tool_manifest_sha256" ]] \
  || fail "APPROVED_TOOL_MANIFEST_SHA256 does not match the independently approved manifest."
[[ "$(sha256_file "$approved_tool_manifest")" == "$approved_tool_manifest_sha256" ]] \
  || fail "approved tool manifest changed during evidence verification."
[[ "$migration_history_state" == "$expected_migration_history_state" ]] \
  || fail "MIGRATION_HISTORY_STATE does not match the approved value."
[[ "$verified_supabase_cli_sha256" == "$supabase_cli_sha256" ]] \
  || fail "SUPABASE_CLI_SHA256 does not match the approved executable."
[[ "$verified_postgres_image_id" == "$postgres_image_id" ]] \
  || fail "POSTGRES_IMAGE_ID does not match the approved full image ID."
[[ "$captured_writer_quiesced_at" == "$writer_quiesced_at" ]] \
  || fail "WRITER_QUIESCED_AT does not match the operator-supplied quiescence boundary."

if ! "$node_bin" - \
  "$writer_quiesced_at" \
  "$capture_started_at" \
  "$captured_at" \
  "$current_time" \
  "$max_capture_age_seconds" <<'NODE'
const [quiesced, started, captured, current, maxAgeText] = process.argv.slice(2);
const timestamps = { quiesced, started, captured, current };
const milliseconds = {};
for (const [label, value] of Object.entries(timestamps)) {
  const parsed = Date.parse(value);
  const canonical = Number.isFinite(parsed)
    && new Date(parsed).toISOString().replace(".000Z", "Z") === value;
  if (!canonical) {
    console.error(`Production reconciliation preflight: ${label} is not a real canonical RFC3339 UTC second.`);
    process.exit(1);
  }
  milliseconds[label] = parsed;
}
const maxAgeSeconds = Number(maxAgeText);
if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
  console.error("Production reconciliation preflight: maximum capture age is invalid.");
  process.exit(1);
}
if (milliseconds.started < milliseconds.quiesced) {
  console.error("Production reconciliation preflight: capture started before writer quiescence.");
  process.exit(1);
}
if (milliseconds.captured < milliseconds.started) {
  console.error("Production reconciliation preflight: capture completed before it started.");
  process.exit(1);
}
const captureAge = milliseconds.current - milliseconds.captured;
if (captureAge < 0) {
  console.error("Production reconciliation preflight: capture completion is in the future.");
  process.exit(1);
}
if (captureAge > maxAgeSeconds * 1000) {
  console.error("Production reconciliation preflight: capture evidence is stale.");
  process.exit(1);
}
NODE
then
  fail "capture/quiescence freshness validation failed."
fi

stage_manifest_sha256_before="$(sha256_file "$stage_manifest")"
[[ "$stage_manifest_sha256_before" == "$expected_reconciliation_stage_manifest_sha256" ]] \
  || fail "reconciliation stage manifest does not match its approved SHA-256."
if ! "$node_bin" "$stage_verifier" \
  --repository-root "$repository_root" \
  --verify-stage "$reconciliation_stage" \
  --release-commit "$release_commit" \
  --through-version "$through_version" \
  >/dev/null; then
  fail "immutable reconciliation stage verification failed."
fi
stage_manifest_sha256="$(sha256_file "$stage_manifest")"
[[ "$stage_manifest_sha256" == "$stage_manifest_sha256_before" ]] \
  || fail "reconciliation stage manifest changed during verification."

before_migration_history_sha256_before="$(sha256_file "$before_migration_history")"
[[ "$before_migration_history_sha256_before" == "$expected_before_migration_history_sha256" ]] \
  || fail "before migration-history snapshot does not match its approved SHA-256."
if ! "$node_bin" "$history_verifier" \
  --input "$before_migration_history" \
  --phase before \
  --through-version "$through_version" \
  >/dev/null; then
  fail "before migration-history snapshot does not prove exactly one pending migration."
fi
before_migration_history_sha256="$(sha256_file "$before_migration_history")"
[[ "$before_migration_history_sha256" == "$before_migration_history_sha256_before" ]] \
  || fail "before migration-history snapshot changed during verification."

preflight_material="$(printf '%s\n' \
  "PREFLIGHT_SCHEMA=$preflight_schema" \
  "PREFLIGHT_SCOPE=offline-non-authorizing" \
  "BACKUP_EVIDENCE_VERIFIER_SHA256=$evidence_verifier_sha256" \
  "BACKUP_ARTIFACT_VERIFIER_SHA256=$artifact_verifier_sha256" \
  "RECONCILIATION_STAGE_VERIFIER_SHA256=$stage_verifier_sha256" \
  "RECONCILIATION_HISTORY_VERIFIER_SHA256=$history_verifier_sha256" \
  "RELEASE_COMMIT=$release_commit" \
  "THROUGH_VERSION=$through_version" \
  "PROJECT_REF=$project_ref" \
  "DATABASE_HOST=$database_host" \
  "SSL_MODE=verify-full" \
  "SSL_ROOT_CERT_SHA256=$ssl_root_cert_sha256" \
  "SSL_ROOT_CERT_RELATIVE_PATH=$verified_ssl_root_cert_relative_path" \
  "ENCRYPTED_VOLUME_ATTESTATION_SHA256=$encrypted_volume_attestation_sha256" \
  "DOCKER_ENDPOINT=unix://$docker_socket" \
  "DOCKER_SOCKET=$docker_socket" \
  "DOCKER_SOCKET_DEVICE=$docker_socket_device" \
  "DOCKER_SOCKET_INODE=$docker_socket_inode" \
  "DOCKER_SOCKET_OWNER_UID=$docker_socket_owner_uid" \
  "DOCKER_SOCKET_OWNER_MODE=$docker_socket_owner_mode" \
  "DOCKER_SHARED_HOME_ROOT=$docker_shared_home_root" \
  "MACOS_TCB_ATTESTATION_SHA256=$macos_tcb_attestation_sha256" \
  "RELEASE_REPOSITORY=$release_repository" \
  "EXPECTED_BRANCH=$expected_branch" \
  "RECONCILIATION_ARTIFACT_HELPER_SHA256=$reconciliation_artifact_helper_sha256" \
  "REHEARSAL_EVIDENCE_MANIFEST_SHA256=$rehearsal_evidence_manifest_sha256" \
  "REHEARSAL_EVIDENCE_DIRECTORY=$rehearsal_evidence_directory" \
  "REHEARSAL_CAPTURE_ID=$rehearsal_capture_id" \
  "REHEARSAL_RESTORE_ID=$rehearsal_restore_id" \
  "REHEARSAL_STAGE_NUMBER=$rehearsal_stage_number" \
  "REHEARSAL_PRE_STATE_SHA256=$rehearsal_pre_state_sha256" \
  "REHEARSAL_POST_STATE_SHA256=$rehearsal_post_state_sha256" \
  "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256" \
  "RESTORE_EVIDENCE_MANIFEST_SHA256=$restore_evidence_manifest_sha256" \
  "SOURCE_MANIFEST_SHA256=$source_manifest_sha256" \
  "SOURCE_FINGERPRINT_SHA256=$source_fingerprint_sha256" \
  "RELATION_SEQUENCE_COUNTS_SHA256=$relation_sequence_counts_sha256" \
  "MIGRATION_HISTORY_SHA256=$migration_history_sha256" \
  "MANAGED_APPLICATION_DDL_SHA256=$managed_application_ddl_sha256" \
  "CAPTURE_TOOLSET_SHA256=$capture_toolset_sha256" \
  "RESTORE_TOOLSET_SHA256=$restore_toolset_sha256" \
  "APPROVED_TOOL_MANIFEST=$approved_tool_manifest" \
  "APPROVED_TOOL_MANIFEST_SHA256=$verified_approved_tool_manifest_sha256" \
  "DUMP_SCRIPT_TRANSFORMER_SHA256=$dump_script_transformer_sha256" \
  "MIGRATION_HISTORY_STATE=$migration_history_state" \
  "SUPABASE_CLI_SHA256=$verified_supabase_cli_sha256" \
  "POSTGRES_IMAGE_ID=$verified_postgres_image_id" \
  "WRITER_QUIESCED_AT=$captured_writer_quiesced_at" \
  "CAPTURE_STARTED_AT=$capture_started_at" \
  "CAPTURED_AT=$captured_at" \
  "CURRENT_TIME=$current_time" \
  "CLOCK_SOURCE=$clock_source" \
  "CLOCK_SHA256=$clock_sha256" \
  "MAX_CAPTURE_AGE_SECONDS=$max_capture_age_seconds" \
  "CAPTURE_DIRECTORY=$capture_directory" \
  "RESTORE_DIRECTORY=$restore_directory" \
  "RECONCILIATION_STAGE=$reconciliation_stage" \
  "RECONCILIATION_STAGE_MANIFEST_SHA256=$stage_manifest_sha256" \
  "BEFORE_MIGRATION_HISTORY=$before_migration_history" \
  "BEFORE_MIGRATION_HISTORY_SHA256=$before_migration_history_sha256")"
preflight_sha256="$(printf '%s\n' "$preflight_material" | sha256_stdin)"
require_hash "$preflight_sha256" "production reconciliation preflight SHA-256"

# stdout is intentionally machine-only and fully covered by the leading hash.
printf '%s\n' \
  "$preflight_identity_key=$preflight_sha256" \
  "$preflight_material"
