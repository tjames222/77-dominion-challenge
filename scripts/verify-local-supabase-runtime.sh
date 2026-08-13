#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Local Supabase runtime: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"

if [[ -n "${DOCKER_BIN:-}" ]]; then
  [[ -x "$DOCKER_BIN" ]] || fail "DOCKER_BIN is not executable: $DOCKER_BIN."
  docker_cli="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  docker_cli="$(command -v docker)"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  docker_cli="/opt/homebrew/bin/docker"
else
  fail "Docker is required."
fi

postgres_version_file="$repository_root/supabase/.temp/postgres-version"
[[ -f "$postgres_version_file" ]] \
  || fail "missing exact Postgres image pin: $postgres_version_file."
postgres_image_version="$(tr -d '\r\n' <"$postgres_version_file")"
[[ "$postgres_image_version" == "17.6.1.141" ]] \
  || fail "expected Postgres image 17.6.1.141, found $postgres_image_version."
expected_postgres_image_ref="public.ecr.aws/supabase/postgres:$postgres_image_version"

project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ -n "$project_id" ]] || fail "could not resolve the local project ID."

database_container="supabase_db_${project_id}"
actual_postgres_image="$($docker_cli inspect "$database_container" \
  --format '{{.Config.Image}}')"
[[ "$actual_postgres_image" == "$expected_postgres_image_ref" ]] \
  || fail "expected $expected_postgres_image_ref, found $actual_postgres_image."

server_version_num="$($docker_cli exec "$database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align \
  --command 'show server_version_num')"
[[ "$server_version_num" == "170006" ]] \
  || fail "expected PostgreSQL server version 17.6, found $server_version_num."

edge_container="supabase_edge_runtime_${project_id}"
functions_root="$(realpath "$repository_root/supabase/functions")"
edge_functions_destination="$($docker_cli inspect "$edge_container" \
  --format '{{range .Mounts}}{{printf "%s\t%s\n" .Source .Destination}}{{end}}' \
  | awk -F '\t' -v source="$functions_root" '$1 == source { print $2; exit }')"
[[ -n "$edge_functions_destination" ]] \
  || fail "Edge Runtime is not mounted from $functions_root."

edge_probe_directory="$(mktemp -d "${TMPDIR:-/tmp}/edge-function-probe.XXXXXX")"
edge_probe="$edge_probe_directory/index.ts"
cleanup() {
  rm -rf -- "$edge_probe_directory"
}
trap cleanup EXIT
if ! "$docker_cli" cp \
  "$edge_container:$edge_functions_destination/stripe-webhook/index.ts" \
  "$edge_probe"; then
  fail "Edge Runtime cannot read the repository function source."
fi
cmp -s "$functions_root/stripe-webhook/index.ts" "$edge_probe" \
  || fail "Edge Runtime function source does not match the repository."

echo "Local Supabase runtime passed: exact Postgres image and repository Edge mount are active."
