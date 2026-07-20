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
images. Generate intentionally changed baselines on the same Ubuntu image as
CI by manually running **Browser quality gate** with **Generate visual
baselines** enabled. Download the `browser-visual-baselines-<sha>` artifact,
review its PNGs, and commit the approved `tests/e2e/__snapshots__` directory.

For local iteration only, update baselines with:

    pnpm exec playwright test visual-routes.spec.mjs --update-snapshots

Do not commit macOS-generated baselines: font rasterization and native controls
can differ from the Linux comparison environment.

## Coverage model

- support/routes.mjs is the source of truth for production HTML entries.
  contracts.spec.mjs fails when Vite gains an entry without a browser route.
- support/fixtures.mjs owns fixed auth, theme, date, billing, points, badges,
  rewards, groups, posts, and submitted-check-in data.
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
requests. Failed runs retain a trace, screenshot, video, HTML report, and
Playwright image diff in the CI artifact.

## Adding a route or feature assertion

1. Add the HTML entry to PRODUCTION_ROUTES.
2. Add a named state to APP_STATES if the surface needs distinct data.
3. Add selectors to that route's ROUTE_ASSERTION_EXTENSIONS entry.
4. Put interaction assertions in the functional or state spec; the route
   automatically joins the responsive visual and accessibility matrices.

This is the extension contract for the card-reduction, rewards, streak,
dedicated-action, sharing, community-integration, and theme tickets.

## Alternate theme handoff (FOU-556)

The alternate theme's stable key is intentionally not guessed here. Set
E2E_ALT_THEME_ID to the registry key introduced by FOU-556. The Playwright
configuration then adds the mobile, tablet, and desktop alternate-theme
projects and passes these preview variables to Vite:

- VITE_ENABLE_ALTERNATE_THEME=true
- VITE_ALTERNATE_THEME_ID=<stable key>

Set the GitHub Actions repository variable E2E_ALT_THEME_ID to activate that
column in pull requests. Set E2E_STRICT_THEME_BOOTSTRAP=true after FOU-556's
early bootstrap is merged; compatibility mode verifies the final theme and
rejects a post-paint reversion, while strict mode also requires the requested
theme before hydration and at first contentful paint. The alternate theme must
map to browser color-scheme: dark.

FOU-546 can then add its CSS and route-level assertions without creating test
infrastructure.
