# Site-admin account and audit reads (FOU-1502, partial delivery)

These four read-only RPCs extend the [security foundation](site-admin-foundation.md).
They do not construct an Auth Admin client, change accounts/roles, append audit
events, or expose an admin UI by themselves. The separately shipped
[read-only admin screen](site-admin-read-ui.md) consumes these contracts.
No migration grants anyone admin access.

Every call first requires its own captured expected actor, current canonical
permission, live healthy Auth session/account, allowed Origin, and verified
same-session TOTP/AAL2. Reads do not require the additional ten-minute write
step-up. A member, crew owner/admin, stale/revoked site admin, service key alone,
or metadata flag cannot bypass this boundary. Each public function uses a stable
statement snapshot and empty search path; serializers remain private and have
no client execute grant. All successful responses set `private, no-store` and
`Pragma: no-cache`. A later UI/Edge adapter must also enforce no-store on transport
errors and clear actor-scoped state on account/lifecycle changes.

## Account list/detail

| RPC | Arguments |
| --- | --- |
| `site_admin_list_users` | `target_expected_actor_id`, `target_limit=25`, `target_search=''`, `target_status='all'`, `target_role='all'`, `target_sort='newest'`, `target_cursor=null` |
| `site_admin_get_user` | `target_expected_actor_id`, `target_user_id` |

Both require `users.read`. List returns
`{schemaVersion:1, actorId, observedAt, items, nextCursor}`; detail returns the
same envelope with one `item` instead of list/cursor. Empty lists have `items:[]`
and `nextCursor:null`; a missing detail returns `admin_record_not_found` (404)
only **after** authorization. There is no approximate or client-calculated total.

The allowlisted account item includes:

- Auth UUID, profile name (120-character cap), canonical Auth email (254-character
  cap), created/confirmed/last-sign-in timestamps, anonymous flag, current
  suspension boolean and stored ban deadline, soft-deleted timestamp.
- Canonical application role and revision.
- `deletionPending` and `deletionRequestStatus`, only from account-deletion
  requests in `requested` or `in_progress`; fulfilled/cancelled/declined requests
  do not imply pending deletion. Operator notes are never selected.
- Current crew UUID/name (80-character cap)/crew-local role; no crew description,
  invitation, private conversation, or integration content.
- `activationSnapshot`: **stored** activation status, participation mode, start
  date, review-required flag and recorded timestamp. This is not an effective
  current-day/completion calculation.
- `statsSnapshot`: stored total points, app/perfect-day streak counters, last-seen
  local date and recorded timestamp. A stale stored streak is not relabeled as
  today's streak. A missing stats/profile row is `null`, not invented zeroes.
- `subscriptionSnapshot`: newest membership subscription by `updated_at DESC,
  id DESC`, containing only allowlisted status, period end, cancellation-at-period
  flag and recorded timestamp. An unknown status is `unknown`. No Stripe IDs,
  metadata, customer/card/payment data, or effective-access decision is returned.

No passwords, Auth metadata, factors/secrets, tokens, avatars/photo objects,
journal/prayer/action-note contents, lifecycle notes, reward codes, or raw
request bodies are selected. These account reads do not grant direct access to
the underlying tables or private serializers.

### Search, filters and ordering

`target_limit` must be 1–50. The server fetches at most `limit + 1` matching IDs
before serializing at most `limit` summaries. There is no OFFSET pagination and
no whole-table JSON payload.

Search is a case-insensitive **literal prefix** of canonical Auth email or
profile name. It trims outer spaces, allows at most 80 input characters, rejects
control characters, and escapes `%`, `_`, and backslash. This is not arbitrary
substring/full-text search. Supporting prefix indexes are explicit and reside
only in application-owned schemas.

Role filter: `all`, `member`, `site_admin`.
Status filter: `all`, `confirmed`, `unconfirmed`, `suspended`, `deletion_pending`,
`deleted`. These are independent facets: suspension means `banned_until` is in
the future; confirmed/unconfirmed and suspended exclude soft-deleted accounts;
`deleted` means the retained Auth row has `deleted_at`, not an assertion that
the entire asynchronous erasure pipeline finished. `deletion_pending` reflects
an active request regardless of other facets. `all` includes retained deleted
and anonymous rows. The app must not invent an `active` filter from these fields.

Sort is `newest` or `oldest`, using `(created_at, UUID)` in the same direction.
For ordering/cursors only, missing `created_at` is treated as Unix epoch; the
display field remains `null`. UUID is the stable tie breaker. Each response is
internally snapshot-consistent. Later pages are new authorized reads, not a
long-lived database snapshot: refresh from page one to see newly inserted rows
above a cursor or changed filter membership.

Return `nextCursor` unchanged for the next request. Its version, actor, query
fingerprint, timestamp and UUID are validated; changing actor/search/filter/sort
invalidates it with `admin_invalid_cursor`. Cursors are navigation state, **not
authorization credentials**. They must not be stored across an account switch.
Page size can change without changing query identity. Unsupported arguments
produce `admin_invalid_input`; malformed/overflow/scalar cursors are caught and
never echo raw payloads or database cast diagnostics.

## Audit list/detail

| RPC | Arguments |
| --- | --- |
| `site_admin_list_audit` | `target_expected_actor_id`, `target_limit=25`, `target_user_id=null`, `target_action='all'`, `target_outcome='all'`, `target_cursor=null` |
| `site_admin_get_audit_event` | `target_expected_actor_id`, `target_event_id` (decimal string) |

Both require `audit.read` independently of `users.read`. Authorized admins may
read the platform's existing redacted ledger, including other admins' actions;
this does not authorize any new operation or private-content read. Actor IDs
remain UUIDs; the initial offline bootstrap's actor is `null`.

Audit items contain only sequence ID, actor/target UUIDs, permission/action,
selected reason code, role-only before/after, request/correlation UUIDs,
environment, UTC occurrence time, outcome and safe error category. The request
signature/digest and other internal tables are not exposed.

Audit IDs and cursor IDs are **decimal strings** so JavaScript cannot round
Postgres bigint values. The list is descending sequence order, with a strict
`id < cursor.id` boundary, maximum 50 items plus one probe, and no full count.
Sequence order represents ledger insertion order; it is not claimed to be a
transaction-commit timestamp ordering across concurrent writers. Filter by target
user UUID, action (`all`, `roles.assign`, `roles.bootstrap`) and outcome (`all`,
`success`, `failure`). Cursor actor/query/version/type/size validation mirrors
the account list. Detail IDs must be positive canonical bigint decimal strings;
overflow is a stable `admin_invalid_input`, not a leaked cast error.

## Validation and intentionally omitted fields

The isolated PostgreSQL 17 fixture executes the exact migration as a
non-superuser application owner, with the Auth tables owned by a distinct
`supabase_auth_admin` role. It first reproduces the rejected original Auth index
DDL, then verifies the corrected migration without ownership escalation or new
Auth privileges. It authorizes two
account shapes, injects privacy sentinels into excluded columns, and tests all
four direct RPC boundaries, stale role/permissions/session, AAL1, malformed
cursors, exact pages/ties/nulls, literal prefix search, status meanings, bigint
audit IDs, no-store and read-only behavior. EXPLAIN on 3,000 seeded accounts
verifies prefix and ordered-keyset index paths in the actual list-query shape,
including its bounded live Auth primary-key lookups. This proves those seeded
plans, not a universal latency guarantee for every filter or account count. The
registered pgTAP 250 file checks 28 grants, private serializers, indexes, projection
boundaries and stable function settings.

### Provider-owned Auth compatibility

Supabase owns `auth.users`; the application migration role cannot create indexes
on that relation merely because it has SELECT or TRIGGER privileges. The original
unreleased index statements failed in full Supabase CI and are replaced here.
No Auth ownership, grants, columns, data, policies or provider settings are changed.

`private.site_admin_user_directory` contains exactly UUID, lowercased canonical
Auth email and the original nullable Auth creation timestamp. It is a transactional
search projection, **not an authorization or session cache**. RLS is enabled and
all direct client/service grants are revoked. Its created-at/UUID and email-prefix
indexes are application-owned; profile name, subscription and audit indexes also
remain application-owned. It contains no health flags, roles, metadata, secrets or
private content. Retention follows the Auth UUID's `ON DELETE CASCADE` reference.

A private fixed-search-path definer trigger synchronizes Auth inserts and email/
creation-date changes in the same transaction. A table lock covers trigger
installation plus initial backfill, preventing an update gap. A failure rolls
back the Auth write as well as the projection rather than silently leaving stale
data; the fixture covers successful provider writes and failed INSERT/UPDATE
rollback. Because a broken Auth trigger can disrupt account operations, full
Supabase CI and a reviewed migration are required before deployment.

Candidate IDs come from the private search indexes. Each is joined back to live
Auth by its guaranteed primary key and the canonical role table; all health/status
filters and the returned email/timestamps still come from Auth. Equality fences
reject an operator-corrupted projection row instead of presenting a false search
match or sort timestamp. Missing/corrupted rows can omit a search result and must
be repaired operationally; they never grant admin authority. Direct account detail
does not depend on the projection. No asynchronous synchronization or stale TTL
is involved.

The platform-only legacy rehearsal excludes exactly the new application trigger
identity, alongside the three existing application Auth triggers, because their
private functions are not part of that platform fixture. Unknown/platform
triggers remain intact. A real Auth-only `pg_dump` restore regression covers this
boundary. Full-chain CI must still verify provider schema compatibility.

The local Supabase stack remains unavailable; `db advisors --local`,
`db pull --local`, and `migration list --local` failed to connect. Raw SQL was
iterated in an owned, network-none tmpfs database, then the pinned CLI generated
`20260913065057_site_admin_read_apis.sql`. No hosted writes occurred. The canonical
schema-drift fixture's Auth enum/column dependencies were separately verified
through schema-only reads and expanded in a separate commit.

This is not the entire Users screen contract. Testing-grant status/expiry and
effective Stripe-versus-test access, challenge current day/canonical completion,
badge/reward aggregates, DAU/retention/other product metrics, operational queues,
CRUD/recovery/global session revocation remain follow-up work. They are omitted
rather than inferred from incomplete state. The read-only UI and browser tests
are documented separately; neither completes those remaining ticket requirements.

References: [Supabase security](https://supabase.com/docs/guides/security/product-security),
[Auth data and supported triggers](https://supabase.com/docs/guides/auth/managing-user-data),
[Postgres multi-column indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html),
[Supabase pagination](https://supabase.com/docs/guides/database/pagination).
