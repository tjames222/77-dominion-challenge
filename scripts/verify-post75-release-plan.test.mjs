import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { FROZEN75_SOURCE_PAIRS_SHA256, POST75_REVIEWED_MIGRATION,
  verifyPost75ReleasePlan, verifyPost75ReleaseSources } from './verify-post75-release-plan.mjs';
import { verifyPost74ReleaseSources } from './verify-post74-release-plan.mjs';
import { POST75_BACKUP_MODE, POST75_VERSIONS_SHA256, requirePost75MigrationVersions,
  selectPost75MigrationVersions } from './production-backup-public-contract.mjs';
import { selectBackupMigrationCheckpoint } from './free-production-backup.mjs';

const directory = new URL('../supabase/migrations/', import.meta.url);
const migrationFilenames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
const hash = value => createHash('sha256').update(value).digest('hex');
const migrationSourceHashes = Object.fromEntries(await Promise.all(migrationFilenames.map(async name =>
  [name, hash(await readFile(new URL(name, directory)))])));
const source = { migrationFilenames, migrationSourceHashes };
const versions = migrationFilenames.map(name => name.slice(0, 14));
const plan = (remote, releaseScope = 'full', overrides = {}) =>
  verifyPost75ReleasePlan({ ...source, releaseScope, remote, ...overrides });

test('source76 pins every frozen75 byte and exactly one reviewed activation review health addition', () => {
  assert.equal(migrationFilenames.length, 76);
  assert.deepEqual(verifyPost75ReleaseSources(source), { exact75: versions.slice(0, 75), exact76: versions });
  assert.equal(hash(JSON.stringify(migrationFilenames.slice(0, 75).map(name => [name, migrationSourceHashes[name]]))),
    FROZEN75_SOURCE_PAIRS_SHA256);
  assert.equal(versions[75], POST75_REVIEWED_MIGRATION.filename.slice(0, 14));
  for (let index = 0; index < 76; index++) {
    assert.throws(() => verifyPost75ReleaseSources({ ...source,
      migrationSourceHashes: { ...migrationSourceHashes, [migrationFilenames[index]]: 'a'.repeat(64) },
    }), /source bytes changed/u);
    const missing = { ...migrationSourceHashes }; delete missing[migrationFilenames[index]];
    assert.throws(() => verifyPost75ReleaseSources({ ...source, migrationSourceHashes: missing }));
  }
  for (const names of [migrationFilenames.slice(0, 74), migrationFilenames.slice(0, 75),
    [...migrationFilenames, '20261019000000_unreviewed.sql'],
    [...migrationFilenames.slice(0, 75), '20261018013111_renamed.sql'],
    [...migrationFilenames.slice(0, 75), migrationFilenames[73]],
    [...migrationFilenames.slice(0, 75), '20260928000000_backdated.sql']]) {
    assert.throws(() => verifyPost75ReleaseSources({ ...source, migrationFilenames: names }));
  }
  for (const invalid of [undefined, {}, { migrationFilenames: null, migrationSourceHashes },
    { migrationFilenames, migrationSourceHashes: null }]) assert.throws(() => verifyPost75ReleaseSources(invalid));
});

test('exact75 full alone requires fresh75 evidence; exact76 full/frontend-only requires none', () => {
  assert.deepEqual(plan(versions.slice(0, 75)), { mode: 'post75-additive-release',
    requiresExact70Backup: false, requiresExact71Backup: false, requiresExact73Backup: false,
    requiresExact74Backup: false, requiresExact75Backup: true, migrationVersion: '20261018013111' });
  assert.throws(() => plan(versions.slice(0, 75), 'frontend-only'), /all76/u);
  for (const scope of ['full', 'frontend-only']) assert.deepEqual(plan(versions, scope), {
    mode: 'post76-reviewed-release', requiresExact70Backup: false, requiresExact71Backup: false,
    requiresExact73Backup: false, requiresExact74Backup: false, requiresExact75Backup: false,
    migrationVersion: '20261018013111',
  });
});

test('source76 rejects old, partial, unknown, duplicate, reordered remote boundaries and scopes', () => {
  for (let count = 0; count < 75; count++) assert.throws(() => plan(versions.slice(0, count)), /remote history/u);
  for (const remote of [[...versions, '20261019000000'], [...versions.slice(0, 75), '20261013090000'],
    [...versions.slice(0, 75), versions[73]], [...versions].reverse(), [...versions.slice(0, 75)].reverse()]) {
    assert.throws(() => plan(remote), /remote history/u);
  }
  for (const remote of [undefined, null, {}, '75']) assert.throws(() => plan(remote), /inventory/u);
  for (const scope of [undefined, null, 'repeatable-challenge-cutover', 'compatibility-cutover', 'unknown']) {
    assert.throws(() => verifyPost75ReleasePlan({ ...source, remote: versions, releaseScope: scope }), /cutover scopes/u);
  }
});

test('exact75 backup selector retains all earlier checkpoints and rejects version or name drift', () => {
  const exact75 = selectPost75MigrationVersions(migrationFilenames);
  assert.equal(POST75_BACKUP_MODE, 'post-admin-profile-name-75');
  assert.equal(hash(JSON.stringify(exact75)), POST75_VERSIONS_SHA256);
  assert.deepEqual(selectBackupMigrationCheckpoint(migrationFilenames, POST75_BACKUP_MODE), exact75);
  for (const count of [70, 71, 72, 73, 74, 76, 77]) assert.throws(() => requirePost75MigrationVersions(
    [...versions, '20261019000000'].slice(0, count)));
  for (const changed of [[...exact75].reverse(), [...exact75.slice(0, 74), exact75[73]],
    [...exact75.slice(0, 74), '20261013000000']]) assert.throws(() => requirePost75MigrationVersions(changed));
  for (const names of [
    [...migrationFilenames.slice(0, 74), '20261013091749_wrong.sql', migrationFilenames[75]],
    [...migrationFilenames, migrationFilenames[0]],
    [...migrationFilenames, 'not_a_migration.sql'],
  ]) assert.throws(() => selectPost75MigrationVersions(names));
  for (const [mode, count] of [['legacy-thirteen-migration-cutover', 13],
    ['current-production-2026-09-27', 61], ['post-early-access-66', 66], ['post-admin-inbox-67', 67],
    ['post-original77-70', 70], ['post-repeatable-challenge-71', 71], ['post-cleanup-monitor-73', 73], ['post-admin-cleanup-health-74', 74]]) {
    assert.equal(selectBackupMigrationCheckpoint(migrationFilenames, mode).length, count);
  }
});

test('old source75 verifier stays exact and new source76 verifier chains its frozen boundary', async () => {
  assert.deepEqual(verifyPost74ReleaseSources({ ...source, migrationFilenames: migrationFilenames.slice(0, 75) }).exact75,
    versions.slice(0, 75));
  assert.throws(() => verifyPost74ReleaseSources(source), /exactly74/u);
  const verifier = await readFile(new URL('./verify-post75-release-plan.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /verifyPost74ReleaseSources\(\{ migrationFilenames: names\.slice\(0, 75\), migrationSourceHashes \}\)/u);
  assert.doesNotMatch(verifier, /process\.env|node:fs|fetch\(|child_process|spawn|execFile/u);
});

test('exact75 producer source76 proof precedes recovery secrets, image resolver and credential mint', async () => {
  const producer = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const proof = producer.indexOf('verifyPost75ReleaseSources({ migrationFilenames, migrationSourceHashes });');
  assert(proof > 0);
  for (const marker of ['const postEarlyAccessSecrets =', 'const imageId = prepareProductionBackupImage();',
    "stage('temporary-credentials')"]) assert(proof < producer.indexOf(marker), marker);
  assert.match(producer, /if \(backupMode === POST75_BACKUP_MODE\) \{/u);
  const verifier = await readFile(new URL('./verify-post75-backup-evidence.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /requirePost75MigrationVersions\(expectedVersions\)/u);
  assert.doesNotMatch(verifier, /decryptBackup|privateDecrypt|child_process/u);
});
