#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Database pgTAP runner: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
source_tests_directory="$repository_root/supabase/tests/database"

[[ -d "$source_tests_directory" ]] || fail "missing $source_tests_directory."

test_files=()
while IFS= read -r test_file; do
  test_files+=("$test_file")
done < <(
  find "$source_tests_directory" -type f \
    \( -name '*.sql' -o -name '*.pg' \) -print \
    | LC_ALL=C sort
)

source_file_count="${#test_files[@]}"
(( source_file_count > 0 )) || fail "no .sql or .pg test files were found."

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

# Supabase CLI 2.109.0 bind-mounts the test path into its pg_prove container.
# A linked worktree can live outside Docker's shared host paths even when the
# repository's common Git directory is shared. Stage the database test directory
# there so normal checkouts and linked worktrees use one Docker-visible path.
# Tests may override only the staging parent.
if [[ -n "${PGTAP_STAGING_PARENT:-}" ]]; then
  staging_parent="$PGTAP_STAGING_PARENT"
else
  staging_parent="$(
    git -C "$repository_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
  )" || fail "could not resolve the repository's common Git directory."
fi

[[ -d "$staging_parent" ]] || fail "staging parent does not exist: $staging_parent."

staging_directory="$(mktemp -d "$staging_parent/pgtap-tests.XXXXXX")" \
  || fail "could not create a Docker-visible staging directory."
output_file="$(mktemp "${TMPDIR:-/tmp}/pgtap-output.XXXXXX")" || {
  rm -rf -- "$staging_directory"
  fail "could not create a test-output file."
}

cleanup() {
  case "$staging_directory" in
    "$staging_parent"/pgtap-tests.*)
      rm -rf -- "$staging_directory"
      ;;
  esac
  rm -f -- "$output_file"
}
trap cleanup EXIT

cp -R "$source_tests_directory/." "$staging_directory/"

echo "Database pgTAP inventory: $source_file_count source file(s)."

cd "$repository_root"
set +e
"$supabase_cli" test db "$staging_directory" 2>&1 | tee "$output_file"
pipeline_status=("${PIPESTATUS[@]}")
set -e

runner_status="${pipeline_status[0]:-1}"
tee_status="${pipeline_status[1]:-1}"
(( tee_status == 0 )) || fail "could not capture the Supabase CLI output."

summary_line="$(
  grep -E '^Files=[0-9]+, Tests=[0-9]+,' "$output_file" | tail -n 1 || true
)"

if [[ ! "$summary_line" =~ ^Files=([0-9]+),[[:space:]]Tests=([0-9]+), ]]; then
  fail "missing or malformed Files/Tests summary (Supabase CLI exit $runner_status)."
fi

reported_file_count="${BASH_REMATCH[1]}"
reported_assertion_count="${BASH_REMATCH[2]}"

echo "Database pgTAP summary: source_files=$source_file_count files=$reported_file_count assertions=$reported_assertion_count"

(( runner_status == 0 )) \
  || fail "Supabase CLI exited with status $runner_status."
(( reported_file_count > 0 )) \
  || fail "Supabase CLI reported zero executed test files."
(( reported_assertion_count > 0 )) \
  || fail "Supabase CLI reported zero executed assertions."
(( reported_file_count == source_file_count )) \
  || fail "source inventory has $source_file_count file(s), but Supabase executed $reported_file_count."

missing_files=()
for test_file in "${test_files[@]}"; do
  relative_path="${test_file#"$source_tests_directory"/}"
  if ! grep -F -- "/$relative_path" "$output_file" >/dev/null; then
    missing_files+=("$relative_path")
  fi
done

if (( ${#missing_files[@]} > 0 )); then
  fail "Supabase output omitted: ${missing_files[*]}."
fi

echo "Database pgTAP gate passed: all $reported_file_count files and $reported_assertion_count assertions executed."
