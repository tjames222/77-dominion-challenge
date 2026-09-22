# Early-access member authority — additive foundation

Migration `20260922000204_early_access_member_authority.sql` records the approved
policy: accepted early access is free until an explicit beta start; an accepted
member keeps eligibility for USD 350 minor units per month indefinitely,
including after subscription cancellation and return. `early_access_v1` starts
configured with `beta_starts_at = NULL`. This does not launch beta or billing.

No real user grant, testing entitlement, site role, invitation, or feedback row
is created by this migration. No existing membership/RLS consumer is changed.
Approval, invitation acceptance, the entitlement-consumer integration and
Checkout remain separate required slices. Feedback intake and its worker are
implemented separately in the release candidate described by
`early-access-feedback-runtime.md`. Do not describe this authority foundation
alone as a working early-access enrollment flow.

## Private authority and durable facts

- `private.early_access_programs`: one approved versioned program. No browser or
  service-role table access and no public program-update API. A future beta
  transition requires its own explicitly reviewed operator operation.
- `private.early_access_grants`: unique `(user_id, program_key)` and request;
  accepted identity and timestamps cannot be rewritten. Insertion requires the
  matching request to be `accepted`, not merely approved/invited. Start equals
  acceptance; acceptance cannot be future-dated or at/after a configured beta
  boundary. Revocation is one-way with `revision + 1`; no public revoke is added.
- `private.early_access_price_qualifications`: inserted by the grant's `AFTER
  INSERT` trigger in the same transaction. Fixed USD 350/month/version-1 facts
  are immutable on update and survive grant revocation, beta and subscription
  cancellation. Failure to insert the fact rolls back the grant. A foreign key
  binds the original accepted grant, program and Auth UUID.

These private tables have RLS enabled, no public policies and no nonowner table
grants. Auth deletion cascades the live user-bound grant and qualification; a
new account reusing an email does not inherit a previous account's offer.
Lifetime/returner eligibility concerns the same account's subscription history,
not account recreation or identity transfer. There is no email allowlist.

The future acceptance transaction must perform all invitation, account, session,
generation, expiry and operation-id checks, then atomically mark the request
accepted and insert the grant with audit/receipt. The grant trigger is a final
consistency check, not the invitation authorization boundary. No caller receives
direct table-write privileges to bypass that transaction.

## Internal helper contracts

```sql
private.early_access_active_for_user(target_user_id uuid, as_of timestamptz)
  returns boolean
private.require_member_current_session(target_user_id uuid, target_session_id uuid)
  returns void
private.require_member_request_identity(target_expected_actor_id uuid)
  returns uuid -- current immutable Auth session ID
```

All are private, empty-search-path functions with execute revoked from PUBLIC,
anon, authenticated and service_role. The active predicate uses a finite server
instant: accepted start is inclusive; the beta boundary is exclusive; revoked,
unconfigured or unhealthy-account grants are inactive. It does not imply paid
subscription or current client-session authorization. It reads only and does
not reconcile, grant, promote a challenge, or claim an award.

The member guard verifies signed authenticated role/expected actor, immutable
session ID, a live matching `auth.sessions` row, `not_after`, confirmed and
nonanonymous account, deletion/suspension state, and the existing deployment
origin list in `private.site_admin_configuration`. Missing or malformed authority
fails closed. Verified MFA enrollment requires the session's current verified
factor and AAL2, plus JWT AAL2 for browser requests. An unverified factor does not
require MFA; no admin role or ten-minute admin step-up is imposed. Admin-specific
session blocks continue to govern admin authority, not ordinary member access.
Each current-session guard captures a fresh `clock_timestamp()` at invocation,
so a second guard after a blocking wait cannot reuse the statement-start time
to admit a session that expired during the wait.

Mutating follow-on functions must capture the original session, acquire locks
in the established lifecycle order, and recheck the same identity and selected
grant/program rows after blocking waits. These read helpers do not acquire
authority locks or promise serialization against a future revoke. No current
admin guards or role authority are weakened.

## Public self-only read

`public.get_member_access_context(target_expected_actor_id uuid)` is executable
only by `authenticated`. Its thin wrapper delegates to a private implementation,
with all default PUBLIC/anon/service grants revoked and empty search paths.
It returns exactly:

```json
{
  "schemaVersion": 1,
  "actorId": "the verified Auth UUID",
  "asOf": "server statement timestamp",
  "appAccess": false,
  "legacyMembershipActive": false,
  "paidSubscriptionActive": false,
  "earlyAccessActive": false,
  "earlyAccessProgram": null,
  "earlyAccessEndsAt": null,
  "betaPriceEligible": false
}
```

The booleans reflect the current owner. `legacyMembershipActive` calls the
unchanged existing `has_active_entitlement` predicate, preserving its historical
start-time behavior. `paidSubscriptionActive` additionally requires a current
active `subscription`-sourced entitlement and nonempty source ID; it always
implies legacy access but is not a provider invoice/payment receipt. Testing
access is neither paid subscription nor early access. `appAccess` is legacy OR
canonical early access. An active grant exposes program `early_access_v1` and
the nullable beta start as `earlyAccessEndsAt`; inactive EA exposes both as null.
`betaPriceEligible` is the earned lifetime fact, independent of current EA/paid
access. The response never includes emails, sessions, factor IDs, invitation
tokens, request IDs, provider configuration, role grants or private content.

Safe failures are `PT401/member_authentication_required`,
`PT403/member_origin_forbidden`, and `PT403/member_mfa_required`. The response
headers are transaction-local `Cache-Control: private, no-store` and
`Pragma: no-cache`. The browser must bind/cancel requests and discard replies
after actor/session changes; this response is not a reusable authorization token.

## Server-only price lookup

```sql
public.get_beta_price_eligibility(
  target_expected_actor_id uuid, target_session_id uuid
) returns jsonb -- exactly {"user_id": UUID, "eligible": boolean}
```

Only `service_role` may execute this wrapper. The implementation requires a
service database role with no member `auth.uid()` and verifies the supplied
original live actor/session and current enrolled-factor requirement before and
after reading the qualification. The Edge caller must first verify the member's
original bearer, pin its actor/session/AAL, enforce the request's allowed origin,
and recheck ownership after async provider work. Never accept actor/session IDs
or eligibility from the browser unchecked, and never turn a failed lookup into
`eligible: false`. This helper returns no Stripe Price ID and creates no checkout.
The separately reviewed pure price selector validates server-fetched pricing.

## Local verification and remaining integration

`node --test scripts/early-access-member-authority.sql.test.mjs` starts one new
labelled, network-none, no-port/no-volume PostgreSQL 17.6.1.141 container from an
already cached image (`--pull never`), with 1 CPU/512 MiB and a 384 MiB tmpfs. It
cleans up only the exact returned container ID after checking its ownership
label. It never uses an existing local stack or hosted connection.

The fixture applies actual intake and site-admin foundation migrations plus the
exact legacy entitlement predicate, then the complete new migration under a
non-superuser/non-BYPASSRLS migration owner. Minimal provider-owned Auth tables
model the columns used; this is not a full Supabase stack/schema-replay claim.
Tests exercise real PostgreSQL constraints/triggers/ACL/RLS, accepted-only atomic
facts, beta and legacy-time boundaries, cancellation/return, MFA/actor/session,
origin, service-only identity, privacy, rollback and account deletion.

Root integration must add the exact migration include and explicit test
inventory, then run the full canonical schema/pgTAP/release gates. The Supabase
advisor CLI is not connected to this deliberately socket-only isolated fixture;
the focused suite asserts object grants/search paths/RLS directly. No hosted
advisor or production SQL operation was performed. Current Supabase
[function security guidance](https://supabase.com/docs/guides/database/functions)
and [session invalidation guidance](https://supabase.com/docs/guides/auth/sessions)
informed the empty-path, explicit-grant and live-session checks.
