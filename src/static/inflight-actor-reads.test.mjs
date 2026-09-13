import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInflightActorReads } from './inflight-actor-reads.mjs';

const request = (overrides = {}) => ({ actorId: 'A', query: 'activation', version: 1, args: [], ...overrides });
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('matching pending reads coalesce, return isolated copies, and are not a settled cache', async () => {
  const scope = createInflightActorReads();
  const pending = deferred(); let calls = 0;
  const read = () => { calls += 1; return pending.promise; };
  const first = scope.run(request(), read);
  const second = scope.run(request(), read);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve({ nested: { status: 'active' } });
  const [a, b] = await Promise.all([first, second]);
  a.nested.status = 'changed';
  assert.equal(b.nested.status, 'active');
  await scope.run(request(), read);
  assert.equal(calls, 2);
});

test('actor, endpoint, contract version and RPC arguments all partition in-flight work', async () => {
  const scope = createInflightActorReads(); let calls = 0;
  const read = async () => { calls += 1; return null; };
  await Promise.all([request(), request({ actorId: 'B' }), request({ query: 'training' }),
    request({ version: 2 }), request({ args: ['page', 1] })].map((key) => scope.run(key, read)));
  assert.equal(calls, 5);
});

test('A→B→A and sign-out invalidate delayed results synchronously, including offline failures', async () => {
  for (const fail of [false, true]) {
    const scope = createInflightActorReads();
    scope.observeAuth('INITIAL_SESSION', 'A');
    const pending = deferred();
    const old = scope.run(request(), () => pending.promise);
    const rejected = assert.rejects(old, fail ? /offline/ : { code: 'STALE_ACTOR_READ' });
    await Promise.resolve();
    scope.observeAuth('SIGNED_OUT', '');
    scope.observeAuth('SIGNED_IN', 'B');
    scope.observeAuth('SIGNED_OUT', '');
    scope.observeAuth('SIGNED_IN', 'A');
    const fresh = scope.run(request(), async () => ({ source: 'new session' }));
    if (fail) pending.reject(new Error('offline'));
    else pending.resolve({ source: 'old session' });
    await rejected;
    assert.deepEqual(await fresh, { source: 'new session' });
  }
});

test('token refresh, user updates and explicit data invalidation fence pending reads', async () => {
  for (const action of [(scope) => scope.observeAuth('TOKEN_REFRESHED', 'A'),
    (scope) => scope.observeAuth('USER_UPDATED', 'A'), (scope) => scope.invalidate()]) {
    const scope = createInflightActorReads();
    scope.observeAuth('INITIAL_SESSION', 'A');
    const pending = deferred();
    const result = scope.run(request(), () => pending.promise);
    const rejected = assert.rejects(result, { code: 'STALE_ACTOR_READ' });
    await Promise.resolve(); action(scope); pending.resolve({}); await rejected;
  }
});

test('initial session delivery for the already captured actor does not discard startup reads', async () => {
  const scope = createInflightActorReads();
  const pending = deferred();
  const result = scope.run(request(), () => pending.promise);
  scope.observeAuth('INITIAL_SESSION', 'A');
  pending.resolve({ okay: true });
  assert.deepEqual(await result, { okay: true });
});

test('failed requests evict immediately so a retry can succeed', async () => {
  const scope = createInflightActorReads();
  await assert.rejects(scope.run(request(), async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(await scope.run(request(), async () => ({ okay: true })), { okay: true });
});

test('a training mutation invalidates training reads without canceling unrelated activation reads', async () => {
  const scope = createInflightActorReads();
  const pending = deferred();
  const activation = scope.run(request(), () => pending.promise);
  const training = scope.run(request({ query: 'training' }), () => pending.promise);
  const rejected = assert.rejects(training, { code: 'STALE_ACTOR_READ' });
  await Promise.resolve();
  scope.invalidate('training');
  pending.resolve({ okay: true });
  await rejected;
  assert.deepEqual(await activation, { okay: true });
});
