# Early Access feedback frontend leaf

This is an unmounted, text-only component for FOU-1803. It does not authorize an
account, query Early Access state, call an API, send email, create a Linear issue,
or enable the floating widget. It is not ticket-completion evidence.

## Injection boundary

`createFeedbackDialog({ owner, context, isCurrent, submit, onSaved, requestTimeoutMs, document })`
returns `open(trigger)` and `destroy()`. The future lazy entry must load the
feedback-only stylesheet alongside the existing shared dialog styles. No current
entrypoint imports this component or its stylesheet.

The caller must verify canonical Early Access eligibility and capture the actor
and immutable session identity before constructing it. `isCurrent(owner)` is a
synchronous lifecycle fence, not authorization. `submit(intent, { signal })` must
be an authenticated owner-bound server adapter that verifies the same actor,
session, current EA entitlement and permitted origin, including after waits.
No second Auth client, cached authorization, editable metadata flag or browser
allowlist may supply that authority. A notification callback receives only a
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
preserved verbatim; the same is true of expected behavior. Proposed frontend
caps are 10,000 and 5,000 UTF-16 code units. These must be aligned with the future
server's UTF-8 body limit before integration. Unknown fields, attachments,
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

The caller supplies these already-coarsened values. This leaf does not read raw
UA, location/referrer, DOM/form contents, cookies, storage, private content,
tokens, user metadata or screenshots. Server-derived reporter/email/cohort and
timestamps are not accepted as client-authoritative context.

Reviewed route proposal: dashboard, badges-rewards, bible-reading,
morning-prayer, worship, evening-prayer, workout-one, intentional-walk,
workout-two, community, group-settings, private-journal, billing and profile,
each with `.html`. This context allowlist is not a mount/eligibility decision.
Public/Auth/Security/Admin/Invite routes are not admitted. A future context
builder must canonicalize clean aliases and discard query/hash before calling
this contract; full URLs, aliases and query/fragment-bearing strings fail closed
here. Broader coverage requires explicit review.

## Durable receipt and retry

A frozen intent has exactly `{ operationId, input, context }`, with a UUID
operation ID. The same object and exact payload are retained on uncertain retry.
The injectable adapter must perform server idempotency keyed to the authenticated
actor, operation ID and payload digest; a browser double-click lock is not enough.

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
owner/page/modal teardown always scrubs. No definite server rejection codes are
invented in this standalone slice; a reviewed negative-outcome contract is an
integration prerequisite if editing after such a result is desired.

After a verified receipt the component clears the draft, announces saved status
without claiming Linear/email delivery, and offers Close. Opening a new form
afterward creates a new operation only when submitted. Callback failure cannot
turn an already-verified receipt into an uncertain retry.

## Verification and remaining integration gates

Focused Node tests exercise the actual component and existing `createDialog`
through a small DOM double: semantics/labels/focus containment, local validation,
double-submit, exact immutable retry, wrong/malformed receipt, owner teardown,
ignored abort, shared-modal replacement, new submission and narrowly scoped CSS.
This does not claim native-browser geometry or assistive-technology acceptance.
The test-only DOM helper is not imported by application code.

Before mounting: align server request/receipt limits; integrate canonical EA
authority and exact session fencing; approve the route policy; add the lazy menu
lifecycle seam with all-theme/native Chromium/WebKit keyboard/geometry checks;
prove no public/Auth/Security initial or runtime feature leakage in actual built
graphs; and verify durable persistence plus real Linear/support delivery with
safe independent retry. EA duration, beta grandfathering and sender selection
remain owner decisions. Public signup, billing and provider configuration are
unchanged by this leaf.
