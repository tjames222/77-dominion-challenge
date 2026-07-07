# Cloudflare Pages Setup

Connect this repo to Cloudflare Pages for staging previews.

Recommended settings:

- Project name: 77-dominion-challenge
- Production branch: main
- Framework preset: Vite
- Build command: npm run build
- Build output directory: dist
- Root directory: /
- Environment variables:
  - VITE_SUPABASE_URL
  - VITE_SUPABASE_ANON_KEY

Branch workflow:

- main = production
- develop = staging and active development
- feature branches = preview deployments

The repo uses Cloudflare Pages for preview deployments. Authentication and challenge data are backed by Supabase Auth and Postgres; localStorage is only used for local UI preferences and fallback behavior when Supabase env vars are not configured.
