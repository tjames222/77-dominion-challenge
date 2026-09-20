# Badge data/presentation graph separation (next batch, not deployed)

Baseline: `69ef75737ffd8e2ba851713167900e0939678a24`. Canonical mock-only develop
build with Night enabled, using the frozen lockfile and existing environment
normalizer. Measurements use the unchanged `measureFrontendBundles` Node gzip
and complete initial-static-graph implementation.

The API imports badge normalization; preview state imports badge identity. Both
previously imported the complete Rewards presentation module. They now import
the dependency-free `badge-data-contract.mjs`, while the presentation module
re-exports its three existing data helpers for compatibility. Function bodies
match the baseline exactly. No criteria, Auth/MFA, actor validation, entitlement,
invalidation, API request, storage, or mutation behavior changed.

| Route | Before JS gzip | After JS gzip | Initial requests (unchanged) |
| --- | ---: | ---: | ---: |
| Landing | 140472 | 138990 | 10 |
| Login | 143796 | 142315 | 11 |
| Dashboard | 160045 | 158557 | 12 |
| Rewards | 152306 | 152101 | 11 |
| Community | 165881 | 164400 | 12 |
| Profile | 146267 | 144785 | 9 |
| Bible reading | 146049 | 144572 | 9 |
| Account Security | 127051 | 125574 | 7 |

All 28 route graphs have no JS gzip regression and no added requests. Every CSS
asset retains its filename and exact bytes. Security adds only the pure data
contract and drops `badges-rewards.mjs`; no menu/header/dialog/training code or
CSS is added. Its CSS remains 29474 gzip bytes. The Rewards presentation module
has 7627 rendered bytes; the pure contract has 3158. Rewards retains all its
presentation behavior, and the other six measured routes no longer load it.

## Compatibility and identity

Normalization still creates a fresh output array and fresh normalized records
on each call; no settled or in-flight cache was added. Award-ID precedence,
fallback key/scope identities, deduplication, timestamp handling and stable
ordering are unchanged. Input metadata and earning-evidence object references
are preserved exactly as before (not newly cloned or retained globally). A new
call observes updated input names/scopes rather than reusing a stale record.
Badge name/description/category/tier/icon/provenance/display-order defaults are
unchanged. Direct contract exports and old presentation-module exports reference
the same function objects.

## Verification

- Full frontend unit suite: 944/944 pass.
- 45 focused unit/build-graph checks pass, including compatibility re-exports,
  fresh result identity, nested-reference behavior and display defaults.
- Actual build-graph assertions reject the Rewards presentation dependency on
  Security and six other measured routes while requiring it on Rewards.
- Six existing browser checks pass against the built mock artifact in Chromium
  and WebKit: 390px tier/details/focus/accessibility behavior, ordered deduplicated
  125-badge collections, and empty collections.
- All three moved functions' representations exactly match the baseline source.
- No Vite grouping, CSS, budget, or measurement-script change was required.

This is a modest ~1.48 KB saving outside Rewards, not a completed FOU-1501 result.
Existing interim request budgets and final 40%/25% JS targets remain unmet. No
Linux visual-baseline, hosted API latency or deployed before/after claim is made.
The larger remaining API/SDK/activation/reward modules require a broader domain
ownership design; their safety boundaries were not changed for this cleanup.

Reproduce a canonical build with
`CF_PAGES=1 CF_PAGES_BRANCH=develop VITE_ENABLE_DOMINION_NIGHT_THEME=true pnpm run build`,
then `node scripts/measure-frontend-bundles.mjs`. Compare to the baseline with the
same flags. Run the focused badge data, Rewards, gallery, collection, preview-state
and site-training build-contract test files. No source-module request substitution
or measurement exclusion was used for these initial graph totals.
