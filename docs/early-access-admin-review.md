# Early-access review foundation (FOU-1742, partial)

This checkpoint provides an Admin queue with server-side detail/history reads
and a **deny-only** transition. It does not approve anyone, create an Auth
account, send an invitation or email, grant membership/testing access, or change
billing/public-signup policy. It is not completion of FOU-1742.

## Read contract

The authenticated RPCs are `site_admin_list_early_access_requests`,
`site_admin_get_early_access_request`, and `site_admin_list_early_access_history`.
Each call requires the expected actor, current `operations.read` capability,
healthy live Auth session, allowed Origin, and verified AAL2 under the existing
site-admin foundation. Neither a service key, crew-admin role, nor metadata can
replace that decision. Reads do not require the extra recent-MFA window used for
writes.

Queue pages default to 25 and cap at 50 records. They support literal,
case-insensitive name/email prefixes, known status values, and oldest/newest
ordering. Timestamp/UUID keysets preserve ties; cursor input is bounded and tied
to the actor and query. History uses string-encoded bigint keysets so sequence
IDs beyond JavaScript's safe-integer range remain exact.

Request payloads contain only the request ID, name/email, status/revision,
request/update timestamps, nullable delivery/acceptance timestamps, and canonical
account match status/ID. The historical intake account link is not proof of a
current email match. The serializer checks at most two matching Auth accounts
through the indexed private directory and returns an ambiguous status without
an account ID if necessary. It does not expose answers, journal content, Auth
metadata, passwords, factors, or tokens.

Invitation sent/expiry/acceptance timestamps remain null unless actual evidence
has been recorded. Existing `invited` or `accepted` statuses do not cause an
invented timestamp. History does not invent a request-created audit event.

## Denial and retries

`site_admin_deny_early_access_request` accepts the expected actor, request ID,
expected revision, operation UUID, and correlation UUID. It requires current
`operations.manage` and the foundation's recent same-session MFA checks. It
rechecks authority after acquiring the shared site-admin lifecycle lock, with a
five-second lock-wait limit. Only `pending` can become `denied`, incrementing the
revision once. Denial does not revoke existing Auth or app access.

The request transition, immutable typed audit event, and operation result commit
together. A failed audit write rolls back all three and the identical operation
can be retried. Handled failures such as a stale revision are also audited and
stored: an exact retry returns the original result without another audit event.
Changed arguments or cross-operation reuse of the UUID fail with a fixed
idempotency conflict. Every retry still requires current authorization and MFA.

Denial shares `private.site_admin_role_requests` with the unchanged role writer;
the historical table name is retained to preserve existing records. Its denial
digest has an explicit operation domain and a shape distinct from the historical
role digest. Role → denial and denial → role UUID reuse therefore fail before the
second operation changes anything, including when both arrive concurrently.
The shared limit counts audited role and denial operations together: 20/minute,
100/hour per actor. Exact retries do not spend the budget again. Capacity
rejections are not written to the ledger; after the window changes they may be
retried as a new attempt rather than being a permanently recorded outcome.

Successful payloads and handled denial results explicitly emit `private,
no-store`; an aborted SQL transaction does not promise these headers on its
error response. The direct private tables and operation registry retain RLS and
their existing restricted grants. Intake cannot write review fields or reopen
a denial. Existing role audit rows and their allowlists remain intact.

## Verification and release boundary

The Early Access tab appears only after canonical `operations.read` readiness.
It provides status/prefix/sort filters, 25-record keyset pages, request detail,
and separately paged history. Account and Audit panels retain their existing
read-only behavior. An operations-only reader can inspect requests without
seeing a denial action or acquiring account/audit access.

Denial requires `operations.manage`, a currently pending snapshot, and fresh
recent-MFA context before the confirmation is shown. The confirmation requires
the supported `early_access_review` reason and a deliberate acknowledgement.
The original request revision, actor, immutable session identity, operation UUID,
and correlation UUID are bound to that one in-memory intent. The adapter checks
current identity and canonical capability/MFA readiness again after async setup
and immediately before sending the reviewed RPC. Each request also pins its
captured bearer before send and after response, so a same-session assurance change
cannot reuse an older bearer even when an Auth notification is delayed or absent.
The server remains authoritative.

Transport errors, malformed replies, or the 20-second request deadline display
an uncertain result, never a successful denial. An explicit retry preserves
exactly the same operation UUIDs and revision. Stale revision, invalid state,
and idempotency conflicts instead require a reload and a new deliberate review;
the UI never silently substitutes a newer revision. Recent-MFA step-up returns
to plain `admin.html`, without a request, tab, or operation in its return URL.
Returning cannot resume or replay an intent.

Closing the dialog, leaving/hiding the page, signing out, losing assurance, or
changing actor/immutable session clears private details and unfinished intents,
aborts owned requests, and fences late replies. No applicant payload or operation
is saved to browser storage, logs, URLs, or a background retry queue. Mock-enabled
develop previews use only temporary, labeled synthetic records; simulated denials
reset on reload and do not contact Supabase or send email.

`pnpm test:e2e:admin` builds the production frontend with mocks disabled and runs
the installed Supabase SDK against a loopback synthetic HTTP fixture in Chromium
and mobile WebKit. It covers canonical permission/MFA gates, original-revision
confirmation, exact retries, stale/conflicting responses, session/assurance races,
deadlines, separate pagination, privacy, keyboard controls, 200% text sizing, and
all four themes. This complements rather than replaces the real SQL tests below.

The existing frontend performance ceilings are not yet green. The matching
pre-UI base already exceeds its request/CSS and several JavaScript ceilings;
this checkpoint adds about 0.9 KiB gzip to the shared route graph with no extra
initial requests. Denial code and synthetic request data are demand-loaded,
but the remaining ceiling violations still belong in the open performance work.
No budget or completion threshold has been raised for this UI.

`pnpm test:early-access-admin-sql` creates only a uniquely named, network-none,
tmpfs PostgreSQL 17.6.1.141 fixture and removes that same container. It applies
the actual intake, admin foundation, directory, and review SQL under an
application migration role without superuser/bypass privileges; Auth remains
owned by `supabase_auth_admin`. Authorization/business helpers are not stubbed.

Coverage includes cross-kind operation conflicts in both directions, real
concurrent role revocation, concurrent denial/retry handling, permission/MFA
rechecks, immutable audits, rollback/retry, both rate windows, literal search,
keyset pagination, bounded indexed query plans, fixed-field privacy, and all 34
registered pgTAP assertions. The separate full migration chain, advisors, SQL
lint, and schema reconciliation must pass CI before release. No hosted SQL or
real denials were performed to validate this checkpoint.

Approval/invite creation, delivery/retry, verified-email acceptance, capability
duration, and associated end-to-end production evidence remain separate unfinished
work. This queue/read/deny checkpoint does not mark FOU-1742 complete.
