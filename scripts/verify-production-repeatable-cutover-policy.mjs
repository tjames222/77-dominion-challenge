import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROJECT_REF } from './production-backup-public-contract.mjs';
import { authoritativeMigrationHistoryQuery, parseRawMigrationHistoryResponse,
  runReadOnlyManagementQuery } from './verify-production-raw-migration-history.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  REPEATABLE_CHALLENGE_MIGRATION_VERSION, verifyRepeatableChallengeCutoverPlan,
  verifyRepeatableChallengeMigrationSource } from './verify-repeatable-challenge-cutover-plan.mjs';

const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
const repeatableChallengeMigration = new URL(
  `../supabase/migrations/${REPEATABLE_CHALLENGE_MIGRATION_FILENAME}`,
  import.meta.url,
);
const allowedScopes = new Set(['repeatable-challenge-cutover', 'full', 'frontend-only', 'compatibility-cutover']);
const fail = message => { throw new Error(`Production repeatable challenge release policy failed: ${message}`); };

export function verifyProductionRepeatableCutoverPolicy({
  releaseScope,
  rawResponse,
  migrationFilenames,
  migrationSourceSha256,
  reviewedMigrationSha256 = REPEATABLE_CHALLENGE_MIGRATION_SHA256,
} = {}) {
  if (!allowedScopes.has(releaseScope)) fail('release scope is invalid');
  if (!Array.isArray(migrationFilenames)) fail('local migration inventory is missing');
  let remote;
  try { remote = parseRawMigrationHistoryResponse(rawResponse); }
  catch { fail('authoritative migration history is invalid'); }
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
  const migrationFilenames = await readdir(migrationsDirectory);
  const migrationSourceSha256 = createHash('sha256')
    .update(await readFile(repeatableChallengeMigration))
    .digest('hex');
  verifyRepeatableChallengeMigrationSource({ migrationSourceSha256 });
  const rawResponse = await runReadOnlyManagementQuery({ projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN, query: authoritativeMigrationHistoryQuery });
  const result = verifyProductionRepeatableCutoverPolicy({ releaseScope: process.env.RELEASE_SCOPE,
    rawResponse, migrationFilenames, migrationSourceSha256 });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.SUPABASE_PROJECT_REF !== PROJECT_REF) {
    console.error('Production repeatable challenge release policy failed: fixed project does not match.');
    process.exitCode = 1;
  } else main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
