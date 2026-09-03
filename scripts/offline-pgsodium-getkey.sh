#!/bin/bash
set -euo pipefail
set +x
umask 077
ulimit -c 0

# This helper is confined to the network-none rehearsal container. It creates
# one random key in the container's PostgreSQL runtime tmpfs, atomically publishes it, and
# reuses it only for the lifetime of that container. No key is present in the
# pack, argv, environment, evidence, logs, or persistent overlay.
key_directory="/var/run/postgresql/dominion-pgsodium"
key_file="$key_directory/pgsodium-root.key"
lock_file="$key_directory/key.lock"
/bin/mkdir -p -m 0700 "$key_directory"
[[ -d "$key_directory" && ! -L "$key_directory"
  && "$(/bin/stat -c '%a:%u:%g' "$key_directory")" == "700:100:101" ]] || exit 1
if [[ ! -e "$lock_file" ]]; then
  set -C
  (umask 077; : >"$lock_file") 2>/dev/null || true
  set +C
fi
[[ -f "$lock_file" && ! -L "$lock_file"
  && "$(/bin/stat -c '%a:%u:%g:%h:%s' "$lock_file")" == "600:100:101:1:0" ]] || exit 1
exec 9<>"$lock_file"
/usr/bin/flock -x 9
[[ -f "$lock_file" && ! -L "$lock_file"
  && "$(/bin/stat -c '%a:%u:%g:%h:%s' "$lock_file")" == "600:100:101:1:0" ]] || exit 1
if [[ ! -e "$key_file" ]]; then
  temporary="$key_directory/.pgsodium-root.$$.partial"
  trap '/bin/rm -f "$temporary"' EXIT INT TERM
  set -C
  (umask 077; { /usr/bin/head -c 32 /dev/urandom | /usr/bin/od -An -v -tx1 \
    | /usr/bin/tr -d ' \n'; /usr/bin/printf '\n'; } >"$temporary")
  set +C
  IFS= read -r generated <"$temporary"
  [[ "$generated" =~ ^[a-f0-9]{64}$ ]] || exit 1
  unset generated
  /bin/chmod 0600 "$temporary"
  /bin/mv "$temporary" "$key_file"
  trap - EXIT INT TERM
fi
[[ -f "$key_file" && ! -L "$key_file"
  && "$(/bin/stat -c '%a:%u:%g:%h:%s' "$key_file")" == "600:100:101:1:65" ]] || exit 1
IFS= read -r key <"$key_file"
[[ "$key" =~ ^[a-f0-9]{64}$ ]] || exit 1
/usr/bin/printf '%s\n' "$key"
unset key
