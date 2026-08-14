#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Local production rehearsal: $1" >&2
  exit 1
}

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"

[[ "${DOMINION_ALLOW_LOCAL_RESET:-}" == "true" ]] || fail \
  "set DOMINION_ALLOW_LOCAL_RESET=true to acknowledge the clean local database reset."

if [[ -n "${SUPABASE_CLI_BIN:-}" ]]; then
  supabase_cli="$SUPABASE_CLI_BIN"
elif [[ -x "$repository_root/node_modules/.bin/supabase" ]]; then
  supabase_cli="$repository_root/node_modules/.bin/supabase"
else
  fail "the pinned local Supabase CLI is required. Run pnpm install --frozen-lockfile."
fi

[[ "$($supabase_cli --version)" == "2.109.0" ]] || fail \
  "Supabase CLI 2.109.0 is required."

if [[ -n "${LOCAL_DOCKER_BIN:-}" ]]; then
  local_docker_bin="$LOCAL_DOCKER_BIN"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  local_docker_bin=/opt/homebrew/bin/docker
elif command -v docker >/dev/null 2>&1; then
  local_docker_bin="$(command -v docker)"
else
  fail "Docker is required to seed disposable local membership fixtures."
fi
[[ -x "$local_docker_bin" ]] || fail "LOCAL_DOCKER_BIN must be an executable file."

local_postgres_container="${LOCAL_POSTGRES_CONTAINER:-supabase_db_77-dominion-challenge}"
[[ "$local_postgres_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail \
  "LOCAL_POSTGRES_CONTAINER is not a valid container name."

export SUPABASE_TELEMETRY_DISABLED=1

if ! "$supabase_cli" status --workdir "$repository_root" >/dev/null 2>&1; then
  bash "$repository_root/scripts/start-local-database.sh"
fi
bash "$repository_root/scripts/reset-local-database.sh"
"$local_docker_bin" container inspect "$local_postgres_container" >/dev/null 2>&1 || fail \
  "the expected local Postgres container is not running."

status_file="$(mktemp "${TMPDIR:-/tmp}/dominion-local-stack.XXXXXX")"
chmod 600 "$status_file"
cleanup() {
  rm -f -- "$status_file"
}
trap cleanup EXIT

"$supabase_cli" status --workdir "$repository_root" -o env >"$status_file"

status_value() {
  variable_name="$1"
  sed -n "s/^${variable_name}=\"\(.*\)\"$/\1/p" "$status_file" | head -n 1
}

local_supabase_url="$(status_value API_URL)"
local_anon_key="$(status_value ANON_KEY)"
local_service_role_key="$(status_value SERVICE_ROLE_KEY)"

[[ -n "$local_supabase_url" ]] || fail "the local API URL was not reported."
[[ -n "$local_anon_key" ]] || fail "the local anonymous key was not reported."
[[ -n "$local_service_role_key" ]] || fail "the local service-role key was not reported."
case "$local_supabase_url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) fail "refusing a non-local Supabase URL." ;;
esac

(
  cd "$repository_root"
  VITE_ENABLE_MOCKS=false \
  VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS=false \
  VITE_ENABLE_PRODUCTION_CONNECTIONS=true \
  VITE_ENABLE_GROUP_INTEGRATIONS=false \
  VITE_SUPABASE_URL="$local_supabase_url" \
  VITE_SUPABASE_PUBLISHABLE_KEY="$local_anon_key" \
  pnpm run build

  LOCAL_SUPABASE_URL="$local_supabase_url" \
  LOCAL_SUPABASE_ANON_KEY="$local_anon_key" \
  LOCAL_SUPABASE_SERVICE_ROLE_KEY="$local_service_role_key" \
  LOCAL_DOCKER_BIN="$local_docker_bin" \
  LOCAL_POSTGRES_CONTAINER="$local_postgres_container" \
  pnpm exec playwright test --config=playwright.local-production.config.mjs
)

echo "Local production rehearsal passed with browser mocks disabled."
