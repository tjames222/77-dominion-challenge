#!/bin/bash
set -euo pipefail
set +x
umask 077

# This dispatcher is entered only by the frozen operator-pack launcher. The
# pack authenticates the release and reviewed runtime first; this script then
# maps one fixed operation to one exact Git blob from that release.

readonly clean_environment_contract="dominion-production-operator/v1"
readonly repository_child_contract="dominion-repository-operator-clean/v1"
readonly release_origin="https://github.com/tjames222/77-dominion-challenge.git"

fail() {
  /bin/echo "Production operator dispatcher: $1" >&2
  exit 64
}

hash_file() {
  local filename="$1"
  if [[ -x /sbin/sha256 ]]; then
    /sbin/sha256 -q "$filename"
  elif [[ -x /usr/bin/shasum ]]; then
    /usr/bin/shasum -a 256 "$filename" | /usr/bin/awk '{print $1}'
  elif [[ -x /usr/bin/sha256sum ]]; then
    /usr/bin/sha256sum "$filename" | /usr/bin/awk '{print $1}'
  else
    fail "an absolute system SHA-256 utility is required."
  fi
}

hash_stdin() {
  if [[ -x /sbin/sha256 ]]; then
    /sbin/sha256 -q
  elif [[ -x /usr/bin/shasum ]]; then
    /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
  elif [[ -x /usr/bin/sha256sum ]]; then
    /usr/bin/sha256sum | /usr/bin/awk '{print $1}'
  else
    fail "an absolute system SHA-256 utility is required."
  fi
}

require_hash() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$2 must be exactly 64 lowercase hexadecimal characters."
}

canonical_file() {
  local filename="$1" label="$2" parent
  [[ "$filename" == /* && -f "$filename" && ! -L "$filename" ]] \
    || fail "$label must be an absolute regular non-symlink file."
  parent="$(cd "$(/usr/bin/dirname "$filename")" && /bin/pwd -P)" \
    || fail "could not canonicalize $label."
  [[ "$parent/$(/usr/bin/basename "$filename")" == "$filename" ]] \
    || fail "$label path must already be canonical."
}

canonical_directory() {
  local directory="$1" label="$2" canonical
  [[ "$directory" == /* && -d "$directory" && ! -L "$directory" ]] \
    || fail "$label must be an absolute non-symlink directory."
  canonical="$(cd "$directory" && /bin/pwd -P)" \
    || fail "could not canonicalize $label."
  [[ "$canonical" == "$directory" ]] \
    || fail "$label path must already be canonical."
}

file_mode() {
  local kernel
  if [[ -x /usr/bin/uname ]]; then
    kernel="$(/usr/bin/uname -s)"
  elif [[ -x /bin/uname ]]; then
    kernel="$(/bin/uname -s)"
  else
    fail "could not identify the host while inspecting $2 permissions."
  fi
  case "$kernel" in
    Darwin) /usr/bin/stat -f '%Lp' "$1" 2>/dev/null ;;
    Linux) /usr/bin/stat -c '%a' "$1" 2>/dev/null ;;
    *) fail "unsupported host while inspecting $2 permissions." ;;
  esac || fail "could not inspect permissions for $2."
}

file_links() {
  local kernel
  if [[ -x /usr/bin/uname ]]; then
    kernel="$(/usr/bin/uname -s)"
  elif [[ -x /bin/uname ]]; then
    kernel="$(/bin/uname -s)"
  else
    fail "could not identify the host while inspecting $2 link count."
  fi
  case "$kernel" in
    Darwin) /usr/bin/stat -f '%l' "$1" 2>/dev/null ;;
    Linux) /usr/bin/stat -c '%h' "$1" 2>/dev/null ;;
    *) fail "unsupported host while inspecting $2 link count." ;;
  esac || fail "could not inspect link count for $2."
}

no_extended_acl() {
  local filename="$1" label="$2" kernel listing mode
  if [[ -x /usr/bin/uname ]]; then
    kernel="$(/usr/bin/uname -s)"
  elif [[ -x /bin/uname ]]; then
    kernel="$(/bin/uname -s)"
  else
    fail "could not identify the host while inspecting $label ACLs."
  fi
  if [[ "$kernel" == "Darwin" ]]; then
    listing="$(LC_ALL=C /bin/ls -lde -- "$filename" 2>/dev/null)" \
      || fail "could not inspect $label ACLs."
    mode="${listing%% *}"
    [[ "$listing" != *$'\n'* && "$mode" != *+ ]] \
      || fail "$label must not have an extended ACL."
  fi
}

owned_nonwritable_directory() {
  local directory="$1" label="$2" mode
  canonical_directory "$directory" "$label"
  [[ -O "$directory" ]] || fail "$label must be owned by the current user."
  mode="$(file_mode "$directory" "$label")"
  (( (8#$mode & 0022) == 0 )) \
    || fail "$label must not be group- or other-writable."
  no_extended_acl "$directory" "$label"
}

owned_nonwritable_executable() {
  local filename="$1" label="$2" mode links
  canonical_file "$filename" "$label"
  [[ -O "$filename" && -x "$filename" ]] \
    || fail "$label must be current-user-owned and executable."
  mode="$(file_mode "$filename" "$label")"
  (( (8#$mode & 0022) == 0 )) \
    || fail "$label must not be group- or other-writable."
  links="$(file_links "$filename" "$label")"
  [[ "$links" == "1" ]] || fail "$label must have exactly one hard link."
  no_extended_acl "$filename" "$label"
}

owned_nonwritable_regular_file() {
  local filename="$1" label="$2" mode links
  canonical_file "$filename" "$label"
  [[ -O "$filename" ]] || fail "$label must be owned by the current user."
  mode="$(file_mode "$filename" "$label")"
  (( (8#$mode & 0022) == 0 )) \
    || fail "$label must not be group- or other-writable."
  links="$(file_links "$filename" "$label")"
  [[ "$links" == "1" ]] || fail "$label must have exactly one hard link."
  no_extended_acl "$filename" "$label"
}

private_runtime_directory() {
  local directory="$1" label="$2" mode
  canonical_directory "$directory" "$label"
  [[ -O "$directory" ]] || fail "$label must be owned by the current user."
  mode="$(file_mode "$directory" "$label")"
  [[ "$mode" == "700" ]] || fail "$label permissions must be 0700."
  no_extended_acl "$directory" "$label"
}

private_regular_file() {
  local filename="$1" label="$2" mode links
  canonical_file "$filename" "$label"
  [[ -O "$filename" ]] || fail "$label must be owned by the current user."
  mode="$(file_mode "$filename" "$label")"
  [[ "$mode" == "400" || "$mode" == "600" ]] \
    || fail "$label permissions must be 0400 or 0600."
  links="$(file_links "$filename" "$label")"
  [[ "$links" == "1" ]] || fail "$label must have exactly one hard link."
  no_extended_acl "$filename" "$label"
}

repository_git() {
  /usr/bin/env -i \
    HOME=/var/empty \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_TERMINAL_PROMPT=0 \
    /usr/bin/git \
      --no-replace-objects \
      -c core.fsmonitor=false \
      -c core.untrackedCache=false \
      -c credential.helper= \
      -c core.hooksPath=/dev/null \
      -c diff.external= \
      -C "$release_repository" "$@"
}

require_release_provenance() {
  local top branch head origin status index_listing index_entry index_count
  top="$(repository_git rev-parse --show-toplevel)" \
    || fail "could not resolve the release repository."
  branch="$(repository_git symbolic-ref --quiet --short HEAD)" \
    || fail "the release must have an attached branch."
  head="$(repository_git rev-parse --verify 'HEAD^{commit}')" \
    || fail "could not resolve the release HEAD."
  origin="$(repository_git config --get-all remote.origin.url)" \
    || fail "could not resolve the release origin."
  status="$(repository_git status --porcelain=v1 --untracked-files=all)" \
    || fail "could not inspect the release worktree."
  [[ "$top" == "$release_repository" \
    && "$branch" == "main" \
    && "$head" == "$release_commit" \
    && "$origin" == "$release_origin" \
    && -z "$status" ]] \
    || fail "release repository must be the exact canonical clean main commit and origin."
  index_listing="$(repository_git ls-files -v)" \
    || fail "could not inspect release index flags."
  index_count=0
  while IFS= read -r index_entry || [[ -n "$index_entry" ]]; do
    index_count=$((index_count + 1))
    [[ "$index_entry" == "H "* ]] \
      || fail "release index contains a hidden, skipped, or non-normal tracked path."
  done <<<"$index_listing"
  (( index_count > 0 )) || fail "release index must contain tracked files."
}

git_blob_sha256() {
  local relative_path="$1" expected_mode="$2" tree_entry tree_metadata tree_path
  tree_entry="$(repository_git ls-tree "$release_commit" -- "$relative_path")" \
    || fail "could not inspect the fixed operation in the release tree."
  [[ -n "$tree_entry" && "$tree_entry" != *$'\n'* && "$tree_entry" == *$'\t'* ]] \
    || fail "the fixed operation must resolve to exactly one release-tree entry."
  tree_metadata="${tree_entry%%$'\t'*}"
  tree_path="${tree_entry#*$'\t'}"
  [[ "$tree_path" == "$relative_path" ]] \
    || fail "the fixed operation release-tree path does not match."
  set -- $tree_metadata
  [[ "$#" == "3" && "$1" == "$expected_mode" && "$2" == "blob" \
    && "$3" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ ]] \
    || fail "the authenticated release path has the wrong Git object mode or type."
  repository_git cat-file blob "$release_commit:$relative_path" | hash_stdin
}

require_exact_environment() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      DOMINION_CLEAN_ENV_LAUNCHER|DOMINION_CLEAN_ENV_LAUNCHER_SHA256|\
      DOMINION_ENTRYPOINT_SHA256|DOMINION_MACOS_TCB_ATTESTATION_SHA256|\
      DOMINION_OPERATOR_PACK_LAUNCHER_SHA256|DOMINION_RELEASE_COMMIT|\
      DOMINION_RELEASE_REPOSITORY|DOMINION_REPOSITORY_OPERATOR_CHILD|\
      HOME|LANG|LC_ALL|NODE_ARCHIVE|NODE_ARCHIVE_SHA256|NODE_BIN|\
      NODE_BIN_SHA256|PATH|PWD|SHLVL|TMPDIR|TZ) ;;
      *) fail "unexpected ambient environment variable: $name" ;;
    esac
  done
  [[ "${PATH:-}" == "/usr/bin:/bin" \
    && "${LANG:-}" == "C" \
    && "${LC_ALL:-}" == "C" \
    && "${TZ:-}" == "UTC" \
    && -n "${HOME:-}" \
    && "${HOME:-}" == "${TMPDIR:-}" \
    && "${DOMINION_CLEAN_ENV_LAUNCHER:-}" == "$clean_environment_contract" \
    && "${DOMINION_REPOSITORY_OPERATOR_CHILD:-}" == "$repository_child_contract" \
    && "${DOMINION_CLEAN_ENV_LAUNCHER_SHA256:-}" \
      == "${DOMINION_OPERATOR_PACK_LAUNCHER_SHA256:-}" ]] \
    || fail "incoming frozen-pack environment contract does not match."
}

[[ "$-" != *x* ]] || fail "xtrace must be disabled."
ulimit -c 0 || fail "could not disable core dumps."
[[ "$(ulimit -c)" == "0" ]] || fail "core dumps remain enabled."
require_exact_environment

release_repository="${DOMINION_RELEASE_REPOSITORY:-}"
release_commit="${DOMINION_RELEASE_COMMIT:-}"
dispatcher_sha256="${DOMINION_ENTRYPOINT_SHA256:-}"
operator_pack_launcher_sha256="${DOMINION_OPERATOR_PACK_LAUNCHER_SHA256:-}"
node_bin="${NODE_BIN:-}"
node_bin_sha256="${NODE_BIN_SHA256:-}"
node_archive="${NODE_ARCHIVE:-}"
node_archive_sha256="${NODE_ARCHIVE_SHA256:-}"
macos_tcb_attestation_sha256="${DOMINION_MACOS_TCB_ATTESTATION_SHA256:-}"

[[ "$release_commit" =~ ^[a-f0-9]{40}$ ]] \
  || fail "release commit must be exactly 40 lowercase hexadecimal characters."
require_hash "$dispatcher_sha256" "repository dispatcher SHA-256"
require_hash "$operator_pack_launcher_sha256" "operator-pack launcher SHA-256"
require_hash "$node_bin_sha256" "Node binary SHA-256"
require_hash "$node_archive_sha256" "Node archive SHA-256"
require_hash "$macos_tcb_attestation_sha256" "macOS TCB attestation SHA-256"

script_directory="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd -P)" \
  || fail "could not resolve the dispatcher directory."
repository_root="$(cd "$script_directory/.." && /bin/pwd -P)" \
  || fail "could not resolve the dispatcher repository."
dispatcher="$script_directory/run-production-operator-clean.sh"
[[ "${BASH_SOURCE[0]}" == "$dispatcher" \
  && "$release_repository" == "$repository_root" ]] \
  || fail "dispatcher must be the exact absolute file in the authenticated release."

[[ "$#" -ge "3" \
  && "$1" == "--operation" \
  && "$3" == "--" ]] \
  || fail "usage: --operation <capture|restore|verify-evidence|preflight|reconcile> -- ..."
operation="$2"
shift 3
case "$operation" in
  capture) child_name="capture-production-backup.sh" ;;
  restore) child_name="rehearse-production-backup-restore.sh" ;;
  verify-evidence) child_name="verify-production-backup-evidence.sh" ;;
  preflight) child_name="verify-production-reconciliation-preflight.sh" ;;
  reconcile) child_name="run-production-reconciliation-step.sh" ;;
  *) fail "unsupported fixed operation: $operation" ;;
esac
child_relative_path="scripts/$child_name"
child="$release_repository/$child_relative_path"
common_relative_path="scripts/production-backup-common.sh"
common_helper="$release_repository/$common_relative_path"

private_runtime_directory "$HOME" "operator-pack runtime"
owned_nonwritable_directory "$release_repository" "release repository"
owned_nonwritable_directory "$script_directory" "release scripts directory"
owned_nonwritable_executable "$dispatcher" "repository dispatcher"
owned_nonwritable_executable "$child" "fixed operation"
owned_nonwritable_regular_file "$common_helper" "production backup common helper"
owned_nonwritable_executable "$node_bin" "Node binary"
private_regular_file "$node_archive" "Node archive"
[[ "$(hash_file "$dispatcher")" == "$dispatcher_sha256" ]] \
  || fail "repository dispatcher SHA-256 does not match the frozen pack."
[[ "$(hash_file "$node_bin")" == "$node_bin_sha256" ]] \
  || fail "Node binary SHA-256 does not match the frozen pack."
[[ "$(hash_file "$node_archive")" == "$node_archive_sha256" ]] \
  || fail "Node archive SHA-256 does not match the frozen pack."
require_release_provenance
[[ "$(git_blob_sha256 "scripts/run-production-operator-clean.sh" 100755)" \
    == "$dispatcher_sha256" ]] \
  || fail "repository dispatcher bytes do not match the release Git blob."
child_sha256="$(git_blob_sha256 "$child_relative_path" 100755)" \
  || fail "could not hash the fixed operation release Git blob."
require_hash "$child_sha256" "fixed operation Git blob SHA-256"
[[ "$(hash_file "$child")" == "$child_sha256" ]] \
  || fail "fixed operation bytes do not match the release Git blob."
common_sha256="$(git_blob_sha256 "$common_relative_path" 100644)" \
  || fail "could not hash the common helper release Git blob."
require_hash "$common_sha256" "common helper Git blob SHA-256"
[[ "$(hash_file "$common_helper")" == "$common_sha256" ]] \
  || fail "common helper bytes do not match the release Git blob."

# Repeat provenance, permissions, and byte identities at the final exec
# boundary. The release directories are non-writable to other users; same-UID
# mutation remains part of the explicitly reviewed local operator TCB.
require_exact_environment
private_runtime_directory "$HOME" "operator-pack runtime"
owned_nonwritable_directory "$release_repository" "release repository"
owned_nonwritable_directory "$script_directory" "release scripts directory"
owned_nonwritable_executable "$dispatcher" "repository dispatcher"
owned_nonwritable_executable "$child" "fixed operation"
owned_nonwritable_regular_file "$common_helper" "production backup common helper"
owned_nonwritable_executable "$node_bin" "Node binary"
private_regular_file "$node_archive" "Node archive"
require_release_provenance
[[ "$(hash_file "$dispatcher")" == "$dispatcher_sha256" \
  && "$(git_blob_sha256 "scripts/run-production-operator-clean.sh" 100755)" \
    == "$dispatcher_sha256" \
  && "$(git_blob_sha256 "$child_relative_path" 100755)" == "$child_sha256" \
  && "$(hash_file "$child")" == "$child_sha256" \
  && "$(git_blob_sha256 "$common_relative_path" 100644)" == "$common_sha256" \
  && "$(hash_file "$common_helper")" == "$common_sha256" \
  && "$(hash_file "$node_bin")" == "$node_bin_sha256" \
  && "$(hash_file "$node_archive")" == "$node_archive_sha256" ]] \
  || fail "a release or reviewed runtime identity changed before exec."

cd "$release_repository"
exec /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  HOME="$HOME" \
  TMPDIR="$TMPDIR" \
  LANG=C \
  LC_ALL=C \
  TZ=UTC \
  NODE_BIN="$node_bin" \
  NODE_BIN_SHA256="$node_bin_sha256" \
  NODE_ARCHIVE="$node_archive" \
  NODE_ARCHIVE_SHA256="$node_archive_sha256" \
  DOMINION_CLEAN_ENV_LAUNCHER="$clean_environment_contract" \
  DOMINION_CLEAN_ENV_LAUNCHER_PATH="$dispatcher" \
  DOMINION_CLEAN_ENV_LAUNCHER_SHA256="$dispatcher_sha256" \
  DOMINION_ENTRYPOINT_SHA256="$dispatcher_sha256" \
  DOMINION_MACOS_TCB_ATTESTATION_SHA256="$macos_tcb_attestation_sha256" \
  DOMINION_REPOSITORY_OPERATOR_CHILD="$repository_child_contract" \
  DOMINION_OPERATOR_PACK_LAUNCHER_SHA256="$operator_pack_launcher_sha256" \
  DOMINION_RELEASE_REPOSITORY="$release_repository" \
  DOMINION_RELEASE_COMMIT="$release_commit" \
  DOMINION_REPOSITORY_OPERATION="$operation" \
  /bin/bash --noprofile --norc "$child" "$@"
