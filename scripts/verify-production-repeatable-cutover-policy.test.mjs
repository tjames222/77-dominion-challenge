import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { selectPostOriginal77MigrationVersions } from './production-backup-public-contract.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  REPEATABLE_CHALLENGE_MIGRATION_VERSION } from './verify-repeatable-challenge-cutover-plan.mjs';
import { verifyProductionRepeatableCutoverPolicy, productionReleaseBoundaryReceipt,
  parseExpectedProductionReleaseBoundary, verifyUnchangedProductionReleaseBoundary } from './verify-production-repeatable-cutover-policy.mjs';

// Exercise the unchanged historical70-to71 release path with its frozen local inventory.
const migrationFilenames = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
  .filter(name => name.endsWith('.sql')).sort().slice(0,71);
const exact70 = selectPostOriginal77MigrationVersions(migrationFilenames);
const exact71 = [...exact70, REPEATABLE_CHALLENGE_MIGRATION_VERSION];
const rows = versions => versions.map(version => ({ version }));
const reviewedMigrationSha256 = 'a'.repeat(64);
const source = { migrationSourceSha256: reviewedMigrationSha256, reviewedMigrationSha256 };
const jobBlock = (workflow, name) => {
  const start = workflow.indexOf(`  ${name}:`);
  assert(start >= 0, `missing workflow job ${name}`);
  const remainder = workflow.slice(start + 3);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\s*$/mu);
  return workflow.slice(start, next < 0 ? undefined : start + 3 + next);
};

test('only the explicit one-time scope can move exact70 production to71', () => {
  assert.deepEqual(verifyProductionRepeatableCutoverPolicy({ releaseScope: 'repeatable-challenge-cutover',
    rawResponse: rows(exact70), migrationFilenames, ...source }), {
    mode: 'repeatable-challenge-cutover', requiresExact70Backup: true,
    migrationVersion: REPEATABLE_CHALLENGE_MIGRATION_VERSION,
  });
  for (const releaseScope of ['full', 'frontend-only', 'compatibility-cutover']) {
    assert.throws(() => verifyProductionRepeatableCutoverPolicy({ releaseScope,
      rawResponse: rows(exact70), migrationFilenames, ...source }), /requires the one-time/u);
  }
});

test('completed71 production accepts ordinary release scopes and rejects replaying the cutover', () => {
  for (const releaseScope of ['full', 'frontend-only']) {
    assert.equal(verifyProductionRepeatableCutoverPolicy({ releaseScope,
      rawResponse: rows(exact71), migrationFilenames, ...source }).requiresExact70Backup, false);
  }
  for (const releaseScope of ['repeatable-challenge-cutover', 'compatibility-cutover']) {
    assert.throws(() => verifyProductionRepeatableCutoverPolicy({ releaseScope,
      rawResponse: rows(exact71), migrationFilenames, ...source }), /no longer valid/u);
  }
});

test('fails closed on partial, extra, malformed and wrong-scope inventories', () => {
  for (const rawResponse of [rows(exact70.slice(0, -1)), rows([...exact71, '20261002000000']),
    [...rows(exact70), { version: exact70.at(-1) }], { versions: exact70 }]) {
    assert.throws(() => verifyProductionRepeatableCutoverPolicy({ releaseScope: 'repeatable-challenge-cutover',
      rawResponse, migrationFilenames, ...source }), /release policy failed/u);
  }
  assert.throws(() => verifyProductionRepeatableCutoverPolicy({ releaseScope: 'unknown',
    rawResponse: rows(exact70), migrationFilenames, ...source }), /scope is invalid/u);
  assert.throws(() => verifyProductionRepeatableCutoverPolicy({ releaseScope: 'repeatable-challenge-cutover',
    rawResponse: rows(exact70), migrationFilenames: null, ...source }), /inventory is missing/u);
});

test('uses the frozen source pin and fails closed on any migration-byte drift', () => {
  assert.equal(REPEATABLE_CHALLENGE_MIGRATION_SHA256,
    '0250b78791964615abcbe8066245df73ed98d78dbdb5a4e418d3bfbc7bec652b');
  assert.equal(verifyProductionRepeatableCutoverPolicy({
    releaseScope: 'repeatable-challenge-cutover',
    rawResponse: rows(exact70),
    migrationFilenames,
    migrationSourceSha256: REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  }).mode, 'repeatable-challenge-cutover');
  assert.throws(() => verifyProductionRepeatableCutoverPolicy({
    releaseScope: 'repeatable-challenge-cutover',
    rawResponse: rows(exact70),
    migrationFilenames,
    migrationSourceSha256: reviewedMigrationSha256,
  }), /outside the exact reviewed 70-to-71 boundary/u);
  assert.throws(() => verifyProductionRepeatableCutoverPolicy({
    releaseScope: 'repeatable-challenge-cutover',
    rawResponse: rows(exact70),
    migrationFilenames,
    migrationSourceSha256: 'b'.repeat(64),
    reviewedMigrationSha256,
  }), /outside the exact reviewed 70-to-71 boundary/u);
});

test('production policy reads the one fixed migration source before the remote history query', async () => {
  const sourceText = await readFile(new URL('./verify-production-repeatable-cutover-policy.mjs', import.meta.url), 'utf8');
  assert.match(sourceText, /REPEATABLE_CHALLENGE_MIGRATION_FILENAME/u);
  assert.equal(REPEATABLE_CHALLENGE_MIGRATION_FILENAME,
    '20261001001245_repeatable_challenge_instances_v2.sql');
  assert(sourceText.indexOf('await readFile(repeatableChallengeMigration)')
    < sourceText.indexOf('await runReadOnlyManagementQuery'));
  assert(sourceText.indexOf('verifyRepeatableChallengeMigrationSource({ migrationSourceSha256 })')
    < sourceText.indexOf('await runReadOnlyManagementQuery'));
  assert.doesNotMatch(sourceText, /process\.env\.(?:MIGRATION|REVIEWED).*SHA/iu);
});

test('release workflow requires the fixed read-only policy before every mutable production path', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const policy = workflow.indexOf('  repeatable-cutover-policy:');
  const cloudflare = workflow.indexOf('  cloudflare-policy:');
  const canary = workflow.indexOf('  canary-policy:');
  const backend = workflow.indexOf('  backend:');
  assert(policy > 0 && cloudflare > policy && canary > policy && backend > policy);
  const block = jobBlock(workflow, 'repeatable-cutover-policy');
  assert.match(block, /environment: production/u);
  const classifier = block.slice(block.indexOf('- name: Classify the exact read-only production migration boundary'),
    block.indexOf('- name: Select the fresh exact-70 encrypted backup artifact'));
  assert.match(classifier, /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/u);
  assert.match(classifier, /SUPABASE_PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/u);
  assert.match(classifier, /RELEASE_SCOPE: \$\{\{ inputs\.release_scope \}\}/u);
  assert.equal(block.match(/SUPABASE_ACCESS_TOKEN:/gu)?.length, 1,
    'the Management credential is exposed only to the read-only classifier step');
  assert.match(block, /node scripts\/verify-production-repeatable-cutover-policy\.mjs/u);
  assert.doesNotMatch(block, /supabase db push|functions deploy|wrangler|SERVICE_ROLE|private[-_ ]?key|decrypt/iu);
  for (const job of ['cloudflare-policy', 'canary-policy', 'compatibility-guards',
    'frontend-rollback-history', 'backend', 'frontend', 'deploy']) {
    assert.match(jobBlock(workflow, job), /repeatable-cutover-policy/u);
  }
  assert.match(jobBlock(workflow, 'backend'),
    /if: inputs\.release_scope == 'full' \|\| inputs\.release_scope == 'repeatable-challenge-cutover'/u);
  assert.match(jobBlock(workflow, 'frontend'),
    /inputs\.release_scope == 'repeatable-challenge-cutover'[\s\S]*needs\.backend\.result == 'success'/u);
  assert.match(jobBlock(workflow, 'deploy'),
    /needs\.repeatable-cutover-policy\.result == 'success'[\s\S]*needs\.frontend\.result == 'success'/u);
  const backendJob = jobBlock(workflow, 'backend');
  assert(backendJob.indexOf('Recheck the exact repeatable-challenge release boundary')
    < backendJob.indexOf('Configure verified native password-reset email'));
  assert.match(backendJob, /node scripts\/verify-production-repeatable-cutover-policy\.mjs/u);
});

test('repeatable cutover validates one fresh exact-commit exact70 backup before mutable jobs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow,
    /options:[\s\S]*- full\n          - repeatable-challenge-cutover\n          - compatibility-cutover/u);
  const block = jobBlock(workflow, 'repeatable-cutover-policy');
  assert.match(block, /if: inputs\.release_scope == 'repeatable-challenge-cutover'[\s\S]*verify-post-original77-backup-evidence\.mjs --select/u);
  assert.match(block, /artifact-ids: \$\{\{ steps\.repeatable-backup\.outputs\.artifact_id \}\}/u);
  assert.match(block, /run-id: \$\{\{ inputs\.backup_run_id \}\}/u);
  assert.match(block, /read -r artifact_id backup_run_attempt[\s\S]*printf 'run_attempt=%s\\n'/u);
  assert.match(block, /BACKUP_RUN_ATTEMPT: \$\{\{ steps\.repeatable-backup\.outputs\.run_attempt \}\}/u);
  const verification = block.slice(block.indexOf('- name: Verify encrypted exact-70 bytes and restored checkpoint'),
    block.indexOf('- name: Select the fresh exact-71 encrypted backup artifact'));
  assert.match(verification, /BACKUP_RUN_ATTEMPT="\$BACKUP_RUN_ATTEMPT"/u);
  assert.match(verification, /PRODUCTION_BACKUP_PUBLIC_KEY="\$PRODUCTION_BACKUP_PUBLIC_KEY"[\s\S]*verify-post-original77-backup-evidence\.mjs[\s\S]*--directory/u);
  assert.equal(verification.match(/PRODUCTION_BACKUP_PUBLIC_KEY: \$\{\{ vars\.PRODUCTION_BACKUP_PUBLIC_KEY \}\}/gu)?.length, 1,
    'the historical exact70 public recovery key remains confined to its artifact verification step');
  assert.doesNotMatch(block, /secrets\.(?:PRODUCTION_BACKUP_PRIVATE_KEY|BACKUP_PRIVATE_KEY)|privateDecrypt|pg_restore/iu);
  const firstMutable = Math.min(workflow.indexOf('  cloudflare-policy:'), workflow.indexOf('  canary-policy:'),
    workflow.indexOf('  compatibility-guards:'), workflow.indexOf('  frontend-rollback-history:'),
    workflow.indexOf('  backend:'));
  assert(workflow.indexOf('  repeatable-cutover-policy:') < firstMutable);
});

const receiptCases = [
  { mode:'repeatable-challenge-cutover', requiresExact70Backup:true, requiresExact71Backup:false, migrationVersion:'20261001001245' },
  { mode:'post-repeatable-challenge-cutover', requiresExact70Backup:false, requiresExact71Backup:false, migrationVersion:'20261001001245' },
  { mode:'post71-additive-release', requiresExact70Backup:false, requiresExact71Backup:true, migrationVersion:'20261007060519' },
  { mode:'post73-reviewed-release', requiresExact70Backup:false, requiresExact71Backup:false, migrationVersion:'20261007060519' },
];

test('every repeated boundary must equal the initial full fixed receipt; no73-to71 backup bypass or concurrent apply', () => {
  for (const expected of receiptCases) for (const actual of receiptCases) {
    const expectedReceipt=JSON.stringify(expected);
    if (expected.mode===actual.mode) {
      assert.deepEqual(verifyUnchangedProductionReleaseBoundary({expectedReceipt,actual}),expected);
      assert(Object.isFrozen(productionReleaseBoundaryReceipt(actual)));
    } else assert.throws(()=>verifyUnchangedProductionReleaseBoundary({expectedReceipt,actual}),/changed after the approved backup gate/u);
  }
  const { requiresExact71Backup, ...legacy }=receiptCases[0];
  assert.deepEqual(productionReleaseBoundaryReceipt(legacy),receiptCases[0]);
});

test('missing, malformed, oversized, noncanonical or forged receipts fail without echoing caller data', () => {
  const valid=receiptCases[2];
  const privateValue='PRIVATE_SYNTHETIC_RECEIPT';
  for (const value of [undefined,'',' ',privateValue,'x'.repeat(513),JSON.stringify({...valid,extra:privateValue}),
    JSON.stringify({...valid,mode:privateValue}),JSON.stringify({...valid,requiresExact70Backup:true}),
    JSON.stringify({...valid,requiresExact71Backup:false}),JSON.stringify({...valid,requiresExact71Backup:'true'}),
    JSON.stringify({...valid,migrationVersion:'20261008000000'}),JSON.stringify({...valid,migrationVersion:73}),
    JSON.stringify(valid)+'\n',JSON.stringify(valid,null,2),JSON.stringify({mode:valid.mode})]) {
    assert.throws(()=>parseExpectedProductionReleaseBoundary(value),error=>
      error.message==='Production repeatable challenge release policy failed: expected release boundary receipt is invalid');
  }
});

test('post71 release selects one fresh same-commit exact71 artifact and gates every mutable job', async () => {
  const workflow=await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  const policy=jobBlock(workflow,'repeatable-cutover-policy');
  assert.match(policy,/receipt: \$\{\{ steps\.release-boundary\.outputs\.receipt \}\}/u);
  assert.match(policy,/requires_exact71_backup: \$\{\{ steps\.release-boundary\.outputs\.requires_exact71_backup \}\}/u);
  assert.match(policy,/backup_artifact_id: \$\{\{ steps\.post71-backup\.outputs\.artifact_id \}\}/u);
  assert.match(policy,/backup_run_attempt: \$\{\{ steps\.post71-backup\.outputs\.run_attempt \}\}/u);
  const gates=policy.slice(policy.indexOf('- name: Select the fresh exact-71 encrypted backup artifact'));
  assert.equal(gates.match(/if: steps\.release-boundary\.outputs\.requires_exact71_backup == 'true'/gu)?.length,3);
  assert.match(gates,/GITHUB_SHA="\$GITHUB_SHA"[\s\S]*verify-post-repeatable-backup-evidence\.mjs --select/u);
  assert.match(gates,/artifact-ids: \$\{\{ steps\.post71-backup\.outputs\.artifact_id \}\}/u);
  assert.match(gates,/run-id: \$\{\{ inputs\.backup_run_id \}\}/u);
  assert.match(gates,/BACKUP_RUN_ATTEMPT: \$\{\{ steps\.post71-backup\.outputs\.run_attempt \}\}/u);
  assert.match(gates,/PRODUCTION_BACKUP_PUBLIC_KEY="\$PRODUCTION_BACKUP_PUBLIC_KEY"[\s\S]*verify-post-repeatable-backup-evidence\.mjs[\s\S]*--directory "\$RUNNER_TEMP\/post71-backup-evidence"/u);
  assert.doesNotMatch(policy,/privateDecrypt|pg_restore|secrets\.(?:PRODUCTION_BACKUP_PRIVATE_KEY|BACKUP_PRIVATE_KEY|PROFILE_PHOTO_HEALTH_SECRET)/u);
  for (const name of ['cloudflare-policy','canary-policy','compatibility-guards','frontend-rollback-history','backend','frontend','deploy']) {
    assert.match(jobBlock(workflow,name),/repeatable-cutover-policy/u);
  }
});

test('backend requires the same approved receipt and fresh exact71 artifact again directly before migration', async () => {
  const workflow=await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  const backend=jobBlock(workflow,'backend');
  assert.match(backend,/EXPECTED_RELEASE_BOUNDARY: \$\{\{ needs\.repeatable-cutover-policy\.outputs\.receipt \}\}/u);
  assert.equal(backend.match(/EXPECTED_RELEASE_BOUNDARY="\$EXPECTED_RELEASE_BOUNDARY"/gu)?.length,2);
  const first=backend.indexOf('Recheck the exact repeatable-challenge release boundary');
  assert(first>0 && first<backend.indexOf('Configure verified native password-reset email'));
  const repeated=backend.indexOf('Reverify fresh exact-71 evidence immediately before migration');
  const boundary=backend.indexOf('Recheck the approved exact migration boundary immediately before apply');
  const migration=backend.indexOf('Apply database migrations');
  assert(repeated>first && boundary>repeated && migration>boundary);
  assert.equal((backend.slice(boundary,migration).match(/- name:/gu)||[]).length,1,
    'no intervening step may separate the final exact boundary check from migration');
  assert.match(backend,/artifact-ids: \$\{\{ needs\.repeatable-cutover-policy\.outputs\.backup_artifact_id \}\}/u);
  const fresh=backend.slice(repeated,boundary);
  assert.match(fresh,/if: needs\.repeatable-cutover-policy\.outputs\.requires_exact71_backup == 'true'/u);
  assert.match(fresh,/BACKUP_RUN_ATTEMPT: \$\{\{ needs\.repeatable-cutover-policy\.outputs\.backup_run_attempt \}\}/u);
  assert.match(fresh,/GITHUB_SHA="\$GITHUB_SHA"[\s\S]*verify-post-repeatable-backup-evidence\.mjs/u);
  const policySource=await readFile(new URL('./verify-production-repeatable-cutover-policy.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(policySource,/post71 protected-workflow wiring is not yet approved/u);
  assert(policySource.indexOf('if (expectedReceipt !== undefined) parseExpectedProductionReleaseBoundary')
    <policySource.indexOf('await runReadOnlyManagementQuery'));
  assert.match(policySource,/verifyUnchangedProductionReleaseBoundary\(\{ expectedReceipt, actual: result \}\)/u);
});

test('dedicated health credential is validated before writes and synchronized only in protected backend', async () => {
  const workflow=await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  const backend=jobBlock(workflow,'backend');
  assert.equal(workflow.match(/PROFILE_PHOTO_HEALTH_SECRET: \$\{\{ secrets\.PROFILE_PHOTO_HEALTH_SECRET \}\}/gu)?.length,1);
  assert.match(backend,/PROFILE_PHOTO_HEALTH_SECRET: \$\{\{ secrets\.PROFILE_PHOTO_HEALTH_SECRET \}\}/u);
  const validation=backend.indexOf('run: node scripts/verify-profile-photo-health-runtime-config.mjs');
  assert(validation>0 && validation<backend.indexOf('Configure verified native password-reset email'));
  assert(validation<backend.indexOf('Apply database migrations'));
  const sync=backend.slice(backend.indexOf('- name: Synchronize Edge Function secrets'),backend.indexOf('- name: Synchronize enabled Stripe Function secrets'));
  assert.match(sync,/"PROFILE_PHOTO_HEALTH_SECRET=\$\{PROFILE_PHOTO_HEALTH_SECRET\}"/u);
  for (const name of ['repeatable-cutover-policy','backup-evidence','frontend','deploy']) assert.doesNotMatch(jobBlock(workflow,name),/PROFILE_PHOTO_HEALTH_SECRET/u);
  const backup=await readFile(new URL('../.github/workflows/production-backup.yml',import.meta.url),'utf8');
  assert.doesNotMatch(backup,/PROFILE_PHOTO_HEALTH_SECRET/u);
});

test('all literal release workflow shell bodies retain valid Bash syntax', async () => {
  const workflow=await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  let checked=0;
  for (const match of workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gmu)) {
    const shell=match[1].split('\n').map(line=>line.slice(10)).join('\n').replaceAll(/\$\{\{[^}]+\}\}/gu,'synthetic-value');
    const result=spawnSync('bash',['-n'],{input:shell,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    checked++;
  }
  assert(checked>25,'The shell syntax inventory unexpectedly shrank.');
});
