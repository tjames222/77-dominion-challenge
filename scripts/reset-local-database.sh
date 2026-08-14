#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Atomic local reset: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"

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

seed_database=true
target_version=""
database_only_runtime_check=false
while (( $# > 0 )); do
  case "$1" in
    --database-only-runtime-check)
      database_only_runtime_check=true
      shift
      ;;
    --no-seed)
      seed_database=false
      shift
      ;;
    --version)
      (( $# >= 2 )) || fail "--version requires a migration version."
      target_version="$2"
      shift 2
      ;;
    *)
      fail "unsupported argument: $1"
      ;;
  esac
done

if [[ -n "$target_version" && ! "$target_version" =~ ^[0-9]+$ ]]; then
  fail "--version must contain digits only."
fi
if [[ -n "$target_version" && "$seed_database" == "true" ]]; then
  fail "seeding a partial migration target is not supported; pass --no-seed."
fi

node "$repository_root/scripts/check-migration-compatibility.mjs"

staging_root="$(mktemp -d "${TMPDIR:-/tmp}/atomic-migrations.XXXXXX")"
cleanup() {
  rm -rf -- "$staging_root"
}
trap cleanup EXIT

mkdir -p "$staging_root/supabase/migrations"
mkdir -p "$staging_root/supabase/.temp"
mkdir -p "$staging_root/application-migrations"
cp "$repository_root/supabase/config.toml" "$staging_root/supabase/config.toml"

postgres_version_file="$repository_root/supabase/.temp/postgres-version"
[[ -f "$postgres_version_file" ]] \
  || fail "missing exact Postgres image pin: $postgres_version_file."
expected_postgres_image="$(tr -d '\r\n' <"$postgres_version_file")"
[[ "$expected_postgres_image" == "17.6.1.141" ]] \
  || fail "expected Postgres image 17.6.1.141, found $expected_postgres_image."
postgres_image_registry="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}"
postgres_image_registry="${postgres_image_registry%/}"
[[ -n "$postgres_image_registry" ]] || fail "Postgres image registry cannot be empty."
expected_postgres_image_ref="$postgres_image_registry/supabase/postgres:$expected_postgres_image"
cp "$postgres_version_file" "$staging_root/supabase/.temp/postgres-version"

if [[ -n "${DOCKER_BIN:-}" ]]; then
  [[ -x "$DOCKER_BIN" ]] || fail "DOCKER_BIN is not executable: $DOCKER_BIN."
  docker_cli="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  docker_cli="$(command -v docker)"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  docker_cli="/opt/homebrew/bin/docker"
else
  fail "Docker is required to verify the exact local Postgres image."
fi

project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ -n "$project_id" ]] || fail "could not resolve the local project ID."
database_container="supabase_db_${project_id}"
actual_postgres_image="$($docker_cli inspect "$database_container" \
  --format '{{.Config.Image}}')"
[[ "$actual_postgres_image" == "$expected_postgres_image_ref" ]] \
  || fail "expected running Postgres image $expected_postgres_image_ref, found $actual_postgres_image."

copied=0
target_found=false
while IFS= read -r migration_file; do
  filename="${migration_file##*/}"
  version="${filename%%_*}"
  if [[ -n "$target_version" && "$version" > "$target_version" ]]; then
    continue
  fi
  if [[ "$version" == "$target_version" ]]; then
    target_found=true
  fi
  cp "$migration_file" "$staging_root/application-migrations/$filename"
  copied=$((copied + 1))
done < <(
  find "$repository_root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print \
    | LC_ALL=C sort
)
(( copied > 0 )) || fail "no migrations were selected."
if [[ -n "$target_version" && "$target_found" != "true" ]]; then
  fail "migration version $target_version does not exist."
fi

# CLI 2.109's Go-backed db reset runner executes a pgx pipeline. The pipeline
# rolls SQL back on failure, but it does not provide an explicit transaction for
# transaction-only statements such as LOCK TABLE. Use it only to restore the
# Supabase-managed platform schemas to an empty application-migration history.
"$supabase_cli" db reset --local --no-seed --workdir "$staging_root"

actual_postgres_image="$($docker_cli inspect "$database_container" \
  --format '{{.Config.Image}}')"
[[ "$actual_postgres_image" == "$expected_postgres_image_ref" ]] \
  || fail "expected Postgres image $expected_postgres_image_ref after reset, found $actual_postgres_image."
server_version_num="$($docker_cli exec "$database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align \
  --command 'show server_version_num')"
[[ "$server_version_num" == "170006" ]] \
  || fail "expected PostgreSQL server version 17.6, found $server_version_num."

# CLI 2.109's TypeScript migration-up engine explicitly wraps every compatible
# migration plus its history INSERT in one BEGIN/COMMIT. The static gate rejects
# statements that would force that engine to flush and run outside the transaction.
cp "$staging_root"/application-migrations/*.sql "$staging_root/supabase/migrations/"
"$supabase_cli" migration up --local --workdir "$staging_root"

if [[ "$seed_database" == "true" ]]; then
  bash "$repository_root/scripts/run-local-sql.sh" \
    "$repository_root/supabase/seed.sql"
fi

runtime_check_arguments=()
if [[ "$database_only_runtime_check" == "true" ]]; then
  runtime_check_arguments+=(--database-only)
fi
bash "$repository_root/scripts/verify-local-supabase-runtime.sh" \
  "${runtime_check_arguments[@]}"

echo "Atomic local reset passed: migration SQL and history were committed together."
