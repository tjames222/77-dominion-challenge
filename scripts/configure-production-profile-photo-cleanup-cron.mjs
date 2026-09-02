import { pathToFileURL } from "node:url";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "./production-auth-canary-policy.mjs";

const MANAGEMENT_API_BASE_URL = "https://api.supabase.com/v1/projects";
const REQUEST_TIMEOUT_MS = 30_000;
const PROJECT_URL_SECRET_NAME = "profile_photo_project_url";
const WORKER_SECRET_NAME = "profile_photo_worker_secret";
const CRON_JOB_NAME = "process-profile-photo-cleanup";
const CRON_SCHEDULE = "*/5 * * * *";

export const PROFILE_PHOTO_CLEANUP_CRON_COMMAND = `select net.http_post(
  url := pg_catalog.rtrim((
    select decrypted_secret
    from vault.decrypted_secrets
    where name = '${PROJECT_URL_SECRET_NAME}'
  ), '/') || '/functions/v1/process-profile-photo-cleanup',
  headers := pg_catalog.jsonb_build_object(
    'Content-Type', 'application/json',
    'x-dominion-worker-key', (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = '${WORKER_SECRET_NAME}'
    )
  ),
  body := '{"limit":25}'::jsonb,
  timeout_milliseconds := 10000
) as request_id;`;

export const EXTENSION_SETUP_QUERY = `do $extension_setup$
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.set_config('statement_timeout', '30s', true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('77-dominion:profile-photo-cleanup-cron', 0)
  );

  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute 'create extension if not exists pg_net with schema extensions';

  if not exists (
    select 1
    from pg_catalog.pg_extension as extension
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = extension.extnamespace
    where extension.extname = 'pg_cron'
      and namespace.nspname = 'pg_catalog'
  ) then
    raise exception 'pg_cron is not installed in pg_catalog';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension as extension
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = extension.extnamespace
    where extension.extname = 'pg_net'
      and namespace.nspname = 'extensions'
  ) then
    raise exception 'pg_net is not installed in extensions';
  end if;
end
$extension_setup$;`;

export const CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY = `with settings as materialized (
  select
    pg_catalog.set_config('lock_timeout', '5s', true) as lock_timeout,
    pg_catalog.set_config('statement_timeout', '30s', true) as statement_timeout
), locked as materialized (
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('77-dominion:profile-photo-cleanup-cron', 0)
  ) as lock_acquired
  from settings
), project_secret as materialized (
  select secret.id, secret.decrypted_secret, secret.description
  from vault.decrypted_secrets as secret
  cross join locked
  where secret.name = '${PROJECT_URL_SECRET_NAME}'
), project_secret_updated as materialized (
  select vault.update_secret(
    project_secret.id,
    $1::text,
    '${PROJECT_URL_SECRET_NAME}',
    'Production project URL for the profile-photo cleanup Cron job'
  ) as update_result
  from project_secret
  where project_secret.decrypted_secret is distinct from $1::text
     or project_secret.description is distinct from
       'Production project URL for the profile-photo cleanup Cron job'
), project_secret_inserted as materialized (
  select vault.create_secret(
    $1::text,
    '${PROJECT_URL_SECRET_NAME}',
    'Production project URL for the profile-photo cleanup Cron job'
  ) as secret_id
  from locked
  where not exists (select 1 from project_secret)
), project_secret_complete as materialized (
  select
    (select pg_catalog.count(*) from project_secret_updated)
      + (select pg_catalog.count(*) from project_secret_inserted) as writes
), worker_secret as materialized (
  select secret.id, secret.decrypted_secret, secret.description
  from vault.decrypted_secrets as secret
  cross join project_secret_complete
  where secret.name = '${WORKER_SECRET_NAME}'
), worker_secret_updated as materialized (
  select vault.update_secret(
    worker_secret.id,
    $2::text,
    '${WORKER_SECRET_NAME}',
    'Production worker credential for the profile-photo cleanup Cron job'
  ) as update_result
  from worker_secret
  where worker_secret.decrypted_secret is distinct from $2::text
     or worker_secret.description is distinct from
       'Production worker credential for the profile-photo cleanup Cron job'
), worker_secret_inserted as materialized (
  select vault.create_secret(
    $2::text,
    '${WORKER_SECRET_NAME}',
    'Production worker credential for the profile-photo cleanup Cron job'
  ) as secret_id
  from project_secret_complete
  where not exists (select 1 from worker_secret)
), worker_secret_complete as materialized (
  select
    (select pg_catalog.count(*) from worker_secret_updated)
      + (select pg_catalog.count(*) from worker_secret_inserted) as writes
), scheduled as materialized (
  select cron.schedule(
    '${CRON_JOB_NAME}',
    '${CRON_SCHEDULE}',
    $profile_photo_cleanup_job$${PROFILE_PHOTO_CLEANUP_CRON_COMMAND}$profile_photo_cleanup_job$
  ) as job_id
  from worker_secret_complete
), activated as materialized (
  select cron.alter_job(
    job_id := scheduled.job_id,
    active := true
  ) as alter_result
  from scheduled
)
select
  (select pg_catalog.count(*) from activated) = 1
    and pg_catalog.count(*) = 1
    and pg_catalog.min(scheduled.job_id) > 0 as configured
from scheduled;`;

export const VERIFY_PROFILE_PHOTO_CLEANUP_QUERY = `with expected as materialized (
  select $1::text as project_url, $2::text as worker_secret
), extension_state as materialized (
  select
    extension.extname,
    namespace.nspname as schema_name
  from pg_catalog.pg_extension as extension
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname in ('pg_cron', 'pg_net', 'supabase_vault')
), project_secret_state as materialized (
  select
    pg_catalog.count(*)::integer as secret_count,
    pg_catalog.coalesce(
      pg_catalog.bool_and(secret.decrypted_secret = expected.project_url),
      false
    ) as value_matches
  from vault.decrypted_secrets as secret
  cross join expected
  where secret.name = '${PROJECT_URL_SECRET_NAME}'
), worker_secret_state as materialized (
  select
    pg_catalog.count(*)::integer as secret_count,
    pg_catalog.coalesce(
      pg_catalog.bool_and(secret.decrypted_secret = expected.worker_secret),
      false
    ) as value_matches
  from vault.decrypted_secrets as secret
  cross join expected
  where secret.name = '${WORKER_SECRET_NAME}'
), job_state as materialized (
  select
    pg_catalog.count(*)::integer as job_count,
    pg_catalog.coalesce(pg_catalog.bool_and(job.schedule = '${CRON_SCHEDULE}'), false)
      as schedule_matches,
    pg_catalog.coalesce(
      pg_catalog.bool_and(
        job.command = $profile_photo_cleanup_job$${PROFILE_PHOTO_CLEANUP_CRON_COMMAND}$profile_photo_cleanup_job$
      ),
      false
    ) as command_matches,
    pg_catalog.coalesce(pg_catalog.bool_and(job.active), false) as active,
    pg_catalog.coalesce(
      pg_catalog.bool_and(job.command !~* 'https?://'),
      false
    ) as contains_no_embedded_url,
    pg_catalog.coalesce(
      pg_catalog.bool_and(
        pg_catalog.strpos(job.command, expected.project_url) = 0
      ),
      false
    ) as contains_no_project_url,
    pg_catalog.coalesce(
      pg_catalog.bool_and(
        pg_catalog.strpos(job.command, expected.worker_secret) = 0
      ),
      false
    ) as contains_no_worker_secret
  from cron.job as job
  cross join expected
  where job.jobname = '${CRON_JOB_NAME}'
)
select
  exists (
    select 1 from extension_state
    where extname = 'pg_cron' and schema_name = 'pg_catalog'
  ) as pg_cron_schema_matches,
  exists (
    select 1 from extension_state
    where extname = 'pg_net' and schema_name = 'extensions'
  ) as pg_net_schema_matches,
  exists (
    select 1 from extension_state
    where extname = 'supabase_vault' and schema_name = 'vault'
  ) as vault_schema_matches,
  project_secret_state.secret_count as project_url_secret_count,
  project_secret_state.value_matches as project_url_secret_matches,
  worker_secret_state.secret_count as worker_secret_count,
  worker_secret_state.value_matches as worker_secret_matches,
  job_state.job_count,
  job_state.schedule_matches as job_schedule_matches,
  job_state.command_matches as job_command_matches,
  job_state.active as job_active,
  job_state.contains_no_embedded_url as job_contains_no_embedded_url,
  job_state.contains_no_project_url as job_contains_no_project_url,
  job_state.contains_no_worker_secret as job_contains_no_worker_secret
from project_secret_state
cross join worker_secret_state
cross join job_state;`;

const VERIFICATION_KEYS = Object.freeze([
  "job_active",
  "job_command_matches",
  "job_contains_no_embedded_url",
  "job_contains_no_project_url",
  "job_contains_no_worker_secret",
  "job_count",
  "job_schedule_matches",
  "pg_cron_schema_matches",
  "pg_net_schema_matches",
  "project_url_secret_count",
  "project_url_secret_matches",
  "vault_schema_matches",
  "worker_secret_count",
  "worker_secret_matches",
].sort());

function fail(message) {
  throw new Error(`Production profile-photo cleanup Cron configuration failed: ${message}`);
}

function requireAccessToken(accessToken) {
  if (
    typeof accessToken !== "string"
    || accessToken.length === 0
    || accessToken.length > 4096
    || accessToken !== accessToken.trim()
    || /[\u0000-\u001f\u007f]/u.test(accessToken)
  ) {
    fail("SUPABASE_ACCESS_TOKEN is missing or malformed");
  }
}

function requireProductionProjectRef(projectRef) {
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    fail("SUPABASE_PROJECT_REF does not identify the reviewed production project");
  }
}

function requireProductionProjectUrl(projectUrl, projectRef) {
  if (
    typeof projectUrl !== "string"
    || projectUrl.length === 0
    || projectUrl.length > 2048
    || projectUrl !== projectUrl.trim()
    || /[\u0000-\u001f\u007f]/u.test(projectUrl)
  ) {
    fail("VITE_SUPABASE_URL is missing or malformed");
  }

  let parsed;
  try {
    parsed = new URL(projectUrl);
  } catch {
    fail("VITE_SUPABASE_URL is missing or malformed");
  }

  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hostname !== `${projectRef}.supabase.co`
    || parsed.port !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    fail("VITE_SUPABASE_URL does not identify the reviewed production project origin");
  }
}

function requireWorkerSecret(workerSecret) {
  if (
    typeof workerSecret !== "string"
    || workerSecret.length < 32
    || workerSecret.length > 4096
    || workerSecret !== workerSecret.trim()
    || /[\u0000-\u001f\u007f]/u.test(workerSecret)
  ) {
    fail("PROFILE_PHOTO_WORKER_SECRET must be a valid secret of at least 32 characters");
  }
}

function requireFetch(fetchImplementation) {
  if (typeof fetchImplementation !== "function") {
    fail("a Fetch-compatible runtime is required");
  }
}

function requireSignalFactory(signalFactory) {
  if (typeof signalFactory !== "function") {
    fail("a request signal factory is required");
  }
}

function defaultSignalFactory() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function discardResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // Status is authoritative. Never inspect or log a credential-bearing body.
  }
}

async function runManagementQuery({
  accessToken,
  fetchImplementation,
  parameters,
  projectRef,
  query,
  readOnly,
  signalFactory,
  stage,
}) {
  let response;
  try {
    response = await fetchImplementation(
      `${MANAGEMENT_API_BASE_URL}/${encodeURIComponent(projectRef)}/database/query`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          parameters,
          read_only: readOnly,
        }),
        cache: "no-store",
        redirect: "error",
        signal: signalFactory(),
      },
    );
  } catch {
    fail(`${stage} Management API request failed`);
  }

  if (
    response?.status !== 201
    || response.redirected === true
  ) {
    const status = Number.isInteger(response?.status)
      ? ` (HTTP ${response.status})`
      : "";
    await discardResponseBody(response);
    fail(`${stage} Management API request was rejected${status}`);
  }

  try {
    return await response.json();
  } catch {
    fail(`${stage} Management API response was not valid JSON`);
  }
}

function isExactObject(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === keys.join("\u0000");
}

export function parseExtensionSetupResponse(value) {
  if (!Array.isArray(value) || value.length !== 0) {
    fail("extension setup returned an unexpected response shape");
  }
  return true;
}

export function parseConfigurationResponse(value) {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || !isExactObject(value[0], ["configured"])
    || value[0].configured !== true
  ) {
    fail("Vault or Cron setup returned an unexpected response shape");
  }
  return true;
}

export function parseVerificationResponse(value) {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || !isExactObject(value[0], VERIFICATION_KEYS)
  ) {
    fail("verification returned an unexpected response shape");
  }

  const result = value[0];
  for (const key of VERIFICATION_KEYS) {
    const expectedType = key.endsWith("_count") ? "number" : "boolean";
    if (typeof result[key] !== expectedType) {
      fail("verification returned an unexpected response shape");
    }
  }

  if (
    result.project_url_secret_count !== 1
    || result.worker_secret_count !== 1
    || result.job_count !== 1
    || VERIFICATION_KEYS.some((key) =>
      !key.endsWith("_count") && result[key] !== true
    )
  ) {
    fail("hosted Vault, extension, or Cron state did not match the fixed policy");
  }
  return true;
}

export async function configureProductionProfilePhotoCleanupCron({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  projectUrl = process.env.VITE_SUPABASE_URL,
  workerSecret = process.env.PROFILE_PHOTO_WORKER_SECRET,
  fetchImplementation = globalThis.fetch,
  signalFactory = defaultSignalFactory,
} = {}) {
  requireAccessToken(accessToken);
  requireProductionProjectRef(projectRef);
  requireProductionProjectUrl(projectUrl, projectRef);
  requireWorkerSecret(workerSecret);
  requireFetch(fetchImplementation);
  requireSignalFactory(signalFactory);

  const extensionResponse = await runManagementQuery({
    accessToken,
    fetchImplementation,
    parameters: [],
    projectRef,
    query: EXTENSION_SETUP_QUERY,
    readOnly: false,
    signalFactory,
    stage: "extension setup",
  });
  parseExtensionSetupResponse(extensionResponse);

  const protectedParameters = [projectUrl, workerSecret];
  const configurationResponse = await runManagementQuery({
    accessToken,
    fetchImplementation,
    parameters: protectedParameters,
    projectRef,
    query: CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY,
    readOnly: false,
    signalFactory,
    stage: "Vault and Cron setup",
  });
  parseConfigurationResponse(configurationResponse);

  const verificationResponse = await runManagementQuery({
    accessToken,
    fetchImplementation,
    parameters: protectedParameters,
    projectRef,
    query: VERIFY_PROFILE_PHOTO_CLEANUP_QUERY,
    // The Management API's read_only mode changes to a role that must not be
    // able to decrypt Vault. Keep the privileged connection, but constrain it
    // to this fixed, parameterized SELECT and validate its exact safe shape.
    readOnly: false,
    signalFactory,
    stage: "verification",
  });
  return parseVerificationResponse(verificationResponse);
}

async function main() {
  await configureProductionProfilePhotoCleanupCron();
  console.log(
    "Production profile-photo cleanup Vault values, extensions, and five-minute Cron policy are configured and verified.",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Production profile-photo cleanup Cron configuration failed.",
    );
    process.exitCode = 1;
  });
}
