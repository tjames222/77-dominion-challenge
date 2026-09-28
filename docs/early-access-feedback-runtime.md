# Early-access feedback runtime

## Production checkpoint — September 28, 2026

[Production release 36382374620](https://github.com/tjames222/77-dominion-challenge/actions/runs/36382374620)
deployed this runtime from main `0211bd537de765078355076104da0ae9b9a807e2` to the
existing Supabase and Cloudflare projects. Exact migration/function state,
private queue permissions, scheduled worker health, and canonical public assets
were verified. The dedicated Linear destination metadata check and Resend SMTP
authentication passed. Resend accepted the one approved owner test email.

A real Early Access feedback submission has not yet demonstrated Linear issue
creation and support-email receipt. The ticket remains In Progress pending that
authorized end-to-end check; a healthy worker or stored credential is not proof
of downstream delivery. Billing and public signup remain disabled. The earlier
candidate notes below describe implementation and test boundaries, not a claim
that the runtime is still undeployed.

## Runtime boundaries

This runtime connects the reviewed feedback contracts to an owner-bound browser
client, private SQL intake, durable Linear/email delivery records, and a bounded
Edge worker. The separate approval/invitation flow is documented in
`early-access-invitation-runtime.md`. Implementation or local testing does not
enroll a real member, enable billing, launch beta, or prove provider delivery.
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

The September 28 release completed verified Resend account/domain setup without
altering incoming support forwarding, key preflight, approved worker scheduling
and secret provisioning, and schema/pgTAP/browser/release checks. Remaining live
acceptance checks are invitation acceptance and the authorized end-to-end
feedback canary, including downstream delivery confirmation. The browser
access-state reader and server membership consumers are now integrated
by `20260927025530_integrate_early_access_membership.sql`; see
`early-access-member-authority.md` for the preserved contracts and race tests.
No migration resets or mutates production during local testing.

## Focused verification

The SQL tests create a new labelled, network-none, no-volume/no-port tmpfs
PostgreSQL container using the already-cached pinned 17.6.1.141 image. Only that
owned container is removed afterward. They do not reset an existing local stack.

```sh
pnpm run test:early-access-member-sql
pnpm run test:early-access-membership-sql
pnpm run test:early-access-feedback-sql
pnpm run test:frontend
pnpm run check:functions
pnpm run test:functions
```

Focused tests are not a substitute for full schema replay, the production
provider configuration, or actual deployment evidence.

Local checkpoint results: 18 member-authority SQL cases, 23 feedback SQL cases
(including 63 pgTAP security assertions), 17 membership-consumer SQL cases
(including 234 existing pgTAP assertions), 305 Edge Function tests, 1,116 frontend
unit tests and 28 native feedback cases pass. The native cases cover Chromium
desktop, WebKit phone, tablet sizing, all four themes, fourteen-route placement,
owner/session changes, uncertain retries, canonical EA billing/profile state
without Stripe calls, and private-context exclusion. Visual
review caught and fixed a consent-checkbox label overflow; explicit inner-form
geometry assertions now protect it. Tests use synthetic local provider replies,
not a live Linear or Resend account. Fourteen repeated WebKit focus/geometry and
EA-state checks also pass. Dialog close restores geometry before returning
focus, with owner/reopen/destroy guards for the deferred restoration.
The existing MFA (44), Daily Actions (66), and Admin (148) native regression
cases also pass against the updated self-only access fixture.

A paired feedback-integration graph comparison leaves initial request counts
and exact ordered CSS unchanged on all 28 entries in both main and develop
modes. It is not a full pristine-base comparison: only API/menu sources were
replaced with their prior versions. The existing performance checker remains
red under unchanged legacy budgets, as already documented in
`frontend-performance.md`; no threshold or visual baseline was relaxed. Full
canonical schema replay and the complete release browser matrix passed for
commit `21faa1f87763c13a7ab394e10f6921611aac9386` in PR #141. They must be rerun
for the newer membership-consumer migration; the earlier green result is not
evidence for a changed candidate or a production deployment.

### September 27 invitation integration

The current candidate also contains the separate invitation lifecycle and
NEW-account setup flow described in `early-access-invitation-runtime.md` and
`early-access-account-bootstrap.md`. Production provisioning now has explicit
closed-Auth, dedicated Linear metadata, Resend SMTP credential, independent
runtime-secret, service-only scheduler and unauthorized-worker smoke gates.
Native SMTP setup authenticates without sending; provider email acceptance and
inbox delivery remain separate evidence. The optional owner test email is
manual, default-off, fixed-recipient and bound to one approved time window.

New local verification includes 506 Edge tests, 75 native SQL cases across
intake/invitations/bootstrap/scheduling, and unchanged canonical mock frontend
performance budgets passing. These supersede the older local counts and
performance result above, but do not supersede the requirement for current-head
CI, full native Auth integration, hosted provider verification and release.
