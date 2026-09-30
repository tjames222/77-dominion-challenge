# Original challenge submission evidence

This document records the approved completion rule and its unpublished release
candidate. The candidate connects canonical submitted progress to check-ins,
an atomic Finisher award, the dashboard, preview mode and versioned sharing.
Production remains on the separate admin inbox release until the protected
checks, fresh encrypted backup and full deployment succeed. Later challenge
instances and the six-reward rebalance remain separate FOU-1498 work.

## Approved rule

The original challenge requires 77 submitted check-ins, including partial
submissions. On September 30, 2026, Tim confirmed that submissions may continue
after calendar day 77 until that count is reached. Later tracks also count
submitted check-ins, including partials, against their configured target.

Calendar position and submitted count are different quantities. `challengeDay`
remains the positive calendar ordinal derived from the immutable original start
and the check-in's local date. Missed dates are neither inserted nor renumbered.
The 77th submitted partial may therefore arrive on calendar day 78 or later.

## Pure evidence contract

`src/static/original-77-submission-evidence.mjs` accepts exact plain-data
projections of an activation and its check-ins. It validates actor identity,
start/date/ordinal agreement, complete or partial status, one to seven distinct
recognized actions, unique check-in IDs/dates/ordinals, finite Gregorian dates
and PostgreSQL-compatible microsecond timestamps. Conflicting or malformed
evidence rejects the snapshot rather than silently reducing it to a qualifying
count. Review-required activations are not accepted.

Live assessment accepts at most 76 prior rows plus the actual inserted event.
Historical assessment accepts at most 77 rows. Both always return
`awardAuthorized: false` and `replayAuthorized: false`; neither authenticates a
caller, proves a complete database snapshot, changes lifecycle state or performs
an award. The server adapter must establish those properties independently.

Historical timestamps are not a commit sequence. Even an ordered, untied
`created_at` series can only provide an unverified candidate. Tied or reversed
timestamps cannot be repaired by sorting them into a fabricated earned date.
The retired `day_77_finisher` and all existing award identities remain unchanged.

## Private database foundation

The additive migration creates a private, immutable completion-event ledger and
a read-only evidence assessor. Neither has execution or table grants for public,
anonymous, authenticated, or service roles. The ledger also enforces RLS and
inherits account deletion through explicit foreign-key cascades.

The assessor examines at most 78 actor-owned rows, rejecting overflow, malformed
actions, noncanonical dates, conflicting ordinals, and mismatched event owners.
Without a persisted live event, 77 canonical submissions are reported only as
historical qualification pending provenance. The foundation alone adds no writer
or check-in trigger. The separately approved live-wiring migration adds the
trusted writer and atomic award, preserving caller checks and lock order.
Neither migration performs a historical backfill or successor activation.

## Coherent live release contract

The original challenge can be implemented before repeatable later instances,
but all of the following must agree before the live rule is enabled:

- Server activation, draft, workout and submission guards must use canonical
  submitted count, while preserving local-date validation and lock order.
- Scoring, badge facts and outbound-payload validation must accept valid
  positive calendar ordinals past 77. The compatible Edge renderer must be
  deployed before the database permits those payloads.
- The actual 77th inserted row must atomically establish one immutable
  completion event and one scoped Finisher award. Retries must not duplicate
  check-ins, points, completions, awards or celebrations.
- Dashboard, drafts, caches, mocks, badge evidence and new share snapshots must
  display submitted progress without treating elapsed day 77 as completion.
- Historical count qualification without a provable qualifying event must stay
  visibly distinct from a dated, awarded Finisher. No automatic historical
  backfill, timestamp invention or celebration replay is authorized here.
- Incomplete later-instance support must remain unavailable. This original
  completion slice must not rewrite the point economy or invent successor
  ownership. FOU-1498 separately requires its six-reward catalog and completion
  chain, preserving existing owners and grandfathered availability.

Private schema groundwork is not sufficient to enable the live feature. It
requires isolated PostgreSQL authority and concurrency tests, complete frontend
and Edge tests, production/mock browser parity, protected review, a current
backup, and a separately verified deployment.

## Current verification

The pure helper update passed 171 focused tests and the broader 1,539-test
frontend suite under Node 24.19.0. The first broad run encountered a sandbox
permission error writing Vite temporary files; the unchanged permitted rerun
passed. The helper has no production imports. The private foundation passed an
independent eight-test fixture using cached PostgreSQL 17.6.1.141 in a disposable
network-isolated container. That adversarial fixture intentionally omits some
production constraints to exercise malformed evidence; it does not prove the
full migration chain or concurrent live completion. Runtime writer and browser
completion behavior are not proved by these foundation tests.

The initial frozen local candidate passed all 1,592 frontend tests under Node
24.19.0, including the existing Vite graph checks. The 118-test focused frontend
slice also passed. Its executable submission harness checks same-user session
replacement, A-to-B-to-A switches, MFA downgrade and successful but stale
responses, which remain marked committed without returning private results.
Dashboard counts and completion displays use owner-bound submitted progress;
calendar ordinals remain separate, and completion no longer starts confetti
from a render-time date or badge inference.

Independent review then caught inconsistent capability flags that could keep
Share/participation open with invalid progress, and start-date editing after a
submission. The normalizer now closes participation for all non-in-progress
states and allows start-date editing only at count zero. Two new regressions
cover invalid, historical and live completion states, plus submitted counts
zero, one and 76. The final full frontend rerun passed 1,594/1,594 tests:
`/private/tmp/77dc-original77-frontend-final-review-root.log`.
Completion copy now points to the actual Rewards page instead of claiming that
badges and rewards appear below the Dashboard.

Independent final review passed 64 focused tests and found no further blocker
in these frontend paths. One recoverable behavior remains: a challenge-track
unlock crossed on submission77 is claimed and celebrated when the member visits
Rewards, rather than immediately on Dashboard; ownership is preserved.

The existing compiled and real-SDK hybrid preview-badge browser suite passed
70/70 tests across Chromium and WebKit. It covers session replacement, account
switches, duplicate submissions, claims/acknowledgements, replay refusal, native
storage failures and public-entry isolation. Explicit new cases reject a
not-started challenge and an active owner without membership without writing
badge state. The test fixtures now establish only their synthetic owner's
membership and activate the synthetic challenge through the existing mock API;
the temporary fixture date is restored in a finally block. Production guards
were not relaxed to accommodate the fixtures.

The original run had 18 missing-activation failures, and the activation-only
fixture correction then had 64 missing-membership setup failures. Both logs and
traces remain preserved. Final log:
`/private/tmp/77dc-original77-preview-badges-member.log`; results:
`/private/tmp/77dc-original77-preview-badges-member-results`.
This existing suite is not a new visual or live-server acceptance test of the
77th-submission Dashboard flow.

Badge/evidence tests passed 195/195. The draft preview reducer records a new
77th submission, immutable completion event and scoped award together, while
historical rows alone cannot manufacture an event or replay an award. Only
facts produced by the preview adapter match the new Finisher catalog entry;
copied or generic client facts cannot. This preview integrity check is not
server authorization.

The compatible Edge drafts passed type checking and all 510 Edge tests,
including 24 focused renderer/share tests. They accept bounded positive
calendar ordinals and a strict V2 submitted-count share payload while leaving
stored V1 share interpretation unchanged. No Edge draft was deployed.

Root logs are `/private/tmp/77dc-original77-frontend-frozen-root.log`,
`/private/tmp/77dc-finisher-badge-evidence-root.log`,
`/private/tmp/77dc-finisher-edge-check-root.log`, and
`/private/tmp/77dc-finisher-edge-all-root.log`.

## Database approval and current release evidence

On September 30, 2026, Tim explicitly approved the described activation, draft,
workout and check-in replacements, private completion and award helpers,
77-submission limit, atomic Finisher event and badge, and temporary closure of
the old later-challenge Start API. This supersedes the earlier managed-review
pause; both generated migration files now contain reviewed implementations.
Existing data, points, rewards and access are preserved. No reset, historical
award backfill or billing change is part of this release.

All 70 application migrations replay unchanged, with each history row in the
same transaction, in an owned network-isolated PostgreSQL 17.6 fixture. The
application owner is NOSUPERUSER postgres. Provider tables are structural
dependencies only; this does not replace native Auth or Storage service tests.
The normal local Supabase stack could not initialize because Docker's persistent
disk was full. No unrelated container or volume was removed. Required native
CI, advisors, SQL lint, RPC tests and schema-drift checks remain enabled.

The compiled original-challenge browser suite passes 12 tests across desktop
Chromium and mobile WebKit. It covers a partial 77th submission on calendar
day 78, duplicate clicks, reload, historical qualification without an invented
award, committed-response recovery, stale dashboard reads, pagehide cleanup,
same-user session replacement and count-based share preview. All actors and
network responses are local fixtures. The existing app-streak suite passes 18
regressions, and the unchanged share pgTAP runs all 43 assertions against the
actual 70-migration chain. Screenshots show the completed dashboard on desktop
and mobile after the reward receipt is dismissed.

Independent native verification passes 34 source-fixed catalog tests and five
exact67 backup archive tests. The real application RPC suite passes five tests,
including explicit overlapping-session evidence: PostgreSQL reports the second
session blocked by the exact first backend before the test releases its gate.
Two 77th submissions create only one point event, completion and Finisher award;
app-visit versus submission succeeds in both lock interleavings. The returned
canonical event must exactly equal persisted provenance. Review restored the mature draft ownership
check and response fields, and the existing synthetic outbound-event branch.
The production catalog verifier pins the frozen migration bodies and rejects
definition, owner, ACL, constraint, trigger, RLS, badge or sharing drift.

Current root logs include `/private/tmp/77dc-original77-browser-session-recovery-root.log`,
`/private/tmp/77dc-original77-appstreak-regression-root.log`,
`/private/tmp/77dc-original77-share-fullchain-corrected-root.log` and
`/private/tmp/77dc-original77-independent-final-native-root.log`.

Tim also approved a fresh free encrypted backup using the three existing worker
secrets for verification, without reading private backup or envelope keys. The
current hosted checkpoint has 67 migrations. Its new `post-admin-inbox-67`
capture mode must run and be independently verified before the 67-to-70 release;
the retained exact66 artifact is not a current-database backup. Compatible Edge
readers deploy before migrations, both catalog receipts must pass, and only
then may the new frontend publish. No production completion is claimed by this
local evidence.
