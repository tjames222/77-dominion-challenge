import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { POST71_REVIEWED_MIGRATIONS, verifyPost71ReleasePlan, verifyPost71ReleaseSources } from './verify-post71-release-plan.mjs';
import { verifyProductionRepeatableCutoverPolicy } from './verify-production-repeatable-cutover-policy.mjs';
const directory = new URL('../supabase/migrations/', import.meta.url);
const migrationFilenames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
const migrationSourceHashes = Object.fromEntries(await Promise.all(migrationFilenames.map(async name =>
  [name, createHash('sha256').update(await readFile(new URL(name,directory))).digest('hex')])));
const source = { migrationFilenames, migrationSourceHashes };
const versions = migrationFilenames.map(name => name.slice(0,14));
const plan = (remote, releaseScope = 'full', overrides = {}) => verifyPost71ReleasePlan({ ...source, releaseScope, remote, ...overrides });

test('post71 policy pins every existing source and exactly two reviewed additive migration sources', () => {
  assert.equal(verifyPost71ReleaseSources(source).exact73.length,73);
  for (const index of [0,69,70,71,72]) {
    assert.throws(() => verifyPost71ReleaseSources({ ...source, migrationSourceHashes: {
      ...migrationSourceHashes, [migrationFilenames[index]]: 'a'.repeat(64),
    } }), /source bytes changed/u);
  }
  for (const names of [migrationFilenames.slice(0,72), [...migrationFilenames,'20261008000000_unreviewed.sql'],
    [...migrationFilenames.slice(0,71),POST71_REVIEWED_MIGRATIONS[1].filename,POST71_REVIEWED_MIGRATIONS[1].filename],
    [...migrationFilenames.slice(0,71),'20260928000000_backdated_health.sql',POST71_REVIEWED_MIGRATIONS[1].filename]]) {
    assert.throws(() => verifyPost71ReleaseSources({ ...source, migrationFilenames:names }), /Post71 release plan is invalid/u);
  }
});

test('exact71 full release requires fresh71 evidence; frontend-only requires fully applied73', () => {
  assert.deepEqual(plan(versions.slice(0,71)), { mode:'post71-additive-release', requiresExact70Backup:false,
    requiresExact71Backup:true, migrationVersion:'20261007060519' });
  assert.throws(() => plan(versions.slice(0,71),'frontend-only'), /all73/u);
  for (const scope of ['full','frontend-only']) assert.equal(plan(versions,scope).requiresExact71Backup,false);
});

test('partial72 stops for coordinated forward-fix; old cutovers and every unknown boundary fail closed', () => {
  assert.throws(() => plan(versions.slice(0,72)), /partial72 requires coordinated review and forward-fix/u);
  for (const remote of [versions.slice(0,70), [...versions,'20261008000000'], [...versions.slice(0,72),'20261008000000'],
    [...versions.slice(0,71),versions[71],versions[71]], [...versions].reverse()]) {
    assert.throws(() => plan(remote), /remote history/u);
  }
  for (const scope of ['repeatable-challenge-cutover','compatibility-cutover','unknown']) assert.throws(() => plan(versions,scope), /cutover scopes/u);
});

test('production authoritative wrapper uses the same exact source-pinned73 contract', () => {
  assert.equal(verifyProductionRepeatableCutoverPolicy({ ...source, releaseScope:'full',
    rawResponse:versions.slice(0,71).map(version=>({version})) }).requiresExact71Backup,true);
  assert.throws(() => verifyProductionRepeatableCutoverPolicy({ ...source, releaseScope:'full',
    rawResponse:versions.slice(0,72).map(version=>({version})) }), /partial72/u);
});

test('post71 CLI remains disabled before any remote query until the protected workflow is approved', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-production-repeatable-cutover-policy.mjs'], {
    cwd: new URL('..', import.meta.url), encoding:'utf8',
    env: { PATH:process.env.PATH, SUPABASE_PROJECT_REF:'mimolwojppbtsbvtqwpo' },
  });
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/post71 protected-workflow wiring is not yet approved/u);
});
