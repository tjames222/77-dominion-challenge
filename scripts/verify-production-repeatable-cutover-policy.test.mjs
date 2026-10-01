import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { selectPostOriginal77MigrationVersions } from './production-backup-public-contract.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256,
  REPEATABLE_CHALLENGE_MIGRATION_VERSION } from './verify-repeatable-challenge-cutover-plan.mjs';
import { verifyProductionRepeatableCutoverPolicy } from './verify-production-repeatable-cutover-policy.mjs';

const migrationFilenames = await readdir(new URL('../supabase/migrations/', import.meta.url));
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
    '7e295a3708a3c241b60917fb16db00f27a39aa327f19c557595a5cbab2396bfc');
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
  const verification = block.slice(block.indexOf('- name: Verify encrypted exact-70 bytes and restored checkpoint'));
  assert.match(verification, /BACKUP_RUN_ATTEMPT="\$BACKUP_RUN_ATTEMPT"/u);
  assert.match(verification, /PRODUCTION_BACKUP_PUBLIC_KEY="\$PRODUCTION_BACKUP_PUBLIC_KEY"[\s\S]*verify-post-original77-backup-evidence\.mjs[\s\S]*--directory/u);
  assert.equal(block.match(/PRODUCTION_BACKUP_PUBLIC_KEY: \$\{\{ vars\.PRODUCTION_BACKUP_PUBLIC_KEY \}\}/gu)?.length, 1,
    'the public recovery key is exposed only to the artifact verification step');
  assert.doesNotMatch(block, /secrets\.(?:PRODUCTION_BACKUP_PRIVATE_KEY|BACKUP_PRIVATE_KEY)|privateDecrypt|pg_restore/iu);
  const firstMutable = Math.min(workflow.indexOf('  cloudflare-policy:'), workflow.indexOf('  canary-policy:'),
    workflow.indexOf('  compatibility-guards:'), workflow.indexOf('  frontend-rollback-history:'),
    workflow.indexOf('  backend:'));
  assert(workflow.indexOf('  repeatable-cutover-policy:') < firstMutable);
});
