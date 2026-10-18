import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/deploy.yml', import.meta.url);
const job = (text, name) => {
  const start = text.indexOf('  ' + name + ':');
  assert(start >= 0);
  const rest = text.slice(start + 3);
  const next = rest.search(/^  [a-z][a-z0-9-]*:\s*$/mu);
  return text.slice(start, next < 0 ? undefined : start + 3 + next);
};
const step = (text, name) => {
  const start = text.indexOf('      - name: ' + name + '\n');
  assert(start >= 0, name);
  const end = text.indexOf('      - name:', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
const clean = script => [
  '/usr/bin/env -i \\', '  PATH="$PATH" \\',
  '  SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \\',
  '  SUPABASE_PROJECT_REF="$SUPABASE_PROJECT_REF" \\',
  '  node scripts/' + script,
].join('\n');
const normalized = text => text.split('\n').map(line => line.trimStart()).join('\n');
const cleanPattern = script => normalized(clean(script));

test('job extraction stops before the next job', () => {
  const fixture = 'jobs:\n  first:\n    timeout-minutes: 1\n  second:\n    needs: first\n';
  assert.equal(job(fixture, 'first'), '  first:\n    timeout-minutes: 1\n');
  assert.equal(job(fixture, 'second'), '  second:\n    needs: first\n');
});

test('fixed receipt preserves eight historical combinations and adds only two reviewed75-to76 combinations', async () => {
  const text = job(await readFile(workflowUrl, 'utf8'), 'repeatable-cutover-policy');
  assert(text.includes('requires_exact74_backup:'));
  assert(text.includes('steps.post74-backup.outputs.artifact_id || steps.post73-backup.outputs.artifact_id || steps.post71-backup.outputs.artifact_id'));
  assert(text.includes('steps.post74-backup.outputs.run_attempt || steps.post73-backup.outputs.run_attempt || steps.post71-backup.outputs.run_attempt'));
  const choices = text.match(/case "\$mode:\$requires_exact71_backup:\$requires_exact73_backup:\$requires_exact74_backup:\$requires_exact75_backup" in\n\s+([^\n]+)\) ;;/)?.[1].split('|');
  assert.deepEqual(choices, [
    'repeatable-challenge-cutover:false:false:false:false', 'post-repeatable-challenge-cutover:false:false:false:false',
    'post71-additive-release:true:false:false:false', 'post73-reviewed-release:false:false:false:false',
    'post73-additive-release:false:true:false:false', 'post74-reviewed-release:false:false:false:false',
    'post74-additive-release:false:false:true:false', 'post75-reviewed-release:false:false:false:false',
    'post75-additive-release:false:false:false:true', 'post76-reviewed-release:false:false:false:false',
  ]);
  assert.match(text, /\*\) echo "::error::The release boundary receipt is invalid."; exit 1/);
});

test('exact74 preflight and frozen74 attestation precede any mutable job; completed75 gets its distinct attestation', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const policy = job(workflow, 'repeatable-cutover-policy');
  const initial = step(policy, 'Classify the exact read-only production migration boundary');
  assert(initial.includes('if [[ "$requires_exact74_backup" == "true" ]]; then'));
  assert(initial.includes('elif [[ "$mode" == "post75-reviewed-release" ]]; then'));
  for (const file of ['verify-admin-profile-name-preflight.mjs', 'verify-production-admin-cleanup-health.mjs', 'verify-production-post75-catalogs.mjs']) {
    assert(normalized(initial).includes(cleanPattern(file)), file);
  }
  assert(initial.indexOf('verify-production-repeatable-cutover-policy.mjs') < initial.indexOf('verify-admin-profile-name-preflight.mjs'));
  assert(policy.indexOf('verify-admin-profile-name-preflight.mjs') < policy.indexOf('Select the fresh exact-74 encrypted backup artifact'));
  for (const name of ['cloudflare-policy', 'canary-policy', 'backend', 'frontend-rollback-history', 'frontend', 'deploy']) {
    assert(job(workflow, name).includes('repeatable-cutover-policy'), name);
  }
});

test('initial exact74 evidence uses same commit, unique artifact and attempt with no database or decryption input', async () => {
  const policy = job(await readFile(workflowUrl, 'utf8'), 'repeatable-cutover-policy');
  const select = step(policy, 'Select the fresh exact-74 encrypted backup artifact');
  const download = step(policy, 'Download only the selected exact-74 encrypted backup artifact');
  const verify = step(policy, 'Verify encrypted exact-74 bytes and restored checkpoint');
  for (const block of [select, download, verify]) assert(block.includes("if: steps.release-boundary.outputs.requires_exact74_backup == 'true'"));
  assert(select.includes('GITHUB_SHA="$GITHUB_SHA"'));
  assert(select.includes('node scripts/verify-post74-backup-evidence.mjs --select'));
  assert(select.includes('read -r artifact_id backup_run_attempt'));
  assert(download.includes('artifact-ids:') && download.includes('steps.post74-backup.outputs.artifact_id'));
  assert(download.includes('inputs.backup_run_id'));
  assert(verify.includes('steps.post74-backup.outputs.run_attempt'));
  assert(verify.includes('BACKUP_RUN_ATTEMPT="$BACKUP_RUN_ATTEMPT"'));
  assert(verify.includes('PRODUCTION_BACKUP_PUBLIC_KEY="$PRODUCTION_BACKUP_PUBLIC_KEY"'));
  assert(verify.includes('GITHUB_SHA="$GITHUB_SHA"'));
  assert(verify.includes('node scripts/verify-post74-backup-evidence.mjs'));
  assert(verify.includes('--directory "$RUNNER_TEMP/post74-backup-evidence"'));
  assert.doesNotMatch(select + download + verify, /SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|PRIVATE_KEY|privateDecrypt|pg_restore|decryptBackup/);
});

test('backend repeats both74 preflights before provider writes and immediately before exact backup/boundary/apply', async () => {
  const backend = job(await readFile(workflowUrl, 'utf8'), 'backend');
  const names = ['Recheck profile-name preflight and exact74 catalog before backend writes',
    'Recheck profile-name preflight and exact74 catalog immediately before migration'];
  for (const name of names) {
    const block = step(backend, name);
    assert(block.includes("if: needs.repeatable-cutover-policy.outputs.requires_exact74_backup == 'true'"));
    assert(block.includes('timeout-minutes: 1'));
    for (const file of ['verify-admin-profile-name-preflight.mjs', 'verify-production-admin-cleanup-health.mjs']) {
      assert(normalized(block).includes(cleanPattern(file)));
    }
  }
  assert(backend.indexOf(names[0]) < backend.indexOf('Configure verified native password-reset email'));
  const sequence = [names[1], 'Download only the selected exact-74 encrypted backup artifact',
    'Reverify fresh exact-74 evidence immediately before migration',
    'Recheck the approved exact migration boundary immediately before apply', 'Apply database migrations'];
  const offsets = sequence.map(name => backend.indexOf(name));
  assert(offsets.every((offset, index) => offset > 0 && (!index || offset > offsets[index - 1])));
  const boundary = step(backend, sequence[3]);
  assert(boundary.includes('EXPECTED_RELEASE_BOUNDARY="$EXPECTED_RELEASE_BOUNDARY"'));
  assert.equal(backend.slice(offsets[3], offsets[4]).match(/- name:/g)?.length, 1);
  for (const name of sequence.slice(1, 3)) assert(step(backend, name).includes("if: needs.repeatable-cutover-policy.outputs.requires_exact74_backup == 'true'"));
  const download = step(backend, sequence[1]), verify = step(backend, sequence[2]);
  assert(download.includes('needs.repeatable-cutover-policy.outputs.backup_artifact_id'));
  assert(download.includes('inputs.backup_run_id'));
  assert(verify.includes('needs.repeatable-cutover-policy.outputs.backup_run_attempt'));
  for (const text of ['GITHUB_SHA="$GITHUB_SHA"', 'BACKUP_RUN_ATTEMPT="$BACKUP_RUN_ATTEMPT"',
    'PRODUCTION_BACKUP_PUBLIC_KEY="$PRODUCTION_BACKUP_PUBLIC_KEY"', 'verify-post74-backup-evidence.mjs']) assert(verify.includes(text));
});

test('old four postflights exclude both later exact catalogs while75 retains its exact two modes', async () => {
  const backend = job(await readFile(workflowUrl, 'utf8'), 'backend');
  const oldCondition = "if: needs.repeatable-cutover-policy.outputs.mode != 'post74-additive-release' && needs.repeatable-cutover-policy.outputs.mode != 'post75-reviewed-release' && needs.repeatable-cutover-policy.outputs.mode != 'post75-additive-release' && needs.repeatable-cutover-policy.outputs.mode != 'post76-reviewed-release'";
  const newCondition = "if: needs.repeatable-cutover-policy.outputs.mode == 'post74-additive-release' || needs.repeatable-cutover-policy.outputs.mode == 'post75-reviewed-release'";
  for (const name of ['Verify source-fixed account-request inbox catalog', 'Verify source-fixed original77 completion catalog',
    'Verify source-fixed repeatable challenge catalog', 'Verify source-fixed Admin cleanup health catalog']) {
    const block = step(backend, name);
    assert.deepEqual(block.split('\n').map(line => line.trim()).filter(line => line.startsWith('if:')), [oldCondition]);
    assert.doesNotMatch(block, /continue-on-error|\|\| true/);
  }
  const name = 'Verify exact75 composed catalogs and guarded profile-name correction';
  const block = step(backend, name);
  assert.deepEqual(block.split('\n').map(line => line.trim()).filter(line => line.startsWith('if:')), [newCondition]);
  assert(normalized(block).includes(cleanPattern('verify-production-post75-catalogs.mjs')));
  assert.doesNotMatch(block, /continue-on-error|\|\| true/);
  assert(backend.indexOf(name) > backend.indexOf('Require exact completed migration history'));
  assert(backend.indexOf(name) < backend.indexOf('Synchronize Edge Function secrets'));
});

test('new validations are additive and preserve required job budgets and historical archive fixtures', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const file of ['free-backup-post-repeatable.sql.test.mjs', 'free-backup-post73.sql.test.mjs', 'free-backup-post74.sql.test.mjs',
    'verify-production-post75-catalogs.sql.test.mjs', 'verify-post71-catalog-history.sql.test.mjs']) assert(ci.includes(file), file);
  assert(ci.includes('pnpm run test:post74-release'));
  assert(ci.includes('pnpm run test:site-admin-profile-name-sql'));
  assert.equal(pkg.scripts['test:site-admin-profile-name-sql'], 'node --test scripts/site-admin-profile-name.sql.test.mjs');
  for (const file of ['verify-post74-release-plan.test.mjs', 'verify-post74-backup-evidence.test.mjs', 'free-backup-post74.test.mjs',
    'post74-release-workflow.test.mjs', 'verify-admin-profile-name-preflight.test.mjs',
    'verify-production-admin-profile-name.test.mjs', 'verify-production-post75-catalogs.test.mjs']) assert(pkg.scripts['test:post74-release'].includes(file));
  assert.match(job(ci, 'database'), /timeout-minutes: 40/);
  assert.doesNotMatch(ci, /continue-on-error:\s*true/);
});
