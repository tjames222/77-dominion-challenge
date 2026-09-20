# Reviewed site-role controls (FOU-1502, partial delivery)

This isolated next-batch UI consumes the existing reviewed
`public.site_admin_assign_role` RPC. It adds no SQL, grants, bootstrap, Auth
configuration, hosted writes, testing access, invitations, email, billing or
unrelated account CRUD. It is not a deployment or completion of all FOU-1502.

## Review and authority

User details show the role review only with both `users.read` and `roles.manage`.
The target UUID and original canonical `roleRevision` are bound to that dialog's
actor and immutable session identity. Self-edit and same-role assignments are
disabled; the latter would otherwise increment the revision and block sessions.
The UI never infers target TOTP eligibility from the account summary: the server
checks that requirement and can return `target_mfa_required`.

The operator explicitly chooses `member` or `site_admin`, one of the three
allowlisted reason codes, and acknowledges the displayed access impact. Changing
role or reason clears the acknowledgement. Opening review and confirming both
fetch fresh canonical context. The write client additionally captures a verified
Auth user, exact bearer, session and epoch; it checks both read/manage capabilities
and a literal `stepUpRequired: false`. The RPC independently rechecks current
authority and recent same-session TOTP. A 403 is not guessed to mean only MFA.

Account Security handles step-up separately. No draft is stored in the URL,
Web Storage or any cache. Returning never replays a mutation: start a new review.
Actor round trips, session replacement, assurance/token changes, pagehide,
visibility loss, cancellation and dialog close discard the decision. Epoch and
bearer checks reject late results even when a transport ignores abort. The whole
write attempt, including owner verification, has a 20-second timeout; a late
preflight cannot start a write after that timeout.

The existing SQL emits role revisions as JSON numbers. Revisions must be safe
nonnegative integers with a safe `+1`; a rounded/string/fractional/oversized value
disables the control rather than pretending to restore precision. No schema or
wire-contract change is bundled here.

## Outcomes and retry

One immutable intent carries actor, session, target, old/new role, original
revision, reason, and operation/correlation UUIDs, with no name/email payload.
The adapter copies it before any await. Only an explicit confirmation invokes
the single allowlisted role RPC; there is no automatic retry or rebasing.

- A lost, malformed, timed-out or otherwise unconfirmed submitted response may
  already be committed. Only **Retry same role change** resends every original
  field and both UUIDs unchanged. Inputs stay locked. Closing discards it.
- `rate_limited` happens before mutation/idempotency persistence. The same manual
  exact retry is available after waiting; nothing runs automatically.
- Audited terminal failures (`invalid_input`, `self_action_forbidden`,
  `target_unavailable`, `revision_conflict`, `target_mfa_required`) end the review.
  Reload and make a new decision with new UUIDs; reusing the old operation would
  replay its stored failure forever. Idempotency mismatch also requires reload.
- The thrown `admin_final_recovery_path` response has distinct safe copy. The UI
  does not invent an RPC `final_admin` result or broaden server recovery policy.

Success must match the intent's role, exact original revision + 1 and literal
`reauthenticationRequired: true`. A stored replay receipt proves the original
operation, not current role. Old account facts and list rows are immediately
removed; separate owner-bound reads refresh details, the first filtered account
page, and up to ten latest role audit events (only with `audit.read`). A failed
refresh leaves a truthful original-operation receipt and a read-only retry,
never stale facts relabeled current or another mutation.

Copy distinguishes **existing sessions blocked from administration** from global
sign-out. To use administration again if still authorized, the target must sign
out, sign in again, then verify MFA. Ordinary member access is not globally
signed out or revoked. Same-session token refresh/TOTP does not clear the block.

Develop-only preview stays read-only for roles and never grants `roles.manage`.
Role mutations exist only in the synthetic HTTP browser test fixture, not the
shipped preview adapter. Production transport keeps no-store, omitted cookies,
redirect rejection, fixed error copy and the existing account scrubbing rules.

## Verification

`node --test src/static/*.test.mjs` covers contracts, precision, immutable payloads,
permission/step-up preflight, exact retries, stale bearers/epochs, unknown results
and bounded owner-verification timeout. `pnpm test:e2e:admin` builds with mocks off
and production wiring to a loopback-only synthetic Supabase provider. New role
tests block non-loopback HTTP and all WebSockets and cover grant/removal, terminal
errors, rate limits, uncertain commits, original receipts versus newer roles,
post-success refresh/failure, actor/assurance loss, pagehide/close, no persistence,
four themes, keyboard/focus, 390px WebKit and desktop Chromium, 200% text and Axe.
These browser fixtures do not replace exact-SQL authority/transaction tests.

The actual built graph regression keeps role contracts/UI/write code out of the
seven canonical public/member initial graphs and Account Security. No CSS,
chunk configuration, budget or target is relaxed. Measurements and remaining
performance failures are recorded in
[the local evidence](release-evidence/admin-role-ui-2026-09-20.md).

Supabase references reviewed: [TOTP MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp),
[challenge and verify](https://supabase.com/docs/reference/javascript/auth-mfa-challengeandverify),
[assurance levels](https://supabase.com/docs/reference/javascript/auth-mfa-getauthenticatorassurancelevel).
