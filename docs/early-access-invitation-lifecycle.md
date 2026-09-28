# Early-access invitation authority — release candidate

`20260927225600_early_access_invitation_lifecycle.sql` supplies the SQL lifecycle
for FOU-1742. It creates no Auth account, real invitation, email, grant, testing
entitlement, or subscription. The original denial RPC is unchanged. Public signup,
billing, Stripe and beta remain closed. These application invitations are not
native Supabase login credentials.

## Original-actor administrative writer

`site_admin_write_early_access_invitation` takes these exact arguments:

```text
target_expected_actor_id uuid
target_action text                    approve | resend | revoke
target_request_id uuid
target_expected_revision bigint
target_operation_id uuid
target_correlation_id uuid
target_binding jsonb                  default null
target_token_digest text               default null
target_content_fingerprint text        default null
target_idempotency_key text            default null
target_envelope jsonb                  default null
```

Only `authenticated` can execute it. The Edge issuer must use the original,
verified administrator bearer and allowed browser Origin for both the existing
`site_admin_get_early_access_request` read and this write. A service credential
plus a supplied actor ID is not a substitute. SQL independently requires current
`operations.manage`, native live session/account, AAL2 and recent same-session
TOTP. It additionally checks live authority and fresh wall-clock MFA bounds after
blocking waits, because the older foundation helper uses statement time.

The mail helper generates 32 random bytes and the frozen authenticated-encrypted
email server-side. Binding fields are exactly `requestId`, `generationId`,
`deliveryId`, `recipient`, `issuedAt`, `expiresAt`, `from`. SQL verifies the request's
canonical email and account rather than trusting an arbitrary mailbox argument.
UTC ISO timestamps use millisecond precision, expire exactly seven days after
issuance, and issuance must be within 30 seconds of the fresh database clock.
The envelope contract is documented in `early-access-invitation-envelope.md`.

Approval accepts only pending requests; resend accepts approved, invited or
expired requests. Each commits request revision, generation/hash, encrypted
delivery job, immutable audit and operation receipt atomically. Resend supersedes
the old generation and removes unsent old ciphertext. Revoke accepts only an
unaccepted approved/invited request with a current generation and requires all
material arguments to be null. It cancels unsent work but never deletes an Auth
account, revokes unrelated membership, or removes an earned price qualification.

A currently healthy confirmed account is pinned by immutable UUID. Ambiguous,
deleted, anonymous or suspended accounts fail closed; an existing unconfirmed
account returns `account_recovery_required`. No-account issuance is allowed but
does not imply that signup/bootstrap exists or that membership is granted.

Successful writer receipt is exactly
`{ok:true,requestId,status:'approved'|'revoked',revision:string}`. Safe failures are
`invalid_input`, `revision_conflict`, `target_unavailable`, `invalid_state`,
`rate_limited`, `account_unavailable`, `account_recovery_required`, and
`program_unavailable`. Shared admin limits remain 20/minute and 100/hour.

The idempotency digest includes action, request, reviewed revision and correlation
UUID, not regenerated random material. A current-authorized exact retry returns
the original token-free receipt before checking current request state or new
material; it never replaces the original envelope or extends expiry. Changed
intent or cross-kind UUID reuse conflicts. All paths retain the original audit
and operation registry, including acceptance attempts, so older role/deny writers
also reject cross-kind reuse.

## Delivery protocol

The service-only worker RPCs reject a mixed service/member identity:

- `claim_early_access_invitation_deliveries(target_worker_token uuid,
  target_batch_size integer default 1)` returns at most one job. Its exact fields
  are `deliveryId`, `binding`, `envelope`, `tokenDigest`, `contentFingerprint`,
  `idempotencyKey`, `firstDispatchedAt`.
- `mark_early_access_invitation_dispatched(target_delivery_id uuid,
  target_worker_token uuid,target_content_fingerprint text,target_token_digest
  text)` returns null or the transactional adapter's exact dispatch receipt.
- `settle_early_access_invitation_delivery(target_delivery_id uuid,
  target_worker_token uuid,target_outcome text,target_code text default null,
  target_receipt_id uuid default null)` returns boolean. Outcomes are `accepted`,
  `retryable`, `uncertain`, or `needs_review`. Accepted requires a provider UUID,
  prior dispatch and no error code; other outcomes cannot supply a receipt.

The worker **must authenticate-decrypt and validate the complete frozen binding,
raw-token digest and content fingerprint before calling the dispatch fence**.
SQL has no encryption key and cannot prove decryption on its own. It trusts only
the dedicated server worker for that operation, not the administrator's submitted
ciphertext. Mere storage of a hash/envelope never permits acceptance.

Leases last two minutes; retries retain the exact envelope/body/key and first
dispatch time. The dispatch fence reserves the existing shared conservative free
email quota once and rechecks lease, account, invitation, configured pre-beta
program and 23-hour uncertainty window after quota waits. The program is SHARE
locked before invitation/delivery locks. A new reservation is rolled back when that wait outlasts
authority. Twelve claims or an exhausted retry window require review. There is
no automatic redrive, paid fallback or claim of perpetual exactly-once delivery.

Provider acceptance records sent time truthfully and removes delivered ciphertext.
It is not proof of inbox arrival. Revoked/superseded jobs cannot be restored by a
late worker. Each claim also expires at most 25 current invitations, with one
typed system audit per expiration, and cancels/purges their unsent payloads.

## Authenticated acceptance and lock order

`accept_early_access_invitation(target_expected_actor_id uuid,
target_generation_id uuid,target_token text,target_operation_id uuid,
target_correlation_id uuid)` requires an original authenticated member bearer,
allowed Origin, healthy confirmed account, live immutable session and current
verified-factor requirements. It strictly decodes the canonical 43-character
base64url token to 32 bytes and compares its SHA-256 hash; pad-bit aliases and
hash-as-token substitution are rejected. Raw tokens are never stored or returned.

Acceptance checks the current generation, fixed mailbox and pinned UUID, seven-day
expiry, validated dispatch and unlaunched program. It atomically consumes the
capability, marks the request accepted, inserts only the EA grant, and relies on
the existing trigger for immutable lifetime USD $3.50/month qualification. Audit and
receipt share that transaction. The successful receipt is exactly
`{ok:true,status:'accepted',actorId,program:'early_access_v1'}`. No app permissions
are inferred from a browser flag, metadata, or delivery receipt.

The actor Auth row's KEY SHARE is taken **before** the existing lifecycle lock so
the grant/qualification/receipt foreign keys cannot introduce the reverse
Auth-delete lock order. The new invitation account UUID deliberately has no Auth
FK: it remains a historical pin after deletion and live checks fail closed.
Lifecycle operations then lock request and, for acceptance, program before grant.
After grant-trigger or foreign-key waits, fresh checks repeat canonical email,
exact pinned UUID, healthy confirmed account, the same live session/current MFA,
expiry and beta boundary. Failure rolls request/grant/qualification back. Native
changes committed before these final checks must deny; overlapping changes after
the relevant final check may order after acceptance. This is authorization at the
final fresh check, not a blanket claim of native Auth state frozen until COMMIT.

No new Auth triggers or parent/child FK coupling are installed. The existing
final-admin guards and directory synchronization remain unchanged. In particular,
a native child INSERT must not acquire lifecycle before its FK can lock the
parent: parent DELETE already owns its row before the existing final-admin guard.
The fixture models factor/user and AMR/session native parent foreign keys and
tests those deletion races. Full native Supabase replay remains a release gate;
the isolated fixture is not a substitute for the installed provider schema.

The existing verified-intake boolean helper now takes the matching Auth KEY
SHARE before intake's advisory/request locks. Its ACL and result stay unchanged;
only volatility and parent-lock ordering change. A native regression proved the
otherwise possible three-way intake(request→Auth FK), deletion(Auth→lifecycle),
issuer(lifecycle→request) cycle and verifies this narrow correction.

Member retries require current identity and retrieve the same receipt; changed
intent conflicts. New attempts are limited to 10/minute and 50/hour. Invalid
unknown capabilities get a bounded hashed operation receipt without a guessed
request audit or private record disclosure. Known request failures are audited.

## Explicit unfinished boundaries and verification

A no-account invitation remains `account_setup_required` even if an arbitrary
account with the same email is later created. The companion
`20260927233055_early_access_account_bootstrap.sql` now provides the separate
reserved-UUID native bootstrap and short-lived recovery-mail outbox described in
`early-access-account-bootstrap.md`. It exposes no arbitrary service-role
account-binding RPC. Existing foreign unconfirmed account recovery is not
implemented by sending it a normal native invite.

Runtime integration of new-account setup, acceptance browser continuation,
remaining UI history/worker-status presentation, real runtime keys,
worker scheduling and an authorized production canary remain release work. This
migration alone does not complete FOU-1742 or claim a production deployment.

`node --test scripts/early-access-invitation.sql.test.mjs` uses only a new labelled,
cached-image, network-none tmpfs PostgreSQL fixture. Tests cover real constraints,
RLS/ACLs, audit rollback, exact retries, canonical token parsing, quota/worker
fencing, acceptance and native Auth email/delete/session/MFA races. Registered
`300_early_access_invitations.sql` verifies exact security inventories and that no
extra native Auth triggers are introduced. It must be included in full replay, advisor and
schema-drift CI before release. No hosted SQL or real invitation is used by tests.

The isolated runner also executes the production scheduler's exported SQL against
real `pg_cron`, `pg_net`, and Supabase Vault. The fixture disables Cron execution
globally and has no network, ports, or host volumes; Vault's bundled key helper
generates a fresh key in disposable tmpfs. It verifies the quota-function source
fingerprint, dispatch/table privileges, parameterized encrypted-secret setup,
exact job commands and readback, stable retry IDs, and rejection of privilege or
quota-policy drift. These checks do not configure production or send worker HTTP.
