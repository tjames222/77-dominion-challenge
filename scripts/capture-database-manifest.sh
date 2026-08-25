#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "Database manifest capture: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
# shellcheck source=production-backup-common.sh
source "$script_directory/production-backup-common.sh"
query_name="manifest"
output_file=""
database_url_file=""
database_passfile=""
database_url=""
database_client_contract=""
project_ref=""
database_name="postgres"
container_name=""
docker_cli=""
requested_postgres_image=""
psql_cli=""
force_docker_psql=false
postgres_image_id=""

resolve_docker_cli() {
  if [[ -n "$docker_cli" ]]; then
    [[ -x "$docker_cli" && -f "$docker_cli" && ! -L "$docker_cli" ]] \
      || fail "--docker-bin is not an executable regular file: $docker_cli."
  elif [[ -n "${DOCKER_BIN:-}" ]]; then
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
    --db-url-file)
      (( $# >= 2 )) || fail "--db-url-file requires a private file."
      database_url_file="$2"
      shift 2
      ;;
    --database-client-contract)
      (( $# >= 2 )) || fail "--database-client-contract requires a value."
      database_client_contract="$2"
      shift 2
      ;;
    --database-passfile)
      (( $# >= 2 )) || fail "--database-passfile requires a private pgpass file."
      database_passfile="$2"
      shift 2
      ;;
    --project-ref)
      (( $# >= 2 )) || fail "--project-ref requires a value."
      project_ref="$2"
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
    --postgres-image-id)
      (( $# >= 2 )) || fail "--postgres-image-id requires an exact image ID."
      postgres_image_id="$2"
      shift 2
      ;;
    --docker-bin)
      (( $# >= 2 )) || fail "--docker-bin requires an exact executable path."
      docker_cli="$2"
      shift 2
      ;;
    --postgres-image)
      (( $# >= 2 )) || fail "--postgres-image requires an exact image ref."
      requested_postgres_image="$2"
      shift 2
      ;;
    *)
      fail "unsupported argument: $1"
      ;;
  esac
done

[[ -n "$output_file" ]] || fail \
  "usage: $0 --output <path> [--db-url-file <passwordless-url-file> --database-passfile <pgpass-file> --project-ref <20-char-ref> [--docker-psql --postgres-image-id sha256:<64hex> | --docker-bin <absolute-path> --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141 --postgres-image-id sha256:<64hex>] | --database <name>] [--fingerprint]."
[[ "$database_name" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] \
  || fail "database names may contain letters, digits, underscores, dots, and hyphens only."
if [[ -n "$database_url_file" && ( -n "$container_name" || "$database_name" != "postgres" ) ]]; then
  fail "--db-url-file cannot be combined with --container or --database."
fi
if [[ -n "$database_url_file" && -z "$database_passfile" ]] \
  || [[ -z "$database_url_file" && -n "$database_passfile" ]]; then
  fail "--db-url-file and --database-passfile are required together."
fi
if [[ -n "$database_url_file" && ! "$project_ref" =~ ^[a-z0-9]{20}$ ]]; then
  fail "remote capture requires an exact 20-character --project-ref."
fi
if [[ -z "$database_url_file" && -n "$project_ref" ]]; then
  fail "--project-ref is only valid with --db-url-file."
fi
if [[ "$force_docker_psql" == "true" && -z "$database_url_file" ]]; then
  fail "--docker-psql requires --db-url-file and --database-passfile."
fi
if [[ -n "$postgres_image_id" \
  && ! "$postgres_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  fail "--postgres-image-id must be sha256 plus 64 lowercase hexadecimal characters."
fi
if [[ -z "$database_url_file" && -n "$postgres_image_id" ]]; then
  fail "--postgres-image-id is only valid with remote --db-url-file capture."
fi
if [[ -n "$docker_cli" || -n "$requested_postgres_image" ]]; then
  [[ -n "$docker_cli" && -n "$requested_postgres_image" \
    && -n "$postgres_image_id" ]] || fail \
    "explicit Docker capture requires --docker-bin, --postgres-image, and --postgres-image-id together."
  case "$docker_cli" in
    /*) ;;
    *) fail "--docker-bin must be an absolute path." ;;
  esac
  [[ "$requested_postgres_image" \
    == "public.ecr.aws/supabase/postgres:17.6.1.141" ]] || fail \
    "--postgres-image must be exactly public.ecr.aws/supabase/postgres:17.6.1.141."
  force_docker_psql=true
fi
if [[ -n "$database_client_contract" \
  && "$database_client_contract" != "exact-docker-pgpass/v1" ]]; then
  fail "--database-client-contract must be exactly exact-docker-pgpass/v1."
fi
if [[ -n "$database_client_contract" && "$force_docker_psql" != "true" ]]; then
  fail "exact-docker-pgpass/v1 requires the complete explicit Docker/image boundary."
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

if [[ -n "$database_url_file" ]]; then
  production_backup_reject_ambient_database_environment
  production_backup_reject_ambient_runtime_environment
  database_url="$(
    node "$script_directory/validate-postgres-credentials.mjs" \
      --database-url-file "$database_url_file" \
      --database-passfile "$database_passfile" \
      --project-ref "$project_ref"
  )" || fail "database credential validation failed."
  if [[ "$force_docker_psql" == "false" ]]; then
    if [[ -n "${PSQL_BIN:-}" ]]; then
      [[ -x "$PSQL_BIN" ]] || fail "PSQL_BIN is not executable: $PSQL_BIN."
      psql_cli="$PSQL_BIN"
    elif command -v psql >/dev/null 2>&1; then
      psql_cli="$(command -v psql)"
    fi
  fi
  if [[ -z "$psql_cli" ]]; then
    [[ -n "$postgres_image_id" ]] || fail \
      "Docker psql requires --postgres-image-id; the helper never pulls or trusts a mutable tag."
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
    if [[ -n "$requested_postgres_image" \
      && "$requested_postgres_image" != "$postgres_image_ref" ]]; then
      fail "the explicit PostgreSQL image does not match the pinned repository image."
    fi
    production_backup_require_local_docker_context "$docker_cli"
    actual_postgres_image_id="$(
      "$docker_cli" image inspect "$postgres_image_ref" --format '{{.Id}}'
    )" || fail "the pinned PostgreSQL image is not present locally."
    [[ "$actual_postgres_image_id" == "$postgres_image_id" ]] || fail \
      "the pinned PostgreSQL tag does not resolve to the approved image ID."
    case "$database_passfile" in
      /*) ;;
      *) fail "database passfile must be an absolute path." ;;
    esac
    case "$database_passfile" in
      *,*) fail "database passfile path cannot contain a comma." ;;
    esac

    "$docker_cli" run \
      --rm \
      --pull never \
      --network bridge \
      --log-driver none \
      --interactive \
      --env PGAPPNAME=77dc-baseline-manifest-read-only \
      --env PGPASSWORD= \
      --env PGPASSFILE=/dominion-private/pgpass \
      --mount "type=bind,source=$database_passfile,target=/dominion-private/pgpass,readonly" \
      --entrypoint psql \
      "$postgres_image_id" \
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
    env -i \
      PATH="$PATH" \
      PGAPPNAME="77dc-baseline-manifest-read-only" \
      PGPASSFILE="$database_passfile" \
      PGSSLMODE="require" \
      "$psql_cli" --dbname "$database_url" \
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
