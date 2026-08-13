# Cloudflare Pages Setup

Cloudflare Pages is the only frontend host for this app. GitHub Actions owns the
production release order; the Cloudflare Git integration remains useful for the
`develop` preview only.

Recommended settings:

- Project name: 77-dominion-challenge
- Production branch: main
- Framework preset: Vite
- Build command: npm run build
- Build output directory: dist
- Root directory: /
- Production environment variables:
  - VITE_SUPABASE_URL
  - VITE_SUPABASE_PUBLISHABLE_KEY
  - VITE_ENABLE_MOCKS=false

Preview environment variables:

- VITE_ENABLE_MOCKS=true

Do not configure Supabase, Stripe, or provider values in the Preview environment. Production-built previews use browser-local identities and browser-local product data. The runtime refuses to construct a Supabase client while mock mode is active, even if a production variable is accidentally inherited.

Branch workflow:

- main = production with real Supabase Auth, Postgres, and Stripe billing
- develop = prelaunch dev deployment with mock identities, data, billing, and provider connections
- feature branches = Cloudflare preview deployments when Pages preview-branch controls allow them

## Required production branch control

Before merging the first release to `main`, open **Workers & Pages →
77-dominion-challenge → Settings → Builds → Branch control** and turn off
**Enable automatic production branch deployments**. This prevents Cloudflare
from publishing the frontend as soon as `main` moves, before migrations and Edge
Functions have passed verification. Keep preview deployment controls limited to
`develop`.

The protected GitHub `Release production` workflow builds one immutable artifact
and deploys it to this existing Pages project only after validation, migrations,
Function deployment, and backend smoke checks succeed. Configure these GitHub
`production` environment secrets:

- `CLOUDFLARE_API_TOKEN` — least-privilege token allowed to deploy this Pages project
- `CLOUDFLARE_ACCOUNT_ID` — account that owns the Pages project

Do not re-enable automatic production deployments. A frontend-only rollback is a
manual dispatch of the protected workflow from a known backend-compatible commit.

Cloudflare Preview environment variables are shared by `develop` and feature previews. Configure **Builds → Branch control → Preview branch** to include only `develop`. Canonical `develop` requires mock mode and rejects the hybrid-Auth override; it does not require or use a hosted Supabase project.

Supabase Auth must allow both production and preview callbacks:

- `https://77-dominion-challenge.pages.dev/**`
- `https://*.77-dominion-challenge.pages.dev/**`
- `http://localhost:5173/**`
- `http://127.0.0.1:5173/**`
- `http://localhost:4173/**`
- `http://127.0.0.1:4173/**`

Supabase Edge Functions allow the production host and Cloudflare preview subdomains for this Pages project. Set these function secrets:

- `PUBLIC_SITE_URL=https://77-dominion-challenge.pages.dev`
- `CLOUDFLARE_PAGES_PROJECT_HOST=77-dominion-challenge.pages.dev`
- `PUBLIC_ALLOWED_SITE_URLS=https://77-dominion-challenge.pages.dev`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_MEMBERSHIP_PRICE_ID`

Authentication and challenge data are backed by Supabase Auth and Postgres only on `main`. Preview builds set `VITE_ENABLE_MOCKS=true`, which disables Supabase client construction and Stripe/provider calls. Production must leave mocks disabled.

The canonical prelaunch dev URL is `https://develop.77-dominion-challenge.pages.dev`. The bare Pages hostname follows `main`; it is not the current dev target and must not be shared for prelaunch testing.
