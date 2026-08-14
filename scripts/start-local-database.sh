#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Atomic local start: $1" >&2
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

node "$repository_root/scripts/check-migration-compatibility.mjs"

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

project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' \
  "$repository_root/supabase/config.toml" | head -n 1)"
[[ -n "$project_id" ]] || fail "could not resolve the local project ID."
database_container="supabase_db_${project_id}"
database_volume="supabase_db_${project_id}"

staging_root=""
owns_database=false
cleanup() {
  exit_status=$?
  trap - EXIT
  if (( exit_status != 0 )) && [[ "$owns_database" == "true" ]]; then
    "$supabase_cli" stop --project-id "$project_id" --no-backup \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "$staging_root" ]]; then
    rm -rf -- "$staging_root"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

container_exists=false
if "$docker_cli" inspect "$database_container" >/dev/null 2>&1; then
  container_exists=true
fi

volume_exists=false
if "$docker_cli" volume inspect "$database_volume" >/dev/null 2>&1; then
  volume_exists=true
fi

if [[ "$container_exists" == "true" ]]; then
  # This stack belongs to the developer. Verify it before any mutating CLI call,
  # and never stop or reset it from the failure trap.
  actual_postgres_image="$($docker_cli inspect "$database_container" \
    --format '{{.Config.Image}}')"
  [[ "$actual_postgres_image" == "$expected_postgres_image_ref" ]] \
    || fail "existing stack uses $actual_postgres_image; expected $expected_postgres_image_ref. It was not changed."
elif [[ "$volume_exists" == "true" ]]; then
  fail "found preserved database volume $database_volume without a container; refusing to infer its image version or change it. Remove it explicitly before a fresh start."
else
  # Starting directly from a fresh repository makes CLI 2.109 apply application
  # SQL through its Go pgx-pipeline runner. Bootstrap only the exact-version DB
  # from a staged config with migrations and seed disabled, then retain its empty
  # volume for the full repository start. This helper owns only this fresh volume.
  staging_root="$(mktemp -d "${TMPDIR:-/tmp}/supabase-platform-bootstrap.XXXXXX")"
  owns_database=true
  mkdir -p "$staging_root/supabase/migrations"
  mkdir -p "$staging_root/supabase/.temp"
  cp "$postgres_version_file" "$staging_root/supabase/.temp/postgres-version"

  awk '
    /^\[db\.migrations\]$/ { section = "migrations"; print; next }
    /^\[db\.seed\]$/ { section = "seed"; print; next }
    /^\[/ { section = "" }
    (section == "migrations" || section == "seed") && /^enabled = / {
      print "enabled = false"
      next
    }
    { print }
  ' "$repository_root/supabase/config.toml" >"$staging_root/supabase/config.toml"

  grep -A2 '^\[db\.migrations\]$' "$staging_root/supabase/config.toml" \
    | grep -Fqx 'enabled = false' \
    || fail "failed to disable migrations in the database bootstrap config."
  grep -A2 '^\[db\.seed\]$' "$staging_root/supabase/config.toml" \
    | grep -Fqx 'enabled = false' \
    || fail "failed to disable seed in the database bootstrap config."

  "$supabase_cli" db start --workdir "$staging_root"

  actual_postgres_image="$($docker_cli inspect "$database_container" \
    --format '{{.Config.Image}}')"
  [[ "$actual_postgres_image" == "$expected_postgres_image_ref" ]] \
    || fail "expected $expected_postgres_image_ref, found $actual_postgres_image."

  # Remove only the database container while retaining the volume this helper
  # just created. The full start sees that volume and skips Go migration/seed.
  "$supabase_cli" stop --workdir "$staging_root"
fi

start_arguments=(--workdir "$repository_root")
if [[ "${CI:-}" == "true" ]]; then
  # The hosted runner can reserve Mailpit's default web port (54324). Database,
  # Auth, Storage, Realtime, Edge Runtime, and the API remain in the CI stack;
  # only the optional local mail viewer is omitted from this database job.
  start_arguments=(--exclude inbucket "${start_arguments[@]}")
fi
"$supabase_cli" start "${start_arguments[@]}"
bash "$repository_root/scripts/verify-local-supabase-runtime.sh"

if [[ "$owns_database" == "true" ]]; then
  # Defense in depth: the preserved empty volume must make the repository start
  # skip CLI 2.109's Go migration path. Prove that before the TS executor runs.
  fresh_history_relation="$($docker_cli exec "$database_container" \
    psql --username postgres --dbname postgres --tuples-only --no-align \
    --command "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"
  fresh_history_count=0
  if [[ -n "$fresh_history_relation" ]]; then
    fresh_history_count="$($docker_cli exec "$database_container" \
      psql --username postgres --dbname postgres --tuples-only --no-align \
      --command 'select count(*) from supabase_migrations.schema_migrations')"
  fi
  [[ "$fresh_history_count" == "0" ]] \
    || fail "fresh full start unexpectedly recorded $fresh_history_count application migration(s)."

  late_app_object="$($docker_cli exec "$database_container" \
    psql --username postgres --dbname postgres --tuples-only --no-align \
    --command "select coalesce(to_regclass('private.reward_offer_codes')::text, '')")"
  [[ -z "$late_app_object" ]] \
    || fail "fresh full start unexpectedly applied application SQL before migration up."
fi

# CLI 2.109's migration-up engine explicitly owns one transaction containing
# each compatible migration's SQL and history insert. Seed is idempotent and is
# kept in its own all-or-nothing local transaction.
"$supabase_cli" migration up --local --workdir "$repository_root"
bash "$repository_root/scripts/run-local-sql.sh" \
  "$repository_root/supabase/seed.sql"

expected_migrations="$(find "$repository_root/supabase/migrations" \
  -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
actual_migrations="$($docker_cli exec "$database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align \
  --command 'select count(*) from supabase_migrations.schema_migrations')"
[[ "$actual_migrations" == "$expected_migrations" ]] \
  || fail "expected $expected_migrations migration rows, found $actual_migrations."

fixture_users="$($docker_cli exec "$database_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align \
  --command "select count(*) from auth.users where email like '%@example.test'")"
[[ "$fixture_users" == "3" ]] \
  || fail "expected three local fixture users, found $fixture_users."

echo "Atomic local start passed: exact-version services, migrations, seed, and Edge mounts are ready."
