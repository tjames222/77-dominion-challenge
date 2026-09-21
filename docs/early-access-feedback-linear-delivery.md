# Feedback Linear delivery adapter (not connected)

`supabase/functions/_shared/feedback_linear.ts` prepares the server-only Linear
delivery part of FOU-1803. It is deliberately **not imported by a deployed Edge
Function**. There is no database intake, worker schedule, credential, or live
delivery implied by this module. The existing site and billing flags are unchanged.

## Authority and immutable input

The future worker must load a committed, immutable feedback job after claiming a
bounded lease. Never pass browser input straight to this adapter. The job's
`issueId` is a UUID v4 allocated and persisted once, separately from `feedbackId`.
The title, escaped/rendered original feedback, severity priority and existing
label IDs must also be persisted/derived deterministically before dispatch.
Only the fixed Foundation Technology team and `77-dominion-challenge` project
are allowed. No user-selected project, endpoint, credentials or callback URL is
accepted. The support-email worker is a separate delivery for the same submission.

Supply a dedicated server-side Linear API key, not an assistant/plugin OAuth
credential. The adapter does not read environment variables or require secrets
for ordinary frontend builds. Its synthetic tests have no network permission.

## Durable dispatch and uncertain outcomes

The adapter looks up the original issue ID, including archived issues, before
creating anything. A receipt must match its ID, team, project and a deterministic
payload fingerprint, with an HTTPS `linear.app` issue URL. A malformed or partial
GraphQL response is not proof of absence or success. Existing records with an
unexpected fingerprint/destination require review; they are never overwritten.

In `create` mode the caller-provided `markDispatched(signal)` **must commit a
compare-and-set under the current lease** before returning literal `true`. The
durable record must thereafter require `reconcile` mode, even if the worker
crashes before the HTTP request. A stale lease returns `false`; a lost reply,
timeout or cancellation produces an uncertain outcome and no provider mutation.
The callback must honor its abort signal where possible; late replies cannot
resume sending. Each network stage and the dispatch fence is bounded to ten
seconds; responses are size-bounded and redirects rejected.

A failed/lost create reply triggers a lookup of the original UUID. If that
cannot prove delivery, preserve the submission and mark the job uncertain.
`reconcile` mode never invokes the dispatch fence or creates another issue.
Do not reset dispatch state or generate a new UUID merely because a lookup is
temporarily empty. This conservative protocol can require operator recovery
after a crash-before-send or unavailable/deleted/moved issue; it does **not**
promise automatic exactly-once delivery under every provider failure. A future
operator redrive requires explicit evidence and an audited transition.

Only safe enum outcomes and validated receipts are returned. Provider bodies,
errors, keys and feedback text are never logged by the adapter. The worker must
settle outcomes with the original lease/attempt, and must not translate a failed
provider delivery into failure of an already committed member submission.

## Remaining integration gates

- Canonical active early-access authorization and an atomic private feedback
  intake/outbox, with exact-retry handling, rate limits and account/session fences.
- A verified existing label mapping including Early Access Feedback, a dedicated
  server key and a read-only configuration preflight against the fixed project.
- Branded text rendering that preserves original feedback without interpreting
  user content as mentions/instructions; only allowlisted technical context.
- A scheduled bounded worker, durable dispatch/reconciliation operations and
  audited recovery, exercised against a synthetic provider and local real SQL.
- The approved transactional sender and separate support-email delivery.
- One authorized end-to-end canary after review and deployment; this adapter's
  fixture tests alone do not complete FOU-1803.

The current official [Linear GraphQL guide](https://linear.app/developers/graphql)
requires checking GraphQL errors even with HTTP 200. Its
[official SDK schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
documents `IssueCreateInput.id` as an optional client-supplied UUID v4, and the
issue ID filter used for reconciliation. No undocumented idempotency header is
assumed.
