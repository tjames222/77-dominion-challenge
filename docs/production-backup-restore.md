# Production backup and isolated restore operator guide

This guide defines the fail-closed evidence boundary that must pass before the
one-time production migration-history reconciliation. It does not authorize a
hosted migration, schema change, Function deployment, Storage mutation, or
production release.

The capture follows Supabase's current logical-backup model: separate role,
application schema, and data dumps, plus separate migration-history dumps. The
data dump uses `--use-copy` and excludes the two vector relations Supabase calls
out in its [CLI backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
Actual Storage blobs are not in a database dump. This repository therefore
refuses to complete a capture while the object or multipart-upload inventories
are nonzero.

## Safety boundary

The operator must run the capture from a clean, exact release commit. Every
remote-capable executable, credential file, local image identity, project ref,
branch, commit, destination, and confirmation is explicit. The script validates
all of them before the first remote-capable hook or database dump.

The destination must already be a mounted encrypted volume outside the
repository. Dumps and inventories are written as mode-0600 files directly in
that volume. There is no plaintext staging directory. The volume passphrase
must be in a separate current-user-owned mode-0400 or mode-0600 file. Never put
the passphrase, database URL, access token, their files, or their hashes in the
repository, ticket comments, shell history, or CI logs.
Remote-hook, dump, restore, and verification subprocess output is redirected to
short-lived files inside the encrypted destination. Successful runs remove
those logs; failed runs retain them there for private diagnosis and emit only a
generic console error.

The required encrypted-volume hook is local-only. It receives:

```text
--destination <canonical-directory> --passphrase-file <private-file>
```

It must verify that the exact directory is the intended mounted encrypted
volume and that the supplied passphrase belongs to it. It must not mount,
unmount, unlock, copy, upload, or contact a network service. On success its only
stdout line is:

```text
DOMINION_ENCRYPTED_VOLUME_OK=<canonical-directory>
```

The operator pins the hook's SHA-256. A generic filesystem directory is not a
valid implementation of this hook.

## Reviewed capture hooks

The repository deliberately does not embed production credentials or assume a
hosted platform shape. Supply separately reviewed, absolute, executable hooks
and pin every hook hash. Each hook must write only to its `--output` path, which
the runner places inside the encrypted capture directory. Hooks must use
read-only transactions or read-only Management API operations, disable command
tracing, avoid credential-bearing stdout/stderr, and fail on partial inventory.

The Edge Functions hook receives `--supabase-cli`, `--project-ref`, and
`--output`, with the access token in `SUPABASE_ACCESS_TOKEN`. It writes:

```json
{
  "schemaVersion": 1,
  "projectRef": "abcdefghijklmnopqrst",
  "functions": [
    {
      "name": "function-name",
      "slug": "function-name",
      "status": "ACTIVE",
      "version": 1,
      "verifyJwt": true
    }
  ]
}
```

The Storage hook receives `--database-url-file`, `--project-ref`, and
`--output`. Its `relations` object must contain exactly these keys:

```text
storage.buckets
storage.buckets_analytics
storage.buckets_vectors
storage.iceberg_namespaces
storage.iceberg_tables
storage.objects
storage.s3_multipart_uploads
storage.s3_multipart_uploads_parts
storage.vector_indexes
```

Each value is `{"present":true,"rowCount":0}` or
`{"present":false,"rowCount":null}`. Buckets, objects, and both multipart
relations must be present. The document also includes complete, bytewise-sorted
`buckets` and `applicationPolicies` arrays. Each bucket records `id`, `name`,
`ownerId`, `public`, `fileSizeLimit`, `allowedMimeTypes`, and `type`; the bucket
array length must match the bucket relation count. Each policy records `table`,
`name`, `command`, `roles`, `using`, and `withCheck`, and an explicit
`applicationPolicyCount` must equal the array length. Any object or multipart row blocks completion;
export those blobs through the Storage API under a separately reviewed process
before retrying.

Three database-evidence hooks receive the same database URL file, project ref,
and output path:

- the source-manifest hook writes bytewise-key-sorted, unique JSONL records to
  `source-manifest.jsonl`;
- the source-fingerprint hook writes bytewise-key-sorted, unique JSONL records
  to `source-fingerprint.jsonl`, covering `auth`, `private`, `public`, `storage`,
  and `supabase_migrations` data;
- the relation-counts hook writes `relation-sequence-counts.json`, including
  the canonical schema list, every present or expected-absent relation with its
  row count and row SHA-256, and every sequence with its value and `isCalled`
  state.

JSONL records use `key`, `kind`, `identity`, and `definition`. The count file
uses this shape:

```json
{
  "schemaVersion": 1,
  "projectRef": "abcdefghijklmnopqrst",
  "schemas": ["auth", "private", "public", "storage", "supabase_migrations"],
  "relations": [
    {
      "schema": "auth",
      "name": "users",
      "present": true,
      "rowCount": 1,
      "rowsSha256": "<64-lowercase-hex>"
    }
  ],
  "sequences": [
    {
      "schema": "public",
      "name": "example_id_seq",
      "present": true,
      "lastValue": "1",
      "isCalled": false
    }
  ]
}
```

Absent relations and sequences use `null` for their value fields. Relation and
sequence identities must be unique and bytewise sorted.

A fourth read-only hook inventories migration-history presence in
`migration-history.json`. It must distinguish the audited absent schema from an
empty present table:

```json
{
  "schemaVersion": 1,
  "projectRef": "abcdefghijklmnopqrst",
  "schemaPresent": false,
  "tablePresent": false,
  "rowCount": null,
  "versions": []
}
```

For a present table, both presence flags are true, `rowCount` is a non-negative
integer, and `versions` is the complete, unique, sorted list of 14-digit version
strings with the same length. A present schema without `schema_migrations` is
unsupported and blocks capture. When the schema is absent, the runner does not
reinterpret a failed CLI dump. It creates two exact, deterministic comment-only
history artifacts. When it is present, both history dumps must succeed and
identify `supabase_migrations`. The archive and verifier therefore preserve the
difference between absent and present-empty states.

A fifth database hook writes `managed-application-ddl.sql`. The normal
Supabase schema dump owns the application schema, but does not recreate
application-owned policies or other reviewed DDL attached to the platform
`auth` and `storage` schemas. This hook must emit only that application-owned
DDL, in dependency-safe order, after this exact first line:

```sql
-- dominion managed application DDL v1
```

It must use a read-only source transaction. The hook itself is separately
reviewed and hash-pinned; review its SQL generation allowlist before capture.
The runner rejects psql meta-commands and cluster-level `ALTER SYSTEM`,
`CREATE DATABASE`, or `DROP DATABASE` statements, checksums the output, and
applies it only inside the isolated restore. Platform-owned Auth and Storage
schema definitions must not be copied into this file.

Before remote access, the runner also executes the exact CLI's `db dump
--dry-run` against a localhost placeholder and requires the pinned 2.109.0 data
scope: `--schema "*"`, Auth/Storage included, only their platform migration
tables excluded, and the two explicit vector exclusions. After capture it
requires `data.sql` to contain COPY sections for `auth.users` and
`storage.buckets`. This proves the archive includes Auth and Storage table data;
actual Storage blobs remain a separate Storage API concern.

## Capture

First close signup and quiesce application, Auth, Storage, scheduled, and direct
database writers. Record the quiescence instant outside the backup archive. Use
absolute paths and hashes; do not paste real values into a shared terminal log:

```bash
pnpm run capture:production-backup -- \
  --capture-id <unique-capture-id> \
  --project-ref <production-project-ref> \
  --expected-branch main \
  --expected-commit <exact-40-character-main-commit> \
  --supabase-cli <resolved-absolute-cli-binary> \
  --supabase-cli-sha256 <cli-sha256> \
  --database-url-file <private-database-url-file> \
  --database-url-sha256 <database-url-file-sha256> \
  --access-token-file <private-access-token-file> \
  --access-token-sha256 <access-token-file-sha256> \
  --destination <mounted-encrypted-directory> \
  --passphrase-file <private-passphrase-file> \
  --passphrase-sha256 <passphrase-file-sha256> \
  --encrypted-volume-check-hook <reviewed-volume-hook> \
  --encrypted-volume-check-hook-sha256 <volume-hook-sha256> \
  --edge-functions-inventory-hook <reviewed-edge-hook> \
  --edge-functions-inventory-hook-sha256 <edge-hook-sha256> \
  --storage-inventory-hook <reviewed-storage-hook> \
  --storage-inventory-hook-sha256 <storage-hook-sha256> \
  --source-manifest-hook <reviewed-source-manifest-hook> \
  --source-manifest-hook-sha256 <source-manifest-hook-sha256> \
  --source-fingerprint-hook <reviewed-source-fingerprint-hook> \
  --source-fingerprint-hook-sha256 <source-fingerprint-hook-sha256> \
  --relation-counts-hook <reviewed-relation-counts-hook> \
  --relation-counts-hook-sha256 <relation-counts-hook-sha256> \
  --migration-history-hook <reviewed-history-hook> \
  --migration-history-hook-sha256 <history-hook-sha256> \
  --managed-application-ddl-hook <reviewed-managed-ddl-hook> \
  --managed-application-ddl-hook-sha256 <managed-ddl-hook-sha256> \
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141 \
  --postgres-image-id sha256:<exact-local-image-id> \
  --confirm-read-only-capture "CAPTURE <production-project-ref> <exact-commit>"
```

Success creates `<destination>/<capture-id>/` with exactly:

```text
capture.json
roles.sql
schema.sql
managed-application-ddl.sql
data.sql
history-schema.sql
history-data.sql
edge-functions.json
storage-metadata.json
source-manifest.jsonl
source-fingerprint.jsonl
relation-sequence-counts.json
migration-history.json
SHA256SUMS
CAPTURE_COMPLETE.json
```

`SHA256SUMS` covers every file except itself and the completion marker. The
marker binds the manifest digest; the source manifest, source fingerprint,
relation/sequence counts, migration-history, and managed-DDL digests; exact
project and commit; and the exact RFC3339 UTC `capturedAt` also stored in
`capture.json`. A failed run leaves `CAPTURE_INCOMPLETE` and never creates a
completion marker. Do not reuse that directory.

## Isolated restore rehearsal

The restore runner does not connect to production and does not pull an image.
It first verifies the encrypted mount and complete capture, then requires the
already-present image to match both the exact tag and image ID. It creates one
uniquely named container with `--network none`, `--pull never`, a tmpfs database
directory, ownership labels, and a read-only bind of the capture. Roles,
application schema, reviewed managed Auth/Storage DDL, migration-history schema,
and data restore in one fail-fast transaction into a unique database on
PostgreSQL server version 17.6.

The required restore-verification hook receives the exact Docker binary,
container, database, capture directory, capture ID, restore ID, and an encrypted
output path. It must compare the restored source manifest, fingerprints,
relation/sequence state, and required role/schema/data invariants. It writes:

```json
{
  "schemaVersion": 1,
  "captureId": "capture-id",
  "restoreId": "restore-id",
  "databaseName": "dominion_restore_restore_id",
  "checks": [
    { "name": "managed-application-ddl", "status": "pass" },
    { "name": "migration-history", "status": "pass" },
    { "name": "relation-sequence-counts", "status": "pass" },
    { "name": "roles-schema-data", "status": "pass" },
    { "name": "source-fingerprint", "status": "pass" },
    { "name": "source-manifest", "status": "pass" }
  ]
}
```

This exact ordered check set is required and every check must pass. Run:

```bash
pnpm run rehearse:production-backup-restore -- \
  --capture-id <capture-id> \
  --restore-id <unique-lowercase-hyphen-id> \
  --project-ref <production-project-ref> \
  --expected-branch main \
  --expected-commit <exact-commit> \
  --supabase-cli-sha256 <captured-cli-sha256> \
  --destination <mounted-encrypted-directory> \
  --passphrase-file <private-passphrase-file> \
  --passphrase-sha256 <passphrase-file-sha256> \
  --encrypted-volume-check-hook <reviewed-volume-hook> \
  --encrypted-volume-check-hook-sha256 <volume-hook-sha256> \
  --docker-bin <resolved-absolute-docker-binary> \
  --docker-bin-sha256 <docker-binary-sha256> \
  --restore-verification-hook <reviewed-restore-hook> \
  --restore-verification-hook-sha256 <restore-hook-sha256> \
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141 \
  --postgres-image-id sha256:<captured-image-id> \
  --confirm-local-restore "RESTORE <capture-id> <restore-id>"
```

Before cleanup, the runner rechecks the full container ID, image ID, image ref,
capture ID, restore ID, and ownership token. A mismatch refuses deletion and
leaves the unexpected container for manual investigation. A successful run
removes the verified container, proves it is absent, and creates sibling
`restore-<capture-id>-<restore-id>/` evidence containing:

```text
restore-verification.json
restore.json
SHA256SUMS
RESTORE_COMPLETE.json
```

`restore.json` binds the backup manifest, exact image, server version 170006,
unique database, and true `cleanupOwnershipVerified` and `containerRemoved`
values. No completion marker is written unless cleanup succeeds.

## Standalone release gate

The reconciler should call the standalone verifier instead of parsing loose
paths. It performs no network or Docker operation:

```bash
pnpm run verify:production-backup-evidence -- \
  --destination <mounted-encrypted-directory> \
  --capture-id <capture-id> \
  --restore-id <restore-id> \
  --project-ref <production-project-ref> \
  --expected-branch main \
  --expected-commit <exact-commit> \
  --supabase-cli <resolved-absolute-cli-binary> \
  --supabase-cli-sha256 <captured-cli-sha256> \
  --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141 \
  --postgres-image-id sha256:<captured-image-id> \
  --passphrase-file <private-passphrase-file> \
  --passphrase-sha256 <passphrase-file-sha256> \
  --encrypted-volume-check-hook <reviewed-volume-hook> \
  --encrypted-volume-check-hook-sha256 <volume-hook-sha256>
```

Its stdout is machine-only:

```text
BACKUP_MANIFEST_SHA256=<hex>
RESTORE_EVIDENCE_MANIFEST_SHA256=<hex>
SOURCE_MANIFEST_SHA256=<hex>
SOURCE_FINGERPRINT_SHA256=<hex>
RELATION_SEQUENCE_COUNTS_SHA256=<hex>
MIGRATION_HISTORY_SHA256=<hex>
MANAGED_APPLICATION_DDL_SHA256=<hex>
MIGRATION_HISTORY_STATE=<absent-or-present>
SUPABASE_CLI_SHA256=<hex>
POSTGRES_IMAGE_ID=sha256:<hex>
CAPTURED_AT=<RFC3339-UTC>
CAPTURE_DIRECTORY=<canonical-path>
RESTORE_DIRECTORY=<canonical-path>
```

The migration runner must independently compare the current CLI binary and
local image identities with these values. It must require `CAPTURED_AT` to be
after writer quiescence and inside the approved freshness window. It must also
compare the restored source artifacts and their exact hashes with the reviewed
production source gate before applying any migration.

Run the fake-boundary suite without credentials, Docker, or network access:

```bash
pnpm run test:production-backup-restore
```
