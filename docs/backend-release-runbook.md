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
  must not enable `VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS` or
  `VITE_ENABLE_PRODUCTION_CONNECTIONS`.
- the one hosted Supabase project and Auth tenant belong only to the protected
  `main`/`production` environment; Stripe will also belong there when billing is
  enabled, but it is deliberately deferred for the closed production canary;
- local CI still replays the full schema and stubs external providers, so code is
  validated without connecting `develop` to production.

### GitHub production secrets

| Name | Purpose | Rotation owner |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authorizes the pinned CLI's temporary login role, read-only Auth/history gates, and separately approved closed-canary Auth policy workflow; a fine-grained token needs `auth_config_read`, `auth_config_write`, `project_admin_write`, `database_read`, and `database_write` | Supabase organization administrator |
| `STRIPE_SECRET_KEY` | Calls Stripe from Edge Functions; required only when reviewed code sets `BILLING_ENABLED=true` | Stripe administrator |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures; required only when reviewed code sets `BILLING_ENABLED=true` | Stripe administrator |
| `STRIPE_MEMBERSHIP_PRICE_ID` | Selects the approved recurring membership price; required only when reviewed code sets `BILLING_ENABLED=true` | Billing owner |
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

`VITE_ENABLE_MOCKS` is deliberately hard-coded to `false` and
`VITE_ENABLE_PRODUCTION_CONNECTIONS` to `true` by the production workflow. The
second gate ensures that production-mode builds outside the protected release
cannot initialize hosted connections merely because public values are present.
`VITE_ENABLE_GROUP_INTEGRATIONS` is deliberately hard-coded to `false`
for the safe-off launch path. For the closed production canary,
`VITE_ENABLE_BILLING=false`, `VITE_ENABLE_PUBLIC_SIGNUP=false`, and the Edge
Function secret `BILLING_ENABLED=false` are also hard-coded in the workflow.
Changing any of these values requires a reviewed code change; an environment
variable override cannot enable them. Treat any future `VITE_*` release toggle as a build-time feature gate:
document its safe default here, leave it disabled until its backend is deployed
and verified, and record who approved enabling it.

`PUBLIC_ALLOWED_SITE_URLS` is an exact-origin allowlist. Do not add `develop`,
feature-preview, or localhost origins to the production value.

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` into deployed functions. Never duplicate those values
in GitHub. The workflow always synchronizes `BILLING_ENABLED` and the configured
allowed-origin values to Supabase Function Secrets before function deployment.
It requires and synchronizes the three Stripe values only after reviewed code
sets `BILLING_ENABLED=true`; with the current value `false`, the guarded billing
Functions remain deployed but return `503` without contacting Stripe.
`ALLOWED_SITE_ORIGINS`
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

### Cloudflare Pages project policy

Before the first protected release, dispatch **Configure Cloudflare Pages
policy** from `main` and approve its `production` environment. The environment's
`CLOUDFLARE_API_TOKEN` needs Cloudflare Pages Write permission only. The job
uses `CLOUDFLARE_ACCOUNT_ID` to update only the
`77-dominion-challenge` Pages project, then performs a separate GET and fails
unless Cloudflare reports all of the following:

- `main` is the production branch and automatic production deployments are
  disabled;
- both production and preview builds pin Node 22 and pnpm 10.17.1;
- the production environment contains the exact protected
  `SUPABASE_PROJECT_REF`, matching `VITE_SUPABASE_URL`, and public
  `VITE_SUPABASE_PUBLISHABLE_KEY`; mocks and hybrid Auth are disabled,
  production connections are enabled, and provider integrations, billing, and
  public signup are disabled;
- the production environment contains no E2E fixture flag, Stripe value,
  server-side Supabase credential, worker secret, or other unapproved variable;
- automatic previews use the custom branch policy with exactly `develop`
  included and no excluded preview branches;
- the preview environment explicitly enables browser-local mocks, explicitly
  disables hybrid Auth, production connections, billing, public signup, and
  provider integrations, and contains none of the live-connection variables
  rejected by `scripts/validate-frontend-env.mjs`.

The same helper is available to protected release jobs as
`pnpm run configure:cloudflare-pages-policy`. It sends credentials only in the
Authorization header, rejects redirects, never prints API response bodies, and
does not parse an HTTP error body. Every protected release now invokes it after
local validation and requires its separate PATCH/GET verification before a
Supabase release mutation or frontend deployment. Rerun the standalone policy
workflow after any manual Cloudflare project configuration change.

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
6. Mock mode is disabled, production connections are explicitly enabled by the
   protected workflow, and new frontend feature flags remain at their safe
   default until the backing migration and functions pass verification.
7. Cloudflare automatic production-branch deployment is disabled. The GitHub
   workflow is the only process allowed to publish `main` after backend checks.
8. Merging `main` does not deploy production. An authorized operator manually
   dispatches **Release production** from the protected `main` branch and selects
   the reviewed release scope. The one-time `compatibility-cutover` scope deploys
   only the four disabled billing guards before its frontend; `frontend-only`
   remains a post-cutover, backend-preserving rollback path and cannot run while
   migrations 14–53 are pending. This keeps the first two-stage
   cutover and every later production mutation explicit. The initial `full`
   scope fails before migrations unless the same commit has a non-expired
   post-deployment compatibility-cutover attestation from this workflow.
9. Supabase Auth is already closed: the official Management API Auth config must
   report `disable_signup=true` and
   `external_anonymous_users_enabled=false`. The workflow checks these exact
   values before any release scope and before `supabase link`, migrations,
   Function secrets, or Function deployment. It never prints
   the Auth response. See
   [`production-canary-operator-runbook.md`](production-canary-operator-runbook.md)
   for the UUID-bound owner canary procedure.
   If either setting is still open, dispatch **Close production Supabase Auth
   canary** from `main` and approve its protected `production` environment job
   before dispatching the release. That separate workflow changes only those
   two reviewed fields, rejects redirects, and GET-verifies the resulting state.

### One-time migration-history reconciliation

The project predates migration-based deployments. The original
`20260707170000_baseline.sql` only reconstructed that historical schema for empty
local databases and must never be replayed over a populated project. The
prelaunch production exception below uses a separately reviewed, fail-closed
revision of that still-unrecorded migration only after the exact legacy source,
zero-risk rows, encrypted backup, restored rehearsal, and normalized manifest
all match. Any other populated state remains prohibited. The release workflow
deliberately omits `--include-all`, so a hosted project with later migration
records but no baseline record fails closed.

Before the first workflow-managed production release, an administrator must
quiesce writers, create and test-restore the encrypted exact production backup,
and inspect its history and schema through the reviewed hooks. Do not link a
working tree or run an ad hoc CLI command against the hosted target. The
one-version entrypoint in
[`production-backup-restore.md`](production-backup-restore.md) receives an
owner-only passwordless URL file and exact pgpass file, captures authoritative
raw and CLI history itself, and preserves every result inside the encrypted
evidence chain.

`db push --dry-run` is a read-only plan preview in rehearsals or guarded workflow
prechecks. With pinned CLI 2.109.0,
actual application must use `supabase migration up`: that TypeScript executor
opens a transaction, runs one migration's compatible statements, inserts the
same version into `supabase_migrations.schema_migrations`, and commits. The
Go-backed `db push` and `db reset` execution paths use a pgx pipeline instead;
pipeline rollback is not an explicit PostgreSQL transaction context, so
transaction-only statements such as `LOCK TABLE`, `SET LOCAL`, and temporary
tables with `ON COMMIT` behavior do not have the required semantics without a
file wrapper. Do not use either Go-backed command to apply application migration
SQL. A fresh `pnpm run supabase:start` first starts only the database from a
temporary config with migrations and seed disabled, retains that empty database
volume, and starts the remaining services from the real repository so Edge
Functions mount the live source. Before application SQL runs, it verifies the
exact pinned Postgres image (default
`public.ecr.aws/supabase/postgres:17.6.1.141`, or the same repository and tag
under `SUPABASE_INTERNAL_IMAGE_REGISTRY`) and proves the full start recorded no
migration history and created no late application object. Its temporary config
is removed immediately. The start command then applies pending
application SQL with the pinned `migration up` executor and loads stable fixtures
in one `psql --single-transaction` call, leaving an immediately usable local
stack.
Local rebuilds use `scripts/reset-local-database.sh`, which runs
`db reset --no-seed` from a staged project with an empty migration directory
only to recreate the Supabase-managed platform schemas, then copies in the gated
application migrations, applies them with `migration up`, and loads local
fixtures in one `psql --single-transaction` call. CLI 2.109.0 rejects
the superficially similar `db reset --version 0` because no `0_*.sql` migration
exists, so do not use that unsupported shortcut.

The reset helper checks the CLI version before touching the database and fails
closed unless it is exactly 2.109.0. This protects the executor assumptions
above in local, schema-drift, and historical-checkpoint test paths.

The `db diff --schema public` output is a preliminary signal, not a complete
checkpoint proof. It does not cover the `private` schema or prove complete grants,
function attributes and bodies, triggers, constraints, RLS policy expressions,
or Storage configuration. In the 2026-08-13 audit, a three-schema CLI diff even
returned empty while direct dumps proved application-owned differences, so an
empty CLI diff never authorizes repair. Export direct schema dumps and normalized
catalog manifests for `public`, `private`, the complete Storage metadata
inventory, the application-owned Storage policies, and the selected Supabase
platform surface in `storage` from the isolated local checkpoint and production.
That platform surface includes event-trigger registrations, every non-internal
trigger on any pinned Storage inventory relation, the definitions and ACLs of
its referenced functions, and direct and effective relation, function, and
column privileges. The pinned Supabase CLI 2.109.0 Storage inventory relations are
`buckets`, `buckets_analytics`, `buckets_vectors`, `iceberg_namespaces`,
`iceberg_tables`, `objects`, `s3_multipart_uploads`,
`s3_multipart_uploads_parts`, and `vector_indexes`. Older hosted Storage
releases may omit the two Iceberg relations. Capture records every selected
relation's presence through `to_regclass`; all relations except those two are
mandatory, including `buckets_vectors` and `vector_indexes`. An absent optional
Iceberg relation receives the canonical empty row inventory without issuing a
query against the missing relation. Compare every present object class and every
row inventory independently, classifying platform-version noise through an
explicit reviewed allowlist rather than silently discarding it. Also run these
read-only queries in the production Supabase SQL editor. Compare the result
exactly with the version-bounded local checkpoint manifest, including commands,
roles, `qual`, and `with_check` expressions. Do not filter the inventory to
expected IDs or policy names: an unknown row is itself a release blocker. For
the migration-3 checkpoint below, the only standard bucket is
`journal-progress`, every other Storage inventory relation has zero rows, and
the only application Storage policies are its four
`Users can ... journal photo objects` policies:

```sql
select id, name, owner_id, public, file_size_limit, allowed_mime_types, type
from storage.buckets
order by id;

select schemaname, tablename, policyname, permissive, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage'
  and tablename in (
    'buckets',
    'buckets_analytics',
    'buckets_vectors',
    'iceberg_namespaces',
    'iceberg_tables',
    'objects',
    's3_multipart_uploads',
    's3_multipart_uploads_parts',
    'vector_indexes'
  )
order by tablename, policyname;

select
  format('storage.%I', relation_name) as relation_name,
  to_regclass(format('storage.%I', relation_name)) is not null as present,
  required
from (values
  ('buckets', true),
  ('buckets_analytics', true),
  ('buckets_vectors', true),
  ('iceberg_namespaces', false),
  ('iceberg_tables', false),
  ('objects', true),
  ('s3_multipart_uploads', true),
  ('s3_multipart_uploads_parts', true),
  ('vector_indexes', true)
) inventory(relation_name, required)
order by relation_name collate "C";
```

Do not compose a static `UNION` that names optional relations: PostgreSQL can
fail while parsing it before a `WHERE to_regclass(...)` guard is evaluated.
Use `scripts/database-manifest.sql` and `scripts/baseline-data-fingerprint.sql`
for the row inventories; both resolve relation OIDs first and query only present
relations.

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
   Function, and record every Storage metadata-table count listed above. Storage
   blobs are not part of a database dump; stop and export through the Storage API
   if the fresh object or multipart inventory is nonzero, and separately
   disposition any analytics/vector catalog rows. Checksum every artifact and
   test-restore the backup locally before continuing.

   Use the fail-closed operator helpers in
   [`production-backup-restore.md`](production-backup-restore.md). They require
   a clean exact release tree, pinned CLI and image identities, separately
   hashed read-only inventory hooks, credentials in private files, and a
   pre-mounted encrypted destination before the first remote access. The
   standalone evidence verifier binds the source manifest, complete
   Auth/private/public/Storage/migration-history data fingerprint, canonical
   relation/sequence counts, reviewed application-owned Auth/Storage DDL,
   capture time, and isolated restore cleanup proof.
   A loose dump path or an incomplete capture/restore directory is not release
   evidence.
3. In an isolated worktree containing only migrations 1–3, pin the exact hosted
   Postgres image (`17.6.1.141`) and build a clean checkpoint without the
   final-schema seed:

   ```bash
   bash scripts/reset-local-database.sh \
     --version 20260708155500 \
     --no-seed
   ```

   Compare its `public` and `private` catalogs, effective grants, functions,
   triggers, constraints, complete policy inventories, badge/configuration rows,
   and the application-owned Storage manifest with production. Classify every
   difference and explicitly allowlist Supabase platform-version noise.
4. Before production use, update the unrecorded migrations 1–3 in reviewed
   commits. Migration 1 must abort on any legacy purchase or non-membership
   entitlement row and use `DROP TABLE ... RESTRICT`. Together migrations 1–2
   must canonicalize `postgres` default privileges for new public tables,
   sequences, and functions, then normalize the ACLs for every baseline and
   gamification table and function whose known legacy privilege would otherwise
   survive `CREATE IF NOT EXISTS`, `CREATE OR REPLACE`, or a narrower `GRANT`.
   This includes revoking all `authenticated` table privileges on `profiles`,
   `challenge_entries`, and `check_ins` before granting the exact target access,
   plus explicit reviewed runtime grants for `service_role` rather than either
   preserving or stripping its legacy `ALL` grants wholesale. Classify function,
   table, sequence, schema, and default privileges with effective catalog checks;
   preserve explicitly approved platform privileges and fail on every unknown
   state. Reconcile clean-checkpoint ACLs with audited runtime needs before
   editing SQL; Edge runtimes require explicit service access to profile and
   billing data. Remove the top-level `BEGIN`/`COMMIT` wrappers from every
   still-unrecorded migration and pass `pnpm run check:migrations`, which rejects
   top-level transaction control and every statement that would force the pinned
   `migration up` executor outside its transaction (`CREATE [UNIQUE] INDEX
   CONCURRENTLY`, `REINDEX ... CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, and
   `CLUSTER`). With CLI 2.109.0, `migration up` explicitly begins a transaction,
   runs one migration's statements, inserts its history row, and commits; a
   file-level `COMMIT` can end that transaction before the history write. Prove
   the exact pinned executor with a disposable history-insert failure after the
   final migration statement and require both SQL and history to be absent.
   These edits are allowed only because production has no migration record for
   any migration file. Never rewrite a version after it is recorded. Rebuild the
   clean checkpoints and rerun the complete validation after any hash changes.
5. Restore the encrypted hosted roles, schema, and data into the isolated exact-
   version stack. Require its normalized source manifest to match the captured
   production source manifest. Then rehearse applying these three migrations
   with pinned `supabase migration up`, not through `db push` or
   `migration repair`:

   ```text
   20260707170000
   20260708154000
   20260708155500
   ```

   Rehearse the successful path once against an exact legacy-source copy. Then
   prove that the hardened migration aborts and rolls back completely for a
   purchase row, an external dependency, a legacy entitlement, any unexpected
   bucket, object, or multipart upload, an unknown privilege state, lock
   contention, and a forced error. Separately prove that the normalized
   source-manifest gate rejects a changed function, policy, relation,
   constraint, trigger, event trigger, Storage trigger-function definition or
   ACL, and direct or effective Storage column privilege before the migration
   runner starts. The successful copy must match the clean migration-3
   application manifest, including effective privileges, and have exactly these
   three history records.

   The checked-in harness performs that exact-version proof against the
   sanitized audited source fixture without contacting production:

   ```bash
   pnpm run test:database-manifest
   pnpm run test:baseline-reconciliation
   ```

   Migration 1 runs in one `READ COMMITTED` transaction. It takes
   `SHARE ROW EXCLUSIVE` on application-owned and migration-writable relations,
   blocking writes and concurrent DDL while allowing ordinary readers. The
   destructive preflight is the next statement, so it receives a fresh snapshot
   after any writer that held up the lock pass commits; the acquired locks then
   prevent a later application write from racing that preflight. An in-flight
   writer may drain safely within the five-second lock timeout. A holder that
   does not drain within that window makes the migration fail atomically. On the
   pinned Storage image, `storage.buckets_vectors` and
   `storage.vector_indexes` are owned by `supabase_storage_admin` and expose only
   `SELECT` to the migration role. The migration verifies that exact contract
   and retains `ACCESS SHARE` on those two read-only inventory relations for the
   full transaction instead of escalating the role's platform privileges. Keep
   all application and vector API writers quiesced for the maintenance window.
   `ACCESS SHARE` does not block the platform owner from vector DML, so the
   required post-migration inventory must catch any vector write that races the
   migration despite that operational gate.

   `test:baseline-reconciliation` refuses to run while either frozen manifest
   contains the regeneration sentinel. It constructs isolated local databases
   on the pinned `17.6.1.141` container, captures the source manifest before any
   migration, applies migrations 1–3 one version at a time with pinned
   `migration up`, checks the exact history prefix after every version, and
   compares the target manifest plus non-badge application data fingerprints.
   It also proves fail-closed behavior for purchase and invalid-entitlement
   rows, external dependencies, direct and role-derived privileges, default
   ACL drift, an exact function-body change, a forced migration exception, and
   lock contention. Every runner failure must preserve the complete pre-attempt
   manifest, data fingerprint, and empty history.

   After any reviewed edit to migrations 1–3, regenerate the deterministic
   sanitized source and target files only on an isolated exact-version stack:

   ```bash
   pnpm run generate:baseline-reconciliation
   git diff -- \
     supabase/tests/reconciliation/legacy-migration-2.source.manifest.jsonl \
     supabase/tests/reconciliation/migration-3.target.manifest.jsonl \
     supabase/tests/reconciliation/platform-diff-allowlist.pg17.6.1.141.json
   pnpm run test:baseline-reconciliation
   ```

   Review every changed whole-object record. The isolated target-vs-target
   platform allowlist must remain empty. To generate a candidate for a reviewed
   production-vs-target comparison, first export the normalized production
   manifest read-only and off-repository, then run:

   ```bash
   node scripts/build-platform-diff-allowlist.mjs \
     supabase/tests/reconciliation/migration-3.target.manifest.jsonl \
     /approved/off-repository/production.manifest.jsonl \
     --postgres-image 17.6.1.141 \
     --output /approved/off-repository/platform-candidate.json
   ```

   The builder rejects every application-owned key. It emits exact keys and
   whole-record SHA-256 pairs only; wildcards, hash mismatches, version
   mismatches, and unused entries fail comparison. For optional Iceberg absence,
   only `platform-relation-presence/storage.iceberg_namespaces` and/or
   `platform-relation-presence/storage.iceberg_tables` may be candidates. An
   approved exact presence transition suppresses only platform shape and ACL
   records that cannot exist on the absent side. It cannot suppress Storage
   policies, unrelated relations, a shape change when both sides are present,
   or any Storage row inventory or data fingerprint. A generated candidate is
   not approval. Review it against direct dumps and then compare with:

   ```bash
   node scripts/compare-database-manifests.mjs \
     supabase/tests/reconciliation/migration-3.target.manifest.jsonl \
     /approved/off-repository/production.manifest.jsonl \
     --postgres-image 17.6.1.141 \
     --allowlist /approved/off-repository/platform-candidate.json
   ```

   Capture against the exact hosted Supabase database only through an owner-only passwordless
   URL file and one exact matching pgpass row. Never put a password-bearing URL
   on argv:

   ```bash
   bash scripts/capture-database-manifest.sh \
     --database-client-contract exact-docker-pgpass/v1 \
     --db-url-file /approved/off-repository/restored-read-only.url \
     --database-passfile /approved/off-repository/restored-read-only.pgpass \
     --project-ref <exact-project-ref> \
     --docker-bin <reviewed-absolute-docker-binary> \
     --postgres-image public.ecr.aws/supabase/postgres:17.6.1.141 \
     --postgres-image-id sha256:<64-lowercase-hex> \
     --output /approved/off-repository/production.manifest.jsonl
   ```

   These exact Docker arguments force `psql` from the pinned image. The helper
   verifies the tag resolves to that already-present ID, uses
   `--pull never`, and launches by ID. The database hostname in the passwordless
   URL must be reachable from the container; do not rewrite or expose the
   read-only credential merely to make a localhost-only address work.

   Never commit a production manifest or data fingerprint; catalog definitions,
   role names, and aggregate hashes are release evidence and belong in the
   encrypted off-repository archive.
6. Only after the backup, restore, source-manifest comparison, successful
   rehearsal, failure rehearsals, code review, and release approval all pass,
   open a production maintenance window. Keep signup and every application,
   Storage, and database writer closed. Take a fresh encrypted backup and run
   the reviewed one-version entrypoint from the exact clean `main` commit.
   Prepare and independently approve one immutable stage plan for each of
   migrations 1–3. The first plan chains to genesis; each later plan must name
   the prior verified completion digest. The entrypoint captures live raw and
   pinned-CLI history twice before mutation, applies only one
   `migration up --yes`, verifies the complete post-manifest, fingerprint,
   history, and migration-specific effects, re-attests the encrypted
   destination, and finalizes its completion digest. Do not begin the next
   version until the standalone completion verifier succeeds. Never call the
   CLI directly and never use `migration repair`.
7. Prepare and independently approve ten more one-version stages, continuing
   the same completion chain through migration 13. Before approval, remove
   top-level transaction controls from every still-unrecorded migration in this
   range, pass the static gate, and repeat the pinned-runner success and failure
   proofs against the verified local restore. Apply exactly these versions, one
   entrypoint invocation and one verified completion digest at a time:

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

   The same quiesced backup may be used only while its plan-approved freshness
   window remains valid and never for more than 3600 seconds. If it expires,
   stop before the next mutation, take and restore a new quiesced backup, and
   approve new plans that continue from the last completion digest. Do not
   extend or override the freshness limit.
8. Return to the full release tree. The reviewed raw and CLI evidence must show
   matching local and remote versions 1–13. The workflow's pinned migration-list
   parser fails closed unless the first full release has exactly 40 pending
   migrations, versions 14–53. No production release may run until every pending
   file passes the transaction-control gate and the exact release tree passes the
   pinned-runner failure proof. Require the complete normalized migration-13
   application manifest—including effective and default privileges—to match its
   clean exact-version checkpoint. Repeat the Storage query above against that
   checkpoint and production; both must now return all three buckets and all
   eleven policies with identical definitions. This satisfies the workflow's
   historical gate; it does not authorize the production release by itself.
   If an initial attempt records only part of versions 14–53, the workflow blocks
   a blind resume and requires incident review plus a reviewed forward path. Once
   version 53 and its complete prefix are present, later releases are allowed only
   when remote history remains an exact prefix of the release tree.

Record the exact applied versions, file hashes, backup and restore
evidence, comparison output, Storage manifest, project reference, operator,
approver, and UTC time in the release record. Never reset the hosted project,
use `--include-all`, mark a missing effect applied, manually execute migration
SQL outside the approved one-version entrypoint, or push the full 53-file tree
before the checkpoint passes. If an applied migration later fails, stop and use
a reviewed forward fix; do not rewrite it or mark it reverted.

### FOU-759 two-stage avatar and journal cutover

FOU-752/753 must not use the normal backend-first order for their first production release. The hardening migration rejects the previous raw/upsert avatar client, and the final cleanup removes journal-photo infrastructure used by the previous client. Use the same reviewed commit for both stages:

1. Confirm the migration-history reconciliation above is genuinely complete
   through migration 13 and no later migration is recorded. The 2026-07-22
   inventory in [`release-evidence/fou-759-production-inventory-2026-07-22.md`](./release-evidence/fou-759-production-inventory-2026-07-22.md)
   found missing historical profile infrastructure, so those versions must not
   be marked applied until a structural diff proves their effects exist or an
   approved bootstrap applies them.
2. Rerun the aggregate journal inventory from that evidence record. Journal
   rows, objects, multipart-upload parents and parts, and nonterminal
   `journal-progress` retention work must all be zero. Also require globally
   empty `billing_customers`, `subscriptions`, and legacy `purchases` (when the
   table exists), and prove the target Auth UUID has no existing
   `membership_active` entitlement.
3. Following [`production-canary-operator-runbook.md`](production-canary-operator-runbook.md),
   authorize exactly one existing non-anonymous Auth UUID with exactly one new,
   release-SHA-bound `production_canary` entitlement for no more than two hours.
   The reconciled baseline schema present by migration 13 supports
   `source_type`, `source_id`, bounded `ends_at`, and release metadata. This
   narrowly timed grant is required to exercise the compatibility client; it is
   not permission to skip the compatibility deployment or go directly to full.
4. Manually dispatch **Release production** from the exact reviewed
   release-candidate ref with `release_scope=compatibility-cutover`. Before
   synchronizing a Function secret or deploying anything, this scope uses the
   strict pinned CLI parser plus a dedicated read-only Management API query to
   prove remote history is exactly migrations 1–13. A separate aggregate-only
   read-only query proves there is exactly one membership row, it is the active,
   non-anonymous, UUID-backed, release-SHA-bound `production_canary` grant with
   a window no longer than two hours, all billing tables are empty, and the
   reconciled baseline removed `public.purchases`. No UUID or row is printed.
   Only then this scope synchronizes `BILLING_ENABLED=false`, deploys
   the no-JWT Stripe webhook guard and requires its exact `503`, deploys the three
   JWT-protected billing guards and requires their unauthenticated gateway `401`s,
   and only then deploys the schema-negotiating, prepared-thumbnail and
   text-only-journal client while intentionally skipping migrations. The client
   must treat the missing `profiles.avatar_url` column as the planned
   compatibility state and must make no profile-photo RPC or Storage request.
5. Using that same exact grant, verify normal sign-in, profile text editing,
   dashboard challenge-date synchronization, and journal create/edit/reload
   behavior in production. The profile-photo control must remain disabled, and
   all six journal text fields must work without a journal-photo request. Leave
   the previous database and empty bucket in place during this verification
   window. Require exact authenticated `503` responses from all three disabled
   billing functions and the workflow's exact webhook `503` evidence.
6. Rerun the zero-data and zero-billing inventories and verify that the exact
   UUID/grant/SHA-bound entitlement is still active and unmodified. Stop on any
   nonzero result; export or explicitly disposition user data and use the
   Storage API for object deletion. If the grant has expired or cannot remain
   valid through the full verification, revoke it and restart the reviewed
   sequence; never extend it or issue a replacement as a shortcut.
7. Dispatch the exact same reviewed ref with `release_scope=full`. There is no
   direct-full exception: the workflow verifies the same-commit compatibility
   deployment attestation before migration 14 can run. The backend stage now
   applies the avatar lifecycle registry and policies first and the fail-closed
   journal cleanup second, then rebuilds the frontend. Reuse the existing exact
   canary grant; do not extend, replace, or broaden it between release scopes.
8. Reload the profile after the full release. Verify the photo control is
   enabled and the authenticated upload Function independently turns a selected
   JPEG/WebP into a stripped square WebP thumbnail no larger than 256×256 and
   150 KiB. Confirm replacement removes the predecessor and profile text edits
   survive avatar-only saves. Then verify the final state with the queries
   below. A cached or custom browser client can no longer write Storage,
   reactivate a predecessor, or delete the canonical object; rejection is the
   intended fail-safe.
9. Before final acceptance, use an invited second non-privileged account with no
   entitlement to prove membership-only data and actions remain denied. Public
   signup stays closed; if that second account does not yet exist, the release
   remains closed and final acceptance is blocked until it is invited and the
   denial check passes.
10. Re-run the exact grant verification, then revoke that same UUID/grant-bound
    row and prove a fresh target-account session is denied as specified in the
    canary runbook. Preserve the revoked audit row and the UTC evidence.

```sql
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
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
2. **Enforce the Cloudflare project policy:** patch only the fixed Pages project,
   first require the exact reviewed Supabase project reference
   `mimolwojppbtsbvtqwpo`, exact matching project URL, and a publishable key that
   the fixed project's `/rest/v1/` gateway accepts. The proof uses only the
   public `apikey` header, rejects redirects and non-200 responses, and never
   reads or logs the response body or key. Then separately GET-verify exact
   Node/pnpm pins, live production Supabase
   wiring with every launch gate safe-off, automatic production deployment off,
   and mock-only `develop` previews with no live connection variables. Every
   release scope waits for this protected job before a Supabase mutation or
   frontend deployment.
3. **Verify the closed Auth policy:** read the hosted Auth configuration through
   Supabase's official Management API and require `disable_signup=true` plus
   `external_anonymous_users_enabled=false`. This read-only step gates all
   release scopes and completes before the workflow can link or mutate the
   backend.
4. **Guard the compatibility cutover:** only for
   `release_scope=compatibility-cutover`, first prove the strict CLI and raw SQL
   histories are exactly reconciled through migration 13 and an aggregate-only
   read-only query proves the one bounded same-release canary grant plus zero
   billing state. Then synchronize the disabled billing
   configuration, deploy and verify all four fail-closed billing endpoints, and
   then allow the compatibility frontend to build. This scope links only to read
   and cross-check history; it does not run a migration or write application
   schema/data. Generic `frontend-only` does not redeploy a Function and remains
   reserved for a backend-compatible rollback after the full cutover. Its
   dedicated gate uses the strict CLI and raw SQL inventories and requires
   post-cutover history with no pending migration; it cannot substitute for the
   initial compatibility scope. Only after
   Cloudflare accepts that frontend does the workflow publish a seven-day,
   exact-commit compatibility attestation.
5. **Migrate:** for `release_scope=full`, link the intended project without a
   stored database password, require the strict pinned-CLI history, and compare
   it with an authoritative read-only SQL inventory of
   `supabase_migrations.schema_migrations`. The raw inventory rejects any
   nonnumeric or extra record the CLI table could omit. Then require the exact
   first-cutover pending suffix and non-expired same-commit compatibility
   attestation, preview with
   `supabase db push --linked --dry-run`, and apply only migrations that follow the
   reconciled remote history with pinned `supabase migration up --linked`. The
   dry-run is a plan only; `db push` must never perform the actual mutation.
   Never use `--include-all` or run `supabase/schema.sql` manually in production.
   After `migration up`, the strict CLI/raw comparison runs again and requires
   zero pending local migrations before any Function secret is synchronized or
   any Function is deployed. Supabase CLI 2.109.0 obtains its short-lived login role from the Management
   API using `SUPABASE_ACCESS_TOKEN`; no database password is placed in workflow
   arguments, environment variables, or logs. The same raw inventory is checked
   again after migration.
6. **Synchronize secrets and deploy functions:** before linking or applying a
   migration, validate every deterministic worker/provider/retention secret
   pairing, minimum length, and distinctness rule without printing a secret.
   Only after the exact post-migration zero-pending gate succeeds, update
   Function Secrets and deploy
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
   The current closed canary synchronizes `BILLING_ENABLED=false` without Stripe
   values but still deploys all four guarded billing endpoints.
7. **Verify backend and release feature gates:** list remote migrations and
   functions, then require exact unauthenticated gateway `401` responses from
   `cancel-membership`, `create-checkout-session`,
   `create-customer-portal-session`, while the no-JWT `stripe-webhook` must
   return exact `503`. This proves all four current deployments are reachable
   without weakening the authenticated Functions' gateway protection. Response
   bodies are retained only in private runner-temporary files and are never
   printed. The owner canary uses its real session to require `503` from the
   other three before sign-out. Keep mock mode off and leave billing and public
   signup disabled.
8. **Build and deploy frontend:** build with production public configuration,
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
4. During the closed canary, use the invited owner's real authenticated session
   to confirm the three authenticated billing Functions each return `503`, and
   confirm the workflow's unauthenticated `stripe-webhook` smoke returned `503`.
   The frontend must expose no billing action,
   and no Stripe or billing row is created. Preview and create one share snapshot,
   inspect its server-rendered metadata, revoke it, and confirm the same URL then
   returns the generic 404. After a separately reviewed billing enablement,
   replace this check by exercising each authenticated billing function with a
   test member and confirming an unapproved origin receives no CORS access.
5. Skip Stripe lifecycle mutation while `BILLING_ENABLED=false`. After billing is
   separately enabled, send a Stripe test-mode signed event to `stripe-webhook`;
   confirm one expected subscription/entitlement transition and no duplicate
   transition on replay.
6. When the integration runtime is enabled, invoke health with the worker secret,
   confirm Cron history is healthy, and deliver one non-sensitive synthetic event
   to each canary-approved provider destination before enabling connection UI.
7. When provider connections are enabled, use a current group owner/admin to
   connect and confirm one isolated canary channel per provider. Confirm a group
   member sees status but no management actions; then test, disconnect, and
   verify queued sends are canceled before reconnecting.
8. Load the production frontend in a fresh browser profile. Confirm it targets
   the production Supabase project, mock identities are unavailable, public
   signup and billing remain absent, and core Dashboard, Check-In, and sign-out
   flows work. Follow
   [`production-canary-operator-runbook.md`](production-canary-operator-runbook.md)
   for the short-lived UUID-bound `membership_active` grant and revocation.
9. Review Supabase Function logs, Postgres logs, and—only after billing is
   enabled—Stripe delivery logs, plus integration health and Cron history for new
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
- **Frontend regression:** disable the affected feature flag when available,
  restore the known-good frontend in a reviewed rollback commit on protected
  `main` while preserving the complete applied migration tree, then dispatch
  with `release_scope=frontend-only`. That path fails unless strict CLI and raw
  histories prove the full cutover is applied with no pending migration, then
  validates and rebuilds the frontend without rerunning migrations or
  redeploying functions. Its backend contract must remain compatible with the
  already-applied schema.
- **Data integrity or credential incident:** disable the affected feature/provider,
  preserve logs, rotate exposed credentials, and follow the Supabase backup or
  point-in-time recovery procedure. Do not improvise SQL deletes in production.

After any recovery, rerun the production verification checklist and add the
failure mode to the automated migration, RLS, RPC, or function suite before
re-enabling the feature.
