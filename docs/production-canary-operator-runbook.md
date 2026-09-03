# Closed production canary operator runbook

This runbook is only for the private, owner-operated production canary while
public signup and billing remain disabled. It is not approval for a public
launch. The release workflow hard-codes these three gates and a reviewed code
change is required to alter them:

- `VITE_ENABLE_PUBLIC_SIGNUP=false`
- `VITE_ENABLE_BILLING=false`
- `BILLING_ENABLED=false`

The workflow also reads the hosted Auth configuration through Supabase's
official [`GET /v1/projects/{ref}/config/auth`](https://supabase.com/docs/reference/api/v1-get-auth-service-config)
endpoint before any release scope can proceed. It fails unless
`disable_signup` is exactly `true` and
`external_anonymous_users_enabled` is exactly `false`, `site_url` is exactly
`https://77-dominion-live.pages.dev`, and `uri_allow_list` contains only
`https://77-dominion-live.pages.dev/reset-password.html`. The check is
read-only, keeps the management token in memory, and never prints the response body.
The production Management API token must include the documented
`auth_config_read` permission (or `auth:read` OAuth scope).

## Configure closed Auth and production URLs before release

When the read-only release gate reports that either path is open, use the
manual **Configure production Supabase Auth canary** workflow at
`.github/workflows/configure-production-auth-canary.yml`. Dispatch it only from
the protected `main` branch, select the explicit confirmation checkbox, and
approve its protected `production` environment job. The workflow requires the
production `SUPABASE_ACCESS_TOKEN` secret and `SUPABASE_PROJECT_REF` variable;
the helper refuses any project reference other than the reviewed production
project.

The helper sends one request to Supabase's official
[`PATCH /v1/projects/{ref}/config/auth`](https://supabase.com/docs/reference/api/v1-update-auth-service-config)
endpoint with exactly this body:

```json
{
  "disable_signup": true,
  "external_anonymous_users_enabled": false,
  "site_url": "https://77-dominion-live.pages.dev",
  "uri_allow_list": "https://77-dominion-live.pages.dev/reset-password.html"
}
```

It then performs the official GET and requires both exact boolean values before
succeeding. Both requests reject redirects and use bounded timeouts. Error
responses and configuration bodies are never printed, and failure messages
contain at most the HTTP status. Do not broaden the body to synchronize the
entire Auth object: the GET response can contain unrelated provider and SMTP
configuration that this procedure is not approved to change. Supplying the
single exact `uri_allow_list` value also removes stale preview, localhost, and
historical production callbacks from the hosted tenant.

For a fine-grained Management API token, Supabase currently documents
`auth_config_write` and `project_admin_write` for PATCH and `auth_config_read`
for the verification GET (or the corresponding `auth:write` and `auth:read`
OAuth scopes). Environment approval is authorization to make only this fixed,
idempotent policy change; it is not approval to alter providers, URLs, email
templates, existing users, or sessions.

With billing disabled, Stripe credentials are not release prerequisites. The
one-time `compatibility-cutover` deploys and verifies all four guards before it
publishes the compatibility frontend, and the later full release redeploys them
after migrations. The automated workflow keeps
gateway JWT verification on for `cancel-membership`,
`create-checkout-session`, and `create-customer-portal-session`, so their
unauthenticated deployment smoke returns `401`; the no-JWT `stripe-webhook`
must return `503`. After the canary entitlement is granted, the operator uses
the invited owner's real session to require exact `503` responses from the
other three. No service-role key, stored user token, or weakened gateway is used
to manufacture that result.

FOU-759 has one deliberately narrow timing rule: after production history is
reconciled exactly through migration 13 and the zero-data/zero-billing checks
pass, one exact Auth UUID may receive one exact release-SHA-bound
`production_canary` entitlement for no more than two hours **before** the
`compatibility-cutover` dispatch. That same row must be used through the
same-commit full release and revoked afterward. This is not a direct-full
exception. Never skip compatibility, extend or replace the grant between
stages, or use more than one entitled account.

## Before granting canary access

1. Finish the migration-history reconciliation exactly through migration 13 and
   the corresponding backup/restore rehearsal and release gates in
   [`backend-release-runbook.md`](backend-release-runbook.md). Confirm migrations
   14–53 remain pending. Never grant before the migration-13 checkpoint or use
   the entitlement to bypass the required two-stage cutover.
2. Record the exact 40-character release commit, production project reference,
   operator, approver, target Auth user UUID, a newly generated grant UUID, and
   UTC start and expiry times in the encrypted release record. Do not use an
   email address as the database identity.
3. Use only an existing, non-anonymous owner verification account. Public signup
   and anonymous sign-in remain closed throughout the canary. A second invited,
   non-privileged account without an entitlement is mandatory for the post-full
   denial check. It need not exist before the grant, but final acceptance is
   blocked until it exists and that check passes.
4. Confirm the target UUID has no `membership_active` entitlement and that
   `billing_customers`, `subscriptions`, and the legacy `purchases` table (if it
   still exists) are globally empty. Any pre-existing row is a stop condition;
   do not overwrite, merge, or delete it.
5. Confirm the reviewed release tree hard-codes all three flags above to
   `false`, hosted Auth is closed, and no Stripe request was attempted. The
   compatibility workflow has not run yet; its three unauthenticated billing
   gateway `401` smokes and webhook `503` smoke are required immediately after
   the grant and before any full release.

## Grant one short-lived entitlement

Run the following through the approved production SQL operator path during the
closed maintenance window. Supply `canary_user_id` and `canary_grant_id` as UUIDs
and `release_sha` as the exact reviewed 40-character commit. The transaction
locks the relevant rows, refuses an absent or anonymous account, refuses any
existing membership or billing evidence, and grants access for two hours only.

```sql
\set ON_ERROR_STOP on

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table canary_parameters (
  user_id uuid primary key,
  grant_id uuid not null unique,
  release_sha text not null check (release_sha ~ '^[0-9a-f]{40}$')
) on commit drop;

insert into canary_parameters (user_id, grant_id, release_sha)
values (:'canary_user_id'::uuid, :'canary_grant_id'::uuid, :'release_sha');

lock table public.entitlements,
  public.billing_customers,
  public.subscriptions
in share row exclusive mode;

do $canary$
declare
  target_user uuid;
  target_grant uuid;
  target_release text;
  grant_start timestamptz := statement_timestamp();
  legacy_purchase_count bigint := 0;
begin
  select user_id, grant_id, release_sha
  into strict target_user, target_grant, target_release
  from canary_parameters;

  if not exists (
    select 1
    from auth.users
    where id = target_user
      and is_anonymous is false
  ) then
    raise exception 'Canary target must be one existing non-anonymous Auth UUID.';
  end if;

  if exists (
    select 1 from public.entitlements
    where user_id = target_user and entitlement_key = 'membership_active'
  ) then
    raise exception 'Canary target already has a membership entitlement.';
  end if;

  if exists (select 1 from public.billing_customers)
    or exists (select 1 from public.subscriptions) then
    raise exception 'Closed canary requires globally empty billing tables.';
  end if;

  if to_regclass('public.purchases') is not null then
    execute 'lock table public.purchases in share row exclusive mode';
    execute 'select count(*) from public.purchases'
      into legacy_purchase_count;
    if legacy_purchase_count <> 0 then
      raise exception 'Closed canary requires an empty legacy purchases table.';
    end if;
  end if;

  insert into public.entitlements (
    user_id,
    entitlement_key,
    status,
    source_type,
    source_id,
    starts_at,
    ends_at,
    metadata
  ) values (
    target_user,
    'membership_active',
    'active',
    'production_canary',
    target_grant::text,
    grant_start,
    grant_start + interval '2 hours',
    jsonb_build_object('release_sha', target_release)
  );
end
$canary$;

commit;
```

Do not extend `ends_at`, change `source_type`, use an open-ended entitlement,
or reuse the grant UUID for a future grant. If the transaction fails, stop and
investigate; do not weaken a guard or manually execute only part of it. Once it
succeeds, the exact same row—not a replacement—must span compatibility and full.

The compatibility workflow independently checks this boundary before its first
Function-secret or deployment mutation. Its dedicated read-only Management API
queries require exact raw migration history through migration 13, exactly one
total `membership_active` row, exactly one total `production_canary` membership
row, one currently active matching bounded row for `GITHUB_SHA`, a matching
non-anonymous Auth user, zero billing rows, and no legacy `purchases` table. The
query returns aggregate counts only; neither UUID nor entitlement row is logged.

## Verify the canary

Run this UUID- and grant-bound query. It must return exactly one row with
`active_now=true`, a two-hour-or-shorter window, and the recorded release SHA:

```sql
select
  user_id,
  entitlement_key,
  status,
  source_type,
  source_id,
  starts_at,
  ends_at,
  metadata ->> 'release_sha' as release_sha,
  ends_at - starts_at <= interval '2 hours' as bounded_window,
  metadata ->> 'release_sha' = :'release_sha' as exact_release_sha,
  status = 'active'
    and starts_at <= clock_timestamp()
    and ends_at > clock_timestamp() as active_now
from public.entitlements
where user_id = :'canary_user_id'::uuid
  and entitlement_key = 'membership_active'
  and source_type = 'production_canary'
  and source_id = :'canary_grant_id'::uuid::text;
```

Immediately dispatch `release_scope=compatibility-cutover` from the exact
recorded release SHA. Do not dispatch full unless compatibility succeeds, its
same-commit keyed attestation exists, the exact grant remains active and
unmodified, and the zero-data/zero-billing inventories still pass. The workflow
publishes that seven-day artifact only after Cloudflare accepts compatibility;
it contains only a format version, the release SHA, and a keyed HMAC-SHA-256
proof—never the UUID, raw entitlement row, raw row fingerprint, or HMAC key. The
full run selects exactly one immutable artifact from a successful exact-SHA
`main` compatibility run and verifies the proof both before migrations and
after the zero-pending migration gate. Then dispatch
`release_scope=full` from that exact same SHA and reuse the same grant. If the
grant expires or cannot cover both stages, revoke it and restart the reviewed
sequence; never extend it or issue a replacement as a shortcut.

Do not rerun a successful compatibility dispatch at the same SHA: two artifacts
with the exact name are intentionally treated as ambiguous and fail closed.
Restart from a newly reviewed release SHA if the successful stage must be
repeated.

After compatibility and again after full, verify all of the following and
record the results:

- the target account can sign in and complete the approved core canary flow;
- after full, the invited second account remains denied membership-only data and
  actions; final acceptance is blocked until this check passes;
- signup and anonymous sign-in remain unavailable;
- billing controls remain absent or disabled; using only the invited owner's
  real browser session, `cancel-membership`, `create-checkout-session`, and
  `create-customer-portal-session` each return exact `503`, while the workflow's
  unauthenticated `stripe-webhook` smoke has already returned exact `503`;
- `billing_customers`, `subscriptions`, and legacy `purchases` remain globally
  empty; and
- Supabase Auth, Function, and Postgres logs contain no unexpected authorization,
  Stripe, elevated-role, or repeated-retry activity.

The first query below must return `0, 0`. The second must return `NULL` after the
reconciled baseline has removed the legacy table. If it instead returns
`public.purchases`, run the third query and require `0`:

```sql
select
  (select count(*) from public.billing_customers) as billing_customers,
  (select count(*) from public.subscriptions) as subscriptions;

select to_regclass('public.purchases') as legacy_purchases_table;

-- Run only when the preceding result is public.purchases.
select count(*) as legacy_purchases
from public.purchases;
```

The only billing-endpoint test while disabled is the fail-closed `503` check
above. Do not attempt a successful checkout, customer-portal session,
cancellation, or webhook transition; those belong to the later reviewed billing
launch.

## Revoke and prove removal

Revoke at the end of the test even if the two-hour expiry has passed. Preserve
the audit row; do not delete it. The exact binding prevents revoking a paid or
unrelated entitlement:

```sql
\set ON_ERROR_STOP on

begin;
set local lock_timeout = '5s';

create temporary table canary_revoke_parameters (
  user_id uuid primary key,
  grant_id uuid not null unique
) on commit drop;

insert into canary_revoke_parameters (user_id, grant_id)
values (:'canary_user_id'::uuid, :'canary_grant_id'::uuid);

do $revoke$
declare
  target_user uuid;
  target_grant uuid;
  changed_rows integer;
begin
  select user_id, grant_id
  into strict target_user, target_grant
  from canary_revoke_parameters;

  update public.entitlements
  set
    status = 'revoked',
    ends_at = least(coalesce(ends_at, clock_timestamp()), clock_timestamp()),
    updated_at = clock_timestamp()
  where user_id = target_user
    and entitlement_key = 'membership_active'
    and source_type = 'production_canary'
    and source_id = target_grant::text
    and status = 'active';

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception 'Expected exactly one active canary entitlement to revoke.';
  end if;

  if exists (
    select 1 from public.entitlements
    where user_id = target_user
      and entitlement_key = 'membership_active'
      and source_type = 'production_canary'
      and source_id = target_grant::text
      and status = 'active'
      and (starts_at is null or starts_at <= clock_timestamp())
      and (ends_at is null or ends_at > clock_timestamp())
  ) then
    raise exception 'Canary entitlement is still active.';
  end if;
end
$revoke$;

commit;
```

Sign the target account out, start a fresh session, and confirm membership-only
data and actions are denied. Re-run the no-billing-row checks and attach the
revoked row plus UTC revocation time to the release record.

## Rollback and incident rules

- Revoke the canary grant first. Keep Auth signup closed and all three feature
  gates `false` throughout rollback.
- For a frontend-only regression after the full cutover, land a reviewed
  backend-compatible rollback commit on protected `main` while preserving the
  complete applied migration tree, then dispatch with
  `release_scope=frontend-only`. The workflow's strict CLI/raw history gate
  requires post-cutover history with nothing pending; never use this scope in
  place of the initial compatibility cutover or publish Cloudflare directly.
- For a Function regression with compatible schema, redeploy reviewed known-good
  function source. Do not blank secrets to disable code.
- After a migration, roll forward with a reviewed migration. Never reset hosted
  Supabase, rewrite or mark an applied migration reverted, or run an ad hoc down
  migration.
- If any billing or Stripe evidence appears, stop the canary, preserve it as
  incident evidence, and revoke access. Do not delete rows or events to make the
  invariant appear clean.

This closed canary validates deployment and an existing account only. Public
signup, anonymous access, real billing, Stripe lifecycle tests, and a public
launch each require their own reviewed enablement change and release approval.
