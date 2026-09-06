#!/usr/bin/env bash

# Shared by the production snapshot operator helpers. Keep this file compatible
# with macOS's Bash 3.2: no associative arrays, mapfile, or case conversion.

readonly DOMINION_SUPABASE_CLI_VERSION="2.109.0"
readonly DOMINION_POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.141"
readonly DOMINION_POSTGRES_SERVER_VERSION_NUM="170006"
readonly DOMINION_DATABASE_CLIENT_CONTRACT="exact-supavisor-session-jit-pgpass-verify-full/v2"
readonly DOMINION_CLEAN_ENV_CONTRACT="dominion-production-operator/v1"

production_backup_fail() {
  echo "Production backup operator: $1" >&2
  exit 1
}

production_backup_sha256_file() {
  production_backup_hash_file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$production_backup_hash_file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$production_backup_hash_file" | awk '{print $1}'
  else
    production_backup_fail "shasum or sha256sum is required."
  fi
}

production_backup_require_hash() {
  production_backup_hash_value="$1"
  production_backup_hash_label="$2"
  [[ "$production_backup_hash_value" =~ ^[a-f0-9]{64}$ ]] || production_backup_fail \
    "$production_backup_hash_label must be exactly 64 lowercase hexadecimal characters."
}

production_backup_require_image_id() {
  [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]] || production_backup_fail \
    "the PostgreSQL image ID must be sha256 plus 64 lowercase hexadecimal characters."
}

production_backup_require_absolute_path() {
  production_backup_absolute_path="$1"
  production_backup_absolute_label="$2"
  case "$production_backup_absolute_path" in
    *[[:cntrl:]]*) production_backup_fail \
      "$production_backup_absolute_label cannot contain control characters." ;;
  esac
  case "$production_backup_absolute_path" in
    /*) ;;
    *) production_backup_fail "$production_backup_absolute_label must be an absolute path." ;;
  esac
}

production_backup_require_no_extended_acl() {
  production_backup_acl_path="$1"
  production_backup_acl_label="$2"
  if [[ -x /usr/bin/uname ]]; then
    production_backup_kernel_name="$(/usr/bin/uname -s)"
  elif [[ -x /bin/uname ]]; then
    production_backup_kernel_name="$(/bin/uname -s)"
  else
    production_backup_fail "could not identify the host while inspecting $production_backup_acl_label ACLs."
  fi
  if [[ "$production_backup_kernel_name" == "Darwin" ]]; then
    production_backup_acl_listing="$(LC_ALL=C /bin/ls -lde -- \
      "$production_backup_acl_path" 2>/dev/null)" || production_backup_fail \
      "could not inspect $production_backup_acl_label extended ACLs."
    production_backup_acl_mode="${production_backup_acl_listing%% *}"
    case "$production_backup_acl_listing" in
      *$'\n'*) production_backup_fail \
        "$production_backup_acl_label must not have an extended ACL." ;;
    esac
    case "$production_backup_acl_mode" in
      *+*) production_backup_fail \
        "$production_backup_acl_label must not have an extended ACL." ;;
    esac
  fi
}

production_backup_private_file() {
  production_backup_private_path="$1"
  production_backup_private_label="$2"
  production_backup_require_absolute_path \
    "$production_backup_private_path" "$production_backup_private_label"
  [[ -f "$production_backup_private_path" && ! -L "$production_backup_private_path" ]] \
    || production_backup_fail \
      "$production_backup_private_label must be a regular, non-symlink file."
  [[ -s "$production_backup_private_path" ]] || production_backup_fail \
    "$production_backup_private_label must not be empty."

  if production_backup_private_mode="$(stat -f '%Lp' "$production_backup_private_path" 2>/dev/null)"; then
    :
  elif production_backup_private_mode="$(stat -c '%a' "$production_backup_private_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail "could not inspect $production_backup_private_label permissions."
  fi
  case "$production_backup_private_mode" in
    400|600) ;;
    *) production_backup_fail "$production_backup_private_label permissions must be 0400 or 0600." ;;
  esac

  if production_backup_private_owner="$(stat -f '%u' "$production_backup_private_path" 2>/dev/null)"; then
    :
  elif production_backup_private_owner="$(stat -c '%u' "$production_backup_private_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail "could not inspect $production_backup_private_label ownership."
  fi
  [[ "$production_backup_private_owner" == "$(id -u)" ]] || production_backup_fail \
    "$production_backup_private_label must be owned by the current user."
  if production_backup_private_links="$(stat -f '%l' \
      "$production_backup_private_path" 2>/dev/null)"; then
    :
  elif production_backup_private_links="$(stat -c '%h' \
      "$production_backup_private_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail "could not inspect $production_backup_private_label link count."
  fi
  [[ "$production_backup_private_links" == "1" ]] || production_backup_fail \
    "$production_backup_private_label must have exactly one hard link."
  production_backup_require_no_extended_acl \
    "$production_backup_private_path" "$production_backup_private_label"
}

production_backup_hashed_executable() {
  production_backup_executable_path="$1"
  production_backup_executable_hash="$2"
  production_backup_executable_label="$3"
  production_backup_require_absolute_path \
    "$production_backup_executable_path" "$production_backup_executable_label"
  [[ -f "$production_backup_executable_path" \
    && ! -L "$production_backup_executable_path" \
    && -x "$production_backup_executable_path" ]] || production_backup_fail \
      "$production_backup_executable_label must be an executable, non-symlink file."
  production_backup_require_hash \
    "$production_backup_executable_hash" "$production_backup_executable_label SHA-256"
  production_backup_executable_actual_hash="$(
    production_backup_sha256_file "$production_backup_executable_path"
  )"
  [[ "$production_backup_executable_actual_hash" == "$production_backup_executable_hash" ]] \
    || production_backup_fail "$production_backup_executable_label SHA-256 does not match."
}

production_backup_hashed_regular_file() {
  production_backup_regular_path="$1"
  production_backup_regular_hash="$2"
  production_backup_regular_label="$3"
  production_backup_require_absolute_path \
    "$production_backup_regular_path" "$production_backup_regular_label"
  [[ -f "$production_backup_regular_path" && ! -L "$production_backup_regular_path" ]] \
    || production_backup_fail \
      "$production_backup_regular_label must be a regular, non-symlink file."
  production_backup_require_hash \
    "$production_backup_regular_hash" "$production_backup_regular_label SHA-256"
  production_backup_regular_actual_hash="$(
    production_backup_sha256_file "$production_backup_regular_path"
  )"
  [[ "$production_backup_regular_actual_hash" == "$production_backup_regular_hash" ]] \
    || production_backup_fail "$production_backup_regular_label SHA-256 does not match."
}

production_backup_hashed_tls_root_cert() {
  production_backup_tls_cert_path="$1"
  production_backup_tls_cert_hash="$2"
  production_backup_hashed_regular_file \
    "$production_backup_tls_cert_path" "$production_backup_tls_cert_hash" \
    "TLS root certificate"
  production_backup_tls_cert_canonical="$(
    production_backup_canonical_file \
      "$production_backup_tls_cert_path" "TLS root certificate"
  )"
  [[ "$production_backup_tls_cert_canonical" == "$production_backup_tls_cert_path" ]] \
    || production_backup_fail "TLS root certificate path must already be canonical."
  if production_backup_tls_cert_mode="$(stat -f '%Lp' "$production_backup_tls_cert_path" 2>/dev/null)"; then
    :
  elif production_backup_tls_cert_mode="$(stat -c '%a' "$production_backup_tls_cert_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail "could not inspect TLS root certificate permissions."
  fi
  case "$production_backup_tls_cert_mode" in
    400|440|444|600|640|644) ;;
    *) production_backup_fail \
      "TLS root certificate must not be group- or other-writable." ;;
  esac
}

production_backup_require_clean_environment() {
  production_backup_clean_script_directory="$1"
  production_backup_expected_repository_operation="${2:-}"
  case "$production_backup_expected_repository_operation" in
    capture)
      production_backup_expected_repository_entrypoint="capture-production-backup.sh"
      ;;
    restore)
      production_backup_expected_repository_entrypoint="rehearse-production-backup-restore.sh"
      ;;
    verify-evidence)
      production_backup_expected_repository_entrypoint="verify-production-backup-evidence.sh"
      ;;
    preflight)
      production_backup_expected_repository_entrypoint="verify-production-reconciliation-preflight.sh"
      ;;
    reconcile)
      production_backup_expected_repository_entrypoint="run-production-reconciliation-step.sh"
      ;;
    *)
      production_backup_fail \
        "clean-environment operation must name one fixed repository entrypoint."
      ;;
  esac
  [[ "${BASH_SOURCE[1]:-}" \
      == "$production_backup_clean_script_directory/$production_backup_expected_repository_entrypoint" ]] \
    || production_backup_fail \
      "clean-environment operation does not match the executing repository entrypoint."
  [[ "${DOMINION_CLEAN_ENV_LAUNCHER:-}" == "$DOMINION_CLEAN_ENV_CONTRACT" ]] \
    || production_backup_fail \
      "invoke this entrypoint through the reviewed clean-environment launcher."
  [[ "$-" != *x* ]] || production_backup_fail "xtrace is forbidden."
  ulimit -c 0 || production_backup_fail "could not disable core dumps."
  [[ "$(ulimit -c)" == "0" ]] || production_backup_fail "core dumps remain enabled."

  production_backup_clean_launcher="$production_backup_clean_script_directory/run-production-operator-clean.sh"
  [[ "${DOMINION_CLEAN_ENV_LAUNCHER_PATH:-}" == "$production_backup_clean_launcher" ]] \
    || production_backup_fail "clean-environment launcher path does not match the release."
  production_backup_hashed_executable \
    "$production_backup_clean_launcher" \
    "${DOMINION_CLEAN_ENV_LAUNCHER_SHA256:-}" \
    "clean-environment launcher"
  production_backup_hashed_executable \
    "${NODE_BIN:-}" "${NODE_BIN_SHA256:-}" "Node binary"
  production_backup_hashed_regular_file \
    "${NODE_ARCHIVE:-}" "${NODE_ARCHIVE_SHA256:-}" "Node archive"
  production_backup_require_hash \
    "${DOMINION_OPERATOR_PACK_LAUNCHER_SHA256:-}" \
    "operator-pack launcher SHA-256"
  production_backup_require_hash \
    "${DOMINION_MACOS_TCB_ATTESTATION_SHA256:-}" \
    "macOS TCB attestation SHA-256"
  [[ "${DOMINION_ENTRYPOINT_SHA256:-}" \
      == "${DOMINION_CLEAN_ENV_LAUNCHER_SHA256:-}" \
    && "${DOMINION_REPOSITORY_OPERATOR_CHILD:-}" \
      == "dominion-repository-operator-clean/v1" \
    && "${DOMINION_RELEASE_REPOSITORY:-}" \
      == "$(cd "$production_backup_clean_script_directory/.." && pwd -P)" \
    && "${DOMINION_RELEASE_COMMIT:-}" =~ ^[a-f0-9]{40}$ \
    && -n "$production_backup_expected_repository_operation" \
    && "${DOMINION_REPOSITORY_OPERATION:-}" \
      == "$production_backup_expected_repository_operation" ]] \
    || production_backup_fail \
      "clean-environment release provenance markers do not match."
}

production_backup_run_repository_operation() {
  production_backup_repository_operation="$1"
  shift
  case "$production_backup_repository_operation" in
    capture|restore|verify-evidence|preflight|reconcile) ;;
    *) production_backup_fail "unsupported repository operation." ;;
  esac
  production_backup_repository_launcher="${DOMINION_CLEAN_ENV_LAUNCHER_PATH:-}"
  production_backup_repository_launcher_sha256="${DOMINION_CLEAN_ENV_LAUNCHER_SHA256:-}"
  production_backup_hashed_executable \
    "$production_backup_repository_launcher" \
    "$production_backup_repository_launcher_sha256" \
    "repository dispatcher"
  production_backup_require_hash \
    "${DOMINION_OPERATOR_PACK_LAUNCHER_SHA256:-}" \
    "operator-pack launcher SHA-256"
  /usr/bin/env -i \
    PATH=/usr/bin:/bin \
    HOME="$HOME" \
    TMPDIR="$TMPDIR" \
    LANG=C \
    LC_ALL=C \
    TZ=UTC \
    NODE_BIN="$NODE_BIN" \
    NODE_BIN_SHA256="$NODE_BIN_SHA256" \
    NODE_ARCHIVE="$NODE_ARCHIVE" \
    NODE_ARCHIVE_SHA256="$NODE_ARCHIVE_SHA256" \
    DOMINION_CLEAN_ENV_LAUNCHER="$DOMINION_CLEAN_ENV_CONTRACT" \
    DOMINION_CLEAN_ENV_LAUNCHER_SHA256="$DOMINION_OPERATOR_PACK_LAUNCHER_SHA256" \
    DOMINION_ENTRYPOINT_SHA256="$production_backup_repository_launcher_sha256" \
    DOMINION_MACOS_TCB_ATTESTATION_SHA256="$DOMINION_MACOS_TCB_ATTESTATION_SHA256" \
    DOMINION_REPOSITORY_OPERATOR_CHILD="$DOMINION_REPOSITORY_OPERATOR_CHILD" \
    DOMINION_OPERATOR_PACK_LAUNCHER_SHA256="$DOMINION_OPERATOR_PACK_LAUNCHER_SHA256" \
    DOMINION_RELEASE_REPOSITORY="$DOMINION_RELEASE_REPOSITORY" \
    DOMINION_RELEASE_COMMIT="$DOMINION_RELEASE_COMMIT" \
    "$production_backup_repository_launcher" \
      --operation "$production_backup_repository_operation" -- "$@"
}

production_backup_require_local_docker_context() {
  production_backup_context_docker="$1"
  production_backup_socket_path="$2"
  production_backup_socket_device="$3"
  production_backup_socket_inode="$4"
  production_backup_socket_owner_uid="$5"
  production_backup_socket_owner_mode="$6"
  production_backup_require_absolute_path \
    "$production_backup_socket_path" "Docker socket"
  [[ -S "$production_backup_socket_path" && ! -L "$production_backup_socket_path" ]] \
    || production_backup_fail "Docker socket must be a real Unix socket."
  production_backup_socket_parent="$(
    cd "$(dirname "$production_backup_socket_path")"
    pwd -P
  )"
  [[ "$production_backup_socket_path" \
    == "$production_backup_socket_parent/$(basename "$production_backup_socket_path")" ]] \
    || production_backup_fail "Docker socket path must already be canonical."
  [[ "$production_backup_socket_device" =~ ^[0-9]+$ \
    && "$production_backup_socket_inode" =~ ^[0-9]+$ \
    && "$production_backup_socket_owner_uid" =~ ^[0-9]+$ \
    && "$production_backup_socket_owner_mode" =~ ^[0-9]+$ ]] \
    || production_backup_fail "Docker socket identity fields must be base-10 integers."
  if production_backup_socket_stat="$(stat -f '%d|%i|%u|%Lp' \
      "$production_backup_socket_path" 2>/dev/null)"; then
    :
  elif production_backup_socket_stat="$(stat -c '%d|%i|%u|%a' \
      "$production_backup_socket_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail "could not inspect the Docker socket identity."
  fi
  IFS='|' read -r production_backup_actual_socket_device \
    production_backup_actual_socket_inode production_backup_actual_socket_uid \
    production_backup_actual_socket_mode <<EOF
$production_backup_socket_stat
EOF
  production_backup_actual_socket_mode_decimal="$((8#$production_backup_actual_socket_mode))"
  [[ "$production_backup_actual_socket_device" == "$production_backup_socket_device" \
    && "$production_backup_actual_socket_inode" == "$production_backup_socket_inode" \
    && "$production_backup_actual_socket_uid" == "$production_backup_socket_owner_uid" \
    && "$production_backup_actual_socket_mode_decimal" \
      == "$production_backup_socket_owner_mode" \
    && "$production_backup_actual_socket_uid" == "$(id -u)" \
    && "$production_backup_actual_socket_mode_decimal" == "384" ]] \
    || production_backup_fail "Docker socket identity is not the exact owner-only reviewed socket."
  production_backup_require_no_extended_acl "$production_backup_socket_path" "Docker socket"
  export DOCKER_HOST="unix://$production_backup_socket_path"
}

production_backup_canonical_directory() {
  production_backup_directory_path="$1"
  production_backup_directory_label="$2"
  production_backup_require_absolute_path \
    "$production_backup_directory_path" "$production_backup_directory_label"
  [[ -d "$production_backup_directory_path" && ! -L "$production_backup_directory_path" ]] \
    || production_backup_fail \
      "$production_backup_directory_label must be a directory and not a symlink."
  (
    cd "$production_backup_directory_path"
    pwd -P
  )
}

production_backup_require_private_directory() {
  production_backup_private_directory_path="$1"
  production_backup_private_directory_label="$2"
  production_backup_canonical_directory \
    "$production_backup_private_directory_path" \
    "$production_backup_private_directory_label" >/dev/null
  if production_backup_private_directory_stat="$(stat -f '%u|%Lp' \
      "$production_backup_private_directory_path" 2>/dev/null)"; then
    :
  elif production_backup_private_directory_stat="$(stat -c '%u|%a' \
      "$production_backup_private_directory_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail \
      "could not inspect $production_backup_private_directory_label ownership."
  fi
  IFS='|' read -r production_backup_private_directory_uid \
    production_backup_private_directory_mode <<EOF
$production_backup_private_directory_stat
EOF
  production_backup_private_directory_mode_decimal="$((8#$production_backup_private_directory_mode))"
  [[ "$production_backup_private_directory_uid" == "$(id -u)" \
    && "$production_backup_private_directory_mode_decimal" == "448" ]] \
    || production_backup_fail \
      "$production_backup_private_directory_label must be current-user-owned mode 0700."
  production_backup_require_no_extended_acl \
    "$production_backup_private_directory_path" \
    "$production_backup_private_directory_label"
}

production_backup_require_owned_directory() {
  production_backup_owned_directory_path="$1"
  production_backup_owned_directory_label="$2"
  production_backup_canonical_directory \
    "$production_backup_owned_directory_path" \
    "$production_backup_owned_directory_label" >/dev/null
  if production_backup_owned_directory_uid="$(stat -f '%u' \
      "$production_backup_owned_directory_path" 2>/dev/null)"; then
    :
  elif production_backup_owned_directory_uid="$(stat -c '%u' \
      "$production_backup_owned_directory_path" 2>/dev/null)"; then
    :
  else
    production_backup_fail \
      "could not inspect $production_backup_owned_directory_label ownership."
  fi
  [[ "$production_backup_owned_directory_uid" == "$(id -u)" ]] \
    || production_backup_fail \
      "$production_backup_owned_directory_label must be owned by the current user."
  production_backup_require_no_extended_acl \
    "$production_backup_owned_directory_path" \
    "$production_backup_owned_directory_label"
}

production_backup_canonical_file() {
  production_backup_file_path="$1"
  production_backup_file_label="$2"
  production_backup_require_absolute_path \
    "$production_backup_file_path" "$production_backup_file_label"
  [[ -f "$production_backup_file_path" && ! -L "$production_backup_file_path" ]] \
    || production_backup_fail \
      "$production_backup_file_label must be a regular, non-symlink file."
  production_backup_file_parent="$(
    cd "$(dirname "$production_backup_file_path")"
    pwd -P
  )"
  printf '%s/%s\n' \
    "$production_backup_file_parent" "$(basename "$production_backup_file_path")"
}

production_backup_run_operator_pack_entrypoint() {
  production_backup_pack_launcher="$1"
  production_backup_pack_launcher_sha256="$2"
  production_backup_pack_entrypoint="$3"
  production_backup_pack_entrypoint_sha256="$4"
  production_backup_pack_runtime_parent="$5"
  production_backup_pack_tcb_attestation="$6"
  production_backup_pack_tcb_attestation_sha256="$7"
  shift 7

  [[ "$production_backup_pack_launcher_sha256" \
      == "${DOMINION_OPERATOR_PACK_LAUNCHER_SHA256:-}" ]] \
    || production_backup_fail \
      "operator-pack launcher does not match the authenticated outer boundary."

  production_backup_hashed_executable \
    "$production_backup_pack_launcher" \
    "$production_backup_pack_launcher_sha256" \
    "operator-pack clean-environment launcher"
  production_backup_require_hash \
    "$production_backup_pack_entrypoint_sha256" \
    "operator-pack entrypoint SHA-256"
  production_backup_private_file \
    "$production_backup_pack_tcb_attestation" \
    "macOS TCB attestation"
  [[ "$(production_backup_sha256_file "$production_backup_pack_tcb_attestation")" \
    == "$production_backup_pack_tcb_attestation_sha256" ]] \
    || production_backup_fail "macOS TCB attestation SHA-256 does not match."
  production_backup_require_private_directory \
    "$production_backup_pack_runtime_parent" \
    "operator-pack runtime parent"
  production_backup_pack_runtime="$(mktemp -d \
    "$production_backup_pack_runtime_parent/operator-pack-entrypoint.XXXXXX")"
  case "$production_backup_pack_runtime" in
    "$production_backup_pack_runtime_parent"/operator-pack-entrypoint.*) ;;
    *) production_backup_fail "mktemp returned an unsafe operator-pack runtime directory." ;;
  esac
  production_backup_pack_runtime="$(production_backup_canonical_directory \
    "$production_backup_pack_runtime" "operator-pack runtime")"
  chmod 700 "$production_backup_pack_runtime"
  production_backup_require_private_directory \
    "$production_backup_pack_runtime" "operator-pack runtime"

  production_backup_pack_status=0
  "$production_backup_pack_launcher" \
    --entrypoint "$production_backup_pack_entrypoint" \
    --entrypoint-file-sha256 "$production_backup_pack_entrypoint_sha256" \
    --clean-environment-launcher-sha256 \
      "$production_backup_pack_launcher_sha256" \
    --node-bin "$NODE_BIN" \
    --node-bin-sha256 "$NODE_BIN_SHA256" \
    --node-archive "$NODE_ARCHIVE" \
    --node-archive-sha256 "$NODE_ARCHIVE_SHA256" \
    --runtime-directory "$production_backup_pack_runtime" \
    --macos-tcb-attestation "$production_backup_pack_tcb_attestation" \
    --macos-tcb-attestation-sha256 \
      "$production_backup_pack_tcb_attestation_sha256" \
    -- "$@" || production_backup_pack_status=$?
  if [[ "$production_backup_pack_status" == "0" ]]; then
    production_backup_pack_runtime_removed=true
    if ! /bin/rm -rf -- "$production_backup_pack_runtime"; then
      production_backup_pack_runtime_removed=false
    fi
    if [[ -e "$production_backup_pack_runtime" || -L "$production_backup_pack_runtime" ]]; then
      production_backup_pack_runtime_removed=false
    fi
    if [[ "$production_backup_pack_runtime_removed" != "true" ]]; then
      echo "Production backup operator: could not remove successful operator-pack runtime." >&2
      production_backup_pack_status=1
    fi
  else
    # A failed pack call may have sealed unresolved cleanup authority inside
    # the reviewed runtime, including an empty directory that a delayed child
    # can still repopulate. Preserve the exact runtime byte-for-byte and let
    # the parent cleanup decide whether the enclosing capture/restore runtime
    # must survive for recovery.
    echo "Production backup operator: preserved failed operator-pack runtime at $production_backup_pack_runtime" >&2
  fi
  return "$production_backup_pack_status"
}

# Return success only when an enclosing operator runtime must be retained. A
# failed/signal-killed pack launcher can leave exact cleanup authority in one
# of its direct runtime children. Any leftover matching entry proves the
# common helper did not finish its own cleanup; even an empty directory may
# still be populated by a delayed descendant. Preserve the whole enclosing
# runtime and its bind sources without trying to reinterpret that state.
production_backup_operator_pack_runtime_needs_preservation() {
  production_backup_pack_parent="$1"
  production_backup_pack_literal="$production_backup_pack_parent/operator-pack-entrypoint.*"
  for production_backup_pack_child in \
    "$production_backup_pack_parent"/operator-pack-entrypoint.*; do
    if [[ "$production_backup_pack_child" == "$production_backup_pack_literal" \
      && ! -e "$production_backup_pack_child" \
      && ! -L "$production_backup_pack_child" ]]; then
      continue
    fi
    case "$production_backup_pack_child" in
      "$production_backup_pack_parent"/operator-pack-entrypoint.*) ;;
      *) return 0 ;;
    esac
    return 0
  done
  return 1
}

production_backup_verify_encrypted_destination() {
  production_backup_destination="$1"
  production_backup_attestation_file="$2"
  production_backup_attestation_sha256="$3"
  production_backup_volume_hook="$4"
  production_backup_volume_hook_sha256="${5:-}"
  production_backup_pack_launcher="${6:-}"
  production_backup_pack_launcher_sha256="${7:-}"
  production_backup_pack_runtime_parent="${8:-}"
  production_backup_pack_tcb_attestation="${9:-}"
  production_backup_pack_tcb_attestation_sha256="${10:-}"
  production_backup_require_hash \
    "$production_backup_attestation_sha256" \
    "encrypted-volume attestation SHA-256"
  production_backup_private_file \
    "$production_backup_attestation_file" \
    "encrypted-volume attestation"
  production_backup_attestation_file="$(
    production_backup_canonical_file \
      "$production_backup_attestation_file" \
      "encrypted-volume attestation"
  )"
  case "$production_backup_attestation_file" in
    "$production_backup_destination"/*) ;;
    *) production_backup_fail \
      "encrypted-volume attestation must be sealed inside the exact destination." ;;
  esac
  [[ "$(production_backup_sha256_file "$production_backup_attestation_file")" \
    == "$production_backup_attestation_sha256" ]] || production_backup_fail \
    "encrypted-volume attestation SHA-256 does not match."
  production_backup_creation_record="$production_backup_destination/encrypted-volume-creation-record.json"
  production_backup_private_file \
    "$production_backup_creation_record" \
    "encrypted-volume AES-256 creation record"
  "$NODE_BIN" "$script_directory/production-backup-artifacts.mjs" \
    validate-encrypted-volume-attestation \
    --file "$production_backup_attestation_file" \
    --file-sha256 "$production_backup_attestation_sha256" \
    --destination "$production_backup_destination" \
    --creation-record "$production_backup_creation_record" \
    >/dev/null || production_backup_fail \
      "encrypted-volume attestation contract validation failed."
  [[ -n "$production_backup_pack_launcher" \
    && -n "$production_backup_pack_launcher_sha256" \
    && -n "$production_backup_volume_hook_sha256" \
    && -n "$production_backup_pack_runtime_parent" \
    && -n "$production_backup_pack_tcb_attestation" \
    && -n "$production_backup_pack_tcb_attestation_sha256" ]] \
    || production_backup_fail \
      "encrypted destination verification requires the manifest-authorized operator-pack launcher."
  production_backup_volume_output="$(
    production_backup_run_operator_pack_entrypoint \
      "$production_backup_pack_launcher" \
      "$production_backup_pack_launcher_sha256" \
      encrypted-volume-check \
      "$production_backup_volume_hook_sha256" \
      "$production_backup_pack_runtime_parent" \
      "$production_backup_pack_tcb_attestation" \
      "$production_backup_pack_tcb_attestation_sha256" \
      --operation verify \
      --destination "$production_backup_destination" \
      --attestation "$production_backup_attestation_file" \
      --attestation-sha256 "$production_backup_attestation_sha256" \
      2>/dev/null
  )" || production_backup_fail "encrypted destination verification hook failed."
  [[ "$production_backup_volume_output" \
    == "DOMINION_ENCRYPTED_VOLUME_ATTESTATION_SHA256=$production_backup_attestation_sha256
DOMINION_ENCRYPTED_VOLUME_DESTINATION=$production_backup_destination" ]] \
    || production_backup_fail \
      "encrypted destination hook did not attest the exact canonical destination."
}

production_backup_require_safe_id() {
  production_backup_id="$1"
  production_backup_id_label="$2"
  [[ "$production_backup_id" =~ ^[a-z0-9][a-z0-9._-]{2,63}$ ]] \
    || production_backup_fail \
      "$production_backup_id_label must use 3-64 lowercase letters, digits, dots, underscores, or hyphens."
}

production_backup_require_project_ref() {
  [[ "$1" =~ ^[a-z0-9]{20}$ ]] || production_backup_fail \
    "project ref must be exactly 20 lowercase letters or digits."
}

production_backup_require_commit() {
  [[ "$1" =~ ^[a-f0-9]{40}$ ]] || production_backup_fail \
    "expected commit must be exactly 40 lowercase hexadecimal characters."
}

production_backup_require_branch() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || production_backup_fail \
    "expected branch contains unsupported characters."
}

# Run Git with no ambient/global/system configuration and with every local
# extension point that can execute code during a read-only repository check
# disabled explicitly. The executable path is supplied by the reviewed launcher
# and is required to be absolute so PATH is never consulted at invocation time.
production_backup_git() {
  production_backup_git_bin="$1"
  shift
  production_backup_require_absolute_path "$production_backup_git_bin" "Git executable"
  [[ -f "$production_backup_git_bin" \
    && ! -L "$production_backup_git_bin" \
    && -x "$production_backup_git_bin" ]] || production_backup_fail \
      "Git executable must be an executable, non-symlink file."
  env -i \
    HOME=/var/empty \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_TERMINAL_PROMPT=0 \
    "$production_backup_git_bin" \
      --no-replace-objects \
      -c core.fsmonitor=false \
      -c core.untrackedCache=false \
      -c credential.helper= \
      -c core.hooksPath=/dev/null \
      -c diff.external= \
      "$@"
}

production_backup_reject_ambient_database_environment() {
  for production_backup_ambient_name in \
    DATABASE_URL \
    PGAPPNAME \
    PGCHANNELBINDING \
    PGCLIENTENCODING \
    PGCONNECT_TIMEOUT \
    PGDATABASE \
    PGHOST \
    PGHOSTADDR \
    PGOPTIONS \
    PGPASSFILE \
    PGPASSWORD \
    PGPORT \
    PGREQUIRESSL \
    PGSERVICE \
    PGSERVICEFILE \
    PGSSLCERT \
    PGSSLCRL \
    PGSSLCRLDIR \
    PGSSLKEY \
    PGSSLMODE \
    PGSSLROOTCERT \
    PGTARGETSESSIONATTRS \
    PGTZ \
    PGUSER \
    POSTGRES_PASSWORD \
    SUPABASE_ACCESS_TOKEN \
    SUPABASE_DB_PASSWORD; do
    if [[ -n "${!production_backup_ambient_name+x}" ]]; then
      production_backup_fail \
        "unset ambient $production_backup_ambient_name before running this operator command."
    fi
  done
}

production_backup_reject_ambient_runtime_environment() {
  for production_backup_ambient_name in \
    BASH_ENV \
    CDPATH \
    DOCKER_CERT_PATH \
    DOCKER_CONFIG \
    DOCKER_CONTEXT \
    DOCKER_HOST \
    DOCKER_TLS_VERIFY \
    DYLD_INSERT_LIBRARIES \
    DYLD_LIBRARY_PATH \
    ENV \
    GIT_ALTERNATE_OBJECT_DIRECTORIES \
    GIT_CEILING_DIRECTORIES \
    GIT_CONFIG_COUNT \
    GIT_CONFIG_GLOBAL \
    GIT_CONFIG_NOSYSTEM \
    GIT_CONFIG_SYSTEM \
    GIT_DIR \
    GIT_INDEX_FILE \
    GIT_OBJECT_DIRECTORY \
    GIT_WORK_TREE \
    LD_LIBRARY_PATH \
    LD_PRELOAD \
    NODE_EXTRA_CA_CERTS \
    NODE_OPTIONS \
    NODE_PATH \
    ALL_PROXY \
    all_proxy \
    AWS_CA_BUNDLE \
    CURL_CA_BUNDLE \
    HTTPS_PROXY \
    https_proxy \
    HTTP_PROXY \
    http_proxy \
    NO_PROXY \
    no_proxy \
    REQUESTS_CA_BUNDLE \
    SSL_CERT_DIR \
    SSL_CERT_FILE \
    SSLKEYLOGFILE; do
    if [[ -n "${!production_backup_ambient_name+x}" ]]; then
      production_backup_fail \
        "unset ambient $production_backup_ambient_name before running this operator command."
    fi
  done

  # NODE_* startup controls are denied by default. Only the four identities
  # injected by the reviewed launcher are permitted.
  for production_backup_ambient_name in $(compgen -e); do
    case "$production_backup_ambient_name" in
      NODE_BIN|NODE_BIN_SHA256|NODE_ARCHIVE|NODE_ARCHIVE_SHA256) ;;
      NODE_*) production_backup_fail \
        "unset ambient $production_backup_ambient_name before running this operator command." ;;
    esac
  done
}
