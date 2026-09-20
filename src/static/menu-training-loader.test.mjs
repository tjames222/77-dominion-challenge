import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMenuTrainingLoader } from './menu-training-loader.mjs';
import { hasSiteTrainingRoute, SITE_TRAINING_ROUTES, SITE_TRAINING_SCHEMA_VERSION } from './site-training-contract.mjs';
import { SITE_TRAINING_REGISTRY, SITE_TRAINING_SCHEMA_VERSION as registrySchema } from './site-training-registry.mjs';

test('the lightweight training admission contract exactly matches the catalog', () => {
  assert.deepEqual(SITE_TRAINING_ROUTES, SITE_TRAINING_REGISTRY.pages.map((page) => page.route));
  assert.equal(SITE_TRAINING_SCHEMA_VERSION, registrySchema);
  for (const route of SITE_TRAINING_ROUTES) {
    assert.equal(hasSiteTrainingRoute(route), true);
    assert.equal(hasSiteTrainingRoute(route.replace(/\.html$/, '')), true);
  }
  for (const route of ['/index.html', '/login', '/register.html', '/invite', '/support', '/account-security', '/today-actions.html', '/unknown']) {
    assert.equal(hasSiteTrainingRoute(route), false, route);
  }
});

test('training controller loading is deferred, coalesced, and retains only public code', async () => {
  let calls = 0;
  const module = { createPageTrainingControls() {}, createSoloFirstRunTraining() {} };
  const load = createMenuTrainingLoader({ load: async () => { calls += 1; return module; } });
  assert.equal(calls, 0);
  const first = load();
  assert.equal(load(), first);
  assert.equal(await first, module);
  assert.equal(await load(), module);
  assert.equal(calls, 1);
});

test('a failed module has fixed reload-required recovery, without exposing provider errors', async () => {
  let calls = 0;
  const load = createMenuTrainingLoader({ load: async () => { calls += 1; throw new Error('sensitive fixture detail'); } });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(load(), (error) => error.code === 'SITE_TRAINING_RELOAD_REQUIRED'
      && !error.message.includes('sensitive fixture detail'));
  }
  assert.equal(calls, 1);
});
