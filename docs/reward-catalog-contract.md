# Typed reward catalog contract

The reward catalog is the server-authoritative read model for point-unlocked
challenges and permanent cosmetic ownership. It preserves the existing
`challenge_definitions` and `user_challenge_states` lifecycle while presenting
every reward through one versioned shape.

## Models

`reward_definitions` contains stable reward identity, display metadata, point
threshold, ordering, fulfillment identity, and one of two state models:

- `challenge_lifecycle` returns `locked`, `available`, `active`, or `completed`.
  Only an accessible `available` reward returns `start` in `allowedActions`.
- `ownership` returns `locked` or `owned`. Presence in
  `user_reward_entitlements` is permanent ownership; no ownership reward is
  startable.

The client should render from `stateModel`, `status`, and `allowedActions`, not
from a hard-coded list of reward types. `rewardType` remains useful for labels,
filtering, and analytics and can expand without changing the state renderer.
Reward key, type, state model, fulfillment key, and challenge binding are
database-enforced immutable identity fields; display copy, ordering, thresholds,
activation, and safe metadata remain configurable.

Existing challenge definitions are copied into the catalog by a compatibility
trigger. Their original thresholds, membership requirement, state, timestamps,
and Start behavior remain authoritative. Ownership definitions are evaluated
against `user_game_stats.total_points`, which is the cached total of the
idempotent point ledger.

## Authenticated read

Call `get_reward_catalog(target_page_size, target_after_sort_order,
target_after_reward_key)`. The RPC always uses `auth.uid()`; the user-selectable
internal helper is not executable by browser roles.

The response contains:

```json
{
  "schemaVersion": 1,
  "catalogVersion": 7,
  "totalPoints": 1200,
  "items": [],
  "nextUnlock": null,
  "page": {
    "limit": 50,
    "totalItems": 5,
    "hasMore": false,
    "nextCursor": null
  }
}
```

Each item includes stable keys, reward/state type, status, title, description,
icon, ordering, required/current/remaining points, progress percentage,
fulfillment key, access state, allowed actions, display metadata, and applicable
unlock/start/completion/ownership/celebration timestamps.

Pagination uses the opaque pair returned in `page.nextCursor`; callers pass its
`sortOrder` and `key` into the next request. `catalogVersion` advances whenever
trusted reward configuration changes. `schemaVersion` changes only when the
contract shape has an incompatible revision.

`nextUnlock` is the lowest-threshold active reward that is both locked and
currently reachable by the user. Owned cosmetics and unlocked challenges are
not selected as the next unlock.

## Grant and claim behavior

Point-total changes and ownership-definition changes reconcile eligible
ownership rows automatically. `grant_reward_entitlement` and
`reconcile_user_reward_entitlements` are service-only, insert with a unique
`(user_id, reward_key)` key, and do nothing on retries. Point corrections,
threshold increases, membership lapses, and configuration changes never delete
an earned row.

`claim_reward_entitlement_unlocks()` atomically marks unseen ownership
celebrations and returns each stable key once. Challenge celebrations continue
to use the existing `claim_challenge_unlocks()` contract.

Authenticated users may select only their own ownership rows under RLS and have
no insert, update, or delete privileges. The catalog RPC is the preferred UI
read path.
