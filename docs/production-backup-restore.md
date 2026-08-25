# Production backup and isolated restore operator guide

This guide defines the fail-closed evidence boundary that must pass before the
one-time production migration-history reconciliation. It does not authorize a
hosted migration, schema change, Function deployment, Storage mutation, or
production release.

The capture follows Supabase's current logical-backup model: separate role,
application schema, and data dumps, plus separate migration-history dumps. The
exact Supabase CLI is used only to generate and hash its canonical dry-run
filter scripts. The exact pinned PostgreSQL image executes those reviewed
scripts with a read-only mounted pgpass file. The data dump uses `--use-copy`
and excludes the two vector relations Supabase calls out in its
[CLI backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
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
the passphrase, database passfile, access token, their files, or their hashes in the
repository, ticket comments, shell history, or CI logs.
Remote-hook, dump, restore, and verification subprocess output is redirected to
short-lived files inside the encrypted destination. A failing subprocess or
missing output retains its private log there for diagnosis and emits only a
generic console error; successfully validated steps remove their logs before
the evidence inventory is sealed.

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
valid implementation of this hook. Docker must resolve through a local
`unix://` context; SSH and TCP Docker contexts are rejected before image or
hosted-database access.

The database URL file is owner-only mode 0400 or 0600 and contains no password.
It must identify the exact project, `postgres` database, TLS port 5432, and only
`sslmode=require`. The separate pgpass file contains exactly one matching
five-field row, with no wildcard or noncanonical escape. URL userinfo passwords,
credential query parameters, extra query parameters, ambient libpq variables,
and repository dotenv influence are rejected or removed. Neither the secret nor
a password-bearing URL appears in process argv, environment, stdout, stderr, or
evidence. The trusted local Docker daemon/root can inspect a read-only bind while
the dump runs; that host-admin boundary is unavoidable and must be part of the
operator approval.

## Independently approved tool manifest

Caller-supplied hook hashes are not approval by themselves. Before the
maintenance window, a second reviewer must approve a non-secret JSON manifest,
record its SHA-256 through the release approval channel, and bind it to the exact
release commit. The operator must use that reviewed digest, not one calculated
ad hoc during capture:

```json
{
  "schemaVersion": 1,
  "artifactContract": "dominion-production-backup-approved-tools/v1",
  "releaseCommit": "<40-hex>",
  "captureTools": { "<exact-v1-tool-key>": "<sha256>" },
  "captureToolsetSha256": "<canonical-capture-map-sha256>",
  "restoreTools": { "<exact-v1-tool-key>": "<sha256>" },
  "restoreToolsetSha256": "<canonical-restore-map-sha256>"
}
```

The capture, restore, standalone verifier, and reconciliation gate compare the
actual tool bytes with this inventory and preserve the approved manifest hash
in metadata and completion markers. Recomputing the file invalidates approval.

## Reviewed capture hooks

The repository deliberately does not embed production credentials or assume a
hosted platform shape. Supply separately reviewed, absolute, executable hooks
and pin every hook hash. Each hook must write only to its `--output` path, which
the runner places inside the encrypted capture directory. Hooks must use
read-only transactions or read-only Management API operations, disable command
tracing, avoid credential-bearing stdout/stderr, and fail on partial inventory.

The Edge Functions hook receives `--supabase-cli`, `--project-ref`,
`--access-token-file`, and `--output`. The hook reads the owner-only token file
itself; the token is never placed in process arguments or environment. It writes:

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

The Storage hook receives `--database-client-contract exact-docker-pgpass/v1`,
`--database-url-file`, `--database-passfile`, `--project-ref`, `--docker-bin`,
`--postgres-image`, `--postgres-image-id`, and
`--output`. Every database hook receives the same exact Docker/image boundary;
reviewed hooks must use that already-present image by ID with `--pull never`
instead of an ambient host client or mutable tag. Its `relations` object must
contain exactly these keys:

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
`{"present":false,"rowCount":null}`. Every relation except the two optional
Iceberg relations must be present. The document also includes complete, bytewise-sorted
`buckets` and `applicationPolicies` arrays. Each bucket records `id`, `name`,
`ownerId`, `public`, `fileSizeLimit`, `allowedMimeTypes`, and `type`; the bucket
array length must match the bucket relation count. Each policy records `table`,
`name`, `command`, `roles`, `using`, and `withCheck`, and an explicit
`applicationPolicyCount` must equal the array length. Any object, multipart, or
excluded-vector row blocks completion;
export those blobs through the Storage API under a separately reviewed process
before retrying.

Three database-evidence hooks receive the same database URL file, database
passfile, project ref, Docker/image identity, and output path:

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
--dry-run` against a non-secret localhost placeholder and requires the pinned 2.109.0 data
scope: `--schema "*"`, Auth/Storage included, only their platform migration
tables excluded, and the two explicit vector exclusions. After capture it
requires `data.sql` to contain COPY sections for `auth.users` and
`storage.buckets`. Every real dry run occurs outside the repository with an
empty environment, is checked against the exact pinned environment/command
shape, and is transformed to use the read-only container pgpass mount. The CLI
never executes the real dump. This proves the archive includes Auth and Storage table data;
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
  --database-passfile <private-database-pgpass-file> \
  --database-passfile-sha256 <database-pgpass-file-sha256> \
  --credential-validator-sha256 <checked-in-validator-sha256> \
  --docker-bin <resolved-absolute-docker-binary> \
  --docker-bin-sha256 <docker-binary-sha256> \
  --dump-script-transformer-sha256 <checked-in-transformer-sha256> \
  --approved-tool-manifest <independently-reviewed-tool-manifest> \
  --approved-tool-manifest-sha256 <independently-recorded-manifest-sha256> \
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
  --writer-quiesced-at <RFC3339-UTC-whole-second> \
  --confirm-read-only-capture "CAPTURE <production-project-ref> <exact-commit>"
```

Success creates `<destination>/<capture-id>/` with exactly:

```text
capture.json
approved-tool-manifest.json
roles.sql
schema.sql
managed-application-ddl.sql
data.sql
dump-contract.json
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
marker binds the manifest digest; approved tool-manifest and toolset hashes;
the source manifest, source fingerprint,
relation/sequence counts, migration-history, and managed-DDL digests; exact
project and commit; and the exact RFC3339 UTC `writerQuiescedAt`,
`captureStartedAt`, and `capturedAt` stored in `capture.json`. Capture start
must not precede writer quiescence and completion must not precede start. A
failed run leaves `CAPTURE_INCOMPLETE`. That marker is authoritative even if a
later-stage failure also left a candidate completion marker: the standalone
verifier rejects any directory containing the incomplete marker. Do not reuse
that directory. The runner removes it only after the manifest and completion
marker pass a full staged verification, then repeats the verification against
the completed inventory.

## Isolated restore rehearsal

The restore runner does not connect to production and does not pull an image.
It first verifies the encrypted mount and complete capture, then requires the
already-present image to match both the exact tag and image ID and launches it
by full image ID. It creates one
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
  --capture-toolset-sha256 <captured-toolset-sha256> \
  --approved-tool-manifest <independently-reviewed-tool-manifest> \
  --approved-tool-manifest-sha256 <independently-recorded-manifest-sha256> \
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

Before cleanup, the runner rechecks and thereafter addresses only the full
container ID, plus the image ID, image ref,
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

`restore.json` binds the backup manifest, approved manifest and restore toolset,
exact image, server version 170006,
unique database, and true `cleanupOwnershipVerified` and `containerRemoved`
values. Failed runs retain `RESTORE_INCOMPLETE`; the verifier rejects that
marker even if cleanup succeeded and a later evidence-finalization step failed.

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
  --credential-validator-sha256 <checked-in-validator-sha256> \
  --dump-script-transformer-sha256 <checked-in-transformer-sha256> \
  --approved-tool-manifest <independently-reviewed-tool-manifest> \
  --approved-tool-manifest-sha256 <independently-recorded-manifest-sha256> \
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
  --postgres-image-id sha256:<captured-image-id> \
  --passphrase-file <private-passphrase-file> \
  --passphrase-sha256 <passphrase-file-sha256> \
  --encrypted-volume-check-hook <reviewed-volume-hook> \
  --encrypted-volume-check-hook-sha256 <volume-hook-sha256> \
  --docker-bin <resolved-absolute-docker-binary> \
  --docker-bin-sha256 <docker-binary-sha256> \
  --restore-verification-hook <reviewed-restore-hook> \
  --restore-verification-hook-sha256 <restore-hook-sha256>
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
CAPTURE_TOOLSET_SHA256=<hex>
RESTORE_TOOLSET_SHA256=<hex>
APPROVED_TOOL_MANIFEST_SHA256=<hex>
MIGRATION_HISTORY_STATE=<absent-or-present>
SUPABASE_CLI_SHA256=<hex>
POSTGRES_IMAGE_ID=sha256:<hex>
WRITER_QUIESCED_AT=<RFC3339-UTC>
CAPTURE_STARTED_AT=<RFC3339-UTC>
CAPTURED_AT=<RFC3339-UTC>
CAPTURE_DIRECTORY=<canonical-path>
RESTORE_DIRECTORY=<canonical-path>
```

## One-version production reconciliation

Never apply the 13 historical versions with a direct linked CLI command. The
hosted entrypoint consumes the standalone backup/restore result, captures live
manifest, fingerprint, raw history, and pinned-CLI history again, applies
exactly one immutable staged file with `migration up`, verifies the post-state,
and chains a completion digest to the next version. It contains no `db push`,
`migration repair`, `--include-all`, or reset path.

Keep signup, application writes, Storage writers, and every other database
writer quiesced from before capture until the final version completes. The
runner derives UTC from the plan-pinned system clock; neither an operator
argument nor a loose file can supply its current time. Backup age may be at most
3600 seconds and may be approved for a shorter interval. If the evidence expires
before a mutation boundary, stop, take and restore a new quiesced backup, and
approve new stage plans. Do not relax the age limit.

### Approve each stage

Create one exact immutable stage per version with the existing stage builder and
rehearse that single transition against the restored snapshot. The local
rehearsal produces canonical pre/post manifests and fingerprints plus the
version-specific effect-verification JSON. Put only their absolute paths,
reviewed backup identities, exact stage, and exact tool paths in an
off-repository canonical JSON contract:

```json
{
  "schemaVersion": 1,
  "artifactContract": "dominion-production-reconciliation-local-rehearsal/v1",
  "databaseClientContract": "exact-docker-pgpass/v1",
  "projectRef": "<production-project-ref>",
  "expectedBranch": "main",
  "releaseCommit": "<exact-40-hex-main-commit>",
  "throughVersion": "<one-approved-14-digit-version>",
  "previousCompletionSha256": "<64-hex-or-all-zero-genesis>",
  "backupEvidence": {
    "backupManifestSha256": "<hex>",
    "captureToolsetSha256": "<hex>",
    "managedApplicationDdlSha256": "<hex>",
    "maxCaptureAgeSeconds": 3600,
    "migrationHistorySha256": "<hex>",
    "migrationHistoryState": "<absent-or-present>",
    "postgresImageId": "sha256:<hex>",
    "relationSequenceCountsSha256": "<hex>",
    "restoreEvidenceManifestSha256": "<hex>",
    "restoreToolsetSha256": "<hex>",
    "sourceFingerprintSha256": "<hex>",
    "sourceManifestSha256": "<hex>",
    "writerQuiescedAt": "<RFC3339-UTC-second>"
  },
  "expectedPreArtifacts": {
    "sourceFingerprint": "<absolute-local-rehearsal-file>",
    "sourceManifest": "<absolute-local-rehearsal-file>"
  },
  "expectedPostArtifacts": {
    "effectVerification": "<absolute-local-rehearsal-file>",
    "sourceFingerprint": "<absolute-local-rehearsal-file>",
    "sourceManifest": "<absolute-local-rehearsal-file>"
  },
  "approvedBackupToolManifest": "<absolute-reviewed-backup-tool-manifest>",
  "reconciliationStage": "<absolute-immutable-stage>",
  "toolPaths": {
    "artifactHelperSha256": "<absolute-artifact-helper>",
    "backupArtifactVerifierSha256": "<absolute-backup-artifact-verifier>",
    "backupEvidenceVerifierSha256": "<absolute-backup-evidence-verifier>",
    "commonHelperSha256": "<absolute-common-helper>",
    "clockSha256": "/bin/date",
    "credentialValidatorSha256": "<absolute-credential-validator>",
    "dockerBinSha256": "<absolute-docker-binary>",
    "dumpScriptTransformerSha256": "<absolute-dump-transformer>",
    "effectVerificationHookSha256": "<absolute-effect-hook>",
    "encryptedVolumeCheckHookSha256": "<absolute-volume-hook>",
    "gitBinSha256": "<absolute-git-binary>",
    "historyVerifierSha256": "<absolute-history-verifier>",
    "manifestValidatorSha256": "<absolute-manifest-validator>",
    "migrationHistoryHookSha256": "<absolute-migration-history-hook>",
    "nodeBinSha256": "<absolute-node-binary>",
    "preflightSha256": "<absolute-preflight-helper>",
    "runnerSha256": "<absolute-reconciliation-runner>",
    "sourceFingerprintHookSha256": "<absolute-source-fingerprint-hook>",
    "sourceManifestHookSha256": "<absolute-source-manifest-hook>",
    "stageVerifierSha256": "<absolute-stage-verifier>",
    "supabaseCliSha256": "<absolute-supabase-cli>"
  }
}
```

The generator validates the complete schema, reruns the immutable-stage
verifier, hashes every tool and rehearsal artifact, and writes a canonical plan:

```bash
pnpm run prepare:production-reconciliation-plan -- \
  --rehearsal-contract <absolute-rehearsal-contract.json> \
  --output <absolute-approved-plan-candidate.json>
```

A second reviewer must inspect the exact plan and independently record its
reported `APPROVED_RECONCILIATION_PLAN_SHA256`. Generating a plan is not
approval. The first version alone uses the all-zero previous digest. Every later
plan uses the immediately preceding
`PRODUCTION_RECONCILIATION_COMPLETION_SHA256`; its pre-state must equal that
verified completion's post-state.

### Run one version

Use the same owner-only passwordless database URL and exact one-row pgpass
boundary as capture. Supply `genesis` only for the first version; later runs use
the absolute prior evidence directory. After the second `--`, pass the exact
standalone evidence-verifier arguments shown above plus the independently
approved `--expected-*` evidence hashes, `--writer-quiesced-at`,
`--max-capture-age-seconds`, `--release-commit`, `--through-version`,
`--reconciliation-stage`, and
`--expected-reconciliation-stage-manifest-sha256`. The runner captures its own
live before-history; callers cannot supply either before-history flag.

```bash
pnpm run run:production-reconciliation-step -- \
  --reconciliation-id <new-safe-id> \
  --database-url-file <private-passwordless-url-file> \
  --database-url-file-sha256 <hex> \
  --database-passfile <private-exact-pgpass-file> \
  --database-passfile-sha256 <hex> \
  --previous-completion-evidence <genesis-or-absolute-prior-evidence-directory> \
  --approved-reconciliation-plan <absolute-reviewed-plan.json> \
  --approved-reconciliation-plan-sha256 <independently-recorded-hex> \
  --effect-verification-hook <absolute-reviewed-hook> \
  --confirm-one-version "<release-commit>:<through-version>:<plan-sha256>" \
  -- \
  <exact-preflight-arguments>
```

Before the hosted read boundary and again immediately before mutation, the
runner requires the exact clean `main` commit, reviewed tools, immutable stage,
local Unix Docker context, pinned image ID, credential hashes and target, and
encrypted destination. It creates `RECONCILIATION_INCOMPLETE.json` inside the
encrypted evidence directory before the first hosted call. Preflight and
apply-boundary captures must be byte-identical. The pinned CLI must report the
real 2.109.0 JSON envelopes and exactly one pending local version. Only then does
the runner execute one `migration up --yes`.

Immediately before that `migration up`, the runner obtains a fresh RFC 3339 UTC
timestamp from the plan-bound, hash-pinned clock tool. It rejects an
authenticated backup whose `capturedAt` is in the future or older than the
plan-approved limit, which can never exceed 3600 seconds. It records the check
as `mutation-boundary-freshness.json` with captured stdout and stderr in the
encrypted evidence directory; callers cannot supply or override this time.

After apply, raw and CLI history must contain the exact new prefix; the complete
manifest, fingerprint, and version-specific effect output must match the
approved plan. The encrypted volume is re-attested before a staged completion
marker is finalized. Success emits the machine-readable completion digest and
evidence directory. The standalone verifier semantically rechecks the copied
`reconciliation-stage.json`, mutation-boundary freshness evidence, real
migration-up envelope and path, and
`final-encrypted-volume-attestation.{stdout,stderr}` before accepting the
completion. Verify it independently:

```bash
pnpm run verify:production-reconciliation-completion -- \
  --evidence-directory <absolute-encrypted-reconciliation-directory> \
  --phase complete \
  --completion-sha256 <reported-completion-sha256> \
  --project-ref <production-project-ref> \
  --release-commit <exact-commit> \
  --through-version <just-applied-version> \
  --approved-plan-sha256 <independently-recorded-plan-sha256>
```

Do not start the next version unless this verifier succeeds and its digest is
the next plan's approved `previousCompletionSha256`. A failure before mutation
requires diagnosis and a new reconciliation ID. A failure after `migration up`
may mean the database changed even though completion evidence is incomplete:
stop, capture live history and effects read-only, and approve a forward recovery
plan. Never rerun blindly, rewrite an applied file, repair history, or mark the
incomplete evidence complete by hand.

Run all fake-boundary suites without credentials, Docker, or network access:

```bash
pnpm run test:production-backup-restore
pnpm run test:production-reconciliation
```
