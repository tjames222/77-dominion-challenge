#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
backup_postgres_options=(-c shared_preload_libraries=pgsodium,pg_cron,supabase_vault)
case "${DOMINION_BACKUP_CURRENT_PG_NET:-}" in
  '') ;;
  1) backup_postgres_options=(-c shared_preload_libraries=pgsodium,pg_cron,supabase_vault,pg_net
       -c max_worker_processes=0 -c pg_net.batch_size=0 -c pg_net.database_name=dominion_backup_disabled) ;;
  *) exit 1 ;;
esac
# Only used in the disposable, network-none restore container. Nothing from
# the host database or its database credentials is mounted in this container.
# Current backup mode later passes a worker setting on stdin for a local test.
initdb --username=backup_restore_admin --auth=trust --no-locale --encoding=UTF8 -D /restore/data >/dev/null
printf '%s\n' '#!/bin/sh' 'cat /restore/root.key' > /restore/getkey
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /restore/root.key
printf '\n' >> /restore/root.key
chmod 700 /restore/getkey
exec postgres -D /restore/data -k /restore -h '' \
  "${backup_postgres_options[@]}" \
  -c pgsodium.getkey_script=/restore/getkey \
  -c vault.getkey_script=/restore/getkey \
  -c cron.database_name=postgres \
  -c cron.launch_active_jobs=off
