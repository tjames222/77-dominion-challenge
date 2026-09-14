# Authenticator setup and sign-in

`/account-security.html` (and the clean `/account-security` path) is the signed-in
self-service TOTP screen. Profile links to it. It is intentionally available
before membership access or an admin role, and does not depend on an admin RPC.

An enrolled user at AAL1 is sent here after password login before profile
creation, local identity persistence, billing lookup, return navigation, or
private header/theme hydration. The user must verify an existing factor. New
enrollment is never an alternative to that challenge. `mode=step-up` asks for a
fresh code even at AAL2, so future admin actions can request recent TOTP proof.

## User setup

1. Sign in and open **Profile → Account security → Set up authenticator**.
2. In a free TOTP-compatible authenticator, scan the QR code from another device,
   or use **Copy setup key** on the same phone and select a time-based account.
3. Enter the current six-digit code and select **Verify code**. Only confirmed
   provider AAL2 plus a verified factor shows success.

The agent does not enroll users, retrieve their setup keys, or grant an admin
role. Those are separate user/private-operator actions. Supabase TOTP is enabled
by default and does not require paid SMS. See the
[official TOTP guide](https://supabase.com/docs/guides/auth/auth-mfa/totp).

## Secret and session lifecycle

The installed SDK saves a successful MFA session before returning from verify.
The shared client therefore uses public `fetch` and `SupportedStorage` adapters
to cancel stale requests and fence the exact MFA session token at its serialized
storage commit. A Web Lock plus a nonsecret random session-revision UUID detects
immutable session changes and cross-tab A→B→A transitions. No private SDK method,
unsafe session restore, or separate `userStorage` is used. Normal non-MFA Auth
retains its in-memory fallback when storage is unavailable; MFA fails closed if
durable browser storage or Web Locks cannot coordinate it.

Coordination is strict only among updated app tabs using this guard. Older
already-open tabs or other uncoordinated clients do not participate. Close or
reload older Dominion tabs before setup, especially after deployment or a
coordination error. A same-session `SIGNED_IN` on refocus does not clear setup;
an actual actor/immutable `session_id` transition does. These JWT fields are
non-authoritative change markers, never a substitute for provider verification.

- Keys, QR PNGs, and codes are transient DOM/in-memory values only. No secret is
  written to application storage, URLs, logs, analytics, or public artifacts.
  Copy is an explicit user action; the UI warns the user to clear their clipboard.
- Cancel, pagehide, account change, replacement, and confirmed verification clear
  the key/QR/code. The key is also hidden after ten minutes. Switching to an
  authenticator app does not clear it merely because the page becomes hidden.
- A lost response is reconciled with provider state. If the factor is verified
  but the client is still AAL1, the key is cleared and a fresh code can challenge
  that existing factor without re-enrollment or removal.
- Cancellation only forgets this local operation; it never calls `unenroll`.
  A provider-side unverified factor can remain inactive after cancellation,
  navigation, or an account race. A unique per-attempt friendly name avoids
  blocking the next attempt by name. The provider factor limit is reported
  safely; no automatic factor reset/cleanup is attempted.
- The public SDK can select a session token asynchronously. An account change
  during enrollment can leave an inactive provider factor; the actor/epoch
  fences prevent returning another account's secret or applying its UI state.
  No read-then-delete cleanup is used because verification can race that deletion.

## Authorization boundary

This release is a sign-in/setup presentation flow, not a claim that every
existing Data API/RLS table now requires MFA. Protected admin APIs independently
must verify canonical role, live session, verified TOTP/AAL2, and recent
same-session TOTP AMR for privileged writes. Local assurance flags, user metadata,
preview fixtures, and a successful-looking screen are never backend authority.

Develop's pure mock screen is explicitly marked **Preview simulation only**.
Its displayed example code does not protect a live account and is never accepted
as production MFA. Production-mode browser tests use the installed SDK with a
synthetic local HTTP provider; no real customer data or hosted mutation is used.

## Verification

- `pnpm test` includes adapter and safe-navigation regressions.
- `pnpm exec playwright test tests/e2e/mfa-security.spec.mjs --project=chromium-functional --project=webkit-mfa-mobile`
  covers all four themes, phone/desktop, accessibility, key copy/cleanup, retries,
  explicit step-up, and 200% text zoom.
- `pnpm exec playwright test --config=playwright.mfa.config.mjs` builds production
  wiring against only a synthetic local provider, verifies no protected request
  during enrolled AAL1, and exercises enrollment, normal billing, invite/group
  continuation, and lost-response recovery in Chromium and WebKit.
- The security route permits zoom; it is a narrow exception to the earlier
  viewport-lock contract. No platform-specific screenshot baselines are included.

Deployment and real-user enrollment are separate release evidence. Passing these
local tests alone does not mean a production deployment or admin activation has
occurred.
