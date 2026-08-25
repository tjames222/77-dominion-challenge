# FOU-762 legacy platform manifest capture — 2026-08-25

Scope: local implementation and exact-version rehearsal only. No hosted
Supabase project, credential, schema, data, function, Storage object, or
migration history was read or changed while producing this evidence.

## Frozen contract

- Base: `origin/develop` at `895bfb05786daa7d08491eba8369d016f4e35cc1`.
- Supabase CLI: `2.109.0`.
- PostgreSQL image: `public.ecr.aws/supabase/postgres:17.6.1.141`.
- Every selected Storage relation emits a
  `platform-relation-presence/storage.<relation>` record.
- `storage.iceberg_namespaces` and `storage.iceberg_tables` are optional.
- The other seven relations are mandatory; this explicitly includes
  `storage.buckets_vectors` and `storage.vector_indexes`.
- An absent optional relation is never queried. Its row inventory and baseline
  data fingerprint use the canonical zero-row SHA-256 while the independent
  presence record retains the fact that the relation is absent.

## Allowlist boundary

An exact, version-pinned optional presence transition may suppress only the
full platform relation, direct/effective relation and column ACL, and platform
trigger records that cannot exist on the absent side. It cannot suppress:

- application or Storage policies;
- unrelated platform relations;
- shape or ACL drift when both sides contain the optional relation;
- `storage-row-inventory/*`; or
- `data/storage.<relation>/all-rows` fingerprints.

The candidate builder therefore emits only the one or two reviewed presence
records for an empty optional-Iceberg absence. A nonzero optional relation,
missing mandatory vector relation, malformed presence transition, version
mismatch, unused entry, or any unrelated drift remains a hard stop.

## Local verification

The checked-in unit and reconciliation harness covers:

1. Exact presence-only candidate generation and scoped suppression.
2. Unrelated record, policy, row-inventory, and both-present drift rejection.
3. Manifest and fingerprint refusal when a vector relation is absent.
4. Capture and migration of a legacy fixture with both Iceberg relations absent.
5. Equality of that migrated fixture to the modern migration-3 target after
   applying only the exact two-entry presence allowlist.
6. Exact fingerprint equality between absent Iceberg and present-but-empty
   Iceberg.
7. Rejection of a nonempty Iceberg inventory by both manifest and fingerprint
   comparison.
8. Read-only URL capture through the pinned Docker `psql` fallback.

The frozen source and migration-3 target manifests contain all nine explicit
presence records. They contain no production identifiers or production data.
