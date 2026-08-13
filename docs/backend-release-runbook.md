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
`supabase/schema.sql`. `supabase/config.toml` pins the local stack to Postgres 17
to match the one hosted project; the database runner fails if that major version
drifts:

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

### Database test discovery contract

Place pgTAP files below `supabase/tests/database` with a `.sql` or `.pg`
extension. SQL suites use a numeric ordering prefix and must wrap a positive
`plan(...)` plus `finish()` in `begin`/`rollback`. Run them only through:

```bash
pnpm run test:database
```

The repository wrapper inventories the source tree, stages it in the shared Git
directory so Docker can read tests from normal checkouts and linked worktrees,
and invokes the pinned Supabase CLI. It then requires a valid nonzero
`Files=N, Tests=M` summary, an executed-file count equal to the source inventory,
and output naming every expected test. A missing summary, `NOTESTS`, omitted
file, count mismatch, or nonzero CLI exit fails the job. Do not call
`supabase test db` with repository-relative positional paths; that bypasses the
guard and can resolve to a host path the pg_prove container cannot read.

## Environment inventory

Configure repository production values on the GitHub `production` environment,
protect that environment with required reviewers, and restrict deployment to the
`main` branch. Do not place production credentials in `.env` files, workflow
YAML, pull-request logs, seeds, or test fixtures.

The prelaunch environment model deliberately uses no paid staging project:

- `develop` and its Cloudflare preview are pure mocks, including identity and
  every backend/provider connection. They require `VITE_ENABLE_MOCKS=true` and
  must not enable `VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS`.
- the one hosted Supabase project, Auth tenant, and Stripe configuration belong
  only to the protected `main`/`production` environment;
- local CI still replays the full schema and stubs external providers, so code is
  validated without connecting `develop` to production.

### GitHub production secrets

| Name | Purpose | Rotation owner |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authorizes the Supabase CLI release | Supabase organization administrator |
| `SUPABASE_DB_PASSWORD` | Links and migrates the production database | Supabase project administrator |
| `STRIPE_SECRET_KEY` | Calls Stripe from Edge Functions | Stripe administrator |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures | Stripe administrator |
| `STRIPE_MEMBERSHIP_PRICE_ID` | Selects the approved recurring membership price | Billing owner |
| `CLOUDFLARE_API_TOKEN` | Deploys the verified immutable frontend artifact to the single Pages project | Cloudflare administrator |
| `CLOUDFLARE_ACCOUNT_ID` | Selects the account that owns the production Pages project | Cloudflare administrator |
| `PROFILE_PHOTO_WORKER_SECRET` | Authorizes only the unattended expired profile-photo cleanup worker | Security administrator |
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
| `PUBLIC_ALLOWED_SITE_URLS` | Recommended | Comma-separated exact approved production or custom origins |
| `VITE_SUPABASE_URL` | Yes | Public Supabase URL baked into the frontend |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Public publishable key baked into the frontend |
| `VITE_YOUVERSION_VERSE_URL` | Optional | Configured daily-verse source |
| `VITE_YOUVERSION_APP_URL` | Optional | YouVersion Bible destination |
| `VITE_YOUVERSION_PRAYER_URL` | Optional | YouVersion guided-prayer destination |
| `VITE_APPLE_FITNESS_URL` | Optional | Apple Fitness destination |
| `VITE_WALK_ALARM_URL` | Optional | Supported walk-alarm destination |

`VITE_ENABLE_MOCKS` is deliberately hard-coded to `false` by the production
workflow. `VITE_ENABLE_GROUP_INTEGRATIONS` is deliberately hard-coded to `false`
for the safe-off launch path. Treat any future `VITE_*` release toggle as a build-time feature gate:
document its safe default here, leave it disabled until its backend is deployed
and verified, and record who approved enabling it.

`PUBLIC_ALLOWED_SITE_URLS` is an exact-origin allowlist. Do not add `develop`,
feature-preview, or localhost origins to the production value.

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
7. Cloudflare automatic production-branch deployment is disabled. The GitHub
   workflow is the only process allowed to publish `main` after backend checks.
8. Merging `main` does not deploy production. An authorized operator manually
   dispatches **Release production** from the protected `main` branch and selects
   the reviewed release scope. This keeps the first two-stage cutover and every
   later production mutation explicit.

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

The `db diff --schema public` output is a preliminary signal, not a complete
checkpoint proof. It does not cover the `private` schema or prove complete grants,
function attributes and bodies, triggers, constraints, RLS policy expressions,
or Storage configuration. In the 2026-08-13 audit, a three-schema CLI diff even
returned empty while direct dumps proved application-owned differences, so an
empty CLI diff never authorizes repair. Export direct schema dumps and normalized
catalog manifests for `public`, `private`, and the application-owned parts of
`storage` from the isolated local checkpoint and production. Compare all of those
object classes, classifying platform-version noise through an explicit reviewed
allowlist rather than silently discarding it. Also run these read-only queries in
the production Supabase SQL editor. Compare the result exactly with the
version-bounded local checkpoint manifest, including commands, roles, `qual`,
and `with_check` expressions. For the migration-3 checkpoint below, the only
expected result is `journal-progress` and its four
`Users can ... journal photo objects` policies; `profile-photos`,
`community-post-images`, and their seven policies must be absent:

```sql
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('profile-photos', 'community-post-images', 'journal-progress')
order by id;

select policyname, cmd, roles, qual, with_check
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

Migration repair records history without executing SQL. Never repair a version
whose complete net effect is not already present, and never infer a repair range
from a partial catalog diff, object names, or later-looking objects. The audited
project below has application drift owned by migrations 1 and 2, so repair is not
the approved reconciliation mechanism.

#### One-time pre-avatar checkpoint bootstrap

The read-only 2026-08-13 production audit found an empty remote migration history
and the migration-2 gamification table shapes. The two functions touched by
migration 3 have the expected definitions and `search_path=public`; migration 3
repeats definitions already present in the checked-in migration 2, so this proves
its net effect but cannot prove it was historically executed. Definitive
migration-4 markers are absent: `user_badges.id` and `earned_date` remain,
`entry_date` is absent, `user_game_stats.created_at` remains, and the point-event
ledger still uses the earlier per-user idempotency constraint.

The full baseline does **not** currently match migration 1. Direct schema dumps
found the empty legacy `public.purchases` table, the legacy entitlement-key
constraint, three application function-body differences, 31 public/Storage RLS
policy differences, and security-significant privilege differences. Therefore no
migration version is currently authorized for repair. Because the application
drift is owned by the checked-in migrations 1 and 2, prefer an actual, normally
recorded execution of migrations 1–3 over a hand-copied bridge plus repaired
history—but only after the destructive statements are made fail-closed in a
separately reviewed change and the exact restored-snapshot rehearsal passes:

1. Pin the release tree, Supabase CLI 2.109.0, and Postgres 17. Keep public signup
   and all application writes closed.
2. Create encrypted, off-repository dumps of roles, schema, and data. Include
   Auth and Storage data and custom DDL, archive the empty
   `supabase_migrations` schema, download or inventory every deployed Edge
   Function, and record aggregate row/object counts. Storage blobs are not part
   of a database dump; stop and export through the Storage API if the fresh
   object count is nonzero. Checksum every artifact and test-restore the backup
   locally before continuing.
3. In an isolated worktree containing only migrations 1–3, pin the exact hosted
   Postgres image (`17.6.1.141`) and build a clean checkpoint without the
   final-schema seed:

   ```bash
   supabase db reset --local --version 20260708155500 --no-seed
   ```

   Compare its `public` and `private` catalogs, effective grants, functions,
   triggers, constraints, complete policy inventories, badge/configuration rows,
   and the application-owned Storage manifest with production. Classify every
   difference and explicitly allowlist Supabase platform-version noise.
4. Before production use, update migration 1 in a reviewed commit so it aborts on
   any legacy purchase or non-membership entitlement row and uses
   `DROP TABLE ... RESTRICT`. This is allowed only because production has no
   migration record for that file. Never rewrite a version after it is recorded.
   Rebuild the clean checkpoints and rerun the complete validation after its hash
   changes.
5. Restore the encrypted hosted roles, schema, and data into the isolated exact-
   version stack. Require its normalized source manifest to match the captured
   production source manifest. Then rehearse applying these three migrations
   normally, not through `migration repair`:

   ```text
   20260707170000
   20260708154000
   20260708155500
   ```

   Rehearse the successful path once against an exact legacy-source copy, then
   exercise each fail-closed case separately against disposable copies: a
   purchase row, an external dependency, a legacy entitlement, a changed
   function, policy, or ACL, lock contention, and a forced rollback. The
   successful copy must match the clean migration-3 application manifest and
   have exactly these three history records.
6. Create a separate, hashed worktree containing exactly migrations 1–13. Its
   linked dry run must list exactly the following ten pending versions. Rehearse
   the same push against the verified local restore, then apply those ten
   migrations normally so their SQL and history records are created together:

   ```text
   20260708160000
   20260709163000
   20260710120000
   20260710123000
   20260713120000
   20260714120000
   20260715190000
   20260716061500
   20260716153000
   20260716163000
   ```

7. Return to the full release tree. `migration list` must show matching local and
   remote versions 1–13, and the full linked dry run must list exactly 39 pending
   migrations, versions 14–52. Repeat the Storage query above against the clean
   local migration-13 checkpoint and production; both must now return all three
   buckets and all eleven policies with identical definitions. This satisfies the
   workflow's historical gate; it does not authorize the production release by
   itself.

Record the exact applied versions, file hashes, backup and restore
evidence, comparison output, Storage manifest, project reference, operator,
approver, and UTC time in the release record. Never reset the hosted project,
use `--include-all`, mark a missing effect applied, manually execute migration
SQL outside the approved three-version runner, or push the full 52-file tree
before the checkpoint passes. If an applied migration later fails, stop and use
a reviewed forward fix; do not rewrite it or mark it reverted.

### FOU-759 two-stage avatar and journal cutover

FOU-752/753 must not use the normal backend-first order for their first production release. The hardening migration rejects the previous raw/upsert avatar client, and the final cleanup removes journal-photo infrastructure used by the previous client. Use the same reviewed commit for both stages:

1. Confirm the migration-history reconciliation above is genuinely complete. The 2026-07-22 inventory in [`release-evidence/fou-759-production-inventory-2026-07-22.md`](./release-evidence/fou-759-production-inventory-2026-07-22.md) found missing historical profile infrastructure, so those versions must not be marked applied until a structural diff proves their effects exist or an approved bootstrap applies them.
2. Rerun the aggregate journal inventory from that evidence record. Journal rows, objects, multipart uploads, and nonterminal `journal-progress` retention work must all be zero.
3. Manually dispatch **Release production** from the exact reviewed release-candidate ref with `release_scope=frontend-only`. This deploys the schema-negotiating, prepared-thumbnail and text-only-journal client while intentionally skipping migrations. The client must treat the missing `profiles.avatar_url` column as the planned compatibility state and must make no profile-photo RPC or Storage request.
4. Verify normal sign-in, profile text editing, dashboard challenge-date synchronization, and journal create/edit/reload behavior in production. The profile-photo control must remain disabled, and all six journal text fields must work without a journal-photo request. Leave the previous database and empty bucket in place during this verification window.
5. Rerun the zero-data inventory. Stop on any nonzero result; export or explicitly disposition user data and use the Storage API for object deletion.
6. Dispatch the exact same reviewed ref with `release_scope=full`. The backend stage now applies the avatar lifecycle registry and policies first and the fail-closed journal cleanup second, then rebuilds the frontend.
7. Reload the profile after the full release. Verify the photo control is
   enabled and the authenticated upload Function independently turns a selected
   JPEG/WebP into a stripped square WebP thumbnail no larger than 256×256 and
   150 KiB. Confirm replacement removes the predecessor and profile text edits
   survive avatar-only saves. Then verify the final state with the queries
   below. A cached or custom browser client can no longer write Storage,
   reactivate a predecessor, or delete the canonical object; rejection is the
   intended fail-safe.

```sql
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('profile-photos', 'community-post-images', 'journal-progress')
order by id;

-- Exactly profile-photos (153600; WebP only) and community-post-images remain.
select policyname, cmd, permissive
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- The exact reviewed policies remain, with no permissive browser INSERT policy:
-- Canonical profile photos cannot be deleted (DELETE, restrictive)
-- Pending account erasure blocks personal asset deletes (DELETE, restrictive)
-- Pending account erasure freezes personal asset updates (UPDATE, restrictive)
-- Users can delete own profile photo objects (DELETE, permissive)
-- Users can read own profile photo objects (SELECT, permissive)
-- Only the service role can insert a trusted profile-photo object.

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

Unattended expiry and deletion are operated separately. Complete the Vault,
Cron, health-alert, and closed production-canary proof in
[`profile-photo-cleanup-runbook.md`](./profile-photo-cleanup-runbook.md) before
production promotion; a successful Function deployment without the Cron job is
not completion evidence for FOU-802.

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

### One-time challenge activation cutover

Migration `20260804200019_challenge_activation_lifecycle.sql` is an approved
prelaunch, atomic cutover with a bounded write outage. Before the migration
stage starts, put the application in maintenance mode, pause every application
and worker path that can write activation evidence, and wait for their open
transactions to drain. This includes writes to challenge entries, check-ins,
crews and membership/invite lifecycle evidence, game stats and point events,
reward entitlements, and badges. Ordinary read-only traffic may remain online.

The migration takes the retired-community deletion advisory lock, freezes the
`auth.users` parent set, and then acquires its eleven evidence-table locks in one
fixed order before capturing the backfill clock. Do not run this migration while
mixed-order live writers are active. If its 10-second `lock_timeout` fires, the
entire transaction rolls back: keep writers quiesced, identify and drain the
remaining lock holder, and retry the complete migration. Never mark a timed-out
attempt as applied or run fragments manually. Resume writers only after migration
history and the activation smoke checks confirm the cutover applied once.

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
   upload an immutable workflow artifact, and deploy it to Cloudflare Pages with
   the least-privilege token only after every backend stage succeeds. GitHub
   Pages is not a production target.

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
   to each canary-approved provider destination before enabling connection UI.
7. When provider connections are enabled, use a current group owner/admin to
   connect and confirm one isolated canary channel per provider. Confirm a group
   member sees status but no management actions; then test, disconnect, and
   verify queued sends are canceled before reconnecting.
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
