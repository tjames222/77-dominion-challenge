# Scoped member badge pagination

The crew member-progress RPC now returns an opaque `awardId` with each badge and
each continuation cursor. It still returns only the existing public presentation
fields; no scope, private earning evidence, metadata, points, or account details
are added. Frontend page merging uses the award UUID, not the reusable badge key.
Both crew readers honor the original earned snapshot's validated public
name/description/tier/icon, with safe canonical fallback for malformed or missing
fields. The leaderboard retains its exact four-field badge allowlist and limits.

The single live function is
`get_crew_member_progress_profile(uuid, uuid, timestamptz, text, integer, uuid)`.
The final `target_badge_cursor_award_id` argument defaults to null. Older callers
can omit it: a time/key cursor is accepted only if it identifies exactly one
award. Ambiguous or stale cursors return SQLSTATE `22023` with the fixed detail
`member_badge_cursor_restart_required`. The API maps this to fixed user-facing
guidance and Community offers **Reload badges**, which rechecks access and reads
the first page. It does not reload the browser or automatically change data.

Ordering is `earned_at DESC, badge_key ASC, id ASC`. Cursor timestamps retain
Postgres microseconds verbatim; converting them with JavaScript `toISOString()`
would truncate the exact boundary. Page sizes remain bounded to 1–24 (default12).
Entitlement, crew, membership, account-erasure locks and generic access denials
are unchanged. The migration updates only the reader, not award data or rules.

## Local verification

- `pnpm test` covers normalization, UUID merge idempotency, microseconds, preview
  paging, actual API function execution with a provider stub, and actor rechecks.
- `pnpm run test:scoped-member-badges-sql` starts and removes only an owned,
  network-none, tmpfs Postgres17.6.1.141 container. It applies the actual scoped
  identity DDL and old reader, reproduces the lost tied row, applies the new
  migration, then executes all40 assertions in
  `260_scoped_member_badge_pagination.sql`.
- Chromium and WebKit tests cover distinct same-key awards, accessible recovery
  in light/dark/Dominion Night, no provenance disclosure, crew permission loss,
  reconnect revalidation, and pagehide scrubbing. Existing Linux visual baselines
  are unchanged; no macOS baselines are generated or committed.

The isolated fixture is not a substitute for the complete migration-chain and
schema-drift rehearsal in release CI. No hosted project is used by these tests.
