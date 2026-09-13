import assert from 'node:assert/strict';
import { test } from 'node:test';
import config, { resolveTrainingModulePreloads } from '../../vite.config.mjs';

test('only the dynamically imported training UI skips its redundant JavaScript preload', () => {
  const target = 'assets/site-training-ui-example.js';
  const dependencies = [target, 'assets/shared-example.js', 'assets/site-training-ui-example.css'];
  assert.deepEqual(resolveTrainingModulePreloads(target, dependencies, { hostType: 'js' }), dependencies.slice(1));
  assert.deepEqual(dependencies, [target, 'assets/shared-example.js', 'assets/site-training-ui-example.css']);
  assert.equal(resolveTrainingModulePreloads(target, dependencies, { hostType: 'html' }), dependencies);
  for (const other of ['assets/menu-example.js', 'assets/share-composer-example.js', 'assets/site-training-runtime-example.js']) {
    assert.equal(resolveTrainingModulePreloads(other, dependencies, { hostType: 'js' }), dependencies);
  }
  assert.equal(config({ mode: 'production' }).build.modulePreload.resolveDependencies, resolveTrainingModulePreloads);
});
