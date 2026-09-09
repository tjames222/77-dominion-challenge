# Public share snapshot contract

FOU-560 introduces one versioned API for streak, challenge-progress, and
general Dominion shares. It deliberately captures a small server-authoritative
snapshot instead of making any authenticated profile or activity endpoint
public.

## Privacy boundary

Every public payload is schema version `1` and contains only:

| Kind | Public payload |
| --- | --- |
| `streak` | Current app streak and current full-standard streak |
| `progress` | Current challenge day, challenge length, and rounded percentage |
| `general` | Fixed product facts: 77 days and seven daily standards |

Names, email addresses, user IDs, avatars, group membership, invite state,
journal content, check-in dates, action history, and exact activity timestamps
are never copied into a snapshot. The preview RPC builds the same payload as the
create RPC, so the composer can show exactly what will become public.

Public identifiers contain 256 random bits. The usable token is returned once
inside the public URL; Postgres stores only its SHA-256 digest. Internal snapshot
UUIDs never appear on public pages. Invalid, expired, revoked, and unknown tokens
all render the same generic `404` response.

## Authenticated Function API

Call the `share-snapshot` Edge Function with the signed-in Supabase session.
All POST requests require authentication even though JWT verification is disabled
at the gateway to permit public crawler GETs.

Preview without writing:

```json
{
  "action": "preview",
  "kind": "streak"
}
```

The response includes `kind`, `payload`, the default 30-day expiration, privacy
declarations, and the exact title/description/metric presentation used by the
public renderer.

Create an immutable snapshot:

```json
{
  "action": "create",
  "kind": "progress",
  "expiresAt": "2026-08-19T12:00:00Z"
}
```

`expiresAt` is optional and must be between one hour and 90 days from creation.
The response returns the owner-only `snapshotId`, final public `url`, expiry,
payload, and presentation. A standalone raw token is never returned by the Edge
Function.

Revoke a link:

```json
{
  "action": "revoke",
  "snapshotId": "00000000-0000-4000-8000-000000000000"
}
```

Revocation is owner-scoped and idempotent. A `false` result does not reveal
whether another user owns the identifier.

## Public renderer and social crawlers

The Edge Function handler builds a complete HTML document for
`GET /functions/v1/share-snapshot/{64-character-token}` without JavaScript.
It includes canonical, Open Graph, Twitter card,
description, and image metadata plus a branded readable fallback page. Responses
use `no-store`, `no-referrer`, a restrictive CSP, `nosniff`, and frame denial so
revocation takes effect on the next request and the bearer token is not sent as a
referrer.

Production requires the explicit Function secret and matching GitHub production
variable `PUBLIC_SHARE_URL=https://77dominion.com/share`. This uses the existing
`share-snapshot` Function's supported public-URL override; new links and their
canonical/`og:url` metadata then use the configured HTTPS Cloudflare route,
regardless of the Function's internal request URL. `PUBLIC_SITE_URL` remains
`https://77dominion.com` for the Dominion destination and preview image.

The public `/share/{64-character-token}` route belongs to the existing
`77-dominion-live` Cloudflare Pages project and forwards only the public share
request to the existing Supabase Function. No replacement project or paid
Supabase custom domain is required. Supabase's shared API domain rewrites HTML
GET responses to `text/plain`, so correcting a direct Supabase link's path alone
does not make it a rendered share page. The Cloudflare route must return HTML
with the same privacy and no-cache protections. See
[Supabase's HTML restriction](https://supabase.com/docs/guides/functions/limits).

Do not leave `PUBLIC_SHARE_URL` unset in production. The current Function still
falls back to `req.url` when the override is absent or invalid. Behind the hosted
gateway, that URL can use internal HTTP routing without the external
`/functions/v1` prefix. This release configures the supported override; it does
not change or harden that fallback code. Do not point the override at `/share`
until the Cloudflare route is deployed and verified.

## Lifecycle, abuse controls, and deletion

- Creation is serialized per user, capped at ten links per hour, and capped at
  25 simultaneously active links.
- A challenge-start reset automatically revokes that user's streak and progress
  snapshots. General advertisements remain valid.
- Account deletion cascades all owned snapshots.
- Expired and revoked rows fail closed immediately. The service-role-only
  `purge_retired_share_snapshots()` job deletes them after a default 30-day
  operational retention window; the retention input is bounded to 1–365 days.
- The only recipient telemetry retained by this feature is an aggregate view
  count and last-viewed time on the snapshot. It records no IP address, user
  agent, referrer, recipient identity, or shared private content.
- The public table has RLS enabled and no direct client grants. Authenticated
  users can only preview, create, and revoke through the documented RPCs; public
  callers can only resolve a high-entropy token.

The purge function is a mechanism, not an automatic production schedule. Add it
to the approved Supabase scheduler only after operations confirms the retention
window and monitoring owner.

## Release and verification

The full backend release can synchronize `PUBLIC_SHARE_URL` and deploy
`share-snapshot` with gateway JWT verification off. Its tokenless `404` smoke
alone does not prove generated URLs or rendered HTML work. The production share
link repair uses this order instead:

1. Review and deploy the Cloudflare `/share` route through the protected
   frontend release to the existing Pages project. Do not change the Supabase
   project, database, or deployed Edge Function code for this repair.
2. Verify the tokenless/invalid public route returns the intended unavailable
   HTML, not an app fallback or raw source. Check its MIME type, security
   headers, and no-store behavior without opening a real user's bearer link.
3. Set the matching GitHub production `PUBLIC_SHARE_URL` variable, then use the
   reviewed protected configuration workflow to synchronize the exact
   `https://77dominion.com/share` Function override only after route-readiness
   verification. Function-secret changes take effect without redeploying the
   Edge Function. Keep existing Auth/origin policy and safe-off billing gates.
4. Verify a signed-in preview and an explicitly authorized synthetic
   create/read/revoke cycle. New links and page canonical/`og:url` values must
   use the apex HTTPS `/share/` route; valid public pages must render as HTML,
   and revoked/expired links must use the same generic unavailable response.
   Do not record bearer tokens or private account data in logs or artifacts.

Local regression tests use only synthetic tokens and mocked RPCs. They confirm
the configured route wins over internal HTTP URLs, rewritten paths, forged Host
and forwarding headers, and request query/fragment values for both create URLs
and public metadata. They do not exercise the unsafe unset-override fallback or
claim the live configuration has already been applied.

Testing a real public share link increments its aggregate view telemetry;
creation and revocation also write snapshot state. Treat those checks as
authorized tests, not read-only probes. Once authorized end-to-end verification
passes, test intended social-platform previews without exposing private fields
in page source or metadata.
