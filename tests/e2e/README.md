# Browser quality gate

This suite exercises the real Vite multi-page application with Playwright and
axe. It never uses Supabase, Stripe, production credentials, or live customer
data.

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

Normal pull-request runs compare screenshots and never rewrite their expected
images once Linux baselines are committed. The first branch run, when no
baseline PNG exists yet, generates the Ubuntu set and uploads it without
pretending a comparison occurred. Download the
`browser-visual-baselines-<sha>` artifact, review its PNGs, and commit the
approved `tests/e2e/__snapshots__` directory; the next run is the strict gate.
Generate intentionally changed baselines later by manually running **Browser
quality gate** with **Generate visual baselines** enabled. That generation path
uses Playwright's explicit `all` update mode, so every expected PNG is rewritten
even when a rendered change falls within the normal screenshot comparison
tolerance. The uploaded artifact is therefore a complete Linux baseline set,
not a mixture of newly rendered and stale images.

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
- visual-routes.spec.mjs captures every route at 390x844, 768x1024, and
  1440x1000 in each enabled theme.
- first-paint.spec.mjs checks the selected root theme and browser
  color-scheme at first contentful paint.
- regression-sensitivity.spec.mjs proves controlled accessibility and visual
  changes are rejected while the test itself remains green.

Screenshots disable motion and carets, freeze the clock, use UTC, replace
external images with a local SVG response, and block all other external
requests. They also use the bundled Inter variable font from upstream commit
`353b61b9f4430d5f420d56605a6e7993e0941470`, with its SIL Open Font License
kept beside the asset. This prevents Linux runner font-package changes from
altering text metrics and full-page screenshot heights. Failed runs retain a
trace, screenshot, video, HTML report, and Playwright image diff in the CI
artifact.

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
