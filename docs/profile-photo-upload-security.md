# Trusted profile-photo upload

FOU-801 makes the authenticated Edge Function the only profile-photo writer.
The browser still prepares a small thumbnail for responsiveness, but its bytes,
dimensions, type, path, and metadata are all untrusted.

## Trust boundary

`upload-profile-photo` performs the complete server-side boundary in this order:

1. Require a valid member JWT, an exact approved request origin, and an actor
   header that matches the authenticated user.
2. Read at most 150 KiB from the request stream and accept only declared JPEG or
   WebP whose bounded container parser confirms one non-animated image no larger
   than 256×256 pixels.
3. Reserve a server-generated, immutable `.webp` path through an idempotent
   service-only RPC before running the expensive decoder. Admission remains
   limited to 3 pending, 20 cleanup, 6 hourly, and 24 daily registrations per
   account.
4. Decode with the pinned `@imagemagick/magick-wasm@0.0.41`, reject multiple
   frames, normalize orientation, center-crop without upscaling, strip metadata,
   and re-encode a square WebP. The output is reparsed and hashed.
5. Write with the Supabase service role and finalize only when the exact Storage
   row, path, MIME type, byte size, actor, registration, and verified output
   metadata match.

Authenticated clients have no Storage INSERT policy and cannot call the service
reservation/finalization RPCs. The former browser reservation RPC is revoked.
The prelaunch migration clears legacy avatar pointers and queues every unverified
pending or canonical object for the existing service cleanup worker, so no
browser-written object is grandfathered into the trusted invariant.

## Deployment and verification

No additional paid service or secret is required. Supabase provides the service
role to deployed Edge Functions. Deploy `upload-profile-photo` with platform JWT
verification enabled, after the database migration is applied.

Before enabling public signup, complete a local full-stack rehearsal and the
single-project closed canary:

- upload one prepared JPEG and one prepared WebP;
- confirm both stored objects are square WebP, at most 256×256 and 150 KiB;
- confirm the path belongs to the authenticated actor and the lifecycle row has
  immutable verified hash, byte-size, dimensions, and timestamp fields;
- confirm a direct authenticated Storage upload and legacy reservation call are
  rejected;
- confirm a malformed, oversized, animated, or multi-frame input creates no
  object, while a decoder failure leaves only cleanup-eligible lifecycle work;
- commit and replace an avatar, then run the cleanup proof in
  [`profile-photo-cleanup-runbook.md`](./profile-photo-cleanup-runbook.md).

Rollback must keep browser Storage INSERT permission disabled. If the upload
Function is unavailable, leave profile photos fail-closed until a reviewed
Function fix is deployed; never restore the retired browser path as a workaround.
