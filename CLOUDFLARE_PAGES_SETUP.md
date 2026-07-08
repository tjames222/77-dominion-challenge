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
- VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are optional in preview because mock mode ignores Supabase and Stripe.

Branch workflow:

- main = production with real Supabase Auth, Postgres, and Stripe billing
- develop = preview deployment with mock auth, mock membership, mock community, and mock journal state
- feature branches = local/PR work only unless you intentionally enable previews later

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

Authentication and challenge data are backed by Supabase Auth and Postgres in production. Preview builds set `VITE_ENABLE_MOCKS=true`, which disables Supabase/Stripe calls and uses local mock state so the full user flow can be tested without real billing. Production must leave mocks disabled.
