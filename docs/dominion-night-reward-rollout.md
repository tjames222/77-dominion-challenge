# Dominion Night reward rollout

`dominion_night_theme` is the permanent cosmetic entitlement for the
`dominion-night` theme registry entry. The rollout definition is active at
exactly 500 total points, uses sort order 5, and does not require an active
membership entitlement. Existing challenge definitions remain unchanged at
1,000 points and above.

## Grant path

All accepted point awards update `user_game_stats.total_points`. Its existing
database trigger reconciles ownership definitions in the same transaction, so
the first total at or above 500 inserts one `(user_id, reward_key)` row. This
includes server-derived Daily Standards points and the Sharing Bonus event when
that source is introduced. Corrections only update the point total; they never
delete ownership.

The definition-change trigger grants users already over the threshold during
deployment. For a bounded repair or a future threshold reduction, a service
worker can repeatedly call:

```text
backfill_reward_entitlements(
  'dominion_night_theme',
  <previous nextCursor or null>,
  500,
  false
)
```

Continue until `complete` is true. A retry may report zero inserted rows and is
safe. Do not call this RPC from a browser or expose service credentials.

## Verification and rollback behavior

- Confirm the definition has `points_required = 500`, `state_model =
  'ownership'`, and `fulfillment_key = 'dominion-night'`.
- Confirm every user at or above 500 has one ownership row and one grant audit
  event.
- Confirm `claim_reward_entitlement_unlocks()` returns each pending ownership
  celebration once.
- If the theme registry must be disabled, set the definition inactive and keep
  ownership rows. The catalog will return owned rows as inactive with no Start
  action, allowing Profile selection to fail closed without revoking rewards.
- Never roll back by deleting entitlement or audit rows. Restore configuration
  in a forward migration.
