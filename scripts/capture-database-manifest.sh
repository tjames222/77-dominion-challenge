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
database_host=""
ssl_root_cert_file=""
ssl_root_cert_file_sha256=""
url_ssl_root_cert_file=""
database_url=""
database_client_contract=""
project_ref=""
database_name="postgres"
container_name=""
docker_cli=""
docker_cli_sha256=""
docker_socket=""
docker_socket_device=""
docker_socket_inode=""
docker_socket_owner_uid=""
docker_socket_owner_mode=""
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
    --database-host)
      (( $# >= 2 )) || fail "--database-host requires a value."
      database_host="$2"
      shift 2
      ;;
    --ssl-root-cert-file)
      (( $# >= 2 )) || fail "--ssl-root-cert-file requires a value."
      ssl_root_cert_file="$2"
      shift 2
      ;;
    --ssl-root-cert-file-sha256)
      (( $# >= 2 )) || fail "--ssl-root-cert-file-sha256 requires a value."
      ssl_root_cert_file_sha256="$2"
      shift 2
      ;;
    --url-ssl-root-cert-file)
      (( $# >= 2 )) || fail "--url-ssl-root-cert-file requires a value."
      url_ssl_root_cert_file="$2"
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
    --docker-bin-sha256)
      (( $# >= 2 )) || fail "--docker-bin-sha256 requires an exact hash."
      docker_cli_sha256="$2"
      shift 2
      ;;
    --docker-socket)
      (( $# >= 2 )) || fail "--docker-socket requires an exact path."
      docker_socket="$2"
      shift 2
      ;;
    --docker-socket-device)
      (( $# >= 2 )) || fail "--docker-socket-device requires a value."
      docker_socket_device="$2"
      shift 2
      ;;
    --docker-socket-inode)
      (( $# >= 2 )) || fail "--docker-socket-inode requires a value."
      docker_socket_inode="$2"
      shift 2
      ;;
    --docker-socket-owner-uid)
      (( $# >= 2 )) || fail "--docker-socket-owner-uid requires a value."
      docker_socket_owner_uid="$2"
      shift 2
      ;;
    --docker-socket-owner-mode)
      (( $# >= 2 )) || fail "--docker-socket-owner-mode requires a value."
      docker_socket_owner_mode="$2"
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
if [[ -n "$database_url_file" ]]; then
  [[ "$database_host" =~ ^[a-z0-9-]+\.pooler\.supabase\.com$ ]] \
    || fail "remote capture requires the exact dashboard --database-host."
  [[ -n "$ssl_root_cert_file" && -n "$ssl_root_cert_file_sha256" \
    && -n "$url_ssl_root_cert_file" ]] \
    || fail "remote capture requires the pinned TLS root certificate contract."
  case "$ssl_root_cert_file" in
    *,*) fail "TLS root certificate path cannot contain a comma." ;;
  esac
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
    && -n "$postgres_image_id" && -n "$docker_cli_sha256" ]] || fail \
    "explicit Docker capture requires --docker-bin, --docker-bin-sha256, --postgres-image, and --postgres-image-id together."
  case "$docker_cli" in
    /*) ;;
    *) fail "--docker-bin must be an absolute path." ;;
  esac
  [[ "$requested_postgres_image" \
    == "public.ecr.aws/supabase/postgres:17.6.1.141" ]] || fail \
    "--postgres-image must be exactly public.ecr.aws/supabase/postgres:17.6.1.141."
  force_docker_psql=true
fi
if [[ -n "$docker_cli_sha256" && ! "$docker_cli_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  fail "--docker-bin-sha256 must be exactly 64 lowercase hexadecimal characters."
fi
if [[ -n "$database_client_contract" && -z "$docker_cli_sha256" ]]; then
  fail "$DOMINION_DATABASE_CLIENT_CONTRACT requires --docker-bin-sha256."
fi
if [[ -n "$database_client_contract" \
  && "$database_client_contract" != "$DOMINION_DATABASE_CLIENT_CONTRACT" ]]; then
  fail "--database-client-contract must be exactly $DOMINION_DATABASE_CLIENT_CONTRACT."
fi
if [[ -n "$database_client_contract" && "$force_docker_psql" != "true" ]]; then
  fail "$DOMINION_DATABASE_CLIENT_CONTRACT requires the complete explicit Docker/image boundary."
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
container_runtime="$(mktemp -d "$output_directory/.database-manifest-container.XXXXXX")"
container_id_file="$container_runtime/cid"
owned_container_id=""
owned_container_token=""
owned_container_name=""
owned_container_expected_image=""
owned_container_active=false
owned_container_creation_attempted=false
preserve_container_runtime=false
container_recovery_state="$container_runtime/container-recovery.json"
validation_node=""

resolve_local_validation_node() {
  local_node_candidate="${NODE_BIN:-}"
  if [[ -z "$local_node_candidate" ]]; then
    local_node_candidate="$(command -v node 2>/dev/null || true)"
  fi
  [[ -n "$local_node_candidate" && -x "$local_node_candidate" ]] \
    || fail "Node.js is required to validate a local database manifest capture."
  local_node_canonical="$($local_node_candidate -e '
    process.stdout.write(require("node:fs").realpathSync(process.argv[1]));
  ' "$local_node_candidate")" \
    || fail "could not resolve the local Node.js executable."
  [[ -x "$local_node_canonical" && -f "$local_node_canonical" \
    && ! -L "$local_node_canonical" ]] \
    || fail "local Node.js must resolve to an executable regular file."
  local_node_sha256="$(production_backup_sha256_file "$local_node_canonical")"
  production_backup_require_hash "$local_node_sha256" "local Node.js SHA-256"
  local_pinning_helper="$script_directory/pin-production-input.mjs"
  production_backup_hashed_regular_file \
    "$local_pinning_helper" "$(production_backup_sha256_file "$local_pinning_helper")" \
    "input pinning helper"
  local_node_pin_identity="$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$local_node_canonical" "$local_pinning_helper" \
      --source "$local_node_canonical" --sha256 "$local_node_sha256" \
      --destination "$container_runtime/node" --kind executable)" \
    || fail "could not pin the local Node.js executable."
  [[ "$local_node_pin_identity" == "PINNED_INPUT_SHA256=$local_node_sha256" ]] \
    || fail "local Node.js pinning emitted an invalid identity."
  validation_node="$container_runtime/node"
}

if [[ -n "$database_client_contract" ]]; then
  production_backup_hashed_executable \
    "$docker_cli" "$docker_cli_sha256" "Docker CLI"
  pinning_helper="$script_directory/pin-production-input.mjs"
  production_backup_hashed_regular_file \
    "$pinning_helper" "$(production_backup_sha256_file "$pinning_helper")" \
    "input pinning helper"
  pin_identity="$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$NODE_BIN" "$pinning_helper" \
      --source "$docker_cli" --sha256 "$docker_cli_sha256" \
      --destination "$container_runtime/docker" --kind executable)" \
    || fail "could not pin the approved Docker executable."
  [[ "$pin_identity" == "PINNED_INPUT_SHA256=$docker_cli_sha256" ]] \
    || fail "Docker executable pinning emitted an invalid identity."
  docker_cli="$container_runtime/docker"
fi

inspect_owned_client_container() {
  [[ "$owned_container_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  owned_container_snapshot="$($docker_cli container inspect "$owned_container_id" --format \
    '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "com.dominion.production-client"}}|{{index .Config.Labels "com.dominion.project-ref"}}|{{index .Config.Labels "com.dominion.ownership-token"}}|{{index .Config.Labels "com.dominion.operation"}}' \
    2>/dev/null)" || return 1
  [[ "$owned_container_snapshot" \
    == "$owned_container_id|$owned_container_expected_image|$owned_container_expected_image|true|$project_ref|$owned_container_token|database-manifest" ]]
}

adopt_owned_client_container() {
  owned_container_recovery_attempt=0
  while (( owned_container_recovery_attempt < 50 )); do
    owned_container_candidate=""
    if [[ -f "$container_id_file" && ! -L "$container_id_file" \
      && "$(wc -l <"$container_id_file" | tr -d '[:space:]')" == "1" ]]; then
      owned_container_candidate="$(cat "$container_id_file")"
    fi
    if [[ ! "$owned_container_candidate" =~ ^[a-f0-9]{64}$ ]]; then
      owned_container_candidate="$($docker_cli container inspect "$owned_container_name" \
        --format '{{.Id}}' 2>/dev/null || true)"
    fi
    if [[ "$owned_container_candidate" =~ ^[a-f0-9]{64}$ ]]; then
      owned_container_id="$owned_container_candidate"
      if inspect_owned_client_container; then
        owned_container_active=true
        return 0
      fi
    fi
    owned_container_recovery_attempt=$((owned_container_recovery_attempt + 1))
    sleep 0.1
  done
  return 1
}

remove_owned_client_container() {
  inspect_owned_client_container || return 1
  owned_container_cleanup_ok=true
  owned_container_diff_file="$container_runtime/container.diff"
  owned_container_diff_error="$container_runtime/container.diff.stderr"
  : >"$owned_container_diff_file"
  : >"$owned_container_diff_error"
  "$docker_cli" diff "$owned_container_id" \
    >"$owned_container_diff_file" 2>"$owned_container_diff_error" &
  owned_container_diff_pid=$!
  owned_container_diff_wait=0
  while kill -0 "$owned_container_diff_pid" 2>/dev/null \
      && (( owned_container_diff_wait < 50 )); do
    sleep 0.1
    owned_container_diff_wait=$((owned_container_diff_wait + 1))
  done
  if kill -0 "$owned_container_diff_pid" 2>/dev/null; then
    kill -KILL "$owned_container_diff_pid" 2>/dev/null || true
    wait "$owned_container_diff_pid" 2>/dev/null || true
    owned_container_cleanup_ok=false
  elif ! wait "$owned_container_diff_pid"; then
    owned_container_cleanup_ok=false
  elif [[ -s "$owned_container_diff_file" ]]; then
    owned_container_cleanup_ok=false
  fi
  "$docker_cli" rm --force "$owned_container_id" >/dev/null || return 1
  remaining_owned_container="$($docker_cli ps --all --quiet \
    --filter "id=$owned_container_id")" || return 1
  if [[ -n "$remaining_owned_container" ]]; then
    echo "Database manifest capture: owned client still exists after forced removal." >&2
    return 1
  fi
  owned_container_active=false
  owned_container_creation_attempted=false
  if [[ "$owned_container_cleanup_ok" != "true" ]]; then
    preserve_container_runtime=true
    echo "Database manifest capture: owned client overlay evidence was unavailable or nonempty." >&2
  fi
  [[ "$owned_container_cleanup_ok" == "true" ]]
}

cleanup() {
  cleanup_status=$?
  cleanup_failed=false
  trap - EXIT
  # Cleanup is the last holder of the in-memory ownership token. Ignore
  # trappable signals throughout adoption, teardown, absence proof, and the
  # recovery-state decision so a second group signal cannot erase authority.
  trap '' HUP INT QUIT TERM
  if [[ "$owned_container_active" == "true" ]]; then
    if ! remove_owned_client_container; then
      cleanup_status=1
      if [[ "$owned_container_active" == "true" \
        || "$owned_container_creation_attempted" == "true" ]]; then
        preserve_container_runtime=true
      fi
    fi
  elif [[ "$owned_container_creation_attempted" == "true" ]]; then
    if adopt_owned_client_container; then
      if ! remove_owned_client_container; then
        cleanup_status=1
        if [[ "$owned_container_active" == "true" \
          || "$owned_container_creation_attempted" == "true" ]]; then
          preserve_container_runtime=true
        fi
      fi
    else
      echo "Database manifest capture: could not prove cleanup of the attempted client container; preserving recovery authority." >&2
      cleanup_status=1
      preserve_container_runtime=true
    fi
  fi
  if ! /bin/rm -f -- "$temporary_output"; then
    cleanup_failed=true
  fi
  if [[ -e "$temporary_output" || -L "$temporary_output" ]]; then
    cleanup_failed=true
  fi
  if [[ "$preserve_container_runtime" == "true" ]]; then
    echo "Database manifest capture: preserved container recovery state at $container_runtime" >&2
  else
    if ! /bin/rm -rf -- "$container_runtime"; then
      cleanup_failed=true
    fi
    if [[ -e "$container_runtime" || -L "$container_runtime" ]]; then
      cleanup_failed=true
    fi
  fi
  if [[ "$cleanup_failed" == "true" ]]; then
    echo "Database manifest capture: one or more cleanup operations failed." >&2
    cleanup_status=1
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

if [[ -n "$database_url_file" ]]; then
  production_backup_require_clean_environment "$script_directory"
  production_backup_reject_ambient_database_environment
  production_backup_reject_ambient_runtime_environment
  production_backup_require_local_docker_context \
    "$docker_cli" "$docker_socket" "$docker_socket_device" \
    "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"
  validation_node="$NODE_BIN"
  database_url="$(
    "$NODE_BIN" "$script_directory/validate-postgres-credentials.mjs" \
      --database-url-file "$database_url_file" \
      --database-passfile "$database_passfile" \
      --database-host "$database_host" \
      --project-ref "$project_ref" \
      --ssl-root-cert-file "$ssl_root_cert_file" \
      --ssl-root-cert-file-sha256 "$ssl_root_cert_file_sha256" \
      --url-ssl-root-cert-file "$url_ssl_root_cert_file"
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
    production_backup_require_local_docker_context \
      "$docker_cli" "$docker_socket" "$docker_socket_device" \
      "$docker_socket_inode" "$docker_socket_owner_uid" "$docker_socket_owner_mode"
    existing_client_containers="$($docker_cli ps --all --quiet \
      --filter "label=com.dominion.production-client=true" \
      --filter "label=com.dominion.project-ref=$project_ref")" \
      || fail "could not inspect prior production client containers."
    [[ -z "$existing_client_containers" ]] || fail \
      "an orphaned production client container exists; refusing unowned cleanup."
    actual_postgres_image_id="$(
      "$docker_cli" image inspect "$postgres_image_ref" --format '{{.Id}}'
    )" || fail "the pinned PostgreSQL image is not present locally."
    [[ "$actual_postgres_image_id" == "$postgres_image_id" ]] || fail \
      "the pinned PostgreSQL tag does not resolve to the approved image ID."
    case "$database_passfile" in
      /*) ;;
      *) fail "database passfile must be an absolute path." ;;
    esac
    container_database_url="$("$NODE_BIN" -e '
      const url = new URL(process.argv[1]);
      url.searchParams.set("sslrootcert", "/tmp/dominion/supabase-ca.crt");
      process.stdout.write(url.toString());
    ' "$database_url")" || fail "could not construct the pinned container database URL."
    case "$database_passfile" in
      *,*) fail "database passfile path cannot contain a comma." ;;
    esac

    owned_container_token="$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    [[ "$owned_container_token" =~ ^[a-f0-9]{64}$ ]] \
      || fail "could not create an unguessable container ownership token."
    owned_container_name="dominion-client-${query_name}-${owned_container_token:0:20}"
    owned_container_expected_image="$postgres_image_id"
    if "$docker_cli" container inspect "$owned_container_name" >/dev/null 2>&1; then
      fail "refusing an unexpected pre-existing client container."
    fi

    if ! {
      printf '%s\n' \
        "$owned_container_token" "$owned_container_name" "$container_id_file" \
        "$owned_container_expected_image" "$docker_socket" \
        "$docker_socket_device" "$docker_socket_inode" \
        "$docker_socket_owner_uid" "$docker_socket_owner_mode" \
        "$database_passfile" "$ssl_root_cert_file" "$project_ref" \
        "$query_name" "$$"
    } | "$NODE_BIN" -e '
const { readFileSync, writeFileSync } = require("node:fs");
const output = process.argv[1];
const fields = readFileSync(0, "utf8").trimEnd().split("\n");
if (fields.length !== 14) process.exit(1);
const [ownershipToken, containerName, cidfile, imageId, socketPath,
  socketDevice, socketInode, socketOwnerUid, socketOwnerMode, passfile,
  rootCert, projectRef, queryName, operatorPid] = fields;
const value = {
  schemaVersion: 1,
  artifactContract: "dominion-database-manifest-client-recovery/v1",
  status: "create-pending",
  ownershipToken,
  containerName,
  cidfile,
  imageId,
  projectRef,
  operation: "database-manifest",
  dockerContext: {
    endpoint: `unix://${socketPath}`,
    socketPath,
    device: socketDevice,
    inode: socketInode,
    ownerUid: Number(socketOwnerUid),
    ownerMode: Number(socketOwnerMode),
  },
  mounts: {
    passfile: {
      source: passfile,
      target: "/tmp/dominion/pgpass",
      readOnly: true,
    },
    rootCert: {
      source: rootCert,
      target: "/tmp/dominion/supabase-ca.crt",
      readOnly: true,
    },
  },
  queryName,
  operatorPid: Number(operatorPid),
};
writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
' "$container_recovery_state"
    then
      fail "could not seal client container recovery authority."
    fi
    chmod 600 "$container_recovery_state"

    docker_run_status=0
    owned_container_creation_attempted=true
    "$docker_cli" run \
      --cidfile "$container_id_file" \
      --name "$owned_container_name" \
      --label "com.dominion.production-client=true" \
      --label "com.dominion.project-ref=$project_ref" \
      --label "com.dominion.ownership-token=$owned_container_token" \
      --label "com.dominion.operation=database-manifest" \
      --pull never \
      --network bridge \
      --log-driver none \
      --interactive \
      --read-only \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --user "$(id -u):$(id -g)" \
      --tmpfs "/tmp:rw,nosuid,nodev,noexec,mode=0700" \
      --env PGAPPNAME=77dc-baseline-manifest-read-only \
      --env PGPASSWORD= \
      --env PGPASSFILE=/tmp/dominion/pgpass \
      --env PGSSLMODE=verify-full \
      --env PGSSLROOTCERT=/tmp/dominion/supabase-ca.crt \
      --env PGCONNECT_TIMEOUT=15 \
      --mount "type=bind,source=$database_passfile,target=/tmp/dominion/pgpass,readonly" \
      --mount "type=bind,source=$ssl_root_cert_file,target=/tmp/dominion/supabase-ca.crt,readonly" \
      --entrypoint psql \
      "$postgres_image_id" \
      "$container_database_url" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1 \
        --file - \
      <"$sql_file" \
      >"$temporary_output" || docker_run_status=$?
    adopt_owned_client_container \
      || fail "client container identity could not be adopted for cleanup."
    remove_owned_client_container \
      || fail "owned client container cleanup or overlay verification failed."
    [[ "$docker_run_status" == "0" ]] || fail "Docker psql capture failed."

    psql_cli=""
  fi

  if [[ -n "$psql_cli" ]]; then
    env -i \
      PATH="$PATH" \
      PGAPPNAME="77dc-baseline-manifest-read-only" \
      PGPASSFILE="$database_passfile" \
      PGSSLMODE="verify-full" \
      PGSSLROOTCERT="$ssl_root_cert_file" \
      PGCONNECT_TIMEOUT="15" \
      "$psql_cli" --dbname "$database_url" \
        --no-psqlrc \
        --quiet \
        --set ON_ERROR_STOP=1 \
        --file "$sql_file" \
        >"$temporary_output"
  fi
else
  resolve_local_validation_node
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
[[ -n "$validation_node" ]] || fail "manifest validator Node.js identity is missing."
"$validation_node" "$script_directory/compare-database-manifests.mjs" \
  --validate "$temporary_output"
mv -- "$temporary_output" "$output_file"
rm -rf -- "$container_runtime"
trap - EXIT

echo "Captured $query_name records at $output_file."
