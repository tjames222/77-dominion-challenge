#!/bin/bash
set -euo pipefail
set +x
umask 077

# This launcher is the only supported outer boundary for production operator
# entrypoints. Invoke it with an empty environment and the system Bash:
#   /usr/bin/env -i /bin/bash /absolute/path/run-production-operator-clean.sh ...

fail() {
  echo "Production operator clean launcher: $1" >&2
  exit 64
}

[[ "$-" != *x* ]] || fail "xtrace must be disabled."
ulimit -c 0 || fail "could not disable core dumps."
[[ "$(ulimit -c)" == "0" ]] || fail "core dumps remain enabled."

launcher_path="${BASH_SOURCE[0]}"
entrypoint=""
entrypoint_sha256=""
node_bin=""
node_bin_sha256=""
launcher_sha256=""

while (( $# > 0 )); do
  case "$1" in
    --entrypoint) (( $# >= 2 )) || fail "--entrypoint requires a value."; entrypoint="$2"; shift 2 ;;
    --entrypoint-sha256) (( $# >= 2 )) || fail "--entrypoint-sha256 requires a value."; entrypoint_sha256="$2"; shift 2 ;;
    --node-bin) (( $# >= 2 )) || fail "--node-bin requires a value."; node_bin="$2"; shift 2 ;;
    --node-bin-sha256) (( $# >= 2 )) || fail "--node-bin-sha256 requires a value."; node_bin_sha256="$2"; shift 2 ;;
    --launcher-sha256) (( $# >= 2 )) || fail "--launcher-sha256 requires a value."; launcher_sha256="$2"; shift 2 ;;
    --) shift; break ;;
    *) fail "unsupported argument: $1" ;;
  esac
done

require_hash() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] || fail "$2 must be 64 lowercase hexadecimal characters."
}

require_absolute_file() {
  [[ "$1" == /* ]] || fail "$2 must be an absolute path."
  [[ -f "$1" && ! -L "$1" ]] || fail "$2 must be a regular, non-symlink file."
}

sha256_file() {
  if [[ -x /usr/bin/shasum ]]; then
    /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
  elif [[ -x /usr/bin/sha256sum ]]; then
    /usr/bin/sha256sum "$1" | /usr/bin/awk '{print $1}'
  else
    fail "an absolute system SHA-256 utility is required."
  fi
}

require_absolute_file "$launcher_path" "launcher"
require_absolute_file "$entrypoint" "entrypoint"
require_absolute_file "$node_bin" "Node binary"
[[ -x "$entrypoint" ]] || fail "entrypoint must be executable."
[[ -x "$node_bin" ]] || fail "Node binary must be executable."
require_hash "$launcher_sha256" "launcher SHA-256"
require_hash "$entrypoint_sha256" "entrypoint SHA-256"
require_hash "$node_bin_sha256" "Node binary SHA-256"
[[ "$(sha256_file "$launcher_path")" == "$launcher_sha256" ]] \
  || fail "launcher SHA-256 does not match."
[[ "$(sha256_file "$entrypoint")" == "$entrypoint_sha256" ]] \
  || fail "entrypoint SHA-256 does not match."
[[ "$(sha256_file "$node_bin")" == "$node_bin_sha256" ]] \
  || fail "Node binary SHA-256 does not match."

case "${entrypoint##*/}" in
  capture-production-backup.sh|rehearse-production-backup-restore.sh|\
  verify-production-backup-evidence.sh|verify-production-reconciliation-preflight.sh|\
  run-production-reconciliation-step.sh) ;;
  *) fail "entrypoint is not in the production operator allowlist." ;;
esac

exec /usr/bin/env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  DOMINION_CLEAN_ENV_LAUNCHER=dominion-production-operator/v1 \
  DOMINION_CLEAN_ENV_LAUNCHER_PATH="$launcher_path" \
  DOMINION_CLEAN_ENV_LAUNCHER_SHA256="$launcher_sha256" \
  NODE_BIN="$node_bin" \
  NODE_BIN_SHA256="$node_bin_sha256" \
  /bin/bash "$entrypoint" "$@"
