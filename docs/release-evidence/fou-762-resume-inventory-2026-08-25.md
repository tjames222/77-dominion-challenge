# FOU-762 hosted project resume inventory — 2026-08-25

This record captures the aggregate, read-only inventory taken after the product
owner authorized resuming the paused hosted Supabase project. Resuming the
project was the only hosted mutation. No migration, schema repair, function
deployment, Storage change, or customer-data write was performed.

## Observed state

- Project status: `ACTIVE_HEALTHY`
- Postgres: `17.6`
- Management API migration list: empty
- `supabase_migrations.schema_migrations`: absent, despite an existing legacy
  application schema
- Auth users: 1
- Purchases: 0
- Reward entitlements: 0
- `journal-progress`: one private bucket, 0 objects, and four journal-specific
  Storage policies
- Extensions `pg_cron` and `pg_net`: absent
- Account-lifecycle request infrastructure: absent
- Profile-photo cleanup health infrastructure: absent
- Deployed Edge Functions: only `create-checkout-session`,
  `create-customer-portal-session`, and `stripe-webhook`

No keys, tokens, member identifiers, journal content, or object paths were read
or recorded.

## Release stop

**STOP:** the resume does not authorize a production migration or prove backup
and restore readiness. FOU-762 remains blocked until protected backup/restore
evidence and the reviewed legacy-schema reconciliation complete successfully.
The checked-in release tree now contains 53 migrations. Follow the guarded
sequence in [`backend-release-runbook.md`](../backend-release-runbook.md):
reconcile versions 1–13 first, then verify the exact 40-file pending sequence,
versions 14–53. Never reset the hosted project, push the full tree before the
checkpoint, or mark absent effects as applied.
