import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runReadOnlyManagementQuery } from "./verify-production-raw-migration-history.mjs";

const attestationVersion = 1;
const attestationDomain = "production-compatibility-cutover-canary-v1";

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
  (select pg_catalog.encode(
     extensions.digest(
       pg_catalog.convert_to(
         pg_catalog.jsonb_build_array(
           entitlement.user_id::text,
           entitlement.entitlement_key,
           entitlement.status,
           entitlement.source_type,
           entitlement.source_id,
           pg_catalog.to_char(
             entitlement.starts_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'
           ),
           pg_catalog.to_char(
             entitlement.ends_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'
           ),
           entitlement.metadata,
           pg_catalog.to_char(
             entitlement.created_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'
           ),
           pg_catalog.to_char(
             entitlement.updated_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'
           )
         )::text,
         'UTF8'
       ),
       'sha256'
     ),
     'hex'
   )
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
     )) as canary_grant_fingerprint,
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
    "canary_grant_fingerprint",
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
  if (!/^[0-9a-f]{64}$/u.test(row.canary_grant_fingerprint)) {
    fail("the exact canary grant fingerprint must be one SHA-256 digest");
  }
  return {
    verified: true,
    grantFingerprint: row.canary_grant_fingerprint,
  };
}

function canaryAttestationHmac({ releaseSha, grantFingerprint, attestationKey }) {
  return createHmac("sha256", attestationKey)
    .update(`${attestationDomain}\0${releaseSha}\0${grantFingerprint}`, "utf8")
    .digest("hex");
}

export function createCanaryCutoverAttestation({
  releaseSha,
  grantFingerprint,
  attestationKey,
}) {
  if (typeof releaseSha !== "string" || !/^[0-9a-f]{40}$/u.test(releaseSha)) {
    fail("the attestation release SHA must be exactly 40 lowercase hexadecimal characters");
  }
  if (
    typeof grantFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(grantFingerprint)
  ) {
    fail("the attestation canary fingerprint must be one SHA-256 digest");
  }
  if (typeof attestationKey !== "string" || attestationKey.length < 20) {
    fail("the attestation key must be a nonempty protected credential");
  }
  return {
    version: attestationVersion,
    releaseSha,
    grantHmacSha256: canaryAttestationHmac({
      releaseSha,
      grantFingerprint,
      attestationKey,
    }),
  };
}

export function verifyCanaryCutoverAttestation({
  value,
  releaseSha,
  grantFingerprint,
  attestationKey,
}) {
  const expectedKeys = ["grantHmacSha256", "releaseSha", "version"];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== expectedKeys.join("\n")
    || value.version !== attestationVersion
    || value.releaseSha !== releaseSha
    || !/^[0-9a-f]{64}$/u.test(value.grantHmacSha256)
  ) {
    fail("the compatibility attestation has an invalid envelope");
  }
  const expected = createCanaryCutoverAttestation({
    releaseSha,
    grantFingerprint,
    attestationKey,
  });
  if (!timingSafeEqual(
    Buffer.from(value.grantHmacSha256, "hex"),
    Buffer.from(expected.grantHmacSha256, "hex"),
  )) {
    fail("the exact canary grant does not match the compatibility attestation");
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
  if (
    (argumentsList.length !== 2 && argumentsList.length !== 4)
    || argumentsList[0] !== "--release-sha"
    || (
      argumentsList.length === 4
      && !["--attestation-input", "--attestation-output"].includes(argumentsList[2])
    )
  ) {
    fail(
      "Usage: verify-production-canary-cutover-gate.mjs --release-sha <40hex> [--attestation-input <path> | --attestation-output <path>]",
    );
  }
  return {
    releaseSha: argumentsList[1],
    attestationMode: argumentsList[2],
    attestationPath: argumentsList[3],
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await verifyProductionCanaryCutoverGate({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    releaseSha: options.releaseSha,
  });
  if (options.attestationMode === "--attestation-output") {
    const attestation = createCanaryCutoverAttestation({
      releaseSha: options.releaseSha,
      grantFingerprint: result.grantFingerprint,
      attestationKey: process.env.SUPABASE_ACCESS_TOKEN,
    });
    await writeFile(options.attestationPath, `${JSON.stringify(attestation)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else if (options.attestationMode === "--attestation-input") {
    let attestation;
    try {
      attestation = JSON.parse(await readFile(options.attestationPath, "utf8"));
    } catch {
      fail("the compatibility attestation is not one readable JSON envelope");
    }
    verifyCanaryCutoverAttestation({
      value: attestation,
      releaseSha: options.releaseSha,
      grantFingerprint: result.grantFingerprint,
      attestationKey: process.env.SUPABASE_ACCESS_TOKEN,
    });
  }
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
