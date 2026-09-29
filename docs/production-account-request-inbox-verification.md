# Production account-request inbox verification

The full production backend job runs
`scripts/verify-production-account-request-inbox.mjs` immediately after
completed raw/CLI migration-history verification and credential cleanup,
before Edge secret synchronization, Edge deployment or frontend publication.
Any failed check fails the backend job; the existing frontend dependency
requires backend success. No new workflow input, permission, environment,
secret, temporary database login or release authority is introduced.

## Fixed read-only contract

The helper accepts only the existing protected `SUPABASE_ACCESS_TOKEN` and
the exact existing `SUPABASE_PROJECT_REF=mimolwojppbtsbvtqwpo`. Its URL is
fixed to the Supabase Management API's
[`database/query/read-only` endpoint](https://supabase.com/docs/reference/api/v1-read-only-query).
It sends one source-fixed `WITH … SELECT`, with no caller-provided SQL or
parameters, to avoid ambiguity about multi-statement response handling.

The query uses a materialized transaction-local canonical-deparse context
and explicit CASE dependencies before search-path-sensitive catalog output,
following the existing post13 contract verifier. Catalog references are
schema-qualified. Canonical settings are pg_catalog search path, UTC and
ISO/YMD. Transaction-local statement/lock timeout settings are included, but
setting statement_timeout inside the running SELECT is **not claimed as a
proved server-side deadline for that same statement**. Independently, the
client enforces a 15-second wall-clock deadline, aborts requests, caps the
streamed response at 4 KiB, refuses redirects, and suppresses remote errors.
The workflow step has a one-minute outer timeout and passes no other backend
secrets through its clean environment.

The only database-row reads are migration history and PostgreSQL catalogs.
No account, request-ledger, Auth/session/MFA, Vault/decrypted-value or email
rows are read, and no application RPC or guard is invoked. No database
objects, grants, policies or data are changed.

Success requires exactly one JSON row with exactly eleven boolean fields,
all true. Missing, extra, null, false, nonboolean or oversized results fail
closed. Successful logs contain only the fixed safe boolean receipt; failures
never include raw SQL, response text, credentials or provider diagnostics.

The predicates verify:

- Exactly 67 distinct ordered migration versions, ending at
  `20260929000950` named `site_admin_account_requests_inbox`, with fixed
  SHA-256 `5593452c85b58a6f666815475a5cdfed619b788c52e177074c76d294ed795a52`
  of the comma-joined ordered version list.
- PostgreSQL 17.6 with an explicitly read-only transaction and exact canonical
  settings. An unsupported hosted runtime fails; there is no permissive fallback.
- One exact inbox RPC overload and its complete native-definition hash,
  argument/default/result signature, language, volatility, postgres owner,
  SECURITY DEFINER attributes, empty search path, exact ACL and effective
  authenticated-only execution.
- Exact existing request-identity, native-MFA and permission-guard definitions,
  owners, ACLs and configuration.
- The reviewed four-column inbox index plus the three pre-existing ledger
  index definitions, owners and valid/ready/live state.
- Ledger owner, enabled/FORCE RLS, exact table/column grants and column shapes,
  both existing own-row policies and effective member read/limited-insert
  permissions.

Expected hashes were derived from the exact source migrations in an empty,
owned, network-none PostgreSQL 17.6.1.141 fixture. They are not learned from
production, and the verifier must never repair live objects to match them.
Future migrations or intentional changes to these catalogs require a reviewed
update to this explicit checkpoint; this is not a rolling "latest" contract.

## Local verification and operator gate

Run the pure transport/boundary tests with:

```sh
node --test scripts/verify-production-account-request-inbox.test.mjs
```

With the already-cached pinned fixture image, run:

```sh
node --test scripts/verify-production-account-request-inbox.sql.test.mjs
```

The native fixture has no network, real actors, guard calls or hosted state.
It proves canonical results from different initial search paths, a local
read-only role, exact history, and rollback-only refusal of RPC, ACL, index,
RLS, policy and history drift. These definition/catalog tests complement,
not replace, the existing behavioral inbox authority tests and required CI.

Before a full release, retain the existing protected-main checks, production
approval and separately reviewed fresh backup gate; keep `send_test_email=false`.
The old canary cutover/restart path and owner grant are not used for this
post-cutover release. The exact protected run must itself obtain all eleven
true booleans from the live read-only endpoint. Local fixture results do not
claim that hosted catalog state or its transaction-read-only setting already
matches. Stop and inspect a failure; do not switch endpoints, weaken hashes,
broaden grants or bypass this step to publish frontend code.
