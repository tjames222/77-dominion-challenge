#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseManifestText } from "./compare-database-manifests.mjs";
import { runReadOnlyManagementQuery } from "./verify-production-raw-migration-history.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const contractQueryPath = path.join(
  scriptDirectory,
  "existing-supabase-post13-contract.sql",
);
const targetManifestPath = path.join(
  repositoryRoot,
  "supabase",
  "tests",
  "reconciliation",
  "migration-13.target.manifest.jsonl",
);

export const EXISTING_SUPABASE_PROJECT_REF = "mimolwojppbtsbvtqwpo";
export const TARGET_MANIFEST_SHA256 =
  "82774858454fa27646fd3e1f430e056a9be16f196cdc59c6e48a6e124f6e86a5";
export const TARGET_MANIFEST_RECORD_COUNT = 1489;
export const POST13_CONTRACT_RECORD_COUNT = 1529;

const ordinaryManifestKinds = new Set([
  "badge",
  "column",
  "constraint",
  "extension",
  "function",
  "index",
  "policy",
  "relation",
  "schema",
  "storage-bucket",
  "trigger",
]);
const applicationDirectAclKinds = new Set([
  "column-acl",
  "function-acl",
  "relation-acl",
  "schema-acl",
]);
const applicationEffectiveAclKinds = new Set([
  "column",
  "function",
  "relation",
  "schema",
  "sequence",
]);

const expectedKindCounts = Object.freeze({
  badge: 30,
  column: 184,
  constraint: 84,
  "direct-acl": 303,
  "effective-acl": 702,
  extension: 1,
  function: 27,
  index: 56,
  policy: 58,
  relation: 22,
  schema: 1,
  "storage-bucket": 3,
  trigger: 18,
});

const expectedOperationalRowCounts = Object.freeze({
  "auth.users": 1,
  "public.billing_customers": 0,
  "public.challenge_entries": 0,
  "public.check_ins": 0,
  "public.community_feed_items": 0,
  "public.community_posts": 0,
  "public.crew_invites": 0,
  "public.crew_members": 0,
  "public.crews": 0,
  "public.entitlements": 0,
  "public.game_point_events": 0,
  "public.journal_entries": 0,
  "public.journal_photos": 0,
  "public.post_comments": 0,
  "public.post_likes": 0,
  "public.profiles": 1,
  "public.subscriptions": 0,
  "public.user_badges": 0,
  "public.user_challenge_states": 0,
  "public.user_game_stats": 0,
  "storage.buckets_analytics": 0,
  "storage.buckets_vectors": 0,
  "storage.objects": 0,
  "storage.s3_multipart_uploads": 0,
  "storage.s3_multipart_uploads_parts": 0,
  "storage.vector_indexes": 0,
});

const hostedPlatformSchemaUsageRoles = Object.freeze([
  "anon",
  "authenticated",
  "postgres",
  "service_role",
]);

// Hosted Supabase adds these exact schema grants through pg_database_owner.
// They are not emitted by the disposable local stack used to pin the migration
// target, so model them explicitly instead of broadly ignoring hosted ACLs.
const hostedPlatformRecords = Object.freeze(
  hostedPlatformSchemaUsageRoles.map((role) => Object.freeze({
    key: `direct-acl/schema-acl/public/pg_database_owner/${role}/USAGE`,
    kind: "direct-acl",
    identity: "public",
    definition: Object.freeze({
      grantee: role,
      grantor: "pg_database_owner",
      grantable: false,
      privilege: "USAGE",
      objectKind: "schema-acl",
    }),
  })),
);

const deterministicConfigurationRecords = Object.freeze([
  {
    key: "entitlement-summary/membership_active",
    kind: "entitlement-summary",
    identity: "membership_active",
    definition: {
      rowCount: 0,
      membershipActiveCount: 0,
      currentlyEffectiveCount: 0,
      unexpectedEntitlementKeyCount: 0,
    },
  },
  {
    key: "workout-config/easy",
    kind: "workout-config",
    identity: "easy",
    definition: { points: 2 },
  },
  {
    key: "workout-config/extreme",
    kind: "workout-config",
    identity: "extreme",
    definition: { points: 15 },
  },
  {
    key: "workout-config/hard",
    kind: "workout-config",
    identity: "hard",
    definition: { points: 10 },
  },
  {
    key: "workout-config/medium",
    kind: "workout-config",
    identity: "medium",
    definition: { points: 5 },
  },
  {
    key: "challenge-definition/bible_in_a_year",
    kind: "challenge-definition",
    identity: "bible_in_a_year",
    definition: {
      title: "Bible in a Year",
      teaser: "Carry the reading discipline into a complete yearlong plan.",
      challengeType: "bible",
      pointsRequired: 10000,
      durationDays: 365,
      entitlementKey: "membership_active",
      icon: "book",
      sortOrder: 50,
      isActive: true,
      metadata: {},
    },
  },
  {
    key: "challenge-definition/forty_day_fast",
    kind: "challenge-definition",
    identity: "forty_day_fast",
    definition: {
      title: "40-Day Fasting & Prayer Track",
      teaser: "Build a guided rhythm of fasting, prayer, and disciplined reflection.",
      challengeType: "fasting",
      pointsRequired: 6000,
      durationDays: 40,
      entitlementKey: "membership_active",
      icon: "flame",
      sortOrder: 40,
      isActive: true,
      metadata: {},
    },
  },
  {
    key: "challenge-definition/seven_day_reset",
    kind: "challenge-definition",
    identity: "seven_day_reset",
    definition: {
      title: "7-Day Reset",
      teaser: "A focused week to rebuild rhythm and recover momentum.",
      challengeType: "reset",
      pointsRequired: 1000,
      durationDays: 7,
      entitlementKey: "membership_active",
      icon: "repeat",
      sortOrder: 10,
      isActive: true,
      metadata: {},
    },
  },
  {
    key: "challenge-definition/thirty_day_strength",
    kind: "challenge-definition",
    identity: "thirty_day_strength",
    definition: {
      title: "30-Day Strength Intensive",
      teaser: "Turn consistency into a focused month of physical training.",
      challengeType: "physical",
      pointsRequired: 4500,
      durationDays: 30,
      entitlementKey: "membership_active",
      icon: "dumbbell",
      sortOrder: 30,
      isActive: true,
      metadata: {},
    },
  },
  {
    key: "challenge-definition/twenty_one_day_prayer",
    kind: "challenge-definition",
    identity: "twenty_one_day_prayer",
    definition: {
      title: "21-Day Prayer Track",
      teaser: "Deepen the daily prayer habit with a guided three-week track.",
      challengeType: "spiritual",
      pointsRequired: 3000,
      durationDays: 21,
      entitlementKey: "membership_active",
      icon: "spark",
      sortOrder: 20,
      isActive: true,
      metadata: {},
    },
  },
  ...Object.entries(expectedOperationalRowCounts).map(([identity, rowCount]) => ({
    key: `row-count/${identity}`,
    kind: "row-count",
    identity,
    definition: { rowCount },
  })),
]);

function fail(message) {
  throw new Error(`Existing-project migration-13 effect is invalid: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isApplicationIdentity(identity) {
  return identity === "public" || identity.startsWith("public.");
}

export function isPost13TargetRecord(record) {
  if (ordinaryManifestKinds.has(record.kind)) return true;
  if (record.kind === "direct-acl") {
    return applicationDirectAclKinds.has(record.definition.objectKind)
      && !record.identity.startsWith("public.rls_auto_enable(");
  }
  if (record.kind === "effective-acl") {
    return applicationEffectiveAclKinds.has(record.definition.objectKind)
      && isApplicationIdentity(record.identity)
      && !record.identity.startsWith("public.rls_auto_enable(");
  }
  return false;
}

function requireExactKindCounts(records) {
  const actual = {};
  for (const record of records) {
    actual[record.kind] = (actual[record.kind] ?? 0) + 1;
  }
  const expectedEntries = Object.entries(expectedKindCounts).sort(([left], [right]) =>
    left.localeCompare(right, "en")
  );
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right, "en")
  );
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    fail("the pinned target manifest does not have the exact reviewed record inventory");
  }
}

export function buildPost13Contract(manifestContents) {
  if (typeof manifestContents !== "string") {
    fail("the pinned target manifest is missing");
  }
  if (sha256(manifestContents) !== TARGET_MANIFEST_SHA256) {
    fail("the pinned target manifest SHA-256 does not match the reviewed migration-13 target");
  }

  const manifest = parseManifestText(manifestContents, targetManifestPath);
  const records = [...manifest.values()].filter(isPost13TargetRecord);
  if (records.length !== TARGET_MANIFEST_RECORD_COUNT) {
    fail("the pinned target manifest record count is not the reviewed migration-13 count");
  }
  requireExactKindCounts(records);

  const contract = [
    ...records,
    ...hostedPlatformRecords,
    ...deterministicConfigurationRecords,
  ]
    .sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
  if (contract.length !== POST13_CONTRACT_RECORD_COUNT) {
    fail("the assembled post-migration-13 contract has an unexpected record count");
  }
  for (let index = 1; index < contract.length; index += 1) {
    if (contract[index - 1].key === contract[index].key) {
      fail(`the assembled post-migration-13 contract repeats ${contract[index].key}`);
    }
  }
  return contract;
}

function stripSqlCommentsAndLiterals(sql) {
  return sql
    .replaceAll(/--[^\n]*(?:\n|$)/gu, "\n")
    .replaceAll(/'(?:''|[^'])*'/gu, "''");
}

export function verifyReadOnlyContractQuery(query) {
  if (typeof query !== "string" || !query.trim()) {
    fail("the post-migration-13 contract query is missing");
  }
  const stripped = stripSqlCommentsAndLiterals(query).trim();
  if (!stripped.startsWith("with\n") || !stripped.endsWith(";")) {
    fail("the contract query must be one WITH ... SELECT statement");
  }
  if ((stripped.match(/;/gu) ?? []).length !== 1) {
    fail("the contract query must contain exactly one SQL statement");
  }
  if (!stripped.includes("pg_catalog.jsonb_array_elements($1::jsonb)")) {
    fail("the contract query must bind the reviewed contract as JSONB parameter $1");
  }
  const deparseSearchPathPin = "pg_catalog.set_config(\n"
    + "    'search_path',\n"
    + "    'public, extensions',\n"
    + "    true\n"
    + "  )";
  if (query.split(deparseSearchPathPin).length - 1 !== 1) {
    fail("the contract query must pin the exact canonical deparse search_path once");
  }
  if (query.split("cross join canonical_deparse_context").length - 1 !== 7) {
    fail("every search_path-sensitive catalog deparser must depend on the canonical context");
  }
  if (query.split("namespace.nspname::text as identity").length - 1 !== 1) {
    fail("the catalog identity union must be pinned to unbounded text");
  }
  const deparseCalls = query.match(
    /pg_catalog\.(?:format_type|pg_get_expr|pg_get_constraintdef|pg_get_indexdef|pg_get_function_identity_arguments|pg_get_function_arguments|pg_get_function_result|pg_get_triggerdef)\s*\(/gu,
  ) ?? [];
  const guardedDeparseCalls = query.match(
    /then\s+pg_catalog\.(?:format_type|pg_get_expr|pg_get_constraintdef|pg_get_indexdef|pg_get_function_identity_arguments|pg_get_function_arguments|pg_get_function_result|pg_get_triggerdef)\s*\(/gu,
  ) ?? [];
  if (deparseCalls.length !== 17 || guardedDeparseCalls.length !== deparseCalls.length) {
    fail("all 17 catalog deparsers must be CASE-ordered after the canonical search_path pin");
  }
  if (
    /\b(?:alter|call|copy|create|delete|do|drop|execute|grant|insert|merge|revoke|truncate|update)\b/iu
      .test(stripped)
  ) {
    fail("the contract query contains a mutating SQL operation");
  }
  return query;
}

const responseKeys = Object.freeze([
  "actual_count",
  "actual_duplicate_key_count",
  "changed_count",
  "contract_matches",
  "expected_count",
  "expected_duplicate_key_count",
  "missing_count",
  "unexpected_count",
]);

export function parsePost13ContractResponse(value) {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || !value[0]
    || Array.isArray(value[0])
    || typeof value[0] !== "object"
    || JSON.stringify(Object.keys(value[0]).sort()) !== JSON.stringify(responseKeys)
  ) {
    fail("the read-only contract response is malformed");
  }
  const result = value[0];
  for (const key of responseKeys.filter((key) => key !== "contract_matches")) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) {
      fail(`the read-only contract response ${key} is not a nonnegative integer`);
    }
  }
  if (typeof result.contract_matches !== "boolean") {
    fail("the read-only contract response contract_matches is not boolean");
  }
  if (result.expected_count !== POST13_CONTRACT_RECORD_COUNT) {
    fail("the database did not receive the exact reviewed contract record count");
  }
  if (
    !result.contract_matches
    || result.actual_count !== POST13_CONTRACT_RECORD_COUNT
    || result.expected_duplicate_key_count !== 0
    || result.actual_duplicate_key_count !== 0
    || result.missing_count !== 0
    || result.unexpected_count !== 0
    || result.changed_count !== 0
  ) {
    fail(
      "the read-only catalog contract differs "
      + `(actual=${result.actual_count}, missing=${result.missing_count}, `
      + `unexpected=${result.unexpected_count}, changed=${result.changed_count}, `
      + `expectedDuplicateKeys=${result.expected_duplicate_key_count}, `
      + `actualDuplicateKeys=${result.actual_duplicate_key_count})`,
    );
  }
  return result;
}

export async function verifyPost13Effect({
  accessToken,
  fetchImplementation = globalThis.fetch,
  projectRef,
} = {}) {
  if (projectRef !== EXISTING_SUPABASE_PROJECT_REF) {
    fail(`project ref must be exactly ${EXISTING_SUPABASE_PROJECT_REF}`);
  }
  const [manifestContents, queryContents] = await Promise.all([
    readFile(targetManifestPath, "utf8"),
    readFile(contractQueryPath, "utf8"),
  ]);
  const contract = buildPost13Contract(manifestContents);
  const query = verifyReadOnlyContractQuery(queryContents);
  const response = await runReadOnlyManagementQuery({
    projectRef,
    accessToken,
    query,
    parameters: [JSON.stringify(contract)],
    fetchImplementation,
  });
  return parsePost13ContractResponse(response);
}

async function main() {
  const result = await verifyPost13Effect({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
  });
  console.log(
    `Verified ${result.actual_count} exact migration-13 schema, policy, privilege, and deterministic configuration records.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Existing-project migration-13 effect verification failed.",
    );
    process.exitCode = 1;
  });
}
