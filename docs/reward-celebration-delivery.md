# Permanent reward celebration delivery

FOU-1497 uses the existing typed reward catalog and permanent ownership records. It does not change point thresholds, ownership eligibility, fulfillment, paid services, theme activation, or challenge completion rules. The held FOU-1498 catalog is not a dependency.

## Server contract

`claim_reward_celebrations(expected_actor, claim_token)` reconciles existing authoritative ownership, then returns only owned, unseen `state_model = ownership` catalog items. A private actor/reward lease lasts fifteen minutes. The same token can recover an interrupted response; another token cannot claim a live lease. Parent entitlement row locking, `SKIP LOCKED`, and the unique lease key serialize competing claimants. A later token can recover an abandoned expired lease.

`acknowledge_reward_celebrations(expected_actor, claim_token, reward_keys)` marks only the actor's matching leased entitlements seen. The operation is idempotent, including a lost success response. It never grants, redeems, downloads, starts a challenge, or changes ownership timestamps. Leases are inaccessible to browser roles. Both RPCs require a verified actor and use explicit schema qualification with an empty definer search path.

Existing owned and seen rows are not backfilled or reset. Newly inserted point-based grants snapshot the configured point threshold in private entitlement metadata; a manual grant or old grant without a historical snapshot omits the milestone rather than implying the current threshold was its original requirement. Existing legacy inline claims cannot consume a live durable lease.

## Client delivery

Dashboard owns the single celebration queue. Permanent rewards follow day-complete and badge celebrations and precede challenge unlocks. Reward lookup failures are isolated from the other stages. The popup has no redemption or activation action: View Reward links to the Rewards tab and opens the matching read-only detail view, with focus returned to its card on close.

With Web Locks and session storage available, the delivery token survives a tab reload; the shared document-token helper prevents a duplicated live tab from reusing the same token. Without those facilities, a fresh document token uses bounded server-lease recovery. Unacknowledged interrupted presentations remain recoverable. A completed dismissal writes an actor-scoped pending acknowledgement before starting the request; failed acknowledgements retry on recovery, and locally dismissed keys are suppressed while retrying. Dismissal due to account invalidation or modal replacement does not mark an unseen reward seen. Server leases prevent independent device claims from duplicating an active delivery; acknowledged entitlements never replay. This is a recoverable delivery protocol, not a claim of exactly-once browser paint: an unacknowledged interrupted popup can be shown again after recovery.

Recovery runs on Dashboard entry, focus, visibility, online and relevant storage events, and at one-minute intervals while visible and online. Hidden, offline, or in-flight check-in states skip periodic recovery. Account identity is rechecked after asynchronous stages; storage denial retains in-memory acknowledgement suppression for the current document.

Recovery batches with multiple rewards are consolidated into one count-based catch-up popup. Live point crossings use deterministic catalog order, one popup per newly owned reward. Backfill/catalog-threshold sources consolidate even in a live refresh. Challenge-lifecycle records are always excluded, including future challenge types. New permanent reward types use the same contract and a safe gift-icon fallback.

## Verification

- `pnpm test`
- `node --test scripts/reward-celebrations.sql.test.mjs`
- `pnpm run check:migrations`
- `pnpm run test:database-runner`
- `pnpm exec playwright test tests/e2e/reward-celebrations.spec.mjs --project=chromium-functional --project=webkit-reward-celebrations-mobile`
- Against the development server: `pnpm exec playwright test tests/e2e/reward-celebrations-failure.spec.mjs --project=chromium-functional --project=webkit-reward-celebrations-mobile`
- Full-stack SQL contract registration: `supabase/tests/database/230_durable_reward_celebrations.sql`.

The isolated SQL harness extracts actual schema and eligibility/catalog functions from existing migrations, applies the exact new migration, and verifies ownership preservation, threshold boundaries, same-token recovery, wrong-token acknowledgement, expired leases, legacy-client exclusion, concurrent devices, gym eligibility, and ACL/actor guards. It can create/remove only its own random-name, network-disabled, tmpfs Postgres 17.6.1.141 container; it cannot accept a hosted URL or an existing container name. Full Supabase service integration/advisors and Linux screenshot baselines remain separate release checks.
