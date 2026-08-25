#!/usr/bin/env bash

# Shared by the production snapshot operator helpers. Keep this file compatible
# with macOS's Bash 3.2: no associative arrays, mapfile, or case conversion.

readonly DOMINION_SUPABASE_CLI_VERSION="2.109.0"
readonly DOMINION_POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.141"
readonly DOMINION_POSTGRES_SERVER_VERSION_NUM="170006"

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

production_backup_verify_encrypted_destination() {
  production_backup_destination="$1"
  production_backup_passphrase_file="$2"
  production_backup_volume_hook="$3"
  production_backup_volume_output="$(
    "$production_backup_volume_hook" \
      --destination "$production_backup_destination" \
      --passphrase-file "$production_backup_passphrase_file"
  )" || production_backup_fail "encrypted destination verification hook failed."
  [[ "$production_backup_volume_output" \
    == "DOMINION_ENCRYPTED_VOLUME_OK=$production_backup_destination" ]] \
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

production_backup_read_private_value() {
  production_backup_read_path="$1"
  production_backup_read_value="$(tr -d '\r\n' <"$production_backup_read_path")"
  [[ -n "$production_backup_read_value" ]] || production_backup_fail \
    "private input file resolved to an empty value."
  printf '%s' "$production_backup_read_value"
}
