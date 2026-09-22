# Early-access feedback runtime — release candidate, not deployed

This slice connects the reviewed feedback contracts to an owner-bound browser
client, private SQL intake, durable Linear/email delivery records, and a bounded
Edge worker. It does **not** complete the separate approval/invitation flow,
enroll any real member, enable billing, launch beta, or establish provider keys.
FOU-1742 and FOU-1803 must remain In Progress until their full acceptance criteria
and the production canary have been verified.

## Persistence and authorization

`submit_early_access_feedback(expected actor, operation ID, input, context)` is
an authenticated RPC. It uses the current verified account/session/MFA and
existing allowed-Origin configuration; private input is not exposed to anon,
other members, or arbitrary service-role table queries. It validates the same
strict fields and UTF-16 bounds as the browser, and rejects attachments and
unknown context fields. The reporter email, cohort and timestamp come from the
server. No page contents, raw URLs, raw user agents, journal entries or tokens
are collected automatically.

An actor-scoped lock serializes idempotency and rate limits. Live Auth/session
and early-access authority are rechecked after blocking waits. New submissions
require active early access and are limited to five per minute and fifty per
rolling 24 hours. The original input, safe context, one fixed Linear issue UUID,
and two provider jobs commit before the exact saved receipt is returned.

The same actor/operation and identical input/context retrieve the same receipt,
even if early access subsequently ends. Changed-payload reuse is a conflict;
session/identity validation still applies to receipt retries. Deleting the Auth
account removes its private feedback and jobs through foreign-key cascades.

## Delivery

`process-early-access-feedback` accepts POST only and requires the dedicated
`x-dominion-worker-key`. It processes at most one Linear job and one support-email
job per invocation. Provider destinations are fixed; request bodies cannot pick
recipients, issue projects, delivery IDs, redrives or message contents.

Each worker must claim a two-minute lease, persist an immutable rendered payload
and fingerprint, and commit the dispatch fence before calling a provider. Linear
uses its original issue UUID and reconciles after a possible send; it does not
blindly create another issue after an uncertain response. Resend uses one fixed
idempotency key and exact message within a conservative 23-hour retry window.
The first dispatch time never resets. An accepted Resend receipt is provider
acceptance, not a guarantee that an inbox received the message.

Retries retain the saved submission. After twelve claims, an expired uncertain
email window, or an invalid binding/receipt, the job requires operator review.
No automatic operator redrive or unsafe reset is supplied. A crash after the
Linear dispatch fence but before its HTTP request can also require review;
this protocol does not promise impossible exactly-once delivery for all faults.

The shared private email reservation helper permits at most 90 new deliveries
per rolling 24 hours and 2,900 per rolling 31 days. It reserves once per durable
delivery and rechecks lease/window after quota-lock waits. These conservative
limits are for the approved free plan; no paid-plan upgrade is automated.

Support notifications use `src/shared/support-contact.mjs`, also consumed by
the Support page. A notification links the verified Linear issue if available
when its body is frozen; otherwise it explicitly states pending/failed. It is
not re-rendered or sent a second time merely because Linear later succeeds.

## Required production configuration

Server-only secrets:

- `LINEAR_FEEDBACK_API_KEY`: dedicated Read + Create issues access, restricted to
  Foundation Technology. Never reuse an assistant/plugin credential.
- `RESEND_API_KEY`: restricted transactional send key for the verified sender.
- `TRANSACTIONAL_EMAIL_FROM`: verified Dominion sender mailbox/display address.
- `FEEDBACK_WORKER_SECRET`: independent high-entropy scheduled-worker credential.

Linear team `f61599d3-1342-430f-855e-2d3bc574a94b` and project
`d9c1d9b7-b35b-4da5-9a9e-be384e06bd2b` are fixed. The existing Bug, Feature and
Improvement taxonomy is reused. The Early Access Feedback label is
`ffbc76e4-a42e-475d-b31d-963fe3100de5`.

Remaining release gates include verified Resend account/domain setup without
altering incoming support forwarding, least-privilege key preflight, approved
worker scheduling and secret provisioning, full schema/pgTAP/browser/release
checks, invitation/entitlement integration, and an authorized end-to-end canary.
No migration resets or mutates production during local testing.

## Focused verification

The SQL tests create a new labelled, network-none, no-volume/no-port tmpfs
PostgreSQL container using the already-cached pinned 17.6.1.141 image. Only that
owned container is removed afterward. They do not reset an existing local stack.

```sh
pnpm run test:early-access-member-sql
pnpm run test:early-access-feedback-sql
pnpm run test:frontend
pnpm run check:functions
pnpm run test:functions
```

Focused tests are not a substitute for full schema replay, the production
provider configuration, or actual deployment evidence.

Local checkpoint results: 18 member-authority SQL cases, 23 feedback SQL cases
(including 63 pgTAP security assertions), 305 Edge Function tests, 1,096 frontend
unit tests and 26 native feedback cases pass. The native cases cover Chromium
desktop, WebKit phone, tablet sizing, all four themes, fourteen-route placement,
owner/session changes, uncertain retries and private-context exclusion. Visual
review caught and fixed a consent-checkbox label overflow; explicit inner-form
geometry assertions now protect it. Tests use synthetic local provider replies,
not a live Linear or Resend account.

A paired feedback-integration graph comparison leaves initial request counts
and exact ordered CSS unchanged on all 28 entries in both main and develop
modes. It is not a full pristine-base comparison: only API/menu sources were
replaced with their prior versions. The existing performance checker remains
red under unchanged legacy budgets, as already documented in
`frontend-performance.md`; no threshold or visual baseline was relaxed. Full
canonical schema replay and the complete release browser matrix remain pending.
