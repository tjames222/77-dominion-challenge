# Production account-request inbox verification

The full production backend job runs
`scripts/verify-production-account-request-inbox.mjs` immediately after
completed raw/CLI migration-history verification and credential cleanup,
before Edge secret synchronization, remaining Edge deployment or frontend
publication. The two backward-compatible share/integration readers are deployed
after the validated migration dry-run and before migrations, so new late-day
or V2 payloads never precede their readers. Optional integration delivery stays
disabled unless the existing validated runtime condition enables it; these
reader deployments add no secrets or activation behavior.
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

- Exactly 70 distinct ordered migration versions, ending at
  `20260930161218` named `share_submitted_progress_v2`, with fixed
  SHA-256 `09d7293ce15add9360f88a89337ea54822e64f015b1e6ef63eaba1543f36c872`
  of the comma-joined ordered version list. The inbox migration's exact name
  and all three original-77 suffix names are also required. Historical 66/67
  and partial 68/69 checkpoints cannot satisfy this post-release gate.
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
For this 67-to-70 release, the fresh capture uses the explicit
`post-admin-inbox-67` mode before migrations, from the same protected main
commit. The prior exact66 artifact does not cover the current database.
The old canary cutover/restart path and owner grant are not used for this
post-cutover release. The exact protected run must itself obtain all eleven
true booleans from the live read-only endpoint. Local fixture results do not
claim that hosted catalog state or its transaction-read-only setting already
matches. Stop and inspect a failure; do not switch endpoints, weaken hashes,
broaden grants or bypass this step to publish frontend code.

## Separate original77 completion checkpoint

The same backend job next runs `scripts/verify-production-original77.mjs`,
before canary continuity verification, remaining Edge publication or frontend
publication. This additive checkpoint does not replace or combine the eleven
inbox predicates. It uses the same fixed read-only Management endpoint,
PostgreSQL 17.6 requirement, existing two environment bindings, 15-second
deadline, 4 KiB result limit and one-minute workflow timeout.

Exactly eight true booleans are required: exact70 history, read-only pinned
runtime, completion function contracts, completion trigger contracts,
check-in constraints and indexes, private completion-ledger protections,
the active Finisher definition, and the compatible share contract. The
function contract includes every overload of the selected names, canonical
definitions, owners, execution attributes, configuration, named ACL tuples
and effective API-role execution. Ledger checks include column shapes,
defaults, table and column ACLs, effective privileges, constraints, indexes,
RLS and policies. Trigger checks include enablement and binding.

Besides migration history and PostgreSQL catalogs, this separate query reads
only the fixed `original_77_completed` badge-definition configuration row.
It does not read account, check-in, award or completion-event rows and never
invokes application functions. No live objects are created or repaired.

Canonical contract digests must be derived from unchanged application
migrations in an owned, cached PostgreSQL 17.6 fixture with no network and
temporary memory-backed storage. Its provider dependency shapes are not
managed Auth or Storage services; catalog proof does not replace native
authorization, RPC/concurrency, browser or full release tests. The fixture
retains all application functions, triggers and migration preflights. The
negative catalog suite changes only synthetic local state inside transactions,
rolls it back and rechecks the positive contract. Run it with:

```sh
node --test scripts/verify-production-original77.test.mjs
node --test scripts/verify-production-original77.sql.test.mjs
```

Any deliberate source, migration-count or catalog change requires a reviewed
checkpoint update and fresh local derivation; neither a permissive history
prefix nor production-learned hashes are acceptable. The live workflow must
obtain both the eleven-field inbox receipt and eight-field original77 receipt
before proceeding. A missing or false predicate stops publication; there is
no alternate write endpoint, manual timing gap, or repair fallback.
