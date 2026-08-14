#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Local SQL runner: $1" >&2
  exit 1
}

(( $# == 1 )) || fail "usage: scripts/run-local-sql.sh <sql-file>"

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
sql_file="$1"
[[ -f "$sql_file" ]] || fail "SQL file does not exist: $sql_file."

config_file="$repository_root/supabase/config.toml"
[[ -f "$config_file" ]] || fail "missing $config_file."

project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' "$config_file" | head -n 1)"
db_port="$(awk '
  /^\[db\]$/ { in_db = 1; next }
  /^\[/ { in_db = 0 }
  in_db && /^port = [0-9]+$/ {
    sub(/^port = /, "")
    print
    exit
  }
' "$config_file")"
[[ -n "$project_id" ]] || fail "could not resolve the local project ID."
[[ "$db_port" =~ ^[0-9]+$ ]] || fail "could not resolve the local database port."

if [[ -n "${PSQL_BIN:-}" ]]; then
  [[ -x "$PSQL_BIN" ]] || fail "PSQL_BIN is not executable: $PSQL_BIN."
  psql_cli="$PSQL_BIN"
elif command -v psql >/dev/null 2>&1; then
  psql_cli="$(command -v psql)"
else
  psql_cli=""
fi

if [[ -n "$psql_cli" ]]; then
  PGPASSWORD=postgres "$psql_cli" \
    --host 127.0.0.1 \
    --port "$db_port" \
    --username postgres \
    --dbname postgres \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --single-transaction \
    --file "$sql_file"
  exit 0
fi

if [[ -n "${DOCKER_BIN:-}" ]]; then
  [[ -x "$DOCKER_BIN" ]] || fail "DOCKER_BIN is not executable: $DOCKER_BIN."
  docker_cli="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  docker_cli="$(command -v docker)"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  docker_cli="/opt/homebrew/bin/docker"
else
  fail "psql or Docker is required."
fi

database_container="${SUPABASE_DB_CONTAINER:-supabase_db_${project_id}}"
"$docker_cli" exec -i "$database_container" \
  psql \
  --username postgres \
  --dbname postgres \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --single-transaction \
  <"$sql_file"
