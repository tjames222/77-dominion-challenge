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

test('token refresh, user updates, MFA verification and explicit invalidation fence same-session pending reads', async () => {
  for (const action of [(scope) => scope.observeAuth('TOKEN_REFRESHED', 'A', 'A:session-1'),
    (scope) => scope.observeAuth('USER_UPDATED', 'A', 'A:session-1'),
    (scope) => scope.observeAuth('MFA_CHALLENGE_VERIFIED', 'A', 'A:session-1'),
    (scope) => scope.invalidate()]) {
    const scope = createInflightActorReads();
    scope.observeAuth('INITIAL_SESSION', 'A', 'A:session-1');
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
  scope.observeAuth('INITIAL_SESSION', 'A', 'A:session-1');
  pending.resolve({ okay: true });
  assert.deepEqual(await result, { okay: true });
});

for (const event of ['SIGNED_IN', 'INITIAL_SESSION']) test(`${event} for a replacement immutable session cannot reuse same-actor pending work`, async () => {
  const scope = createInflightActorReads();
  scope.observeAuth('INITIAL_SESSION', 'A', 'A:session-1');
  const pending = deferred(); let calls = 0;
  const old = scope.run(request(), () => { calls += 1; return pending.promise; });
  const rejected = assert.rejects(old, { code: 'STALE_ACTOR_READ' });
  await Promise.resolve();
  scope.observeAuth(event, 'A', 'A:session-2');
  const fresh = scope.run(request(), async () => { calls += 1; return { source: 'replacement' }; });
  pending.resolve({ source: 'old session' });
  await rejected; assert.deepEqual(await fresh, { source: 'replacement' });
  assert.equal(calls, 2);
});

test('genuine same-session SIGNED_IN/refocus still shares one pending read', async () => {
  const scope = createInflightActorReads();
  scope.observeAuth('INITIAL_SESSION', 'A', 'A:session-1');
  const pending = deferred(); let calls = 0;
  const first = scope.run(request(), () => { calls += 1; return pending.promise; });
  await Promise.resolve();
  scope.observeAuth('SIGNED_IN', 'A', 'A:session-1');
  const second = scope.run(request(), async () => { calls += 1; return { source: 'unexpected' }; });
  pending.resolve({ source: 'same session' });
  assert.deepEqual(await first, { source: 'same session' });
  assert.deepEqual(await second, { source: 'same session' });
  assert.equal(calls, 1);
});

test('same-actor session A→B→A cannot revive the original pending response', async () => {
  const scope = createInflightActorReads();
  scope.observeAuth('INITIAL_SESSION', 'A', 'A:session-1');
  const pending = deferred();
  const old = scope.run(request({ query: 'training' }), () => pending.promise);
  const rejected = assert.rejects(old, { code: 'STALE_ACTOR_READ' });
  await Promise.resolve();
  scope.observeAuth('SIGNED_IN', 'A', 'A:session-2');
  scope.observeAuth('SIGNED_IN', 'A', 'A:session-1');
  pending.resolve({ private: 'old training' }); await rejected;
});

for (const initial of ['', 'A:session-1']) test(`a missing immutable-session marker cannot preserve pending work from ${initial || 'an unknown session'}`, async () => {
  const scope = createInflightActorReads();
  scope.observeAuth('INITIAL_SESSION', 'A', initial);
  const pending = deferred();
  const old = scope.run(request(), () => pending.promise);
  const rejected = assert.rejects(old, { code: 'STALE_ACTOR_READ' });
  await Promise.resolve(); scope.observeAuth('SIGNED_IN', 'A', '');
  pending.resolve({}); await rejected;
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
