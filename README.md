# 77-Day Dominion Challenge

Responsive Vue 3 website for tracking the 77-Day Dominion Challenge with Supabase Auth and Postgres persistence.

## Stack

- Vue 3
- Composition API / composables
- Vite
- TypeScript
- Supabase Auth
- Supabase Postgres
- localStorage for local UI preferences and preview-only mock workflow state

## Run locally

```bash
npm install
npm run dev
```

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

### Workout difficulty scoring

Workout completions receive the standard 10 action points plus a configurable difficulty bonus. The default bonuses are Easy `2`, Medium `5`, Hard `10`, and Extreme `15` points.

Production values live in `public.workout_difficulty_point_values`. A trusted operator can rebalance future check-ins from the Supabase Table Editor or with the service role; no frontend deployment is required. Existing point events are historical records and are not recalculated when configuration changes.

## Deployment workflow

- `main` is production and must use real Supabase Auth, Postgres, and Stripe billing.
- `develop` is the Cloudflare Pages preview branch and should set `VITE_ENABLE_MOCKS=true` so auth, membership, dashboard, community, and journal flows use local mock state instead of Supabase or Stripe.
- Production should not set `VITE_ENABLE_MOCKS`; the default is `false`.
- Local Vite dev on localhost also enables mock mode for rapid UI testing.

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

## Build

```bash
npm run build
```

## Challenge standards

- Bible reading: 5–8 chapters
- Morning prayer
- Evening prayer
- Worship music only
- Workout #1
- Intentional walk
- Workout #2

Scheduled miss days are supported when planned ahead.
