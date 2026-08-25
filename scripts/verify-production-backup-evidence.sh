#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
# shellcheck source=production-backup-common.sh
source "$script_directory/production-backup-common.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: verify-production-backup-evidence.sh
  --destination <absolute-mounted-encrypted-directory>
  --capture-id <safe-id> --restore-id <lowercase-hyphen-id>
  --project-ref <20-char-ref>
  --expected-branch <branch> --expected-commit <40hex>
  --supabase-cli <absolute-executable> --supabase-cli-sha256 <64hex>
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141
  --postgres-image-id sha256:<64hex>
  --passphrase-file <absolute-private-file> --passphrase-sha256 <64hex>
  --encrypted-volume-check-hook <absolute-executable> --encrypted-volume-check-hook-sha256 <64hex>
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
postgres_image=""
postgres_image_id=""
passphrase_file=""
passphrase_sha256=""
encrypted_volume_check_hook=""
encrypted_volume_check_hook_sha256=""

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
    --postgres-image) postgres_image="$2" ;;
    --postgres-image-id) postgres_image_id="$2" ;;
    --passphrase-file) passphrase_file="$2" ;;
    --passphrase-sha256) passphrase_sha256="$2" ;;
    --encrypted-volume-check-hook) encrypted_volume_check_hook="$2" ;;
    --encrypted-volume-check-hook-sha256) encrypted_volume_check_hook_sha256="$2" ;;
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
production_backup_require_commit "$expected_commit"
[[ "$postgres_image" == "$DOMINION_POSTGRES_IMAGE" ]] || production_backup_fail \
  "PostgreSQL image must be exactly $DOMINION_POSTGRES_IMAGE."
production_backup_require_image_id "$postgres_image_id"
production_backup_hashed_executable \
  "$supabase_cli" "$supabase_cli_sha256" "Supabase CLI"
production_backup_hashed_executable \
  "$encrypted_volume_check_hook" "$encrypted_volume_check_hook_sha256" \
  "encrypted volume check hook"
production_backup_private_file "$passphrase_file" "encrypted volume passphrase file"
production_backup_require_hash "$passphrase_sha256" "passphrase file SHA-256"
[[ "$(production_backup_sha256_file "$passphrase_file")" == "$passphrase_sha256" ]] \
  || production_backup_fail "passphrase file SHA-256 does not match."

export SUPABASE_TELEMETRY_DISABLED=1
actual_cli_version="$($supabase_cli --version)"
[[ "$actual_cli_version" == "$DOMINION_SUPABASE_CLI_VERSION" ]] \
  || production_backup_fail \
    "expected Supabase CLI $DOMINION_SUPABASE_CLI_VERSION, found $actual_cli_version."

node_bin="${NODE_BIN:-}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi
[[ -n "$node_bin" && -x "$node_bin" ]] || production_backup_fail "Node.js is required."
git_bin="${GIT_BIN:-}"
if [[ -z "$git_bin" ]]; then
  git_bin="$(command -v git || true)"
fi
[[ -n "$git_bin" && -x "$git_bin" ]] || production_backup_fail "Git is required."
actual_branch="$($git_bin -C "$repository_root" rev-parse --abbrev-ref HEAD)"
actual_commit="$($git_bin -C "$repository_root" rev-parse HEAD)"
[[ "$actual_branch" == "$expected_branch" ]] || production_backup_fail \
  "expected branch $expected_branch, found $actual_branch."
[[ "$actual_commit" == "$expected_commit" ]] || production_backup_fail \
  "expected commit $expected_commit, found $actual_commit."
[[ -z "$($git_bin -C "$repository_root" status --porcelain)" ]] || production_backup_fail \
  "the release worktree must be clean before evidence verification."

destination="$(production_backup_canonical_directory "$destination" "encrypted destination")"
[[ "$destination" != "/" ]] || production_backup_fail "destination cannot be the filesystem root."
case "$destination/" in
  "$repository_root/"*) production_backup_fail "destination must be outside the repository." ;;
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
production_backup_verify_encrypted_destination \
  "$destination" "$passphrase_file" "$encrypted_volume_check_hook"
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
    --project-ref "$project_ref" \
    --git-branch "$expected_branch" \
    --git-commit "$expected_commit" \
    --cli-sha256 "$supabase_cli_sha256" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id"
)"
database_suffix="$(printf '%s' "$restore_id" | tr '-' '_')"
database_name="dominion_restore_$database_suffix"
restore_manifest_sha256="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    verify-restore \
    --directory "$restore_directory" \
    --capture-id "$capture_id" \
    --restore-id "$restore_id" \
    --project-ref "$project_ref" \
    --backup-manifest-sha256 "$backup_manifest_sha256" \
    --postgres-image "$postgres_image" \
    --postgres-image-id "$postgres_image_id" \
    --database-name "$database_name"
)"

source_manifest_sha256="$(
  production_backup_sha256_file "$capture_directory/source-manifest.jsonl"
)"
source_fingerprint_sha256="$(
  production_backup_sha256_file "$capture_directory/source-fingerprint.jsonl"
)"
relation_counts_sha256="$(
  production_backup_sha256_file "$capture_directory/relation-sequence-counts.json"
)"
migration_history_sha256="$(
  production_backup_sha256_file "$capture_directory/migration-history.json"
)"
managed_application_ddl_sha256="$(
  production_backup_sha256_file "$capture_directory/managed-application-ddl.sql"
)"
migration_history_state="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    history-state \
    --file "$capture_directory/migration-history.json" \
    --project-ref "$project_ref"
)"
captured_at="$(
  "$node_bin" "$script_directory/production-backup-artifacts.mjs" \
    capture-timestamp --directory "$capture_directory"
)"

# Keep stdout stable for downstream release gates. Diagnostics use stderr.
echo "BACKUP_MANIFEST_SHA256=$backup_manifest_sha256"
echo "RESTORE_EVIDENCE_MANIFEST_SHA256=$restore_manifest_sha256"
echo "SOURCE_MANIFEST_SHA256=$source_manifest_sha256"
echo "SOURCE_FINGERPRINT_SHA256=$source_fingerprint_sha256"
echo "RELATION_SEQUENCE_COUNTS_SHA256=$relation_counts_sha256"
echo "MIGRATION_HISTORY_SHA256=$migration_history_sha256"
echo "MANAGED_APPLICATION_DDL_SHA256=$managed_application_ddl_sha256"
echo "MIGRATION_HISTORY_STATE=$migration_history_state"
echo "SUPABASE_CLI_SHA256=$supabase_cli_sha256"
echo "POSTGRES_IMAGE_ID=$postgres_image_id"
echo "CAPTURED_AT=$captured_at"
echo "CAPTURE_DIRECTORY=$capture_directory"
echo "RESTORE_DIRECTORY=$restore_directory"
