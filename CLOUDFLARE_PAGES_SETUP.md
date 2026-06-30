# Cloudflare Pages Setup

Connect this repo to Cloudflare Pages for staging previews.

Recommended settings:

- Project name: 77-dominion-challenge
- Production branch: main
- Framework preset: Vite
- Build command: npm run build
- Build output directory: dist
- Root directory: /

Branch workflow:

- main = production
- develop = staging and active development
- feature branches = preview deployments

The repo includes wrangler.toml with the Pages output directory set to dist.

Current app note: authentication and dashboard state are still mocked with localStorage. Real accounts will require a backend or hosted auth provider later.
