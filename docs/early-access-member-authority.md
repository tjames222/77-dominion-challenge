# Early-access member authority — additive foundation

Migration `20260922000204_early_access_member_authority.sql` records the approved
policy: accepted early access is free until an explicit beta start; an accepted
member keeps eligibility for USD 350 minor units per month indefinitely,
including after subscription cancellation and return. `early_access_v1` starts
configured with `beta_starts_at = NULL`. This does not launch beta or billing.

No real user grant, testing entitlement, site role, invitation, or feedback row
is created by this migration. This foundation did not change membership/RLS
consumers; the additive consumer migration described below now integrates them.
Approval, invitation acceptance and Checkout remain separate required slices.
Frontend access-state integration is described below. Feedback intake and its worker are
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
  INSERT` trigger in the same transaction. Fixed USD $3.50/month/version-1 facts
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

The booleans reflect the current owner. `legacyMembershipActive` uses the exact
original entitlement predicate, preserving its historical start-time behavior.
It deliberately does not call the now-EA-aware `has_active_entitlement` helper.
`paidSubscriptionActive` additionally requires a current
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

The exact migration is included in the canonical schema and explicit CI test
inventory. Full canonical schema/pgTAP/release gates remain required on every
new release candidate. The Supabase
advisor CLI is not connected to this deliberately socket-only isolated fixture;
the focused suite asserts object grants/search paths/RLS directly. No hosted
advisor or production SQL operation was performed. Current Supabase
[function security guidance](https://supabase.com/docs/guides/database/functions)
and [session invalidation guidance](https://supabase.com/docs/guides/auth/sessions)
informed the empty-path, explicit-grant and live-session checks.

## Membership consumer integration

`20260927025530_integrate_early_access_membership.sql` adds accepted, active EA
as an alternative only for `membership_active`. It replaces the exact current
bodies of the shared RLS helper and eleven direct entitlement consumers:
challenge reconciliation, definition synchronization, progression, celebration
claim and start; reward catalog item; activation payload; crew issuer predicate,
invite issuance and confirmation; and same-crew member progress. Existing RPC
payloads, caller checks, legacy date predicates and function ACLs are retained.
No unrelated product entitlement, subscription, invoice or person is created.

The three existing entitlement-locking RPCs retain their billing-row locks and
also lock the EA program followed by grants in deterministic user-ID order.
They recheck EA with a fresh server clock after blocking waits. Member progress
does this after its crew/membership waits too. No Auth row lock or global admin
lifecycle lock is added. A revoke committed while waiting therefore wins; a
beta boundary crossed during the wait cannot reuse the earlier statement time.

`pnpm run test:early-access-membership-sql` uses a new labelled, cached-image,
network-none/port-free/volume-free PostgreSQL fixture. It loads the canonical
application snapshot with the reviewed provider table shapes, then the complete
new migration; it is not a full provider-stack or historical-cutover replay.
The 17 native cases cover the twelve consumers, exact pre/post ACL equality,
no seeded access, unrelated-product denial, account health, paid/legacy/EA
separation, lifetime qualification, eight revoke/expiry races and 234 existing
pgTAP assertions across five challenge/crew suites. CI additionally performs the
full Supabase replay, advisors and canonical pgTAP/schema-drift gates.

## Browser member-access integration

Live `getBillingState` now reads the canonical self-only member context instead
of treating a raw entitlement as both application access and a paid subscription.
It keeps raw billing snapshots for display but skips the subscriptions request
while billing is closed. Mock/develop paths remain separate and unchanged.
Profile and Billing distinguish accepted EA from other member access, state
that EA is free until beta, and show the retained USD $3.50/month rate only when
the server reports the immutable qualification. No Stripe gate is opened.

The lazy reader reuses the existing Auth singleton and owner epoch. It verifies
the original bearer with Auth, requires the current MFA state, binds actor and
immutable session, and rechecks owner/bearer/epoch around asynchronous work.
A single bounded deadline covers Auth, MFA, details, context and final ownership
verification. Account/session/assurance changes, pagehide, cancellation and
malformed contracts cannot publish stale permissions. There is no new Auth
listener, persisted permission cache, SDK instance or local eligibility source.
Initial session acquisition tolerates exactly one ordinary refresh witnessed by
that same synchronous observer, including a refresh during the lazy import.
The acquired bearer must exactly match the refresh and retain any already-known
immutable owner. A first provider refresh may establish the initial owner before
`INITIAL_SESSION`; no access is inferred from that event. Auth, MFA and server
authority are still freshly verified afterwards. Replacement owners, multiple
refreshes, lifecycle invalidations and all post-acquisition refreshes still fail
closed, under the original request deadline.

Reader/contract tests cover owner changes, A-to-B-to-A, silent token
replacement, MFA, deadline/cancellation, transport bounds and closed billing.
Real installed-SDK tests restore an expired persisted session through
`TOKEN_REFRESHED` then `INITIAL_SESSION`, both during acquisition and lazy load.
Native Chromium and WebKit cases verify the free/retained-rate copy with no
subscription or Stripe requests. These local synthetic tests do not grant any
real account access or establish production invitation readiness.
