# Early Access invitation envelope v1

`supabase/functions/_shared/early_access_invitation.ts` is a pure, server-only
helper. It does not read environment variables, call Supabase Auth, authorize
requests, send email, or confer membership. The application invitation is not a
login credential. The caller and database remain responsible for the current
admin/session checks, a fresh issuance time, exact recipient matching, expiry,
revocation, generation fencing, atomic acceptance, and single use.

## Creation and persistence

Call `createEarlyAccessInvitation(binding, { keyVersion, key })` once per new
generation. The exact binding is `{ requestId, generationId, deliveryId,
recipient, issuedAt, expiresAt, from }`. IDs are lowercase UUIDs, recipient is the
request's canonical lowercase mailbox, and timestamps are exact UTC ISO strings
with three fractional digits. Expiry must be exactly 604800000 ms after issuance.
The privileged writer must additionally compare issuance to the fresh database
clock; the pure helper deliberately has no clock or database dependency.

Supply `from` from the validated `TRANSACTIONAL_EMAIL_FROM` runtime setting. Its
mailbox must be on the approved `mail.77dominion.com` domain. Planned production
value: `Dominion <noreply@mail.77dominion.com>`. Support contact copy imports the
existing shared support address; it does not create another source of truth.

The helper generates 32 cryptographically random token bytes, encodes them as
canonical unpadded base64url (43 characters), and computes `tokenDigest` as
SHA-256 of the decoded 32 bytes, **not** the UTF-8 encoded token string. Acceptance
can use `hashEarlyAccessInvitationToken` to validate and hash a presented token.
Invalid padding, whitespace, alternate alphabets, and unused pad-bit aliases are
rejected. The only invitation URL is:

`https://77dominion.com/early-access-invite.html#token=<canonical-token>&generation=<generation UUID>`

Both fields are fragment-only and must be captured then immediately removed
from browser history before any network work. The generation ID selects the
single-use authority row; it confers no authority without its matching token
and a currently authorized native account/session.

The returned object contains only `{ tokenDigest, contentFingerprint,
idempotencyKey, envelope }`, where `envelope` is exactly `{ version: 1,
keyVersion, nonce, ciphertext }`. All objects are frozen. Neither the raw token
nor a plaintext message is returned by creation. Persist these fields and the
binding atomically, only in the private invitation/outbox authority. Never put
the envelope, digest, raw token, URL, or message in admin/member responses, logs,
exception causes, or exported debugging data.

`idempotencyKey` is `dominion-early-access/<delivery UUID>`.
`contentFingerprint` comes from the existing `transactionalEmailFingerprint`
helper, binding the immutable sender, sole recipient, subject, exact text and
HTML, delivery UUID, idempotency key, and fixed Resend endpoint. Retain the
original first-dispatch timestamp and use the existing dispatch fence/retry
window; this envelope does not extend provider idempotency retention.

## Encryption and rotation

Use a dedicated random 32-byte AES key, supplied only from server runtime secret
storage, with an integer version from 1 through 2147483647. Do not reuse the
integration credential, Auth signing, service-role, or Resend API key. The
helper imports a nonextractable AES-256-GCM key, generates a fresh random
12-byte nonce, and uses a 128-bit authentication tag. Creation does not accept a
caller-chosen nonce. Runtime key provisioning is outside this helper.

Authenticated additional data is UTF-8 JSON of the following ordered array:

`["dominion-early-access-envelope", "app_invitation", 1, keyVersion,
requestId, generationId, deliveryId, recipient, issuedAt, expiresAt, from,
tokenDigest, contentFingerprint, idempotencyKey]`

The plaintext is UTF-8 JSON containing exactly `{ version: 1,
purpose: "app_invitation", token, content }`. The content is the fully rendered,
frozen `TransactionalEmailContent`. Plaintext is capped at 8192 bytes.
Ciphertext plus tag is capped at 8208 bytes (10944 base64url characters). Nonce
is exactly 16 base64url characters. Both encodings must be canonical and
unpadded. This protocol has a separate purpose/AAD from integration credentials.

`openEarlyAccessInvitation(envelope, binding, { keyVersion, key }, expected)`
requires `expected` to contain exactly `{ tokenDigest, contentFingerprint,
idempotencyKey }`. Select the dedicated key for the envelope's exact version;
there is no latest-key fallback. It authenticates all binding fields and stored
fingerprints, checks the inner token digest, purpose, schema, exact recipient,
sender, subject, URL, and transactional fingerprint, then returns the exact
frozen persisted content. It never rerenders retry copy. Keep old key versions
available for authorized pending jobs until they are safely completed or
terminally retired; do not relabel an existing ciphertext's key version.

Opening is not permission to send. Only open a currently leased job after the
database's current generation/expiry/revocation checks, and keep the transactional
dispatch fence immediately before sending. Discard plaintext after dispatch.
The only public error message is `Invalid early-access invitation configuration.`
No underlying crypto/parser exception or secret value is attached.

## Durable service worker

`process-early-access-invitations` accepts only POST with the dedicated
`x-dominion-worker-key` matching `EARLY_ACCESS_INVITATION_WORKER_SECRET`. It has no
browser CORS response and does not consume request-selected delivery IDs,
recipients, payloads, or redrive parameters. Required runtime configuration is
`RESEND_API_KEY`, `TRANSACTIONAL_EMAIL_FROM`, the canonical base64url 32-byte
`EARLY_ACCESS_INVITATION_KEY`, and its positive integer
`EARLY_ACCESS_INVITATION_KEY_VERSION`. The worker uses the existing service
client only after its own authentication/configuration gate.

Each invocation claims at most one delivery from
`claim_early_access_invitation_deliveries`. It authenticates/decrypts the
persisted payload, requires its frozen sender to match current configuration,
then calls the existing transactional adapter. The adapter calls
`mark_early_access_invitation_dispatched` immediately before its only fixed-URL
Resend POST. SQL must revalidate lease, generation, expiry, account health and
free quota and persist the original first dispatch timestamp at that fence.
A null fence receipt means no send. Uncertain fence/provider results retain the
same frozen message, idempotency key and dispatch timestamp for a bounded retry;
after the existing conservative 23-hour retry window, operator review is
required. `settle_early_access_invitation_delivery` stores only fixed outcome
codes and a validated provider UUID receipt. Provider acceptance is not a claim
that an email reached the mailbox.

Only one runtime AES version is currently configured. Drain or terminally retire
old-version pending deliveries before switching that setting; otherwise those
deliveries correctly stop for review instead of silently using the wrong key.
The helper's versioned protocol permits a future explicitly reviewed key-ring
loader, but the worker does not automatically fall back to another key.

RPC and email work is abort/deadline bounded. Worker responses contain only an
aggregate state, never recipient identity, tokens, encrypted material, sender,
provider bodies or exception details. The worker does not schedule itself,
provision secrets, enable billing, or make hosted changes upon import/deployment.

## Verification

The Deno suite covers fresh randomness, known SHA-256 vectors, exact frozen
roundtrips, transactional fingerprints, all AAD fields, independent purpose
binding, ciphertext/nonce/tag tampering, exact key versions, malformed/bounded
envelopes and plaintext, invalid dates/lifetimes, getter rejection, input mutation
across awaits, header injection, HTML escaping, and altered token URLs.
Tests need no network, environment, or database permission.
