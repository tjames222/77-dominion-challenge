#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Database manifest capture: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
query_name="manifest"
output_file=""
database_url=""
database_name="postgres"
container_name=""
docker_cli=""
psql_cli=""
force_docker_psql=false

resolve_docker_cli() {
  if [[ -n "${DOCKER_BIN:-}" ]]; then
    [[ -x "$DOCKER_BIN" ]] || fail "DOCKER_BIN is not executable: $DOCKER_BIN."
    docker_cli="$DOCKER_BIN"
  elif command -v docker >/dev/null 2>&1; then
    docker_cli="$(command -v docker)"
  elif [[ -x /opt/homebrew/bin/docker ]]; then
    docker_cli="/opt/homebrew/bin/docker"
  else
    return 1
  fi
}

while (( $# > 0 )); do
  case "$1" in
    --output)
      (( $# >= 2 )) || fail "--output requires a path."
      output_file="$2"
      shift 2
      ;;
    --db-url)
      (( $# >= 2 )) || fail "--db-url requires a PostgreSQL URL."
      database_url="$2"
      shift 2
      ;;
    --database)
      (( $# >= 2 )) || fail "--database requires a database name."
      database_name="$2"
      shift 2
      ;;
    --container)
      (( $# >= 2 )) || fail "--container requires a Docker container name."
      container_name="$2"
      shift 2
      ;;
    --fingerprint)
      query_name="fingerprint"
      shift
      ;;
    --docker-psql)
      force_docker_psql=true
      shift
      ;;
    *)
      fail "unsupported argument: $1"
      ;;
  esac
done

[[ -n "$output_file" ]] || fail \
  "usage: $0 --output <path> [--db-url <url> [--docker-psql] | --database <name>] [--fingerprint]."
[[ "$database_name" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] \
  || fail "database names may contain letters, digits, underscores, dots, and hyphens only."
if [[ -n "$database_url" && ( -n "$container_name" || "$database_name" != "postgres" ) ]]; then
  fail "--db-url cannot be combined with --container or --database."
fi
if [[ "$force_docker_psql" == "true" && -z "$database_url" ]]; then
  fail "--docker-psql requires --db-url."
fi

case "$query_name" in
  manifest)
    sql_file="$script_directory/database-manifest.sql"
    ;;
  fingerprint)
    sql_file="$script_directory/baseline-data-fingerprint.sql"
    ;;
esac
[[ -f "$sql_file" ]] || fail "missing query: $sql_file."

output_directory="$(dirname "$output_file")"
mkdir -p "$output_directory"
temporary_output="$(mktemp "$output_directory/.database-manifest.XXXXXX")"
cleanup() {
  rm -f -- "$temporary_output"
}
trap cleanup EXIT

if [[ -n "$database_url" ]]; then
  if [[ "$force_docker_psql" == "false" ]]; then
    if [[ -n "${PSQL_BIN:-}" ]]; then
      [[ -x "$PSQL_BIN" ]] || fail "PSQL_BIN is not executable: $PSQL_BIN."
      psql_cli="$PSQL_BIN"
    elif command -v psql >/dev/null 2>&1; then
      psql_cli="$(command -v psql)"
    fi
  fi
  if [[ -z "$psql_cli" ]]; then
    resolve_docker_cli \
      || fail "psql or Docker is required for --db-url capture."
    postgres_version_file="$repository_root/supabase/.temp/postgres-version"
    [[ -f "$postgres_version_file" ]] \
      || fail "missing pinned Postgres version: $postgres_version_file."
    postgres_image_version="$(tr -d '\r\n' <"$postgres_version_file")"
    [[ "$postgres_image_version" == "17.6.1.141" ]] \
      || fail "expected pinned Postgres image 17.6.1.141, found $postgres_image_version."
    postgres_image_registry="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}"
    postgres_image_registry="${postgres_image_registry%/}"
    [[ -n "$postgres_image_registry" ]] \
      || fail "Postgres image registry cannot be empty."
    postgres_image_ref="${postgres_image_registry}/supabase/postgres:${postgres_image_version}"

    "$docker_cli" run \
      --rm \
      --interactive \
      --env PGAPPNAME=77dc-baseline-manifest-read-only \
      --entrypoint psql \
      "$postgres_image_ref" \
      "$database_url" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1 \
        --file - \
      <"$sql_file" \
      >"$temporary_output"

    psql_cli=""
  fi

  if [[ -n "$psql_cli" ]]; then
    PGAPPNAME="77dc-baseline-manifest-read-only" \
      "$psql_cli" "$database_url" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1 \
        --file "$sql_file" \
        >"$temporary_output"
  fi
else
  config_file="$repository_root/supabase/config.toml"
  [[ -f "$config_file" ]] || fail "missing $config_file."
  project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' "$config_file" | head -n 1)"
  [[ -n "$project_id" ]] || fail "could not resolve the local project ID."
  if [[ -z "$container_name" ]]; then
    container_name="supabase_db_${project_id}"
  fi
  [[ "$container_name" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] \
    || fail "container names may contain letters, digits, underscores, dots, and hyphens only."

  resolve_docker_cli \
    || fail "Docker is required for local capture when psql is unavailable."

  "$docker_cli" exec \
      --env PGAPPNAME=77dc-baseline-manifest-read-only \
      -i "$container_name" \
      psql \
        --username postgres \
        --dbname "$database_name" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1 \
        --file - \
      <"$sql_file" \
      >"$temporary_output"
fi

[[ -s "$temporary_output" ]] || fail "capture returned no records."
node "$script_directory/compare-database-manifests.mjs" \
  --validate "$temporary_output"
mv -- "$temporary_output" "$output_file"
trap - EXIT

echo "Captured $query_name records at $output_file."
