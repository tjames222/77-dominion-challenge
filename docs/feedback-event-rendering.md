# Feedback event rendering

`feedback_event_renderer.ts` is a pure server-side renderer. It does not read
page contents, identify the current user, authorize Early Access, send mail, or
call Linear. The durable intake/worker must supply a canonical persisted event:

```ts
{
  schemaVersion: 1,
  feedbackId, issueId, actorId, reporterEmail, submittedAt,
  cohort: 'early_access_v1',
  input: { type, description, expectedBehavior, impact, contactAllowed },
  context: { route, theme, viewport: { width, height }, buildSha, browser, platform }
}
```

Identity, verified email, cohort, and submission time are server-owned facts, not
browser claims. The renderer reuses the exact frontend input/context validators,
including text limits and private-field/attachment rejection. Extra canonical
event fields are rejected too. It does not verify database provenance itself.

`renderFeedbackLinearJob(event)` returns an immutable job for the existing fixed
team/project adapter. Original description and expected behavior remain exact
substrings inside dynamically sized code fences; neither becomes a title,
mention, link, or operational instruction. Titles use only fixed category/impact
labels. The existing **Early Access Feedback** label is always applied. Bug maps
to Bug; Feature idea to Feature; Design/UI, UX/usability and Performance to
Improvement. Other receives only the cohort label. Blocking/Frustrating/Minor/
Suggestion map to Linear priorities 1/2/3/4.

For a field of N characters, the longest backtick and tilde runs together occupy
at most N characters. Choosing the shorter safe fence means a framed block uses
at most 2N + 8 characters for N ≥ 4. Thus the 10,000 + 5,000 character text limits
need at most 30,016 framed characters, plus bounded context/headings. The reviewed
Linear description cap is 65,536 characters; its serialized create request,
including receipt marker, is independently capped at 128 KiB UTF-8 before any
lookup or dispatch. Maximum valid delimiter-heavy, Unicode, newline, quote and
ampersand fixtures fit the Linear and email bounds without altering the text.

`renderFeedbackSupportEmail(event, { from, linear })` returns a frozen
`{ from, to, subject, text, html }` message. The destination comes only from
`src/shared/support-contact.mjs` (`SUPPORT_EMAIL`). The sender is operator config;
its verified-domain status is a deployment preflight, not a renderer assertion.
There is no reply-to, CC, BCC, attachment, remote image, tracking URL, or automatic
link derived from reporter text. HTML is escaped; plaintext preserves the original.
The reporter's follow-up-contact preference is explicit in both outputs.

The `linear` snapshot is `{ state: 'pending' | 'failed' }` or
`{ state: 'delivered', issueId, issueUrl }`. Delivered requires the exact event
issue ID and a canonical HTTPS Linear issue URL without credentials, query,
fragment, or alternate host. Pending/failed snapshots contain no URL or raw
provider error. Freeze this message in the email outbox before its first dispatch;
a later Linear status change must not rewrite an email already bound to a Resend
idempotency key. A follow-up notification, if desired, is a separately approved
event—not a silent mutation of the retry body.

The shared contact constant is intentionally not wired into the Support page by
this isolated change; the integrating owner must replace that page's literal
with the shared source and verify the build. Supabase function packaging must
also include the imported shared/contact and pure frontend-contract modules.
No SMTP, public-signup, billing, provider-account, or deployment setting is changed.

Verification:

```sh
cd supabase
deno test --frozen functions/_shared/feedback_event_renderer_test.ts
```
