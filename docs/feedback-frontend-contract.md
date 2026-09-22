# Early Access feedback frontend contract

The text-only component for FOU-1803 is connected to the candidate's lazy
authenticated-page widget and owner-bound client. The component itself still
does not authorize an account, perform Auth or network calls, send email, or
create a Linear issue. This is local implementation evidence, not deployment or
ticket-completion evidence. See [the runtime contract](early-access-feedback-runtime.md)
for persistence, delivery, provider configuration and remaining release gates.

## Injection boundary

`createFeedbackDialog({ owner, context, isCurrent, submit, onSaved, requestTimeoutMs, document })`
returns `open(trigger)`, `destroy()`, `hasPendingIntent()` and `isAvailable()`.
`feedback-widget.mjs` imports the dialog and its scoped stylesheet lazily, after
the menu coordinator has obtained fresh canonical Early Access context on an
allowed authenticated route. The dialog and its CSS are absent from every
initial entry closure; they are not mounted on Public/Auth/Security/Admin/Invite
routes.

The caller must verify canonical Early Access eligibility and capture the actor
and immutable session identity before constructing it. `isCurrent(owner)` is a
synchronous lifecycle fence, not authorization. `submit(intent, { signal })` must
be an authenticated owner-bound server adapter that verifies the same actor,
session, current EA entitlement and permitted origin, including after waits.
No second Auth client, cached authorization, editable metadata flag or browser
allowlist supplies that authority. `api.js` injects the existing singleton into
`feedback-client.mjs`; that client pins the original actor/session/bearer across
canonical Auth checks, waits, RPC dispatch and final publication. The browser
uses `get_member_access_context` and `submit_early_access_feedback`, not service
pricing or administrative RPCs. A notification callback receives only a
validated saved receipt.

Call `destroy()` synchronously on owner/session loss, sign-out, pagehide and
feature teardown. Destruction aborts the caller's request, scrubs private form
values and fences ignored-abort completions without claiming server rollback.
It does not restore focus to an ineligible trigger. Another shared dialog's
forced replacement also retires this instance. Recreate with a freshly verified
owner before mounting again. Drafts are deliberately not stored or logged.

## Fixed input and context

Input fields are `type`, `description`, optional `expectedBehavior`, `impact` and
boolean `contactAllowed`. Category/impact labels exactly match the ticket.
Description must contain a non-whitespace character, but its original string is
preserved verbatim; the same is true of expected behavior. Browser and SQL
validation share caps of 10,000 and 5,000 UTF-16 code units. The downstream
renderers and transports independently enforce their bounded output/body sizes.
Unknown fields, attachments,
identity assertions, null/nonstring text, PostgreSQL-incompatible NUL and
ill-formed Unicode surrogate sequences are rejected. Valid Unicode is not
normalized or rewritten.

Context is limited to:

- `route`: exact canonical `.html` name from the fourteen-entry list below;
- `theme`: light, dark, dominion-night or dominion-platinum;
- `viewport`: integer width/height from 1 through 16,384;
- `buildSha`: full forty-character lowercase Git SHA;
- `browser`: chromium, firefox, safari, other or unknown;
- `platform`: windows, macos, linux, android, ios, other or unknown.

The dialog receives these already-coarsened values. `feedback-context.mjs`
reduces the runtime user-agent string to fixed enums and discards the raw string;
the widget captures only pathname, theme, viewport and validated build SHA.
There is no DOM/form-content scanning, storage/referrer collection, private
content, token, user-metadata or screenshot capture. Geometry-only placement
checks do not add context fields. Server-derived reporter/email/cohort and
timestamps are not accepted as client-authoritative context.

The fixed route list is dashboard, badges-rewards, bible-reading,
morning-prayer, worship, evening-prayer, workout-one, intentional-walk,
workout-two, community, group-settings, private-journal, billing and profile,
each with `.html`. This context allowlist is not a mount/eligibility decision.
Public/Auth/Security/Admin/Invite routes are not admitted. `feedback-route.mjs`
canonicalizes clean root-level extensionless/HTML aliases from
`window.location.pathname`; query/hash never enter the context builder. The
final context contract accepts only canonical names. Full URLs, nested paths,
encoded paths and query/fragment-bearing strings fail closed. Broader coverage
requires explicit review. `vite.config.mjs` supplies the build SHA only from
validated build-environment values; an absent SHA keeps the widget hidden.

## Durable receipt and retry

A frozen intent has exactly `{ operationId, input, context }`, with a UUID
operation ID. The same object and exact payload are retained on uncertain retry.
The integrated RPC performs server idempotency keyed to the authenticated actor,
operation ID and exact input/context; a browser double-click lock is not enough.
New submissions require current active Early Access. An exact previously
dispatched operation may recover its existing receipt after Early Access ends,
but cannot create a new row without server-side eligibility.

Only this exact versioned receipt confirms the submission:

```js
{
  schemaVersion: 1,
  operationId, // exact original UUID
  feedbackId,  // persisted feedback UUID
  actorId,     // exact captured actor
  status: 'saved'
}
```

Unknown fields, malformed receipts, wrong operation/actor, throws and timeouts
remain uncertain. A bounded deadline (20 seconds by default, configurable from
1 through 60,000 milliseconds) aborts the caller's request without pretending
it was rolled back. Raw provider errors are not displayed. Text is kept and editing
is locked; the explicit retry button resends the same immutable intent. While a
request is in flight, dismissal is blocked only until that bounded deadline.
The uncertain state permits Close for now/Escape/backdrop and retains the exact
draft and intent for reopening by the same owner on this page. The UI warns that
leaving the page or signing out clears it. Late responses after the deadline
cannot publish. Explicit pre-submit cancel is supported; forced
owner/page/modal teardown always scrubs. Errors use fixed safe messages, never
raw provider text. The dialog does not guess that a failed or timed-out request
was rolled back and unlock its immutable payload for editing.

After a verified receipt the component clears the draft, announces saved status
without claiming Linear/email delivery, and offers Close. Opening a new form
afterward creates a new operation only when submitted. Callback failure cannot
turn an already-verified receipt into an uncertain retry.

## Widget placement and verification

The square message-icon launcher has the accessible name “Send Feedback”. It
uses safe-area offsets and mounted-page bottom space. It hides while a menu or
dialog is active and when its geometry would overlap an interactive page
control, including narrow controls; it returns when the obstruction is gone.
Placement does not read text or field values. Editing/uncertain drafts survive
benign same-session refresh, while owner/session loss synchronously scrubs them.

Focused Node tests exercise the actual component and existing `createDialog`
through a small DOM double: semantics/labels/focus containment, local validation,
double-submit, exact immutable retry, wrong/malformed receipt, owner teardown,
ignored abort, shared-modal replacement, new submission and narrowly scoped CSS.
The test-only DOM helper is not imported by application code. Compiled
Chromium/WebKit tests cover the real SDK with synthetic transport: eligibility,
all fourteen routes, malformed/MFA rejection, exact uncertain retries,
same-session retention, replacement-session teardown, all four themes, native
focus/keyboard behavior, axe checks and phone/desktop/tablet geometry. Consent
checkbox and label bounds are checked separately from container bounds. Actual
28-entry builds verify optional-module isolation, one Auth runtime, unchanged
initial request counts and ordered initial CSS. This is not an actual
screen-reader acceptance claim or a claim that existing performance budgets pass.

## Remaining release gates

The owner approved free Early Access until beta, indefinite $3.50 USD monthly
beta-price eligibility including cancellation/return, and Resend's free tier.
That policy approval does not provision an account or make the incomplete
approval/invitation/acceptance flow available. Remaining gates include that flow
and entitlement integration, Resend/Linear least-privilege configuration,
approved worker scheduling, full schema/release checks and an authorized
production canary verifying durable persistence and independent Linear/support
delivery retry. Public signup and billing stay disabled. Neither this frontend
contract nor the local synthetic tests assert that the candidate is deployed.
