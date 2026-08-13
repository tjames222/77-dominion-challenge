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
| `forgot-password.html` | Password reset request | `src/static/password-recovery.js` |
| `reset-password.html` | Password recovery completion | `src/static/password-recovery.js` |
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
| `community.html` | Private-group community | `src/static/community.js` |
| `group-settings.html` | Private-group settings, privacy, and access | `src/static/group-settings.js` |
| `private-journal.html` | Private journal | `src/static/private-journal.js` |
| `profile.html` | Account and appearance settings | `src/static/profile.js` |
| `science.html` | Challenge background and sources | `src/static/science.js` |
| `privacy.html` | Privacy policy | `src/static/legal.js` |
| `terms.html` | Terms of use | `src/static/legal.js` |
| `cancellation-refunds.html` | Cancellation and refund policy | `src/static/legal.js` |
| `support.html` | Support and contact paths | `src/static/legal.js` |

Shared browser modules live in `src/static/`. Shared visual tokens and page styles live in `src/assets/`. `src/static/api.js` owns the browser-facing Supabase and preview-mock boundary. Supabase migrations, the cumulative schema, and Edge Functions live under `supabase/` and are deployed separately from the Vite bundle. The retired `today-actions.html` URL is served as a static redirect from `public/` and is intentionally excluded from the active Vite entry-point map.

## Run locally

```bash
pnpm install
pnpm dev
```

Local Vite development automatically uses the browser-local preview workflow. Any hosted build with `VITE_ENABLE_MOCKS=true` keeps identities, product data, billing, and provider connections browser-local even if production variables are accidentally visible to the build. Local `vite` sessions may exercise the isolated Auth fixture only when `VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS=true` is explicitly set with mock Supabase values; that override is ignored by production builds.

Slack and Discord connection controls fail closed unless `VITE_ENABLE_GROUP_INTEGRATIONS=true`. Keep the flag false until the complete provider rollout in FOU-764 is approved; when it is false, the browser does not expose provider controls or call provider-management functions.

## Supabase setup

1. Create a Supabase project.
2. For local development, run `pnpm run supabase:start` and `pnpm run supabase:reset` so the versioned migration chain is applied from an empty database.
3. For a hosted environment, follow the migration reconciliation and deployment steps in [`docs/backend-release-runbook.md`](docs/backend-release-runbook.md). Never run `supabase/schema.sql` manually or use `--include-all` against production.
4. Copy `.env.example` to `.env`.
5. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
6. In the hosted Supabase Auth URL Configuration, set the Site URL to the exact Cloudflare Pages production URL for this app.
7. Add only the exact password-recovery callback to the hosted project's
   redirect allowlist:
   - `https://77-dominion-challenge.pages.dev/reset-password.html`

The local Supabase stack may keep localhost callbacks in its local configuration.
Do not add `develop`, feature-preview, or localhost callbacks to the hosted
production Auth tenant.

The frontend uses Supabase Auth for login/register and writes directly to Supabase Postgres with Row Level Security policies.

Password recovery always returns to the fixed same-origin `reset-password.html`
route. Add that exact production path to the Auth redirect allowlist, verify
custom SMTP delivery, and test expired, reused, and valid recovery links before
launch. Recovery completion revokes the recovery session and requires a fresh
login.

### Storage

The browser prepares supported profile photos, then an authenticated Edge
Function independently decodes, center-crops, strips, and re-encodes them as
square WebP thumbnails no larger than 256×256 pixels and 150 KiB. Only that
trusted output can enter Storage; source camera bytes and direct browser uploads
cannot. Upload paths are immutable, and a durable lifecycle registry retries
removal of non-canonical predecessors without allowing the current avatar to be
deleted or a retired path to be reused. The Private Journal is text-only and
does not require a `journal_photos` table or `journal-progress` bucket.

### Point economy

Each of the seven Daily Standards awards exactly one point, for a maximum of seven Daily Standard points per active challenge day. The authoritative point sources, reward reachability, and migration contract are documented in [`docs/point-economy.md`](docs/point-economy.md).

### Private-group invitations

Private-group links open a dedicated preview and confirmation page. They survive login, registration, and membership activation without putting the invite secret in an auth redirect, and opening a link never auto-joins the recipient. Issuance, rotation, revocation, expiry, one-time redemption, capacity, and inviter attribution are enforced by database RPCs. See [docs/private-group-invites.md](docs/private-group-invites.md) for the security contract and test matrix.

### Workout difficulty

Workout difficulty describes the work performed and never changes points. Historical difficulty-bonus ledger rows remain immutable, but new Check-Ins award one point for each completed workout standard regardless of difficulty.

## Deployment workflow

- `main` is production and must use real Supabase Auth, Postgres, and Stripe billing.
- `https://develop.77-dominion-challenge.pages.dev` is the canonical prelaunch dev URL. The bare `https://77-dominion-challenge.pages.dev` host follows `main` and must not be treated as the current dev deployment.
- `develop` must set only `VITE_ENABLE_MOCKS=true` for backend selection. Login, registration, membership, billing, dashboard, community, journal, and provider connections remain browser-local and never call Supabase or Stripe.
- Production must resolve `VITE_ENABLE_MOCKS` to `false`; `main` builds fail closed if mocks are enabled.
- Local Vite dev on localhost enables browser-local product data for rapid UI testing. It uses local mock identities unless `VITE_ENABLE_MOCKS=true`, `VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS=true`, and valid Supabase public configuration are all supplied explicitly.
- Canonical `develop` builds fail unless mock mode is enabled and hybrid Auth is disabled. Canonical `main` builds fail unless mock mode is disabled and the production Supabase URL/publishable key are present.

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
6. Apply the reviewed migration chain through the release workflow before testing hosted billing flows. For local billing tests, reset the local Supabase stack so every migration is replayed.

## Data lifecycle decisions

- [Retired Community social-data retention](docs/community-social-data-retention.md)
- [Governed retired Community deletion runbook](docs/retired-community-deletion-runbook.md)
- [Account lifecycle and policy release gate](docs/account-lifecycle-release.md)

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
