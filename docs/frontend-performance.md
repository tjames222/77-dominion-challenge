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
These changes still require a pinned deployed remeasurement; no local geometry
test is presented as proof of final LCP/CLS gates.

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

## References

Cache behavior follows [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)
and [serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).
Font generation uses the official [fontTools subset interface](https://fonttools.readthedocs.io/en/latest/subset/index.html).
Authoritative identity checks and synchronous invalidation follow Supabase's
[getUser](https://supabase.com/docs/reference/javascript/auth-getuser) and
[auth-state subscription](https://supabase.com/docs/reference/javascript/auth-onauthstatechange) contracts.
