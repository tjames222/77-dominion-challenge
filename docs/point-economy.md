# Dominion point economy contract

Status: launch contract after the FOU-846 progression rebalance. The database,
reward catalog, and user interface use the same thresholds.

## Principles

1. A Daily Standard is worth exactly one point.
2. A challenge day contains seven Daily Standards, so the Daily Standards award is capped at seven points per active challenge day.
3. Workout difficulty describes the work performed. It never changes points.
4. App visits and streak milestones are engagement and achievement signals, not point sources.
5. The Sharing Bonus is a one-time lifetime bonus. It is deliberately outside the seven-point Daily Standards cap.
6. Earned lifetime points and permanent entitlements are never reduced by a later catalog or threshold change.
7. Levels are a display-only rhythm: a member enters a new level every 14 lifetime points. Reward ownership remains point-based and independent from the level number.

## Authoritative point sources

| Source | Amount | Frequency | Counts toward lifetime total | Counts toward the seven-point Daily Standards cap |
| --- | ---: | --- | --- | --- |
| Daily Standard completion | 1 | Up to seven per active challenge day | Yes | Yes |
| Sharing Bonus | 14 | Once per user | Yes | No |
| App visit | 0 | Daily tracking continues | No | No |
| App-streak milestone | 0 | Badges and display continue | No | No |
| Full-standard-streak milestone | 0 | Badges and display continue | No | No |
| Workout difficulty | 0 | Selection remains descriptive | No | No |
| Administrative correction | Explicit signed delta | Exceptional, audited | Yes | No |

The backend ledger must use distinct source keys for `daily_standard`, `sharing_bonus`, and `admin_adjustment`. Retired `app_visit`, `full_day_streak_bonus`, status-bonus, and workout-difficulty events remain historical records but cannot be created after cutover.

## Challenge cycles and reachability

The original Dominion challenge is one 77-day challenge instance. A perfect instance awards `77 × 7 = 539` Daily Standards points. The one-time Sharing Bonus can raise the user's lifetime total by 14 points, but no reward may require sharing.

After a challenge instance is completed, the user may start any available challenge definition. A completed definition may be started again as a new challenge instance. Each instance has its own dates, drafts, Check-Ins, completion state, and streak context; lifetime points and permanent rewards carry forward. Only one challenge instance may be active for a user at a time.

Levels and rewards intentionally move at different speeds. A perfect participant
levels up every two days, while reward gaps expand through the challenge. Every
reward threshold lands exactly on a level boundary, but eligibility is evaluated
from lifetime points rather than from the displayed level:

| Reward | Lifetime points | Level entered | Perfect day without Sharing | Perfect day with the one-time Sharing Bonus |
| --- | ---: | ---: | ---: | ---: |
| Dominion Night theme | 56 | 5 | 8 | 6 |
| 7-Day Reset | 126 | 10 | 18 | 16 |
| 21-Day Prayer Track | 210 | 16 | 30 | 28 |
| 30-Day Strength Intensive | 308 | 23 | 44 | 42 |
| 40-Day Fasting & Prayer Track | 420 | 31 | 60 | 58 |
| Bible in a Year | 532 | 39 | 76 | 74 |

The Sharing Bonus accelerates these dates but is never required. A consistent
four-standard day reaches the first reward on day 14 and four rewards by day 77;
sharing alone unlocks nothing. Repeatable challenge instances remain the
long-term earning path after launch rewards have been earned.

## Totals and consumers

`lifetime_points` is the sum of immutable ledger events and drives reward eligibility, next-unlock progress, goals, and lifetime leaderboards. Daily views display only Daily Standards points earned for that challenge day. Streak counters and badges are calculated independently from points.

Group leaderboards use lifetime points by default. A future time-boxed leaderboard must aggregate ledger events within its documented period rather than rewriting lifetime totals.

## Migration policy

* Preserve all historical point events and the lifetime total already shown to a user.
* Stop issuing retired event types at the deployment cutover; do not subtract their historical value.
* Backfill a source classification for legacy events without changing their amount.
* Reconcile permanent reward ownership before changing thresholds. An already-owned reward stays owned.
* Recalculate locked progress from the preserved lifetime total and current catalog.
* Record future corrections as audited adjustment events; never edit an awarded ledger row in place.

## Release invariants

* A Check-In can add at most seven `daily_standard` points.
* Repeating a request cannot duplicate a ledger event.
* A share can grant at most one 14-point bonus per user.
* App visits, streaks, statuses, and workout difficulty cannot add points.
* Every active point reward is reachable through repeatable challenge instances.
* Every active point reward requires at least 56 points and aligns to a 14-point level boundary.
* The launch reward thresholds are 56, 126, 210, 308, 420, and 532 points.

The server/client shape that exposes these thresholds, lifecycle states, and
permanent ownership is documented in [reward-catalog-contract.md](reward-catalog-contract.md).
