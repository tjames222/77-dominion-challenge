# Cloudflare Pages Setup

Connect this repo to Cloudflare Pages for the production frontend and develop-branch preview testing.

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

Cloudflare Preview environment variables are shared by `develop` and feature previews. Either configure **Builds & deployments → Preview branch controls** to include only `develop`, or expect feature previews to inherit the same real Supabase Auth tenant. A feature build with no Supabase values intentionally falls back to local-only identities; canonical `develop` fails its build instead.

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
