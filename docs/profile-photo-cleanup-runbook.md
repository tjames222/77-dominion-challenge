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
