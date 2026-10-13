import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { POST73_REVIEWED_MIGRATION, verifyPost73ReleasePlan, verifyPost73ReleaseSources } from './verify-post73-release-plan.mjs';
import { productionReleaseBoundaryReceipt, parseExpectedProductionReleaseBoundary,
  verifyUnchangedProductionReleaseBoundary, verifyProductionRepeatableCutoverPolicy } from './verify-production-repeatable-cutover-policy.mjs';
import { POST73_BACKUP_MODE, requirePost73MigrationVersions, selectPost73MigrationVersions } from './production-backup-public-contract.mjs';
import { selectBackupMigrationCheckpoint } from './free-production-backup.mjs';

const directory = new URL('../supabase/migrations/', import.meta.url);
const migrationFilenames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
const migrationSourceHashes = Object.fromEntries(await Promise.all(migrationFilenames.map(async name =>
  [name, createHash('sha256').update(await readFile(new URL(name, directory))).digest('hex')])));
const source = { migrationFilenames, migrationSourceHashes };
const versions = migrationFilenames.map(name => name.slice(0, 14));
const plan = (remote, releaseScope = 'full', overrides = {}) =>
  verifyPost73ReleasePlan({ ...source, releaseScope, remote, ...overrides });

test('source74 pins all frozen73 bytes and exactly one reviewed cleanup migration', () => {
  assert.equal(verifyPost73ReleaseSources(source).exact74.length, 74);
  assert.equal(versions[73], POST73_REVIEWED_MIGRATION.filename.slice(0, 14));
  for (let index = 0; index < 74; index++) assert.throws(() => verifyPost73ReleaseSources({
    ...source, migrationSourceHashes: { ...migrationSourceHashes, [migrationFilenames[index]]: 'a'.repeat(64) },
  }), /source bytes changed/u);
  for (const names of [migrationFilenames.slice(0, 72), migrationFilenames.slice(0, 73),
    [...migrationFilenames, '20261014000000_unreviewed.sql'],
    [...migrationFilenames.slice(0, 73), '20261013055744_renamed.sql'],
    [...migrationFilenames.slice(0, 73), migrationFilenames[72]],
    [...migrationFilenames.slice(0, 73), '20260928000000_backdated.sql']]) {
    assert.throws(() => verifyPost73ReleaseSources({ ...source, migrationFilenames: names }));
  }
});

test('only exact73 full release requires fresh73 evidence; completed74 accepts full/frontend-only', () => {
  assert.deepEqual(plan(versions.slice(0, 73)), { mode: 'post73-additive-release',
    requiresExact70Backup: false, requiresExact71Backup: false, requiresExact73Backup: true,
    migrationVersion: '20261013055744' });
  assert.throws(() => plan(versions.slice(0, 73), 'frontend-only'), /all74/u);
  for (const scope of ['full', 'frontend-only']) assert.deepEqual(plan(versions, scope), {
    mode: 'post74-reviewed-release', requiresExact70Backup: false, requiresExact71Backup: false,
    requiresExact73Backup: false, migrationVersion: '20261013055744',
  });
});

test('source74 rejects all old/partial/unknown/duplicate/reordered remote boundaries and scopes', () => {
  for (const remote of [versions.slice(0, 70), versions.slice(0, 71), versions.slice(0, 72),
    [...versions, '20261014000000'], [...versions.slice(0, 73), '20261013000000'],
    [...versions.slice(0, 73), versions[72]], [...versions].reverse()]) {
    assert.throws(() => plan(remote), /remote history/u);
    assert.throws(() => verifyProductionRepeatableCutoverPolicy({ ...source,
      releaseScope: 'full', rawResponse: remote.map(version => ({ version })) }));
  }
  for (const scope of ['repeatable-challenge-cutover', 'compatibility-cutover', 'unknown']) {
    assert.throws(() => plan(versions, scope), /cutover scopes/u);
  }
  for (const count of [73, 74]) assert.equal(verifyProductionRepeatableCutoverPolicy({
    ...source, releaseScope: 'full', rawResponse: versions.slice(0, count).map(version => ({ version })),
  }).requiresExact73Backup, count === 73);
});

test('exact73 backup selector retains all earlier checkpoints and fails on version/name drift', () => {
  const exact73 = selectPost73MigrationVersions(migrationFilenames);
  assert.equal(exact73.length, 73);
  assert.deepEqual(selectBackupMigrationCheckpoint(migrationFilenames, POST73_BACKUP_MODE), exact73);
  for (const count of [71, 72, 74, 75]) assert.throws(() => requirePost73MigrationVersions(
    [...versions, '20261014000000'].slice(0, count)));
  for (const names of [
    [...migrationFilenames.slice(0, 72), '20261007060519_wrong.sql'],
    [...migrationFilenames, migrationFilenames[0]],
  ]) assert.throws(() => selectPost73MigrationVersions(names));
  for (const [mode, count] of [['legacy-thirteen-migration-cutover', 13],
    ['current-production-2026-09-27', 61], ['post-early-access-66', 66],
    ['post-admin-inbox-67', 67], ['post-original77-70', 70], ['post-repeatable-challenge-71', 71]]) {
    assert.equal(selectBackupMigrationCheckpoint(migrationFilenames, mode).length, count);
  }
});

test('receipt binds new backup flag and exact boundary, including additive-to-completed drift', () => {
  const additive = plan(versions.slice(0, 73));
  const completed = plan(versions);
  for (const result of [additive, completed]) {
    const receipt = productionReleaseBoundaryReceipt(result);
    const json = JSON.stringify(receipt);
    assert.deepEqual(parseExpectedProductionReleaseBoundary(json), receipt);
    assert.deepEqual(verifyUnchangedProductionReleaseBoundary({ expectedReceipt: json, actual: result }), receipt);
    for (const mutate of [
      value => { delete value.requiresExact73Backup; },
      value => { value.requiresExact73Backup = !value.requiresExact73Backup; },
      value => { value.requiresExact73Backup = String(value.requiresExact73Backup); },
      value => { value.requiresExact71Backup = true; },
      value => { value.requiresExact70Backup = true; },
      value => { value.migrationVersion = '20261007060519'; },
      value => { value.extra = false; },
    ]) { const changed = { ...result }; mutate(changed); assert.throws(() => productionReleaseBoundaryReceipt(changed)); }
  }
  assert.throws(() => verifyUnchangedProductionReleaseBoundary({
    expectedReceipt: JSON.stringify(productionReleaseBoundaryReceipt(additive)), actual: completed,
  }), /boundary changed/u);
});

test('exact73 producer binds all source bytes before temporary credentials and uses existing recovery inputs', async () => {
  const producer = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  assert(producer.indexOf('verifyPost73ReleaseSources({ migrationFilenames, migrationSourceHashes });')
    < producer.indexOf("stage('temporary-credentials')"));
  assert.match(producer, /mode === POST73_BACKUP_MODE/u);
  const verifier = await readFile(new URL('./verify-post73-backup-evidence.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /requirePost73MigrationVersions\(expectedVersions\)/u);
  assert.doesNotMatch(verifier, /decryptBackup|privateDecrypt|child_process/u);
});
