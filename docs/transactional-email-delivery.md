# Transactional email delivery boundary

`supabase/functions/_shared/transactional_email.ts` is a server-only Resend
adapter. It does not provision an account, configure DNS/Auth SMTP, render
templates, read secrets from the environment, authorize recipients, or schedule
delivery. No emails are sent by importing it. Tests use only injected fixtures.

## Durable job and worker contract

Persist `deliveryId`, a stable `idempotencyKey`, the already-rendered
`message: { from, to, subject, text, html }`, and the result of
`transactionalEmailFingerprint(content)` atomically with the originating event.
The fingerprint covers the fixed endpoint, delivery ID, key, and exact serialized
message. Never re-render, trim, change recipient, rotate the key, or recompute the
stored fingerprint to conceal a changed payload during retry. Invitation content
containing secrets needs the separately reviewed encrypted-payload lifecycle;
the adapter does not make plaintext storage safe.

`deliverTransactionalEmail(job, options)` receives that persisted job plus its
nullable canonical `firstDispatchedAt`. Options inject the sending-only API key,
`markDispatched(binding, signal)`, and optionally fetch/clock/abort/deadline.
`markDispatched` must atomically enforce the current worker lease, immutable
binding, account/event validity, and free-plan budget, then persist the first
dispatch timestamp before resolving with:

```ts
{ deliveryId, idempotencyKey, bindingFingerprint, firstDispatchedAt }
```

It is called for every attempt. Retries return the original timestamp; an older
job snapshot with a null timestamp must also receive any timestamp already
persisted by another worker. A confirmed denial returns `null`; throws or timeout
mean the fence is unconfirmed. A timed-out/aborted callback must not later claim
a lease or overwrite another worker's state. Persist all outcomes under the
same lease; do not overwrite a newer accepted receipt with a late failure.

Only a strict UUID provider receipt yields `state: "accepted"`. This means Resend
accepted the request, not that the inbox received it. Other states are
`retryable`, `uncertain`, or `needs_review`, with allowlisted codes only. Raw
provider messages, message bodies, addresses, and API keys are never returned or
logged. Definitive provider configuration errors and quota limits require review;
there is no automatic upgrade, paid fallback, or key replacement.

## Retry safety and bounds

Resend retains idempotency keys for 24 hours and returns the original response
for an identical retry. A changed payload under the same key conflicts; a
concurrent request can be retried later. See [Resend idempotency
keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

This adapter uses a stricter **23-hour window from the first persisted dispatch**,
reserving the full request deadline inside it. It checks before the fence, after
the fence, and immediately before POST. A missing/wrong binding, changed first
timestamp, future/invalid clock, expired window, or conflict never sends another
message. After an unknown outcome ages out, persist `needs_review`; never blindly
resend with a new key or reset the timestamp. Manual reconciliation is separate.
There is no in-process retry loop and no claim of perpetual exactly-once delivery.

Both the fence and HTTP exchange default to 10-second deadlines, each bounded to
1–30,000 ms. Abort/deadline returns even when an injected provider ignores abort.
The only network target is `https://api.resend.com/emails`, with `redirect: error`.
Requests are limited to 128 KiB UTF-8; responses, including chunked bodies, to
16 KiB. Only one recipient is allowed. CC/BCC, reply-to, attachments, arbitrary
headers, remote templates, and scheduled sends are not accepted. Subject/header
controls are rejected; HTML must already be safely escaped by the renderer.
See the [send-email API](https://resend.com/docs/api-reference/emails/send-email)
and [error contract](https://resend.com/docs/api-reference/errors).

## Free plan and support-address integration

The approved budget is at most **100 emails/day and 3,000/month**, free only.
The durable worker must reserve capacity atomically before the original send,
count uncertain sends conservatively, and not reset limits to force a retry.
Known exact cached retries should reuse the original reservation. Other uses of
the same provider account can consume the shared quota; provider quota errors
must stop delivery rather than upgrade. No budget counter is implemented here.

The eventual renderer should take the sender and support destination from the
same reviewed site-contact configuration used by the Support page. Do not add
a second hardcoded support address, route replies to an automatically collected
user email, or alter Supabase Auth SMTP as part of this adapter. Verification of
the approved domain/sender and private runtime-key entry remain integration gates.

Pure verification:

```sh
cd supabase
deno test --frozen functions/_shared/transactional_email_test.ts
```
