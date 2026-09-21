# Browser quality gate

The normal pull-request suite exercises the real Vite multi-page application
with Playwright and axe. It never uses Supabase, Stripe, production credentials,
or live customer data. A separate explicit local-production rehearsal uses only
the clean local Supabase stack and disposable test accounts.

## Local commands

Install the pinned browser once:

    pnpm install --frozen-lockfile
    pnpm exec playwright install chromium

Run the same gate as pull requests:

    pnpm test:e2e

Useful focused commands:

    pnpm exec playwright test --project=chromium-functional
    pnpm exec playwright test visual-routes.spec.mjs
    pnpm exec playwright show-report

Run the production-shaped local proof only after acknowledging that it resets
the repository's local Supabase database:

    DOMINION_ALLOW_LOCAL_RESET=true pnpm test:e2e:local-production

That command verifies the pinned local Postgres stack, replays every migration,
builds with `VITE_ENABLE_MOCKS=false`, and serves the built assets. It then uses
real local Auth and PostgREST to create an account, seed a disposable membership
directly into the reset local Postgres database, load authenticated routes, retain
Share and App Streak header controls, create private journal entries in two accounts,
and prove cross-account journal reads and updates are denied by RLS. The runner
rejects any non-local Supabase URL and never reads hosted credentials.

Normal pull-request runs compare screenshots and never rewrite their expected
images once Linux baselines are committed. The first branch run, when no
baseline PNG exists yet, generates the Ubuntu set and uploads it without
pretending a comparison occurred. Download the
`browser-visual-baselines-<sha>-<run>-<attempt>` artifact, review its PNGs under `snapshots/`
and its `verification.json`, then copy the approved `snapshots/` contents into
`tests/e2e/__snapshots__`; the next run is the strict gate. A pull request with
no committed baselines fails until those reviewed images are committed.
Generate intentionally changed baselines later by manually running **Browser
quality gate** with **Generate visual baselines** enabled. That generation path
uses Playwright's explicit `all` update mode, so every expected PNG is rewritten
even when a rendered change falls within the normal screenshot comparison
tolerance. The uploaded artifact is therefore a complete Linux baseline set,
not a mixture of newly rendered and stale images.

CI runs the unit/build and dedicated hybrid, MFA, Admin, and Daily Action gates
once, then partitions the unchanged main matrix across two standard Ubuntu
runners (two Playwright workers each, existing retries/timeouts). The required
**Routes, accessibility, and visuals** check is a fail-closed aggregate: both
shards and every preliminary gate must succeed. Failed, cancelled, or skipped
dependencies cannot produce a green aggregate.

The exact SHA/run/attempt plan records full discovery and both disjoint shard
inventories. Each generation runner moves its committed PNG tree aside before
running, so its output contains only fresh screenshots. Three-day
`browser-shard-*` artifacts are staging evidence, **never adoption artifacts**.
The aggregate verifies every expected test outcome, every staged PNG hash,
the complete committed-path union, and byte equality for any duplicate path
before publishing the 14-day combined artifact. Missing shards, traversal,
symlinks, corrupt/truncated files, stale identities, or conflicting pixels fail
closed. Normal successful comparison runs stage manifests only, not PNGs.
PNG validation accepts bounded, non-interlaced RGB8/RGBA8 browser captures,
checks every chunk CRC and exact inflated scanline length, then decodes with
the already-pinned Playwright PNG decoder. All current committed PNGs are RGB8.
If a screenshot is intentionally removed, remove its obsolete committed PNG
in the same change; otherwise generation correctly rejects the missing path.
Use **Re-run all jobs** after a failed attempt: the evidence intentionally binds
to a single attempt and cannot reuse a successful preflight from an older one.

For local iteration only, update baselines with:

    pnpm exec playwright test visual-routes.spec.mjs --update-snapshots=all

Do not commit macOS-generated baselines: font rasterization and native controls
can differ from the Linux comparison environment.

## Coverage model

- support/routes.mjs is the source of truth for production HTML entries.
  contracts.spec.mjs fails when Vite gains an entry without a browser route.
- support/fixtures.mjs owns fixed auth, theme, date, billing, points, badges,
  rewards, private groups, and submitted-check-in data.
- functional.spec.mjs covers route guards, keyboard navigation, forms, and
  daily actions.
- accessibility.spec.mjs blocks serious and critical WCAG 2.0/2.1 A/AA axe
  violations.
- states.spec.mjs covers loading, empty, error, locked, unlocked, submitted,
  validation, and open-navigation states.
- menu-layers.spec.mjs checks real drawer/backdrop hit-testing, covered-page
  isolation, Safari keyboard cycling, scroll locking and sticky restoration in
  all four themes at phone, tablet, and desktop widths. It runs in Chromium and
  the focused mobile WebKit project; open Rewards/Badges captures also join the
  Linux visual matrix.
- visual-routes.spec.mjs captures every route at 390x844, 768x1024, and
  1440x1000 in each enabled theme.
- first-paint.spec.mjs checks the selected root theme and browser
  color-scheme at first contentful paint.
- share-composer-routes.spec.mjs opens the shared composer on all 16 authenticated
  header routes at clean URLs and after hard refresh, verifies computed component
  styles, and covers delayed CSS, four themes, text zoom, and keyboard/axe checks
  in Chromium and WebKit. The mobile visual matrix includes Dashboard, Rewards,
  and Journal composer baselines, including Dominion Platinum.
- regression-sensitivity.spec.mjs proves controlled accessibility and visual
  changes are rejected while the test itself remains green.
- local-production-stack.spec.mjs is outside the normal mock suite and proves a
  built, mocks-off client against real local Auth/Postgres with two disposable
  accounts and owner-only journal RLS.

Screenshots disable motion and carets, freeze the clock, use UTC, replace
external images with a local SVG response, and block all other external
requests. The app bundles its Inter variable brand font from upstream commit
`353b61b9f4430d5f420d56605a6e7993e0941470`, with its SIL Open Font License
copied into the production build at `fonts/Inter-LICENSE.txt`. The build fails
if either the font or its license is absent. The screenshot harness waits for
that same production face instead of substituting a test-only family. This prevents Linux
runner font-package changes from altering text metrics and full-page screenshot
heights while keeping visual tests faithful to production. Failed runs retain a
trace, screenshot timeline, HTML report, and Playwright image diff in one
short-lived CI artifact. Standalone CI videos are disabled because a broad
visual failure can otherwise exceed the repository's artifact storage quota;
local runs still retain failure videos for debugging.

## Adding a route or feature assertion

1. Add the HTML entry to PRODUCTION_ROUTES.
2. Add a named state to APP_STATES if the surface needs distinct data.
3. Add selectors to that route's ROUTE_ASSERTION_EXTENSIONS entry.
4. Put interaction assertions in the functional or state spec; the route
   automatically joins the responsive visual and accessibility matrices.

This is the extension contract for the card-reduction, rewards, streak,
dedicated-action, sharing, community-integration, and theme tickets.

## Dominion Night matrix

Every production route is captured in Light, Dark, and the entitlement-gated
`dominion-night` theme. The browser server enables
`VITE_ENABLE_DOMINION_NIGHT_THEME=true`, and authenticated fixtures provide
the permanent reward ownership and server-style theme preference needed to
hydrate it. Public pages use that authenticated fixture only for their Night
captures; their normal Light and Dark contracts remain logged out.

`E2E_STRICT_THEME_BOOTSTRAP=true` requires public themes to be correct before
hydration and at first contentful paint. Dominion Night intentionally begins
with the safe Dark fallback until account ownership is verified, so its gate
asserts the final theme, dark browser color scheme, and absence of any later
reversion.
