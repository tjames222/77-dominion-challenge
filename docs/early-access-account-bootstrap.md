# Proven new-account setup authority

`20260927233055_early_access_account_bootstrap.sql` extends the reviewed
application-invitation authority. The migration creates no Auth account, sends no
email, grants no access and does not enable signup or billing. It adds no Auth
trigger or Auth-table privilege. Only new private-table triggers participate in
the existing invitation transaction.

## Identity and uncertainty boundary

Successful approval with no matching canonical Auth account atomically reserves
a random UUID and a separate setup-delivery UUID in a private provenance row.
Neither UUID has an Auth foreign key. Existing healthy confirmed accounts skip
bootstrap; any foreign/preexisting unconfirmed account remains
`account_recovery_required`. A later email match alone never establishes
ownership of the reserved UUID.

The service worker must authenticate its dedicated worker secret, enable native
bootstrap explicitly, verify the current production Auth policy and use the
create-only `early_access_auth_bootstrap.ts` helper. Only the privately reserved
UUID may reconcile an uncertain creation. No email lookup adoption, caller-chosen
password, account confirmation or application grant is permitted. Native link
generation happens outside every database transaction.

The native-start fence is one-way. A repeated start returns false, even for the
same worker. After native start, a crashed/expired lease or uncertain native
result becomes `needs_review`; it is never automatically reclaimed to regenerate
a link. This prevents a stale worker from invalidating a frozen link that another
attempt may already have mailed. A failure before native start can reclaim the
same reserved UUID after lease expiry, with a maximum of six claims.

Persistence checks exact reserved UUID, canonical mailbox, healthy unconfirmed
account, current generation, program and lease. It inserts encrypted setup mail
and pins `invitation.account_id` atomically. The same checks are repeated after
outbox insertion waits; failure rolls the entire insertion/pin back. Exact
persist retries return the existing receipt and never overwrite the envelope.

## Worker contracts

All seven public RPCs are service-only and reject a mixed service/member JWT.
The `target_worker_token` is a fresh UUID per worker invocation. Claim sizes are
exactly one, and leases last two minutes.

| RPC | Arguments after `target_` prefix | Result |
| --- | --- | --- |
| `claim_early_access_account_bootstraps` | `worker_token uuid, batch_size integer=1` | At most one `{requestId,generationId,reservedUserId,deliveryId,recipient,invitationExpiresAt}` |
| `start_early_access_account_bootstrap` | `generation_id uuid, worker_token uuid` | Boolean; true authorizes exactly one native helper invocation |
| `persist_early_access_account_setup` | `generation_id uuid, worker_token uuid, binding jsonb, envelope jsonb, content_fingerprint text, idempotency_key text` | Boolean; immutable durable mail and reserved-UUID pin |
| `settle_early_access_account_bootstrap` | `generation_id uuid, worker_token uuid, code text` | Boolean; terminal review, never a native retry |
| `claim_early_access_account_setup_deliveries` | `worker_token uuid, batch_size integer=1` | At most one `{deliveryId,binding,envelope,contentFingerprint,idempotencyKey,firstDispatchedAt}` |
| `mark_early_access_account_setup_dispatched` | `delivery_id uuid, worker_token uuid, content_fingerprint text` | Null or `{deliveryId,idempotencyKey,bindingFingerprint,firstDispatchedAt}` |
| `settle_early_access_account_setup_delivery` | `delivery_id uuid, worker_token uuid, outcome text, code text=null, receipt_id uuid=null` | Boolean |

Setup-mail settlement outcomes are `accepted`, `retryable`, `uncertain`, and
`needs_review`. Accepted requires a provider UUID and null code; other outcomes
must have no provider UUID. Codes contain only 1–80 lowercase letters, digits or
underscores. Root worker uses only fixed classifications, never provider prose.
No browser can invoke these RPCs or read the private rows.

## Separate native recovery message

Binding is exactly `{requestId,generationId,deliveryId,reservedUserId,recipient,
issuedAt,expiresAt,from}`. Every member is a string; timestamps are UTC ISO with
milliseconds. Sender is constrained to `mail.77dominion.com`. Idempotency key is
`dominion-early-access-setup/<delivery UUID>`. The token/action URL appears only
inside the encrypted `native_recovery` message, never binding, SQL arguments
outside ciphertext, metadata, logs, admin history or member responses. It is not
an application invitation or a seven-day native credential.

The dedicated invitation AES key/version may be reused only with the explicitly
different `native_recovery` purpose/AAD namespace. The helper authenticates the
full binding and frozen content fingerprint, checks the native action-link
origin/path/redirect and then returns the exact persisted content. SQL permits
at most 16,400 encrypted bytes (21,867 canonical unpadded base64url characters),
representing 16 KiB plaintext plus the GCM tag. It does not pretend ciphertext
shape proves decryption or native link validity: the trusted worker must open and
validate the envelope before the dispatch fence.

TTL is a verified runtime Auth setting, not inferred from local configuration.
Current release guard requires a 3,600-second native recovery TTL, confirmation
enabled and unverified sign-in disabled. Worker expiry is the smaller of the
application expiry and its pre-Auth-call start time plus TTL minus 30 seconds.
SQL independently caps expiry at database `native_started_at + 3,570 seconds`,
`issuedAt + 3,600 seconds`, and application expiry. Issuance must be within 30
seconds of database time; malformed/skewed/expired material fails closed.

The dispatch fence rechecks current program/generation, exact healthy
unconfirmed account, lease and native expiry after any shared free-email quota
wait. A new quota reservation rolls back if those checks fail. Unknown mail
keeps the same frozen envelope, key and first-dispatch time, with at most twelve
claims; retries stop at native expiry or the existing 23-hour provider window,
whichever comes first. Provider acceptance after expiry is recorded truthfully
but never confirms Auth or grants application access.

## Normal continuation and retirement

Unbound invitations never release application mail. After setup is durably
persisted, the pinned account must actually confirm before the original frozen
application invitation becomes claimable. The user receives native setup first,
then the seven-day application invitation on a later worker pass. Setup mail or
Auth confirmation alone grants no EA membership. Acceptance still requires the
app token, exact authenticated UUID, current session/MFA and all existing grant
checks.

Revocation, supersession, expiry and acceptance retire bootstrap work and purge
unsent encrypted setup mail. An already-created Auth account is not deleted, and
an in-flight native email may still arrive; the retired app generation cannot
grant access. Such provider effects are not represented as successful access or
silently undone with destructive Auth operations.

## Explicit recovery limitation

A normal missed one-hour setup email with a durable pinned UUID differs from an
unknown native call without durable mail. The existing forgot-password page uses
native `resetPasswordForEmail`; it can be a valid mailbox-owner recovery path
once native SMTP delivery and reset-page continuation are verified in production.
That is not the same transport or quota ledger as this durable Resend outbox and
has not been certified solely by these SQL tests.

An explicit administrative setup-reissue operation is not implemented here.
Its minimum safe authority would require the original admin bearer/MFA,
revision/idempotency, current pre-beta generation, exact private reserved UUID
pin, unchanged canonical healthy-unconfirmed account, expired prior credential
under verified native TTL, and no active native/mail lease. It must append a new
setup attempt/delivery and typed audit event; it must never overwrite the prior
native-start fence or provider idempotency key. Unknown native starts additionally
require by-reserved-UUID reconciliation and evidence that the old native token
can no longer be used. Generic resend currently fails recovery-required instead
of silently implementing that broader authority.

## Verification boundary

The isolated invitation SQL runner loads both new migrations. It tests native
constraints, original intake/Auth/admin lock races, start-once claims, unknown
native outcomes, foreign-account rejection, immutable payload retries,
post-outbox account changes, quota/TTL boundaries, generation retirement and
confirmation-gated app acceptance. `310_early_access_account_bootstrap.sql`
adds 47 exact RLS/ACL/worker/trigger inventory assertions; no real account or
hosted database is used. Full native Supabase replay, advisors, schema drift,
runtime policy/secrets/SMTP verification and an authorized canary remain release
gates. These files alone do not claim deployment or ticket completion.
