#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Migration atomicity proof: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
fixture_directory="$script_directory/fixtures"

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
export SUPABASE_TELEMETRY_DISABLED=1

cli_version="$($supabase_cli --version)"
[[ "$cli_version" == "2.109.0" ]] \
  || fail "expected pinned Supabase CLI 2.109.0, found $cli_version."

node "$script_directory/check-migration-compatibility.mjs"

staging_root="$(mktemp -d "${TMPDIR:-/tmp}/migration-atomicity.XXXXXX")"
failure_log="$(mktemp "${TMPDIR:-/tmp}/migration-atomicity-output.XXXXXX")"

cleanup() {
  test_status=$?
  trap - EXIT
  cleanup_status=0
  bash "$script_directory/run-local-sql.sh" \
    "$fixture_directory/migration-history-failure-cleanup.sql" \
    >/dev/null 2>&1 || cleanup_status=$?
  rm -rf -- "$staging_root"
  rm -f -- "$failure_log"
  if (( test_status != 0 )); then
    exit "$test_status"
  fi
  if (( cleanup_status != 0 )); then
    echo "Migration atomicity proof: failed to remove the local probe fixture." >&2
    exit "$cleanup_status"
  fi
  exit 0
}
trap cleanup EXIT

mkdir -p "$staging_root/supabase/migrations"
cp "$repository_root/supabase/config.toml" "$staging_root/supabase/config.toml"
cp "$repository_root"/supabase/migrations/*.sql "$staging_root/supabase/migrations/"
cp "$fixture_directory/99999999999999_atomicity_probe.sql" \
  "$staging_root/supabase/migrations/"

bash "$script_directory/run-local-sql.sh" \
  "$fixture_directory/migration-history-failure-setup.sql" >/dev/null

set +e
"$supabase_cli" migration up --local --workdir "$staging_root" \
  >"$failure_log" 2>&1
migration_status=$?
set -e

if (( migration_status == 0 )); then
  cat "$failure_log" >&2
  fail "the forced history-insert failure did not reject the migration."
fi
# CLI 2.109 wraps and redacts the underlying PostgreSQL trigger exception, but
# preserves the failed statement. The setup transaction proves the rejecting
# trigger exists; this assertion proves that the expected history INSERT fired.
if ! grep -Fq 'INSERT INTO supabase_migrations.schema_migrations' "$failure_log"; then
  cat "$failure_log" >&2
  fail "migration up failed for an unexpected reason."
fi

bash "$script_directory/run-local-sql.sh" \
  "$fixture_directory/migration-history-failure-verify.sql" >/dev/null

echo "Migration atomicity proof passed: failed history insertion rolled back both SQL and history."
