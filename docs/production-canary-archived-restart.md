# One approved archived production-canary restart

This is one explicit exception to the ordinary
[canary operator runbook](production-canary-operator-runbook.md), not a renewal
mechanism or a public-launch approval. It applies only to the revoked canary
bound to prior release
`0507c5e3b63d03f5e8ce7781aad463134d992871`.

This exact replacement was separately approved after the previous compatibility
attempt stopped on an incorrect billing gateway smoke expectation. The earlier
8779421-bound exception was used and is no longer accepted. Its encrypted audit
archive remains retained. This new exception requires another fresh backup of
the currently revoked 0507c5e row and authorizes only one replacement; it does
not turn either exception into a reusable renewal mechanism.

The old grant must already be revoked and inactive. A fresh encrypted backup
must preserve its complete original row, and the operator must prove local key
recovery before the dedicated workflow can replace that exact row once. The
replacement receives a new internally generated grant identifier, the new
reviewed release SHA, and a fresh two-hour expiry. It is not an extension of the
old window. After replacement, the fixed old-SHA/revoked-row predicate is false;
repeating the workflow cannot produce another grant.

No database reset, row deletion, migration-history repair, migration replay,
new Supabase project, Stripe setup, signup enablement, or second entitled account
is authorized by this procedure. Do not change a guard to make a failed attempt
pass. The normal compatibility-then-full sequence remains mandatory.

## Prerequisites and durable recovery evidence

1. Merge the reviewed fixes and require the protected checks to pass. Record and
   freeze the new exact `main` SHA; it must differ from the fixed prior release.
   Use a clean local checkout of that same reviewed commit. Do not advance
   `main` during restart, compatibility, full, owner testing, or revocation.
2. Confirm the old grant was revoked through its reviewed workflow. The hosted
   restart checks require exactly one non-anonymous profiled Auth user, exactly
   one entitlement row containing that revoked old-SHA canary, no billing rows,
   no legacy purchases table, and exact migration history 1–13. Migrations
   14–53 remain pending. Preserve closed Auth, disabled billing, and the existing
   production/preview wiring policy.
3. Run **Free production backup** from the new frozen `main` SHA and approve its
   protected production job. It must complete source capture and the isolated
   restore comparison successfully. Use the exact successful run, attempt, and
   encrypted artifact; do not substitute the earlier release's backup.
4. Retain the encrypted backup and its RSA-4096 recovery private key on the
   operator machine beyond GitHub's seven-day artifact lifetime. Both are
   required to recover the original audit row. Keep the private key as an
   ordinary owner-only `0600` file; keep recovery directories owner-only `0700`.
   The [free backup runbook](free-production-backup.md) remains authoritative
   for recovery scope, including the zero-Storage-object requirement.
5. Create a **separate Ed25519 signing key pair** locally for this recovery
   receipt. Keep its private key in another owner-only `0600` local file. Do not
   reuse the RSA recovery key or put either private key in GitHub, workflow
   inputs, logs, artifacts, tickets, or repository files.

Only these public values belong in GitHub's protected `production` environment
variables:

| Variable | Value |
| --- | --- |
| `PRODUCTION_BACKUP_PUBLIC_KEY` | Existing RSA-4096 recovery public key, unchanged |
| `PRODUCTION_CANARY_RESTART_PUBLIC_KEY` | Separate Ed25519 public key |
| `PRODUCTION_CANARY_RESTART_RECOVERY_PROOF` | Exact public JSON receipt produced below |

The separate Ed25519 public key must be configured **before** preparing the
receipt. Never populate a public-key variable with private-key PEM text.

## Prepare the local signed receipt

From the clean new release checkout, use explicit absolute paths. The download
parent and output parent must already be ordinary owner-only `0700` directories;
the output file must not exist. Place them outside the repository checkout.
Use the reviewed clean operator environment without Node preload/debugger or
heap-snapshot settings, and disable core dumps (`ulimit -c 0`) before starting
the local helper. Child GitHub/git commands use a reconstructed environment;
that does not undo instrumentation loaded before Node itself starts.

```sh
node scripts/prepare-production-canary-restart-proof.mjs \
  --release-sha <new-reviewed-40-character-main-sha> \
  --backup-run-id <successful-new-release-backup-run-id> \
  --artifact-id <exact-encrypted-backup-artifact-id> \
  --rsa-private-key /absolute/private/recovery-rsa.pem \
  --signing-private-key /absolute/private/restart-ed25519.pem \
  --download-parent /absolute/private/retained-backups \
  --output /absolute/private/restart-receipt.json
```

The local helper only makes fixed read-only GitHub requests/downloads. It
requires the current checkout and remote `main` to equal the new release,
verifies the successful protected-main backup workflow/run/attempt/artifact
bindings, and freshly downloads the selected artifact into a new `0700`
directory. It does not accept a supplied predownloaded provenance claim. The
encrypted download remains retained even if later receipt verification fails.

Both supplied private keys must match their configured public keys. The helper
checks the encrypted manifest and bytes, unwraps the AES key with RSA-OAEP-SHA256,
and authenticates AES-256-GCM entirely in memory. Only after authentication does
it inspect the exact three regular tar entries, header checksums, dump magic,
and parsed inventory. The inventory must prove the exact 13-migration checkpoint
and exactly one `public.entitlements` table record containing one row. No SQL is
executed, no hosted database is contacted, and no plaintext backup is written.

The Ed25519 signature covers a domain-separated canonical payload containing
the public release/run/artifact/ciphertext/RSA-key bindings **and** the private
whole-entitlements-table fingerprint. That fingerprint and the old row are not
included in the public receipt or console output. Mutable decrypted buffers and
key buffers are wiped after use; all plaintext processing remains in memory.

The receipt is written exclusively as a new `0600` JSON file only after all
verification succeeds. Its timestamp is the backup manifest's creation time,
not a refreshed signing time; the backup/proof validity window is 24 hours.
Set `PRODUCTION_CANARY_RESTART_RECOVERY_PROOF` to that exact public JSON. Retain
the encrypted artifact, both local private keys, and receipt in the private
release record. A receipt does not itself mutate or authorize a different row.

## Run the bounded approved sequence once

The dedicated **Restart one archived production canary** workflow requires
`backup_run_id` and `confirm_archived_restart=true`, runs only from protected
`main`, and shares the existing `production-release` concurrency group. It
rechecks the archive/run/manifest, public receipt signature, current `main`,
closed Auth, and exact old-row invariants. A private read-only fingerprint must
match the recovered backup. The single fixed transaction locks the relevant
tables and repeats those checks before replacing the row; concurrent drift or
any mismatch stops it. The final aggregate-only read must verify the new grant.

Use the reviewed local controller to dispatch this workflow and then the
compatibility/full releases with their corrected billing gateway smoke matrix.
The flag below explicitly authorizes
the controller to approve only the bound runs' protected production gates.
It requires the approved operator's existing GitHub login and a clean exact
release checkout. The journal parent must be a canonical absolute owner-only
`0700` directory; the journal file must be new.

```sh
node scripts/run-approved-production-restart.mjs \
  --release-sha <same-new-reviewed-main-sha> \
  --backup-run-id <same-successful-backup-run-id> \
  --state-file /absolute/private/restart-controller.jsonl \
  --approve-protected-production
```

The controller runs, in order:

1. The one archived restart and its protected verification.
2. `release_scope=compatibility-cutover`, with the same backup run and SHA.
3. Public login/invite/reset-page HTTP checks after compatibility.
4. `release_scope=full`, using the exact same grant and frozen SHA.
5. The same public HTTP checks after full.

All existing workflow checks remain in place: release validation, closed Auth,
backup evidence, raw/CLI migration-history agreement, zero-billing invariants,
disabled billing Function guards, keyed compatibility attestation, forward
migrations, zero-pending verification, and Cloudflare deployment policy. Public
HTTP checks reject off-origin redirects, fallback pages, or a missing final
invite `no-referrer` policy. They do not replace real-session canary acceptance.

The controller has a **105-minute total budget from its own start**, checked
against both wall-clock and monotonic elapsed time; whichever elapsed value is
larger controls the stop. A backward clock also stops it. This is shorter than
the grant's two-hour lifetime and cannot renew or extend that lifetime. Each
phase is dispatched at most once, and GitHub run identities, attempts, jobs,
pending environment gates, and frozen `main` are revalidated before further
mutation. No workflow check is bypassed by automated environment approval.

## Stops, uncertainty, and final acceptance

The controller creates a new owner-only `0600`, append-only, fsynced journal.
Dispatch/approval intentions are recorded **before** the requests, and returned
run/deployment identifiers are recorded afterward. Keep this journal with the
private release record; it is not a resume token.

If a request times out, returns no exact run URL, gives an ambiguous approval
response, or the process is interrupted, the mutation may already have happened.
Stop and inspect the exact journal/run/grant. **Do not rerun the controller,
create a fresh journal to start again, redispatch a phase, renew access, or
replace another grant.** An empty successful `gh workflow run` response can
still represent a created dispatch. Deadline exhaustion and unexpected state
also require inspection, not an automatic retry.

Only after the restart was verified successful and a later workflow reports an
authoritative terminal failure may the controller attempt the existing
same-SHA revoke workflow, subject to the remaining deadline and frozen-branch
checks. It does not revoke across an uncertain or still-running migration. A
failed or uncertain revoke is recorded for inspection, never presumed complete.

A successful controller leaves owner testing and revocation outstanding. Keep
the same new grant and frozen SHA while completing the real owner-session
checks, all disabled billing endpoints' authenticated fail-closed checks, the
invited non-entitled second-account denial checks, and operational/log review
from the ordinary runbook. Then revoke through the existing workflow, retain
the new revoked audit row, sign out, and verify access denial. Do not treat
automated HTTP success as completion of those acceptance gates. Stripe, SMTP,
customer-policy, and public-launch readiness remain separately gated.
