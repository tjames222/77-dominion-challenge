import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { selectPostOriginal77MigrationVersions } from './production-backup-public-contract.mjs';
import { parseMigrationList } from './verify-reconciliation-history.mjs';

export const REPEATABLE_CHALLENGE_MIGRATION_VERSION = '20261001001245';
export const REPEATABLE_CHALLENGE_MIGRATION_FILENAME =
  `${REPEATABLE_CHALLENGE_MIGRATION_VERSION}_repeatable_challenge_instances_v2.sql`;
export const REPEATABLE_CHALLENGE_MIGRATION_SHA256 =
  '0250b78791964615abcbe8066245df73ed98d78dbdb5a4e418d3bfbc7bec652b';
const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
const repeatableChallengeMigration = new URL(
  `../supabase/migrations/${REPEATABLE_CHALLENGE_MIGRATION_FILENAME}`,
  import.meta.url,
);
const fail = message => { throw new Error(`Repeatable challenge cutover plan is invalid: ${message}`); };
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const isSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export function verifyRepeatableChallengeMigrationSource({
  migrationSourceSha256,
  reviewedMigrationSha256 = REPEATABLE_CHALLENGE_MIGRATION_SHA256,
} = {}) {
  if (!isSha256(reviewedMigrationSha256)) fail('the reviewed migration source pin is not ready');
  if (!isSha256(migrationSourceSha256)) fail('the migration source hash is missing or malformed');
  if (migrationSourceSha256 !== reviewedMigrationSha256) fail('the migration source bytes changed after review');
  return migrationSourceSha256;
}

export function verifyRepeatableChallengeCutoverPlan({
  local,
  remote,
  migrationFilenames,
  migrationSourceSha256,
  reviewedMigrationSha256 = REPEATABLE_CHALLENGE_MIGRATION_SHA256,
} = {}) {
  verifyRepeatableChallengeMigrationSource({ migrationSourceSha256, reviewedMigrationSha256 });
  if (!Array.isArray(local) || !Array.isArray(remote) || !Array.isArray(migrationFilenames)) fail('migration inventories are missing');
  let exact70;
  try { exact70 = selectPostOriginal77MigrationVersions(migrationFilenames); }
  catch { fail('the reviewed exact-70 backup checkpoint changed'); }
  const exact71 = [...exact70, REPEATABLE_CHALLENGE_MIGRATION_VERSION];
  const versions = migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort()
    .map(name => name.slice(0, 14));
  if (!same(versions, exact71) || !same(local, exact71)) fail('local history must be exactly the reviewed 71-migration cutover');
  if (same(remote, exact70)) return Object.freeze({ mode: 'repeatable-challenge-cutover', requiresExact70Backup: true });
  if (same(remote, exact71)) return Object.freeze({ mode: 'post-repeatable-challenge-cutover', requiresExact70Backup: false });
  fail('remote history must be exactly the pre-cutover 70 or completed 71 migrations');
}

function parseArguments(values) {
  if (values.length !== 2 || values[0] !== '--cli-history' || !values[1] || values[1].startsWith('--')) {
    fail('usage: --cli-history <path>');
  }
  return values[1];
}

async function main() {
  const path = parseArguments(process.argv.slice(2));
  const history = parseMigrationList(await readFile(path, 'utf8'));
  const migrationFilenames = await readdir(migrationsDirectory);
  const migrationSourceSha256 = createHash('sha256')
    .update(await readFile(repeatableChallengeMigration))
    .digest('hex');
  console.log(verifyRepeatableChallengeCutoverPlan({
    ...history,
    migrationFilenames,
    migrationSourceSha256,
  }).mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
