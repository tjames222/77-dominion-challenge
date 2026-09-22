# Feedback Linear delivery adapter (release candidate, not deployed)

`supabase/functions/_shared/feedback_linear.ts` prepares the server-only Linear
delivery part of FOU-1803. The candidate `process-early-access-feedback` worker
now imports it after durable SQL intake and job leasing. Neither worker nor
intake is deployed, and no production schedule, provider credential or live
delivery is implied. See `early-access-feedback-runtime.md` for the integrated
candidate and its remaining gates. The existing site and billing flags are unchanged.

## Authority and immutable input

The worker must load a committed, immutable feedback job after claiming a
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

Descriptions are limited to 65,536 characters so safe dynamic code fences can
preserve maximum-length valid feedback without truncation. The complete serialized
create request, including its receipt marker, is capped at 128 KiB UTF-8 before
lookup or dispatch. Responses retain their independent 128 KiB limit.

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

- Complete the invitation/acceptance and app-access integration that establishes
  actual early-access membership; focused private-authority/intake tests are
  not a full enrollment or full-schema release proof.
- The renderer uses the verified existing type labels and the created Early
  Access Feedback label. Provision a dedicated server key and perform the
  read-only configuration preflight against the fixed project before deployment.
- Provision the approved free transactional sender and worker secrets, then
  schedule the bounded worker. Local real-SQL and synthetic-provider tests cover
  the candidate's durable dispatch and separate support-email delivery, not live
  provider acceptance or inbox delivery. Audited operator redrive is not supplied.
- One authorized end-to-end canary after review and deployment; this adapter's
  fixture tests alone do not complete FOU-1803.

The current official [Linear GraphQL guide](https://linear.app/developers/graphql)
requires checking GraphQL errors even with HTTP 200. Its
[official SDK schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
documents `IssueCreateInput.id` as an optional client-supplied UUID v4, and the
issue ID filter used for reconciliation. No undocumented idempotency header is
assumed.
