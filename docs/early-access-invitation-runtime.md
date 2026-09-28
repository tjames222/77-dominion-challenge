# Early Access invitation runtime

The runtime was deployed on September 28, 2026 in
[production release 36382374620](https://github.com/tjames222/77-dominion-challenge/actions/runs/36382374620),
main `0211bd537de765078355076104da0ae9b9a807e2`. Exact hosted migration history,
function configuration, worker health, and public artifact delivery were verified.
Resend accepted the single approved test email. A separately authorized owner
canary persisted one public request, which the owner approved through the normal
admin UI; the invitation was provider-accepted on its first attempt at
07:20:02 UTC. Inbox receipt and a real hosted invitation acceptance have not yet
been confirmed. Keep FOU-1742 open until the
remaining end-to-end acceptance evidence is recorded. FOU-1803 separately needs
real feedback delivery to Linear and the support mailbox; metadata checks are
not issue-creation or inbox-delivery evidence.

## Administrative action

`admin-early-access-invitation` accepts POST from an exact configured site Origin
with the original administrator's native Auth bearer. Its JSON body has only:
`action`, `expectedActorId`, `requestId`, `expectedRevision` (decimal string),
`operationId`, and `correlationId`. Actions are approve, resend, or pre-acceptance
revoke. Denial retains its existing SQL/API path.

For approve/resend the endpoint reads the canonical request under that same
bearer, creates a random seven-day application capability and encrypted frozen
email, and calls the authenticated SQL writer. It never accepts a browser-supplied
recipient, sender, native credential, grant, token, or ciphertext. SQL independently
checks current native session, administrator permission, recent MFA, canonical
mailbox/account, original revision, and program state. Retrying the original
operation retrieves its original result; it cannot replace the first generation.

Only a small decision receipt returns to the administrator. Approved means queued,
not provider-accepted, inbox-delivered, or membership-granted. Resend replaces the
old application capability. Revoke cannot delete an account or revoke an already
accepted membership through this endpoint.

## Delivery

`process-early-access-invitations` requires its dedicated
`x-dominion-worker-key`; it never accepts a member token as worker authority.
It ignores caller-supplied job IDs/content and claims at most one SQL-owned job
per enabled stage (new-account bootstrap, setup email, application invitation).
After decrypting and verifying all bindings, the worker calls the SQL dispatch
fence. That fence checks the lease, current generation, expiry, account/program
state, and shared free-email allowance, and records the first dispatch timestamp
before the provider POST. Retries use exactly the original plaintext,
idempotency key, and timestamp. Uncertain sends beyond the 23-hour retry window
require review, not blind redelivery. Resend is a distinct administrator action.

Server-only runtime configuration:

- `RESEND_API_KEY`: sending-only key restricted to `mail.77dominion.com`.
- `TRANSACTIONAL_EMAIL_FROM`: `Dominion <noreply@mail.77dominion.com>`.
- `EARLY_ACCESS_INVITATION_KEY`: dedicated random 32-byte AES key, canonical
  unpadded base64url; never reuse an Auth, Resend, or integration key.
- `EARLY_ACCESS_INVITATION_KEY_VERSION`: positive integer, matching queued envelopes.
- `EARLY_ACCESS_INVITATION_WORKER_SECRET`: separate high-entropy worker secret.
- `EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED`: exact `true` enables new-account setup;
  absent/`false` leaves that stage off. Enable only after native-flow verification.
- `EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS`: exact `3600`, matching the reviewed
  and read-back-verified native Auth email token lifetime.
- Existing Supabase server credentials and approved site-origin settings.

None belong in Vite/browser variables, artifacts, logs, or chat. The current
runtime selects one exact key version; do not rotate it while jobs still need that
version. First drain or explicitly retire those jobs, or implement a reviewed
versioned keyring. Invalid/missing runtime configuration fails closed.

The application ledger shares a conservative 90-per-24-hour and 2,900-per-31-day
allowance across transactional workers. Other account-level mail, including SMTP,
can consume Resend quota outside this ledger. Do not enable paid overages or raise
limits to make a failed send pass.

## Acceptance and setup

The application link carries only its token and generation in the URL fragment.
The dedicated page removes them before loading Auth. A short-lived tab-local
continuation can bridge explicit sign-in/MFA; secrets never enter `returnTo`.
Opening, scanning, reviewing, or signing in does not accept an invitation.
Acceptance requires an explicit confirmation under a freshly verified owner and
the original native bearer. SQL consumes the current capability and creates the
grant/permanent USD 3.50 monthly price qualification atomically. Billing and public
signup remain disabled.

Confirmed accounts use normal sign-in. Existing unconfirmed/ambiguous/unhealthy
accounts fail closed; native `inviteUserByEmail` or automatic recovery must not
be used to adopt them. A genuinely new account needs a previously reserved random
UUID, create-only Admin Auth call, by-ID-only uncertainty reconciliation, durable
provenance binding, and a separately encrypted short-lived native recovery email.
The private SQL bootstrap queue reserves the UUID before any native call. A
one-way durable start marker prevents a crashed/uncertain worker from blindly
regenerating a native link. The worker creates only the reserved UUID, seals
native recovery mail, then atomically persists the envelope and pins the account.
The separate `native_recovery` AES-GCM purpose includes every binding field,
key version and content fingerprint; it cannot be substituted for app mail.
The same dedicated key is used with a distinct purpose/AAD namespace.

Setup mail uses `dominion-early-access-setup/<deliveryId>` and the same free quota.
Its expiry is conservatively measured from before native creation/link generation,
minus 30 seconds, capped at the application invitation's expiry and one hour.
Only its frozen encrypted payload is retried after unknown provider delivery.
The application invitation is not dispatched until that exact pinned account is
healthy and confirmed. Native failures require review, not adoption of a different
account or blind link regeneration. Normal expired-setup recovery remains a release
UX verification item; the current setup email directs that case to support.

The production Auth guard now requires signup and anonymous access disabled,
email confirmation enabled, unverified-email sign-ins disabled, the exact three
reset redirects and `mailer_otp_exp=3600`. The September 28 production release
verified these hosted settings by read-back. Future releases must pass the same
guard; a local candidate or configuration file alone is not hosted-state proof.

## Required release evidence

The isolated native fixture now exercises actual GoTrue 2.196.0 and PostgREST
16.1 against PostgreSQL 17.6.1.141. Its two service-flow tests cover reserved
creation, the mailed GET verification redirect, installed-SDK recovery callback
and fragment removal, pinned password update/global session revocation, fresh
sign-in, real SQL acceptance/retry/replay, and a foreign unconfirmed account
remaining unchanged. Public signup and unconfirmed password sign-in are denied.
It uses a new labelled internal Docker network, tmpfs database, zero published
ports and a bounded stdin-only internal HTTP transport. No hosted account,
external mail provider, or shared local Supabase stack is contacted. These tests
do not prove hosted provider delivery or replace the remaining release gates.

```sh
pnpm run test:early-access-native-auth
```

1. Verify the implemented durable new-account bootstrap/recovery mail integration
   and original-owner password-recovery fence. Mutation and logout requests use
   the captured native bearer, never a replacement account; see
   `password-recovery-owner-fence.md` for the existing-MFA recovery limitation.
2. Test the complete flow against native Auth with signup disabled and email
   confirmation required, including conflict/unknown-send and expired/revoked
   invitation paths. Mocks and pure helper tests do not substitute for this.
3. Pass the new native SQL/pgTAP checks, full migration replay, advisors, Edge,
   frontend, and production-built desktop/mobile browser checks; obtain review.
4. Provision runtime secrets and reviewed worker scheduling in the existing
   Supabase project. Verify the provider key and a specifically authorized test
   delivery; do not enroll or grant a real person merely to manufacture evidence.
5. Merge through develop/main and deploy the existing Cloudflare production
   project after all gates pass. Preserve billing/public-signup-off, existing
   production data, website DNS, and support forwarding.
