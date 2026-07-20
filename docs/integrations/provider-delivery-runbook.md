# Slack and Discord integration delivery runbook

This runbook provisions the provider applications and operates the durable
delivery runtime added by FOU-553. The runtime is dormant until its two server
secrets are present and a provider destination has been created by the secure
connection flow in FOU-541. No provider credential belongs in the repository,
browser bundle, logs, seed data, or CI fixtures.

## Environment isolation and ownership

Create two Slack applications and two Discord applications. The non-production
applications may serve local development and staging test destinations; the
production applications may authorize only production callbacks and real
customer destinations.

| Environment | Slack app | Discord app | Destinations | Secret owner |
| --- | --- | --- | --- | --- |
| Development/staging | `77 Dominion Updates Staging` | `77 Dominion Updates Staging` | Dedicated test workspace/server and channels | Integration administrator |
| Production | `77 Dominion Updates` | `77 Dominion Updates` | Customer-approved workspaces/servers and channels | Production integration administrator |

Use a separate Supabase project and separate secrets for each environment. Do
not install the production apps into test destinations or copy a staging bot
token into production.

## Provider application registration

### Slack

1. Import `slack-app-manifest.example.yaml` in the Slack app dashboard. Replace
   `ENVIRONMENT` and `PROJECT_REF` first.
2. Retain only `chat:write`, `channels:read`, and `groups:read`. The application
   does not read message history, users, files, reactions, or direct messages.
3. Confirm the HTTPS OAuth redirect exactly matches the callback deployed by
   FOU-541. Enable token rotation and keep Socket Mode, incoming webhooks, event
   subscriptions, and interactivity disabled.
4. Install the staging app into an isolated test workspace. Add the bot only to
   the public and private channels used for verification.
5. Record the client ID, client secret, and signing secret in the environment's
   managed secret store. Never copy the bot access or refresh token out of the
   OAuth callback; FOU-541 encrypts those values before persistence.
6. Complete Slack's distribution/review checklist before allowing installations
   outside the owned test workspace. Recheck the manifest export against the
   reviewed file after every provider-side change.

### Discord

1. Create the application and bot in the Discord Developer Portal using
   `discord-app-config.example.json` as the reviewed configuration record.
2. Request only the `bot` and `identify` install scopes and permission integer
   `3072` (`VIEW_CHANNEL` plus `SEND_MESSAGES`). Do not enable privileged Gateway
   intents; this integration makes REST sends and does not consume messages.
3. Require the OAuth2 code grant and register the exact HTTPS callback deployed
   by FOU-541. Use the returned guild ID only after validating the signed Dominion
   state and the installing user's current group-admin authority.
4. Install the staging bot into an isolated test server and grant it access only
   to the verification channels. Channel-level overrides must preserve both
   required permissions.
5. Store the client ID, client secret, public key, and bot token in the managed
   environment secret store. FOU-541 encrypts the bot token for a destination;
   the shared application token must never be returned to the browser.
6. Complete the provider verification/review process before broad production
   installation, and keep the production bot unavailable until that approval is
   recorded.

## Runtime secrets

Configure these Supabase Function Secrets directly or through protected GitHub
environment secrets. Use independent values per environment.

| Secret | Format | Rotation |
| --- | --- | --- |
| `INTEGRATION_WORKER_SECRET` | At least 32 random characters | Rotate immediately on suspected disclosure; update Cron and the Function Secret together |
| `INTEGRATION_CREDENTIAL_KEYS` | JSON map of positive key version to a base64-encoded 32-byte AES key, for example `{"1":"…"}` | Add a new version before re-encrypting; retain old versions until no row references them |
| `SLACK_CLIENT_ID` | Provider value | Rotate/reissue with the Slack app |
| `SLACK_CLIENT_SECRET` | Provider secret | Rotate at provider and update Function Secret atomically |
| `SLACK_SIGNING_SECRET` | Provider secret | Rotate at provider and update Function Secret atomically |
| `DISCORD_CLIENT_ID` | Provider value | Rotate/reissue with the Discord app |
| `DISCORD_CLIENT_SECRET` | Provider secret | Rotate at provider and update Function Secret atomically |
| `DISCORD_PUBLIC_KEY` | Provider value | Update when the Discord app changes |
| `DISCORD_BOT_TOKEN` | Provider secret | Reset at provider, replace encrypted destination credentials, then revoke the old token |

Generate AES key material with a trusted secret-management tool that can produce
32 random bytes and base64 encode them. Do not print generated values into CI
logs or shell history. The worker accepts a versioned key ring so a rotation can
be rolled forward without making already-queued deliveries unreadable.

The production workflow treats the runtime as disabled when both runtime secrets
are absent, and fails closed when only one is present. FOU-541 must add its
provider secrets to the same protected environment before connection UI is
enabled.

## Deploy and schedule

1. Apply migrations before deploying `process-integration-outbox`.
2. Set both runtime secrets, deploy the function with JWT verification disabled,
   and retain its independent `x-dominion-worker-key` authorization. A bearer or
   public Supabase key alone cannot invoke the worker.
3. In Supabase Cron, create `dominion-integration-delivery` to invoke the Edge
   Function every minute with JSON body `{"mode":"process","batchSize":20}`.
   Put the worker secret in a Vault-backed custom header; never inline it in a
   migration or job definition.
4. Create `dominion-integration-maintenance` at `17 3 * * *` UTC with body
   `{"mode":"maintenance"}`. This releases stale locks, redacts old payloads and
   provider metadata, and removes terminal rows after the retention window.
5. Inspect Cron job history and run the authenticated health request. A healthy
   empty runtime returns HTTP 200 with zero queued, processing, and recent dead
   letters.

Cron and `pg_net` must be enabled in the target Supabase project. Provision the
jobs through the Integrations → Cron interface so the custom header remains
Vault-backed. Capture the job names, schedules, project reference, operator, and
UTC time in the release record.

## Contract for connection and event tickets

FOU-541 writes one `private.integration_destinations` row per approved channel
through a reviewed security-definer RPC. It must generate the destination UUID
before encryption, encode the provider credential as JSON with one
`accessToken` field, and encrypt with AES-256-GCM using:

- a fresh 12-byte nonce;
- the selected version from `INTEGRATION_CREDENTIAL_KEYS`;
- UTF-8 additional authenticated data
  `77-dominion:<provider>:<destination UUID>`;
- a SHA-256 credential fingerprint for rotation and duplicate detection.

Only a server callback may persist or replace ciphertext. Browser-facing reads
must use a sanitized projection that excludes ciphertext, nonce, key version,
fingerprint, and provider error diagnostics.

FOU-542 publishes through `enqueue_outbound_delivery`. Its group ID must match
the destination's group, event names must use the registered lowercase contract,
and the idempotency key must identify one logical event/destination pair. An
exact retry returns the existing row; reusing a key with changed event data is an
error. Publication must not wait for or call a provider. The worker exclusively
uses `claim_outbound_deliveries`, `settle_outbound_delivery`, health, stale-lock,
and retention RPCs with the service role.

## Staging acceptance exercise

Complete this exercise once for Slack and once for Discord before production
promotion:

1. Use FOU-541's connection flow to authorize the staging provider app and select
   the isolated test channel. Confirm the stored destination is server-only and
   its credential column is ciphertext with a 12-byte nonce and a current key
   version.
2. Invoke the worker with `mode=synthetic`, the destination's group and
   destination IDs, an idempotency key unique to the test, and non-sensitive test
   text. Confirm one message arrives and an identical retry creates no second
   queue row.
3. Temporarily make the destination return a retryable response or use a test
   adapter. Confirm the attempt is recorded, the outbox is rescheduled, Check-In
   submission remains successful, and the next worker run succeeds.
4. In a test-only row with `max_attempts=1`, force another retry. Confirm terminal
   `dead_letter` state, a redacted attempt record, and a non-zero health signal.
5. Disconnect the staging destination and confirm new enqueue attempts fail and
   no stale credential can send. Reconnect and run one final synthetic message.

Never use production member progress as a synthetic payload.

## Observability and alerts

The worker emits one structured settlement log containing only delivery ID,
group ID, provider, attempt number, outcome, HTTP status, and a normalized error
code. It never logs message payloads, authorization headers, credentials, or raw
provider response bodies.

Alert when any of these conditions persist for two worker intervals:

- the oldest ready delivery is more than five minutes old;
- processing rows remain locked for more than five minutes;
- dead letters occur in the last 24 hours;
- Cron or Edge Function invocations fail twice consecutively;
- provider authorization failures occur for an active destination.

Rate limits are rescheduled using the provider's `Retry-After` signal when
present. Other transient failures use bounded database backoff and stop after at
most eight attempts. Authorization, invalid destination, and invalid payload
failures dead-letter without an unbounded retry loop.

## Retention, incident response, and rollback

- Successful payload content is replaced with a redacted marker after seven
  days. Attempt metadata and error summaries are redacted after 30 days.
- Delivered, dead-lettered, and cancelled rows are removed after 90 days.
- Credentials persist only while the destination remains connected and must be
  revoked and deleted by the disconnect/deletion work in FOU-541 and FOU-564.
- On suspected credential disclosure, disable the destination, stop its Cron job,
  rotate or revoke the provider token, rotate affected encryption/worker secrets,
  preserve redacted audit records, and then resume with a synthetic test.
- To roll back worker code, disable the Cron jobs and deploy the last known-good
  function. Keep additive queue tables and migrations in place; do not drop the
  outbox during an incident. Queued Check-Ins remain committed independently and
  can be drained after recovery.
