# Production backup, isolated restore, and reconciliation evidence

This is the operator contract for the one-time production migration-history
reconciliation. It is deliberately fail closed. It does not authorize a
hosted write, a deployment, or a database migration by itself.

## Release blockers

Do not run a production entrypoint yet. The following boundaries remain
approval-gated and must be frozen together before an operator run:

- the operator-pack launcher as the sole clean-environment trust boundary and
  its fixed `repository-operator-clean` child mapping;
- the complete macOS/Node trusted-computing-base attestation;
- creation of a previously nonexistent AES-256 sparsebundle and its v2
  creation/attachment attestation; and
- the external pack rehearsal producer, including its exact launcher mapping,
  option contract, executable inventory, and sealed output inventory; and
- the reviewed recovery-only consumer for preserved Docker recovery records.

The checked-in scripts intentionally reject an unbound launcher. A recovery
record is evidence for a future reviewed recovery tool; it is not permission
to remove a container manually. Never delete a preserved runtime or its bind
sources while an owned container may survive.

## Fixed release and storage boundary

Use a clean, canonical `main` worktree at the exact approved release commit.
The release repository, pack root, launcher, entrypoints, transitive helpers,
and every external executable are hash-bound before use. Production entrypoints
must be reached through the approved operator-pack launcher; direct shell
execution is unsupported.

The evidence destination must be the exact owner-owned, mode-0700, no-ACL
mountpoint created by the approved AES-256 helper. It must be under the explicit
Colima-shared home root. Every credential, CA, pinned executable, log, recovery
record, capture, restore, and reconciliation artifact stays on that attested
filesystem. Do not stage secrets in `/tmp`, `/private/tmp`, the repository, or
an ordinary home directory.

The encrypted-volume contract is exactly:

```text
schemaVersion: 2
artifactContract: dominion-encrypted-volume-attestation/v2
creation record: dominion-encrypted-volume-aes256-creation-record/v2
```

The creation record must prove the image did not exist before the exact
`hdiutil create ... -encryption AES-256 -stdinpass` operation. The attestation
binds the sparsebundle files, UUID, image and mounted-session identities,
`hdidPid`, destination, owner/mode, and the creation-record hash. Verification
uses the pack launcher and the exact `encrypted-volume-check` mapping:

```text
--operation verify
--destination <canonical-mounted-root>
--attestation <private-attestation-json-inside-root>
--attestation-sha256 <reviewed-sha256>
```

It must print only the attestation SHA-256 and canonical destination identities
defined by the v2 hook. The old passphrase-based, single-line success-marker
contract is retired.

## Hosted database credential contract

The client contract is exactly:

```text
exact-supavisor-session-jit-pgpass-verify-full/v2
```

Use the dashboard-provided Supavisor session-pooler host, port `5432`, database
`postgres`, and username `postgres.<project-ref>`. Direct `db.<ref>` access,
transaction-pooler port `6543`, and other hosts or users are rejected. The URL
file is passwordless and has one newline-terminated URL with this exact query
order and encoding:

```text
postgresql://postgres.<project-ref>@<dashboard-pooler-host>:5432/postgres?sslmode=verify-full&sslrootcert=<percent-encoded-absolute-pinned-CA-path>&options=-c%20jit%3Don
```

The pgpass file contains exactly one newline-terminated, non-wildcard row:

```text
<dashboard-pooler-host>:5432:postgres:postgres.<project-ref>:<password>
```

The reviewed Supabase project CA is a strict single PEM/X.509 certificate. Its
absolute path and SHA-256 are bound; ambient/system/custom CA fallback is
rejected. URL, pgpass, PAT, CA, and their approved digests must be private
regular single-link no-ACL files. The operator pins them with O_NOFOLLOW and
fstat-before/after checks into an owner-only runtime inside the encrypted
destination. Secrets never enter argv, environment, logs, or evidence.

JIT access must be granted immediately before the read/apply boundary, proved
with the session identity, TLS state, backend, DNS/A reachability, and a
with-JIT-success/without-JIT-failure control, then revoked and independently
verified. The grant/revoke helper is part of the separately reviewed operator
pack, not this repository guide.

## Docker boundary

Every Docker call uses the reviewed executable hash and an explicit local Unix
endpoint. The approved v2 object has exactly:

```text
{
  "endpoint": "unix:///absolute/path/to/docker.sock",
  "socketPath": "/absolute/path/to/docker.sock",
  "device": "<decimal>",
  "inode": "<decimal>",
  "ownerUid": <current-user-decimal-integer>,
  "ownerMode": 384
}
```

The live socket must be canonical, current-user-owned, mode 0600, and no-ACL.
No ambient Docker context/config is accepted. Each invocation uses a private
empty HOME/DOCKER_CONFIG and the exact endpoint. Containers have per-run random
ownership labels, durable pre-create recovery state, bounded inspection, and
ownership-checked force removal plus absence proof. Never remove an unowned
container.

Restore/rehearsal containers are network-none, read-only-root, capability-free,
`no-new-privileges`, user `100:101`, log-driver none, and use only exact tmpfs
writable paths. The reviewed offline pgsodium getkey helper creates a random
tmpfs-only key. This exception is valid only while the sealed v2
relation/sequence evidence proves `vaultSecretsCount: 0`; a nonzero or missing
Vault count fails closed.

## Approved tool manifest v2

The independently reviewed manifest contract is exactly
`dominion-production-backup-approved-tools/v2`. Its top-level keys are:

```text
artifactContract, captureTools, captureToolsetSha256, dockerContext,
dockerSharedHomeRoot, releaseCommit, restoreTools, restoreToolsetSha256,
schemaVersion
```

`captureTools` contains exactly:

```text
cleanEnvironmentLauncherSha256, credentialValidatorSha256, dockerBinSha256,
dumpScriptTransformerSha256, edgeFunctionsInventoryHookSha256,
encryptedVolumeCheckHookSha256, inputPinningHelperSha256,
macosTcbAttestationSha256, managedApplicationDdlHookSha256,
migrationHistoryHookSha256, nodeBinSha256,
operatorPackCleanEnvironmentLauncherSha256, relationCountsHookSha256,
sourceFingerprintHookSha256, sourceManifestHookSha256,
storageInventoryHookSha256, supabaseCliSha256
```

`restoreTools` contains exactly:

```text
cleanEnvironmentLauncherSha256, dockerBinSha256,
encryptedVolumeCheckHookSha256, inputPinningHelperSha256,
macosTcbAttestationSha256, nodeBinSha256,
offlinePgsodiumGetkeySha256, operatorPackCleanEnvironmentLauncherSha256,
restoreVerificationHookSha256
```

Toolset hashes are SHA-256 of canonical key-sorted compact JSON. The repository
launcher and pack launcher are distinct identities. A caller-provided hash is
not authority; all expected hashes come from this independently approved
manifest.

## Supported invocation shape

After the launcher/TCB freeze, the sole outer boundary will be the directly
executed approved pack launcher. Its fixed repository child invocation is:

```bash
<pack>/launch-reviewed-entrypoint.sh \
  --entrypoint repository-operator-clean \
  --entrypoint-file-sha256 <manifest-cleanEnvironmentLauncherSha256> \
  --clean-environment-launcher-sha256 <manifest-operatorPackCleanEnvironmentLauncherSha256> \
  --node-bin <canonical-node> \
  --node-bin-sha256 <manifest-nodeBinSha256> \
  --runtime-directory <private-runtime-inside-encrypted-destination> \
  --macos-tcb-attestation <private-tcb-json-inside-encrypted-destination> \
  --macos-tcb-attestation-sha256 <manifest-macosTcbAttestationSha256> \
  --release-repository <canonical-clean-main-worktree> \
  --release-commit <exact-release-commit> \
  -- \
  --operation <capture|restore|verify-evidence|preflight|reconcile> -- <operation-arguments>
```

Do not run this template until the pack mapping and TCB are frozen and approved.
The pack must re-prove canonical repository ownership/no-ACL, exact clean
`main` HEAD and origin, then hash the fixed repository child before executing
it in a clean environment.

The repository operation arguments are defined by the usage blocks in:

- `scripts/capture-production-backup.sh`
- `scripts/rehearse-production-backup-restore.sh`
- `scripts/verify-production-backup-evidence.sh`
- `scripts/verify-production-reconciliation-preflight.sh`
- `scripts/run-production-reconciliation-step.sh`

Use every required flag exactly once. Capture additionally requires exact
`CAPTURE <project-ref> <release-commit>` confirmation, the writer-quiesced UTC
second, all eight pack hook paths/hashes, the exact pinned image ID, database
host/credential/CA inputs, Docker socket identity/shared root, and the v2
volume/TCB/tool manifest. Restore requires exact
`RESTORE <capture-id> <restore-id>`, the capture/toolset identities, reviewed
offline getkey and restore hook, and the same volume/Docker/image boundary.
Evidence verification uses the same complete identities and makes no hosted
call.

## Capture and isolated restore invariants

Capture writes separate role, schema, data, history-schema, history-data, and
managed-application-DDL SQL plus exact Edge, Storage, source manifest,
fingerprint, relation/sequence, and migration-history inventories. Storage
objects and multipart uploads must be zero because logical backup does not
contain Storage blobs. All artifacts are sealed owner-private regular files;
the capture root and manifest are revalidated with handle-bound reads.

The relation/sequence artifact is v2 and contains exact relation counts,
sequence state, and `vaultSecretsCount: 0`. Restore uses only the verified
sealed capture copy, performs no network access, and must reproduce every
expected manifest/fingerprint/count/history invariant. It emits a sealed
restore manifest only after container absence and volume re-attestation.

On any uncertain teardown, preserve the exact private runtime, recovery JSON,
cidfile, ownership token, and every bind source. The recovery consumer is not
yet approved or checked in; stop for review. Do not improvise with Docker CLI.

## Reconciliation rehearsal and one-version plans

Production plans require
`dominion-production-reconciliation-rehearsal-evidence/v2` with exactly these
eight files:

```text
effect-verification.json
post-relation-sequence-counts.json
post-source-fingerprint.jsonl
post-source-manifest.jsonl
pre-relation-sequence-counts.json
pre-source-fingerprint.jsonl
pre-source-manifest.jsonl
rehearsal-evidence.json
```

The rehearsal is network-none against the exact isolated restored capture. Its
sealed manifest binds capture/restore/stage/release repository, included
versions, image, CLI, Docker context/shared root, backup evidence, TCB and tool
hashes, pre/post component hashes and canonical state hashes, and the exact
three ordered passing effect checks:

```text
application-data-state
application-schema-state
migration-prefix-state
```

Stage 1 pre-state must byte/hash-match the verified capture. For stage N+1,
pre-state must equal stage N post-state, and both the prior evidence-manifest
SHA and prior post-state SHA are cross-bound to the actual completed plan.
Every prior production completion must use `system-utc` and the exact same full
reconciliation toolset. It must also carry byte-equivalent full `backupEvidence`
and the identical `approvedBackupToolManifestSha256`; neither may change between
stages. Legacy/loose/test-only evidence cannot seed production.

The approval-gated rehearsal producer lives in the external operator pack. Its
fixed launcher mapping is `--entrypoint rehearsal`; that wrapper is
`rehearse-one-version-stage.sh`, which invokes the hash-bound
`lib/rehearsal-driver.mjs`. This producer is not authorized merely because its
files exist. Do not invoke it until the pack launcher, TCB, exact options, and
full pack inventory have been independently frozen and approved.

For every historical version 1 through 13, use this exact evidence flow:

1. `prepare-reconciliation-stage.mjs` materializes the cumulative immutable
   stage from release commit R and emits `reconciliation-stage.json`. The stage
   manifest SHA-256 is the rehearsal producer's stage identity.
2. The approved pack `rehearsal` mapping runs that one stage against the exact
   network-none isolated restored capture. It emits only the eight-file v2
   directory above. The SHA-256 of `rehearsal-evidence.json` is the sealed
   rehearsal identity.
3. `production-reconciliation-artifacts.mjs verify-rehearsal-evidence` receives
   that directory plus the independently recorded expected manifest SHA-256.
   Its `REHEARSAL_EVIDENCE_MANIFEST_SHA256`, release/version, capture/restore,
   pre-state, post-state, shared-root, TCB, and repository outputs must exactly
   match the reviewed producer record.
4. A private canonical
   `dominion-production-reconciliation-local-rehearsal/v2` contract supplies
   the same rehearsal directory, immutable stage, approved backup
   manifest/evidence, release/TLS/tool paths, and both chain inputs. For stage
   1, `previousRehearsalEvidenceDirectory` must be the literal string
   `genesis`, while the separate `previousCompletionSha256` must be the literal
   all-zero SHA-256
   `0000000000000000000000000000000000000000000000000000000000000000`.
   Later stages supply the exact prior sealed rehearsal directory and verified
   production completion SHA-256.
   `prepare-plan --rehearsal-contract ...` emits the candidate
   `dominion-production-reconciliation-plan/v2`,
   `REHEARSAL_CONTRACT_SHA256`, and
   `APPROVED_RECONCILIATION_PLAN_SHA256`.
5. Only the independently reviewed plan SHA-256 may enter the one-version
   runner confirmation. A production preflight must bind the same plan, stage,
   rehearsal manifest, pre-state, backup/restore evidence, and before-history
   identities before the runner can apply that single version.
6. The independently verified production
   `PRODUCTION_RECONCILIATION_COMPLETION_SHA256` becomes the next plan's exact
   `previousCompletionSha256`. The completed plan's rehearsal manifest SHA-256
   and post-state SHA-256 become stage N+1's
   `previousRehearsalEvidenceManifestSha256` and
   `previousPostStateSha256`; stage N+1 pre-state must equal that post-state.

Stop the chain immediately on a missing/extra/loose artifact; any hash,
metadata, release, stage, image, CLI, Docker, TCB, backup, or tool mismatch;
failed effect check; broken state continuity; non-system production clock;
test-only identity; stale capture; incomplete prior completion; unexpected
history; or uncertain container/volume teardown. Never regenerate, rewrap, or
skip an evidence stage to make a later plan pass.

The runner applies exactly one migration only after production-labeled
preflight succeeds and all bound evidence is revalidated. Test-only preflight
and completion use the distinct keys
`TEST_ONLY_RECONCILIATION_PREFLIGHT_SHA256` and
`TEST_ONLY_RECONCILIATION_COMPLETION_SHA256`; production consumers reject
them. Production completion uses only `system-utc` and
`PRODUCTION_RECONCILIATION_COMPLETION_SHA256`.

## Teardown

Keep the encrypted mount attached through all Docker work. Verify every owned
container is absent, preserve unresolved recovery state, then gracefully stop
Colima. Only after the VM has stopped may the operator perform a normal
`hdiutil detach` and prove the mount is absent. Never force-detach production.
Stopping Colima invalidates the bound socket inode, so no later Docker evidence
step may run in that session.

## Offline verification

These suites use no hosted credentials and must pass on the exact release:

```bash
pnpm run test:database-manifest
pnpm run test:reconciliation-stage
pnpm run test:production-backup-restore
pnpm run test:production-reconciliation
git diff --check
```

Do not interpret a green offline suite as authority to cross an approval-gated
launcher, AES, TCB, external rehearsal-producer, JIT, recovery, or hosted
mutation boundary.
