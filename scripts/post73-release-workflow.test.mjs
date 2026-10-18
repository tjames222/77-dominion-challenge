import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const jobBlock = (workflow, name) => {
  const start = workflow.indexOf('  ' + name + ':');
  assert(start >= 0);
  const remainder = workflow.slice(start + 3);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\s*$/mu);
  return workflow.slice(start, next < 0 ? undefined : start + 3 + next);
};

test('exact73 evidence gate precedes all mutable jobs with exact artifact/attempt identity', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const policy = jobBlock(workflow, 'repeatable-cutover-policy');
  assert.match(policy, /requires_exact73_backup: \$\{\{ steps\.release-boundary\.outputs\.requires_exact73_backup \}\}/u);
  assert.match(policy, /post73-additive-release:false:true:false:false\|post74-reviewed-release:false:false:false:false/u);
  const gates = policy.slice(policy.indexOf('- name: Select the fresh exact-73 encrypted backup artifact'));
  assert.equal(gates.match(/if: steps\.release-boundary\.outputs\.requires_exact73_backup == 'true'/gu)?.length, 3);
  assert.match(gates, /GITHUB_SHA="\$GITHUB_SHA"[\s\S]*verify-post73-backup-evidence\.mjs --select/u);
  assert.match(gates, /artifact-ids: \$\{\{ steps\.post73-backup\.outputs\.artifact_id \}\}/u);
  assert.match(gates, /BACKUP_RUN_ATTEMPT: \$\{\{ steps\.post73-backup\.outputs\.run_attempt \}\}/u);
  assert.match(gates, /run-id: \$\{\{ inputs\.backup_run_id \}\}/u);
  assert.match(gates, /PRODUCTION_BACKUP_PUBLIC_KEY="\$PRODUCTION_BACKUP_PUBLIC_KEY"[\s\S]*verify-post73-backup-evidence\.mjs[\s\S]*--directory "\$RUNNER_TEMP\/post73-backup-evidence"/u);
  assert.doesNotMatch(gates, /SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|privateDecrypt|pg_restore|decryptBackup/u);
  for (const name of ['cloudflare-policy','canary-policy','compatibility-guards','frontend-rollback-history','backend','frontend','deploy']) {
    assert.match(jobBlock(workflow, name), /repeatable-cutover-policy/u);
  }
});

test('backend downloads the exact selected73 artifact and rechecks bytes/freshness/attempt before apply', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const backend = jobBlock(workflow, 'backend');
  const download = backend.indexOf('Download only the selected exact-73 encrypted backup artifact');
  const verify = backend.indexOf('Reverify fresh exact-73 evidence immediately before migration');
  const boundary = backend.indexOf('Recheck the approved exact migration boundary immediately before apply');
  const apply = backend.indexOf('Apply database migrations');
  assert(download > 0 && download < verify && verify < boundary && boundary < apply);
  const block = backend.slice(download, boundary);
  assert.equal(block.match(/if: needs\.repeatable-cutover-policy\.outputs\.requires_exact73_backup == 'true'/gu)?.length, 2);
  assert.match(block, /artifact-ids: \$\{\{ needs\.repeatable-cutover-policy\.outputs\.backup_artifact_id \}\}/u);
  assert.match(block, /BACKUP_RUN_ATTEMPT: \$\{\{ needs\.repeatable-cutover-policy\.outputs\.backup_run_attempt \}\}/u);
  assert.match(block, /run-id: \$\{\{ inputs\.backup_run_id \}\}/u);
  assert.match(block, /GITHUB_SHA="\$GITHUB_SHA"[\s\S]*verify-post73-backup-evidence\.mjs/u);
  assert.equal(backend.slice(boundary, apply).match(/- name:/gu)?.length, 1);
  assert.match(backend.slice(boundary, apply), /EXPECTED_RELEASE_BOUNDARY="\$EXPECTED_RELEASE_BOUNDARY"/u);
});

test('new73 backup injects exactly the unchanged three worker credentials, no new secret recovery surface', async () => {
  const backup = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  assert.match(backup, /- post-cleanup-monitor-73/u);
  const secretNames = [...new Set([...backup.matchAll(/secrets\.([A-Z_]+)/gu)].map(match => match[1]))].sort();
  assert.deepEqual(secretNames, ['EARLY_ACCESS_INVITATION_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET',
    'PROFILE_PHOTO_WORKER_SECRET', 'SUPABASE_ACCESS_TOKEN']);
  for (const key of secretNames.filter(name => name !== 'SUPABASE_ACCESS_TOKEN')) {
    const line = backup.split('\n').find(value => value.includes(key + ':'));
    assert(line.includes("inputs.backup_mode == 'post-cleanup-monitor-73'"));
    assert(line.includes('&& secrets.' + key + " || ''"));
  }
  assert.match(backup, /if: inputs\.backup_mode == 'post-cleanup-monitor-73'[\s\S]*verify-post73-backup-evidence\.mjs/u);
  assert.match(backup, /retention-days: 7/u);
  assert.match(backup, /environment: production/u);
  assert.doesNotMatch(backup, /PROFILE_PHOTO_HEALTH_SECRET|RESEND_API_KEY|LINEAR_API_KEY|INVITATION_KEY|PRIVATE_KEY/u);
});

test('CI preserves historical71 archive and catalog gates while adding separate73 evidence', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const name of ['free-backup-post-repeatable.sql.test.mjs', 'free-backup-post73.sql.test.mjs',
    'verify-post71-release-plan.test.mjs', 'verify-post73-release-plan.test.mjs',
    'verify-post-repeatable-backup-evidence.test.mjs', 'verify-post73-backup-evidence.test.mjs',
    'verify-post71-catalog-history.sql.test.mjs']) assert(workflow.includes(name), name);
});

test('source-fixed cleanup preflight is required before provider mutations and repeated before database apply', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const policy = jobBlock(workflow, 'repeatable-cutover-policy');
  const classify = policy.indexOf('node scripts/verify-production-repeatable-cutover-policy.mjs');
  const preflight = policy.indexOf('node scripts/verify-admin-cleanup-index-preflight.mjs');
  const backup = policy.indexOf('Select the fresh exact-73 encrypted backup artifact');
  assert(classify > 0 && preflight > classify && backup > preflight);
  assert.match(policy.slice(classify, preflight), /if \[\[ "\$requires_exact73_backup" == "true" \]\]; then/u);
  const backend = jobBlock(workflow, 'backend');
  assert.equal(backend.match(/node scripts\/verify-admin-cleanup-index-preflight\.mjs/gu)?.length, 2);
  const first = backend.indexOf('Recheck cleanup index preflight before backend writes');
  assert(first > 0 && first < backend.indexOf('Configure verified native password-reset email'));
  const last = backend.indexOf('Recheck cleanup index preflight immediately before migration');
  assert(last > first && last < backend.indexOf('Reverify fresh exact-73 evidence immediately before migration'));
  for (const index of [first, last]) {
    const step = backend.slice(index, backend.indexOf('      - name:', index + 1));
    assert.match(step, /if: needs\.repeatable-cutover-policy\.outputs\.requires_exact73_backup == 'true'/u);
    assert.match(step, /SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN"/u);
    assert.match(step, /SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF"/u);
  }
  const postflight = backend.indexOf('Verify source-fixed Admin cleanup health catalog');
  assert(postflight > backend.indexOf('Verify source-fixed repeatable challenge catalog')
    && postflight < backend.indexOf('Synchronize Edge Function secrets'));
  const postflightStep = backend.slice(postflight, backend.indexOf('      - name:', postflight + 1));
  assert.match(postflightStep, /if: needs\.repeatable-cutover-policy\.outputs\.mode != 'post74-additive-release' && needs\.repeatable-cutover-policy\.outputs\.mode != 'post75-reviewed-release' && needs\.repeatable-cutover-policy\.outputs\.mode != 'post75-additive-release' && needs\.repeatable-cutover-policy\.outputs\.mode != 'post76-reviewed-release'\n/u);
  assert.doesNotMatch(postflightStep, /continue-on-error/u);
  assert.match(backend, /name: Verify exact75 composed catalogs and guarded profile-name correction\n        if: needs\.repeatable-cutover-policy\.outputs\.mode == 'post74-additive-release' \|\| needs\.repeatable-cutover-policy\.outputs\.mode == 'post75-reviewed-release'/u);
  assert.match(postflightStep, /node scripts\/verify-production-admin-cleanup-health\.mjs/u);
});
