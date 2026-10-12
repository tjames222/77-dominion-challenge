import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthenticatedHeaderLoader, HEADER_RELOAD_MESSAGE } from './shared-header-loader.mjs';
import { resolveTrainingModulePreloads, isSharedMenuModule } from '../../vite.config.mjs';

test('header code is deferred, coalesced, cached without any actor state', async () => {
  let calls = 0; let resolve; const module = { createAuthenticatedHeaderActions() {} };
  const load = createAuthenticatedHeaderLoader({ load: () => { calls++; return new Promise(done => { resolve = done; }); } });
  assert.equal(calls, 0); const first = load(); assert.equal(load(), first);
  await Promise.resolve(); assert.equal(calls, 1); resolve(module);
  assert.equal(await first, module); assert.equal(await load(), module); assert.equal(calls, 1);
});

for (const cause of ['rejection', 'timeout']) test(`header ${cause} remains failed until a new document`, async () => {
  let calls = 0; let expire; let cleared = 0; let resolve;
  const load = createAuthenticatedHeaderLoader({
    load: () => { calls++; return cause === 'rejection' ? Promise.reject(new Error('private detail')) : new Promise(done => { resolve = done; }); },
    setTimer(callback, ms) { assert.equal(ms, 30000); expire = callback; return 7; },
    clearTimer(id) { assert.equal(id, 7); cleared++; },
  });
  const first = load(); const rejected = assert.rejects(first, { message: HEADER_RELOAD_MESSAGE });
  await Promise.resolve(); if (cause === 'timeout') expire(); await rejected;
  if (cause === 'timeout') resolve({ createAuthenticatedHeaderActions() { assert.fail('late code must not mount'); } });
  await assert.rejects(load(), { message: HEADER_RELOAD_MESSAGE });
  assert.equal(load(), first); assert.equal(calls, 1);
  await Promise.resolve(); assert.equal(cleared, 1);
});

test('header chunk skips only its own optional JS preload and keeps the shared streak helper in menu', () => {
  const target = 'assets/shared-header-actions-example.js';
  const dependencies = [target, 'assets/menu-example.js', 'assets/auth-shared-example.js', 'assets/menu-example.css'];
  assert.deepEqual(resolveTrainingModulePreloads(target, dependencies, { hostType: 'js' }), dependencies.slice(1));
  assert.equal(resolveTrainingModulePreloads(target, dependencies, { hostType: 'html' }), dependencies);
  const dialog = 'assets/app-streak-dialog-example.js';
  assert.deepEqual(resolveTrainingModulePreloads(dialog, [dialog, ...dependencies.slice(1)], { hostType: 'js' }), dependencies.slice(1));
  assert.equal(isSharedMenuModule('/project/src/static/streak-summary.mjs'), true);
  assert.equal(isSharedMenuModule('/project/src/static/shared-header-actions.js'), false);
});
