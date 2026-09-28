# Free production backup

The manual **Free production backup** workflow captures the existing project
`mimolwojppbtsbvtqwpo`. Its default `legacy-thirteen-migration-cutover` mode is
still restricted to the exact first thirteen migration checkpoint. It uses
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
login credentials. Each remote `psql` connection explicitly runs the fixed
`SET SESSION ROLE postgres` after authentication; both dump tools use the fixed
`--role=postgres` option. No hosted grants or role attributes are changed. A
bounded preflight checks only two booleans: the effective role is `postgres` and
its explicit read-only transaction is active. Inventory runs in an explicit
read-only transaction; PostgreSQL 17.6 `pg_dump` itself uses a repeatable-read,
read-only transaction. The fixed `pg_dumpall --roles-only --no-role-passwords`
invocation reads catalog metadata and emits role SQL only into the local dump;
it does not execute that SQL remotely. `PGOPTIONS` remains defense in depth,
not an authoritative control, because a session pooler can discard startup
options. This post-connect role selection matches the pinned Supabase CLI's
[connection setup](https://github.com/supabase/cli/blob/v2.109.0/apps/cli-go/internal/utils/connect.go)
and PostgreSQL's documented [dump role option](https://www.postgresql.org/docs/17/app-pgdump.html).
A full custom-format
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
with tmpfs data. It has no hosted database credentials and its local admin role
must be absent from the source. The current mode additionally feeds an existing
worker credential on stdin for its local reconstruction test, described below;
no database credential is passed or mounted. Cron execution is disabled. The restore must reproduce
every non-system table's row count and SHA-256 content fingerprint, sequence
state, large-object fingerprint, migration history, and event-trigger ownership,
enabled state, tags, and function identity/ownership. These event-trigger records
remain private inside the encrypted inventory. PostgreSQL 17 membership
grants issued by the source bootstrap superuser are replayed by the disposable
cluster's bootstrap administrator; other grantors and all grant options are
preserved. The original role SQL remains unchanged in the backup. Matching source
inventories before and after capture also reject concurrent changes. Foreign
tables, Storage objects or multipart uploads, and Vault/pgsodium encrypted data
fail closed because this backup would not contain their external data or root key.

Stock PostgreSQL 17 requires an event trigger's target owner to be a superuser
when replaying its ownership, even if the restore executor is a superuser. The
isolated recovery test therefore temporarily gives only its local `postgres`
role `SUPERUSER` while replaying the unchanged archive, then always attempts to
restore `NOSUPERUSER`. Before doing so it requires `postgres` to be non-superuser
and the disposable bootstrap role to be `backup_restore_admin`. Afterward every
attribute in the local `pg_roles` view must exactly match its snapshot taken
after role replay; event-trigger metadata must also match the source after the
downgrade. Any restore, downgrade, or comparison failure stops verification and
encryption and removes the owned container. This compatibility step never
changes hosted roles, the original role SQL/archive, object owners, or ACLs.

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

## Current September 27 checkpoint

Choose `current-production-2026-09-27` explicitly when dispatching the manual
workflow to capture the current, pre-release database. This separate mode pins
exactly 61 migration versions through `20260913082358` and a source-fixed SHA-256
of that complete ordered prefix. It does not silently accept the candidate's
five pending migrations, an arbitrary database history, or a different prefix.
The old thirteen-migration default and compatibility-cutover evidence verifier
are unchanged.

Current production contains exactly two regenerable Vault settings:
`profile_photo_project_url` and `profile_photo_worker_secret`, used by the one
`process-profile-photo-cleanup` Cron job. All other encrypted Vault data remains
out of scope. A fixed, parameterized, repeatable-read **read-only** query verifies
the exact names, null key IDs, exact known Cron command/schedule/owner, the fixed
project URL, no foreign keys referencing `vault.secrets`, and equality to the existing protected GitHub production secret
`PROFILE_PHOTO_WORKER_SECRET`. It returns only a boolean. The proof is bound to
the exact ciphertext-table fingerprint in the captured inventory; before/after
inventory equality still rejects source changes. It neither exports decrypted
Vault values nor reads the project root key, changes source settings, or invokes
any job. Unknown secrets, value mismatches, a different job, Storage blobs,
multipart uploads, foreign tables, or pgsodium encrypted data fail closed.

The archive preserves the **original encrypted Vault rows**, with unchanged
owners and ACLs. After the original isolated restore and full fingerprint
comparison succeeds, an additional disposable-only test captures the two names
and descriptions, deletes exactly those two known rows, recreates their values
using the protected settings, verifies them under the local fresh encryption
key, and rolls the test transaction back. Its new UUIDs exist only inside that
rolled-back rehearsal; the original ciphertext/IDs remain in the archive. The test requires
`backup_restore_admin`, the `/restore` Unix socket, no listening address,
disabled Cron execution, and no referring foreign keys before any mutation.
The container is also network-none.
It never runs against hosted Postgres. Parameter values are fed through psql's
extended-protocol `\bind` on stdin, in mode-0600 tmpfs SQL files outside the
archive directory; these files are removed on success and during failure
cleanup. No worker credential is placed in argv, stdout, or the artifact
manifest. The worker credential is not a Supabase root encryption key.

This mode has a distinct manifest contract:
`dominion-free-current-production-backup/v1`, `schemaVersion: 2`.
Its `vaultRecovery` object expressly says `selfContained: false` and records
that recovery depends on protected GitHub production settings
`VITE_SUPABASE_URL` and `PROFILE_PHOTO_WORKER_SECRET`. Preserve access to those
settings. It is **not a standalone Vault/root-key backup**: database dumps retain
Vault ciphertext, while its encryption key lives outside the database.
See [Supabase Vault encryption-key documentation](https://supabase.com/docs/guides/database/vault#encryption-key-location).
The old compatibility-cutover verifier rejects this different contract.

If the original root key is unavailable during a separately reviewed recovery,
the two settings must be reconstructed from those protected inputs before Cron
is enabled. The current general provisioning operator reads the decrypted view
before updating, so it cannot be assumed to repair old ciphertext under a
different key; Vault 0.3.1's `update_secret` itself also tries to decrypt the old
value. The isolated recovery proof instead recreates the exact two name-addressed
settings with explicit values without first decrypting their old ciphertext.
Any actual hosted recovery—including a proposed secret recreation—is a separate
reviewed action; this proof does not authorize or perform it.
