import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROJECT_REF } from './production-backup-public-contract.mjs';
import { authoritativeMigrationHistoryQuery, parseRawMigrationHistoryResponse,
  runReadOnlyManagementQuery } from './verify-production-raw-migration-history.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  REPEATABLE_CHALLENGE_MIGRATION_VERSION, verifyRepeatableChallengeCutoverPlan,
  verifyRepeatableChallengeMigrationSource } from './verify-repeatable-challenge-cutover-plan.mjs';
import { verifyPost71ReleasePlan, verifyPost71ReleaseSources } from './verify-post71-release-plan.mjs';

const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
const repeatableChallengeMigration = new URL(
  `../supabase/migrations/${REPEATABLE_CHALLENGE_MIGRATION_FILENAME}`,
  import.meta.url,
);
const allowedScopes = new Set(['repeatable-challenge-cutover', 'full', 'frontend-only', 'compatibility-cutover']);
const fail = message => { throw new Error(`Production repeatable challenge release policy failed: ${message}`); };

/** A bounded, non-secret receipt is the only boundary passed between jobs. */
export function productionReleaseBoundaryReceipt(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('release boundary receipt is invalid');
  const legacy = ['repeatable-challenge-cutover', 'post-repeatable-challenge-cutover'].includes(result.mode);
  const allowedKeys = ['mode', 'requiresExact70Backup', 'migrationVersion', ...(legacy && !Object.hasOwn(result, 'requiresExact71Backup') ? [] : ['requiresExact71Backup'])].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(allowedKeys)) fail('release boundary receipt is invalid');
  const receipt = Object.freeze({ mode: result.mode, requiresExact70Backup: result.requiresExact70Backup,
    requiresExact71Backup: legacy && !Object.hasOwn(result, 'requiresExact71Backup') ? false : result.requiresExact71Backup,
    migrationVersion: result.migrationVersion });
  const boundaries = {
    'repeatable-challenge-cutover': [true, false, REPEATABLE_CHALLENGE_MIGRATION_VERSION],
    'post-repeatable-challenge-cutover': [false, false, REPEATABLE_CHALLENGE_MIGRATION_VERSION],
    'post71-additive-release': [false, true, '20261007060519'],
    'post73-reviewed-release': [false, false, '20261007060519'],
  };
  const expected = Object.hasOwn(boundaries, receipt.mode) && boundaries[receipt.mode];
  if (!expected || receipt.requiresExact70Backup !== expected[0] || receipt.requiresExact71Backup !== expected[1]
    || receipt.migrationVersion !== expected[2]) fail('release boundary receipt is invalid');
  return receipt;
}

export function parseExpectedProductionReleaseBoundary(value) {
  if (typeof value !== 'string' || value.length > 512) fail('expected release boundary receipt is invalid');
  let receipt;
  try { receipt = productionReleaseBoundaryReceipt(JSON.parse(value)); }
  catch { fail('expected release boundary receipt is invalid'); }
  if (JSON.stringify(receipt) !== value) fail('expected release boundary receipt is invalid');
  return receipt;
}

export function verifyUnchangedProductionReleaseBoundary({ expectedReceipt, actual } = {}) {
  const expected = parseExpectedProductionReleaseBoundary(expectedReceipt);
  const receipt = productionReleaseBoundaryReceipt(actual);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) fail('production migration boundary changed after the approved backup gate');
  return receipt;
}

export function verifyProductionRepeatableCutoverPolicy({
  releaseScope,
  rawResponse,
  migrationFilenames,
  migrationSourceSha256,
  migrationSourceHashes,
  reviewedMigrationSha256 = REPEATABLE_CHALLENGE_MIGRATION_SHA256,
} = {}) {
  if (!allowedScopes.has(releaseScope)) fail('release scope is invalid');
  if (!Array.isArray(migrationFilenames)) fail('local migration inventory is missing');
  let remote;
  try { remote = parseRawMigrationHistoryResponse(rawResponse); }
  catch { fail('authoritative migration history is invalid'); }
  if (migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).length > 71) {
    return verifyPost71ReleasePlan({ releaseScope, remote, migrationFilenames, migrationSourceHashes });
  }
  const local = migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort()
    .map(name => name.slice(0, 14));
  let plan;
  try {
    plan = verifyRepeatableChallengeCutoverPlan({
      local,
      remote,
      migrationFilenames,
      migrationSourceSha256,
      reviewedMigrationSha256,
    });
  }
  catch { fail('migration history is outside the exact reviewed 70-to-71 boundary'); }
  if (plan.mode === 'repeatable-challenge-cutover' && releaseScope !== 'repeatable-challenge-cutover') {
    fail('the exact70 production checkpoint requires the one-time repeatable-challenge-cutover scope');
  }
  if (plan.mode === 'post-repeatable-challenge-cutover'
    && !['full', 'frontend-only'].includes(releaseScope)) {
    fail('the one-time repeatable challenge cutover scope is no longer valid');
  }
  return Object.freeze({ mode: plan.mode, requiresExact70Backup: plan.requiresExact70Backup,
    migrationVersion: REPEATABLE_CHALLENGE_MIGRATION_VERSION });
}

async function main() {
  if (process.argv.length !== 2) fail('arguments are not accepted');
  // An explicitly bound but missing/malformed job receipt fails before any
  // remote query. The initial classification intentionally has no expected input.
  const expectedReceipt = Object.hasOwn(process.env, 'EXPECTED_RELEASE_BOUNDARY')
    ? process.env.EXPECTED_RELEASE_BOUNDARY : undefined;
  if (expectedReceipt !== undefined) parseExpectedProductionReleaseBoundary(expectedReceipt);
  const migrationFilenames = await readdir(migrationsDirectory);
  const migrationSourceSha256 = createHash('sha256')
    .update(await readFile(repeatableChallengeMigration))
    .digest('hex');
  verifyRepeatableChallengeMigrationSource({ migrationSourceSha256 });
  let migrationSourceHashes;
  if (migrationFilenames.filter(name => name.endsWith('.sql')).length > 71) {
    migrationSourceHashes = Object.fromEntries(await Promise.all(migrationFilenames.filter(name => name.endsWith('.sql'))
      .map(async name => [name, createHash('sha256').update(await readFile(new URL(name, migrationsDirectory))).digest('hex')])));
    verifyPost71ReleaseSources({ migrationFilenames, migrationSourceHashes });
  }
  const rawResponse = await runReadOnlyManagementQuery({ projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN, query: authoritativeMigrationHistoryQuery });
  const result = verifyProductionRepeatableCutoverPolicy({ releaseScope: process.env.RELEASE_SCOPE,
    rawResponse, migrationFilenames, migrationSourceSha256, migrationSourceHashes });
  const receipt = expectedReceipt === undefined ? productionReleaseBoundaryReceipt(result)
    : verifyUnchangedProductionReleaseBoundary({ expectedReceipt, actual: result });
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.SUPABASE_PROJECT_REF !== PROJECT_REF) {
    console.error('Production repeatable challenge release policy failed: fixed project does not match.');
    process.exitCode = 1;
  } else main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
