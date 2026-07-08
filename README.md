# 77-Day Dominion Challenge

Responsive Vue 3 website for tracking the 77-Day Dominion Challenge with Supabase Auth and Postgres persistence.

## Stack

- Vue 3
- Composition API / composables
- Vite
- TypeScript
- Supabase Auth
- Supabase Postgres
- localStorage fallback for local UI preferences when Supabase env vars are not configured

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
5. In Supabase Auth URL Configuration, set the Site URL to the Cloudflare Pages production URL for this app and add local dev URLs for testing.
6. This project is deployed from the Cloudflare production branch only. Supabase redirect URLs do not need a preview branch entry.

The frontend uses Supabase Auth for login/register and writes directly to Supabase Postgres with Row Level Security policies.

## Billing and monetization

The app uses one subscription product:

- `Dominion Subscription` for `$7/month`

Stripe powers checkout and the customer portal. Supabase stores subscriptions and entitlements. App access is gated by the `membership_active` entitlement.

### Required Stripe setup

1. Create one recurring monthly Stripe price for the `$7/month` Dominion Subscription.
2. Set these Supabase function secrets:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_MEMBERSHIP_PRICE_ID`
   - `PUBLIC_SITE_URL`
3. Deploy the Edge Functions:
   - `create-checkout-session`
   - `create-customer-portal-session`
   - `stripe-webhook`
4. Point a Stripe webhook endpoint at the deployed `stripe-webhook` function and subscribe at minimum to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Run the updated `supabase/schema.sql` before testing billing flows.

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
