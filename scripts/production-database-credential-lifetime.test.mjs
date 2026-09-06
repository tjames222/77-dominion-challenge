import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialLifetime, remainingCredentialMilliseconds, runDeadlineProcess } from './production-database-credential-lifetime.mjs';

const ref = 'mimolwojppbtsbvtqwpo';
const second = 1_000_000_000n;
const lifetime = () => createCredentialLifetime({ projectRef: ref, issuedAtNs: 1000n * second, ttlSeconds: 300 });

test('lifetime consumes request/readiness time and retains a 30-second expiry reserve', () => {
  const value = lifetime();
  assert.equal(value.deadlineNs, String(1270n * second));
  assert.equal(remainingCredentialMilliseconds(value, ref, 1060n * second, 120), 210000);
  assert.equal(remainingCredentialMilliseconds(value, ref, 1120n * second, 120), 150000);
  assert.equal(remainingCredentialMilliseconds(value, ref, 1150n * second, 120), 120000);
  assert.throws(() => remainingCredentialMilliseconds(value, ref, 1151n * second, 120), { diagnosticCode: 'credential-lifetime-budget' });
  assert.throws(() => remainingCredentialMilliseconds(value, ref, 1270n * second), { diagnosticCode: 'credential-lifetime-expired' });
});

test('deadline contract rejects widened TTL, reserve, project, fields and noncanonical clock values', () => {
  for (const patch of [{ ttlSeconds: 299 }, { ttlSeconds: 7201 }, { reserveSeconds: 0 }, { projectRef: 'other' }, { deadlineNs: '999999999999999' }, { issuedAtNs: '01000000000000' }, { extra: true }]) {
    assert.throws(() => remainingCredentialMilliseconds({ ...lifetime(), ...patch }, ref, 1000n * second), { diagnosticCode: 'credential-lifetime-contract' });
  }
});

test('fixed child exits normally under the immutable monotonic deadline', async () => {
  const status = await runDeadlineProcess(process.execPath, ['--eval', 'process.exit(0)'], {
    deadlineNs: process.hrtime.bigint() + 2n * second, env: {}, stdio: 'ignore',
  });
  assert.equal(status, 0);
});

test('deadline kills a TERM-resistant child group and waits for actual child exit', async () => {
  let pid;
  await assert.rejects(() => runDeadlineProcess(process.execPath, ['--eval', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    deadlineNs: process.hrtime.bigint() + 250_000_000n, env: {}, stdio: 'ignore', terminationGraceMs: 30,
    onSpawn: (child) => { pid = child.pid; },
  }), { diagnosticCode: 'credential-operation-timeout' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('an expired credential cannot spawn a child', () => {
  let spawned = false;
  assert.throws(() => runDeadlineProcess('unused', [], {
    deadlineNs: 10n, monotonicNow: () => 10n, spawnImplementation: () => { spawned = true; },
  }), { diagnosticCode: 'credential-lifetime-expired' });
  assert.equal(spawned, false);
});

test('setup errors terminate the spawned group before rejecting', async () => {
  let pid;
  const expected = new Error('fixture setup failed');
  await assert.rejects(() => runDeadlineProcess(process.execPath, ['--eval', 'setInterval(()=>{},1000)'], {
    deadlineNs: process.hrtime.bigint() + 2n * second, env: {}, stdio: 'ignore', terminationGraceMs: 30,
    onSpawn: (child) => { pid = child.pid; throw expected; },
  }), (error) => error === expected);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('time spent starting/setup does not extend the deadline', async () => {
  let now = 0n;
  let pid;
  await assert.rejects(() => runDeadlineProcess(process.execPath, ['--eval', 'setInterval(()=>{},1000)'], {
    deadlineNs: second, monotonicNow: () => now, env: {}, stdio: 'ignore', terminationGraceMs: 30,
    onSpawn: (child) => { pid = child.pid; now = 2n * second; },
  }), { diagnosticCode: 'credential-operation-timeout' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('missing executable fails without exposing invocation details', async () => {
  await assert.rejects(() => runDeadlineProcess('/nonexistent/fixture-database-cli', [], {
    deadlineNs: process.hrtime.bigint() + second, env: {}, stdio: 'ignore',
  }), { diagnosticCode: 'executable-unavailable' });
});
