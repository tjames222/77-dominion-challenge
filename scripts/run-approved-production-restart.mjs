import { execFile } from 'node:child_process';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { restartSubprocessEnvironment } from './prepare-production-canary-restart-proof.mjs';

const execute = promisify(execFile);
export const REPOSITORY = 'tjames222/77-dominion-challenge';
export const PRODUCTION_ENVIRONMENT_ID = 19832155387;
export const CONTROLLER_BUDGET_MS = 105 * 60 * 1000;
const priorRelease = '0507c5e3b63d03f5e8ce7781aad463134d992871';
const origin = 'https://77-dominion-live.pages.dev';
const workflows = Object.freeze({ restart: 'restart-production-canary.yml', compatibility: 'deploy.yml', full: 'deploy.yml', revoke: 'manage-production-canary-entitlement.yml' });
const idPattern = /^[1-9][0-9]{0,15}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;

class Stop extends Error {
  constructor(message, terminal = false) { super(message); this.terminal = terminal; }
}
function requireThat(condition, message) { if (!condition) throw new Stop(message); }
function parseJson(output) {
  try { return JSON.parse(output); } catch { throw new Stop('GitHub response was not valid JSON; inspect the journal before any further action.'); }
}
function iso(value) { return new Date(value).toISOString(); }

export function verifyControllerRun(run, { runId, workflow, releaseSha, dispatchedAt, nowMs }) {
  requireThat(run && String(run.id) === runId && run.head_sha === releaseSha
    && run.head_branch === 'main' && run.event === 'workflow_dispatch'
    && run.path === `.github/workflows/${workflow}` && run.run_attempt === 1
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  'Run identity changed or is not the exact first-attempt protected-main workflow.');
  const created = Date.parse(run.created_at);
  requireThat(Number.isFinite(created) && created >= dispatchedAt - 5000 && created <= nowMs + 5000,
    'Dispatched run timestamp is outside the exact dispatch boundary.');
  requireThat(['queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed'].includes(run.status),
    'Unexpected workflow state; no further action was taken.');
  return run;
}

export async function verifyPublicRelease({ repository, fetchImpl = fetch }) {
  const title = text => text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1].replace(/\s+/gu, ' ').trim();
  for (const file of ['login.html', 'invite.html', 'reset-password.html']) {
    const expectedTitle = title(await readFile(path.join(repository, file), 'utf8'));
    requireThat(Boolean(expectedTitle), 'Reviewed public page has no title.');
    let url = new URL(`/${file}`, origin);
    let verified = false;
    for (let hop = 0; hop < 5; hop++) {
      requireThat(url.origin === origin && !url.username && !url.password, 'Public redirect left the reviewed origin.');
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        requireThat(Boolean(location), 'Public redirect had no location.');
        url = new URL(location, url);
        continue;
      }
      requireThat(response.status === 200 && /^text\/html\b/iu.test(response.headers.get('content-type') ?? ''), 'Public release page did not return HTML 200.');
      const bytes = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        requireThat(size <= 2 * 1024 * 1024, 'Public release page exceeded the size boundary.');
        bytes.push(chunk);
      }
      requireThat(title(Buffer.concat(bytes).toString('utf8')) === expectedTitle, 'Public release returned a fallback or unexpected page.');
      if (file === 'invite.html') {
        const policies = (response.headers.get('referrer-policy') ?? '').split(',').map(value => value.trim());
        requireThat(policies.at(-1) === 'no-referrer', 'Canonical invite page is missing its final no-referrer policy.');
      }
      verified = true;
      break;
    }
    requireThat(verified, 'Public release exceeded the redirect boundary.');
  }
}

// The injected interfaces support offline tests. Production supplies only the
// fixed local gh CLI, append-only fsynced journal, and reviewed public HTTP probe.
export async function runApprovedRestart({ releaseSha, backupRunId, gh, journal, smoke,
  wallNow = Date.now, monotonicNow = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), progress = () => {} }) {
  requireThat(shaPattern.test(releaseSha ?? '') && releaseSha !== priorRelease && idPattern.test(backupRunId ?? ''), 'Canonical new release and backup run are required.');
  const wallStart = wallNow();
  const monotonicStart = monotonicNow();
  const runs = {};
  let restartSucceeded = false;
  function budget() {
    const wallElapsed = wallNow() - wallStart;
    const monotonicElapsed = monotonicNow() - monotonicStart;
    requireThat(wallElapsed >= 0 && monotonicElapsed >= 0 && Math.max(wallElapsed, monotonicElapsed) < CONTROLLER_BUDGET_MS,
      'Conservative release deadline reached; do not renew or redispatch. Inspect running jobs and the grant.');
  }
  async function api(suffix) { return parseJson(await gh(['api', `repos/${REPOSITORY}${suffix}`])); }
  async function frozen() {
    const ref = await api('/git/ref/heads/main');
    requireThat(ref?.object?.sha === releaseSha && ref?.object?.type === 'commit', 'Main is no longer the frozen release; no further mutation is permitted.');
  }
  await journal({ event: 'start', releaseSha, backupRunId, at: iso(wallStart), budgetMinutes: 105 });
  requireThat((await gh(['api', 'user', '--jq', '.login'])).trim() === 'tjames222', 'The approved GitHub operator account is not signed in.');
  await frozen();

  async function dispatchAndWait(phase, inputs) {
    budget();
    await frozen();
    budget();
    const workflow = workflows[phase];
    requireThat(Boolean(workflow) && !runs[phase], 'A workflow phase cannot be dispatched twice.');
    const dispatchedAt = wallNow();
    await journal({ event: 'dispatch-intent', phase, workflow, releaseSha, inputs, at: iso(dispatchedAt) });
    budget(); // A durable write can span machine sleep; recheck before mutation.
    let output;
    try {
      output = await gh(['workflow', 'run', workflow, '--repo', REPOSITORY, '--ref', 'main', ...Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`])]);
    } catch {
      await journal({ event: 'dispatch-uncertain', phase, at: iso(wallNow()) });
      throw new Stop('Dispatch outcome is uncertain; never repeat it automatically. Inspect the saved intent.');
    }
    const match = output.trim().match(/^https:\/\/github\.com\/tjames222\/77-dominion-challenge\/actions\/runs\/([1-9][0-9]{0,15})$/u);
    if (!match) {
      await journal({ event: 'dispatch-uncertain', phase, at: iso(wallNow()) });
      throw new Stop('Dispatch did not return one exact run URL; do not redispatch.');
    }
    const runId = match[1];
    runs[phase] = runId;
    await journal({ event: 'dispatched', phase, runId, at: iso(wallNow()) });
    progress({ event: 'dispatched', phase, runId });
    const approvedGates = new Set();
    let lastStatus = '';
    while (true) {
      budget();
      const run = verifyControllerRun(await api(`/actions/runs/${runId}`), { runId, workflow, releaseSha, dispatchedAt, nowMs: wallNow() });
      if (run.status !== lastStatus) {
        progress({ event: 'status', phase, runId, status: run.status });
        lastStatus = run.status;
      }
      if (run.status === 'completed') {
        await journal({ event: 'completed', phase, runId, conclusion: run.conclusion, at: iso(wallNow()) });
        if (run.conclusion !== 'success') throw new Stop(`${phase} completed without success.`, true);
        return runId;
      }
      const pending = await api(`/actions/runs/${runId}/pending_deployments`);
      requireThat(Array.isArray(pending) && pending.length <= 1, 'Unexpected production approval inventory.');
      if (pending.length) {
        const gate = pending[0];
        requireThat(gate.environment?.id === PRODUCTION_ENVIRONMENT_ID && gate.environment?.name === 'production', 'Approval targeted an unexpected environment.');
        const jobList = await api(`/actions/runs/${runId}/jobs?per_page=100`);
        requireThat(Array.isArray(jobList?.jobs) && jobList.total_count === jobList.jobs.length && jobList.jobs.length <= 100, 'Job inventory is incomplete.');
        for (const job of jobList.jobs) {
          requireThat(Number.isSafeInteger(job.id) && job.id > 0 && String(job.run_id) === runId && job.head_sha === releaseSha, 'A job does not belong to the exact run and commit.');
        }
        const waiting = jobList.jobs.filter(job => job.status === 'waiting').map(job => job.id).sort((a, b) => a - b);
        const gateKey = waiting.join(',');
        if (waiting.length && !approvedGates.has(gateKey)) {
          requireThat(gate.current_user_can_approve === true, 'The exact production gate is not available to the approved operator.');
          await frozen();
          budget();
          await journal({ event: 'approval-intent', phase, runId, environmentId: PRODUCTION_ENVIRONMENT_ID, waitingJobs: waiting, at: iso(wallNow()) });
          budget(); // Never approve after a pause inside journal persistence.
          let approval;
          try {
            approval = parseJson(await gh(['api', '--method', 'POST', `repos/${REPOSITORY}/actions/runs/${runId}/pending_deployments`, '-F', `environment_ids[]=${PRODUCTION_ENVIRONMENT_ID}`, '-f', 'state=approved', '-f', `comment=Approved one-time archived restart release ${releaseSha}, phase ${phase}; existing checks remain enforced.`]));
            requireThat(Array.isArray(approval) && approval.length > 0 && approval.every(item => item.environment === 'production' && item.sha === releaseSha && Number.isSafeInteger(item.id) && item.id > 0), 'Approval response did not bind the exact deployment.');
          } catch {
            await journal({ event: 'approval-uncertain', phase, runId, at: iso(wallNow()) });
            throw new Stop('Approval outcome is uncertain; do not repeat it automatically. Inspect the exact run.');
          }
          approvedGates.add(gateKey);
          await journal({ event: 'approved', phase, runId, deploymentIds: approval.map(item => item.id), at: iso(wallNow()) });
          progress({ event: 'approved', phase, runId });
        }
      }
      await sleep(15000);
    }
  }

  try {
    await dispatchAndWait('restart', { backup_run_id: backupRunId, confirm_archived_restart: 'true' });
    restartSucceeded = true;
    await dispatchAndWait('compatibility', { release_scope: 'compatibility-cutover', backup_run_id: backupRunId });
    budget();
    await smoke();
    await journal({ event: 'compatibility-public-http-verified', at: iso(wallNow()) });
    await dispatchAndWait('full', { release_scope: 'full' });
    budget();
    await smoke();
    await journal({ event: 'success', runs, at: iso(wallNow()), ownerTestingPending: true, revokeStillRequired: true });
    return { releaseSha, runs, ownerTestingPending: true, revokeStillRequired: true };
  } catch (error) {
    await journal({ event: 'stopped', runs, terminalFailure: error instanceof Stop && error.terminal, at: iso(wallNow()) });
    // Cleanup is permitted only after a verified grant and an authoritative
    // terminal workflow failure. Never revoke during uncertain/running migration.
    if (restartSucceeded && error instanceof Stop && error.terminal && !runs.revoke) {
      try {
        await dispatchAndWait('revoke', { operation: 'revoke', confirm_production_change: 'true' });
        await journal({ event: 'failure-canary-revoked', runId: runs.revoke, at: iso(wallNow()) });
      } catch {
        await journal({ event: 'revoke-needs-inspection', at: iso(wallNow()) });
      }
    }
    throw error;
  }
}

export async function createControllerJournal(filename) {
  requireThat(path.isAbsolute(filename), 'Journal path must be absolute.');
  const parent = path.dirname(filename);
  const stat = await lstat(parent);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700 && await realpath(parent) === parent, 'Journal parent must be an ordinary owner-only directory.');
  const handle = await open(filename, 'ax', 0o600);
  try {
    const opened = await handle.stat();
    requireThat(opened.isFile() && opened.nlink === 1 && opened.uid === process.getuid() && (opened.mode & 0o777) === 0o600, 'Journal must be a new private ordinary file.');
  } catch (error) { await handle.close(); throw error; }
  return {
    append: async value => { await handle.appendFile(`${JSON.stringify(value)}\n`); await handle.sync(); },
    close: () => handle.close(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  requireThat(args.length === 7 && args[0] === '--release-sha' && args[2] === '--backup-run-id'
    && args[4] === '--state-file' && args[6] === '--approve-protected-production', 'Expected exact release, backup, fresh journal, and protected-approval flags.');
  const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const env = restartSubprocessEnvironment();
  const command = async (binary, argv) => {
    try { return (await execute(binary, argv, { cwd: repository, env, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout; }
    catch { throw new Stop('A fixed local command failed or timed out; inspect the journal without repeating mutations.'); }
  };
  requireThat((await command('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'])).trim() === args[1]
    && (await command('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal'])).trim() === '', 'The local operator must run from the clean exact reviewed release.');
  const journal = await createControllerJournal(args[5]);
  try {
    const result = await runApprovedRestart({ releaseSha: args[1], backupRunId: args[3], gh: argv => command('gh', argv), journal: journal.append,
      smoke: () => verifyPublicRelease({ repository }), progress: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify(result));
  } finally { await journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Stop ? error.message : 'Approved release controller stopped; inspect its private journal before further action.'); process.exitCode = 1; });
}
