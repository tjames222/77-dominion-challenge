# Password recovery ownership boundary

The reset page requires a native `PASSWORD_RECOVERY` event from the existing
Supabase Auth singleton. An ordinary cached session, query parameter, or successful
sign-in does not enable password changes. A small eager observer captures only
the current event so the reset-only controller can load lazily without losing it.
The user UUID, native session UUID, and exact bearer remain in private closures;
the page receives only an opaque handle and fixed presentation state.

Logout, another account/session, token changes, relevant storage events, or
`pagehide` synchronously retire the handle. A failed native ownership check also
retires it, including an A→B→A cache sequence. Outside Auth callbacks the
controller checks the exact current SDK session and makes a direct, bounded
`GET /auth/v1/user` with the captured JWT. Only after that native endpoint accepts
the bearer does the controller bind its `sub`, `session_id`, supported `aal`, and
unexpired integer `exp` claims. Its next assurance level is derived from **all**
fresh verified server factors, not cached user data or only TOTP factors.
Malformed factor inventories fail closed; an omitted optional inventory means
no factors, as in GoTrue's user response.

Recovery deliberately does not call SDK `getUser` or either SDK MFA assurance
overload. The installed SDK can clear its stored session when a pending user
read returns `session_not_found`, even if another account replaced that session
before the response. Direct native reads have no SDK/storage side effect, and
the existing before/after-await owner checks still retire stale operations.

The password request is a bounded `PUT /auth/v1/user` with the captured bearer
(or the private same-session AAL2 bearer described below).
The handle is consumed before dispatch, and an unknown result cannot automatically
retry. Subsequent global/local logout requests use that same bearer, even if the
browser has changed accounts while the password request was in flight. Neither
SDK `updateUser` nor SDK `signOut` selects a replacement owner.

The controller does not clear SDK/local storage: there is no supported atomic
conditional removal API that would safely exclude a replacement account. The
completion UI instead requires explicit sign-in again and reports server-session
revocation accurately. Supabase access JWTs can remain valid until expiration;
logout revokes refresh sessions, not the signatures on already-issued JWTs.
Native GoTrue `/user` additionally requires the JWT's session row to exist, so
the Login page's native user check rejects a successfully revoked recovery
session and leaves the explicit login form available. Invitation acceptance
independently requires a current native session in SQL, so a revoked cached
recovery bearer is not acceptance authority. The password response never grants
membership, accepts an invitation, or starts billing.

## Same-page verified TOTP continuation

When current native MFA requires AAL2, the reset page keeps password entry disabled
and offers only the account's existing, verified TOTP factors. Selecting a factor
and submitting its current six-digit code explicitly creates a native challenge
and verifies that challenge. The controller makes no enrollment, replacement or
unenrollment calls. A
phone-only account or a missing verified authenticator stays blocked with a
support path; loss of a factor never silently removes the MFA requirement.

The original SDK user UUID, session UUID and exact access token remain the
immutable lifecycle anchor throughout this operation. The controller calls native
`POST /auth/v1/factors/<id>/challenge` and `/verify` with that exact bearer. It
does **not** call the SDK's mutable-owner challenge/verify methods, `setSession`,
or any private SDK storage method. All requests pin the installed SDK's
`X-Supabase-Api-Version: 2024-01-01`, omit credentials, disallow redirects, use
no-store caching, and bound the entire operation/body read. A challenge UUID is
private, single-attempt, and bounded by the native expiry (at most ten minutes).

A locally initiated successful verification may return a new bearer. Its parsed
claims are only binding checks, never authorization: the user and native session
UUID must remain exact, `aal` must be `aal2`, and expiry must be finite, unexpired
and no more than 24 hours away. A fresh, direct native `/user` read with that
exact bearer must accept it and return the same actor and still-verified selected
TOTP before its AAL2 claim is used. The private bearer is used only for
fresh native validation, password update and owner-bound logout (global first,
local fallback). Returned refresh
credentials are ignored; neither bearer nor code is installed or persisted in
SDK/browser storage. The final password check again requires the exact original
SDK anchor and the selected current verified factor.

GoTrue rotates refresh credentials during MFA verification and may remove
unverified factors and invalidate the same user's other AAL1 sessions as part of
its native verification transaction. Those provider-side effects are not claims
of browser-storage mutation or a promise to preserve every same-user session.
The old SDK refresh token is intentionally not adopted or repaired. Any refresh, user-update,
MFA-verified event (even with the same session UUID), storage change, sign-out,
account replacement or pagehide still retires recovery synchronously. This can
require a fresh reset link if an independent refresh happens mid-recovery, but
cannot transfer the capability to a replacement account. No special event
exception or A→B→A resurrection is allowed.

Only a bounded, explicit HTTP422 `mfa_verification_failed` response permits an
explicit fresh-code attempt, after rechecking the original owner and factor. The
old challenge is already consumed and cannot be replayed. Factor loss, other
provider errors, malformed receipts, deadline/body failures and unknown results
retire the capability; no automatic retry occurs. Codes are cleared from the form
before network work. Passwords, codes, tokens and raw provider errors are never
logged or returned in presentation state. If the account changes during an
already-dispatched password request, subsequent logout still targets the captured
private bearer and never clears the replacement SDK session.

Contract references: installed `@supabase/auth-js`2.110.0 `GoTrueClient._challenge`,
`_verify`, `_getUser` error cleanup, and JWT-overload `_getAuthenticatorAssuranceLevel`;
the pinned GoTrue
v2.196.0 native fixture; [official TOTP flow](https://supabase.com/docs/guides/auth/auth-mfa/totp),
[challenge](https://supabase.com/docs/reference/javascript/auth-mfa-challenge) and
[verify](https://supabase.com/docs/reference/javascript/auth-mfa-verify). The public
changelog was checked September28,2026; no relevant hosted TOTP endpoint breaking
change was identified. No Auth configuration or schema change is part of this slice.

The tests cover eager capture before lazy loading, synchronous invalidation,
silent owner changes, ABA, deadlines, unknown results, exact bearer revocation,
and actual SDK recovery/login events against a mocked native transport. The MFA
units additionally cover the installed-SDK pending-403/replacement-storage race,
bounded native reads, malformed claims and all-factor inventories, private token
binding, incorrect-code retries, selected
factor loss, malformed/oversized/stalled responses, expiry and invalidation during
each operation. Native fixture and compiled browser coverage are separate release
checks. These are local test evidence, not a hosted deployment or delivery receipt.
