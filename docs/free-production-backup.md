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
must be absent from the source. The explicitly selected 61/66/67 modes additionally
feed their existing worker credentials on stdin for local reconstruction tests, described below;
no database credential is passed or mounted. Cron execution is disabled. The restore must reproduce
every non-system table's row count and SHA-256 content fingerprint, sequence
state, large-object fingerprint, migration history, and event-trigger ownership,
enabled state, tags, and function identity/ownership. These event-trigger records
remain private inside the encrypted inventory. PostgreSQL 17 membership
grants issued by the source bootstrap superuser are replayed by the disposable
cluster's bootstrap administrator; other grantors and all grant options are
preserved. The original role SQL remains unchanged in the backup. Matching source
inventories before and after capture also reject concurrent changes. Foreign
tables, Storage objects or multipart uploads, and unreviewed Vault/pgsodium encrypted
data fail closed because this backup would not contain their external data or root key.

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

For the historical thirteen-migration cutover only, run this workflow from `main`,
download its successful encrypted artifact, apply
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

## Historical 61-migration September 27 checkpoint

Choose `current-production-2026-09-27` explicitly when dispatching the manual
workflow to capture that historical pre-release database checkpoint. This separate mode pins
exactly 61 migration versions through `20260913082358` and a source-fixed SHA-256
of that complete ordered prefix. It does not silently accept the candidate's
five pending migrations, an arbitrary database history, or a different prefix.
The old thirteen-migration default and compatibility-cutover evidence verifier
are unchanged.

### Preserving pg_net extension data

PostgreSQL omits non-configuration extension-member contents from `pg_dump`,
including when selecting those tables explicitly. The pinned production
`pg_net` 0.20.3 has exactly three such relations: `net._http_response`,
`net.http_request_queue`, and `net.http_request_queue_id_seq`. Current mode
checks the exact version, extension membership/configuration, table column
order/types/nullability, absence of user triggers, and sequence definition.
Unknown non-configuration extension relations fail closed. See the
[PostgreSQL extension configuration-table contract](https://www.postgresql.org/docs/17/extend-extensions.html#EXTEND-EXTENSIONS-CONFIG-TABLES).

Two explicit read-only binary `COPY TO STDOUT` operations preserve every row
in `pg-net-http-response.copy` and `pg-net-http-request-queue.copy`, inside the
same private mode-0600 tmpfs capture directory. The sequence value and
`is_called` flag come from the original validated inventory, without invoking
`nextval`. Both binary files are included in the encrypted tar. The
`pgNetSupplement` manifest records their exact names, byte lengths, SHA-256
hashes, extension version, binary format, and lossless sequence state under
`dominion-pg-net-binary-supplement/v1`. Neither HTTP bodies nor headers are
printed, and there is no hosted `COPY FROM`, `setval`, or extension mutation.
The original source-before/after and full restored-inventory equality checks
are unchanged; no pg_net table, response, queued request, or sequence is ignored.

Current-mode isolated startup additionally preloads pg_net (required for its
native extension DDL), sets `max_worker_processes=0`, `pg_net.batch_size=0`,
and directs its worker at the deliberately nonexistent
`dominion_backup_disabled` database. Cron stays off, networking stays disabled,
and no background worker can drain requests or expire responses. The legacy
startup remains unchanged unless the exact current-mode flag is passed.
Each binary replay refuses before writing unless the local admin/socket/
no-listener/worker-disable settings, absent worker database, pinned metadata,
and empty destination table all match. Replay is transactional; corrupt or
truncated input cannot commit partial rows. The sequence uses psql17 bound
parameters against the one fixed local sequence. Any failure prevents artifact
publication and removes only the owned disposable runtime. Future recovery must
preserve these no-worker/no-egress conditions until separately reviewed;
restoring queued requests into an active worker could resend them.

Native tests use the actual restricted startup script and the exact production
psql `-c`/binary-stdin transport. They verify full equality for nonempty queues,
expired responses, nulls, JSON, Unicode, newlines and bytea; both sequence states;
metadata/runtime/role refusals; and rollback of damaged binary copies. The
existing fresh-key Vault tests also run under this current-mode startup in CI.

The 61-migration checkpoint contains exactly two regenerable Vault settings:
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

## Post-Early-Access 66-migration checkpoint

Choose `post-early-access-66` explicitly when dispatching
`production-backup.yml` from reviewed protected `main`. This is not a
"latest" mode: it pins exactly 66 versions through
`20260927233055_early_access_account_bootstrap`, with SHA-256
`f39a1a6975b422fdeb0e3fd3a928957d3f674e2e99e37551e78266d613277caf`
of the ordered version array. A 61-, 65-, or 67-migration source, a modified
prefix, or PostgreSQL other than the already pinned 17.6 fails closed. Neither
historical mode nor its manifest/evidence semantics changes.

This mode is bounded to exactly these five Vault names:

- `profile_photo_project_url`
- `profile_photo_worker_secret`
- `early_access_project_url`
- `early_access_feedback_worker_secret`
- `early_access_invitation_worker_secret`

Both URL values must equal the fixed existing project URL. The three worker
values must equal the already-existing protected production settings
`PROFILE_PHOTO_WORKER_SECRET`, `FEEDBACK_WORKER_SECRET`, and
`EARLY_ACCESS_INVITATION_WORKER_SECRET`. Only the explicit 66 and 67 modes receive
the latter two secrets. Before actual dispatch, obtain explicit owner approval for these
additional protected-secret reads and for the conditional recovery contract;
local synthetic tests do not constitute that approval. No secret is created,
rotated, repaired, disclosed, or written to hosted Vault.

The parameter-bound source proof returns only one boolean and requires exactly
the three existing active five-minute jobs, with the source-fixed command,
database and owner for each: `process-profile-photo-cleanup`,
`process-early-access-feedback`, and `process-early-access-invitations`.
It additionally retains the ciphertext-inventory hash binding, null key IDs,
unique exact names, and absence of referring foreign keys. A mismatched job,
extra Vault row, wrong protected value, or unknown key is a failure, not
permission to change the source.

Capture retains all private Early Access request, invitation, feedback,
bootstrap and delivery rows, including application-encrypted envelopes.
The existing exact pg_net supplement, all-table/sequence/large-object/
event-trigger inventory, before/after equality, credential deadline, encrypted
size cap, seven-day artifact retention, and cleanup boundaries are unchanged.
Storage objects, multipart uploads/parts, foreign tables and pgsodium key rows
must still be absent. Production workers are not paused by this workflow;
concurrent changes can safely stop capture, and a retry requires investigating
the failed gate rather than ignoring changed inventory.

After credential revocation and exact full restore comparison, only the
owned fresh-root, network-none local cluster can test reconstruction. Its
guards require the local restore administrator/socket/no-listener settings,
Cron disabled, pg_net workers disabled, the nonexistent worker database and
zero background workers. It deletes and recreates only these five names,
preserves descriptions, verifies the explicit values under the fresh key, and
rolls everything back. The archive retains the original ciphertext and IDs.
No hosted restore, reset, new project, email, worker invocation, plan upgrade,
or old canary entitlement operation is authorized or performed.

The new manifest is `schemaVersion: 3`,
`dominion-free-post-early-access-backup/v1`. Its Vault recovery remains
`selfContained: false`, conditional on the fixed project URL and those three
protected worker keys; it does not contain the Vault root key. Its separate
`applicationEnvelopeRecovery` record explicitly says that encrypted
invitation/setup payloads were preserved but **decryption was not verified**.
Recovery of those payloads also depends on the separately retained
`EARLY_ACCESS_INVITATION_KEY` and `EARLY_ACCESS_INVITATION_KEY_VERSION`.
This backup mode neither reads nor passes either application-envelope setting.
Their custody and any future decryption/recovery must be reviewed separately.

The historical compatibility-cutover verifier intentionally rejects this new
contract. A successful 66-migration backup is not permission to run the old
cutover/restart controller or owner-canary grant. Before a later full release,
download the fresh artifact, retain the recipient private key securely, verify
its exact commit/run/checkpoint/encrypted hashes and isolated-restore evidence,
and obtain the separate release approval. An older successful 61-migration
artifact does not prove a backup of subsequent production activity.

## Post-admin-inbox 67-migration checkpoint

Choose `post-admin-inbox-67` explicitly for the database after the admin inbox
release. It pins exactly 67 migration versions through
`20260929000950_site_admin_account_requests_inbox`, with SHA-256
`fea508a9d28234417a250bfd23825eb418265957c8c1e11b7365750acafb1358`
of the ordered version array. Pending later source migrations do not advance
the selected checkpoint. A 66-, 68-, or any other migration-count source,
missing/changed prefix, unsupported PostgreSQL version or failed inventory
boundary is rejected. The historical 13, 61 and 66 modes remain unchanged;
do not run the 66 mode against the deployed 67-migration database.

The inbox migration adds its metadata-only RPC, index and execution ACL; it
adds no Vault names, Cron jobs, pg_net relations or external Storage data.
The 67 mode therefore reuses the exact five-name, three-job, parameter-bound
source proof and fresh-root reconstruction described above without widening
them. Only the same three existing protected worker keys are passed, and only
after approval for this capture and conditional recovery contract. No root
key, application-envelope key, Resend key or Linear key is read by this mode.

The manifest remains version 3 with contract
`dominion-free-post-early-access-backup/v1`; the explicit `backupMode` and exact
migration array distinguish this checkpoint. All size, encryption, credential,
pg_net, zero-Storage, before/after inventory, cleanup and recovery-custody
requirements remain unchanged. The backup is still not self-contained for
Vault or invitation-envelope recovery. A synthetic native test additionally
restores the actual inbox schema and nonempty request ledger, checking the
RPC definition/owner/ACL/configuration, index, RLS and member privileges along
with original Vault ciphertext and pg_net data.

Before the next normal full release, merge and validate the exact protected
main commit, obtain approval for this fresh capture, and run the 67 mode from
that same commit while production is still at 67. Require complete workflow
success including final credential cleanup, independently download and verify
its ciphertext/manifest and run/attempt/commit/checkpoint, and retain the
recipient private key securely before dispatching the separately approved
release. The older 66 artifact is pre-inbox evidence, not a backup of the
current database. A later migration cannot make it current, and this mode
does not authorize hosted restore, reset, secret repair or replay of the old
canary cutover.
