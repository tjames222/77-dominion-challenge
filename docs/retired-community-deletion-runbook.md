# Retired Community deletion controls

FOU-564 captures the retired Community data at T0, gives each authenticated member 30 days to export only content they authored, and defines sealed deletion batches. Deploying the schema does not authorize a production deletion. Do not create a non-dry-run batch until the Storage/provider worker, monitoring, backup destination, and named operators are approved for production.

## Member export

`export_own_retired_community_content()` accepts no arguments and derives `auth.uid()`. It returns the caller's own post and comment bodies, own reactions, and minimal identifiers/timestamps. It never returns another member's body, display name, avatar, email, or user ID.

An authored post may include its `attachmentPath`. The path is usable by an approved export process and contains only opaque group/account identifiers plus the caller's own object name; it contains no other member content. All member Storage policies remain revoked, so the path is not an access grant. `imageReferenceId` is the SHA-256 inventory handle used for reconciliation.

## Batch invariants

- Aged retention cannot create or execute a batch before T0 + 91 days.
- Account erasure derives the authenticated subject and records a deadline exactly 24 hours after the request. It inventories the subject's retired posts, authored engagement, unavoidable cascades on subject posts, and exact unshared image objects.
- Account deletion sets `crews.created_by` and `integration_destinations.installed_by` to null. It does not delete groups or provider destinations merely because the subject created or installed them.
- Group deletion records `execute_after` exactly 30 days after request. Owners/admins can cancel before that instant. Storage or credential work cannot be claimed during the cancellation window.
- Group credential digests bind the provider identity and encrypted revocation material. Routine delivery/test timestamps may continue during the cancellation window, but credential rotation or destination changes invalidate the claim.
- Every persisted batch is sealed with exact item counts and a source digest. Its scope cannot be edited or deleted.
- A named/versioned backup proof records the source digest, bundle digest, bytes, verifier, and verification time. A different named approver must bind approval to the same digests and all five counts.
- Public planning, confirmation, and execution responses expose only `batchId`, `status`, and aggregate `counts`.
- The append-only ledger stores operational metadata only. It never stores bodies, Storage paths, ciphertext, nonces, or exported bundles.

## Worker boundary

Only the service-role worker claim RPCs expose exact work:

- `claim_retired_community_storage_work(uuid, uuid, integer)` returns at most 100 exact object paths and expected metadata hashes.
- `confirm_retired_community_storage_work(uuid, uuid, uuid, text)` succeeds only after the real `storage.objects` record is absent.
- `claim_retired_community_credential_work(uuid, uuid, integer)` returns at most 20 encrypted provider credentials for a day-30 group batch.
- `confirm_retired_community_credential_work(uuid, uuid, uuid, text, text)` records the provider revocation reference and clears local credential material.

SQL never deletes `storage.objects`. The worker must back up and verify the named bundle, remove each exact object through the Supabase Storage API, and then confirm it. For group deletion, the worker must revoke provider access before confirming credential work. A relational batch cannot execute while either queue has unconfirmed work.

Claims are idempotent for the same worker token. A different worker may reclaim a claim after 15 minutes, so workers must treat an already-absent object or already-revoked provider credential as a successful retry before confirming it.

## Operator sequence

1. Run the appropriate request/plan RPC with its default dry-run behavior and review aggregate counts.
2. Explicitly create the batch and export the exact sealed scope to the named, versioned backup.
3. Verify the bundle and record its proof with `record_retired_community_backup_proof`.
4. Have an independent operator call `approve_retired_community_deletion_batch` with the same digests and exact counts.
5. After the hard execution window opens, run the worker until Storage and credential queues are confirmed.
6. Call `execute_retired_community_deletion_batch` with the exact phrase `EXECUTE SEALED RETIRED COMMUNITY DELETION`.
7. Reconcile the opaque result counts and immutable ledger against the approved change record.

Provider disaster-recovery reapplication, repeated orphan-bucket reconciliation, and long-term redacted manifest expiration remain separate follow-on controls; this core does not claim to implement them.
