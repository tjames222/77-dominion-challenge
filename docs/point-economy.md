# Dominion point economy contract

Status: approved target model for FOU-549. The database and user-interface cutover is implemented by the dependent scoring and rewards tickets.

## Principles

1. A Daily Standard is worth exactly one point.
2. A challenge day contains seven Daily Standards, so the Daily Standards award is capped at seven points per active challenge day.
3. Workout difficulty describes the work performed. It never changes points.
4. App visits and streak milestones are engagement and achievement signals, not point sources.
5. The Sharing Bonus is a one-time lifetime bonus. It is deliberately outside the seven-point Daily Standards cap.
6. Earned lifetime points and permanent entitlements are never reduced by a later catalog or threshold change.

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

Repeatable challenge instances are the long-term earning path. Existing challenge thresholds remain reachable without inflating a single day's award:

| Lifetime threshold | Perfect 77-day instances required without sharing |
| ---: | ---: |
| Alternate dark theme — 500 | 1 |
| 7-Day Reset — 1,000 | 2 |
| 21-Day Prayer Track — 3,000 | 6 |
| 30-Day Strength Intensive — 4,500 | 9 |
| 40-Day Fasting & Prayer Track — 6,000 | 12 |
| Bible in a Year — 10,000 | 19 |

The alternate dark theme is intentionally the least-expensive point reward. Catalog code must reject a new active reward below 500 points unless the product contract is deliberately revised.

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
* No active point reward is cheaper than the 500-point alternate theme.
