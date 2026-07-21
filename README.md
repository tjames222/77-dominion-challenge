# 77-Day Dominion Challenge

Static multi-page application for tracking the 77-Day Dominion Challenge with Supabase Auth and Postgres persistence.

## Stack

- HTML, CSS, and browser-native JavaScript
- Vite multi-page build
- Supabase Auth
- Supabase Postgres
- localStorage for local UI preferences and preview-only mock workflow state

## Application architecture

The deployed frontend is a Vite multi-page application (MPA). It has no client-side framework mount or catch-all application route. Each customer-facing page is a root HTML entry declared once in `app-entrypoints.mjs`, which is consumed by both the Vite build and the entry-point test.

| Entry | Purpose | Page module |
| --- | --- | --- |
| `index.html` | Marketing landing page | `src/static/landing.js` |
| `membership.html` | Membership offer | `src/static/membership.js` |
| `login.html` | Sign in | `src/static/auth.js` |
| `register.html` | Registration | `src/static/auth.js` |
| `invite.html` | Private-group invitation confirmation | `src/static/invite.js` |
| `billing.html` | Subscription management | `src/static/billing.js` |
| `dashboard.html` | Daily challenge dashboard | `src/static/dashboard.js` |
| `badges-rewards.html` | Badges, rewards, and entitlement state | `src/static/badges-rewards.js` |
| `bible-reading.html` | Bible reading Daily Standard | `src/static/daily-standard-page.js` |
| `morning-prayer.html` | Morning prayer Daily Standard | `src/static/daily-standard-page.js` |
| `worship.html` | Worship Daily Standard | `src/static/daily-standard-page.js` |
| `evening-prayer.html` | Evening prayer Daily Standard | `src/static/daily-standard-page.js` |
| `workout-one.html` | First workout Daily Standard | `src/static/daily-standard-page.js` |
| `intentional-walk.html` | Intentional walk Daily Standard | `src/static/daily-standard-page.js` |
| `workout-two.html` | Second workout Daily Standard | `src/static/daily-standard-page.js` |
| `community.html` | Community, groups, and journal | `src/static/community.js` |
| `profile.html` | Account and appearance settings | `src/static/profile.js` |
| `science.html` | Challenge background and sources | `src/static/science.js` |

Shared browser modules live in `src/static/`. Shared visual tokens and page styles live in `src/assets/`. `src/static/api.js` owns the browser-facing Supabase and preview-mock boundary. Supabase migrations, the cumulative schema, and Edge Functions live under `supabase/` and are deployed separately from the Vite bundle. The retired `today-actions.html` URL is served as a static redirect from `public/` and is intentionally excluded from the active Vite entry-point map.

## Run locally

```bash
pnpm install
pnpm dev
```

Local Vite development automatically uses the preview mock workflow. To exercise the explicit preview behavior in another environment, set `VITE_ENABLE_MOCKS=true`.

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env`.
4. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
5. In Supabase Auth URL Configuration, set the Site URL to the Cloudflare Pages production URL for this app.
6. Add redirect URLs for production, Cloudflare preview deployments, and local development:
   - `https://77-dominion-challenge.pages.dev/**`
   - `https://*.77-dominion-challenge.pages.dev/**`
   - `http://localhost:5173/**`
   - `http://127.0.0.1:5173/**`
   - `http://localhost:4173/**`
   - `http://127.0.0.1:4173/**`

The frontend uses Supabase Auth for login/register and writes directly to Supabase Postgres with Row Level Security policies.

### Point economy

Each of the seven Daily Standards awards exactly one point, for a maximum of seven Daily Standard points per active challenge day. The authoritative point sources, reward reachability, and migration contract are documented in [`docs/point-economy.md`](docs/point-economy.md).

### Private-group invitations

Private-group links open a dedicated preview and confirmation page. They survive login, registration, and membership activation without putting the invite secret in an auth redirect, and opening a link never auto-joins the recipient. Issuance, rotation, revocation, expiry, one-time redemption, capacity, and inviter attribution are enforced by database RPCs. See [docs/private-group-invites.md](docs/private-group-invites.md) for the security contract and test matrix.

### Workout difficulty

Workout difficulty describes the work performed and never changes points. Historical difficulty-bonus ledger rows remain immutable, but new Check-Ins award one point for each completed workout standard regardless of difficulty.

## Deployment workflow

- `main` is production and must use real Supabase Auth, Postgres, and Stripe billing.
- `develop` is the Cloudflare Pages preview branch and should set `VITE_ENABLE_MOCKS=true` so auth, membership, dashboard, community, and journal flows use local mock state instead of Supabase or Stripe.
- Production should not set `VITE_ENABLE_MOCKS`; the default is `false`.
- Local Vite dev on localhost also enables mock mode for rapid UI testing.

### Feature-flagged Dominion Night theme

The alternate dark visual profile is registered as `dominion-night` and remains
hidden unless `VITE_ENABLE_DOMINION_NIGHT_THEME=true`. The rollout flag controls
availability, while permanent reward entitlement controls whether an authenticated
user may select it in Profile. Its palette, asset behavior, contrast checks, and
route audit are documented in `docs/dominion-night-theme-audit.md`.

## Billing and monetization

The app uses one subscription product:

- `Dominion Subscription` for `$7/month`

Stripe powers checkout, payment method updates, and membership cancellation. Supabase stores subscriptions and entitlements. App access is gated by the `membership_active` entitlement.

### Required Stripe setup

1. Create one recurring monthly Stripe price for the `$7/month` Dominion Subscription.
2. Set these Supabase function secrets:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_MEMBERSHIP_PRICE_ID`
   - `PUBLIC_SITE_URL`
   - `CLOUDFLARE_PAGES_PROJECT_HOST`
   - `PUBLIC_ALLOWED_SITE_URLS`
3. Configure the Stripe customer portal to allow payment method updates.
4. Deploy the Edge Functions:
   - `create-checkout-session`
   - `create-customer-portal-session`
   - `cancel-membership`
   - `stripe-webhook`
5. Point a Stripe webhook endpoint at the deployed `stripe-webhook` function and subscribe at minimum to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
6. Run the updated `supabase/schema.sql` before testing billing flows.

## Data lifecycle decisions

- [Retired Community social-data retention](docs/community-social-data-retention.md)
- [Governed retired Community deletion runbook](docs/retired-community-deletion-runbook.md)

## Validation and build

```bash
pnpm test
pnpm build
```

The test suite verifies that every root HTML file is either an active production entry or an approved retired-route redirect. The build emits every active entry and its shared assets; no dormant Vue prototype code is compiled.

## Browser quality gate

Pull requests run deterministic Playwright coverage for every production HTML
entry, authenticated route guards, keyboard interactions, axe accessibility,
responsive screenshots, and first-paint theme behavior.

    pnpm exec playwright install chromium
    pnpm test:e2e

See [the browser test guide](./tests/e2e/README.md) for fixtures, visual
baseline updates, failure artifacts, and the FOU-556 alternate-theme handoff.

## Challenge standards

- Bible reading: 5–8 chapters
- Morning prayer
- Evening prayer
- Worship music only
- Workout #1
- Intentional walk
- Workout #2

Days without a submitted Check-In count as missed days.
