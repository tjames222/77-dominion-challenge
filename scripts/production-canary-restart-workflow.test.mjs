import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('archived restart has one explicit manual confirmation and one protected mutation job', async () => {
  const workflow = await read('.github/workflows/restart-production-canary.yml');
  assert.match(workflow, /on:\n  workflow_dispatch:\n    inputs:\n      backup_run_id:/u);
  assert.match(workflow, /confirm_archived_restart:[\s\S]*?required: true\n        default: false\n        type: boolean/u);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read\n/u);
  assert.match(workflow, /concurrency:\n  group: production-release\n  cancel-in-progress: false/u);
  assert.equal((workflow.match(/environment: production/gu) ?? []).length, 1);
  for (const boundary of ['$GITHUB_EVENT_NAME" == workflow_dispatch', '$GITHUB_REPOSITORY" == tjames222/77-dominion-challenge',
    '$GITHUB_REF" == refs/heads/main', '$CONFIRM_ARCHIVED_RESTART" == true',
    '$GITHUB_SHA" != 0507c5e3b63d03f5e8ce7781aad463134d992871']) assert.ok(workflow.includes(boundary));
  assert.match(workflow, /restart:\n[\s\S]*?needs: authorize\n[\s\S]*?timeout-minutes: 5\n    environment: production/u);
  assert.doesNotMatch(workflow, /pull_request_target:|schedule:|workflow_call:|secrets: inherit|write-all|continue-on-error: true/u);
});

test('restart selects exact same-release artifact with pinned actions before accessing production credential', async () => {
  const workflow = await read('.github/workflows/restart-production-canary.yml');
  const actions = [...workflow.matchAll(/uses: ([^\s#]+)/gu)].map(match => match[1]);
  assert.deepEqual(actions, [
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  ]);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/u);
  assert.match(workflow, /node scripts\/verify-free-production-backup-evidence\.mjs --select/u);
  assert.match(workflow, /artifact-ids: \$\{\{ steps\.backup\.outputs\.artifact_id \}\}/u);
  assert.match(workflow, /repository: tjames222\/77-dominion-challenge\n          run-id: \$\{\{ inputs\.backup_run_id \}\}/u);
  assert.equal((workflow.match(/secrets\.SUPABASE_ACCESS_TOKEN/gu) ?? []).length, 1);
  assert.ok(workflow.indexOf('name: Verify the signed recovery proof') < workflow.indexOf('secrets.SUPABASE_ACCESS_TOKEN'));
  for (const name of ['PRODUCTION_BACKUP_PUBLIC_KEY', 'PRODUCTION_CANARY_RESTART_PUBLIC_KEY', 'PRODUCTION_CANARY_RESTART_RECOVERY_PROOF']) {
    assert.ok(workflow.includes(`vars.${name}`));
  }
  assert.match(workflow, /set \+x\n          umask 077\n          ulimit -c 0\n          \/usr\/bin\/env -i/u);
  assert.match(workflow, /node scripts\/restart-production-canary\.mjs \\\n              --backup-directory "\$RUNNER_TEMP\/production-restart-backup"/u);
  assert.doesNotMatch(workflow, /PRIVATE_KEY|upload-artifact|supabase db reset|migration repair|CLOUDFLARE_API_TOKEN/u);
});

test('required Database validation exercises both new offline and actual isolated SQL boundaries', async () => {
  const ci = await read('.github/workflows/ci.yml');
  const pkg = JSON.parse(await read('package.json'));
  assert.ok(ci.includes('run: pnpm run test:production-canary-restart\n'));
  assert.ok(ci.includes('run: pnpm run test:production-canary-restart-sql\n'));
  for (const file of ['production-canary-restart-proof', 'prepare-production-canary-restart-proof', 'restart-production-canary',
    'run-approved-production-restart', 'production-canary-restart-workflow']) {
    assert.ok(pkg.scripts['test:production-canary-restart'].includes(`scripts/${file}.test.mjs`));
  }
  assert.equal(pkg.scripts['test:production-canary-restart-sql'], 'node --test scripts/restart-production-canary.sql.test.mjs');
});

test('ordinary grant, compatibility and full still enforce the original closed canary contract', async () => {
  const grant = await read('scripts/manage-production-canary-entitlement.mjs');
  const deploy = await read('.github/workflows/deploy.yml');
  assert.ok(grant.includes('zero existing membership entitlements'));
  assert.doesNotMatch(grant, /restartCanaryQuery|restartProductionCanary|PRODUCTION_CANARY_RESTART/u);
  for (const value of ['VITE_ENABLE_PUBLIC_SIGNUP: "false"', 'VITE_ENABLE_BILLING: "false"', 'BILLING_ENABLED: "false"']) {
    assert.ok(deploy.includes(value), value);
  }
  assert.ok(deploy.includes('verify-production-canary-cutover-gate.mjs'));
  assert.ok(deploy.includes('verify-free-production-backup-evidence.mjs'));
  assert.match(deploy, /concurrency:\n  group: production-release\n  cancel-in-progress: false/u);
  assert.doesNotMatch(deploy, /PRODUCTION_CANARY_RESTART|restart-production-canary/u);
});
