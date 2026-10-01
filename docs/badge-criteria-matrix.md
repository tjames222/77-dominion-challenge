# Canonical badge matrix v1 (FOU-1499)

This matrix audits all 31 pre-cutover keys. Eight submitted-check-in milestones
and one completion definition use new keys because their meanings differ
from calendar-position awards. Active perfect-streak crossings are 3, 7, 14, 28,
56 and 70 consecutive local dates; retired intermediate weeks reduce repetition.
The four explicitly chosen workout difficulties remain one-time action wins.
Existing awards and their original definition snapshots are never removed.
The original77 canonical completion prerequisite shipped in the prior release.
The FOU-1498 V2 UUID/repeatable-run integration described below is implemented
in migration **20261001001245**. Production availability requires its current
backup, protected checks, guarded cutover and matching frontend deployment;
consult production release workflow evidence rather than this matrix for status.

`src/static/badge-catalog.v1.json` is the checked-in source consumed by preview
and mirrored by the current SQL definitions. The historical fixture verifies the
immutable seed with only the explicit later Finisher activation and 14 per-run
copy corrections reversed. Current participation and perfect-streak requirements
say “one challenge run”; they apply to original and later runs. Existing earned
definition snapshots retain their original wording. The typed SQL and JavaScript evaluators are checked
against the same one-before/exact/one-after cases; no criterion executes code.

| Key | Name | State | Source / exact rule | Scope | Tier | Order | Migration treatment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| faithful_start | Faithful Start | active | check_in: check_in_count = 1 | lifetime | bronze | 10 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| honest_partial | Honest Check-In | active | check_in: partial_count = 1 | lifetime | bronze | 20 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| iron_standard | Seven for Seven | active | check_in: perfect_count = 1 | lifetime | bronze | 30 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| first_sweat | Easy Workout | active | check_in: workout = easy | lifetime | bronze | 40 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| steady_grind | Medium Workout | active | check_in: workout = medium | lifetime | bronze | 50 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| hard_path | Hard Workout | active | check_in: workout = hard | lifetime | silver | 60 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| extreme_fire | Extreme Workout | active | check_in: workout = extreme | lifetime | gold | 70 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| streak_flame | 3-Day Perfect Streak | active | check_in: perfect_streak = 3 | challenge_instance | bronze | 80 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| seven_sealed | 7-Day Perfect Streak | active | check_in: perfect_streak = 7 | challenge_instance | silver | 90 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| full_streak_14 | 14-Day Perfect Streak | active | check_in: perfect_streak = 14 | challenge_instance | silver | 100 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| full_streak_28 | 28-Day Perfect Streak | active | check_in: perfect_streak = 28 | challenge_instance | silver | 110 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| full_streak_56 | 56-Day Perfect Streak | active | check_in: perfect_streak = 56 | challenge_instance | gold | 120 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| full_streak_70 | 70-Day Perfect Streak | active | check_in: perfect_streak = 70 | challenge_instance | gold | 130 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| check_ins_7 | 7 Check-Ins | active | check_in: instance_check_in_count = 7 | challenge_instance | bronze | 140 | New key: submitted participation is not elapsed calendar position. |
| check_ins_14 | 14 Check-Ins | active | check_in: instance_check_in_count = 14 | challenge_instance | silver | 150 | New key: submitted participation is not elapsed calendar position. |
| check_ins_21 | 21 Check-Ins | active | check_in: instance_check_in_count = 21 | challenge_instance | silver | 160 | New key: submitted participation is not elapsed calendar position. |
| check_ins_26 | 26 Check-Ins | active | check_in: instance_check_in_count = 26 | challenge_instance | silver | 170 | New key: submitted participation is not elapsed calendar position. |
| check_ins_39 | 39 Check-Ins | active | check_in: instance_check_in_count = 39 | challenge_instance | silver | 180 | New key: submitted participation is not elapsed calendar position. |
| check_ins_50 | 50 Check-Ins | active | check_in: instance_check_in_count = 50 | challenge_instance | gold | 190 | New key: submitted participation is not elapsed calendar position. |
| check_ins_60 | 60 Check-Ins | active | check_in: instance_check_in_count = 60 | challenge_instance | gold | 200 | New key: submitted participation is not elapsed calendar position. |
| check_ins_70 | 70 Check-Ins | active | check_in: instance_check_in_count = 70 | challenge_instance | gold | 210 | New key: submitted participation is not elapsed calendar position. |
| morning_watch | 3-Day App Streak | active | app_visit: app_streak = 3 | lifetime | bronze | 220 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| watchman_week | 7-Day App Streak | active | app_visit: app_streak = 7 | lifetime | silver | 230 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| sharing | Sharing | active | share: verified_share = 1 | lifetime | bronze | 240 | Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule. |
| seven_day_start | Seven Days Complete | retired | none: retired = not earnable | lifetime | gold | 1024 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| two_week_guard | Two Weeks Complete | retired | none: retired = not earnable | lifetime | gold | 1025 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| three_week_wall | Three Weeks Complete | retired | none: retired = not earnable | lifetime | gold | 1026 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| third_way | One-Third Complete | retired | none: retired = not earnable | lifetime | gold | 1027 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| deep_roots | Day 33 | retired | none: retired = not earnable | lifetime | gold | 1028 | Retired redundant calendar milestone. |
| halfway_fire | Halfway | retired | none: retired = not earnable | lifetime | gold | 1029 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| fifty_faithful | Day 50 | retired | none: retired = not earnable | lifetime | gold | 1030 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| sixty_strong | Day 60 | retired | none: retired = not earnable | lifetime | gold | 1031 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| final_watch | Final Week | retired | none: retired = not earnable | lifetime | gold | 1032 | Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge. |
| full_streak_21 | 21-Day Perfect Streak | retired | none: retired = not earnable | lifetime | gold | 1033 | Retired dense weekly streak cadence; existing awards retained. |
| full_streak_35 | 35-Day Perfect Streak | retired | none: retired = not earnable | lifetime | gold | 1034 | Retired dense weekly streak cadence; existing awards retained. |
| full_streak_42 | 42-Day Perfect Streak | retired | none: retired = not earnable | lifetime | gold | 1035 | Retired dense weekly streak cadence; existing awards retained. |
| full_streak_49 | 49-Day Perfect Streak | retired | none: retired = not earnable | lifetime | gold | 1036 | Retired dense weekly streak cadence; existing awards retained. |
| full_streak_63 | 63-Day Perfect Streak | retired | none: retired = not earnable | lifetime | gold | 1037 | Retired dense weekly streak cadence; existing awards retained. |
| day_77_finisher | 77 Days Complete | retired | none: retired = not earnable | lifetime | gold | 1038 | Elapsed-day rule retired; new Finishers use canonical original_77_completed events. |
| original_77_completed | 77-Day Finisher | active; UUID repeats in V2 candidate | challenge_completion: persisted live 77th submitted check-in of an original run | challenge_instance | gold | 900 | Partials and submissions after calendar day77 count. No historical earned-time invention or award replay. |

## Approved completion contract and release boundary

Tim approved 77 submitted check-ins, including partials, with submissions allowed
after calendar day77 until that count is reached. Elapsed day77, a client flag,
a points balance, and an old finisher badge are not completion evidence. A live
77th insertion must atomically persist an immutable completion event and scoped
award. The event ID and source check-in ID remain separate; earned time comes
from the actual source, never from a sorted historical timestamp.

The preview adapter validates the complete 76-row prior snapshot and actual new
row against an explicit completion record. Its facts are frozen and locally
branded; serialized copies and arbitrary completion flags cannot enter the
Finisher evaluator. This protects preview consistency, not production authority.
Production must independently derive and persist its own event in PostgreSQL.

The V2 candidate can preserve validated historical completion as
`legacy_completed`, without inventing a completion event, earned time, new award
or ceremony. Ambiguous history remains review-required. Existing awards remain
untouched. Each new original run has its own canonical completion and Finisher
scope; completing a later track does not award an original77 Finisher. Later
tracks count their configured number of submissions, including partials, and
grant only their configured successor. See [point-economy.md](point-economy.md).
Local candidate tests do not establish hosted completion or deployment.

## Calendar and provenance

Check-in facts use immutable posted check-ins, not draft entries. Bound initial
original runs retain their recorded `original77:<start-date>` award scope;
historical rows must agree with that authoritative start
(`entry_date - challenge_day + 1`). New V2 runs have a UUID and
`instance:<UUID>` scope. Facts use only source rows bound to that run; a fresh
run cannot reuse an earlier run's counts or completion event. Counts are posted rows,
including partial check-ins. Streaks require all seven distinct Daily Actions on
consecutive recorded local dates, not an aggregate streak counter or UTC dates.
App visits use the server's authoritative activation/profile timezone and a
separate append-only visit record. Missing dates reset a streak; partial
check-ins do too. The posted event supplies earned_at and earned local date.

The gallery evidence contract remains schemaVersion1; workout difficulty uses
the actual product values easy/medium/hard/extreme (never a guessed Medium).

## Cutover, recovery, and collection contract

Existing earned rows retain their original timestamps and presentation snapshots.
The earlier badge-pipeline cutover's preserved legacy rows remain presented.
The V2 repeatable-run candidate adds no historical award backfill and must not
invoke an older reconciliation path to manufacture missing awards. No old
aggregate counter is expanded into invented event rows; existing acknowledgment
state does not reset on a new run or catalog revision.

An ongoing app streak keeps its trusted display continuity at cutover (same local
day is unchanged, yesterday advances, a missing date resets). Its prior best is
preserved. New app-streak badge eligibility and locked progress use only actual
immutable visit records, independently from that display aggregate. For example,
a six-day prior display can become seven on the next visit without awarding a
seven-day badge from an unproven six-day aggregate.

`getBadgeCollection({expectedUserId})` captures one actor for its complete paginated
earned history and actor-checked catalog RPC. It returns
`{catalogVersion:1,scopeKey,items,earnedBadges}`. Items carry definition identity,
name, description, requirement, series, tier/tierRank, icon, displayOrder, status,
scope, criteriaVersion, sourceEvent, visibility, showProgress,
earnedInCurrentScope and `progress:{metric,current,target}`. V2 selects
`currentInstance.scopeKey`, retaining original scopes for bound history and UUID
scopes for fresh runs. Scoped progress is zero when the latest evidence does not
belong to the current instance. Hidden
locked and unowned retired definitions are omitted; owned retired definitions
remain retired, not newly earnable.

The gallery integration must show locked public definitions honestly, group
series in catalog order, render progress only when showProgress is true, preserve
all earned scopes via badgeAwardIdentity, and distinguish blocked completion from
earnable milestones. The parent FOU-1500 gallery work owns that presentation.

Unseen awards are leased in catalog order in bounded batches of eight. Dismissal
persists pending acknowledgment before contacting the server; acknowledgments
must confirm each requested award ID (including already-seen retries). A copied
tab cannot reuse another live document's delivery token because of a document
Web Lock. Without document locks, an old lease may need its two-minute expiry
before another page can recover it. Account epochs and pagehide cleanup prevent
stale responses from presenting or acknowledging another account's awards.

## Earlier badge-pipeline validation record

The following records the earlier badge-pipeline candidate's local validation,
not fresh evidence that the V2 repeatable-run release or its hosted cutover has
completed. Current V2 release invariants are in
[point-economy.md](point-economy.md#release-invariants-and-boundary).

The exact CLI-generated migration is
`20260913033347_deterministic_badge_pipeline.sql`. Local validation uses an owned,
network-disabled, tmpfs PostgreSQL17.6.1.141 fixture, including the actual prior
app-visit function and activation-wrapper definitions, concurrent awards/claims,
RLS/privileges, preservation, collection scope, SQL/preview rule parity, and the
registered220 pgTAP contract. Frontend and Chromium/mobile-WebKit regressions run
against mocks only. The pinned full local Supabase stack is absent and Docker's
persistent disk is full; local advisors, db pull, and migration list cannot connect.
The later owned full-chain fixture supplies the baseline's real SELECT-only
vector-inventory dependency and replays all 70 application migrations unchanged
as NOSUPERUSER postgres. Its structural provider tables do not simulate managed
Auth or Storage. Native advisors and platform integration therefore remain
release-CI requirements. Compatible Edge readers must deploy before the database,
and the database before the new frontend contract. No hosted database, project,
auth, billing, or entitlement was changed while preparing this candidate.
