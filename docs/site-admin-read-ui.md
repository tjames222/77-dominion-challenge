# Read-only administration (FOU-1502, partial delivery)

`/admin` and `/admin.html` provide account summaries/details and the existing
redacted administrative audit list/details. The page is not a membership or
billing route: a canonical authorized admin needs no subscription entitlement.
It exposes no account mutation, testing grant, role-assignment, password reset,
export, impersonation, journal, message, or metrics controls.

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

This does **not** complete all of FOU-1502. Remaining work includes separately
reviewed admin mutation/recovery flows, testing-grant management and effective
access, operational queues, canonical metrics/retention, broader Users fields,
and final production/first-admin verification after manual MFA enrollment. No
hosted role grant or database mutation is part of this UI change.
