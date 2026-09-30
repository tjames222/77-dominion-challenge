# Original challenge submission evidence

This document records the approved completion rule and the boundaries of its
implementation. The pure helper and private database foundation do not change
live check-in limits, grant a Finisher badge, or unlock another challenge.

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
an award. A future server adapter must establish those properties independently.

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
historical qualification pending provenance. There is no writer, trigger on
check-ins, historical backfill, award, outbound event, or successor activation.
The assessor is not an authentication boundary: a future trusted writer must
independently establish the caller, session, insertion context, and lock order.

## Coherent live implementation still required

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
completion behavior remain unimplemented and are not claimed by these tests.
