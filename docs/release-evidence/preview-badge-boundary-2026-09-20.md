# Optional preview badge runtime — local next-batch evidence

## Scope and ownership

Base: `6ee02f8f76e520692e8a1a85d26ee40c4c821690`. This is a frontend-only
next-batch checkpoint, not evidence of a deployment or of meeting the remaining
performance budgets. No SQL, hosted data, release gates, catalog rules, CSS,
production Vite configuration, or budget thresholds changed.

- API preview badge evaluation/state now loads through native dynamic import.
  The platform may cache the module, but there is no cached user, result, failed
  loader promise, or private state in this boundary.
- Every operation captures its owner before loading. It verifies the same actor,
  immutable session, exact bearer and local lifecycle epoch after loading and,
  for mutations, again inside the existing per-actor browser Web Lock. Reducer
  state reads and writes remain synchronous within that lock.
- Collection reads capture before obtaining earned-badge data, then reverify the
  original owner after that awaited read and before reading collection facts.
  Independent review caught and closed an earlier draft that captured too late.
- Pure previews perform no Supabase calls. DEV hybrid previews preserve all
  canonical user checks plus the added checks below. The production live RPC
  branches are unchanged and do not use this preview boundary.
- Dashboard imports only pure ordering/reason helpers. The generated key/order
  projection comes from the canonical catalog, preserves first-match strict-key
  semantics and existing fallback/tie behavior, and never trusts an incoming
  badge's displayOrder. Exact source-integrity tests fail on a stale projection.
  Existing evaluator exports remain compatible reexports.
- The held Original77 completion rule is unchanged. No award criteria, grants,
  testing access, administration access or membership provisioning were added.

## Actual initial-graph comparison

Paired in-memory Vite production builds used the unchanged production config
and all 28 canonical HTML entrypoints. The before build substitutes the five
changed existing production modules from the pinned base; all other inputs are
the same. Main uses the fixed production provider URL with a synthetic public
key for compilation only. Neither build makes provider requests.

These are sums of gzip-compressed initial JavaScript assets, not latency
measurements or total session payload. Static imports and HTML preload assets
are traversed; optional dynamic imports are excluded until invoked.

Every route in both modes has **zero initial request-count delta** and
**byte-identical CSS**. Catalog, evaluator and preview-state modules are absent
from all 28 initial graphs, including Dashboard and menu-free Account Security.
The initial savings range is 3,562–3,604 bytes in develop and 3,557–3,598 in main.

| Entry | Develop before | Develop after | Main before | Main after |
| --- | ---: | ---: | ---: | ---: |
| main | 138990 | 135406 | 139079 | 135497 |
| membership | 140300 | 136716 | 140389 | 136807 |
| login | 142315 | 138731 | 142402 | 138822 |
| register | 142315 | 138731 | 142402 | 138822 |
| forgotPassword | 139503 | 135919 | 139592 | 136011 |
| resetPassword | 139503 | 135919 | 139592 | 136011 |
| accountSecurity | 125574 | 122009 | 125666 | 122102 |
| admin | 147186 | 143582 | 147273 | 143675 |
| invite | 142121 | 138537 | 142208 | 138629 |
| billing | 142661 | 139077 | 142748 | 139168 |
| dashboard | 158557 | 154966 | 158644 | 155059 |
| badgesRewards | 152101 | 148539 | 152189 | 148632 |
| bibleReading | 144572 | 140989 | 144661 | 141081 |
| morningPrayer | 144572 | 140989 | 144661 | 141081 |
| worship | 144572 | 140989 | 144661 | 141081 |
| eveningPrayer | 144572 | 140989 | 144661 | 141081 |
| workoutOne | 144572 | 140989 | 144661 | 141081 |
| intentionalWalk | 144572 | 140989 | 144661 | 141081 |
| workoutTwo | 144572 | 140989 | 144661 | 141081 |
| community | 164400 | 160816 | 164488 | 160910 |
| groupSettings | 143373 | 139787 | 143460 | 139879 |
| privateJournal | 143502 | 139918 | 143590 | 140010 |
| profilePage | 144785 | 141201 | 144873 | 141295 |
| science | 138319 | 134733 | 138406 | 134824 |
| privacy | 139308 | 135724 | 139397 | 135817 |
| terms | 139308 | 135724 | 139397 | 135817 |
| cancellationRefunds | 139308 | 135724 | 139397 | 135817 |
| support | 139308 | 135724 | 139397 | 135817 |

When a signed-in preview actually records a visit/check-in or opens its badge
collection, the optional runtime is still required: one new chunk, 4,736 bytes
gzip in develop (4,735 in the main artifact, where live branches do not invoke
it). This is a deferral, not a claim that preview users never download those
bytes or that total post-interaction payload decreases.

## Auth traffic and browser evidence

Measured with the real installed Supabase SDK and the existing exact-token
local Auth fixture, on Chromium and WebKit, without ambient menu hydration:

| DEV hybrid operation | Base source checks | Measured candidate GET /user |
| --- | ---: | ---: |
| Locked badge operation | 2 | 3 |
| Collection read | 2 | 5 |
| Locked operation after module cache is warm | 2 | 3 |

Collection checks are initial actor resolution, original boundary capture,
post-import, earned read and post-earned original-owner verification. These
increases are deliberate DEV-hybrid-only costs, not performance improvements.
Pure compiled preview makes zero provider requests. Main live RPC branches
retain their existing authorization flow. No checks were removed to offset
the added cost.

Local gates:

- `node --test src/static/*.test.mjs`: **964 passed**, zero skipped/failing.
- `pnpm test:e2e:preview-badges`: **28 passed**, zero retries. Sixteen actual
  production-compiled pure-preview cases and twelve DEV-hybrid real-SDK cases,
  split evenly across Chromium and WebKit.
- `E2E_FOU_1452_PORT=4498 pnpm test:e2e:auth`: **7 passed** existing hybrid
  account, logout, stale-session and owner-scoped state regressions.
- `node scripts/generate-badge-display-order.mjs --check`: canonical projection
  exact; all-pairs comparator and compatible-export tests pass.
- `git diff --check`: clean.

Coverage includes delayed import with actor change and A→B→A, immutable session
replacement, post-import canonical rejection, queued lock revalidation,
duplicate event serialization across tabs, exclusive claims, wrong-token and
duplicate acknowledgment, exact reload/explicit retry after an import failure,
no replay on reload, signed-out public/Security runtime absence, and compiled
Dashboard celebration text/presentation/acknowledgment.

The collection review regression executes the actual API/getEarned functions
and schedules replacement immediately after the earned read's last actor
check. The real-SDK case obtains a registered same-actor replacement session
using a second SDK client, models its storage arrival during the post-earned
canonical read, and verifies rejection before publishing a mixed-session
result. No permissive Auth fixture or fabricated accepted token is used.

The harness is a separate test-only HTML entry and config. Normal build graph
tests reject its global hook or any test module in every emitted chunk. The
dedicated suite is excluded from unrelated main browser discovery and runs as
a required browser preflight after Daily Action; CI diagnostics use the
existing short-lived HTML report artifact. Hosted/non-GET unexpected traffic
is blocked, application WebSockets are closed locally, and no page errors are
suppressed. Hybrid's local Vite HMR socket is closed rather than forwarded.

## Durable local artifacts and limits

Worktree:
`/Users/timjames/.codex/visualizations/2026/07/21/019f8263-5bb3-7d40-8c75-49dce522b208/next-preview-badge-boundary-2026-09-20`

Ignored local evidence is retained under `test-results/preview-badge-evidence/`:
the paired-build audit script, complete develop/main module/chunk/route JSON,
graph summaries, final unit log and final 28-case browser log.

- Develop JSON SHA-256:
  `f9c3e58b0b6b7f5867dd5b124dd91be7239de4ae56e0c959e6e04ff50cbc9be1`
- Main JSON SHA-256:
  `312269b6496c1872e5753ad896e2acccd4e59b19e9f395515d8fe8bd076793df`

These are local synthetic regression/build results. Linux exact-head CI,
combined-head measurement, reviewed release artifacts, and deployment remain
separate gates. No push, database operation, production mutation or deployment
was performed by this checkpoint.
