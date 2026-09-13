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
- Everyday Latin/punctuation/arrows/UI-symbol font traffic is 80132 bytes,
  77.3% below the original. The original font is unchanged and fetched only for
  its complementary extended-language glyph ranges. This is the documented
  100 KB exception for user text needing those glyphs, not lost language support.
  Unsupported emoji are excluded from both advertised ranges and use fallback.

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

## References

Cache behavior follows [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)
and [serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).
Font generation uses the official [fontTools subset interface](https://fonttools.readthedocs.io/en/latest/subset/index.html).
