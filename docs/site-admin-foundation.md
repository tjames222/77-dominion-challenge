# Site-admin security foundation (FOU-1502, partial delivery)

This is a backend foundation, not the completed admin console. Applying the
migration assigns every existing account `member`, installs the default for new
accounts, and **does not grant anyone admin access**. It does not alter crew
roles, Stripe entitlements, existing owner testing grants, challenge state,
points, badges, rewards, journal content, or account lifecycle requests.

## Canonical authorization

`private.site_roles`, `site_permissions`, `site_role_permissions`, and
`site_user_roles` define authority. The initial matrix has `member` (no admin
permissions) and `site_admin` (the eight permissions below):

| Permission | Intended future boundary |
| --- | --- |
| `users.read` | Allowlisted account summaries |
| `users.manage` | Reviewed Auth/lifecycle operations |
| `roles.manage` | Role assignment |
| `testing.manage` | Separate testing capability grants |
| `metrics.read` | Aggregate, test-excluding metrics |
| `operations.read` | Allowlisted queue/health summaries |
| `operations.manage` | Approved operational actions |
| `audit.read` | Redacted, server-paginated audit history |

Only role assignment and self-context are implemented in this foundation.
Seeding a permission is not an implementation of its future API. Crew
`owner/admin/member`, user metadata, browser flags, and testing grants confer no
site authority. All tables have RLS enabled, no public policies, and no direct
grants to anonymous, authenticated, or service roles. Admins receive no journal,
prayer, action-note, private crew-content, or integration-content policy.

The server trusts the Supabase gateway to validate a signed, unexpired bearer
JWT. Every boundary additionally checks the expected actor, JWT authenticated
role, exact allowed browser Origin, live `auth.sessions` row for that actor,
session expiry, and current verified/nonanonymous/nondeleted/nonbanned Auth
account. JWT/app metadata is not canonical authorization. Session deletion
therefore invalidates even an otherwise unexpired AAL2 token for these APIs.

## Self-context contract

`get_site_admin_context(target_expected_actor_id uuid)` accepts the caller's
captured actor ID; it never reads another actor's readiness.

- A member receives only `{schemaVersion:1, actorId, role:'member', adminReady:false}`.
- A canonical admin lacking MFA receives `adminReady:false` and
  `reason:'mfa_required'`, with no permissions or private counts.
- A role-change-blocked session receives `reason:'reauthentication_required'`.
- A ready admin receives `roleRevision`, sorted `permissions`, and
  `stepUpRequired` in addition to its own identity/role.

Ready means the JWT **and live session** are AAL2, and the session's specific
factor is still a verified TOTP belonging to the caller. Read readiness and
write freshness are distinct. Writes additionally require both the same-session
Auth AMR record and JWT `amr` TOTP timestamp within ten minutes (at most 30 seconds
future clock tolerance). A freshly refreshed JWT `iat`, a password AMR, a stale
factor, or another account's factor does not satisfy step-up.

The separately delivered `/account-security` MFA setup can be used by any
signed-in member at AAL1 before any admin assignment. It must not depend on this
RPC to permit enrollment, and an absent/failed context RPC must never imply
admin access. Users enter their own authenticator code; operators/agents must
not enroll or retain the user's TOTP secret.

Successful RPC responses set `Cache-Control: private, no-store` and `Pragma:
no-cache`. Future UI/Edge wrappers must apply those headers to **all** outcomes,
including transport/auth errors, use no-store requests, bypass service workers,
and clear user-scoped state on account switch, sign-out and page lifecycle.
This SQL-only foundation does not claim that those unbuilt wrappers exist.

## Role mutation contract

`site_admin_assign_role(expected_actor, target_user, target_role,
expected_revision, request_id, correlation_id, reason_code)` uses the actual
SQL argument names prefixed `target_` (see migration). It requires canonical
`roles.manage` and recent TOTP step-up before and after the lifecycle lock.

Allowed roles are `member` and `site_admin`. Reasons are deliberate selections:
`staff_access_review`, `approved_role_change`, or `recovery_plan`; arbitrary free
text is not retained. A target must be a current confirmed, nonanonymous,
nondeleted, unbanned Auth account. Granting admin additionally requires its
verified TOTP. Self-targeting is always rejected; another usable admin must
perform the action. Expected revision prevents overwriting concurrent changes.

Use fresh UUID request/correlation IDs for a new decision; use the *same values*
for an uncertain retry. Under the global transaction lock, identical retries
return the stored result and create no second event. A changed retry input
returns `admin_idempotency_conflict`. The retry signature stores only a SHA-256
digest, not a raw request or arbitrary invalid text.

Accepted attempts are limited atomically to 20/minute and 100/hour per actor.
Preflight authentication/permission/request-ID failures raise stable errors.
Budget exhaustion returns `{ok:false,errorCode:'rate_limited'}` before mutation
and does not append unlimited rejected-traffic rows. Accepted domain failures
return `{ok:false,errorCode}` and persist one safe failure audit. A successful
change returns `{ok:true,role,revision,reauthenticationRequired:true}`.

Audit failure rolls back the role change, session blocks, and idempotency result
in the same transaction. The ledger contains UUID identities, selected reason,
role-only before/after, request/correlation IDs, environment, UTC time and safe
outcome/error. UPDATE, DELETE and TRUNCATE are rejected, including ordinary
operator SQL. A database owner capable of replacing triggers is still trusted;
this is not a cryptographic ledger against a compromised database owner.

All existing target Auth session IDs are blocked from *privileged admin use*
atomically with a role change. A new sign-in + MFA is required. Canonical role
checks also reject revoked authority immediately. This does **not** globally
sign out the member, delete Auth sessions, revoke membership, or call Auth Admin.
Global session revocation and cross-system CRUD need the later reviewed Edge
orchestration; do not substitute direct cascade deletes or service-key calls.

## First-admin activation: private, explicit, one time

1. Deploy/review the foundation and MFA UI. Keep the intended account identity,
   approved project/environment, and approval UUID in a private operator record,
   never a public migration, test, PR, browser bundle or log.
2. The explicitly designated user manually enrolls and verifies TOTP. Verify the
   exact Auth UUID, confirmed email, account health, and verified factor using
   read-only server checks. Never infer identity from a display name or crew role.
3. After explicit authorization, use a protected `postgres` operator connection
   to the pinned project. Invoke `private.bootstrap_site_admin` with that exact
   UUID, approval UUID, and environment in a transaction. The migration does not
   invoke it; anonymous, authenticated and service roles cannot execute it.
4. Require a successful receipt and single immutable bootstrap audit. The
   operation demands an empty admin set and verified TOTP, validates environment,
   and snapshots all existing sessions for privileged reauthentication.
5. The user signs out and signs in again, then completes MFA. Verify readiness
   and a harmless authorized read. Do not claim activation from metadata alone.

The same target/approval/environment retry returns `alreadyApplied:true`; it
never regrants a later-revoked role. A different retry or later bootstrap is
rejected. No shared service secret is a substitute for the operator procedure.

## Recovery and rollback

The data boundary prevents demotion, suspension, Auth deletion, loss of verified
email, or conversion to anonymous for the final site admin unless another
usable site admin exists. Direct Auth API factor removal/status changes are
also guarded: a site admin may remove a verified TOTP only when a replacement
verified TOTP on the same account or another usable admin preserves recovery.
Normal members and unverified enrollment cleanup are unaffected. Concurrent
removals serialize and cannot remove both final recovery paths.

Prefer enrolling/verifying a replacement factor before removing an old one.
If the sole admin loses its authenticator, do not disable MFA enforcement,
reuse bootstrap, promote a crew owner, or edit metadata to recover. A separate
explicitly approved break-glass identity-verification/recovery procedure is
required; it is deliberately not guessed here. A second-admin identity and
operational recovery policy remain operator decisions, not prerequisites for
ordinary member MFA enrollment.

Rollback application exposure by withholding the unbuilt admin UI/Edge routes;
do not drop audit history or reset the database. Once a role has been granted,
use a second ready admin and audited role change to revoke it, preserving the
final recovery path. Testing-grant expiry and lifecycle operations are unchanged
and are not implemented by this foundation.

## Validation and remaining ticket scope

The network-none tmpfs PostgreSQL 17 fixture runs the exact migration with the
Auth table/session/factor fields it uses. It covers defaults, metadata spoofing,
Origin, live account/session, stale refresh/AAL/AMR, actor mismatch, role revocation,
concurrent idempotency and final-admin actions, factor recovery, audit privacy,
immutability/atomicity, both rate budgets and private-content RLS. The registered
`240_site_admin_foundation.sql` executes 30 structural checks on the full chain.

Local `supabase db lint --local`, `db pull --local`, and `migration list --local`
could not connect: no 77 Dominion local stack is running, and Docker's persistent disk is
full. No unrelated containers/volumes were pruned. After raw-SQL iteration, the
CLI generated `20260913062841_site_admin_foundation.sql`; no draft duplicate is
committed. Full Supabase/Auth-schema migration, pgTAP and advisor validation must
run in the existing free CI/local stack before release. The minimal fixture is
not evidence that a hosted migration or hosted role grant has happened.

FOU-1502 remains incomplete: admin route/navigation/dashboard, allowlisted
server-paginated user/metrics/operations/audit reads, Auth Admin CRUD and session
revocation orchestration, separate testing grants and effective test clock,
safe simulated side effects, Profile test-toggle removal, two-account full-stack
and browser coverage, and the explicit first-admin activation are follow-up
work. Existing owner testing grants are not broadened or renewed.

## Sources

- [Supabase sessions and live session IDs](https://supabase.com/docs/guides/auth/sessions)
- [Supabase MFA and assurance levels](https://supabase.com/docs/guides/auth/auth-mfa)
- [Supabase JWT fields and authentication methods](https://supabase.com/docs/guides/auth/jwt-fields)
- [Auth MFA schema source](https://github.com/supabase/auth/blob/master/migrations/20221003041349_add_mfa_schema.up.sql)
