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
5. In Supabase Auth URL Configuration, set the Site URL to the production frontend URL and add local dev URLs for testing.

The frontend uses Supabase Auth for login/register and writes directly to Supabase Postgres with Row Level Security policies.

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
