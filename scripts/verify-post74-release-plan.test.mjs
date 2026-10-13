import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { FROZEN74_SOURCE_PAIRS_SHA256, POST74_REVIEWED_MIGRATION,
  verifyPost74ReleasePlan, verifyPost74ReleaseSources } from './verify-post74-release-plan.mjs';
import { verifyPost73ReleaseSources } from './verify-post73-release-plan.mjs';
import { POST74_BACKUP_MODE, POST74_VERSIONS_SHA256, requirePost74MigrationVersions,
  selectPost74MigrationVersions } from './production-backup-public-contract.mjs';
import { selectBackupMigrationCheckpoint } from './free-production-backup.mjs';

const directory = new URL('../supabase/migrations/', import.meta.url);
const migrationFilenames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
const hash = value => createHash('sha256').update(value).digest('hex');
const migrationSourceHashes = Object.fromEntries(await Promise.all(migrationFilenames.map(async name =>
  [name, hash(await readFile(new URL(name, directory)))])));
const source = { migrationFilenames, migrationSourceHashes };
const versions = migrationFilenames.map(name => name.slice(0, 14));
const plan = (remote, releaseScope = 'full', overrides = {}) =>
  verifyPost74ReleasePlan({ ...source, releaseScope, remote, ...overrides });

test('source75 pins every frozen74 byte and exactly one reviewed profile correction addition', () => {
  assert.equal(migrationFilenames.length, 75);
  assert.deepEqual(verifyPost74ReleaseSources(source), { exact74: versions.slice(0, 74), exact75: versions });
  assert.equal(hash(JSON.stringify(migrationFilenames.slice(0, 74).map(name => [name, migrationSourceHashes[name]]))),
    FROZEN74_SOURCE_PAIRS_SHA256);
  assert.equal(versions[74], POST74_REVIEWED_MIGRATION.filename.slice(0, 14));
  for (let index = 0; index < 75; index++) {
    assert.throws(() => verifyPost74ReleaseSources({ ...source,
      migrationSourceHashes: { ...migrationSourceHashes, [migrationFilenames[index]]: 'a'.repeat(64) },
    }), /source bytes changed/u);
    const missing = { ...migrationSourceHashes }; delete missing[migrationFilenames[index]];
    assert.throws(() => verifyPost74ReleaseSources({ ...source, migrationSourceHashes: missing }));
  }
  for (const names of [migrationFilenames.slice(0, 73), migrationFilenames.slice(0, 74),
    [...migrationFilenames, '20261014000000_unreviewed.sql'],
    [...migrationFilenames.slice(0, 74), '20261013091749_renamed.sql'],
    [...migrationFilenames.slice(0, 74), migrationFilenames[73]],
    [...migrationFilenames.slice(0, 74), '20260928000000_backdated.sql']]) {
    assert.throws(() => verifyPost74ReleaseSources({ ...source, migrationFilenames: names }));
  }
  for (const invalid of [undefined, {}, { migrationFilenames: null, migrationSourceHashes },
    { migrationFilenames, migrationSourceHashes: null }]) assert.throws(() => verifyPost74ReleaseSources(invalid));
});

test('exact74 full alone requires fresh74 evidence; exact75 full/frontend-only requires none', () => {
  assert.deepEqual(plan(versions.slice(0, 74)), { mode: 'post74-additive-release',
    requiresExact70Backup: false, requiresExact71Backup: false, requiresExact73Backup: false,
    requiresExact74Backup: true, migrationVersion: '20261013091749' });
  assert.throws(() => plan(versions.slice(0, 74), 'frontend-only'), /all75/u);
  for (const scope of ['full', 'frontend-only']) assert.deepEqual(plan(versions, scope), {
    mode: 'post75-reviewed-release', requiresExact70Backup: false, requiresExact71Backup: false,
    requiresExact73Backup: false, requiresExact74Backup: false, migrationVersion: '20261013091749',
  });
});

test('source75 rejects old, partial, unknown, duplicate, reordered remote boundaries and scopes', () => {
  for (let count = 0; count < 74; count++) assert.throws(() => plan(versions.slice(0, count)), /remote history/u);
  for (const remote of [[...versions, '20261014000000'], [...versions.slice(0, 74), '20261013090000'],
    [...versions.slice(0, 74), versions[73]], [...versions].reverse(), [...versions.slice(0, 74)].reverse()]) {
    assert.throws(() => plan(remote), /remote history/u);
  }
  for (const remote of [undefined, null, {}, '74']) assert.throws(() => plan(remote), /inventory/u);
  for (const scope of [undefined, null, 'repeatable-challenge-cutover', 'compatibility-cutover', 'unknown']) {
    assert.throws(() => verifyPost74ReleasePlan({ ...source, remote: versions, releaseScope: scope }), /cutover scopes/u);
  }
});

test('exact74 backup selector retains all earlier checkpoints and rejects version or name drift', () => {
  const exact74 = selectPost74MigrationVersions(migrationFilenames);
  assert.equal(POST74_BACKUP_MODE, 'post-admin-cleanup-health-74');
  assert.equal(hash(JSON.stringify(exact74)), POST74_VERSIONS_SHA256);
  assert.deepEqual(selectBackupMigrationCheckpoint(migrationFilenames, POST74_BACKUP_MODE), exact74);
  for (const count of [70, 71, 72, 73, 75, 76]) assert.throws(() => requirePost74MigrationVersions(
    [...versions, '20261014000000'].slice(0, count)));
  for (const changed of [[...exact74].reverse(), [...exact74.slice(0, 73), exact74[72]],
    [...exact74.slice(0, 73), '20261013000000']]) assert.throws(() => requirePost74MigrationVersions(changed));
  for (const names of [
    [...migrationFilenames.slice(0, 73), '20261013055744_wrong.sql', migrationFilenames[74]],
    [...migrationFilenames, migrationFilenames[0]],
    [...migrationFilenames, 'not_a_migration.sql'],
  ]) assert.throws(() => selectPost74MigrationVersions(names));
  for (const [mode, count] of [['legacy-thirteen-migration-cutover', 13],
    ['current-production-2026-09-27', 61], ['post-early-access-66', 66], ['post-admin-inbox-67', 67],
    ['post-original77-70', 70], ['post-repeatable-challenge-71', 71], ['post-cleanup-monitor-73', 73]]) {
    assert.equal(selectBackupMigrationCheckpoint(migrationFilenames, mode).length, count);
  }
});

test('old source74 verifier stays exact and new source75 verifier chains its frozen boundary', async () => {
  assert.deepEqual(verifyPost73ReleaseSources({ ...source, migrationFilenames: migrationFilenames.slice(0, 74) }).exact74,
    versions.slice(0, 74));
  assert.throws(() => verifyPost73ReleaseSources(source), /exactly73/u);
  const verifier = await readFile(new URL('./verify-post74-release-plan.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /verifyPost73ReleaseSources\(\{ migrationFilenames: names\.slice\(0, 74\), migrationSourceHashes \}\)/u);
  assert.doesNotMatch(verifier, /process\.env|node:fs|fetch\(|child_process|spawn|execFile/u);
});

test('exact74 producer source75 proof precedes recovery secrets, image resolver and credential mint', async () => {
  const producer = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const proof = producer.indexOf('verifyPost74ReleaseSources({ migrationFilenames, migrationSourceHashes });');
  assert(proof > 0);
  for (const marker of ['const postEarlyAccessSecrets =', 'const imageId = prepareProductionBackupImage();',
    "stage('temporary-credentials')"]) assert(proof < producer.indexOf(marker), marker);
  assert.match(producer, /if \(backupMode === POST74_BACKUP_MODE\) \{/u);
  const verifier = await readFile(new URL('./verify-post74-backup-evidence.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /requirePost74MigrationVersions\(expectedVersions\)/u);
  assert.doesNotMatch(verifier, /decryptBackup|privateDecrypt|child_process/u);
});
