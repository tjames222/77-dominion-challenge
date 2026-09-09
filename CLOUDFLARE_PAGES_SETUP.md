# Cloudflare Pages Setup

Cloudflare Pages is the only frontend host for this app. GitHub Actions owns the
production release order. A Git-integrated project may build the `develop`
preview automatically; a Direct Upload project uses the dedicated protected
`Deploy develop mock preview` workflow instead.

Recommended settings:

- Project name: the exact GitHub `CLOUDFLARE_PAGES_PROJECT` production variable
  (`77-dominion-live` for the production project)
- Canonical production domain: `https://77dominion.com`, attached to that same
  existing Pages project; `https://www.77dominion.com` and
  `https://77-dominion-live.pages.dev` remain supported
- Production branch: main
- Framework preset: Vite
- Build command: npm run build
- Build output directory: dist
- Root directory: /
- Production environment variables: only the exact public Node/pnpm pins,
  production Supabase URL/publishable key, and reviewed safe-off frontend flags
  enforced by the policy workflow. The protected GitHub `production`
  environment still supplies those values while building the immutable artifact;
  no server credential belongs in Cloudflare.

Preview environment variables:

- VITE_ENABLE_MOCKS=true
- VITE_ENABLE_BILLING=false
- VITE_ENABLE_PUBLIC_SIGNUP=false

Do not configure Supabase, Stripe, worker, production-origin, Slack, Discord, or external resource/handoff values in the Preview environment, and do not enable hybrid Auth, production connections, or provider connections. Canonical `develop` builds reject those values. The runtime also refuses to construct a Supabase client while mock mode is active.

Branch workflow:

- main = production with real Supabase Auth and Postgres; billing and public
  signup remain disabled for the closed canary
- develop = prelaunch dev deployment with mock identities, data, billing, and provider connections
- feature branches = no hosted deployment; local/CI preview only

## Required production branch control

Keep the existing reviewed Direct Upload target, `77-dominion-live`. Do not
create, replace, or switch Cloudflare projects without explicit user approval;
adding the approved apex and `www` custom domains does not require a new project.
The protected **Configure Cloudflare Pages policy** workflow verifies that the
existing project has no Git source. Its historical one-time
`create_missing_project` capability is not standing approval to create or replace
a project. The production release workflow itself never creates a project.
If the project is ever converted to Git integration,
open **Workers & Pages → 77-dominion-live → Settings → Builds → Branch control**
and turn off **Enable automatic production branch deployments**. This prevents
Cloudflare from publishing the frontend as soon as `main` moves, before
migrations and Edge Functions have passed verification. Keep preview deployment
controls limited to `develop`.

Remove every unapproved production `VITE_*` variable from Cloudflare. The policy
workflow writes only the exact reviewed production values and safe-off flags. If
automatic Git deployment is accidentally re-enabled, the project remains
configured for live Supabase with mocks, billing, integrations, and public signup
hard-off, but the policy verification still fails because automatic production
deployment is forbidden.

The protected GitHub `Release production` workflow builds one immutable artifact
and deploys it to this existing Pages project only after validation, migrations,
Function deployment, and backend smoke checks succeed. Configure these GitHub
`production` environment secrets:

- `CLOUDFLARE_API_TOKEN` — least-privilege token allowed to deploy this Pages project
- `CLOUDFLARE_ACCOUNT_ID` — account that owns the Pages project

Configure the non-secret `CLOUDFLARE_PAGES_PROJECT` production variable to the
exact project name. The production workflow refuses an empty or malformed name
and never creates a missing project.

For a Direct Upload project, create a separate GitHub `cloudflare-preview`
environment restricted to the protected `develop` branch. Store only the same
least-privilege `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets plus
the non-secret `CLOUDFLARE_PAGES_PROJECT` variable there. Its build job receives
no Cloudflare, Supabase, or Stripe credential; only the second job can upload
the already-built mock artifact. Preview artifacts expire after one day.

Do not re-enable automatic production deployments. A frontend-only rollback is a
manual dispatch of the protected workflow from a known backend-compatible commit.

For a Git-integrated project, Cloudflare Preview environment variables are shared
by preview branches. Configure **Builds → Branch control → Preview branch** to
include only `develop`. A Direct Upload project instead receives the same exact
mock flags from the protected preview workflow. Canonical `develop` requires mock
mode and rejects the hybrid-Auth override, production-connection opt-in, provider
enablement, and every known live backend/provider value; it does not require or
use a hosted Supabase project.

## Production domains, sharing, and Auth

Attach both `77dominion.com` and `www.77dominion.com` to the existing
`77-dominion-live` Pages project. Verify HTTPS, `login.html`, and
`reset-password.html` on both custom domains before changing the canonical Auth
URL. Keep the existing Pages hostname available. Do not force redirects between
these three origins as part of this configuration change: existing Pages and
`www` sessions and links must remain usable. Browser sessions stay scoped to
their original origin, so users may need to sign in when they first use the apex.

The existing **Configure Cloudflare Pages policy** workflow has a separate,
explicit `configure_custom_domain=true` mode. Keep `create_missing_project=false`.
This mode verifies the existing project, active `www` binding, and active
same-account zone; it only adds a missing apex binding and a missing proxied
CNAME to `77-dominion-live.pages.dev`. It refuses conflicting routing records
instead of overwriting them and leaves mail records and `www` unchanged. The
token needs Pages Write plus Zone Read and DNS Read/Write for this exact account
and zone. A pending certificate is reported as pending, not as a live domain.

Set the hosted Supabase Auth Site URL to `https://77dominion.com` and allow
exactly these production password-recovery callbacks:

- `https://77dominion.com/reset-password.html`
- `https://www.77dominion.com/reset-password.html`
- `https://77-dominion-live.pages.dev/reset-password.html`

Keep localhost callbacks only in the local Supabase stack. Do not allow
`develop`, feature-preview, localhost, or wildcard callbacks in the hosted Auth
tenant. The allowlist must contain all three exact callbacks, without duplicates
or extra entries; its order does not matter. The frontend already requests a
same-origin recovery callback, preserving existing links on all three origins.
The protected **Configure production Supabase Auth canary** workflow applies
and GET-verifies those two URL fields together with closed signup and
anonymous access; it does not copy or rewrite any provider, SMTP, template,
user, or session configuration.

Supabase Edge Functions allow only exact origins configured below. Keep the
GitHub `production` variables `PUBLIC_SITE_URL` and `PUBLIC_ALLOWED_SITE_URLS`
matched to these Function secrets so later releases cannot restore stale domain
configuration:

- `BILLING_ENABLED=false`
- `PUBLIC_SITE_URL=https://77dominion.com`
- `PUBLIC_ALLOWED_SITE_URLS=https://77dominion.com,https://www.77dominion.com,https://77-dominion-live.pages.dev`

The CORS helper also accepts the compatibility alias `ALLOWED_SITE_ORIGINS`.
If that secret exists, align it with the same exact three-origin policy rather
than leaving stale additional origins enabled. Preserve the existing public
share Function URL: do not point `PUBLIC_SHARE_URL` to a custom-domain path
unless that path has an explicitly configured proxy. Changing the canonical
site origin updates share-page destination/image URLs without replacing existing
share links. Function origin secrets take effect without redeploying Functions;
a frontend-only release does not synchronize them. Verify allowed preflights
for all three origins and rejection of unapproved origins after synchronization.

Do not configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, or
`STRIPE_MEMBERSHIP_PRICE_ID` for the closed canary. They become required only
after a reviewed change sets `BILLING_ENABLED=true`. The release still deploys
all four guarded billing Functions with billing off. Its hosted smoke requires
the three gateway-protected Functions to reject an unauthenticated request with
`401` and the public webhook Function to return `503`. The owner canary then
uses a real authenticated session to require exact `503` responses from the
other three without weakening gateway JWT verification.

Authentication and challenge data are backed by Supabase Auth and Postgres only
on `main`. Preview builds set `VITE_ENABLE_MOCKS=true`,
`VITE_ENABLE_BILLING=false`, and `VITE_ENABLE_PUBLIC_SIGNUP=false`, which
disables Supabase client construction and Stripe/provider calls. The Cloudflare
normalizer enforces all three safe values even if an inherited Preview variable
is hostile. Production leaves mocks disabled but hard-codes billing and public
signup to `false`; changing either requires a reviewed workflow change.

Before a full or frontend-only production build, the protected release workflow
uses Supabase's read-only Auth config endpoint and requires hosted public signup
and anonymous sign-in to be closed. A frontend-only release cannot bypass this
policy gate.

The canonical prelaunch dev URL is `https://develop.77-dominion-live.pages.dev`. The bare Pages hostname follows `main`; it is not the current dev target and must not be shared for prelaunch testing.

Account recovery does not authorize changing the project name or hosting target.
If a project replacement is ever needed, obtain explicit user approval for that
exact change first and review all target guards, compatible origins, Auth
callbacks, and release records together. Only `https://77dominion.com` is
canonical; the other two approved origins remain compatibility entry points.
