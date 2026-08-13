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

First run this proof against the clean local full stack. Repeat it during the
closed canary on the single hosted production project before public signup is
opened: register and upload a disposable profile photo, abandon it, and then
leave the Profile page. Record evidence that:

1. Cron invokes the worker without a member session.
2. The exact Storage object becomes absent.
3. Its lifecycle row becomes `retired` and the digest tombstone is terminal.
4. A canonical photo, an object with the wrong identity, and an account under
   erasure sealing are not deleted.
5. Health returns to zero ready/stale work and the alert path receives its test.

Pause the Cron job before rolling back the Function. Never restore browser
Storage DELETE permission as an operational workaround.
