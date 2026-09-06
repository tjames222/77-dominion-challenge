#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
# Only used in the disposable, network-none restore container. Nothing from
# the host database or its credentials is mounted in this container.
initdb --username=backup_restore_admin --auth=trust --no-locale --encoding=UTF8 -D /restore/data >/dev/null
printf '%s\n' '#!/bin/sh' 'cat /restore/root.key' > /restore/getkey
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /restore/root.key
printf '\n' >> /restore/root.key
chmod 700 /restore/getkey
exec postgres -D /restore/data -k /restore -h '' \
  -c shared_preload_libraries=pgsodium,pg_cron \
  -c pgsodium.getkey_script=/restore/getkey \
  -c vault.getkey_script=/restore/getkey \
  -c cron.database_name=postgres \
  -c cron.launch_active_jobs=off
