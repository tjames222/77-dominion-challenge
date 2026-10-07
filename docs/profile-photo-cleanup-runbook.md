# Profile-photo cleanup worker

The trusted upload boundary and its closed-canary checklist are documented in
[`profile-photo-upload-security.md`](./profile-photo-upload-security.md).

FOU-802 replaces best-effort browser deletion with a service-only worker. The
database owns eligibility, exact object identity, leases, stale-lease recovery,
backoff, and terminal tombstones. The Edge Function only uses the Storage API
after `verify_profile_photo_cleanup_service` rechecks the canonical profile
pointer and account-erasure state.

## Required production configuration

1. Generate a random `PROFILE_PHOTO_WORKER_SECRET` containing at least 32
   characters. It must differ from every integration, retention, and DR secret.
2. Add the value to the GitHub `production` environment and Supabase Edge
   Function secrets. The release workflow fails closed when it is absent,
   deploys `process-profile-photo-cleanup` with platform JWT verification off,
   and calls its authenticated health mode.
3. Dispatch the protected `full` production release. After the release proves
   exact zero-pending migration history, synchronizes Function secrets, and
   deploys `process-profile-photo-cleanup`, it runs
   `scripts/configure-production-profile-photo-cleanup-cron.mjs`. The script
   uses the Supabase Management API to enable `pg_cron` in `pg_catalog` and
   `pg_net` in `extensions`, then creates or updates the two named Vault values
   and the one active five-minute job. The operation is transaction-locked,
   idempotent, parameterized, and verified before the hosted worker health
   request can run.
4. Do not create or edit this job through direct `cron.job` writes. The release
   uses only Supabase's supported `cron.schedule` and `cron.alter_job` APIs. Its
   stored command reads `profile_photo_project_url` and
   `profile_photo_worker_secret` only through `vault.decrypted_secrets`; it
   never contains the project URL or worker credential. Management API errors
   are status-only, and the fixed verification `SELECT` returns counts and
   booleans rather than a decrypted value. It uses the privileged query role
   only because Supabase's read-only role correctly cannot decrypt Vault.

The GitHub `production` environment must provide the protected secret
`SUPABASE_ACCESS_TOKEN`, variable `SUPABASE_PROJECT_REF`, variable
`VITE_SUPABASE_URL`, and secret `PROFILE_PHOTO_WORKER_SECRET`. Never put their
values in a migration, repository file, command argument, job text, or release
log. A setup or verification mismatch fails the backend release before health
proof and therefore prevents the frontend release.

Supabase records runs in `cron.job_run_details`. Keep the job at five-minute
intervals unless local rehearsal and closed-canary load evidence support a
change; claims are capped at
100 and leased for five minutes, and database backoff reaches six hours.

## Health and alerting

Tim James is the approved cleanup-alert owner, with operational notifications
destined for `tjames@cablueprinting.com` (September 28, 2026
[ownership decision](release-governance.md)). The worker and five-minute Cron
are deployed, but naming this owner does not configure notifications: FOU-802
remains open until threshold evaluation, durable deduplication/recovery behavior,
and a received alert through the installed delivery channel are verified.

Call health mode only from a trusted operator or monitor:

```bash
curl --fail-with-body \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "x-dominion-worker-key: ${PROFILE_PHOTO_WORKER_SECRET}" \
  --data '{"mode":"health"}' \
  "${SUPABASE_URL}/functions/v1/process-profile-photo-cleanup"
```

The response contains aggregate counts only. It never includes a member ID,
object path, or image content. Alert when any of these conditions holds:

- the Cron job or health request fails twice in succession;
- `staleLeases` is nonzero for more than ten minutes;
- `ready` exceeds 100 or `oldestReadyAt` is more than fifteen minutes old;
- `failuresLastHour` exceeds five.

Investigate Edge Function structured events, Storage availability, database
health, and `cron.job_run_details`. A failed object is released to exponential
database backoff; do not delete it manually or bypass the exact-object trigger.

### Independent read-only monitor boundary (FOU-802)

The additive `profile_photo_cleanup_monitor_health()` RPC and
`mode=monitor-health` Function path supply a narrow health boundary. The approved
protected backend release now includes synchronization of the independent health
secret. The inert monitor Worker and protected secret are provisioned, but the
backend migration/secret synchronization, mail verification, and monitor
activation remain pending. **Monitoring and notifications are not active.** The
existing worker/Cron credential and `mode=health` call above continue to work
without the new setting.

The monitor path requires a separate `PROFILE_PHOTO_HEALTH_SECRET`: exactly 32
random bytes encoded as canonical unpadded base64url (43 characters), different
from `PROFILE_PHOTO_WORKER_SECRET` and every other integration credential. Keep
it only in protected server/monitor secret stores. Do not give a monitor the
destructive worker key, service-role key, Management API token, or Vault access.
The approved release workflow reads it from the GitHub `production` environment,
validates it, and synchronizes it to Supabase Edge Function secrets only in the
protected backend job; frontend-only releases do not synchronize it.

The request contract is `POST`, `Content-Type: application/json`, header
`x-dominion-health-key`, and the exact object `{"mode":"monitor-health"}`.
Do not send `x-dominion-worker-key` alongside it. The health credential cannot
authorize the old health mode, default processing, or any batch limit; the
worker credential cannot authorize the new monitor mode. Requests with invalid
JSON, duplicate/escaped/unknown keys, extra fields, unknown modes, encoded
bodies, more than 256 body bytes, or an incomplete body after one second fail
before creating an admin client. Existing supported worker objects remain
`{}`, `{"limit":25}` (integer 1–100), and `{"mode":"health"}`. Previously
malformed requests must not be relied on to default to cleanup.

A successful response is `{status:"ok",health:{schemaVersion:1,...}}` with
`Cache-Control: no-store`. This means the snapshot was read, **not** that the
operational state is healthy. It contains:

- `generatedAt` and the existing `cleanup` aggregate, including its own
  `generatedAt`, queue/lease/failure counts and `oldestReadyAt`;
- `cron.extensionAvailable`, `catalogAvailable`, and `jobState` (`unavailable`,
  `missing`, `present`, or `ambiguous`) for only the fixed cleanup job;
- nullable `active` and `scheduleMatches` (the exact `*/5 * * * *` schedule);
- `historyAvailable`, `stale`, `staleAfterSeconds:900`, and at most the exact
  last two runs, newest first, each limited to `runId`, fixed-label `status`,
  `startedAt`, and `endedAt`;
- `transportEvidence:"enqueue-only"`. A successful Cron run proves only that
  its SQL finished enqueueing the asynchronous pg_net request. It does not
  prove an HTTP response, Storage deletion, or successful cleanup.

Treat run IDs as canonical decimal **strings**, never JavaScript numbers:
PostgreSQL bigint IDs can exceed the safe-number range. They are operational
deduplication identities, not member IDs or Cron connection identities. Unknown
native statuses reduce to `unknown`; returned statuses never include raw error
text. No recent start time (or one outside the previous 15 minutes, including a
future timestamp) marks the schedule stale. An absent/ambiguous job supplies no
run history or borrowed status from another owner's job. Consumers must also
reject stale/invalid HTTP snapshots and apply the separate queue thresholds;
they must not interpret an HTTP 200 or `stale:false` alone as healthy.

The new SQL helper is stable, security-definer with an empty search path, and
executable only by `service_role`, with an additional rejection of any non-null
`auth.uid()`. It grants no direct Cron or private lifecycle-table access. The
Function validates and projects a fixed response allowlist; it does not expose
Cron commands, usernames, databases, `return_message`, HTTP bodies, Vault values,
member IDs, object paths or image content. No health call claims, retries,
expires, deletes, repairs, or changes a schedule.

Verification without touching the shared local Supabase stack:

```bash
node --test scripts/profile-photo-cleanup-monitor.sql.test.mjs
```

This creates and removes only a uniquely labeled, cached-image PostgreSQL
fixture with no network/ports/host mounts, tmpfs data, read-only root and all
background workers disabled. It executes the real pg_cron extension, additive
migration, and `320_profile_photo_cleanup_monitor_health.sql` ACL tests.
The ordinary Function test suite also executes the credential/body/response
reject matrix. This isolated health proof does not replace the destructive
worker rehearsal or prove alert delivery.

### Private scheduled monitor implementation (not yet activated)

`workers/profile-photo-cleanup-monitor/` contains the independent Worker and
SQLite-backed Durable Object. Its checked-in configuration pins the existing
Dominion account, disables HTTP/preview URLs and routes, leaves Cron triggers
empty, and sets `ALERTS_ENABLED=false`. The Worker and protected health secret
have been provisioned in this inert state. Backend migration/secret
synchronization, provider/mail verification, received email evidence, and
activation remain release steps; provisioning is not evidence of active alerts.

The provisioned resource is `dominion-profile-photo-cleanup-monitor`, with one
private object named `profile-photo-cleanup-v1`. Its eventual offset schedule is
`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`. Health requests are pinned to the
existing Supabase Function, forbid redirects, have an eight-second deadline and
an 8 KiB decoded-body ceiling. No URL/body/recipient override is accepted.
Runtime authority is only the independent health credential plus the email
binding restricted to `alerts@77dominion.com` and `tjames@cablueprinting.com`.

Each poll is serialized, and state is reloaded from physical storage. Both the
frozen notification intent and daily budget are committed before invoking email
once. Thresholds above are combined into one incident, with at most one update
for newly appearing conditions and recovery after two consecutive fresh healthy
observations. The global ceiling is six reserved notifications per UTC day,
including rejected and uncertain sends. State is bounded, not reset on deploy,
and contains no member data, object paths, response bodies or credentials.

Email `accepted` means only that the binding returned a valid message ID; it does
not claim destination delivery or recipient acknowledgment. A timeout, malformed
result or interrupted `sending` becomes `delivery_unknown`, blocks all further
mail, and is never automatically retried. A known pre-acceptance provider
rejection is recorded as `provider_rejected`. Logs contain fixed status/condition
codes, timestamps, the bounded notification identity and provider message ID.
Unknown stored schemas or malformed records fail closed instead of resetting.

For uncertain mail, Tim reviews the exact notification ID, provider evidence and
recipient inbox. Only a protected Worker configuration change may set
`MONITOR_RECONCILE_NOTIFICATION` to that exact ID. The next poll records
`resume_without_retry` and allows future distinct notifications. It does **not**
retry the uncertain message, assert receipt, clear its uncertain status, erase
history, or reset quota. Remove the configuration value after acknowledgment;
leaving it set cannot acknowledge a later notification. No public reconciliation
or reset route exists. Disabling alerts or the schedule must preserve the object
and its migration identity; never delete state as an incident workaround.

The approved two-message acceptance canary is selected only with the exact
private configuration `MONITOR_SELF_TEST=owner-acceptance-2026-10-07` while
`ALERTS_ENABLED=false`. It uses separate persisted synthetic state: one test
incident then two fresh healthy synthetic observations on later scheduled polls.
Both messages say `TEST ONLY`; they use the same fixed binding and recipient and
share the six-notification budget. Real health is still read without injecting
synthetic conditions into its incident state. The canary never changes Supabase,
leases, photos, Cron jobs, DNS, or billing. Its completion record survives flag
removal/redeploy/restart, so the same identity cannot send again.

An uncertain test send also blocks future real mail even after removing the
canary flag. Its reconciliation ID is qualified with
`owner-acceptance-2026-10-07/`, followed by the recorded notification ID. Do not
substitute an unqualified ID or create a new canary identity to resend. Completion
and provider acceptance remain separate from the required two recipient receipts.
After those receipts and healthy real observations, remove the canary flag and
enable ordinary alerts in the reviewed deployment. Never activate a paid plan or
change sending DNS to make the test pass without new approval.

Local verification uses only synthetic transport/email and an owned temporary
SQLite directory; it makes no hosted health or mail request:

```bash
node --test workers/profile-photo-cleanup-monitor/*.test.mjs
```

The native tests use the lockfile-pinned Miniflare/Workerd package and actual
SQLite files, destroy/restart the runtime, and prove overlap serialization,
uncertain-send recovery and one-shot replay suppression. They remove only their
owned temporary fixture directories. Native test timing is not production CPU
measurement; confirm Workers Free entitlement, available Cron/DO quota and CPU
before activation. A monitor cannot detect its own complete platform outage.

## Local rehearsal and closed-canary proof

Run the deterministic proof only against the pinned local full stack. It has an
explicit destructive-reset acknowledgement and refuses every database/API
origin except the exact local containers and loopback ports:

```bash
pnpm run rehearse:profile-photo-cleanup-cron -- --confirm-local-reset
```

The command first removes and verifies any exact disposable resources retained
by an interrupted rehearsal, then resets the local database, uploads four new
disposable objects through the local Storage API, and starts a second pinned
Edge Runtime container. It aborts before reset if retained cleanup cannot be
proved, because the tracking tables are the authority for exact Storage
deletion. The isolated runtime mounts a staged copy of the real handler; a
reviewed local client bridge permits only the exact local Kong origin. An
executable import-graph gate proves the real handler reaches exactly one
external import and maps that pinned Supabase client import to the bridge. The
runtime clears uppercase and lowercase proxy variables, and the bridge still
rejects every non-local origin. The proof therefore neither uses the CLI
Function server nor contacts a hosted project.

Before resetting, the command holds an atomic lock for this one local project
and attests the pinned Postgres, Storage, Kong, PostgREST, and Edge Runtime
images, the Supabase network, and Kong's exact configured API port. It also
fails closed if a database proxy could route the pg_net runtime alias through a
proxy. Do not bypass these checks to make a local environment pass.

Cron keeps the database-generated, one-use 64-character worker secret in a
revoked unlogged tracking table and stores only a table reference in job text.
That table atomically records the Cron job ID and every readiness, worker,
health, and teardown pg_net request ID. The reset verifies the exact database
runtime but deliberately does not require the CLI-managed Edge Runtime to be
mounted from the current worktree, because the isolated runtime is the reviewed
Function source boundary for this proof.

The proof emits three aggregate JSON records: Cron history, the cleanup worker
result, and a separate authenticated `mode=health` response. The health record
must have a non-null observation time and a non-null `oldestReadyAt` within the
documented fifteen-minute threshold. Captured stdout and stderr are searched
for both the worker secret and local service-role key before either stream is
released; SQL evidence is also checked for fixture identity and worker-secret
leaks.

Teardown first unschedules the one named job and requires repeated quiet
observations with no schedule and no nonterminal `cron.job_run_details` row.
After pruning terminal history, it requires a second quiet window so a late
`starting`, `connecting`, or `sending` run cannot escape cleanup. It then waits
until every tracked pg_net request has a terminal response, deletes only those
queue/response rows, and asserts that none remain.

Before any exact fixture Storage delete, teardown cancels its fixture erasure
batch where necessary and clears canonical avatar pointers. A non-null recorded
Storage object UUID is immutable: if the current exact bucket/path belongs to a
different UUID, teardown fails closed and retains its inventory. Only the crash
gap where the upload trigger recorded its UUID in the registry before the
fixture recorded it may fill a null fixture UUID once, and only when that same
registry UUID still occupies the path. Teardown then binds the registry to that
exact UUID, transitions the row to cleanup, obtains a live service claim, and
re-verifies the claim against the same identity before sending a JSON
bulk-delete request for the reviewed path. Tracking inventory is retained
whenever exact runtime absence, Cron/pg_net drain, or a database existence probe
cannot be proved. Related fixture inventory is retained whenever identity,
authorization, or Storage deletion cannot be proved; lifecycle rows and fixture
accounts are removed only after `storage.objects` proves zero exact-path
residue.

Cleanup removes the labeled runtime by its exact name even when failure occurs
immediately after `docker run`, then removes the lifecycle rows, deletion batch,
fixture accounts, tracking tables, and temporary files. A `pg_cron` extension
that existed before the rehearsal is preserved; one installed by the rehearsal
must be removed successfully before its ownership record is dropped. Cleanup is
idempotent and runs again from the EXIT trap. It never deletes a Docker volume.

Maintainers can set `FOU802_REHEARSAL_FAULT_AFTER` to one of the checkpoint
names covered by `test:profile-photo-cleanup-cron` to rehearse failure cleanup.
Those runs still require `--confirm-local-reset`, are destructive to the same
local database, and must not be run without the same explicit approval as the
normal rehearsal.

The local proof must establish that:

1. Cron invokes the worker without a member session, and a distinct
   authenticated health request returns fresh non-alerting aggregates.
2. The exact Storage object becomes absent.
3. Its lifecycle row becomes `retired` and the digest tombstone is terminal.
4. A canonical photo, an object with the wrong identity, and an account under
   erasure sealing are not deleted.
5. Aggregate health remains below every documented alert threshold.

The account-erasure fixture intentionally remains one fresh ready item in the
first worker and health responses because its governing deletion batch blocks
cleanup. This is non-alerting: `ready` is below 100, `oldestReadyAt` is present
and under fifteen minutes, `staleLeases` is zero, and the single wrong-identity
failure is below the documented threshold. The teardown invocation cancels
only that disposable local batch and proves all fixture objects are removed.

Repeat the behavioral checklist separately during the closed canary on the
single hosted production project before public signup is opened. Do not run the
local command for that canary: it deliberately cannot address a hosted origin.

Pause the Cron job before rolling back the Function. Never restore browser
Storage DELETE permission as an operational workaround.
