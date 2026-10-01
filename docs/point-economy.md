# Dominion point economy contract

Status: **FOU-1498 V2 local release candidate; not yet deployed.** This document
describes the implementation on the repeatable-challenge feature branch, not the
current production reward curve. The earlier original77 completion prerequisite
has shipped; that does not establish deployment of the six-reward rebalance or
UUID repeatable runs. See the release boundary below.

## Point sources stay unchanged

1. A completed Daily Action (the internal `daily_standard` policy) is worth one point.
2. A submitted Check-In awards between one and seven Daily Action points. A user
   can submit only one scored Check-In per authoritative local date, across all runs.
3. Workout difficulty, app visits, streak milestones and completion status do not
   add points. Badges and app-streak tracking remain separate.
4. The Sharing Bonus is 14 points once per user, outside the seven-point daily cap.
5. Levels are display-only: `floor(lifetimePoints / 14) + 1`. A level never grants a reward.
6. A catalog change does not subtract historical points or revoke a recorded grant.

| Source | Amount | Frequency | Lifetime total | Daily Action cap |
| --- | ---: | --- | --- | --- |
| Submitted Daily Action | 1 | Up to seven in the user's one daily Check-In | Included | Included |
| Sharing Bonus | 14 | Once per user | Included | Excluded |
| App visit or streak milestone | 0 | Independent tracking/badges | No new points | Excluded |
| Workout difficulty or Check-In status | 0 | Descriptive/achievement only | No new points | Excluded |
| Administrative correction | Explicit audited delta | Exceptional | Included | Excluded |

The existing immutable `game_point_events` ledger and cached
`user_game_stats.total_points` remain authoritative. Daily Action scoring is
recorded by the existing `check_in` event type with action/source metadata; the
client policy label is not a new database event type. Old bonus events retain
their original amounts but are not reissued by the V2 scoring path.

## Six point-gated core rewards

The checked-in configuration is
`src/static/reward-progression-catalog.v2.json`; the reviewed migration mirrors
its rule, phase and order in the database. Consumers use the actor-bound catalog
response, not a page-specific threshold list.

| Order | Reward | Requirement | Perfect submitted Check-In without Sharing | With the one-time Sharing Bonus |
| --- | --- | --- | ---: | ---: |
| 1 | Gym Training Discount | 42 trusted Daily Action points | 6 | 6 |
| 2 | Dominion Night theme | 112 lifetime points | 16 | 14 |
| 3 | Nehemiah Leadership Handbook | 210 lifetime points | 30 | 28 |
| 4 | Dominion Platinum theme | 308 lifetime points | 44 | 42 |
| 5 | 7-Day Reset | 420 lifetime points | 60 | 58 |
| 6 | Big God Energy T-Shirt Discount | 532 lifetime points | 76 | 74 |

The Gym reward counts only trusted Check-In action points, capped at seven per
source event. Sharing and administrative adjustments cannot unlock it. The
remaining five core rewards use lifetime points. The shirt reward is independent
of Reset completion; Platinum precedes Reset.

A perfect original run awards `77 × 7 = 539` points, so all six core rewards are
reachable without sharing. Four actions on each of 77 submissions award 308
points and reach the first four core rewards. Completing the run below 420 points
does not strand the user: they may explicitly start another original run and
continue earning lifetime points. Sharing alone unlocks nothing.

## Completion-gated tracks

| Track | Submitted Check-Ins to finish | New-grant requirement |
| --- | ---: | --- |
| 7-Day Reset | 7 | 420 lifetime points |
| 21-Day Prayer Track | 21 | Complete 7-Day Reset |
| 30-Day Strength Intensive | 30 | Complete 21-Day Prayer Track |
| 40-Day Fasting & Prayer Track | 40 | Complete 30-Day Strength Intensive |
| Bible in a Year | 365 | Complete 40-Day Fasting & Prayer Track |

The four post-core tracks have **no point threshold**. A large balance, sharing,
an adjustment, starting a prerequisite, or an incomplete run cannot satisfy a
completion rule. A canonical completion persists its immediate successor's
availability atomically and idempotently; availability is not itself completion
and cannot cascade through the chain. Explicitly preserved legacy completion
records can satisfy their corresponding prerequisite without inventing a new
completion event or badge.

Reset can become available during the original run, but cannot start until the
open run finishes. Existing grandfathered later-track grants remain usable even
when the new rule would not have granted them today. All Starts remain subject
to server access checks and the one-open-run rule.

## Runs, dates and completion

- The original target is **77 submitted Check-Ins**, including partial submissions.
  Later tracks use the target in the table above, also counting partials.
- Missed dates do not end a run. `calendarDay` is elapsed local-calendar position,
  not submitted count; it may exceed the target. There is no automatic day77 expiry.
- A user has at most one `scheduled` or `active` instance. A future scheduled run
  also occupies that slot; no overlapping Start is allowed.
- After completion, an explicit Start creates a fresh UUID instance for an
  available track or another original run. No run auto-starts. The candidate's
  repeat/later-track Start creates a solo run for today or a future date.
- Each run keeps its own drafts, source Check-Ins, submitted count, completion
  record and scoped badge/streak history. Lifetime points, permanent ownership,
  earlier completed runs and acknowledged celebrations remain intact.
- The `(user, local date)` submission barrier stays global. Completing a run and
  starting another on the same date does not allow another scored Check-In that
  date. Per-run calendar ordinals permit the next run's day1 without colliding
  with an earlier run's day1.
- The final canonical submission, point event, completion record and applicable
  award/successor grant commit together. The new original-run Finisher is tied to
  that run's actual completion event, not to a points total or calendar position.
- Writes capture actor, current instance and the required version/revision.
  An old page for the same account cannot write into a newly started run.

## Preservation and preview parity

Preserve immutable source events and their IDs, amounts, dates and earned times.
Keep explicit `owned`, `available`, `active` and `completed` reward grants and
their seen timestamps. Snapshot the prior catalog version/reason for support;
raising a threshold changes locked progress, not recorded ownership. Do not
reconstruct grants from the retired point curve or mark a legacy completed
record as a new canonical event. This release does not authorize historical
badge backfill, invented Finisher times or replayed migration celebrations.

The local preview uses the same rule configuration and V2 response shape. Its
actor-scoped aggregate commits run, scoring, badge and grant changes together;
no-op reads must not rewrite storage. Preview data is not production authority.
See [reward-catalog-contract.md](reward-catalog-contract.md) for configuration,
pagination, lifecycle and Start details.

## Release invariants and boundary

- Test one-below/exact/one-above for 42/112/210/308/420/532, including 41/42 trusted
  Gym points with sharing/adjustments excluded.
- Test perfect, perfect-plus-sharing, four-action and irregular submission runs;
  only six rewards are point-granted, regardless of a large balance.
- Test each immediate successor, skipped prerequisites, preserved grants,
  repeated runs, partial final submissions and missed dates beyond the target.
- Retry/concurrent tabs/devices must not duplicate a Check-In, points, completion,
  Finisher, successor grant or Start; an uncertain Start retains its request UUID.
- Actor/run/CAS fences, global daily uniqueness, RLS/privileges and canonical
  source links must hold independently of browser hints.
- Dashboard, Rewards, Profile, celebrations, direct refresh and preview must
  agree on the same typed requirements, order, ownership and allowed actions.
- Configuration insertion/reordering/chain-extension tests must not require
  route-specific grant logic. Preserve fulfillment authorization and theme gates.

The reviewed historical-instance binding/activation integration and generic
public-share SQL are included in the candidate with preservation, race, privacy,
and rollback tests. Their presence locally does not prove hosted migration or
release. Before production, take and verify the approved current backup,
run the release gates, deploy compatible Edge readers before the database and
the database before the V2 frontend, then verify the deployed contracts. No
database reset, project switch, billing activation or historical award backfill
is part of this contract.
