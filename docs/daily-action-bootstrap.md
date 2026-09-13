# Focused Daily Action bootstrap (FOU-1501)

This is a bounded part of FOU-1501, not completion of its Dashboard, history,
bundle-size, or deployed performance requirements.

## Contract

`get_daily_action_bootstrap(expected actor, time-zone hint, optional entry date)`
is an authenticated POST RPC. The public wrapper delegates to a revoked private
implementation without granting access to the private schema. It returns only
`schemaVersion`, `actorId`, `asOf`, `appAccess`, `activation`, `timeZone`,
`entryDate`, and `draft`. `asOf` is statement start, not a promise that all
concurrent database state was frozen at that instant.

Missing access returns null activation/date/draft fields and performs no profile
creation, activation promotion, or time-zone write. Input and actor checks still
run. App access remains distinct from challenge eligibility. Member reads reuse
the existing activation promotion, time-zone initialization, canonical user-date,
and draft helpers, preserving the single-crew → activation → Auth-parent → profile
lock ordering. The server selects today when no requested date is supplied;
explicit historical dates retain the existing read-only draft rules.

Successful payload responses are `private, no-store`; an aborted SQL transaction
does not promise those headers on its error response. The browser does not cache settled private
responses or Auth decisions. Identical pending reads share one RPC; every
operation verifies the user before and after the request, checks the immutable
session lifecycle marker, and rejects stale responses after A → B → A, a new
same-user session, mutations, storage changes, or page exit. MFA presentation
gating and the existing guarded Supabase client remain in force. This is not a
claim that all ordinary Data API endpoints enforce MFA on the server.

All seven pages use this route-specific bootstrap in production wiring. Pure
mock/hybrid preview keeps its existing actor-scoped simulated data path. A
20-second loading deadline and explicit retry prevent an indefinite spinner.
No route here submits a Check-In automatically; checkbox/difficulty mutations
remain separate, expected-actor-bound user actions.

## Request evidence and remaining costs

At source baseline `aa8747b917a66274829a0346d233dad4be5c4591`, a network-free probe
of the actual API bodies found 11 application-data requests in the active Daily
Action loader: billing (1), broad Dashboard (8), time-zone initializer (1), draft
(1). Those had four application-data dependency waves; four `getUser` calls in
the composed API path were counted separately. Existing-profile/billing-disabled
conditions apply; session refreshes are additional.

The new route loader makes **one focused RPC**, with two fresh `getUser` checks
and local session/AAL checks. It requests no Dashboard feed, 90-day histories,
stats, badges, separate billing decision, or draft/time-zone preflight.

This is **not a one-request whole page**. Existing shared header, app visit,
theme, admin-navigation readiness, and eligible training requests remain separate
and unchanged by this phase. Browser test attachments list those paths alongside
Auth and focused-route counts. User-triggered mutations and their existing draft
recovery have separate costs. Further shared-shell/request work remains open.

## Verification

- `pnpm test`: normalization, pending-only coalescing, stale actor/session results,
  fixed errors, timeout/retry, existing owner/mutation contracts.
- `pnpm test:e2e:daily-bootstrap`: production-built, actual SDK, synthetic loopback
  provider; seven routes × clean/HTML × Chromium/WebKit, request counts, access
  and scheduled states, AAL1 gating, delayed responses, focus storms, all themes,
  accessibility, mutation date/version, restored-page refresh and timeout.
  Cross-tab A → B → A and same-actor/new-session notifications reject held
  results and rehydrate outside the synchronous provider callback. An enrolled
  replacement session reaches the existing MFA gate without an Auth deadlock.
- `pnpm test:daily-bootstrap-sql`: uniquely named, network-none/tmpfs PostgreSQL
  `17.6.1.141` fixture. Actual prerequisite SQL bodies plus the exact new migration
  run pgTAP280 with the normal clock. A test-only clock replacement then exercises
  midnight, both DST transitions, concurrent schedule promotion, and account
  deletion locking; no business-rule helper is replaced by a stub.
- `pnpm test:database`: full migration-chain pgTAP280; regular CI also runs advisors
  and lint. Local Docker disk capacity may prevent the isolated fixture from
  starting; that is not a SQL pass. No hosted database is used by these tests.

The isolated checkpoint passed 838 frontend tests, 60 production-built browser
tests, all 24 normal-clock pgTAP assertions, and seven actual-function SQL tests
(including concurrent promotion and deletion). The exact database inventory at
this checkpoint is 38 files / 1,610 planned assertions. This is not a claim that
the full migration chain or hosted stack has been executed by that fixture.

Full-stack CI (including advisors, SQL lint, and schema reconciliation) and
deployed before/after measurements remain required before claiming release
verification or closing the performance ticket. Apply the migration before
releasing the new frontend: there is deliberately no broad Dashboard fallback
when the focused RPC is unavailable.
