# Administrative read views (FOU-1502, partial delivery)

`/admin` and `/admin.html` provide account summaries/details and the existing
redacted administrative audit list/details. The page is not a membership or
billing route: a canonical authorized admin needs no subscription entitlement.
These read views expose no testing grant, password reset, export, impersonation,
journal, message or metrics controls. The separate
[reviewed role controls](site-admin-role-ui.md) and
[early-access denial](early-access-admin-review.md) document the only available
mutation boundaries; they are not inferred from read permissions.
Member Share/Streak header controls are deliberately absent, including after
refresh; administration does not need to hydrate those member-data surfaces.

The Admin menu item is absent from static navigation. It is appended only after
the current actor's `get_site_admin_context` decision says `adminReady` and grants
`users.read` or `audit.read`. It is removed before menu refresh and immediately
on auth/lifecycle invalidation. Members, crew administrators, and user metadata
do not qualify. A direct URL shows a generic gate until authorization completes.
The workspace starts hidden and inert; without JavaScript no records load.

## Authentication and lifecycle

`admin-read-client.mjs` captures a provider-verified user and immutable Auth
session marker before each request. The marker is lifecycle evidence only, not
permission. RPCs receive the captured expected actor, bearer token, and fixed
allowlisted name. Every result must match that actor and unchanged auth epoch
and session. A→B→A switches, replacement sessions for A, sign-out, storage
identity changes, pagehide, and hidden-document transitions invalidate reads.
Provider updates (including token refresh with the same session UUID) also clear
records, since MFA assurance/account health may have changed without a new ID.
Abort is an optimization; epoch checks reject a late response even if the server
already completed it or the transport ignores abort.

Rendered records, dialogs, inputs and in-memory cursor history are scrubbed on
identity/lifecycle invalidation. BFCache `pageshow.persisted`, focus/visibility
return, and reconnect reverify access before reading again. There is no browser
cache of admin payloads, Web Storage/IndexedDB persistence, service worker, or
payload logging. Fetch uses `cache: no-store`, `credentials: omit`, and refuses
redirects. Static admin documents have private/no-store, no-referrer and noindex
headers; the SQL success contract also sets private/no-store. Non-success
transport responses are consumed with the same no-store request mode and only
fixed safe error messages are rendered.

A canonical admin at AAL1 gets the allowlisted Account Security challenge link,
preserving the admin return route. A stale session gets explicit sign-out/login.
MFA enrollment itself remains available separately without admin assignment.
Nothing here activates a first admin, broadens an owner testing grant, changes
Auth provider configuration, or enrolls an authenticator on anyone's behalf.

## Read views

Users loads 25 records per request with the server's literal prefix search,
role/status filters and newest/oldest ordering. Audit independently requires
`audit.read` and filters by target UUID, action and outcome. Each view has next,
previous, first and refresh controls; cursors remain opaque, query-bound and in
memory. Changing filters clears old rows immediately; Apply filters makes a new
authorized request. Page counts describe only the current page, never all users.
An empty result is distinct from loading or failure. Failures clear old rows.

The Users list presents five concise columns: Member (name and email), Site role,
Account status, Last sign-in, and Details. Status labels do not infer membership
or paid/test/Early Access entitlement. Last sign-in is a recorded Auth timestamp
in UTC, not a claim of current app activity. Role and status filters live in the
keyboard-native More filters disclosure; active filter values and Reset filters
are visible together. Reset restores that view's defaults and makes one fresh
authorized list request. Filters and their summary are scrubbed on invalidation.

Opening Details makes the existing authorized detail read. Account history and
identifiers, crew information, and stored snapshots are then available through
native disclosures without additional reads or mutations. Stored points,
subscription status, progress counters, local last-seen date, cancellation flag,
and each snapshot timestamp remain explicitly historical. Missing records stay
"Not recorded", zero counters stay zero, and unknown subscription states are not
relabeled as active or expired. No effective-access/current-day/current-streak
calculation is introduced. Users becomes labeled cards at tablet/mobile widths.
All detail data is removed with the existing dialog scrub on filters, refresh or
authorization invalidation.

The FOU-1832 presentation pass applies to the implemented Users, Audit, Early
Access and Account requests views. It uses shared theme tokens, concise view
headings, status labels, disclosure-based secondary metadata, and a request
history timeline. Early Access decisions and their consequences stay visible;
only identifiers and historical delivery/event metadata are collapsed. Role and
invitation confirmation, MFA and safe-retry logic are unchanged. No Overview
metrics, testing-grant controls or other unimplemented admin capability is
fabricated by this UI pass.

Details render only fixed fields with DOM text nodes. Stored activation,
progress and subscription values are labeled snapshots with recorded timestamps,
not current effective access, current challenge day or completion. Auth deletion
and deletion-request status remain distinct. Crew roles are explicitly separate
from site roles. Audit bigint identifiers stay strings. Dialogs support Escape,
keyboard focus restoration and small-screen scrolling. Tabs support arrow keys,
Home/End, and independent read permissions. The layout uses existing theme
tokens and allows browser zoom; mobile tables become labeled record cards.

Develop-only simulation can be opened as `/admin.html?admin-preview=ready` or
`admin-preview=mfa` after a mock login. Synthetic records and the menu are
prominently labeled preview; default is a denied member. This adapter is selected
only with mocks enabled **and** Supabase authentication disabled. Production or
hybrid Auth ignores that query parameter entirely. Nothing is persisted as a
role or sent to a hosted service.

## Verification and remaining scope

### Read-only account requests inbox

The Account requests tab (`/admin.html#account-requests`) independently requires
`operations.read`. It lists the existing export/deletion intake, initially active
(`requested` or `in_progress`) and oldest first. Type, recorded-status and sort
filters use the new bounded server keyset read; page size is 25. The list has no
total count, client-side aggregate, fulfillment control or automatic transition.

The independent Active queue overview shows exactly four buckets: data export
and account deletion, each requested/in progress. It always covers the active
queue, not the current list filters. Each bucket has a bounded count, displayed
as `1000+` only when an additional entry was found, and its oldest original
request timestamp. Empty buckets display zero and “No active requests”; missing,
malformed or failed responses display unknown/unavailable, never fabricated zero.
The server observation time is visible in UTC. Entering this tab loads the
summary once; its separate Refresh queue overview button obtains a new snapshot.
List filtering/paging does not refetch it, and there is no background polling.

Summary responses have the same Operations/AAL2/actor/session guards, finite
ten-second transport and invalidation scrub as the inbox. They are never stored,
logged or derived from the visible rows. Only count/status/type/timestamps are
rendered, with no requester identity or private content. This is recorded intake,
not export delivery or complete-erasure verification. It adds no fulfillment
actions, cleanup/integration health, SLA promise, metrics, or role permissions.

Only request UUID, nullable requester UUID, request type/status, and requested,
updated and resolved UTC timestamps are rendered. No notes, names, email
addresses, export data, links or private content are selected or displayed. A
removed account reference remains explicitly absent; it is not reconstructed.
Recorded fulfilled is historical operator state, not new proof of delivery or
complete erasure. Declined is not relabeled as a failed processor run. This slice
does not provide account-detail links; separately opening Users still requires
the existing `users.read` authorization.

The entire new list operation, including deferred loading and Auth waits, has a
ten-second deadline; its exact-bearer native POST also limits UTF-8 response data
to 64KiB. No automatic retry occurs. The existing Admin owner/epoch checks and
row/filter/cursor scrubbing apply. All response rows validate before publishing
any of them; malformed status, timestamps, requester, or oversized cursor causes
the fixed unavailable state. Other Admin mutation/read transport is unchanged.
New view/transport modules stay out of every non-Admin initial graph. Synthetic
preview data is generated only by the explicit mock adapter and is never stored.

The production-built Admin suite includes Operations-only isolation, paging and
filters, each existing status, removed requester, private-field sentinels,
permission loss, wrong actor, same-user session replacement, A→B→A, pagehide and
late-response rejection. Chromium/WebKit cover keyboard tabs, four themes, 200%
text, responsive tables and axe. Separate unit tests exercise stream limits,
malformed MIME/UTF-8, aborted/stalled fetch/body, and late module/Auth continuation
after deadline. Exact SQL authorization and query plans are separate evidence;
the local HTTP provider is not proof of hosted fulfillment.

Run `pnpm test`, `pnpm test:e2e:admin`, and the `admin-preview.spec.mjs` Chromium
and WebKit projects. The live-build suite uses the actual installed Supabase SDK
against a local synthetic HTTP provider with mocks disabled. It covers anonymous,
member/crew-admin metadata, AAL1, audit-only scope, role denial, raw-error
redaction, wrong actors, session replacement, A→B→A, delayed reads, sign-out,
pagehide/BFCache, paging/filters/detail focus, four themes, mobile/desktop and
200% text. Axe audits the page and modal. The mock suite verifies explicit preview
labels, theme entitlements/layout and account-change clearing. Database grants,
session checks, indexed queries and privacy sentinels remain covered by the
separate exact-SQL foundation/read tests, not inferred from the browser stub.

This does **not** complete all of FOU-1502. Remaining work includes broader
admin mutation/recovery flows, testing-grant management and effective
access, other operational queues, canonical metrics/retention, broader Users fields,
and the remaining authenticated production acceptance matrix. The initial owner
admin and MFA setup were completed earlier; this UI pass neither repeats that
bootstrap nor changes a hosted role or database record.
