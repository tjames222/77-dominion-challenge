# Earned badge gallery presentation contract

FOU-1500 only changes the earned collection on the Badges tab. It does not award
badges, change eligibility, or modify Dashboard, private-group, reward or
celebration behavior. Existing full earned-badge pagination remains intact.

The normalized record contains `key`, `name`, `description`, `icon`, `tier`,
`earnedAt`, `requirement`, optional `earningEvidence`, `legacy` and `retired`.
Requirements come from the authoritative definition (legacy descriptions are
preserved); page code never infers criteria from a badge name. Unknown earned
timestamps are omitted, not replaced with a check-in date or today's date.

The richer badge pipeline can return `earningEvidence` directly, or under the
existing award metadata. Version1 has `schemaVersion: 1` and a `kind`:

- `check_in`, `perfect_streak`, `app_streak`, `app_visit`, `share`, or
  `challenge_completion`: positive integer `qualifyingValue`.
- `daily_standards`: integer `completedCount` from1 through7.
- `workout`: `workout` (`one`/`two`) and explicit `difficulty`
  (`easy`/`moderate`/`hard`).

Only these fields become friendly earning text. Raw source/user/record IDs,
arbitrary metadata, unrecognized kinds/versions and free-form summaries are never
rendered. Legacy or insufficient evidence gets an honest fallback. This is a
presentation schema, not a new award rule or authorization mechanism; FOU-1499
must populate it from canonical evidence.

Keyed DOM reconciliation preserves the exact trigger and selected dialog during
same-account updates. The existing page actor guard clears all grid/dialog state
on account loss or switch. Details consume the in-memory record without reads,
claims, tab changes, reordered collections, or celebration replay.
