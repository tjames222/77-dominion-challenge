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

`GET /functions/v1/share-snapshot/{64-character-token}` returns a complete HTML
document without JavaScript. It includes canonical, Open Graph, Twitter card,
description, and image metadata plus a branded readable fallback page. Responses
use `no-store`, `no-referrer`, a restrictive CSP, `nosniff`, and frame denial so
revocation takes effect on the next request and the bearer token is not sent as a
referrer.

`PUBLIC_SHARE_URL` may point to a custom HTTPS route that proxies this Function.
If it is absent, creation uses the deployed Function URL. `PUBLIC_SITE_URL` is
required for the canonical Dominion destination and preview image.

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

The release workflow applies the migration, synchronizes optional
`PUBLIC_SHARE_URL`, deploys `share-snapshot` with gateway JWT verification off,
and confirms a tokenless request returns the generic `404`. Before enabling the
composer, verify a real preview/create/revoke cycle and run the resulting URL
through the intended social-platform debuggers. Confirm revoked and expired URLs
return the same unavailable page and that no private field appears in page source
or metadata.
