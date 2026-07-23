# Backend validation and production release runbook

This runbook covers database migrations, Row Level Security (RLS), RPCs,
Supabase Edge Functions, environment configuration, and the production frontend
release. Pull-request validation runs entirely against local or stubbed services;
it does not connect to or mutate production.

## Local prerequisites

- Node.js 22 or newer
- pnpm 10.17.1 (Corepack can install the version pinned in `package.json`)
- Docker Desktop or another Docker-compatible daemon
- Deno 2.8.1

Install exactly the dependency graph committed to the repository:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Reproduce pull-request validation locally

Frontend validation is independent of Docker and Supabase:

```bash
pnpm run check:frontend
```

Database validation starts from an empty local database, applies every migration,
loads `supabase/seed.sql`, tests RLS and RPC invariants, exercises concurrent RPC
requests, and compares the resulting application schema and Storage policies with
`supabase/schema.sql`:

```bash
pnpm run supabase:start
pnpm run check:database
pnpm run supabase:stop
```

Always stop the stack when a validation command fails. `pnpm run supabase:reset`
is safe only for the local stack; never point `SUPABASE_DB_URL` at a hosted
environment. The integration harness defaults to
`postgresql://postgres:postgres@127.0.0.1:54322/postgres` and accepts an explicit
local override through `SUPABASE_DB_URL`.

Edge Function checks use Deno and stub Stripe, Supabase, and other provider calls
at the network boundary. They require no provider credentials and do not require
the local Supabase stack:

```bash
pnpm run check:functions
pnpm run test:functions
```

The pull-request workflow exposes three required checks so failures are easy to
route: `Frontend`, `Database`, and `Edge Functions`. The database job owns the
local Supabase lifecycle and always stops it, including on failure.

## Environment inventory

Configure repository production values on the GitHub `production` environment,
protect that environment with required reviewers, and restrict deployment to the
`main` branch. Do not place production credentials in `.env` files, workflow
YAML, pull-request logs, seeds, or test fixtures.

### GitHub production secrets

| Name | Purpose | Rotation owner |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authorizes the Supabase CLI release | Supabase organization administrator |
| `SUPABASE_DB_PASSWORD` | Links and migrates the production database | Supabase project administrator |
| `STRIPE_SECRET_KEY` | Calls Stripe from Edge Functions | Stripe administrator |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures | Stripe administrator |
| `STRIPE_MEMBERSHIP_PRICE_ID` | Selects the approved recurring membership price | Billing owner |
| `INTEGRATION_WORKER_SECRET` | Authorizes the private Cron-to-worker request when integrations are enabled | Integration administrator |
| `INTEGRATION_CREDENTIAL_KEYS` | Versioned AES-256-GCM key ring for provider credentials when integrations are enabled | Security administrator |
| `INTEGRATION_OAUTH_STATE_SECRET` | Signs short-lived, one-use provider authorization state | Security administrator |
| `RETIRED_COMMUNITY_WORKER_SECRET` | Authorizes only the retired Community scan/deletion worker | Security administrator |
| `RETIRED_COMMUNITY_DR_HMAC_SECRET` | Signs and verifies the redacted off-platform purge ledger | Disaster-recovery owner |
| `SLACK_CLIENT_ID` | Identifies the environment-specific Slack app | Integration administrator |
| `SLACK_CLIENT_SECRET` | Exchanges Slack authorization codes server-side | Integration administrator |
| `SLACK_SIGNING_SECRET` | Retained with the reviewed Slack app configuration | Integration administrator |
| `DISCORD_CLIENT_ID` | Identifies the environment-specific Discord app | Integration administrator |
| `DISCORD_CLIENT_SECRET` | Exchanges Discord authorization codes server-side | Integration administrator |
| `DISCORD_PUBLIC_KEY` | Retained with the reviewed Discord app configuration | Integration administrator |
| `DISCORD_BOT_TOKEN` | Sends only to channels selected through the connection flow | Integration administrator |

### GitHub production variables

| Name | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | Yes | Production Supabase project targeted by the release |
| `PUBLIC_SITE_URL` | Yes | Canonical HTTPS origin returned by billing flows |
| `PUBLIC_SHARE_URL` | Optional | Custom HTTPS route for public share snapshots; defaults to the Edge Function URL |
| `PUBLIC_ALLOWED_SITE_URLS` | Recommended | Comma-separated exact preview or secondary origins |
| `CLOUDFLARE_PAGES_PROJECT_HOST` | When Cloudflare previews are used | Allows the configured Pages host and its preview subdomains |
| `VITE_SUPABASE_URL` | Yes | Public Supabase URL baked into the frontend |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Public publishable key baked into the frontend |
| `VITE_YOUVERSION_VERSE_URL` | Optional | Configured daily-verse source |
| `VITE_YOUVERSION_APP_URL` | Optional | YouVersion Bible destination |
| `VITE_YOUVERSION_PRAYER_URL` | Optional | YouVersion guided-prayer destination |
| `VITE_APPLE_FITNESS_URL` | Optional | Apple Fitness destination |
| `VITE_WALK_ALARM_URL` | Optional | Supported walk-alarm destination |

`VITE_ENABLE_MOCKS` is deliberately hard-coded to `false` by the production
workflow. Treat any future `VITE_*` release toggle as a build-time feature gate:
document its safe default here, leave it disabled until its backend is deployed
and verified, and record who approved enabling it.

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` into deployed functions. Never duplicate those values
in GitHub. The workflow synchronizes the Stripe and allowed-origin values above
to Supabase Function Secrets before function deployment. `ALLOWED_SITE_ORIGINS`
is supported only as a compatibility alias; new configuration should use
`PUBLIC_ALLOWED_SITE_URLS`.

The integration worker secret requires the provider credential key ring. The two
retired Community secrets are optional only while its production worker is
dormant; configure both together, along with the same credential key ring used to
revoke Slack/Discord access. The workflow deploys each worker only when its full
secret set is present and fails closed on partial configuration. Provider
connections are deployed only when all provider credentials and the OAuth state
secret are present, and they require the integration runtime first. Provider app
registration is documented in `docs/integrations/provider-delivery-runbook.md`;
retired data operations and DR are documented in
`docs/retired-community-deletion-runbook.md`.

For local function serving only, copy `supabase/.env.example` to
`supabase/.env.local`, fill it with local/test values, and pass it explicitly:

```bash
pnpm exec supabase functions serve --env-file supabase/.env.local
```

## Release gates

Before approving the GitHub `production` environment deployment, confirm:

1. The release commit is on `main`, came through a reviewed pull request, and all
   three validation jobs passed for that exact commit.
2. A recent production backup or point-in-time recovery window is available.
3. New migrations are additive or have an approved compatibility plan for the
   currently deployed frontend and functions.
4. Every new Edge Function secret is present in the inventory and has an owner.
5. Provider configuration uses test/sandbox endpoints until its production smoke
   test is explicitly approved.
6. Mock mode is disabled and new frontend feature flags remain at their safe
   default until the backing migration and functions pass verification.

### One-time migration-history reconciliation

The project predates migration-based deployments. The new
`20260707170000_baseline.sql` reconstructs that historical schema for empty local
databases; it must never be replayed over an already-populated hosted project.
The release workflow deliberately omits `--include-all`, so a hosted project with
later migration records but no baseline record fails closed.

Before the first workflow-managed production release, an administrator must make
a backup, link the exact production project, and inspect its history and schema:

```bash
supabase migration list --linked
supabase db diff --from migrations --to linked --schema public
supabase db push --linked --dry-run
```

Also run these read-only queries in the production Supabase SQL editor. They must
return all three expected buckets and all eleven named application policies:

```sql
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('profile-photos', 'community-post-images', 'journal-progress')
order by id;

select policyname
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname in (
    'Profile photos are publicly readable',
    'Users can upload own profile photo objects',
    'Users can update own profile photo objects',
    'Users can delete own profile photo objects',
    'Crew members can read community post images',
    'Crew members can upload own community post images',
    'Authors and crew leaders can delete community post images',
    'Users can read own journal photo objects',
    'Users can upload own journal photo objects',
    'Users can update own journal photo objects',
    'Users can delete own journal photo objects'
  )
order by policyname;
```

If—and only if—the public structural diff is empty and the Storage verification
passes, use `supabase migration repair ... --status applied --linked` to record
every local historical migration whose effect is already present, without
executing its SQL. A project with empty history must reconcile the complete local
history through `20260716163000`; a project with partial history must repair every
missing version through that floor, not only the baseline and compatibility
migration. Then rerun `migration list` and the dry-run. The production workflow
checks every version through that floor and refuses to continue if any local and
remote history cell does not match.

Record the exact repaired versions, backup identifier, structural-diff and Storage
query output, project reference, operator, and UTC time in the release record.
Never use `--include-all` to bypass an older missing migration in production. A
non-empty or incomplete check requires a reviewed forward-fix or a separately
approved, backed-up bootstrap plan.

### FOU-759 two-stage avatar and journal cutover

FOU-752/753 must not use the normal backend-first order for their first production release. The hardening migration rejects the previous raw/upsert avatar client, and the final cleanup removes journal-photo infrastructure used by the previous client. Use the same reviewed commit for both stages:

1. Confirm the migration-history reconciliation above is genuinely complete. The 2026-07-22 inventory in [`release-evidence/fou-759-production-inventory-2026-07-22.md`](./release-evidence/fou-759-production-inventory-2026-07-22.md) found missing historical profile infrastructure, so those versions must not be marked applied until a structural diff proves their effects exist or an approved bootstrap applies them.
2. Rerun the aggregate journal inventory from that evidence record. Journal rows, objects, multipart uploads, and nonterminal `journal-progress` retention work must all be zero.
3. Manually dispatch **Release production** from the exact reviewed release-candidate ref with `release_scope=frontend-only`. This deploys the schema-negotiating, prepared-thumbnail and text-only-journal client while intentionally skipping migrations. The client must treat the missing `profiles.avatar_url` column as the planned compatibility state and must make no profile-photo RPC or Storage request.
4. Verify normal sign-in, profile text editing, dashboard challenge-date synchronization, and journal create/edit/reload behavior in production. The profile-photo control must remain disabled, and all six journal text fields must work without a journal-photo request. Leave the previous database and empty bucket in place during this verification window.
5. Rerun the zero-data inventory. Stop on any nonzero result; export or explicitly disposition user data and use the Storage API for object deletion.
6. Dispatch the exact same reviewed ref with `release_scope=full`. The backend stage now applies the avatar lifecycle registry and policies first and the fail-closed journal cleanup second, then rebuilds the frontend.
7. Reload the profile after the full release. Verify the photo control is enabled, a selected image becomes a square thumbnail no larger than 256×256 and 150 KiB, replacement removes the predecessor, and profile text edits survive avatar-only saves. Then verify the final state with the queries below. A cached legacy avatar client can no longer upload a timestamp-only path, reactivate a predecessor, or delete the canonical object; rejection is the intended fail-safe.

```sql
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('profile-photos', 'community-post-images', 'journal-progress')
order by id;

-- Exactly profile-photos (153600; JPEG/WebP) and community-post-images remain.
select policyname, cmd, permissive
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- Exactly seven policies remain:
-- Canonical profile photos cannot be deleted (DELETE, restrictive)
-- Pending account erasure blocks personal asset deletes (DELETE, restrictive)
-- Pending account erasure blocks personal asset uploads (INSERT, restrictive)
-- Pending account erasure freezes personal asset updates (UPDATE, restrictive)
-- Users can delete own profile photo objects (DELETE, permissive)
-- Users can read own profile photo objects (SELECT, permissive)
-- Users can upload own profile photo objects (INSERT, permissive)

select
  to_regclass('public.journal_photos') is null as journal_photos_retired,
  to_regclass('private.profile_photo_objects') is not null as photo_lifecycle_ready,
  to_regclass('private.profile_photo_path_tombstones') is not null as path_tombstones_ready;
```

### Profile-photo registration admission controls

The registration RPC serializes admission per account and fails closed at these
server-enforced limits:

- 3 pending uploads at once;
- 20 registrations waiting for Storage cleanup;
- 6 new immutable paths in a rolling hour;
- 24 new immutable paths in a rolling 24 hours.

A retry of the exact same unexpired pending path returns its original
registration ID without extending its 15-minute lease or consuming another
slot. An expired, abandoned, canonical, cleanup, or retired path is never
reactivated. The browser may retry one ambiguous transport or gateway failure
with that same path; it does not retry an application, authorization, rate, or
capacity response.

Use the service role to read aggregate admission health:

```sql
select public.profile_photo_registration_health();
```

The result contains thresholds; active-pending, expired-pending, actual-cleanup,
and effective-cleanup lifecycle and Storage-object counts; oldest timestamps;
and counts of users at each effective limit. It contains no user IDs, paths, or
object metadata. Alert immediately when any user reaches the effective cleanup
cap, when `oldestExpiredPendingCreatedAt` remains non-null across two checks, or
when the oldest cleanup registration or the difference between effective cleanup
registrations and objects grows across two checks. Investigate the authenticated
cleanup flow and the FOU-802 unattended worker before changing any threshold.

For user support, let a pending lease expire, ask the member to revisit Profile
so the authenticated cleanup queue can drain, or wait for the rolling hourly or
daily window named by the client error. Never delete `storage.objects` rows,
registration rows, or path tombstones with SQL, and never reset a user's counters
by rewriting `created_at`; Storage deletion must use the Storage API and the
governed claim/confirmation flow.

## Staged production release

`.github/workflows/deploy.yml` enforces the following order and stops before the
next stage when one fails:

1. **Validate:** run the full reusable local CI workflow. No production access is
   available in this stage.
2. **Migrate:** link the intended project, preview with
   `supabase db push --linked --dry-run`, and apply only migrations that follow the
   reconciled remote history. Never use `--include-all` or run
   `supabase/schema.sql` manually in production.
3. **Synchronize secrets and deploy functions:** update Function Secrets, deploy
   the three JWT-protected billing functions and the JWT-protected
   `retired-community-export`, then deploy `stripe-webhook` with JWT verification
   disabled because Stripe authenticates it by signature and the public
   `share-snapshot` renderer with its own POST authentication. When both
   integration runtime secrets are present, also deploy
   `process-integration-outbox` without JWT verification; it authenticates the
   Vault-backed Cron request with its independent worker secret. When the full
   provider secret set is also present, deploy the authenticated
   `group-integrations` function and the public Slack and Discord OAuth callback
   functions. The callbacks authenticate signed, expiring, one-use state rather
   than a user JWT. When both retired Community secrets and the credential key
   ring are present, also deploy the private-header-authenticated
   `process-retired-community-deletions` worker.
4. **Verify backend and release feature gates:** list remote migrations and
   functions, then confirm an unauthenticated billing-function request is rejected
   before releasing the frontend build. Keep mock mode off and leave new
   customer-facing flags disabled until the remaining checks below pass.
5. **Build and deploy frontend:** build with production public configuration,
   upload the immutable Pages artifact, and deploy it only after every backend
   stage succeeds.

The workflow is intentionally non-concurrent. Do not cancel a running production
release while a migration may be in progress.

## Production verification

Complete these checks immediately after the backend stage and again after the
frontend is live. Record the release commit, operator, UTC time, and results in
the release or incident record.

1. In Supabase migration history, confirm every repository migration through the
   release commit is applied once and in order.
2. Sign in with two non-privileged verification accounts. Confirm each user can
   read and mutate only their own profile, entries, point ledger, rewards, and
   group data; confirm a cross-user and cross-group request is denied.
3. Repeat an idempotent RPC request with the same key and confirm it returns the
   same result without a second point-ledger grant. Repeat a safe request after a
   simulated client retry and confirm invariants still hold.
4. Exercise each authenticated billing function with a test member. Confirm an
   unauthenticated request is rejected and an unapproved origin receives no CORS
   access. Preview and create one share snapshot, inspect its server-rendered
   metadata, revoke it, and confirm the same URL then returns the generic 404.
5. Send a Stripe test-mode signed event to `stripe-webhook`; confirm one expected
   subscription/entitlement transition and no duplicate transition on replay.
6. When the integration runtime is enabled, invoke health with the worker secret,
   confirm Cron history is healthy, and deliver one non-sensitive synthetic event
   to each staging-approved provider before enabling connection UI.
7. When provider connections are enabled, use a current group owner/admin to
   connect and confirm one staging channel per provider. Confirm a group member
   sees status but no management actions; then test, disconnect, and verify queued
   sends are canceled before reconnecting.
8. Load the production frontend in a fresh browser profile. Confirm it targets
   the production Supabase project, mock identities are unavailable, and core
   Dashboard, Check-In, billing, and sign-out flows work.
9. Review Supabase Function logs, Postgres logs, Stripe delivery logs, integration
   health, and Cron history for new
   authorization errors, repeated retries, or unexpected elevated-role access.
10. Before enabling any retired Community deletion schedule, invoke its worker
    health endpoint and record the aggregate counts. Require no overdue account
    erasures, stale claims, repeated work failures, pending DR reapplications, or
    quarantined restore data; verify an account batch inventories profile,
    journal, and Community buckets before approving execution.

Only after these checks pass may a new customer-facing feature flag be enabled.
If a flag is build-time (`VITE_*`), update the production variable and rerun the
frontend release; do not redeploy or rerun migrations just to change the flag.

## Failure, forward-fix, and rollback

- **Before a migration starts:** cancel the release, correct the branch, rerun
  validation, and release a new commit.
- **After any migration applies:** do not delete, rename, edit, or mark an applied
  migration as reverted. Stop later stages and ship a new, reviewed forward-fix
  migration. Use a destructive down migration only with a backup, an incident
  owner, and explicit data-loss approval.
- **Function regression with compatible schema:** keep the database in place and
  redeploy the last known-good function source from an immutable release commit.
  Rotate or restore a secret only when its value is known to be the cause; never
  blank secrets as a rollback technique.
- **Frontend regression:** disable the affected feature flag when available, then
  dispatch the release workflow from the last known-good frontend commit with
  `release_scope` set to `frontend-only`. That path validates and rebuilds the
  frontend without rerunning migrations or redeploying functions. Its backend
  contract must remain compatible with the already-applied schema.
- **Data integrity or credential incident:** disable the affected feature/provider,
  preserve logs, rotate exposed credentials, and follow the Supabase backup or
  point-in-time recovery procedure. Do not improvise SQL deletes in production.

After any recovery, rerun the production verification checklist and add the
failure mode to the automated migration, RLS, RPC, or function suite before
re-enabling the feature.
