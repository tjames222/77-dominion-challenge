#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  PRODUCTION_SUPABASE_PROJECT_REF,
  verifyProductionAuthCanary,
} from "./production-auth-canary-policy.mjs";
import { reconciledHistoryVersions } from "./verify-production-migration-cutover-plan.mjs";

const MANAGEMENT_API_BASE_URL = "https://api.supabase.com/v1/projects";
const REQUEST_TIMEOUT_MS = 30_000;
const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const RELEASE_SHA_SENTINEL = "__PRODUCTION_CANARY_RELEASE_SHA__";
const FORBIDDEN_NODE_ENVIRONMENT = Object.freeze([
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
]);

const exactReconciledHistorySql = reconciledHistoryVersions
  .map((version) => `'${version}'`)
  .join(", ");

const exactHistoryExpression = `(select coalesce(
    pg_catalog.array_agg(history.version::text order by history.version::text collate "C"),
    array[]::text[]
  )
  from supabase_migrations.schema_migrations history) =
  array[${exactReconciledHistorySql}]::text[]`;

export const grantPreflightQuery = `select
  ($1::text ~ '^[0-9a-f]{40}$') as release_sha_is_canonical,
  (${exactHistoryExpression}) as migration_history_matches,
  (select pg_catalog.count(*)::text
   from auth.users candidate
   where candidate.is_anonymous is false) as nonanonymous_user_count,
  (select pg_catalog.count(*)::text
   from auth.users candidate
   inner join public.profiles profile on profile.user_id = candidate.id
   where candidate.is_anonymous is false) as matching_profile_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active') as membership_count,
  (select pg_catalog.count(*)::text
   from public.billing_customers) as billing_customer_count,
  (select pg_catalog.count(*)::text
   from public.subscriptions) as subscription_count,
  pg_catalog.to_regclass('public.purchases')::text as legacy_purchases_table;`;

export const grantCanaryQuery = `do $production_canary$
declare
  target_user uuid;
  target_release constant text := '${RELEASE_SHA_SENTINEL}';
  nonanonymous_user_count bigint;
  matching_profile_count bigint;
  grant_start timestamptz := pg_catalog.statement_timestamp();
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.set_config('statement_timeout', '30s', true);
  perform pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('77-dominion:production-canary-entitlement', 0)
  );

  if target_release !~ '^[0-9a-f]{40}$' then
    raise exception 'The release SHA is not canonical.';
  end if;

  lock table supabase_migrations.schema_migrations in share mode;
  lock table auth.users in share mode;
  lock table public.profiles,
    public.entitlements,
    public.billing_customers,
    public.subscriptions
  in share row exclusive mode;

  if not (${exactHistoryExpression}) then
    raise exception 'The exact reconciled migration-13 history is required.';
  end if;

  select pg_catalog.count(*)
  into nonanonymous_user_count
  from auth.users candidate
  where candidate.is_anonymous is false;

  select pg_catalog.count(*)
  into matching_profile_count
  from auth.users candidate
  inner join public.profiles profile on profile.user_id = candidate.id
  where candidate.is_anonymous is false;

  if nonanonymous_user_count <> 1 or matching_profile_count <> 1 then
    raise exception 'Exactly one non-anonymous Auth user with a matching profile is required.';
  end if;

  select candidate.id
  into strict target_user
  from auth.users candidate
  inner join public.profiles profile on profile.user_id = candidate.id
  where candidate.is_anonymous is false
  for key share of candidate;

  if exists (
    select 1
    from public.entitlements entitlement
    where entitlement.entitlement_key = 'membership_active'
  ) then
    raise exception 'The closed canary requires zero existing membership entitlements.';
  end if;

  if exists (select 1 from public.billing_customers)
    or exists (select 1 from public.subscriptions) then
    raise exception 'The closed canary requires globally empty billing tables.';
  end if;

  if pg_catalog.to_regclass('public.purchases') is not null then
    raise exception 'The reconciled baseline must have removed public.purchases.';
  end if;

  insert into public.entitlements (
    user_id,
    entitlement_key,
    status,
    source_type,
    source_id,
    starts_at,
    ends_at,
    metadata
  ) values (
    target_user,
    'membership_active',
    'active',
    'production_canary',
    pg_catalog.gen_random_uuid()::text,
    grant_start,
    grant_start + interval '2 hours',
    pg_catalog.jsonb_build_object('release_sha', target_release)
  );
end
$production_canary$;`;

export const grantVerificationQuery = `select
  (${exactHistoryExpression}) as migration_history_matches,
  (select pg_catalog.count(*)::text
   from auth.users candidate
   where candidate.is_anonymous is false) as nonanonymous_user_count,
  (select pg_catalog.count(*)::text
   from auth.users candidate
   inner join public.profiles profile on profile.user_id = candidate.id
   where candidate.is_anonymous is false) as matching_profile_count,
  (select pg_catalog.count(*)::text
   from public.billing_customers) as billing_customer_count,
  (select pg_catalog.count(*)::text
   from public.subscriptions) as subscription_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active') as membership_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.status = 'active'
     and entitlement.starts_at <= pg_catalog.statement_timestamp()
     and entitlement.ends_at > pg_catalog.statement_timestamp()) as active_membership_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.source_type = 'production_canary') as production_canary_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.status = 'active'
     and entitlement.source_type = 'production_canary'
     and entitlement.source_id ~* '${UUID_PATTERN}'
     and entitlement.starts_at is not null
     and entitlement.ends_at is not null
     and entitlement.ends_at - entitlement.starts_at = interval '2 hours'
     and entitlement.starts_at <= pg_catalog.statement_timestamp()
     and entitlement.ends_at > pg_catalog.statement_timestamp()
     and entitlement.metadata = pg_catalog.jsonb_build_object('release_sha', $1::text)
     and exists (
       select 1
       from auth.users candidate
       inner join public.profiles profile on profile.user_id = candidate.id
       where candidate.id = entitlement.user_id
         and candidate.is_anonymous is false
     )) as matching_canary_count,
  pg_catalog.to_regclass('public.purchases')::text as legacy_purchases_table;`;

export const revokeCanaryQuery = `do $production_canary_revoke$
declare
  target_release constant text := '${RELEASE_SHA_SENTINEL}';
  matching_active_count bigint;
  total_active_canary_count bigint;
  changed_rows integer;
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.set_config('statement_timeout', '30s', true);
  perform pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('77-dominion:production-canary-entitlement', 0)
  );

  if target_release !~ '^[0-9a-f]{40}$' then
    raise exception 'The release SHA is not canonical.';
  end if;

  lock table public.entitlements in share row exclusive mode;

  select pg_catalog.count(*)
  into matching_active_count
  from public.entitlements entitlement
  where entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and entitlement.source_type = 'production_canary'
    and entitlement.source_id ~* '${UUID_PATTERN}'
    and entitlement.metadata ->> 'release_sha' = target_release;

  select pg_catalog.count(*)
  into total_active_canary_count
  from public.entitlements entitlement
  where entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and entitlement.source_type = 'production_canary';

  if matching_active_count <> 1 or total_active_canary_count <> 1 then
    raise exception 'Expected one sole active production canary for this release.';
  end if;

  update public.entitlements entitlement
  set
    status = 'revoked',
    ends_at = least(
      coalesce(entitlement.ends_at, pg_catalog.clock_timestamp()),
      pg_catalog.clock_timestamp()
    ),
    updated_at = pg_catalog.clock_timestamp()
  where entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and entitlement.source_type = 'production_canary'
    and entitlement.source_id ~* '${UUID_PATTERN}'
    and entitlement.metadata ->> 'release_sha' = target_release;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception 'Expected exactly one production canary entitlement to revoke.';
  end if;
end
$production_canary_revoke$;`;

export const revokeVerificationQuery = `select
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.source_type = 'production_canary') as production_canary_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.status = 'active'
     and entitlement.source_type = 'production_canary') as active_production_canary_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.status = 'revoked'
     and entitlement.source_type = 'production_canary'
     and entitlement.source_id ~* '${UUID_PATTERN}'
     and entitlement.ends_at is not null
     and entitlement.ends_at <= pg_catalog.statement_timestamp()
     and entitlement.metadata ->> 'release_sha' = $1::text) as matching_revoked_count;`;

function fail(message) {
  throw new Error(`Production canary entitlement operation is invalid: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactShape(value, expectedKeys, label) {
  if (!Array.isArray(value) || value.length !== 1) {
    fail(`${label} must return exactly one aggregate row`);
  }
  const row = value[0];
  if (
    !isPlainObject(row)
    || Object.keys(row).sort().join("\n") !== [...expectedKeys].sort().join("\n")
  ) {
    fail(`${label} returned an unexpected aggregate shape`);
  }
  return row;
}

export function verifyGrantPreflightResponse(value) {
  const row = requireExactShape(value, [
    "billing_customer_count",
    "legacy_purchases_table",
    "matching_profile_count",
    "membership_count",
    "migration_history_matches",
    "nonanonymous_user_count",
    "release_sha_is_canonical",
    "subscription_count",
  ], "the grant preflight");
  if (row.release_sha_is_canonical !== true) {
    fail("the release SHA is not canonical");
  }
  if (row.migration_history_matches !== true) {
    fail("the exact reconciled migration-13 history is required before grant");
  }
  if (
    row.nonanonymous_user_count !== "1"
    || row.matching_profile_count !== "1"
  ) {
    fail("exactly one non-anonymous Auth user with a matching profile is required");
  }
  if (row.membership_count !== "0") {
    fail("the closed canary requires zero existing membership entitlements");
  }
  if (
    row.billing_customer_count !== "0"
    || row.subscription_count !== "0"
  ) {
    fail("the closed canary requires globally empty billing tables");
  }
  if (row.legacy_purchases_table !== null) {
    fail("the reconciled baseline must have removed public.purchases");
  }
  return true;
}

export function verifyGrantResponse(value) {
  const row = requireExactShape(value, [
    "active_membership_count",
    "billing_customer_count",
    "legacy_purchases_table",
    "matching_canary_count",
    "matching_profile_count",
    "membership_count",
    "migration_history_matches",
    "nonanonymous_user_count",
    "production_canary_count",
    "subscription_count",
  ], "the grant verification");
  if (
    row.migration_history_matches !== true
    || row.nonanonymous_user_count !== "1"
    || row.matching_profile_count !== "1"
    || row.membership_count !== "1"
    || row.active_membership_count !== "1"
    || row.production_canary_count !== "1"
    || row.matching_canary_count !== "1"
    || row.billing_customer_count !== "0"
    || row.subscription_count !== "0"
    || row.legacy_purchases_table !== null
  ) {
    fail("the exact bounded grant or closed-canary production state was not verified");
  }
  return true;
}

export function verifyRevokeResponse(value) {
  const row = requireExactShape(value, [
    "active_production_canary_count",
    "matching_revoked_count",
    "production_canary_count",
  ], "the revoke verification");
  if (
    row.production_canary_count !== "1"
    || row.active_production_canary_count !== "0"
    || row.matching_revoked_count !== "1"
  ) {
    fail("the exact release-bound canary was not preserved as one revoked audit row");
  }
  return true;
}

function validateInputs({
  accessToken,
  authVerifier,
  environment,
  fetchImpl,
  operation,
  projectRef,
  releaseSha,
  signalFactory,
}) {
  if (!['grant', 'revoke'].includes(operation)) {
    fail("PRODUCTION_CANARY_OPERATION must be exactly grant or revoke");
  }
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    fail("SUPABASE_PROJECT_REF must identify the reviewed production project");
  }
  if (
    typeof accessToken !== "string"
    || accessToken.length === 0
    || accessToken !== accessToken.trim()
    || /[\u0000-\u001f\u007f]/u.test(accessToken)
  ) {
    fail("SUPABASE_ACCESS_TOKEN is missing or malformed");
  }
  if (typeof releaseSha !== "string" || !/^[0-9a-f]{40}$/u.test(releaseSha)) {
    fail("GITHUB_SHA must be exactly 40 lowercase hexadecimal characters");
  }
  if (
    typeof fetchImpl !== "function"
    || typeof signalFactory !== "function"
    || typeof authVerifier !== "function"
  ) {
    fail("Fetch, timeout, and Auth-verification implementations are required");
  }
  for (const name of FORBIDDEN_NODE_ENVIRONMENT) {
    if (typeof environment?.[name] === "string" && environment[name].length > 0) {
      fail(`${name} must be unset`);
    }
  }
}

function defaultSignalFactory() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function discardResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // Status and exact aggregate checks are authoritative. Never inspect a body.
  }
}

async function runManagementQuery({
  accessToken,
  fetchImpl,
  projectRef,
  query,
  readOnly,
  releaseSha,
  signalFactory,
}) {
  const endpoint = readOnly ? "/database/query/read-only" : "/database/query";
  let boundQuery = query;
  let parameters = [releaseSha];
  if (!readOnly) {
    const sentinelCount = query.split(RELEASE_SHA_SENTINEL).length - 1;
    if (sentinelCount !== 1) {
      fail("the fixed write query does not have one release binding");
    }
    boundQuery = query.replace(RELEASE_SHA_SENTINEL, releaseSha);
    parameters = [];
  }
  let response;
  try {
    response = await fetchImpl(
      `${MANAGEMENT_API_BASE_URL}/${projectRef}${endpoint}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: boundQuery, parameters }),
        cache: "no-store",
        redirect: "error",
        signal: signalFactory(),
      },
    );
  } catch {
    fail(`${readOnly ? "read-only verification" : "write"} request failed`);
  }
  if (
    response?.redirected === true
    || (response?.status >= 300 && response?.status < 400)
  ) {
    await discardResponseBody(response);
    fail(`${readOnly ? "read-only verification" : "write"} returned a redirect`);
  }
  if (response?.status !== 201) {
    const status = Number.isInteger(response?.status) ? ` HTTP ${response.status}` : "";
    await discardResponseBody(response);
    fail(`${readOnly ? "read-only verification" : "write"} returned${status}`);
  }
  if (!readOnly) {
    await discardResponseBody(response);
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    fail("read-only verification did not return JSON");
  }
}

export async function manageProductionCanaryEntitlement({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  authVerifier = verifyProductionAuthCanary,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  operation = process.env.PRODUCTION_CANARY_OPERATION,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  releaseSha = process.env.GITHUB_SHA,
  signalFactory = defaultSignalFactory,
} = {}) {
  validateInputs({
    accessToken,
    authVerifier,
    environment,
    fetchImpl,
    operation,
    projectRef,
    releaseSha,
    signalFactory,
  });

  const request = (query, readOnly) => runManagementQuery({
    accessToken,
    fetchImpl,
    projectRef,
    query,
    readOnly,
    releaseSha,
    signalFactory,
  });

  if (operation === "grant") {
    await authVerifier({
      accessToken,
      fetchImpl,
      projectRef,
      signalFactory,
    });
    verifyGrantPreflightResponse(await request(grantPreflightQuery, true));
    await request(grantCanaryQuery, false);
    verifyGrantResponse(await request(grantVerificationQuery, true));
    return { operation: "grant", verified: true };
  }

  await request(revokeCanaryQuery, false);
  verifyRevokeResponse(await request(revokeVerificationQuery, true));
  return { operation: "revoke", verified: true };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  if (process.argv.length !== 2) {
    console.error(
      "Production canary entitlement operation is invalid: command-line arguments are not accepted.",
    );
    process.exitCode = 1;
  } else {
    manageProductionCanaryEntitlement()
      .then(({ operation }) => {
        console.log(
          operation === "grant"
            ? "Verified one bounded production canary entitlement for this release."
            : "Verified production canary revocation and preserved its audit row.",
        );
      })
      .catch((error) => {
        console.error(
          error instanceof Error
            ? error.message
            : "Production canary entitlement operation failed.",
        );
        process.exitCode = 1;
      });
  }
}
