import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

export const MINIMUM_PRODUCTION_LOGIN_TTL_SECONDS = 300;
export const CREDENTIAL_EXPIRY_RESERVE_SECONDS = 30;
export const MINIMUM_READY_BUDGET_SECONDS = 120;
const NS_PER_SECOND = 1_000_000_000n;

function lifetimeFailure(code) {
  const error = new Error('Production database credential lifetime is invalid');
  error.diagnosticCode = code;
  throw error;
}

export function createCredentialLifetime({ projectRef, issuedAtNs, ttlSeconds }) {
  if (typeof issuedAtNs !== 'bigint' || issuedAtNs < 0n
    || !Number.isInteger(ttlSeconds) || ttlSeconds < MINIMUM_PRODUCTION_LOGIN_TTL_SECONDS || ttlSeconds > 7200) {
    lifetimeFailure('credential-lifetime-contract');
  }
  const expiresAtNs = issuedAtNs + BigInt(ttlSeconds) * NS_PER_SECOND;
  return {
    schemaVersion: 1, projectRef, issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: expiresAtNs.toString(),
    deadlineNs: (expiresAtNs - BigInt(CREDENTIAL_EXPIRY_RESERVE_SECONDS) * NS_PER_SECOND).toString(),
    ttlSeconds, reserveSeconds: CREDENTIAL_EXPIRY_RESERVE_SECONDS,
  };
}

export function remainingCredentialMilliseconds(lifetime, projectRef, nowNs = process.hrtime.bigint(), minimumSeconds = 0) {
  try {
    assert.deepEqual(Object.keys(lifetime).sort(), ['deadlineNs', 'expiresAtNs', 'issuedAtNs', 'projectRef', 'reserveSeconds', 'schemaVersion', 'ttlSeconds']);
    assert.equal(lifetime.schemaVersion, 1);
    assert.equal(lifetime.projectRef, projectRef);
    assert.equal(lifetime.reserveSeconds, CREDENTIAL_EXPIRY_RESERVE_SECONDS);
    for (const name of ['issuedAtNs', 'expiresAtNs', 'deadlineNs']) assert.match(lifetime[name], /^(0|[1-9][0-9]*)$/u);
    const expected = createCredentialLifetime({ projectRef, issuedAtNs: BigInt(lifetime.issuedAtNs), ttlSeconds: lifetime.ttlSeconds });
    assert.deepEqual(lifetime, expected);
    assert.equal(typeof nowNs, 'bigint');
    assert(nowNs >= BigInt(lifetime.issuedAtNs));
    assert(Number.isInteger(minimumSeconds) && minimumSeconds >= 0);
  } catch { lifetimeFailure('credential-lifetime-contract'); }
  const remainingNs = BigInt(lifetime.deadlineNs) - nowNs;
  if (remainingNs <= 0n) lifetimeFailure('credential-lifetime-expired');
  if (remainingNs < BigInt(minimumSeconds) * NS_PER_SECOND) lifetimeFailure('credential-lifetime-budget');
  return Number(remainingNs / 1_000_000n);
}

// POSIX production runner only. A detached process group ensures a CLI child
// cannot leave a still-running database subprocess behind at the deadline.
// The promise settles only after actual exit; callers must not clean up or
// publish artifacts while a process is still alive.
export function runDeadlineProcess(executable, args, {
  deadlineNs, env, cwd, stdio = 'inherit', spawnImplementation = spawn,
  monotonicNow = () => process.hrtime.bigint(), terminationGraceMs = 5_000,
  onSpawn,
} = {}) {
  const remainingMs = Number((BigInt(deadlineNs) - monotonicNow()) / 1_000_000n);
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) lifetimeFailure('credential-lifetime-expired');
  return new Promise((resolve, reject) => {
    let child;
    let deadlineTimer;
    let killTimer;
    let terminationError;
    let spawnError;
    let settled = false;
    const clear = () => {
      clearTimeout(deadlineTimer); clearTimeout(killTimer);
      process.removeListener('SIGTERM', interrupted);
      process.removeListener('SIGINT', interrupted);
    };
    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} } }
    };
    const finish = (error, status) => {
      if (settled) return;
      settled = true; clear();
      if (error) reject(error); else resolve(status);
    };
    const terminate = (error) => {
      if (terminationError || settled) return;
      terminationError = error;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), terminationGraceMs);
    };
    const interrupted = () => {
      const error = new Error('Production database operation was interrupted');
      error.diagnosticCode = 'credential-operation-interrupted';
      terminate(error);
    };
    const deadlineReached = () => {
      const error = new Error('Production database operation reached its credential deadline');
      error.diagnosticCode = 'credential-operation-timeout';
      terminate(error);
    };
    try {
      child = spawnImplementation(executable, args, { cwd, env, stdio, detached: true });
      child.once('error', () => {
        spawnError = new Error('Production database executable could not start');
        spawnError.diagnosticCode = 'executable-unavailable';
      });
      child.once('close', (status) => {
        if (terminationError) {
          // Ensure descendants are gone even if their immediate CLI parent
          // exited first after TERM. The group belongs only to this operation.
          signalGroup('SIGKILL');
          finish(terminationError);
        } else finish(spawnError, status);
      });
      process.once('SIGTERM', interrupted);
      process.once('SIGINT', interrupted);
      try { onSpawn?.(child); } catch (error) { terminate(error); }
      if (!terminationError) {
        // Spawn/setup time consumes the same immutable budget.
        const afterSpawnMs = Number((BigInt(deadlineNs) - monotonicNow()) / 1_000_000n);
        if (afterSpawnMs <= 0) deadlineReached();
        else deadlineTimer = setTimeout(deadlineReached, afterSpawnMs);
      }
    } catch (error) {
      if (child?.pid) terminate(error);
      else finish(error);
    }
  });
}
