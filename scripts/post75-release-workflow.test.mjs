import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { productionReleaseBoundaryReceipt, parseExpectedProductionReleaseBoundary,
  verifyUnchangedProductionReleaseBoundary, verifyProductionRepeatableCutoverPolicy } from './verify-production-repeatable-cutover-policy.mjs';

const workflowUrl = new URL('../.github/workflows/deploy.yml', import.meta.url);
const job = (text, name) => {
  const start = text.indexOf('  ' + name + ':'); assert(start >= 0, name);
  const rest = text.slice(start + 3), next = rest.search(/^  [a-z][a-z0-9-]*:\s*$/mu);
  return text.slice(start, next < 0 ? undefined : start + 3 + next);
};
const step = (text, name) => {
  const start = text.indexOf('      - name: ' + name + '\n'); assert(start >= 0, name);
  const end = text.indexOf('      - name:', start + 1); return text.slice(start, end < 0 ? undefined : end);
};
const normalized = text => text.split('\n').map(line => line.trimStart()).join('\n');
const clean = script => normalized(['/usr/bin/env -i \\', '  PATH="$PATH" \\',
  '  SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \\', '  SUPABASE_PROJECT_REF="$SUPABASE_PROJECT_REF" \\',
  '  node scripts/' + script].join('\n'));
const directory = new URL('../supabase/migrations/', import.meta.url);
const filenames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
const hashes = Object.fromEntries(await Promise.all(filenames.map(async name => [name,
  createHash('sha256').update(await readFile(new URL(name, directory))).digest('hex')])));
const versions = filenames.map(name => name.slice(0, 14));
const source = { migrationFilenames: filenames, migrationSourceHashes: hashes };
const receipts = [true, false].map(pending => ({ mode: pending ? 'post75-additive-release' : 'post76-reviewed-release',
  requiresExact70Backup: false, requiresExact71Backup: false, requiresExact73Backup: false,
  requiresExact74Backup: false, requiresExact75Backup: pending, migrationVersion: '20261018013111' }));

test('complete76 policy requires the exact current75 backup and refuses source/history drift', () => {
  assert.equal(filenames.length, 76);
  for (const [index, receipt] of receipts.entries()) {
    const rawResponse = versions.slice(0, index ? 76 : 75).map(version => ({ version }));
    for (const releaseScope of index ? ['full', 'frontend-only'] : ['full']) {
      const actual = verifyProductionRepeatableCutoverPolicy({ ...source, rawResponse, releaseScope });
      assert.deepEqual(actual, receipt);
      assert.deepEqual(productionReleaseBoundaryReceipt(actual), receipt);
      const serialized = JSON.stringify(receipt); assert(serialized.length <= 512);
      assert.deepEqual(parseExpectedProductionReleaseBoundary(serialized), receipt);
      assert.deepEqual(verifyUnchangedProductionReleaseBoundary({ expectedReceipt: serialized, actual }), receipt);
    }
  }
  for (const count of [0, 70, 71, 73, 74]) assert.throws(() => verifyProductionRepeatableCutoverPolicy({ ...source,
    releaseScope: 'full', rawResponse: versions.slice(0, count).map(version => ({ version })) }));
  assert.throws(() => verifyProductionRepeatableCutoverPolicy({ ...source, releaseScope: 'frontend-only',
    rawResponse: versions.slice(0, 75).map(version => ({ version })) }));
  for (const releaseScope of ['repeatable-challenge-cutover', 'compatibility-cutover'])
    assert.throws(() => verifyProductionRepeatableCutoverPolicy({ ...source, releaseScope,
      rawResponse: versions.map(version => ({ version })) }));
  for (const name of filenames) assert.throws(() => verifyProductionRepeatableCutoverPolicy({ ...source,
    migrationSourceHashes: { ...hashes, [name]: 'a'.repeat(64) }, releaseScope: 'full',
    rawResponse: versions.slice(0, 75).map(version => ({ version })) }));
});

test('new receipts require every exact Boolean/key and cannot cross pending/completed boundaries', () => {
  for (const receipt of receipts) {
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt }; delete missing[key]; assert.throws(() => productionReleaseBoundaryReceipt(missing));
      for (const value of [null, '', 'true', 'false', 0, 1, ...(typeof receipt[key] === 'boolean' ? [!receipt[key]] : [])])
        assert.throws(() => productionReleaseBoundaryReceipt({ ...receipt, [key]: value }));
    }
    assert.throws(() => productionReleaseBoundaryReceipt({ ...receipt, extra: false }));
    assert.throws(() => parseExpectedProductionReleaseBoundary(JSON.stringify(receipt, null, 2)));
    assert.throws(() => verifyUnchangedProductionReleaseBoundary({ expectedReceipt: JSON.stringify(receipt),
      actual: receipts.find(value => value.mode !== receipt.mode) }));
  }
});

test('exact75 preflight plus all53 frozen checks precede selection and every mutable release job', async () => {
  const workflow = await readFile(workflowUrl, 'utf8'), policy = job(workflow, 'repeatable-cutover-policy');
  const initial = step(policy, 'Classify the exact read-only production migration boundary');
  assert(initial.includes('if [[ "$requires_exact75_backup" == "true" ]]; then'));
  assert(initial.includes('elif [[ "$mode" == "post76-reviewed-release" ]]; then'));
  for (const file of ['verify-admin-activation-review-index-preflight.mjs', 'verify-production-post75-catalogs.mjs', 'verify-production-post76-catalogs.mjs'])
    assert(normalized(initial).includes(clean(file)), file);
  assert(initial.indexOf('verify-production-repeatable-cutover-policy.mjs') < initial.indexOf('verify-admin-activation-review-index-preflight.mjs'));
  assert(policy.indexOf('verify-admin-activation-review-index-preflight.mjs') < policy.indexOf('Select the fresh exact-75 encrypted backup artifact'));
  assert.equal(policy.match(/SUPABASE_ACCESS_TOKEN:/g)?.length, 1);
  for (const name of ['cloudflare-policy', 'canary-policy', 'backend', 'frontend-rollback-history', 'frontend', 'deploy'])
    assert(job(workflow, name).includes('repeatable-cutover-policy'), name);
  assert.doesNotMatch(policy, /supabase db push|functions deploy|wrangler|SERVICE_ROLE|privateDecrypt|pg_restore/);
});

test('exact75 artifact is same-commit and attempt-bound, verified again immediately before apply', async () => {
  const workflow = await readFile(workflowUrl, 'utf8'), policy = job(workflow, 'repeatable-cutover-policy'), backend = job(workflow, 'backend');
  assert(policy.includes('requires_exact75_backup: ${{ steps.release-boundary.outputs.requires_exact75_backup }}'));
  for (const key of ['artifact_id', 'run_attempt'])
    assert(policy.includes('steps.post75-backup.outputs.' + key + ' || steps.post74-backup.outputs.' + key));
  const select = step(policy, 'Select the fresh exact-75 encrypted backup artifact');
  const download = step(policy, 'Download only the selected exact-75 encrypted backup artifact');
  const verify = step(policy, 'Verify encrypted exact-75 bytes and restored checkpoint');
  for (const block of [select, download, verify]) assert(block.includes("if: steps.release-boundary.outputs.requires_exact75_backup == 'true'"));
  assert(select.includes('GITHUB_SHA="$GITHUB_SHA"') && select.includes('node scripts/verify-post75-backup-evidence.mjs --select'));
  assert(download.includes('artifact-ids: ${{ steps.post75-backup.outputs.artifact_id }}') && download.includes('inputs.backup_run_id'));
  assert(verify.includes('steps.post75-backup.outputs.run_attempt'));
  for (const text of ['BACKUP_RUN_ATTEMPT="$BACKUP_RUN_ATTEMPT"', 'GITHUB_SHA="$GITHUB_SHA"',
    'PRODUCTION_BACKUP_PUBLIC_KEY="$PRODUCTION_BACKUP_PUBLIC_KEY"', '--directory "$RUNNER_TEMP/post75-backup-evidence"']) assert(verify.includes(text));
  assert.doesNotMatch(select + download + verify, /SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|PRIVATE_KEY|privateDecrypt|pg_restore/);
  const preflightNames = ['Recheck activation-review index preflight and exact75 catalog before backend writes',
    'Recheck activation-review index preflight and exact75 catalog immediately before migration'];
  for (const name of preflightNames) {
    const block = step(backend, name); assert(block.includes("if: needs.repeatable-cutover-policy.outputs.requires_exact75_backup == 'true'"));
    for (const file of ['verify-admin-activation-review-index-preflight.mjs', 'verify-production-post75-catalogs.mjs']) assert(normalized(block).includes(clean(file)));
  }
  assert(backend.indexOf(preflightNames[0]) < backend.indexOf('Configure verified native password-reset email'));
  const sequence = [preflightNames[1], 'Download only the selected exact-75 encrypted backup artifact',
    'Reverify fresh exact-75 evidence immediately before migration', 'Recheck the approved exact migration boundary immediately before apply', 'Apply database migrations'];
  const offsets = sequence.map(name => backend.indexOf(name)); assert(offsets.every((value, index) => value > 0 && (!index || value > offsets[index - 1])));
  assert.equal(backend.slice(offsets[3], offsets[4]).match(/- name:/g)?.length, 1);
  assert(step(backend, sequence[3]).includes('EXPECTED_RELEASE_BOUNDARY="$EXPECTED_RELEASE_BOUNDARY"'));
  for (const name of sequence.slice(1, 3)) assert(step(backend, name).includes("if: needs.repeatable-cutover-policy.outputs.requires_exact75_backup == 'true'"));
  assert(step(backend, sequence[1]).includes('needs.repeatable-cutover-policy.outputs.backup_artifact_id'));
  const repeated = step(backend, sequence[2]); assert(repeated.includes('needs.repeatable-cutover-policy.outputs.backup_run_attempt'));
  for (const text of ['GITHUB_SHA="$GITHUB_SHA"', 'BACKUP_RUN_ATTEMPT="$BACKUP_RUN_ATTEMPT"', 'verify-post75-backup-evidence.mjs']) assert(repeated.includes(text));
  assert.equal(workflow.match(/node scripts\/verify-admin-activation-review-index-preflight\.mjs/g)?.length, 3);
});

test('every admitted mode executes exactly one complete postflight family, with no unchecked gap', async () => {
  const backend = job(await readFile(workflowUrl, 'utf8'), 'backend');
  const families = [
    ['Verify source-fixed account-request inbox catalog', 'Verify source-fixed original77 completion catalog', 'Verify source-fixed repeatable challenge catalog', 'Verify source-fixed Admin cleanup health catalog'],
    ['Verify exact75 composed catalogs and guarded profile-name correction'],
    ['Verify exact76 composed catalogs and guarded legacy activation reviews'],
  ];
  const conditions = families.map(names => names.map(name => {
    const block = step(backend, name); assert.doesNotMatch(block, /continue-on-error|\|\| true/);
    const lines = block.split('\n').map(line => line.trim()).filter(line => line.startsWith('if: ')); assert.equal(lines.length, 1);
    return lines[0].slice(4);
  }));
  for (const family of conditions) assert(family.every(value => value === family[0]));
  const enabled = (expression, mode) => expression.split(' || ').some(part => part.split(' && ').every(atom => {
    const match = atom.match(/^needs\.repeatable-cutover-policy\.outputs\.mode (==|!=) '([a-z0-9-]+)'$/); assert(match, atom);
    return match[1] === '==' ? mode === match[2] : mode !== match[2];
  }));
  const modes = ['repeatable-challenge-cutover', 'post-repeatable-challenge-cutover', 'post71-additive-release', 'post73-reviewed-release',
    'post73-additive-release', 'post74-reviewed-release', 'post74-additive-release', 'post75-reviewed-release', 'post75-additive-release', 'post76-reviewed-release'];
  for (const [index, mode] of modes.entries()) assert.deepEqual(conditions.map(family => enabled(family[0], mode)),
    [index < 6, index >= 6 && index < 8, index >= 8]);
  const post = step(backend, families[2][0]); assert(normalized(post).includes(clean('verify-production-post76-catalogs.mjs')));
  assert(backend.indexOf(families[2][0]) > backend.indexOf('Require exact completed migration history'));
  assert(backend.indexOf(families[2][0]) < backend.indexOf('Synchronize Edge Function secrets'));
});

test('backup and CI wiring add exact75 recovery without new secrets, weaker protection or skipped historical checks', async () => {
  const backup = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  assert(backup.includes('          - post-admin-profile-name-75\n'));
  assert.match(backup, /environment: production/); assert.match(backup, /group: production-release\n  cancel-in-progress: false/);
  assert.match(backup, /timeout-minutes: 30/); assert.match(backup, /retention-days: 7/);
  const capture = step(backup, 'Capture and rehearse restore');
  for (const key of ['PROFILE_PHOTO_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET']) {
    const line = capture.split('\n').find(line => line.trimStart().startsWith(key + ':')); assert(line.includes("inputs.backup_mode == 'post-admin-profile-name-75'"));
  }
  assert.doesNotMatch(backup, /PRIVATE_KEY|PROFILE_PHOTO_HEALTH_SECRET|EARLY_ACCESS_INVITATION_ENCRYPTION_KEY/);
  assert(step(backup, 'Verify exact75 admin profile name encrypted evidence').includes('node scripts/verify-post75-backup-evidence.mjs'));
  assert(step(backup, 'Revoke temporary login roles after interruption').includes('if: always()'));
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const file of ['free-backup-post74.sql.test.mjs', 'free-backup-post75.sql.test.mjs', 'verify-production-post75-catalogs.sql.test.mjs', 'verify-production-post76-catalogs.sql.test.mjs']) assert(ci.includes(file));
  assert(ci.includes('pnpm run test:post75-release') && ci.includes('pnpm run test:site-admin-activation-review-health-sql'));
  assert.equal(pkg.scripts['test:site-admin-activation-review-health-sql'], 'node --test scripts/site-admin-activation-review-health.sql.test.mjs');
  for (const file of ['verify-post75-release-plan.test.mjs', 'verify-post75-backup-evidence.test.mjs', 'free-backup-post75.test.mjs', 'post75-release-workflow.test.mjs', 'verify-admin-activation-review-index-preflight.test.mjs', 'verify-production-post76-catalogs.test.mjs']) assert(pkg.scripts['test:post75-release'].includes(file));
  assert.match(job(ci, 'database'), /timeout-minutes: 40/); assert.doesNotMatch(ci, /continue-on-error:\s*true/);
  const latest = await readFile(new URL('./latest-schema-pgtap.sql.test.mjs', import.meta.url), 'utf8');
  assert(latest.includes('verifyPost75ReleaseSources({ migrationFilenames, migrationSourceHashes });'));
  assert(latest.indexOf('verifyPost75ReleaseSources({') < latest.indexOf('fixture = await createOriginal77FullchainFixture'));
  assert(latest.includes('POST74_REVIEWED_MIGRATION, POST75_REVIEWED_MIGRATION]'));
});
