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
- VITE_SUPABASE_URL
- VITE_SUPABASE_PUBLISHABLE_KEY

Production-built previews use Supabase Auth for real login, registration, sessions, and logout whenever the public configuration is present. `VITE_ENABLE_MOCKS=true` isolates product data and billing in browser-local, UUID-scoped preview state, so preview testing cannot call Stripe or mutate Supabase application tables. These accounts are real rows in the configured Supabase Auth tenant even though their product data is local.

Branch workflow:

- main = production with real Supabase Auth, Postgres, and Stripe billing
- develop = prelaunch dev deployment with real Supabase Auth plus mock membership, community, journal, and other product state
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

Cloudflare Preview environment variables are shared by `develop` and feature previews. Configure **Builds → Branch control → Preview branch** to include only `develop`; otherwise feature previews inherit the same real Supabase Auth tenant. A feature build with no Supabase values intentionally falls back to local-only identities; canonical `develop` fails its build instead.

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

Authentication and challenge data are backed by Supabase Auth and Postgres in production. Preview builds set `VITE_ENABLE_MOCKS=true`, which keeps Supabase Auth enabled when public configuration is present while disabling Supabase application-data and Stripe calls. Production must leave mocks disabled.

The canonical prelaunch dev URL is `https://develop.77-dominion-challenge.pages.dev`. The bare Pages hostname follows `main`; it is not the current dev target and must not be shared for prelaunch testing.
