import { pathToFileURL } from "node:url";
import { runReadOnlyManagementQuery } from "./verify-production-raw-migration-history.mjs";

export const canaryCutoverGateQuery = `select
  (select pg_catalog.count(*)::text
   from public.billing_customers) as billing_customer_count,
  (select pg_catalog.count(*)::text
   from public.subscriptions) as subscription_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active')
    as membership_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.source_type = 'production_canary')
    as production_canary_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.status = 'active'
     and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.statement_timestamp())
     and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.statement_timestamp()))
    as active_membership_count,
  (select pg_catalog.count(*)::text
   from public.entitlements entitlement
   where entitlement.entitlement_key = 'membership_active'
     and entitlement.status = 'active'
     and entitlement.source_type = 'production_canary'
     and entitlement.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and entitlement.starts_at is not null
     and entitlement.ends_at is not null
     and entitlement.ends_at > entitlement.starts_at
     and entitlement.ends_at - entitlement.starts_at <= interval '2 hours'
     and entitlement.starts_at <= pg_catalog.statement_timestamp()
     and entitlement.ends_at > pg_catalog.statement_timestamp()
     and entitlement.metadata ->> 'release_sha' = $1
     and exists (
       select 1
       from auth.users canary_user
       where canary_user.id = entitlement.user_id
         and canary_user.is_anonymous is false
     ))
    as matching_canary_count,
  pg_catalog.to_regclass('public.purchases')::text as legacy_purchases_table;`;

function fail(message) {
  throw new Error(`Production canary cutover gate is invalid: ${message}`);
}

export function verifyCanaryCutoverGateResponse(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    fail("the read-only inventory must return exactly one aggregate row");
  }
  const row = value[0];
  const expectedKeys = [
    "active_membership_count",
    "billing_customer_count",
    "legacy_purchases_table",
    "matching_canary_count",
    "membership_count",
    "production_canary_count",
    "subscription_count",
  ];
  if (
    !row
    || typeof row !== "object"
    || Array.isArray(row)
    || Object.keys(row).sort().join("\n") !== expectedKeys.join("\n")
  ) {
    fail("the read-only inventory returned an unexpected aggregate shape");
  }
  if (row.billing_customer_count !== "0" || row.subscription_count !== "0") {
    fail("billing_customers and subscriptions must both be globally empty");
  }
  if (row.legacy_purchases_table !== null) {
    fail("the reconciled baseline must have removed public.purchases");
  }
  if (
    row.membership_count !== "1"
    || row.production_canary_count !== "1"
    || row.active_membership_count !== "1"
    || row.matching_canary_count !== "1"
  ) {
    fail(
      "exactly one active membership must be the bounded production_canary grant for this release",
    );
  }
  return { verified: true };
}

export async function verifyProductionCanaryCutoverGate({
  projectRef,
  accessToken,
  releaseSha,
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof releaseSha !== "string" || !/^[0-9a-f]{40}$/u.test(releaseSha)) {
    fail("the release SHA must be exactly 40 lowercase hexadecimal characters");
  }
  const response = await runReadOnlyManagementQuery({
    projectRef,
    accessToken,
    query: canaryCutoverGateQuery,
    parameters: [releaseSha],
    fetchImplementation,
  });
  return verifyCanaryCutoverGateResponse(response);
}

function parseArguments(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--release-sha") {
    fail("Usage: verify-production-canary-cutover-gate.mjs --release-sha <40hex>");
  }
  return { releaseSha: argumentsList[1] };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await verifyProductionCanaryCutoverGate({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    releaseSha: options.releaseSha,
  });
  console.log(
    "Verified one bounded release-bound production canary entitlement and globally empty billing state.",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Production canary cutover gate verification failed.",
    );
    process.exitCode = 1;
  });
}
