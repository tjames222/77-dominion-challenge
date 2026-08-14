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
3. In Supabase Vault, create `profile_photo_project_url` containing the project
   URL and `profile_photo_worker_secret` containing the same worker secret. Do
   not put either value in a migration, repository file, client variable, or
   Cron job text.
4. Enable the Supabase Cron and `pg_net` integrations, then create the job below
   through the Dashboard SQL editor after reviewing the decrypted-secret names.

```sql
select cron.schedule(
  'process-profile-photo-cleanup',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'profile_photo_project_url'
    ) || '/functions/v1/process-profile-photo-cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dominion-worker-key', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'profile_photo_worker_secret'
      )
    ),
    body := '{"limit":25}'::jsonb,
    timeout_milliseconds := 10000
  ) as request_id;
  $job$
);
```

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

The command resets the local database, uploads four disposable objects through
the local Storage API, and starts a second pinned Edge Runtime container. The
isolated runtime mounts a staged copy of the real handler; a reviewed local
client bridge permits only the exact local Kong origin. An executable import-
graph gate proves the real handler reaches exactly one external import and maps
that pinned Supabase client import to the bridge. The runtime clears uppercase
and lowercase proxy variables, and the bridge still rejects every non-local
origin. The proof therefore neither uses the CLI Function server nor contacts a
hosted project.

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

Teardown first unschedules the one named job and waits for its active runs to
finish. It then waits until every tracked pg_net request is either queued or has
a response, deletes only those queue/response rows, and asserts that none
remain. If an upload succeeded before its object ID was recorded, cleanup
recovers the ID from the exact `profile-photos` bucket/path and sends a JSON
bulk-delete request for that path only. Cleanup removes the labeled runtime by
its exact name even when failure occurs immediately after `docker run`, then
removes the lifecycle rows, deletion batch, fixture accounts, tracking tables,
and temporary files. A `pg_cron` extension that existed before the rehearsal is
preserved; one installed by the rehearsal is removed. Cleanup is idempotent and
runs again from the EXIT trap. It never deletes a Docker volume.

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
