import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { selectPostOriginal77MigrationVersions } from './production-backup-public-contract.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  REPEATABLE_CHALLENGE_MIGRATION_VERSION, verifyRepeatableChallengeCutoverPlan,
  verifyRepeatableChallengeMigrationSource,
} from './verify-repeatable-challenge-cutover-plan.mjs';

const migrationFilenames = await readdir(new URL('../supabase/migrations/', import.meta.url));
const exact70 = selectPostOriginal77MigrationVersions(migrationFilenames);
const exact71 = [...exact70, REPEATABLE_CHALLENGE_MIGRATION_VERSION];
const reviewedMigrationSha256 = 'a'.repeat(64);
const source = { migrationSourceSha256: reviewedMigrationSha256, reviewedMigrationSha256 };

test('requires a fresh exact70 backup only while the one reviewed migration is pending', () => {
  assert.deepEqual(verifyRepeatableChallengeCutoverPlan({
    local: exact71, remote: exact70, migrationFilenames, ...source,
  }), {
    mode: 'repeatable-challenge-cutover', requiresExact70Backup: true,
  });
  assert.deepEqual(verifyRepeatableChallengeCutoverPlan({
    local: exact71, remote: exact71, migrationFilenames, ...source,
  }), {
    mode: 'post-repeatable-challenge-cutover', requiresExact70Backup: false,
  });
});

test('rejects partial, unknown, reordered and future migration inventories', () => {
  const future = '20261002000000_future.sql';
  for (const input of [
    { local: exact70, remote: exact70, migrationFilenames },
    { local: exact71, remote: exact70.slice(0, -1), migrationFilenames },
    { local: exact71, remote: [...exact70.slice(0, -1), '20260930170000'], migrationFilenames },
    { local: [...exact71].reverse(), remote: exact70, migrationFilenames },
    { local: [...exact71, future.slice(0, 14)], remote: exact70, migrationFilenames: [...migrationFilenames, future] },
  ]) assert.throws(() => verifyRepeatableChallengeCutoverPlan({ ...input, ...source }), /cutover plan is invalid/u);
});

test('pins the sole cutover identity after the exact70 prefix', () => {
  assert.equal(exact70.length, 70);
  assert.equal(exact70.at(-1), '20260930161218');
  assert.equal(REPEATABLE_CHALLENGE_MIGRATION_VERSION, '20261001001245');
  assert.equal(REPEATABLE_CHALLENGE_MIGRATION_FILENAME,
    '20261001001245_repeatable_challenge_instances_v2.sql');
  assert.equal(exact71.length, 71);
});

test('pins the exact frozen migration bytes and rejects any source drift', async () => {
  assert.equal(REPEATABLE_CHALLENGE_MIGRATION_SHA256,
    '0250b78791964615abcbe8066245df73ed98d78dbdb5a4e418d3bfbc7bec652b');
  const bytes = await readFile(new URL(`../supabase/migrations/${REPEATABLE_CHALLENGE_MIGRATION_FILENAME}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), REPEATABLE_CHALLENGE_MIGRATION_SHA256);
  assert.equal(verifyRepeatableChallengeCutoverPlan({
    local: exact71,
    remote: exact70,
    migrationFilenames,
    migrationSourceSha256: REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  }).mode, 'repeatable-challenge-cutover');
  assert.throws(() => verifyRepeatableChallengeCutoverPlan({
    local: exact71, remote: exact70, migrationFilenames,
    migrationSourceSha256: 'b'.repeat(64),
  }), /source bytes changed/u);
});

test('accepts only an exact reviewed migration source hash', () => {
  assert.equal(verifyRepeatableChallengeMigrationSource(source), reviewedMigrationSha256);
  for (const input of [
    {},
    { migrationSourceSha256: 'not-a-hash', reviewedMigrationSha256 },
    { migrationSourceSha256: reviewedMigrationSha256, reviewedMigrationSha256: 'UNREADY' },
    { migrationSourceSha256: 'b'.repeat(64), reviewedMigrationSha256 },
  ]) assert.throws(() => verifyRepeatableChallengeMigrationSource(input), /cutover plan is invalid/u);
});
