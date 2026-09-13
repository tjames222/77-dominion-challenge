# Frontend performance (FOU-1501, work in progress)

## Baseline and completion boundary

The local bundle baseline was built from `1ff3ee7feb60baf0953258b7ac63a43d25991f8d`
with Node's gzip/Brotli measurement, not Vite's differently configured gzip summary.
Build command:

```sh
CF_PAGES=1 CF_PAGES_BRANCH=develop VITE_ENABLE_DOMINION_NIGHT_THEME=true pnpm run build
node scripts/measure-frontend-bundles.mjs
```

These are **mock-preview static dependency graphs**, not deployed timing or API
latency results. The wrapper disables billing, signup, integrations and test
fixtures, enables preview mocks, and removes live connection settings. The
initial graph includes the HTML entry, module preloads, static imports, linked
CSS and the stable theme bootstrap; optional imports and media are reported
separately. The parser targets Vite-generated module syntax, not arbitrary JS.

| Route | Initial JS gzip bytes | Initial CSS gzip bytes |
| --- | ---: | ---: |
| Landing | 140131 | 36386 |
| Login | 142286 | 33576 |
| Dashboard | 157232 | 33576 |
| Rewards | 146842 | 36899 |
| Community | 165250 | 41790 |
| Profile | 146490 | 33576 |
| Bible reading | 145357 | 33576 |

The common menu JS was 136733 gzip bytes. The original Inter font was 352240
bytes. These explain the first scoped changes, but **FOU-1501 is not complete**:
the 40% public / 25% authenticated initial-JS targets, domain/API deduplication,
bounded history reads, daily-action bootstrap and deployed before/after timing
matrix remain separate required work. No navigation INP score is fabricated.

## Deployed measurements

Use a verified immutable **mock-only develop deployment of the existing
`77-dominion-live` project**, never a signed-in production session. The source SHA
must be checked against Cloudflare's deployment metadata before recording it:

```sh
node scripts/measure-deployed-performance.mjs \
  --base-url=https://DEPLOYMENT.77-dominion-live.pages.dev \
  --sha=VERIFIED_40_CHARACTER_SOURCE_SHA --samples=3 \
  --output=/tmp/deployed-performance-before.json
```

The script accepts only the approved project and uses fresh disposable browser
contexts with local mock fixtures. It does not intercept requests, so cold/warm
cache behavior comes from the real CDN. Its fixed fixture calendar does not
replace the performance clock. It covers the seven routes above, clean and HTML
URLs, desktop and CPU/network-throttled phone profiles. Redirect hops are counted.
It records sanitized URL paths, cache headers, transfer sizes, waterfall timings,
LCP/FCP/CLS/TTFB/TBT and primary-content readiness. No tokens, query strings,
payloads or customer records are captured. `networkidle` is only the sampling
barrier after primary-content readiness, not the usable-content metric.

For a tooling smoke run, limit with `--profile=desktop --route=landing`. A canonical
develop URL without a verified immutable source is not the final baseline.
Navigation runs leave INP null: interaction lab checks and sufficiently sampled
production p75 RUM require separate evidence. Before and after must use identical
flags, routes, profiles and fixture state; attach the JSON summaries to the ticket.

## Changes in the first asset phase

- Hashed `/assets/*` files receive one-year immutable freshness. Root HTML and
  one-segment route/deploy pointers revalidate. Copied images and font-license
  paths have one-hour freshness. Cloudflare joins duplicate matching header
  values, so there is no blanket `/*` cache header competing with asset rules.
  Existing `today-actions` no-store and private share-worker headers remain.
  `_headers` applies only to static assets; Functions/Worker responses retain
  their own explicit private policy.
- Theme artwork now requests only the selected variant, retaining its existing
  fallback and theme-change behavior; it does not preload the alternate theme.
- Sharing is loaded on interaction. Its stylesheet remains a static dependency
  of the deferred component, so a first open cannot race its CSS. Pending clicks
  coalesce, failures announce a retry, and synchronous account-reset generations
  invalidate delayed opens without loading the component merely to close it.
  Always-visible Share buttons own a separate small static stylesheet; opening
  the component must not restyle those existing controls or change their geometry.
- Everyday Latin/punctuation/arrows/UI-symbol font traffic is 80132 bytes,
  77.3% below the original. The original font is unchanged and fetched only for
  its complementary extended-language glyph ranges. This is the documented
  100 KB exception for user text needing those glyphs, not lost language support.
  Unsupported emoji are excluded from both advertised ranges and use fallback.

The deployed baseline also identified a preview-only Community shift: inserting
the known mock-mode notice after hydration moved the group section down 120 px
on a 390 px phone. The build now includes that notice in preview HTML before the
first paint, using the same runtime copy. Production still gets an empty feedback
area; no production-only layout claim is inferred from this preview fix.

The font subset preserves all weight/optical-size axes, hinting, default shaping
features and tabular numbers. The generator checks every retained glyph's advance
and bearing against the original, pins its hash, enforces 100 KB, and generates
non-overlapping CSS ranges whose union retains all 2852 supported codepoints.
The SIL 1.1 license remains at `public/fonts/Inter-LICENSE.txt`.

Reproduce the mechanical font artifact in a temporary virtual environment with
`fonttools[woff]==4.59.0` and `brotli==1.1.0`, then run
`python scripts/subset-ui-font.py`. No downloads occur inside the generator and
there is no additional production runtime dependency. Do not replace the original
font or commit platform-specific visual baselines when regenerating the subset.

## Responsive landing artwork and measured layout corrections

The remaining multi-megabyte landing image now uses four local, content-hashed
WebP widths (480/768/1200/1536), encoded from the exact existing PNGs without
cropping or artwork changes. Dark candidates are 16/36/67/115 KB; Light candidates
are 22/48/88/149 KB. The original R2 URLs remain native `<picture>` fallbacks.
Both pictures reserve the original 1536×1024 aspect ratio. CSS hides the inactive
picture before layout, and native lazy loading does not fetch it. Only Light
selects the Light picture; Dark, Night and Platinum retain the approved Dark
artwork fallback. This depends on the existing secure root-theme selection and
does not grant theme entitlement. Browser tests cover both engines, all four
themes, theme changes, one-image accessibility and non-WebP fallback selection.

`hero-artwork.json` pins original/derivative SHA-256 hashes, bytes, dimensions and
encoder options. To reproduce, download the two manifest URLs to a temporary
directory as `hero-dark.png` and `hero-light.png`, then run
`node scripts/encode-hero-artwork.mjs /path/to/temp` with `cwebp 1.6.0` installed.
The script verifies original hashes before encoding; it makes no network request.
Source and production-build checks enforce byte budgets, intrinsic dimensions,
hashed HTML references and original fallbacks. See the official
[cwebp reference](https://developers.google.com/speed/webp/docs/cwebp) and
[native lazy-loading behavior](https://web.dev/articles/browser-level-image-lazy-loading).

The deployed diagnostic also traced Community's desktop shift to the brand
moving from the far right when authenticated controls arrived. Its existing
header now reserves the same left-aligned brand position before hydration.
Rewards on narrow phones reserve two progress-label rows and two lines of status
copy, so replacing placeholder points/copy does not add a row or collapse space.
Pinned deployed remeasurement is recorded below; local geometry tests are not
used as a substitute for those CDN measurements.

### Verified asset/layout checkpoint

Three sequential samples per route/profile/cache/URL-shape were run against
`3fce81d8.77-dominion-live.pages.dev` at the baseline SHA above, then
`99080616.77-dominion-live.pages.dev` at
`1c10bc06e4355d8fc1e47b2ef3a7c6b352f1ac2b`. Each matrix contains 168
navigations, with zero navigation errors. Every AFTER sample was below 2500 ms
LCP and .10 CLS. These are mock-only lab results, not production RUM or real API
round-trip evidence. The benchmark's desktop and 390×844 phone browser contexts
use default DPR 1; separate iPhone/WebKit tests cover responsive source selection.

| Clean, cold median | Before | After |
| --- | ---: | ---: |
| Phone Landing LCP | 23340 ms | 1280 ms |
| Phone Landing transfer | 4585242 bytes | 278945 bytes |
| Desktop Landing LCP | 3980 ms | 588 ms |
| Desktop Community CLS | .228466 | .028724 |
| Phone Community CLS | .293589 | .064647 |
| Phone Rewards CLS | .063914 | .004694 |

All eight deployed WebP candidates also matched their reviewed byte counts and
SHA-256 hashes, `image/webp` MIME type, and one-year immutable caching; HTML
returned `no-cache`. Reproduce the static verification with
`node scripts/verify-deployed-hero-artwork.mjs <immutable-preview-url> <verified-sha>`.
`summarize-deployed-performance.mjs` summarizes the raw before/after JSON matrices
without including payloads, credentials, tokens, or customer data. The subsequent
training-presentation split is a separate local checkpoint and is not included
in these deployed measurements.

## In-flight activation and training reads

`getChallengeActivation` and `getSiteTrainingState` now coalesce only concurrently
pending calls for the same actor, endpoint, contract version and server arguments.
Each settled result is immediately evicted; consumers receive independent copies.
There is no TTL/SWR store, local persistence, service worker, cached authorization,
or memoization of mutations. Real-wire reads keep the captured expected actor and
verify it with `getUser` before and after the shared RPC. A deterministic API
integration test verifies two concurrent consumers produce one activation RPC,
with both pre/post authentication checks retained; this is not a hosted latency
measurement or proof of production round-trip budgets.

Synchronous auth-event, sign-out, local login, cross-tab storage, offline/online and
visibility invalidation fences delayed responses with an epoch. A→B→A cannot reuse
an earlier A promise. Activation/group mutations clear pending reads before and
after completion, including failed responses. Training mutations invalidate only
the training query so they do not cancel an unrelated activation read. Read-only
mock membership canonicalization explicitly does not self-invalidate; real mock
membership mutations do. Authentication, reward entitlement, app-visit and
celebration-claim operations are not coalesced by this module.

The remaining app-visit/game-summary work must coordinate with FOU-1499's durable
badge-claim contract; do not memoize its claim or acknowledgement mutations. Domain
bootstrap, pagination, broader lifecycle/realtime invalidation and initial-graph
targets remain open. The in-flight primitive deliberately introduces no settled
cache while those full invalidation contracts are still being established.

## Deferred training presentation

Training-state hydration does not import the coachmark implementation or CSS.
The separate UI entry statically imports its stylesheet; Vite resolves both
before opening the first overlay. Controls remain visible and busy during this
load. A failed import starts no durable training mutation. Chromium and WebKit
cache failed module requests for the document, so clearing an application promise
cannot reliably retry. A failed JS/CSS load stays closed and both training controls
offer **Reload to load training** with visible save-your-work guidance. Reload
requires a second explicit confirmation, initially focused on **Keep editing**;
failure, onboarding handoff, focus, and reconnect never reload automatically.
There is no cache-busting import or draft/progress reset. The reload creates a new
document that can fetch the UI again; saved onboarding handoffs remain recoverable.
WebKit also retains a failed JavaScript `modulepreload` after a soft reload, even
for a real HTTP 503 with `Cache-Control: no-store`. The narrow
[`build.modulePreload.resolveDependencies`](https://vite.dev/config/build-options#build-modulepreload)
resolver removes only the controller/catalog and training UI dynamic JS preloads
from training imports, leaving native import, Vite's automatic CSS awaiting,
unrelated dependencies, and HTML preloads
unchanged. A loopback HTTP regression builds the actual loader/UI in memory and
verifies sticky failure then successful reload in Chromium and WebKit.
Actor epochs and a separate presentation generation discard delayed
opens after sign-out, an A→B→A cycle, dismissal or destruction. A dismissal during
an already-running successful mutation keeps its confirmed progress but does not
reopen the overlay. The menu is closed again immediately before creating/acquiring
the modal layer, covering a menu reopened while an import or request was pending.

This was a deliberately small presentation-only checkpoint. Training controller/state
code remained in the initial shared graph; that first local build saved
about 3.4 KB gzip, not the overall 40%/25% JS targets. It does not defer required
first-run onboarding or change the published training catalog or progress RPCs.

## Member training graph extraction (local checkpoint)

The menu now uses a tiny schema/route contract instead of importing the normalized
catalog just to read its schema version. A parity test keeps the fourteen-route
index equal to the published catalog. Visitors never load the controller/catalog
graph, including on public Science; authenticated members on supported routes
still load it immediately for durable first-run handoff/resume. The coachmark
implementation and styles remain a separate interaction/active-training load.
This is not an artificial delay of required member work or an API latency claim.

The regular menu is interactive before the optional graph arrives. Load status
and the same save-work/reload confirmation remain accessible on failure. Auth
changes, menu rehydration and pagehide fence stale import continuations; cached
public code cannot attach the old actor's controls or auto-open their training.
A restored back/forward document rehydrates the controls. No auth client, MFA
guard, settled private cache, training RPC, catalog content or progress contract
changed in this phase.

Explicit [Rolldown code-splitting groups](https://rolldown.rs/reference/TypeAlias.CodeSplittingGroup)
keep the existing shared menu dependencies and common styles together, while a
lower-priority group contains only the optional controllers/catalog and their
otherwise-unowned dependencies. Shared dialog CSS is packed with the menu styles
(the Invite page also receives the dialog styles its menu had previously omitted).
Existing CSS declarations are unchanged; the new reload action reuses the menu's
54 px button styling and hidden-state rules. The generated ESM runtime remains a
separate counted asset. No initial request budget was increased to accommodate
the split.

Canonical mock build comparison against `8f5bcc5`, using the same measurement
script and policy as above:

| Route | Checkpoint JS gzip | Extracted JS gzip | Initial graph requests |
| --- | ---: | ---: | ---: |
| Landing | 135059 | 123278 | 7 |
| Login | 137214 | 125432 | 7 |
| Dashboard | 152161 | 140417 | 7 |
| Rewards | 141779 | 129976 | 7 |
| Community | 160199 | 148455 | 8 |
| Profile | 141420 | 129623 | 6 |
| Bible reading | 140285 | 128500 | 6 |

The shared menu is 119460 gzip bytes; the deferred controller/catalog chunk is
14216 and coachmark UI is 4506. These optional bytes remain part of member runtime
work and are included in the all-chunk audit. Full-built loopback HTTP503 tests
cover both actual optional training chunks in Chromium and WebKit, including a
cancelled reload confirmation, successful explicit reload, exactly one new
request after reload, and style/focus readiness. The UI import must not preload
the already-loaded controller again: WebKit otherwise refetches it with no-store
responses. All other preloads and CSS waiting are preserved.

**This checkpoint is not deployed performance completion.** It still exceeds all
seven final JavaScript targets. Remaining work includes heavier API/domain module
boundaries, dashboard/daily-action request budgets and bounded history. The
deployed asset/layout timings above do not measure this later extraction; a new
pinned before/after run is required after root review and preview publication.

## Interim automated budgets

`pnpm run check:frontend-performance` audits a freshly built canonical mock preview
against `frontend-performance-budgets.json`. Initial JS ceilings are the pinned
baseline (no regression), CSS allows at most 2 KB gzip over that baseline for the
static trigger/layout fixes, and initial static request counts cannot grow.
Every JS chunk, including deferred chunks, is capped at 140 KB gzip. Sharing and
training UI/controller entry graphs must not become static dependencies. Image and font
budgets are enforced separately by the production asset verifier.

These interim checks intentionally print `targetsMet: false` while the 40% public
and 25% authenticated JS reductions remain unfinished. Before closing FOU-1501,
run `pnpm run check:frontend-performance -- --require-targets`; it must pass along
with deployed timing/API/accessibility requirements. Passing only the interim
regression ceiling does **not** mean the ticket is complete.

## References

Cache behavior follows [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)
and [serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).
Font generation uses the official [fontTools subset interface](https://fonttools.readthedocs.io/en/latest/subset/index.html).
Authoritative identity checks and synchronous invalidation follow Supabase's
[getUser](https://supabase.com/docs/reference/javascript/auth-getuser) and
[auth-state subscription](https://supabase.com/docs/reference/javascript/auth-onauthstatechange) contracts.
