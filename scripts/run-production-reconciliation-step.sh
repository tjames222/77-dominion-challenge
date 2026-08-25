#!/usr/bin/env bash
set -euo pipefail

# Executes one approved historical migration against the hosted production
# target. The independently reviewed per-stage plan binds executable identity,
# backup/restore evidence, the immutable stage, expected results, and chain.

umask 077

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
runner_path="$script_directory/run-production-reconciliation-step.sh"
common_helper="$script_directory/production-backup-common.sh"
default_preflight="$script_directory/verify-production-reconciliation-preflight.sh"
credential_validator="$script_directory/validate-postgres-credentials.mjs"
artifact_helper="$script_directory/production-reconciliation-artifacts.mjs"
stage_verifier="$script_directory/prepare-reconciliation-stage.mjs"
history_verifier="$script_directory/verify-reconciliation-history.mjs"
manifest_validator="$script_directory/compare-database-manifests.mjs"
zero_hash="0000000000000000000000000000000000000000000000000000000000000000"

fail() {
  echo "Production reconciliation step: $1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: run-production-reconciliation-step.sh
  --reconciliation-id <safe-id>
  --database-url-file <absolute-owner-only-passwordless-url>
  --database-url-file-sha256 <64hex>
  --database-passfile <absolute-owner-only-exact-pgpass>
  --database-passfile-sha256 <64hex>
  --previous-completion-evidence <genesis|absolute-prior-evidence-directory>
  --approved-reconciliation-plan <absolute-canonical-json>
  --approved-reconciliation-plan-sha256 <independently-reviewed-64hex>
  --effect-verification-hook <absolute-executable>
  --confirm-one-version <release-commit>:<through-version>:<plan-sha256>
  -- <all verify-production-reconciliation-preflight arguments except
      --before-migration-history and
      --expected-before-migration-history-sha256>

The all-zero genesis chain is accepted only for the first approved version.
Every later version requires a verified prior completion chain under the same
encrypted destination. Database/effect hooks must implement the reviewed
exact-docker-pgpass/v1 argument contract. No secret value is placed in argv.
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

require_hash() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$2 must be exactly 64 lowercase hexadecimal characters."
}

require_regular_file() {
  case "$1" in /*) ;; *) fail "$2 must be an absolute path." ;; esac
  [[ -f "$1" && ! -L "$1" ]] \
    || fail "$2 must be a regular, non-symlink file."
}

reconciliation_id=""
database_url_file=""
database_url_file_sha256=""
database_passfile=""
database_passfile_sha256=""
previous_completion_evidence=""
approved_plan=""
approved_plan_sha256=""
effect_verification_hook=""
confirmation=""
seen_runner_options="|"

record_runner_option() {
  case "$seen_runner_options" in
    *"|$1|"*) fail "$1 may be supplied only once." ;;
  esac
  seen_runner_options="${seen_runner_options}${1}|"
}

if [[ "${1:-}" == "--" && "${2:-}" == "--reconciliation-id" ]]; then
  shift
fi
while (( $# > 0 )) && [[ "$1" != "--" ]]; do
  (( $# >= 2 )) || usage
  option="$1"
  value="$2"
  [[ -n "$value" && "$value" != --* ]] || usage
  record_runner_option "$option"
  case "$option" in
    --reconciliation-id) reconciliation_id="$value" ;;
    --database-url-file) database_url_file="$value" ;;
    --database-url-file-sha256) database_url_file_sha256="$value" ;;
    --database-passfile) database_passfile="$value" ;;
    --database-passfile-sha256) database_passfile_sha256="$value" ;;
    --previous-completion-evidence) previous_completion_evidence="$value" ;;
    --approved-reconciliation-plan) approved_plan="$value" ;;
    --approved-reconciliation-plan-sha256) approved_plan_sha256="$value" ;;
    --effect-verification-hook) effect_verification_hook="$value" ;;
    --confirm-one-version) confirmation="$value" ;;
    *) usage ;;
  esac
  shift 2
done
[[ "${1:-}" == "--" ]] || usage
shift
(( $# > 0 )) || fail "the exact preflight argument set is required after --."
preflight_arguments=("$@")
(( ${#preflight_arguments[@]} % 2 == 0 )) \
  || fail "preflight arguments must be exact flag/value pairs."

for required_runner_option in \
  --reconciliation-id \
  --database-url-file \
  --database-url-file-sha256 \
  --database-passfile \
  --database-passfile-sha256 \
  --previous-completion-evidence \
  --approved-reconciliation-plan \
  --approved-reconciliation-plan-sha256 \
  --effect-verification-hook \
  --confirm-one-version; do
  case "$seen_runner_options" in
    *"|$required_runner_option|"*) ;;
    *) fail "$required_runner_option is required." ;;
  esac
done

require_hash "$database_url_file_sha256" "database URL file SHA-256"
require_hash "$database_passfile_sha256" "database passfile SHA-256"
require_hash "$approved_plan_sha256" "approved reconciliation plan SHA-256"
require_regular_file "$approved_plan" "approved reconciliation plan"
[[ "$(sha256_file "$approved_plan")" == "$approved_plan_sha256" ]] \
  || fail "approved reconciliation plan does not match its independently reviewed SHA-256."

# Bootstrap only enough identity to authenticate the full plan verifier. The
# full exact schema is checked immediately afterward, before any operator hook,
# Supabase CLI, Docker, Git stage verification, or hosted IO.
initial_node="$(command -v node || true)"
[[ -n "$initial_node" && -x "$initial_node" ]] || fail "Node.js is required."
node_bin="$($initial_node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$initial_node")"
bootstrap_record="$($node_bin - "$approved_plan" <<'NODE'
const { readFileSync } = require("node:fs");
const contents = readFileSync(process.argv[2], "utf8");
let plan;
try { plan = JSON.parse(contents); } catch { process.exit(1); }
if (contents !== `${JSON.stringify(plan, null, 2)}\n`) process.exit(1);
const names = ["artifactHelperSha256", "commonHelperSha256", "nodeBinSha256", "runnerSha256"];
if (!plan || typeof plan !== "object" || Array.isArray(plan) || !plan.tools) process.exit(1);
for (const name of names) {
  if (!/^[a-f0-9]{64}$/.test(plan.tools[name] || "")) process.exit(1);
}
process.stdout.write([
  `ARTIFACT_HELPER_SHA256=${plan.tools.artifactHelperSha256}`,
  `COMMON_HELPER_SHA256=${plan.tools.commonHelperSha256}`,
  `NODE_BIN_SHA256=${plan.tools.nodeBinSha256}`,
  `RUNNER_SHA256=${plan.tools.runnerSha256}`,
].join("\n") + "\n");
NODE
)" || fail "approved reconciliation plan bootstrap validation failed."
bootstrap_line_count=0
while IFS= read -r bootstrap_line || [[ -n "$bootstrap_line" ]]; do
  bootstrap_line_count=$((bootstrap_line_count + 1))
  case "$bootstrap_line_count" in
    1) bootstrap_key="ARTIFACT_HELPER_SHA256" ;;
    2) bootstrap_key="COMMON_HELPER_SHA256" ;;
    3) bootstrap_key="NODE_BIN_SHA256" ;;
    4) bootstrap_key="RUNNER_SHA256" ;;
    *) fail "approved reconciliation plan bootstrap emitted extra output." ;;
  esac
  case "$bootstrap_line" in
    "$bootstrap_key="*) bootstrap_value="${bootstrap_line#*=}" ;;
    *) fail "approved reconciliation plan bootstrap line $bootstrap_line_count is invalid." ;;
  esac
  require_hash "$bootstrap_value" "bootstrap $bootstrap_key"
  case "$bootstrap_key" in
    ARTIFACT_HELPER_SHA256) bootstrap_artifact_helper_sha256="$bootstrap_value" ;;
    COMMON_HELPER_SHA256) bootstrap_common_helper_sha256="$bootstrap_value" ;;
    NODE_BIN_SHA256) bootstrap_node_sha256="$bootstrap_value" ;;
    RUNNER_SHA256) bootstrap_runner_sha256="$bootstrap_value" ;;
  esac
done <<<"$bootstrap_record"
[[ "$bootstrap_line_count" == "4" ]] || fail "approved reconciliation plan bootstrap output is incomplete."
[[ "$(sha256_file "$node_bin")" == "$bootstrap_node_sha256" ]] \
  || fail "Node.js does not match the independently approved plan."
require_regular_file "$runner_path" "production reconciliation runner"
require_regular_file "$common_helper" "production backup common helper"
require_regular_file "$artifact_helper" "production reconciliation artifact helper"
[[ "$(sha256_file "$runner_path")" == "$bootstrap_runner_sha256" ]] \
  || fail "runner does not match the independently approved plan."
[[ "$(sha256_file "$common_helper")" == "$bootstrap_common_helper_sha256" ]] \
  || fail "common helper does not match the independently approved plan."
[[ "$(sha256_file "$artifact_helper")" == "$bootstrap_artifact_helper_sha256" ]] \
  || fail "artifact helper does not match the independently approved plan."

# shellcheck source=production-backup-common.sh
source "$common_helper"
production_backup_fail() { fail "$1"; }
production_backup_reject_ambient_database_environment
production_backup_reject_ambient_runtime_environment

runtime_directory="$(mktemp -d /tmp/dominion-production-reconciliation-step.XXXXXX)"
case "$runtime_directory" in
  /tmp/dominion-production-reconciliation-step.*) ;;
  *) fail "mktemp returned an unsafe runtime directory." ;;
esac
mkdir -m 700 "$runtime_directory/home" "$runtime_directory/config"
evidence_directory=""
incomplete_marker=""
incomplete_backup="$runtime_directory/RECONCILIATION_INCOMPLETE.json"
finalized=false
cleanup() {
  local exit_status=$?
  trap - EXIT HUP INT TERM
  if [[ "$finalized" != "true" && -n "$incomplete_marker" \
    && -d "${evidence_directory:-}" && ! -e "$incomplete_marker" \
    && -f "$incomplete_backup" ]]; then
    /bin/cp "$incomplete_backup" "$incomplete_marker" || true
    chmod 600 "$incomplete_marker" || true
  fi
  case "${runtime_directory:-}" in
    /tmp/dominion-production-reconciliation-step.*) rm -rf "$runtime_directory" ;;
    *) echo "Production reconciliation step: refused unsafe runtime cleanup." >&2; exit 1 ;;
  esac
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

plan_record="$runtime_directory/plan-record.txt"
if ! "$node_bin" "$artifact_helper" verify-plan \
  --input "$approved_plan" --input-sha256 "$approved_plan_sha256" \
  >"$plan_record"; then
  fail "approved reconciliation plan schema verification failed."
fi

plan_line_count=0
while IFS= read -r plan_line || [[ -n "$plan_line" ]]; do
  plan_line_count=$((plan_line_count + 1))
  case "$plan_line_count" in
    1) plan_key="APPROVED_RECONCILIATION_PLAN_SHA256" ;;
    2) plan_key="PROJECT_REF" ;;
    3) plan_key="EXPECTED_BRANCH" ;;
    4) plan_key="RELEASE_COMMIT" ;;
    5) plan_key="THROUGH_VERSION" ;;
    6) plan_key="PREVIOUS_COMPLETION_SHA256" ;;
    7) plan_key="EXPECTED_PRE_SOURCE_MANIFEST_SHA256" ;;
    8) plan_key="EXPECTED_PRE_SOURCE_FINGERPRINT_SHA256" ;;
    9) plan_key="EXPECTED_POST_SOURCE_MANIFEST_SHA256" ;;
    10) plan_key="EXPECTED_POST_SOURCE_FINGERPRINT_SHA256" ;;
    11) plan_key="EXPECTED_EFFECT_VERIFICATION_SHA256" ;;
    12) plan_key="BACKUP_MANIFEST_SHA256" ;;
    13) plan_key="RESTORE_EVIDENCE_MANIFEST_SHA256" ;;
    14) plan_key="BACKUP_SOURCE_MANIFEST_SHA256" ;;
    15) plan_key="BACKUP_SOURCE_FINGERPRINT_SHA256" ;;
    16) plan_key="BACKUP_RELATION_SEQUENCE_COUNTS_SHA256" ;;
    17) plan_key="BACKUP_MIGRATION_HISTORY_SHA256" ;;
    18) plan_key="BACKUP_MANAGED_APPLICATION_DDL_SHA256" ;;
    19) plan_key="CAPTURE_TOOLSET_SHA256" ;;
    20) plan_key="RESTORE_TOOLSET_SHA256" ;;
    21) plan_key="BACKUP_MIGRATION_HISTORY_STATE" ;;
    22) plan_key="POSTGRES_IMAGE_ID" ;;
    23) plan_key="WRITER_QUIESCED_AT" ;;
    24) plan_key="MAX_CAPTURE_AGE_SECONDS" ;;
    25) plan_key="APPROVED_BACKUP_TOOL_MANIFEST_SHA256" ;;
    26) plan_key="RECONCILIATION_STAGE_MANIFEST_SHA256" ;;
    27) plan_key="RUNNER_SHA256" ;;
    28) plan_key="COMMON_HELPER_SHA256" ;;
    29) plan_key="CLOCK_SHA256" ;;
    30) plan_key="ARTIFACT_HELPER_SHA256" ;;
    31) plan_key="BACKUP_ARTIFACT_VERIFIER_SHA256" ;;
    32) plan_key="BACKUP_EVIDENCE_VERIFIER_SHA256" ;;
    33) plan_key="DUMP_SCRIPT_TRANSFORMER_SHA256" ;;
    34) plan_key="PREFLIGHT_SHA256" ;;
    35) plan_key="STAGE_VERIFIER_SHA256" ;;
    36) plan_key="HISTORY_VERIFIER_SHA256" ;;
    37) plan_key="MANIFEST_VALIDATOR_SHA256" ;;
    38) plan_key="CREDENTIAL_VALIDATOR_SHA256" ;;
    39) plan_key="NODE_BIN_SHA256" ;;
    40) plan_key="GIT_BIN_SHA256" ;;
    41) plan_key="SUPABASE_CLI_SHA256" ;;
    42) plan_key="DOCKER_BIN_SHA256" ;;
    43) plan_key="SOURCE_MANIFEST_HOOK_SHA256" ;;
    44) plan_key="SOURCE_FINGERPRINT_HOOK_SHA256" ;;
    45) plan_key="MIGRATION_HISTORY_HOOK_SHA256" ;;
    46) plan_key="ENCRYPTED_VOLUME_CHECK_HOOK_SHA256" ;;
    47) plan_key="EFFECT_VERIFICATION_HOOK_SHA256" ;;
    *) fail "approved reconciliation plan verifier emitted extra output." ;;
  esac
  case "$plan_line" in
    "$plan_key="*) plan_value="${plan_line#*=}" ;;
    *) fail "approved reconciliation plan output line $plan_line_count must be $plan_key=<value>." ;;
  esac
  [[ -n "$plan_value" ]] || fail "approved reconciliation plan output contains an empty value."
  case "$plan_key" in
    APPROVED_RECONCILIATION_PLAN_SHA256) verified_plan_sha256="$plan_value" ;;
    PROJECT_REF) project_ref="$plan_value" ;;
    EXPECTED_BRANCH) expected_branch="$plan_value" ;;
    RELEASE_COMMIT) release_commit="$plan_value" ;;
    THROUGH_VERSION) through_version="$plan_value" ;;
    PREVIOUS_COMPLETION_SHA256) previous_completion_sha256="$plan_value" ;;
    EXPECTED_PRE_SOURCE_MANIFEST_SHA256) expected_pre_source_manifest_sha256="$plan_value" ;;
    EXPECTED_PRE_SOURCE_FINGERPRINT_SHA256) expected_pre_source_fingerprint_sha256="$plan_value" ;;
    EXPECTED_POST_SOURCE_MANIFEST_SHA256) expected_post_source_manifest_sha256="$plan_value" ;;
    EXPECTED_POST_SOURCE_FINGERPRINT_SHA256) expected_post_source_fingerprint_sha256="$plan_value" ;;
    EXPECTED_EFFECT_VERIFICATION_SHA256) expected_effect_verification_sha256="$plan_value" ;;
    BACKUP_MANIFEST_SHA256) backup_manifest_sha256="$plan_value" ;;
    RESTORE_EVIDENCE_MANIFEST_SHA256) restore_evidence_manifest_sha256="$plan_value" ;;
    BACKUP_SOURCE_MANIFEST_SHA256) backup_source_manifest_sha256="$plan_value" ;;
    BACKUP_SOURCE_FINGERPRINT_SHA256) backup_source_fingerprint_sha256="$plan_value" ;;
    BACKUP_RELATION_SEQUENCE_COUNTS_SHA256) backup_relation_counts_sha256="$plan_value" ;;
    BACKUP_MIGRATION_HISTORY_SHA256) backup_migration_history_sha256="$plan_value" ;;
    BACKUP_MANAGED_APPLICATION_DDL_SHA256) backup_managed_ddl_sha256="$plan_value" ;;
    CAPTURE_TOOLSET_SHA256) capture_toolset_sha256="$plan_value" ;;
    RESTORE_TOOLSET_SHA256) restore_toolset_sha256="$plan_value" ;;
    BACKUP_MIGRATION_HISTORY_STATE) backup_migration_history_state="$plan_value" ;;
    POSTGRES_IMAGE_ID) postgres_image_id="$plan_value" ;;
    WRITER_QUIESCED_AT) writer_quiesced_at="$plan_value" ;;
    MAX_CAPTURE_AGE_SECONDS) max_capture_age_seconds="$plan_value" ;;
    APPROVED_BACKUP_TOOL_MANIFEST_SHA256) approved_backup_tool_manifest_sha256="$plan_value" ;;
    RECONCILIATION_STAGE_MANIFEST_SHA256) stage_manifest_sha256="$plan_value" ;;
    RUNNER_SHA256) runner_sha256="$plan_value" ;;
    COMMON_HELPER_SHA256) common_helper_sha256="$plan_value" ;;
    CLOCK_SHA256) clock_sha256="$plan_value" ;;
    ARTIFACT_HELPER_SHA256) artifact_helper_sha256="$plan_value" ;;
    BACKUP_ARTIFACT_VERIFIER_SHA256) backup_artifact_verifier_sha256="$plan_value" ;;
    BACKUP_EVIDENCE_VERIFIER_SHA256) backup_evidence_verifier_sha256="$plan_value" ;;
    DUMP_SCRIPT_TRANSFORMER_SHA256) dump_script_transformer_sha256="$plan_value" ;;
    PREFLIGHT_SHA256) preflight_sha256="$plan_value" ;;
    STAGE_VERIFIER_SHA256) stage_verifier_sha256="$plan_value" ;;
    HISTORY_VERIFIER_SHA256) history_verifier_sha256="$plan_value" ;;
    MANIFEST_VALIDATOR_SHA256) manifest_validator_sha256="$plan_value" ;;
    CREDENTIAL_VALIDATOR_SHA256) credential_validator_sha256="$plan_value" ;;
    NODE_BIN_SHA256) node_bin_sha256="$plan_value" ;;
    GIT_BIN_SHA256) git_bin_sha256="$plan_value" ;;
    SUPABASE_CLI_SHA256) supabase_cli_sha256="$plan_value" ;;
    DOCKER_BIN_SHA256) docker_bin_sha256="$plan_value" ;;
    SOURCE_MANIFEST_HOOK_SHA256) source_manifest_hook_sha256="$plan_value" ;;
    SOURCE_FINGERPRINT_HOOK_SHA256) source_fingerprint_hook_sha256="$plan_value" ;;
    MIGRATION_HISTORY_HOOK_SHA256) migration_history_hook_sha256="$plan_value" ;;
    ENCRYPTED_VOLUME_CHECK_HOOK_SHA256) encrypted_volume_check_hook_sha256="$plan_value" ;;
    EFFECT_VERIFICATION_HOOK_SHA256) effect_verification_hook_sha256="$plan_value" ;;
  esac
done <"$plan_record"
[[ "$plan_line_count" == "47" ]] || fail "approved reconciliation plan output is incomplete."
[[ "$verified_plan_sha256" == "$approved_plan_sha256" \
  && "$runner_sha256" == "$bootstrap_runner_sha256" \
  && "$common_helper_sha256" == "$bootstrap_common_helper_sha256" \
  && "$artifact_helper_sha256" == "$bootstrap_artifact_helper_sha256" \
  && "$node_bin_sha256" == "$bootstrap_node_sha256" ]] \
  || fail "approved reconciliation plan bootstrap and full verification disagree."
[[ "$confirmation" == "$release_commit:$through_version:$approved_plan_sha256" ]] \
  || fail "--confirm-one-version must bind the release commit, one version, and reviewed plan SHA-256."
production_backup_require_safe_id "$reconciliation_id" "reconciliation ID"

preflight_value=""
get_preflight_value() {
  local requested="$1"
  local found=0
  local index=0
  preflight_value=""
  while (( index < ${#preflight_arguments[@]} )); do
    local flag="${preflight_arguments[$index]}"
    local value="${preflight_arguments[$((index + 1))]}"
    [[ "$flag" == --* && -n "$value" && "$value" != --* ]] \
      || fail "preflight arguments contain an invalid pair near $flag."
    if [[ "$flag" == "$requested" ]]; then
      found=$((found + 1))
      preflight_value="$value"
    fi
    index=$((index + 2))
  done
  [[ "$found" == "1" ]] \
    || fail "preflight arguments must contain exactly one $requested."
}

for forbidden_preflight_option in \
  --before-migration-history \
  --expected-before-migration-history-sha256; do
  if printf '%s\n' "${preflight_arguments[@]}" | grep -Fqx "$forbidden_preflight_option"; then
    fail "$forbidden_preflight_option is captured live by this mutating entrypoint."
  fi
done

get_preflight_value --destination; destination="$preflight_value"
get_preflight_value --project-ref; preflight_project_ref="$preflight_value"
get_preflight_value --expected-branch; preflight_expected_branch="$preflight_value"
get_preflight_value --expected-commit; expected_commit="$preflight_value"
get_preflight_value --release-commit; preflight_release_commit="$preflight_value"
get_preflight_value --through-version; preflight_through_version="$preflight_value"
get_preflight_value --reconciliation-stage; reconciliation_stage="$preflight_value"
get_preflight_value --expected-reconciliation-stage-manifest-sha256; preflight_stage_manifest_sha256="$preflight_value"
get_preflight_value --supabase-cli; supabase_cli="$preflight_value"
get_preflight_value --supabase-cli-sha256; preflight_supabase_cli_sha256="$preflight_value"
get_preflight_value --docker-bin; docker_bin="$preflight_value"
get_preflight_value --docker-bin-sha256; preflight_docker_bin_sha256="$preflight_value"
get_preflight_value --postgres-image; postgres_image="$preflight_value"
get_preflight_value --postgres-image-id; preflight_postgres_image_id="$preflight_value"
get_preflight_value --passphrase-file; passphrase_file="$preflight_value"
get_preflight_value --passphrase-sha256; passphrase_sha256="$preflight_value"
get_preflight_value --encrypted-volume-check-hook; encrypted_volume_check_hook="$preflight_value"
get_preflight_value --encrypted-volume-check-hook-sha256; preflight_volume_hook_sha256="$preflight_value"
get_preflight_value --source-manifest-hook; source_manifest_hook="$preflight_value"
get_preflight_value --source-manifest-hook-sha256; preflight_source_manifest_hook_sha256="$preflight_value"
get_preflight_value --source-fingerprint-hook; source_fingerprint_hook="$preflight_value"
get_preflight_value --source-fingerprint-hook-sha256; preflight_source_fingerprint_hook_sha256="$preflight_value"
get_preflight_value --migration-history-hook; migration_history_hook="$preflight_value"
get_preflight_value --migration-history-hook-sha256; preflight_migration_history_hook_sha256="$preflight_value"
get_preflight_value --credential-validator-sha256; preflight_credential_validator_sha256="$preflight_value"
get_preflight_value --dump-script-transformer-sha256; preflight_dump_transformer_sha256="$preflight_value"
get_preflight_value --approved-tool-manifest; approved_backup_tool_manifest="$preflight_value"
get_preflight_value --approved-tool-manifest-sha256; preflight_approved_tool_manifest_sha256="$preflight_value"
get_preflight_value --expected-backup-manifest-sha256; preflight_backup_manifest_sha256="$preflight_value"
get_preflight_value --expected-restore-evidence-manifest-sha256; preflight_restore_manifest_sha256="$preflight_value"
get_preflight_value --expected-source-manifest-sha256; preflight_backup_source_manifest_sha256="$preflight_value"
get_preflight_value --expected-source-fingerprint-sha256; preflight_backup_source_fingerprint_sha256="$preflight_value"
get_preflight_value --expected-relation-sequence-counts-sha256; preflight_backup_relation_counts_sha256="$preflight_value"
get_preflight_value --expected-migration-history-sha256; preflight_backup_history_sha256="$preflight_value"
get_preflight_value --expected-managed-application-ddl-sha256; preflight_backup_ddl_sha256="$preflight_value"
get_preflight_value --expected-capture-toolset-sha256; preflight_capture_toolset_sha256="$preflight_value"
get_preflight_value --expected-restore-toolset-sha256; preflight_restore_toolset_sha256="$preflight_value"
get_preflight_value --expected-migration-history-state; preflight_history_state="$preflight_value"
get_preflight_value --writer-quiesced-at; preflight_writer_quiesced_at="$preflight_value"
get_preflight_value --max-capture-age-seconds; preflight_max_capture_age_seconds="$preflight_value"

[[ "$preflight_project_ref" == "$project_ref" \
  && "$preflight_expected_branch" == "$expected_branch" \
  && "$expected_commit" == "$release_commit" \
  && "$preflight_release_commit" == "$release_commit" \
  && "$preflight_through_version" == "$through_version" \
  && "$preflight_stage_manifest_sha256" == "$stage_manifest_sha256" \
  && "$preflight_supabase_cli_sha256" == "$supabase_cli_sha256" \
  && "$preflight_docker_bin_sha256" == "$docker_bin_sha256" \
  && "$preflight_postgres_image_id" == "$postgres_image_id" \
  && "$preflight_volume_hook_sha256" == "$encrypted_volume_check_hook_sha256" \
  && "$preflight_source_manifest_hook_sha256" == "$source_manifest_hook_sha256" \
  && "$preflight_source_fingerprint_hook_sha256" == "$source_fingerprint_hook_sha256" \
  && "$preflight_migration_history_hook_sha256" == "$migration_history_hook_sha256" \
  && "$preflight_credential_validator_sha256" == "$credential_validator_sha256" \
  && "$preflight_dump_transformer_sha256" == "$dump_script_transformer_sha256" \
  && "$preflight_approved_tool_manifest_sha256" == "$approved_backup_tool_manifest_sha256" \
  && "$preflight_backup_manifest_sha256" == "$backup_manifest_sha256" \
  && "$preflight_restore_manifest_sha256" == "$restore_evidence_manifest_sha256" \
  && "$preflight_backup_source_manifest_sha256" == "$backup_source_manifest_sha256" \
  && "$preflight_backup_source_fingerprint_sha256" == "$backup_source_fingerprint_sha256" \
  && "$preflight_backup_relation_counts_sha256" == "$backup_relation_counts_sha256" \
  && "$preflight_backup_history_sha256" == "$backup_migration_history_sha256" \
  && "$preflight_backup_ddl_sha256" == "$backup_managed_ddl_sha256" \
  && "$preflight_capture_toolset_sha256" == "$capture_toolset_sha256" \
  && "$preflight_restore_toolset_sha256" == "$restore_toolset_sha256" \
  && "$preflight_history_state" == "$backup_migration_history_state" \
  && "$preflight_writer_quiesced_at" == "$writer_quiesced_at" \
  && "$preflight_max_capture_age_seconds" == "$max_capture_age_seconds" ]] \
  || fail "preflight arguments do not exactly match the independently approved reconciliation plan."
[[ "$expected_branch" == "main" ]] || fail "production reconciliation requires main."
production_backup_require_project_ref "$project_ref"
production_backup_require_commit "$release_commit"
[[ "$through_version" =~ ^[0-9]{14}$ ]] || fail "through version must be exactly 14 digits."
[[ "$postgres_image" == "$DOMINION_POSTGRES_IMAGE" ]] \
  || fail "PostgreSQL image tag does not match the repository pin."

production_backup_private_file "$database_url_file" "database URL file"
production_backup_private_file "$database_passfile" "database passfile"
production_backup_private_file "$passphrase_file" "backup passphrase file"
database_url_file="$(production_backup_canonical_file "$database_url_file" "database URL file")"
database_passfile="$(production_backup_canonical_file "$database_passfile" "database passfile")"
passphrase_file="$(production_backup_canonical_file "$passphrase_file" "backup passphrase file")"
[[ "$(sha256_file "$database_url_file")" == "$database_url_file_sha256" ]] \
  || fail "database URL file SHA-256 does not match."
[[ "$(sha256_file "$database_passfile")" == "$database_passfile_sha256" ]] \
  || fail "database passfile SHA-256 does not match."
[[ "$(sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || fail "passphrase file SHA-256 does not match preflight."
for docker_mount_path in "$database_url_file" "$database_passfile" "$passphrase_file"; do
  case "$docker_mount_path" in
    *,*|*[[:cntrl:]]*) fail "private file paths cannot contain commas or control characters." ;;
  esac
done

git_candidate="$(command -v git || true)"
[[ -n "$git_candidate" && -x "$git_candidate" ]] || fail "Git is required."
git_bin="$($node_bin -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$git_candidate")"

test_mode="${PRODUCTION_RECONCILIATION_STEP_TEST_MODE:-}"
test_preflight_bin="${PRODUCTION_RECONCILIATION_STEP_TEST_PREFLIGHT_BIN:-}"
test_clock_bin="${PRODUCTION_RECONCILIATION_STEP_TEST_CLOCK_BIN:-}"
if [[ -n "$test_mode" || -n "$test_preflight_bin" || -n "$test_clock_bin" ]]; then
  [[ "$test_mode" == "offline-fixture-only" ]] \
    || fail "test replacements require offline-fixture-only mode."
  [[ -n "$test_preflight_bin" && -n "$test_clock_bin" ]] \
    || fail "offline-fixture-only mode requires both plan-pinned replacements."
  preflight_bin="$test_preflight_bin"
  clock_bin="$test_clock_bin"
  clock_source="test-only-hashed-override"
  allowed_preflight_clock_source="test-only-hashed-override"
else
  preflight_bin="$default_preflight"
  clock_bin="/bin/date"
  clock_source="system-utc"
  allowed_preflight_clock_source="system-utc"
fi

backup_artifact_verifier="$script_directory/production-backup-artifacts.mjs"
backup_evidence_verifier="$script_directory/verify-production-backup-evidence.sh"
dump_script_transformer="$script_directory/prepare-supabase-dump-script.mjs"
production_backup_hashed_regular_file "$common_helper" "$common_helper_sha256" "common helper"
production_backup_hashed_regular_file "$artifact_helper" "$artifact_helper_sha256" "artifact helper"
production_backup_hashed_regular_file "$backup_artifact_verifier" "$backup_artifact_verifier_sha256" "backup artifact verifier"
production_backup_hashed_regular_file "$stage_verifier" "$stage_verifier_sha256" "stage verifier"
production_backup_hashed_regular_file "$history_verifier" "$history_verifier_sha256" "history verifier"
production_backup_hashed_regular_file "$manifest_validator" "$manifest_validator_sha256" "manifest validator"
production_backup_hashed_regular_file "$credential_validator" "$credential_validator_sha256" "credential validator"
production_backup_hashed_regular_file "$dump_script_transformer" "$dump_script_transformer_sha256" "dump-script transformer"
production_backup_hashed_executable "$backup_evidence_verifier" "$backup_evidence_verifier_sha256" "backup evidence verifier"
production_backup_hashed_executable "$runner_path" "$runner_sha256" "production reconciliation runner"
production_backup_hashed_executable "$node_bin" "$node_bin_sha256" "Node.js"
production_backup_hashed_executable "$git_bin" "$git_bin_sha256" "Git"
production_backup_hashed_executable "$preflight_bin" "$preflight_sha256" "production reconciliation preflight"
production_backup_hashed_executable "$clock_bin" "$clock_sha256" "UTC clock"
production_backup_hashed_executable "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
production_backup_hashed_executable "$docker_bin" "$docker_bin_sha256" "Docker CLI"
production_backup_hashed_executable "$source_manifest_hook" "$source_manifest_hook_sha256" "source manifest hook"
production_backup_hashed_executable "$source_fingerprint_hook" "$source_fingerprint_hook_sha256" "source fingerprint hook"
production_backup_hashed_executable "$migration_history_hook" "$migration_history_hook_sha256" "migration-history hook"
production_backup_hashed_executable "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" "encrypted volume hook"
production_backup_hashed_executable "$effect_verification_hook" "$effect_verification_hook_sha256" "effect verification hook"
production_backup_hashed_regular_file "$approved_backup_tool_manifest" "$approved_backup_tool_manifest_sha256" "approved backup tool manifest"

verify_release_state() {
  local actual_root actual_branch actual_head worktree_state
  actual_root="$(env -i PATH="$PATH" "$git_bin" --no-replace-objects \
    -C "$repository_root" rev-parse --show-toplevel)" \
    || fail "could not resolve the release repository root."
  [[ "$actual_root" == "$repository_root" ]] \
    || fail "release repository root does not match the runner repository."
  actual_branch="$(env -i PATH="$PATH" "$git_bin" --no-replace-objects \
    -C "$repository_root" symbolic-ref --quiet --short HEAD)" \
    || fail "release repository must be on an attached branch."
  [[ "$actual_branch" == "$expected_branch" ]] \
    || fail "release repository must be on exact branch $expected_branch."
  actual_head="$(env -i PATH="$PATH" "$git_bin" --no-replace-objects \
    -C "$repository_root" rev-parse --verify 'HEAD^{commit}')" \
    || fail "could not resolve the release HEAD."
  [[ "$actual_head" == "$release_commit" ]] \
    || fail "release HEAD does not equal the approved release commit."
  worktree_state="$(env -i PATH="$PATH" "$git_bin" --no-replace-objects \
    -C "$repository_root" status --porcelain=v1 --untracked-files=all)" \
    || fail "could not inspect release worktree state."
  [[ -z "$worktree_state" ]] \
    || fail "release worktree must be completely clean before hosted access."
}
verify_release_state

reconciliation_stage="$(production_backup_canonical_directory "$reconciliation_stage" "reconciliation stage")"
case "$reconciliation_stage" in
  "$repository_root"|"$repository_root"/*)
    fail "immutable reconciliation stage must be outside the release repository."
    ;;
esac
[[ "$(sha256_file "$reconciliation_stage/reconciliation-stage.json")" == "$stage_manifest_sha256" ]] \
  || fail "reconciliation stage manifest does not match the approved plan."
if ! env -i PATH="$PATH" HOME="$runtime_directory/home" NODE_BIN="$node_bin" \
  GIT_CONFIG_NOSYSTEM=1 "$node_bin" "$stage_verifier" \
    --verify-stage "$reconciliation_stage" \
    --release-commit "$release_commit" --through-version "$through_version" \
    >"$runtime_directory/stage.stdout" 2>"$runtime_directory/stage.stderr"; then
  fail "immutable reconciliation stage verification failed before hosted access."
fi
actual_cli_version="$(env -i PATH="$PATH" SUPABASE_TELEMETRY_DISABLED=1 "$supabase_cli" --version)"
[[ "$actual_cli_version" == "$DOMINION_SUPABASE_CLI_VERSION" ]] \
  || fail "expected Supabase CLI $DOMINION_SUPABASE_CLI_VERSION, found $actual_cli_version."

normalized_database_url="$($node_bin "$credential_validator" \
  --database-url-file "$database_url_file" \
  --database-passfile "$database_passfile" \
  --project-ref "$project_ref")" \
  || fail "database credential validation failed."
case "$normalized_database_url" in
  postgres://*:*@*|postgresql://*:*@*) fail "validated database URL unexpectedly contains a password." ;;
esac

destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || fail "encrypted destination cannot be filesystem root."
if ! "$node_bin" - "$repository_root" "$destination" "$database_url_file" \
  "$database_passfile" "$passphrase_file" <<'NODE'
const path = require("node:path");
const [repository, destination, ...privateFiles] = process.argv.slice(2);
function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
if (within(repository, destination) || within(destination, repository)) process.exit(1);
if (privateFiles.some((file) => within(repository, file) || within(destination, file))) process.exit(1);
NODE
then
  fail "destination must be isolated from the repository, and private files must be outside both."
fi
if ! env -i PATH="$PATH" "$encrypted_volume_check_hook" \
  --destination "$destination" --passphrase-file "$passphrase_file" \
  >"$runtime_directory/volume.stdout" 2>"$runtime_directory/volume.stderr"; then
  fail "encrypted destination verification failed."
fi
[[ "$(tr -d '\r\n' <"$runtime_directory/volume.stdout")" \
  == "DOMINION_ENCRYPTED_VOLUME_OK=$destination" ]] \
  || fail "encrypted destination hook did not attest the exact canonical destination."

production_backup_require_local_docker_context "$docker_bin"
if ! env -i PATH="$PATH" "$docker_bin" image inspect \
  --format '{{.Id}}' "$postgres_image" \
  >"$runtime_directory/postgres-image.stdout" \
  2>"$runtime_directory/postgres-image.stderr"; then
  fail "could not inspect the local pinned PostgreSQL image before hosted access."
fi
[[ "$(tr -d '\r\n' <"$runtime_directory/postgres-image.stdout")" == "$postgres_image_id" ]] \
  || fail "PostgreSQL image tag does not resolve to the exact approved image ID."

if [[ "$previous_completion_sha256" == "$zero_hash" ]]; then
  [[ "$through_version" == "20260707170000" && "$previous_completion_evidence" == "genesis" ]] \
    || fail "genesis is valid only for the first approved historical version."
else
  [[ "$through_version" != "20260707170000" && "$previous_completion_evidence" != "genesis" ]] \
    || fail "every later version requires prior completion evidence."
  production_backup_require_absolute_path "$previous_completion_evidence" "prior completion evidence"
  if ! "$node_bin" "$artifact_helper" verify-previous-chain \
    --destination "$destination" \
    --tip-evidence-directory "$previous_completion_evidence" \
    --approved-plan "$approved_plan" \
    --approved-plan-sha256 "$approved_plan_sha256" \
    >"$runtime_directory/previous-chain.stdout" 2>"$runtime_directory/previous-chain.stderr"; then
    fail "prior completion chain verification failed."
  fi
  [[ "$(tr -d '\r\n' <"$runtime_directory/previous-chain.stdout")" \
    == "PREVIOUS_COMPLETION_SHA256=$previous_completion_sha256" ]] \
    || fail "prior completion chain verifier emitted an unexpected identity."
fi

current_utc() {
  production_backup_hashed_executable "$clock_bin" "$clock_sha256" "UTC clock"
  if [[ "$clock_source" == "system-utc" ]]; then
    "$clock_bin" -u '+%Y-%m-%dT%H:%M:%SZ'
  else
    "$clock_bin"
  fi
}

started_at="$(current_utc)" || fail "could not derive reconciliation start time."
[[ "$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "reconciliation clock did not return an RFC3339 UTC second."
evidence_directory="$destination/reconciliation-$reconciliation_id"
[[ ! -e "$evidence_directory" && ! -L "$evidence_directory" ]] \
  || fail "reconciliation evidence path already exists; use a new reconciliation ID."
mkdir -m 700 "$evidence_directory"
incomplete_marker="$evidence_directory/RECONCILIATION_INCOMPLETE.json"
if ! "$node_bin" - "$incomplete_marker" "$reconciliation_id" "$project_ref" \
  "$release_commit" "$through_version" "$approved_plan_sha256" "$started_at" <<'NODE'
const { writeFileSync } = require("node:fs");
const [output, reconciliationId, projectRef, releaseCommit, throughVersion, planSha256, startedAt] = process.argv.slice(2);
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  artifactContract: "dominion-production-reconciliation-incomplete/v1",
  status: "incomplete",
  reconciliationId,
  projectRef,
  releaseCommit,
  throughVersion,
  approvedReconciliationPlanSha256: planSha256,
  startedAt,
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
NODE
then
  fail "could not create the encrypted incomplete marker before hosted access."
fi
/bin/cp "$incomplete_marker" "$incomplete_backup"
chmod 600 "$incomplete_backup"
/bin/cp "$approved_plan" "$evidence_directory/approved-reconciliation-plan.json"
chmod 600 "$evidence_directory/approved-reconciliation-plan.json"
[[ "$(sha256_file "$evidence_directory/approved-reconciliation-plan.json")" == "$approved_plan_sha256" ]] \
  || fail "copied approved reconciliation plan changed."
/bin/cp "$reconciliation_stage/reconciliation-stage.json" \
  "$evidence_directory/reconciliation-stage.json"
chmod 600 "$evidence_directory/reconciliation-stage.json"
[[ "$(sha256_file "$evidence_directory/reconciliation-stage.json")" == "$stage_manifest_sha256" ]] \
  || fail "copied reconciliation stage manifest changed."

run_capture_hook() {
  local label="$1"
  local hook="$2"
  local hook_sha256="$3"
  local output="$4"
  local stdout_log="$5"
  local stderr_log="$6"
  production_backup_hashed_executable "$hook" "$hook_sha256" "$label hook"
  if ! (cd "$evidence_directory" && env -i \
    PATH="$PATH" NODE_BIN="$node_bin" SUPABASE_TELEMETRY_DISABLED=1 \
    "$hook" \
      --database-client-contract exact-docker-pgpass/v1 \
      --database-url-file "$database_url_file" \
      --database-passfile "$database_passfile" \
      --project-ref "$project_ref" \
      --docker-bin "$docker_bin" \
      --postgres-image "$postgres_image" \
      --postgres-image-id "$postgres_image_id" \
      --output "$output") \
      >"$stdout_log" 2>"$stderr_log"; then
    fail "$label failed; encrypted diagnostics remain in the incomplete evidence directory."
  fi
  [[ -s "$output" && -f "$output" && ! -L "$output" ]] \
    || fail "$label did not create a nonempty regular evidence file."
  chmod 600 "$output" "$stdout_log" "$stderr_log"
}

run_cli() {
  local operation="$1"
  local output="$2"
  local log="$3"
  shift 3
  production_backup_hashed_executable "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
  if ! (cd "$evidence_directory" && env -i PATH="$PATH" HOME="$runtime_directory/home" \
    XDG_CONFIG_HOME="$runtime_directory/config" PGPASSFILE="$database_passfile" \
    PGSSLMODE=require PGAPPNAME=77dc-production-reconciliation \
    SUPABASE_TELEMETRY_DISABLED=1 "$supabase_cli" "$@" \
      >"$output" 2>"$log"); then
    fail "$operation failed; encrypted diagnostics remain in the incomplete evidence directory."
  fi
  [[ -s "$output" && -f "$output" && ! -L "$output" ]] \
    || fail "$operation did not produce exact JSON evidence."
  chmod 600 "$output" "$log"
}

capture_snapshot() {
  local prefix="$1"
  local phase="$2"
  rehash_private_files
  current_capture_url="$($node_bin "$credential_validator" \
    --database-url-file "$database_url_file" \
    --database-passfile "$database_passfile" \
    --project-ref "$project_ref")" \
    || fail "$prefix database target validation failed."
  [[ "$current_capture_url" == "$normalized_database_url" ]] \
    || fail "$prefix database target differs from the approved target."
  production_backup_hashed_regular_file "$artifact_helper" "$artifact_helper_sha256" "artifact helper"
  production_backup_hashed_regular_file "$manifest_validator" "$manifest_validator_sha256" "manifest validator"
  production_backup_hashed_executable "$docker_bin" "$docker_bin_sha256" "Docker CLI"
  run_capture_hook "$prefix source-manifest capture" "$source_manifest_hook" \
    "$source_manifest_hook_sha256" \
    "$evidence_directory/$prefix-source-manifest.jsonl" \
    "$evidence_directory/$prefix-source-manifest.stdout" \
    "$evidence_directory/$prefix-source-manifest.stderr"
  run_capture_hook "$prefix source-fingerprint capture" "$source_fingerprint_hook" \
    "$source_fingerprint_hook_sha256" \
    "$evidence_directory/$prefix-source-fingerprint.jsonl" \
    "$evidence_directory/$prefix-source-fingerprint.stdout" \
    "$evidence_directory/$prefix-source-fingerprint.stderr"
  run_capture_hook "$prefix raw migration-history capture" "$migration_history_hook" \
    "$migration_history_hook_sha256" \
    "$evidence_directory/$prefix-raw-history.json" \
    "$evidence_directory/$prefix-raw-history.stdout" \
    "$evidence_directory/$prefix-raw-history.stderr"
  run_cli "$prefix CLI migration-history capture" \
    "$evidence_directory/$prefix-cli-history.json" \
    "$evidence_directory/$prefix-cli-history.stderr" \
    migration list --db-url "$normalized_database_url" \
      --workdir "$reconciliation_stage" --output-format json --agent no
  "$node_bin" "$artifact_helper" verify-cli-history \
    --input "$evidence_directory/$prefix-cli-history.json" \
    --phase "$phase" --through-version "$through_version"
  "$node_bin" "$artifact_helper" verify-raw-history \
    --input "$evidence_directory/$prefix-raw-history.json" \
    --phase "$phase" --project-ref "$project_ref" --through-version "$through_version"
  "$node_bin" "$manifest_validator" --validate \
    "$evidence_directory/$prefix-source-manifest.jsonl" >/dev/null
  "$node_bin" "$manifest_validator" --validate \
    "$evidence_directory/$prefix-source-fingerprint.jsonl" >/dev/null
}

rehash_private_files() {
  [[ "$(sha256_file "$database_url_file")" == "$database_url_file_sha256" \
    && "$(sha256_file "$database_passfile")" == "$database_passfile_sha256" \
    && "$(sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
    || fail "a private credential/passphrase file changed at a hosted boundary."
}
rehash_private_files
capture_snapshot pre before
[[ "$(sha256_file "$evidence_directory/pre-source-manifest.jsonl")" == "$expected_pre_source_manifest_sha256" ]] \
  || fail "fresh pre source manifest does not match the approved per-stage plan."
[[ "$(sha256_file "$evidence_directory/pre-source-fingerprint.jsonl")" == "$expected_pre_source_fingerprint_sha256" ]] \
  || fail "fresh pre source fingerprint does not match the approved per-stage plan."

pre_pinned_history="$evidence_directory/pre-cli-history.pinned.txt"
"$node_bin" "$artifact_helper" render-pinned-history \
  --input "$evidence_directory/pre-cli-history.json" \
  --output "$pre_pinned_history" --phase before --through-version "$through_version"
pre_pinned_history_sha256="$(sha256_file "$pre_pinned_history")"

preflight_record="$evidence_directory/preflight-record.txt"
preflight_stderr="$evidence_directory/preflight.stderr"
production_backup_hashed_executable "$preflight_bin" "$preflight_sha256" "production reconciliation preflight"
if ! env -i PATH="$PATH" HOME="$runtime_directory/home" XDG_CONFIG_HOME="$runtime_directory/config" \
  NODE_BIN="$node_bin" GIT_CONFIG_NOSYSTEM=1 SUPABASE_TELEMETRY_DISABLED=1 \
  "$preflight_bin" "${preflight_arguments[@]}" \
    --before-migration-history "$pre_pinned_history" \
    --expected-before-migration-history-sha256 "$pre_pinned_history_sha256" \
    >"$preflight_record" 2>"$preflight_stderr"; then
  fail "backup/restore/tool/stage preflight failed; no mutation was attempted."
fi
chmod 600 "$preflight_record" "$preflight_stderr"
if ! "$node_bin" "$artifact_helper" verify-preflight-record \
  --input "$preflight_record" \
  --plan "$approved_plan" --plan-sha256 "$approved_plan_sha256" \
  --stage "$reconciliation_stage" \
  --before-history "$pre_pinned_history" \
  --before-history-sha256 "$pre_pinned_history_sha256" \
  --allowed-clock-source "$allowed_preflight_clock_source" \
  >"$runtime_directory/preflight-identity.txt"; then
  fail "preflight record does not strictly match the independently approved plan."
fi
preflight_identity="$(tr -d '\r\n' <"$runtime_directory/preflight-identity.txt")"
case "$preflight_identity" in
  PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256=*) verified_preflight_sha256="${preflight_identity#*=}" ;;
  *) fail "preflight record verifier emitted an invalid identity." ;;
esac
require_hash "$verified_preflight_sha256" "verified preflight SHA-256"

# A second fully independent live capture closes the potentially long offline
# restore/preflight window. Writers must remain quiesced throughout.
capture_snapshot boundary before
for boundary_artifact in source-manifest.jsonl source-fingerprint.jsonl raw-history.json cli-history.json; do
  [[ "$(sha256_file "$evidence_directory/pre-$boundary_artifact")" \
    == "$(sha256_file "$evidence_directory/boundary-$boundary_artifact")" ]] \
    || fail "target drifted between preflight and apply: $boundary_artifact changed."
done

verify_mutation_boundary() {
  [[ "$(sha256_file "$approved_plan")" == "$approved_plan_sha256" \
    && "$(sha256_file "$evidence_directory/approved-reconciliation-plan.json")" == "$approved_plan_sha256" \
    && "$(sha256_file "$runner_path")" == "$runner_sha256" \
    && "$(sha256_file "$common_helper")" == "$common_helper_sha256" \
    && "$(sha256_file "$artifact_helper")" == "$artifact_helper_sha256" \
    && "$(sha256_file "$backup_artifact_verifier")" == "$backup_artifact_verifier_sha256" \
    && "$(sha256_file "$backup_evidence_verifier")" == "$backup_evidence_verifier_sha256" \
    && "$(sha256_file "$dump_script_transformer")" == "$dump_script_transformer_sha256" \
    && "$(sha256_file "$stage_verifier")" == "$stage_verifier_sha256" \
    && "$(sha256_file "$history_verifier")" == "$history_verifier_sha256" \
    && "$(sha256_file "$manifest_validator")" == "$manifest_validator_sha256" \
    && "$(sha256_file "$credential_validator")" == "$credential_validator_sha256" \
    && "$(sha256_file "$node_bin")" == "$node_bin_sha256" \
    && "$(sha256_file "$git_bin")" == "$git_bin_sha256" \
    && "$(sha256_file "$preflight_bin")" == "$preflight_sha256" \
    && "$(sha256_file "$clock_bin")" == "$clock_sha256" \
    && "$(sha256_file "$supabase_cli")" == "$supabase_cli_sha256" \
    && "$(sha256_file "$docker_bin")" == "$docker_bin_sha256" \
    && "$(sha256_file "$source_manifest_hook")" == "$source_manifest_hook_sha256" \
    && "$(sha256_file "$source_fingerprint_hook")" == "$source_fingerprint_hook_sha256" \
    && "$(sha256_file "$migration_history_hook")" == "$migration_history_hook_sha256" \
    && "$(sha256_file "$encrypted_volume_check_hook")" == "$encrypted_volume_check_hook_sha256" \
    && "$(sha256_file "$effect_verification_hook")" == "$effect_verification_hook_sha256" \
    && "$(sha256_file "$approved_backup_tool_manifest")" == "$approved_backup_tool_manifest_sha256" \
    && "$(sha256_file "$database_url_file")" == "$database_url_file_sha256" \
    && "$(sha256_file "$database_passfile")" == "$database_passfile_sha256" \
    && "$(sha256_file "$passphrase_file")" == "$passphrase_sha256" \
    && "$(sha256_file "$reconciliation_stage/reconciliation-stage.json")" == "$stage_manifest_sha256" ]] \
    || fail "a plan-bound tool, credential file, or stage identity changed before mutation."
  current_git="$(command -v git || true)"
  [[ -n "$current_git" \
    && "$($node_bin -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$current_git")" == "$git_bin" ]] \
    || fail "Git resolution changed before mutation."
  current_database_url="$($node_bin "$credential_validator" \
    --database-url-file "$database_url_file" \
    --database-passfile "$database_passfile" \
    --project-ref "$project_ref")" \
    || fail "database credential revalidation failed."
  [[ "$current_database_url" == "$normalized_database_url" ]] \
    || fail "database target changed before mutation."
  rehash_private_files
  verify_release_state
  production_backup_require_local_docker_context "$docker_bin"
  if ! env -i PATH="$PATH" "$docker_bin" image inspect \
    --format '{{.Id}}' "$postgres_image" \
    >"$runtime_directory/postgres-image-boundary.stdout" \
    2>"$runtime_directory/postgres-image-boundary.stderr"; then
    fail "could not re-inspect the approved PostgreSQL image before mutation."
  fi
  [[ "$(tr -d '\r\n' <"$runtime_directory/postgres-image-boundary.stdout")" \
    == "$postgres_image_id" ]] \
    || fail "PostgreSQL image tag changed before mutation."
}

if ! env -i PATH="$PATH" HOME="$runtime_directory/home" NODE_BIN="$node_bin" \
  GIT_CONFIG_NOSYSTEM=1 "$node_bin" "$stage_verifier" \
    --verify-stage "$reconciliation_stage" \
    --release-commit "$release_commit" --through-version "$through_version" \
    >"$evidence_directory/boundary-stage-verification.stdout" \
    2>"$evidence_directory/boundary-stage-verification.stderr"; then
  fail "immutable stage changed at the mutation boundary."
fi
chmod 600 "$evidence_directory/boundary-stage-verification.stdout" \
  "$evidence_directory/boundary-stage-verification.stderr"
verify_mutation_boundary

mutation_boundary_at="$(current_utc)" \
  || fail "could not derive the exact migration-boundary time."
[[ "$mutation_boundary_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "migration-boundary clock did not return an RFC3339 UTC second."
mutation_freshness="$evidence_directory/mutation-boundary-freshness.json"
mutation_freshness_stdout="$evidence_directory/mutation-boundary-freshness.stdout"
mutation_freshness_stderr="$evidence_directory/mutation-boundary-freshness.stderr"
if ! "$node_bin" "$artifact_helper" record-mutation-boundary-freshness \
  --preflight-record "$preflight_record" \
  --plan "$approved_plan" --plan-sha256 "$approved_plan_sha256" \
  --stage "$reconciliation_stage" \
  --before-history "$pre_pinned_history" \
  --before-history-sha256 "$pre_pinned_history_sha256" \
  --allowed-clock-source "$allowed_preflight_clock_source" \
  --mutation-boundary-at "$mutation_boundary_at" \
  --output "$mutation_freshness" \
  >"$mutation_freshness_stdout" 2>"$mutation_freshness_stderr"; then
  fail "backup evidence became stale before the migration boundary; no mutation was attempted."
fi
chmod 600 "$mutation_freshness" "$mutation_freshness_stdout" \
  "$mutation_freshness_stderr"
mutation_freshness_sha256="$(sha256_file "$mutation_freshness")"
[[ "$(tr -d '\r\n' <"$mutation_freshness_stdout")" \
  == "MUTATION_BOUNDARY_FRESHNESS_SHA256=$mutation_freshness_sha256" ]] \
  || fail "mutation-boundary freshness verifier emitted an unexpected identity."
rehash_private_files

run_cli "one-version migration up" \
  "$evidence_directory/migration-up.json" \
  "$evidence_directory/migration-up.stderr" \
  migration up --db-url "$normalized_database_url" \
    --workdir "$reconciliation_stage" --yes --output-format json --agent no
"$node_bin" "$artifact_helper" verify-migration-up \
  --input "$evidence_directory/migration-up.json" \
  --stage "$reconciliation_stage" --through-version "$through_version"

capture_snapshot post after
[[ "$(sha256_file "$evidence_directory/post-source-manifest.jsonl")" == "$expected_post_source_manifest_sha256" ]] \
  || fail "post source manifest does not match the independently approved stage result."
[[ "$(sha256_file "$evidence_directory/post-source-fingerprint.jsonl")" == "$expected_post_source_fingerprint_sha256" ]] \
  || fail "post source fingerprint does not match the independently approved stage result."

effect_output="$evidence_directory/effect-verification.json"
effect_stdout="$evidence_directory/effect-verification.stdout"
effect_stderr="$evidence_directory/effect-verification.stderr"
rehash_private_files
production_backup_hashed_executable "$effect_verification_hook" "$effect_verification_hook_sha256" "effect verification hook"
production_backup_hashed_executable "$docker_bin" "$docker_bin_sha256" "Docker CLI"
if ! (cd "$evidence_directory" && env -i \
  PATH="$PATH" NODE_BIN="$node_bin" SUPABASE_TELEMETRY_DISABLED=1 \
  "$effect_verification_hook" \
    --database-client-contract exact-docker-pgpass/v1 \
    --database-url-file "$database_url_file" \
    --database-passfile "$database_passfile" \
    --project-ref "$project_ref" \
    --through-version "$through_version" \
    --docker-bin "$docker_bin" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    --output "$effect_output") \
    >"$effect_stdout" 2>"$effect_stderr"; then
  fail "post-migration effect verification failed."
fi
[[ -s "$effect_output" && -f "$effect_output" && ! -L "$effect_output" ]] \
  || fail "effect verification did not create a nonempty regular file."
chmod 600 "$effect_output" "$effect_stdout" "$effect_stderr"
"$node_bin" "$artifact_helper" verify-effect \
  --input "$effect_output" --project-ref "$project_ref" --through-version "$through_version"
[[ "$(sha256_file "$effect_output")" == "$expected_effect_verification_sha256" ]] \
  || fail "effect verification does not match the independently approved stage result."

rehash_private_files
production_backup_hashed_executable "$encrypted_volume_check_hook" \
  "$encrypted_volume_check_hook_sha256" "encrypted volume hook"
final_volume_stdout="$evidence_directory/final-encrypted-volume-attestation.stdout"
final_volume_stderr="$evidence_directory/final-encrypted-volume-attestation.stderr"
if ! (cd "$evidence_directory" && env -i PATH="$PATH" \
  "$encrypted_volume_check_hook" \
    --destination "$destination" --passphrase-file "$passphrase_file") \
    >"$final_volume_stdout" 2>"$final_volume_stderr"; then
  fail "encrypted destination re-attestation failed before completion."
fi
chmod 600 "$final_volume_stdout" "$final_volume_stderr"
[[ "$(tr -d '\r\n' <"$final_volume_stdout")" \
  == "DOMINION_ENCRYPTED_VOLUME_OK=$destination" ]] \
  || fail "final encrypted destination attestation did not bind the exact destination."
rehash_private_files
completed_at="$(current_utc)" || fail "could not derive reconciliation completion time."
[[ "$completed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "reconciliation completion clock is invalid."
if ! "$node_bin" - "$started_at" "$completed_at" <<'NODE'
const [started, completed] = process.argv.slice(2).map(Date.parse);
if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) process.exit(1);
NODE
then
  fail "reconciliation completion time precedes start time."
fi

reconciliation_manifest="$evidence_directory/reconciliation.json"
if ! "$node_bin" - "$evidence_directory" "$reconciliation_manifest" \
  "$reconciliation_id" "$project_ref" "$expected_branch" "$release_commit" \
  "$through_version" "$previous_completion_sha256" "$approved_plan_sha256" \
  "$verified_preflight_sha256" "$writer_quiesced_at" "$started_at" "$completed_at" \
  "$approved_backup_tool_manifest_sha256" "$stage_manifest_sha256" \
  "$clock_source" "$clock_sha256" <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const [directory, output, reconciliationId, projectRef, expectedBranch, releaseCommit,
  throughVersion, previousCompletionSha256, approvedPlanSha256, preflightSha256,
  writerQuiescedAt, startedAt, completedAt, approvedBackupToolManifestSha256,
  stageManifestSha256, clockSource, clockSha256] = process.argv.slice(2);
const excluded = new Set([
  path.basename(output),
  "RECONCILIATION_COMPLETE.json",
  "RECONCILIATION_INCOMPLETE.json",
]);
const artifacts = {};
for (const name of readdirSync(directory).sort()) {
  if (excluded.has(name)) continue;
  const filename = path.join(directory, name);
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`unexpected non-file reconciliation artifact: ${name}`);
  }
  artifacts[name] = createHash("sha256").update(readFileSync(filename)).digest("hex");
}
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 2,
  artifactContract: "dominion-production-reconciliation-step/v2",
  status: "verified",
  reconciliationId,
  projectRef,
  expectedBranch,
  releaseCommit,
  throughVersion,
  previousCompletionSha256,
  approvedReconciliationPlanSha256: approvedPlanSha256,
  preflightSha256,
  writerQuiescedAt,
  startedAt,
  completedAt,
  approvedBackupToolManifestSha256,
  reconciliationStageManifestSha256: stageManifestSha256,
  clock: { source: clockSource, sha256: clockSha256 },
  artifacts,
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
NODE
then
  fail "could not write reconciliation evidence manifest."
fi

reconciliation_manifest_sha256="$(sha256_file "$reconciliation_manifest")"
completion_marker="$evidence_directory/RECONCILIATION_COMPLETE.json"
if ! "$node_bin" - "$completion_marker" "$reconciliation_manifest_sha256" \
  "$previous_completion_sha256" "$approved_plan_sha256" "$project_ref" \
  "$release_commit" "$through_version" "$completed_at" <<'NODE'
const { writeFileSync } = require("node:fs");
const [output, manifestSha256, previousCompletionSha256, approvedPlanSha256,
  projectRef, releaseCommit, throughVersion, completedAt] = process.argv.slice(2);
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 2,
  artifactContract: "dominion-production-reconciliation-completion/v2",
  status: "complete",
  projectRef,
  releaseCommit,
  throughVersion,
  previousCompletionSha256,
  approvedReconciliationPlanSha256: approvedPlanSha256,
  reconciliationManifestSha256: manifestSha256,
  completedAt,
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
NODE
then
  fail "could not write reconciliation completion marker."
fi
completion_sha256="$(sha256_file "$completion_marker")"

if ! "$node_bin" "$artifact_helper" verify-completion \
  --evidence-directory "$evidence_directory" --phase before-finalize \
  --completion-sha256 "$completion_sha256" --project-ref "$project_ref" \
  --release-commit "$release_commit" --through-version "$through_version" \
  --approved-plan-sha256 "$approved_plan_sha256" \
  >"$runtime_directory/completion-before.stdout" 2>"$runtime_directory/completion-before.stderr"; then
  fail "completion evidence failed verification before finalization."
fi
rm "$incomplete_marker"
if ! "$node_bin" "$artifact_helper" verify-completion \
  --evidence-directory "$evidence_directory" --phase complete \
  --completion-sha256 "$completion_sha256" --project-ref "$project_ref" \
  --release-commit "$release_commit" --through-version "$through_version" \
  --approved-plan-sha256 "$approved_plan_sha256" \
  >"$runtime_directory/completion-final.stdout" 2>"$runtime_directory/completion-final.stderr"; then
  fail "finalized completion evidence failed standalone verification."
fi
[[ "$(tr -d '\r\n' <"$runtime_directory/completion-final.stdout")" \
  == "PRODUCTION_RECONCILIATION_COMPLETION_SHA256=$completion_sha256" ]] \
  || fail "completion verifier emitted an unexpected identity."
finalized=true

printf '%s\n' \
  "PRODUCTION_RECONCILIATION_COMPLETION_SHA256=$completion_sha256" \
  "RECONCILIATION_MANIFEST_SHA256=$reconciliation_manifest_sha256" \
  "APPROVED_RECONCILIATION_PLAN_SHA256=$approved_plan_sha256" \
  "PREVIOUS_COMPLETION_SHA256=$previous_completion_sha256" \
  "RELEASE_COMMIT=$release_commit" \
  "THROUGH_VERSION=$through_version" \
  "EVIDENCE_DIRECTORY=$evidence_directory"
