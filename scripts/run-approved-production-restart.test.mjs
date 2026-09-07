import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTROLLER_BUDGET_MS, PRODUCTION_ENVIRONMENT_ID, REPOSITORY,
  createControllerJournal, runApprovedRestart, verifyControllerRun, verifyPublicRelease } from './run-approved-production-restart.mjs';

const releaseSha = 'a'.repeat(40);
const baseline = Date.parse('2026-09-07T04:00:00.000Z');
function fixture(overrides = {}) {
  let now = baseline, monotonic = 0, id = 100;
  const runs = new Map(), events = [], calls = [], approvals = [];
  const gh = async args => {
    calls.push(args);
    if (overrides.command) {
      const replacement = await overrides.command(args, { runs, events, calls });
      if (replacement !== undefined) return replacement;
    }
    if (args[0] === 'workflow') {
      const phase = args[2] === 'restart-production-canary.yml' ? 'restart'
        : args[2] === 'manage-production-canary-entitlement.yml' ? 'revoke'
        : args.includes('release_scope=full') ? 'full' : 'compatibility';
      const runId = String(++id);
      runs.set(runId, { phase, workflow: args[2], poll: 0, createdAt: now });
      return `https://github.com/${REPOSITORY}/actions/runs/${runId}\n`;
    }
    assert.equal(args[0], 'api');
    if (args[1] === 'user') return 'tjames222\n';
    if (args[1].endsWith('/git/ref/heads/main')) return JSON.stringify({ object: { type: 'commit', sha: releaseSha } });
    if (args[1] === '--method') {
      const runId = args[3].match(/runs\/(\d+)/u)[1];
      approvals.push(runId);
      return JSON.stringify([{ id: Number(runId) + 500, environment: 'production', sha: releaseSha }]);
    }
    const match = args[1].match(/\/actions\/runs\/(\d+)(.*)$/u);
    assert.ok(match, `Unexpected command ${args.join(' ')}`);
    const [, runId, suffix] = match;
    const run = runs.get(runId);
    assert.ok(run);
    if (!suffix) {
      run.poll++;
      const data = { id: Number(runId), head_sha: releaseSha, head_branch: 'main', event: 'workflow_dispatch',
        path: `.github/workflows/${run.workflow}`, run_attempt: 1, repository: { full_name: REPOSITORY },
        head_repository: { full_name: REPOSITORY }, created_at: new Date(run.createdAt).toISOString(),
        status: run.poll > 2 ? 'completed' : 'waiting', conclusion: 'success' };
      overrides.run?.(data, run);
      return JSON.stringify(data);
    }
    if (suffix === '/pending_deployments') {
      const gate = { environment: { id: PRODUCTION_ENVIRONMENT_ID, name: 'production' }, current_user_can_approve: true };
      overrides.gate?.(gate, run);
      return JSON.stringify([gate]);
    }
    if (suffix === '/jobs?per_page=100') {
      const data = { total_count: 1, jobs: [{ id: Number(runId) * 10, run_id: Number(runId), head_sha: releaseSha, status: 'waiting' }] };
      overrides.jobs?.(data, run);
      return JSON.stringify(data);
    }
    assert.fail(`Unexpected suffix ${suffix}`);
  };
  const invoke = () => runApprovedRestart({ releaseSha, backupRunId: '999', gh,
    journal: async event => { events.push(structuredClone(event)); await overrides.journal?.(event, {
      setWall: value => { now = value; }, setMonotonic: value => { monotonic = value; },
    }); },
    smoke: overrides.smoke ?? (async () => {}), wallNow: () => now, monotonicNow: () => monotonic,
    sleep: async milliseconds => { now += milliseconds; monotonic += milliseconds; overrides.clock?.({ setWall: value => { now = value; }, setMonotonic: value => { monotonic = value; } }); },
  });
  return { invoke, events, calls, approvals, runs };
}

test('one-shot success journals before each mutation and approves transient gates only once', async () => {
  const f = fixture();
  const result = await f.invoke();
  assert.deepEqual(Object.keys(result.runs), ['restart', 'compatibility', 'full']);
  assert.equal(result.ownerTestingPending, true);
  assert.equal(result.revokeStillRequired, true);
  assert.deepEqual(f.approvals, ['101', '102', '103']);
  assert.equal(f.events.filter(e => e.event === 'dispatch-intent').length, 3);
  for (const phase of ['restart', 'compatibility', 'full']) {
    const names = f.events.filter(e => e.phase === phase).map(e => e.event);
    assert.ok(names.indexOf('dispatch-intent') < names.indexOf('dispatched'));
    assert.ok(names.indexOf('approval-intent') < names.indexOf('approved'));
  }
});

for (const phase of ['compatibility', 'full']) test(`terminal ${phase} failure revokes once after verified restart`, async () => {
  const f = fixture({ run(data, run) { if (run.phase === phase && data.status === 'completed') data.conclusion = 'failure'; } });
  await assert.rejects(f.invoke(), new RegExp(`${phase} completed without success`, 'u'));
  assert.equal([...f.runs.values()].filter(r => r.phase === 'revoke').length, 1);
  assert.equal(f.events.at(-1).event, 'failure-canary-revoked');
});

test('failed restart never triggers revocation or a second grant', async () => {
  const f = fixture({ run(data) { data.status = 'completed'; data.conclusion = 'failure'; } });
  await assert.rejects(f.invoke(), /restart completed/u);
  assert.equal(f.runs.size, 1);
});

for (const output of ['', 'created run', `https://github.com/other/repo/actions/runs/12`,
  `https://github.com/${REPOSITORY}/actions/runs/12\nhttps://github.com/${REPOSITORY}/actions/runs/13`]) {
  test('uncertain dispatch output is not redispatched or discovered by listing', async () => {
    const f = fixture({ command(args) { if (args[0] === 'workflow') return output; } });
    await assert.rejects(f.invoke(), /do not redispatch/u);
    assert.equal(f.calls.filter(a => a[0] === 'workflow').length, 1);
    assert.equal(f.events.at(-2).event, 'dispatch-uncertain');
  });
}

test('dispatch timeout is not retried', async () => {
  const f = fixture({ command(args) { if (args[0] === 'workflow') throw new Error('timeout'); } });
  await assert.rejects(f.invoke(), /outcome is uncertain/u);
  assert.equal(f.calls.filter(a => a[0] === 'workflow').length, 1);
});

test('uncertain approval is never repeated or cleaned up as a terminal failure', async () => {
  const f = fixture({ command(args) { if (args[1] === '--method') return '{}'; } });
  await assert.rejects(f.invoke(), /Approval outcome is uncertain/u);
  assert.equal(f.calls.filter(a => a[1] === '--method').length, 1);
  assert.equal(f.runs.size, 1);
});

for (const mutate of [gate => { gate.environment.id++; }, gate => { gate.environment.name = 'preview'; },
  gate => { gate.current_user_can_approve = false; }]) test('unexpected approval target/authority stops before POST', async () => {
  const f = fixture({ gate: mutate });
  await assert.rejects(f.invoke());
  assert.equal(f.approvals.length, 0);
});

for (const mutate of [data => { data.total_count++; }, data => { data.jobs[0].head_sha = 'b'.repeat(40); },
  data => { data.jobs[0].run_id++; }]) test('incomplete or mismatched jobs stop before approval', async () => {
  const f = fixture({ jobs: mutate });
  await assert.rejects(f.invoke());
  assert.equal(f.approvals.length, 0);
});

for (const mutate of [run => { run.run_attempt = 2; }, run => { run.head_sha = 'b'.repeat(40); },
  run => { run.head_branch = 'develop'; }, run => { run.event = 'push'; },
  run => { run.path = '.github/workflows/other.yml'; }, run => { run.repository.full_name = 'other/repo'; },
  run => { run.created_at = '2020-01-01T00:00:00Z'; }]) test('exact dispatch identity rejects changes before approval', async () => {
  const f = fixture({ run: mutate });
  await assert.rejects(f.invoke());
  assert.equal(f.approvals.length, 0);
});

test('moving main prevents the next mutation', async () => {
  let reads = 0;
  const f = fixture({ command(args) {
    if (args[1]?.endsWith('/git/ref/heads/main') && ++reads === 3) return JSON.stringify({ object: { type: 'commit', sha: 'b'.repeat(40) } });
  } });
  await assert.rejects(f.invoke(), /no longer the frozen release/u);
  assert.equal(f.approvals.length, 0);
});

for (const axis of ['wall', 'monotonic', 'backwards']) test(`${axis} deadline stops without cleanup during a running workflow`, async () => {
  const f = fixture({ clock({ setWall, setMonotonic }) {
    if (axis === 'wall') setWall(baseline + CONTROLLER_BUDGET_MS);
    if (axis === 'monotonic') setMonotonic(CONTROLLER_BUDGET_MS);
    if (axis === 'backwards') setWall(baseline - 1);
  } });
  await assert.rejects(f.invoke(), /deadline reached/u);
  assert.equal(f.runs.size, 1);
});

test('journal persistence failure happens before dispatch or approval', async () => {
  for (const eventName of ['dispatch-intent', 'approval-intent']) {
    const f = fixture({ journal(event) { if (event.event === eventName) throw new Error('disk full'); } });
    await assert.rejects(f.invoke(), /disk full/u);
    assert.equal(f.calls.filter(a => eventName === 'dispatch-intent' ? a[0] === 'workflow' : a[1] === '--method').length, 0);
  }
});

test('public smoke failure does not dispatch full or claim canary acceptance', async () => {
  const f = fixture({ smoke() { throw new Error('unexpected HTTP'); } });
  await assert.rejects(f.invoke(), /unexpected HTTP/u);
  assert.deepEqual([...f.runs.values()].map(r => r.phase), ['restart', 'compatibility']);
  assert.equal(f.events.some(e => e.event === 'success'), false);
});

for (const eventName of ['dispatch-intent', 'approval-intent']) {
  for (const axis of ['wall', 'monotonic']) test(`pause during ${eventName} journal blocks mutation on ${axis} deadline`, async () => {
    const f = fixture({ journal(event, { setWall, setMonotonic }) {
      if (event.event !== eventName) return;
      if (axis === 'wall') setWall(baseline + CONTROLLER_BUDGET_MS);
      else setMonotonic(CONTROLLER_BUDGET_MS);
    } });
    await assert.rejects(f.invoke(), /deadline reached/u);
    assert.equal(f.calls.filter(a => eventName === 'dispatch-intent' ? a[0] === 'workflow' : a[1] === '--method').length, 0);
  });
}

test('journal is exclusive, private, fsynced, and rejects links or broad directory modes', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), '77dc-controller-journal-')));
  try {
    await chmod(directory, 0o700);
    const filename = path.join(directory, 'state.jsonl');
    const journal = await createControllerJournal(filename);
    await journal.append({ event: 'start' });
    await journal.close();
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal(await readFile(filename, 'utf8'), '{"event":"start"}\n');
    await assert.rejects(createControllerJournal(filename));
    await symlink(filename, path.join(directory, 'link'));
    await assert.rejects(createControllerJournal(path.join(directory, 'link')));
    await chmod(directory, 0o755);
    await assert.rejects(createControllerJournal(path.join(directory, 'new')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public smoke checks actual titles, same-origin redirects, and final invite policy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '77dc-controller-http-'));
  try {
    for (const file of ['login.html', 'invite.html', 'reset-password.html']) await writeFile(path.join(directory, file), `<title>${file}</title>`);
    const fetchImpl = async url => new Response(`<title>${url.pathname.slice(1)}</title>`, { headers: { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer' } });
    await verifyPublicRelease({ repository: directory, fetchImpl });
    await assert.rejects(verifyPublicRelease({ repository: directory, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://other.example/' } }) }), /reviewed origin/u);
    await assert.rejects(verifyPublicRelease({ repository: directory, fetchImpl: async () => new Response('<title>fallback</title>', { headers: { 'Content-Type': 'text/html' } }) }), /unexpected page/u);
    await assert.rejects(verifyPublicRelease({ repository: directory, fetchImpl: async url => new Response(`<title>${url.pathname.slice(1)}</title>`, { headers: { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer, unsafe-url' } }) }), /no-referrer/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
