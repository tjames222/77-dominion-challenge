# Isolated Admin role UI evidence — 2026-09-20

Base: `38378d1`. Branch: `epic/next-admin-role-controls-2026-09-20`.
No push, merge, hosted access/role assignment, migration or deployment occurred.
The frozen current release was not edited. This is one bounded FOU-1502 slice.

Final local unit suite after discovery-isolation follow-up: **960/960 passed**.
Synthetic production-built Admin suite:
**140/140 passed** (62 role-control cases and 78 existing Admin cases).
Existing production-built MFA suite: **44/44 passed**. Early browser runs exposed
incorrect test assertions for native option disabled state, the existing “Site
admin” display label, and the fixture's pre-existing audit entry; the assertions
were corrected without weakening product checks. Whole-write timeout and immutable
adapter-copy regressions are included. Screenshots were visually reviewed for
desktop/light and 390px WebKit/dark; all four themes pass Axe, focus, keyboard,
48px select sizing, no overflow and 200% text checks.

Synthetic screenshots remain outside the commit at
`/tmp/77dc-admin-role-{admin-live-chromium|admin-live-webkit}-{light|dark|dominion-night|dominion-platinum|uncertain|uncertain-actions|receipt}.png`.
The uncertain/receipt pair is produced by the exact-retry test; the phone dialog
is scrollable, with a second uncertainty capture showing the retry actions.

The role browser suite is explicitly excluded from the main mock-server
configuration, alongside the two existing production-only Admin suites. Actual
Playwright discovery remains **1,152 tests in 38 files** for the main configuration
and **140 tests in 3 files** for the production-built Admin configuration.
Three static configuration regressions verify the isolation for every main
project and the Admin build/server flags; the focused config/role/read/early-access/
build-graph run passed **50/50**. All prior exclusions remain unchanged.

Independent review found and verified fixes for a list refresh incorrectly tied
to a closed dialog, original-owner checks around read-only refresh, and an older
refresh publishing after timeout/newer success. The final browser regressions
hold owner verification beyond the unchanged 20-second timeout, successfully
publish member/revision 9 and newer audit data, then release the old work and
prove neither facts nor audit are overwritten. Independent actual-module replay
and 47 focused checks passed with no remaining concrete findings.

## Canonical develop graph

Exact frozen lockfile, Vite 8.1.5, production mode, normalized Cloudflare
`develop` mocks, production connections/Auth-in-mocks/E2E fixtures off, Dominion
Night on, no live Supabase URL/key. Baseline source was loaded from exact
`38378d1` for the four changed application modules in the same worktree; no
configuration or CSS was substituted. The new files are unreachable from the
baseline entries. Full raw graph/asset measurements remain local and untracked
as `role-graph-baseline383.json` and `role-graph-role-controls.json`.

| Route | Initial JS gzip before → after | Requests before → after |
| --- | ---: | ---: |
| Landing | 140,472 → 140,639 | 10 → 10 |
| Login | 143,796 → 143,960 | 11 → 11 |
| Dashboard | 160,045 → 160,154 | 12 → 12 |
| Rewards | 152,306 → 152,467 | 11 → 11 |
| Community | 165,881 → 166,053 | 12 → 12 |
| Profile | 146,267 → 146,442 | 9 → 9 |
| Bible Reading | 146,049 → 146,206 | 9 → 9 |
| Account Security | 127,051 → 127,219 | 7 → 7 |
| Admin | 148,647 → 152,480 | 10 → 11 |

All 27 non-Admin route module sets and request counts are unchanged. Every CSS
asset identity and byte content is identical on all 28 routes; Security CSS
remains 29,474 gzip bytes. Admin adds only the role UI/data contract to startup;
the write adapter is optional until confirmation. Shared-client dispatch and
safe transport classification add roughly 0.1–0.2 KB gzip to non-Admin routes.

An initial contract-to-session-client import created an entries-aware merge that
incorrectly included `dialog.mjs` in Security. The existing graph test caught it.
The final pure role contract has no session/API dependency, restoring the exact
baseline Security module set. No Vite grouping/threshold or CSS change was used.
The graph regression also explicitly forbids all three role modules in Security
and the seven canonical public/member startup graphs.

The existing performance check **still fails** the same 15 budget categories as
the baseline, with all seven JS completion targets unmet. There is no new budget
failure category and Profile stays below its existing JS maximum, but existing
overages are slightly larger due to the added shared dispatch. No budget or
completion target was raised. FOU-1501 is not complete and this evidence is not
a production release approval.
