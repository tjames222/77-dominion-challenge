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
controller checks the exact current session, `getUser(capturedJWT)`, and
`getAuthenticatorAssuranceLevel(capturedJWT)`. The JWT overload fetches current
native factors; the zero-argument cached-MFA result is not used.

The password request is a bounded `PUT /auth/v1/user` with the captured bearer.
The handle is consumed before dispatch, and an unknown result cannot automatically
retry. Subsequent global/local logout requests use that same bearer, even if the
browser has changed accounts while the password request was in flight. Neither
SDK `updateUser` nor SDK `signOut` selects a replacement owner.

The controller does not clear SDK/local storage: there is no supported atomic
conditional removal API that would safely exclude a replacement account. The
completion UI instead requires explicit sign-in again and reports server-session
revocation accurately. Supabase access JWTs can remain valid until expiration;
logout revokes refresh sessions, not already-issued JWTs. Invitation acceptance
independently requires a current native session in SQL, so a revoked cached
recovery bearer is not acceptance authority. The password response never grants
membership, accepts an invitation, or starts billing.

## Current MFA limitation

This is **not complete recovery support for an account with an existing verified
authenticator**. If current native MFA requires AAL2 and the recovery session is
AAL1, the reset page disables password mutation and shows a fixed support message.
It does not enroll a replacement factor, weaken MFA, accept a stored assurance
flag, or navigate away and silently recreate recovery ownership. New-account
setup, where no verified factor exists, uses the supported path. A future
same-page MFA continuation needs its own reviewed owner-preserving challenge and
token-transition flow before this limitation can be removed.

The tests cover eager capture before lazy loading, synchronous invalidation,
silent owner changes, ABA, deadlines, unknown results, exact bearer revocation,
and actual SDK recovery/login events against a mocked native transport. These
are local test evidence, not a hosted deployment or delivery receipt.
