# Typed reward catalog contract

Release contract: **FOU-1498 V2, migration 20261001001245.** Historical-instance
binding, initial activation and generic public-share SQL are implemented and
covered by preservation, concurrency and privacy checks. Production availability
requires the successful guarded migration-71 cutover and matching frontend
deployment; this document is a contract, not deployment evidence. The original77
completion prerequisite shipped separately.

## Configuration and authority

`reward_definitions` holds stable reward identity, display metadata, ordering,
phase, release/active state, fulfillment identity and the typed unlock rule.
Challenge definitions supply the executable submitted-Check-In target. The
checked-in `src/static/reward-progression-catalog.v2.json` is the shared preview
configuration and reviewed SQL seed reference, not browser authority to grant,
start or complete anything.

There are two durable state models:

- `ownership`: `locked` or `owned`; an existing entitlement remains owned.
- `challenge_lifecycle`: `locked`, `available`, `active` or `completed`; explicit
  prior grants remain preserved. Current-run state may overlay a matching
  definition for display without erasing that definition's durable history.

The server's `allowedActions` controls Start. An accessible, released, available
or completed challenge can return `["start"]` when the current run is completed
and no review restriction blocks it. A completed definition can be repeated.
Ownership items never return Start. UI status, a points balance or an unlocked
deep link alone is not authorization; the mutation rechecks the server facts.

Stable key, reward type, state model, fulfillment key and challenge binding are
identity fields. Preserve them across configuration versions. Display copy,
ordering and reviewed rules may evolve without route-specific conditions.

## Authenticated read and consistent pagination

RPC:

```text
get_reward_catalog_v2(
  target_page_size = 50,
  target_after_sort_order = null,
  target_after_reward_key = null,
  target_expected_actor_id = null,
  target_expected_revision = null,
  target_expected_catalog_version = null,
  target_expected_snapshot_version = null
)
```

The authenticated actor is verified independently of the supplied expected ID.
The read locks that actor's runtime and reconciles eligible grants from trusted
server facts before building the response. Private helpers/tables are not
browser-write interfaces. The response is private/no-store.

| Top-level field | Meaning |
| --- | --- |
| `schemaVersion` | `2`, the response shape version |
| `actorId` | Verified owner of every page |
| `catalogVersion` | Positive server configuration revision; not the JSON manifest version |
| `effectiveAt` | Server catalog activation timestamp; preview uses its deterministic manifest timestamp |
| `revision` | Actor runtime revision, also used for Start compare-and-swap (CAS) |
| `snapshotVersion` | Full 64-lowercase-hex SHA-256 digest of the effective actor catalog snapshot |
| `totalPoints` | Preserved lifetime total |
| `currentInstance` | Current UUID instance hint or `null` |
| `originalRepeat` | Separate original-run availability/action hint |
| `items` | Ordered typed reward rows |
| `nextUnlock` | Selected complete reward row or `null` |
| `page` | `{limit,totalItems,hasMore,nextCursor}` |

Page size is bounded to 1–100. Use the returned cursor pair
`{sortOrder,key}` without inventing positions. Every continuation must send the
first page's actor, runtime `revision`, `catalogVersion` and `snapshotVersion`.
The snapshot covers all effective catalog rows, activation and points, not just
the current page. If any guard changes, discard the partial result and refresh;
never combine pages from different snapshots or follow a repeated cursor.

`getAllRewardCatalog()` enforces that continuity in the client. The snapshot hash
is an opaque pagination consistency token, **not** Start's revision or a grant
credential. Preview uses the same opaque 64-hex contract; clients do not compute
or compare hashes across environments.

## Typed reward requirements

Each item retains stable `key`, `rewardType`, `stateModel`, `status`, title,
description, icon, `sortOrder`, `fulfillmentKey`, `requiredEntitlementKey`,
`active`, metadata, access state and lifecycle timestamps. V2 adds `phase`
(`core` or `post_core`), `released`, `targetSubmittedCheckIns`,
`grantProvenance`, `blockedReason` and the runtime `requirement` discriminator.

Point-based requirements:

```json
{
  "type": "trusted_points",
  "pointsRequired": 42,
  "currentPoints": 41,
  "pointsRemaining": 1,
  "progressPercent": 97.62
}
```

`lifetime_points` has the same shape. The four point metrics also appear at item
top level and must agree. Already granted point rewards display zero remaining
and 100% progress even if a later correction puts the balance below today's rule.
Only the Gym reward uses trusted Check-In action points; the six thresholds and
the completion chain are defined in [point-economy.md](point-economy.md).

Completion-based requirements:

```json
{
  "type": "challenge_completion",
  "prerequisiteChallengeKey": "seven_day_reset",
  "requiredState": "completed",
  "satisfied": false
}
```

For these rows, top-level `pointsRequired`, `currentPoints`, `pointsRemaining`
and `progressPercent` are all **null**, not zero. Render the prerequisite, never
a points progress bar. `targetSubmittedCheckIns` is the challenge's run target;
it is null for ownership rewards. `unlockPoints` is retained historical grant
data, not the current rule or a substitute for `requirement`.

The client normalizer derives a static `unlockRule` and may add a prerequisite
title for presentation. It also accepts optional `grantCatalogVersion` and
`grantReason` from preview records; these are not required raw SQL fields. The
wire provenance field is either null, `{type:"legacy_preserved",catalogVersion}`
or `{type:"rule_earned",catalogVersion}`. The private preservation record keeps
the prior state and `catalog_v1_preserved` reason for audit without exposing it as
a browser-editable grant.

`canAccess`/`accessReason` describe access; `blockedReason` explains run-level
obstacles such as `original_completion_required`, `active_instance_exists` or
`review_required`. They are distinct from ownership. A grandfathered grant can
be usable while the new completion `requirement.satisfied` is false. Preserve
the recorded grant; do not re-lock it based on a client calculation.

## Next requirement and current run

The SQL selector first considers available, startable challenges when the
current run is completed, preferring its immediate successor over earlier
configured available rewards. Otherwise it selects a locked, accessible,
active/released core reward in `(sortOrder,key)` order. During an open original
run, this advances only through the six point rewards. A Reset grant can show
that it must wait for the current run; it is not permission to overlap runs.
Later locked cards still show their actual prerequisite.

`currentInstance` carries:

```text
id, challengeKey, title, scopeKey, status, startDate, timeZone,
mode, crewId, targetCount, submittedCount, calendarDay,
completedAt, completionEventId, provenance, reviewRequired
```

`id` is a UUID; status is `scheduled`, `active` or `completed`. Newly repeated
runs use `instance:<UUID>` as their scope. Bound initial original runs retain
`original77:<start-date>` so historic award identities do not change.
`calendarDay` is null before a scheduled start and can exceed the target after
missed dates. Completion counts submissions, including partials, not elapsed days.
`crewId` is null for solo runs. Provenance is `live`, `legacy_bound` or
`legacy_completed`; a preserved legacy completion does not acquire a fabricated
event ID. Review-required history cannot supply browser mutation authority.

`originalRepeat` is separate from reward items because `original_77` is execution
data, not an eleventh reward:

```text
{challengeKey:"original_77",targetCount:77,available,canStart,reason}
```

Availability follows preserved/canonical original completion; `canStart` also
requires a completed current run, current access and no review restriction.
Reason is null when Start is permitted, otherwise a server reason such as
`original_completion_required`, `active_instance_exists`, `entitlement_required`
or `review_required`.

## Explicit Start and safe retry

The client calls:

```text
startChallenge(challengeKey, {
  expectedUserId, expectedInstanceId, expectedRevision,
  startDate, timeZone, requestId
})
```

The RPC is `start_challenge_instance_v2(target_challenge_key, target_start_date,
target_time_zone, target_request_id, target_expected_actor_id,
target_expected_instance_id, target_expected_revision)`, with `expectedUserId`
mapped to the expected actor. The result is
`{schemaVersion:2,actorId,instanceId,activation,replayed}`. `activation` is the
strict V2 activation shape with the new current instance and runtime revision.
Reload the catalog after success; do not locally grant the next challenge.

Capture actor, current UUID and revision before the request. Retain the same
request UUID and exact payload after an uncertain response; the server binds it
to the actor/operation fingerprint and returns the stored result on replay.
A changed payload cannot reuse that request ID. Disable concurrent Start actions
while one is pending, and discard UI results after account/session/run invalidation.

The server requires a completed current run, no other open instance, current
membership/required entitlement and an existing available/completed grant (or
original completion for `original_77`). The selected start date is today or
later in the requested valid timezone. The candidate creates solo repeat/later
runs; the initial activation path remains separate. A repeat preserves earlier
run history, ownership and completed grant timestamps. The global user/local-date
Check-In barrier still prevents scoring twice after a same-day transition.

## Permanent ownership, themes and celebrations

Owned rows and existing challenge grants remain durable across threshold or
membership changes. Server reconciliation can insert newly eligible grants from
the current rule; it cannot treat points as completion, rewrite a prior grant,
or recreate old-curve ownership from a balance alone. Completion plus immediate
successor insertion is atomic. Privileged repair/backfill entry points are not
part of normal UI operation and are not authorization for historical badge backfill.

Theme authorization uses the same catalog's active `ownership` row with status
`owned`. Night is 112 lifetime points and Platinum is 308 for new grants; their
stable fulfillment keys remain `dominion-night` and `dominion-platinum`. Existing
owners keep them. Local storage stores preference, not ownership proof. Protected
themes remain fail-closed until trusted ownership loads and revert to Dark on
authorization failure. `VITE_ENABLE_DOMINION_NIGHT_THEME` can restrict rollout but
cannot grant ownership; Platinum has no client grant flag.

Permanent reward delivery still uses the durable claim/acknowledge lease protocol,
not read-time seen flags. Preserve acknowledgment timestamps and historical
milestone snapshots. An interrupted unacknowledged popup is recoverable; a
dismissed/acknowledged reward never replays because of a new catalog version or
run. Challenge rows do not enter the ownership celebration queue. See
[reward-celebration-delivery.md](reward-celebration-delivery.md).

## Operator configuration and release guidance

1. Start with the manifest and database definition, not a Dashboard/Profile array.
   Keep stable identities and fulfillment authorization unchanged. Add a new key
   for a genuinely new identity; do not recycle an earned key.
2. Advance the manifest version for a configuration change. Its `schemaVersion:1`
   describes the configuration file, while runtime responses use `schemaVersion:2`.
   `lifecycle:"released"` means loadable candidate configuration, not a claim of
   production deployment. Server `catalogVersion` and `effectiveAt` come from the
   database; do not hard-code preview values as production evidence.
3. Set phase, ordering, active/released state and a discriminated rule. Core point
   rules have positive, strictly increasing thresholds in configured order.
   Completion rules have a real earlier prerequisite, no cycle, no points and a
   challenge target. The current runtime supports targets 1–365; original is 77.
4. Update and validate the SQL/configuration mirror in the same reviewed change.
   Challenge execution target, reward metadata, rule graph and catalog version
   must agree. Do not assume the retired point-only compatibility trigger will
   safely configure the completion chain. Do not blanket-reconcile old thresholds.
5. Preserve explicit grants with prior provenance and seen state. Inactive items
   with recorded ownership/history must remain recoverable; disabling a release
   is not deletion of history. Do not run unsolicited grant or badge backfills.
6. Test boundary values, high-balance skip attempts, configuration insertion and
   reordering, an added successor, legacy grants, repeated instances, pagination
   drift, same-day transitions, concurrent/replayed mutations, account/session
   fences, accessibility, supported themes and preview/server next-unlock parity.
7. Verify the reviewed initial-binding and share-reader integrations, the
   current backup and protected release gates, then deploy compatible Edge readers,
   database and frontend in that order. Verify the hosted V2 response afterward
   before describing the candidate as deployed. See
   [point-economy.md](point-economy.md#release-invariants-and-boundary).
