# FOU-757 prelaunch audit — 2026-08-13

This is a read-only launch inventory captured at `2026-08-13T16:34:19Z`.
It records what was observed; it does not authorize a production migration,
deploy, purge, or payment.

## Release source

- Repository: `tjames222/77-dominion-challenge`
- Audited integrated `develop`: `21fda0b03fd951e1aa9ec0505bb49759d0775503`
- Audited `main`: `19820a64ec09ad689359393a4a7f8bad034445b1`
- `develop` was 353 commits ahead of `main` when inspected.
- No open pull request existed at the start of the audit.
- Clean `develop` frontend unit baseline: 523 passing tests.

## GitHub controls applied

- A protected `production` environment exists.
- Production deployments are restricted to `main`.
- `main` and `develop` require pull requests, conversation resolution, the four
  named checks, and administrator enforcement; force pushes and deletions are
  disabled.
- Required checks: `Frontend`, `Database`, `Edge Functions`, and
  `Routes, accessibility, and visuals`.
- Public production variables are configured for project ref
  `mimolwojppbtsbvtqwpo`, the Pages origin, public share origin, allowed origin,
  Pages host, and Supabase public configuration.
- `VITE_ENABLE_GROUP_INTEGRATIONS=false` is recorded. The workflow also hard-codes
  this safe-off state and `VITE_ENABLE_MOCKS=false`.

There is currently one repository collaborator, so independent human approval is
not possible. The named reviewer is the repository owner and self-review remains
allowed. Add a second trusted collaborator before representing the gate as an
independent review.

## Secrets not yet configured

The audit found no usable production credentials for the following required
release operations. Values must be created by their human owners and stored in
the protected GitHub environment; they must never be added to this file.

- Supabase access token and database password
- Stripe live secret key, webhook signing secret, and approved live price ID
- Cloudflare least-privilege API token and account ID
- Profile-photo cleanup worker secret after FOU-802 review

Slack and Discord stay safely off; their optional secret set must remain absent.
The retired-Community destructive worker must also remain dormant unless its
separate approval and complete secret set are recorded.

## Production Supabase inventory

- Project: `mimolwojppbtsbvtqwpo`
- Region: `us-west-2`
- Status: `ACTIVE_HEALTHY`
- Postgres: `17.6` / engine 17
- Remote migration records returned by the management API: none
- Deployed Functions: `create-checkout-session`,
  `create-customer-portal-session`, and `stripe-webhook`
- Auth users: 1
- Profiles: 1
- Challenge entries, Check-Ins, feed items, billing customers, purchases,
  subscriptions, entitlements, groups, memberships, invitations, social posts,
  likes, comments, journal entries, journal photos, user badges, game stats, and
  point events: 0
- Storage objects: 0 across all buckets

The product owner approved the prelaunch zero-social-data exception for FOU-765
on 2026-08-13, and a fresh aggregate inventory reconfirmed all affected counts
at zero. The decision and fail-closed release condition are recorded in
[`fou-765-zero-data-exception-2026-08-13.md`](./fou-765-zero-data-exception-2026-08-13.md).
This makes a reviewed baseline/bootstrap safer; it does not replace the required
backup, structural diff, migration reconciliation, or dry run.

## Security and operational findings

- Leaked-password protection is disabled in production Auth and must be enabled
  before signup opens.
- The old hosted schema exposes several `SECURITY DEFINER` RPCs to signed-in
  users. The reviewed forward migration chain and post-migration advisor report
  must prove that only intentional authenticated APIs remain.
- There is no separate staging Supabase project or branch.
- Production backup/PITR evidence was not available through the connected tools.
- Stripe live product, portal, webhook, and delivery evidence is not configured.
- Cloudflare currently deploys `main` automatically. Disable automatic
  production-branch deployments before moving `main`; the protected GitHub
  workflow now owns backend-first release ordering and the Cloudflare upload.
- The Pages origin responded, but production security headers were absent before
  this release candidate. `public/_headers` adds the reviewed header policy.

## Stop conditions before `main`

Do not merge the production release PR or approve its environment until all of
the following are attached to the Linear release record:

1. Backup/PITR identifier and UTC verification time.
2. Reconciled migration history plus reviewed dry-run output.
3. Real staging run against the exact candidate with two-account isolation and
   rollback evidence.
4. Supabase Auth sender/redirect/password configuration and delivered email tests.
5. Owner-approved customer policies and account lifecycle operator.
6. Stripe live configuration and controlled webhook replay evidence.
7. Cloudflare automatic production deploy disabled and least-privilege deploy
   credentials installed.
8. All required checks green on the exact `develop` and `develop` → `main` PRs.
