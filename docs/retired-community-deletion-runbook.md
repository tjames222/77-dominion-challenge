# Retired Community deletion controls

FOU-564 captures retired Community data at T0, gives each member 30 days to
export only content they authored, and places every deletion behind a sealed
manifest, verified backup, three distinct operators, and worker confirmation.
Deploying this code does **not** authorize a production purge. Keep every plan in
dry-run mode until the production change record names the requester, backup
verifier, approver, execution operator, backup destination, and rollback owner.

## Runtime boundary

Deploy `retired-community-export` with JWT verification. It accepts an empty
`POST`, derives the user from the bearer token, and calls the zero-argument
`export_own_retired_community_content()` RPC. The Edge function signs for five
minutes only those `community-post-images` paths returned for that same caller.
It rejects request-supplied paths and user IDs. The JSON export remains unchanged
and signed attachment downloads are returned separately.

Deploy `process-retired-community-deletions` without platform JWT verification;
it authenticates a private `x-dominion-worker-key` header using
`RETIRED_COMMUNITY_WORKER_SECRET`. Configure that secret together with
`RETIRED_COMMUNITY_DR_HMAC_SECRET` and `INTEGRATION_CREDENTIAL_KEYS`. All three
must be server-only, at least 32 random characters where applicable, and distinct
from public keys and other worker secrets.

The worker supports these private modes:

- `health`: aggregate queue, scan, manifest, backup, and DR signals.
- `scan`: a recursive, paginated, complete inventory of
  `community-post-images`; the database rejects partial or inexact inventories.
- `process`: claims one approved batch, rechecks exact Storage metadata, removes
  only the claimed path through the Storage API, confirms absence, and revokes
  provider credentials before clearing local encrypted material. Account erasure
  work spans the active `community-post-images` and `profile-photos` buckets.
  `journal-progress` remains in the worker allowlist and historical work
  constraint solely so a restored pre-FOU-753 snapshot can finish a previously
  sealed claim; the active product no longer provisions that bucket. Each claim
  carries its bucket and path explicitly.
- `verify-backup`: records the independent purge-plus-30-day backup check.
- `maintenance`: after exact 180-day retention, removes the redacted manifest,
  linked verification, exact relational items, Storage path work, credential
  work, and eligible old orphan-scan items in one transaction. Evidence that a
  pending DR reapplication still needs is retained until that reapplication
  executes. When the global aged-retention manifest expires and no deletion is
  active, the same governed transaction also removes direct IDs, crew IDs,
  object paths, and referenced-row keys from the T0 inventories; only aggregate
  counts and digests remain. For every expired batch it also removes backup/
  approval identities, replaces requester/subject/crew and ledger actors with
  fixed non-identifying sentinels, and writes a count/digest-only redaction proof.
  A cancelled sealed batch follows the same exact-evidence and identity cleanup
  at cancellation + 180 days even though it has no execution manifest.
- `dr-export`: returns an HMAC-signed, count/digest-only ledger for off-platform
  custody.
- `dr-apply`: verifies that HMAC and reapplies each locally matching sealed purge
  after a restore.

Responses and structured logs contain batch/work IDs, provider names, and
aggregate counts only. They must never include object paths, content, ciphertext,
nonces, tokens, provider response bodies, or signing secrets.

## Sealed-batch invariants

- Aged retention cannot begin or execute before T0 + 91 days and remains bound
  to the exact T0 inventory.
- Account erasure derives the authenticated subject, has an exact 24-hour
  deadline, includes authored engagement, unavoidable post cascades, active
  profile objects, any journal objects present only in a restored historical
  snapshot, and subject-owned unreferenced Community uploads, and does not
  erase groups merely because the member created them. Every exact Storage item
  must be confirmed absent before `auth.users` is deleted.
- Group deletion has an exact 30-day cancellation window and cannot claim either
  Storage or provider work early. Credential-covered destination fields are
  frozen after sealing; health/display metadata may still change. A destination
  that is already credentialless is sealed as safely confirmed and normalized to
  `revoked` without a provider call.
- Sealing an account erasure cancels queued, processing, and retrying outbound
  deliveries for that subject. New active deliveries and new or changed personal
  Storage objects are rejected until the batch is cancelled or executed.
- Account and group batches fail closed if a T0 row is missing without a prior
  executed deletion, if a row hash drifted, if a new cascade row is unmanifested,
  or if object/provider work is incomplete or belongs to another scope.
- Requester, backup verifier, and approver are three distinct normalized
  identities. Case and surrounding whitespace cannot bypass independence.
  Cancellation and execution are terminal; terminal batches cannot receive new
  proof or approval.
- The append-only operational ledger never stores member content, object paths,
  exported bundles, or credential material.

The four stable worker interfaces remain:

- `claim_retired_community_storage_work(uuid, uuid, integer)`
- `confirm_retired_community_storage_work(uuid, uuid, uuid, text)`
- `claim_retired_community_credential_work(uuid, uuid, integer)`
- `confirm_retired_community_credential_work(uuid, uuid, uuid, text, text)`

The worker-only `verify_retired_community_storage_work(uuid, uuid, uuid)` check is
called immediately before the Storage API delete. SQL must never delete from
`storage.objects`. An already-absent object and an already-revoked Slack/Discord
credential are safe retries, but both still require database confirmation. A
failed external call is attempted three times per worker invocation; exhaustion
is durably recorded and releases the claim for an operator-approved retry.

## Two-scan orphan protocol

1. Invoke `scan` and retain its scan ID and aggregate count in the change record.
2. Wait at least seven full days. Do not backdate either scan in production.
3. Invoke `scan` again. The newest scan must be no more than 24 hours old when the
   orphan plan is created.
4. Dry-run `plan_orphan_retired_community_deletion`. A candidate must have the
   same object ID, bucket, path, and metadata hash in both scans, zero references
   in both scans, and zero current post references.
5. Investigate count changes before creating the batch. Reusing a scan ID replaces
   it atomically and leaves an audit event only while it is unbound. A batch-bound
   scan can never be replaced.

Any incomplete recursive scan, duplicate object identity, unexpected bucket, or
concurrent bucket change fails closed. Run the two scans again after resolving it.
The P4 migration terminally cancels any active legacy orphan batch that lacks this
two-scan proof; never revive it. Create a new batch from two current scans.

## Approved execution sequence

1. Run the appropriate plan/request RPC in its default dry-run mode and record the
   opaque counts.
2. Explicitly create the batch. Export its exact sealed scope to the named,
   versioned backup destination.
3. Have the independent backup operator validate bundle bytes and both digests,
   then call `record_retired_community_backup_proof`.
4. Have a third operator bind approval to the source digest, bundle digest, and
   all five counts with `approve_retired_community_deletion_batch`.
5. After the hard time window opens, invoke worker `process` repeatedly until
   Storage and credential pending counts are zero. Each item retries three times
   with bounded backoff; another worker may reclaim a claim after 15 minutes.
6. Reconcile the approved counts, then call
   `execute_retired_community_deletion_batch` with the exact phrase
   `EXECUTE SEALED RETIRED COMMUNITY DELETION`.
7. Confirm a redacted manifest exists, its digest matches the exported DR ledger,
   and its expiry is execution + 180 days. Preserve the signed DR envelope outside
   the database and separately from its HMAC key. Keep envelopes append-only;
   never overwrite the last known-good export during key rotation.
8. At execution + 30 days, restore/read the named bundle in the approved isolated
   verification environment and call worker `verify-backup` with its bundle digest
   and a digest of the verification record. Never submit a ticket URL, operator
   name, or other readable identifier as that reference.

## Scheduling, metrics, and alerts

Use a Vault-backed scheduler and the private worker header. Suggested cadence:

- `health`: every five minutes.
- `process`: every five minutes only while an approved batch is active; supply an
  explicit batch ID from the approved change record.
- `scan`: once for each approved scan ID; never schedule automatic deletion.
- `maintenance`: daily.
- `dr-export`: after every execution and daily while manifests exist.

Alert when any condition lasts for two worker intervals, or immediately when an
approved execution window is close to expiry:

- `storagePending` or `credentialPending` is not decreasing;
- `staleClaims`, `workFailures`, or `repeatedFailures` is nonzero;
- `accountErasuresDueSoon` is nonzero or `accountErasuresOverdue` is nonzero;
- `backupReverificationDue` is nonzero;
- `manifestsExpiringSoon` is nonzero without a recent off-platform signed export;
- `expiredManifests` is nonzero, especially when an active batch is holding the
  global T0 identity-purge boundary open;
- `cancelledEvidenceDue` is nonzero;
- `t0IdentityRowsRetained` remains nonzero after `t0SnapshotPurged` becomes `1`;
- `drReapplicationsPending` is nonzero;
- `legacyOrphanBatches` is nonzero;
- `orphanScan.pairReady` unexpectedly becomes false before batch creation;
- a worker request returns non-200, a provider revocation exhausts three retries,
  or a Storage object remains after deletion.

On failure, stop execution and preserve the sealed batch. Do not edit private
tables, scan times, hashes, queue status, or manifest evidence. Fix the external
cause and retry with the same approved batch. Rotate a worker/HMAC/encryption key
immediately if it may have entered a log or ticket.

## Disaster recovery

Never expose a restored database to application traffic before reapplying the
signed purge ledger:

1. Restore into an isolated project with public ingress and schedulers disabled.
2. Deploy the exact schema/function version that created the ledger and load the
   server secrets from the disaster-recovery vault.
3. Invoke `dr-apply` with the latest untampered signed envelope. The database
   requires each redacted manifest to match its local sealed batch exactly.
4. Run `process` for every returned reapplication batch and execute each ready
   batch. Restored group data is quarantined from crews, memberships, and invites;
   restored account subjects are banned from new authentication while their exact
   three-bucket Storage work finishes, then erased by batch execution. Their
   active outbound deliveries are cancelled and retained delivery history is
   stripped of subject identity. Retired
   post/comment/like tables and their image bucket remain unavailable to members
   throughout.
5. Require `drReapplicationsPending = 0`, no quarantined group visible under an
   authenticated acceptance test, and a fresh signed ledger export before
   re-enabling application traffic or outbound integrations.

If a manifest does not match, keep the restore isolated and escalate to the
security and backup owners. Do not weaken a digest, fabricate a scan, remove a
quarantine row, or discard the ledger to make the restore pass.

The signed redacted manifest proves aggregate history but cannot reconstruct
exact rows, object paths, or credential work once their retention phase closes.
Before the global aged-retention phase closes, the immutable T0 inventories are
still direct evidence and must receive the same restricted treatment as deletion
work. A restore that predates a purge therefore also needs a database backup (or
separately approved encrypted recovery bundle) containing the matching sealed
batch and its unexpired exact evidence. If that evidence is absent, never open
public ingress: keep the restore isolated and escalate. Importing a manifest just
before expiry pins its source evidence until the reapplication executes.

Redacted purge manifests are immutable and retained for exactly 180 days. After
expiry, daily maintenance deletes the manifest, linked post-purge verification,
exact deletion items, Storage work paths, credential work, and eligible old scan
items in the same transaction, except while a DR reapplication still depends on
the source. The global aged-retention manifest is also held while any deletion
batch is active; when it becomes eligible, direct T0 inventory identities and
paths are deleted and an immutable count/digest-only T0 purge record is created.
Expired batch requester, subject, crew, proof/approval, and ledger actor identities
are redacted at the same boundary, leaving only fixed sentinels plus aggregate
counts, digests, times, reasons, and opaque batch IDs. The aggregate T0 census,
redacted batch/ledger, and purge/redaction records remain; the off-platform signed
ledger and backup follow the separately approved legal/backup retention policy.
