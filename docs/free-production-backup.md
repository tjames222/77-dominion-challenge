# Free production backup

The manual **Free production backup** workflow captures the existing project
`mimolwojppbtsbvtqwpo` at the exact first thirteen migration checkpoint. It uses
the repository's standard GitHub-hosted runner and makes no paid Supabase API
request or project creation. Production backup and release share the same
concurrency group.

The production environment variable `PRODUCTION_BACKUP_PUBLIC_KEY` holds an
RSA-4096 public PEM. Its private key stays on the operator's machine and must be
preserved with the downloaded backup. The workflow creates a random AES-256-GCM
key, encrypts the backup, and wraps that key using RSA-OAEP-SHA256. Only
`backup.enc` and the non-secret `backup-manifest.json` leave the runner. Artifacts
are capped at 50 MiB and expire after seven days; download them locally before
release (the ciphertext is capped at 49 MiB to leave room for artifact metadata).
Standard Actions usage for this public repository is free. This workflow
does not upgrade any plan or enable paid backup services.

The capture uses the pinned Supabase PostgreSQL `17.6.1.141` tools and temporary
login credentials. Remote connections are forced read-only. A full custom-format
`pg_dump` includes application/private schemas, Auth, Storage metadata, migration
history, extensions, owners, ACLs, and large objects. Roles are captured separately
without passwords. All plaintext dumps, private diagnostics, and credentials live
in runner tmpfs and are removed afterward. An interrupted runner is ephemeral;
the final workflow step also attempts credential revocation.

Supabase controls the temporary password lifetime; the production path accepts
integer lifetimes of 300–7200 seconds instead of assuming a full hour. A
monotonic deadline begins before the login request, includes setup and readiness
time, and reserves 30 seconds before expiry. At least 120 usable seconds must
remain before credentials become ready and before a production CLI operation
starts. All remote backup commands share that one deadline. A timeout stops the
owned capture container before cleanup, so terminating the Docker client cannot
leave its database query running. Local restore and encryption happen after
credential revocation and do not consume this database-login budget.

The release workflow obtains and revokes a separate login for each fixed
`history`, `dry-run`, or `migrate` operation. It never refreshes credentials in
the middle of an operation. A timed-out migration command can have committed an
earlier migration; inspect exact history and review the recovery path instead of
assuming the whole chain rolled back or blindly retrying it.

The backup is restored into a new `initdb` cluster in a network-disabled container
with tmpfs data. It has no hosted credentials and its local admin role must be
absent from the source. Cron execution is disabled. The restore must reproduce
every non-system table's row count and SHA-256 content fingerprint, sequence
state, large-object fingerprint, and migration history. PostgreSQL 17 membership
grants issued by the source bootstrap superuser are replayed by the disposable
cluster's bootstrap administrator; other grantors and all grant options are
preserved. The original role SQL remains unchanged in the backup. Matching source
inventories before and after capture also reject concurrent changes. Foreign
tables, Storage objects or multipart uploads, and Vault/pgsodium encrypted data
fail closed because this backup would not contain their external data or root key.

Run this workflow from `main`, download its successful encrypted artifact, apply
the bounded owner canary grant, then dispatch the compatibility cutover with its
`backup_run_id`. Once that succeeds, dispatch the full release. The manifest binds the exact
release commit and canonical SPKI DER recipient key fingerprint. Do not modify
`main` between backup and the two release stages.

To recover the archive locally, choose a new private output path on encrypted
local storage and run:

```sh
node scripts/free-production-backup.mjs decrypt backup.enc recovered-backup.tar backup-manifest.json /private/path/recipient-private.pem
```

This command authenticates the ciphertext before writing a mode-0600 tar file.
It does not connect to a database. The archive contains `roles.sql`,
`database.dump`, and `inventory.jsonl`. Any future hosted restore is a separately
reviewed recovery action. A successful isolated restore does not create a hosted
project or reset the existing one.
