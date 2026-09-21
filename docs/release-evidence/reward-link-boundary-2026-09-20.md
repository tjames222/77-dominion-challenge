# Pure reward-link boundary — 2026-09-20

Base: `73c7f292da6840d040df1ab0eefa2aec8e243dbc` (N73). Next-batch-only work in `epic/next-reward-link-boundary-2026-09-20`; no push, deployment, provider request, SQL, or migration change.

## Scope and preserved behavior

Badges previously imported only `rewardKeyFromLocation` from the reward celebration controller. That shared import brought the recovery and delivery-token module into Badges' initial dependency graph. The parser now lives in `reward-link-contract.mjs`, Badges imports it directly, and the original module reexports the same function for compatibility.

The exact synchronous parser and key language are unchanged: URL parsing uses no base, the first `reward` parameter wins, decoding is performed once by URLSearchParams, and invalid/malformed input returns an empty key. Unknown but syntactically valid keys remain valid parser results. Prototype-like strings receive no special object lookup. No new URL/origin policy, asynchronous boundary, actor check, side effect, or cache is introduced.

The tiny private validator is intentionally kept in both modules. A source-integrity test requires identical validator expressions, and behavioral tests cover outbound-link acceptance. Moving the outbound helper/validator into a shared import instead was measured in the read-only proposal and retained an extra shared request; the accepted parser-only boundary does not make Dashboard depend on the parser.

All token generation, ownership/award/completion rules, celebration claim/ack/retry behavior, Auth fencing, details focus, and load sequencing remain unchanged. Production Vite configuration, CSS, performance budgets, lockfile, and workflows are unchanged.

## Paired production graph measurement

Actual Vite production builds, using unchanged production configuration and canonical Cloudflare environment normalization, compared the exact two original source files at N73 against the candidate. All 28 HTML entry-point static graphs were traversed from emitted HTML through emitted chunk imports, counting initial JS/CSS assets plus public theme bootstrap. Lazy imports were excluded. Main used a synthetic public key for compilation only; no provider was contacted.

| Build mode | Route | Initial gzip JS before → after | JS saved | Initial graph requests |
| --- | --- | ---: | ---: | ---: |
| develop mocks | Badges | 148,716 → 146,711 B | 2,005 B | 11 → 10 |
| develop mocks | Dashboard | 155,181 → 154,615 B | 566 B | 12 → 11 |
| main live-wired | Badges | 148,809 → 146,805 B | 2,004 B | 11 → 10 |
| main live-wired | Dashboard | 155,275 → 154,710 B | 565 B | 12 → 11 |

Other 26 routes: identical JS bytes and request counts. All 28 routes: identical CSS hashes and gzip bytes. Account Security is unchanged (122,187 B develop / 122,279 B main initial JS). Badges includes only the pure parser; actual reward recovery and delivery-token modules remain present only in Dashboard's initial graph, folded into its existing entry chunk.

The unchanged interim Badges JS ceiling is 146,842 B, leaving only 131 B develop / 37 B main headroom. This is not completion of FOU-1501. All seven route completion JS targets remain unmet. Remaining interim violations in both modes:

- Initial requests: Landing 10 > 7, Login 11 > 7, Dashboard 11 > 7, Badges 10 > 7, Community 12 > 8, Profile 9 > 6, Bible Reading 9 > 6.
- Initial CSS: Dashboard 36,154 > 35,624 B; Badges 39,197 > 38,947 B.

## Verification

- Frozen-lockfile dependencies; Node 26.4.0, pnpm 10.17.1, Vite 8.1.5, macOS arm64. Lockfile SHA-256: `49b9f4808756b782d9b3e5a147a945c46151ed1bd080c786d83d419dff26eb13`.
- Full frontend units: **1,017 passed**, no skips. Includes four new contract tests covering original-function equivalence, malformed/missing/throwing/coercible/inherited inputs, encoded and duplicate parameters, prototype-like keys, exact compatible export, and dependency purity.
- Existing actual production build-contract test now requires parser ownership only on Badges and recovery/token ownership only on Dashboard across all 28 routes.
- Production-compiled synthetic reward browser matrix: **58 passed**, Chromium desktop and WebKit mobile. Includes the six new link cases in both engines, deep-link focus restoration, all four themes and both viewport widths, no automatic fulfillment/theme change, collection view without acknowledgement, offline acknowledgement retry, duplicate-tab token isolation, actor changes, and queued celebration order.
- Source-injected outage/fulfillment checks: **11 passed** (nine Chromium fulfillment cases plus reward outage in both Chromium/WebKit). Kept separate because those fixtures intercept source modules and cannot honestly test a compiled bundle.
- Normal `pnpm run build` including environment validation and asset verification passed for canonical develop and main environments. The first main invocation omitted the required `SUPABASE_PROJECT_REF` and correctly failed validation before compilation; supplying the pinned public project reference passed without a source change.
- Actual Playwright discovery: **1,164 main-suite cases**, up from 1,152 due to six new tests × two projects. The two actual shard inventories contain **582 + 582**, disjoint and exactly covering the full main list, verified with the existing plan validator. Dedicated preview suite remains **28**; preview and role suites remain excluded from the main suite.
- Independent reviewer reran **16** focused parser/recovery/build tests and verified paired graph reports and runtime logs with no findings.
- `git diff --check` passed.

Private raw evidence remains under `test-results/reward-link-evidence/` in the isolated worktree: `audit.mjs`, both `reward-link-*-graph-evidence.json`, summary/build/unit/browser logs, and actual full/shard/dedicated discovery JSONs. Compiled browser fixtures are under `test-results/reward-built-dist/`; browser traces/screenshots under the separate `reward-built-browser/` and `reward-source-browser/` directories. These generated files are ignored and are not committed.

These are local synthetic and build-graph results, not hosted production behavior or Linux visual-baseline approval. Final combined-source Linux/strict release checks remain the release owner's responsibility.
