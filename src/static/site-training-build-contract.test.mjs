import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import config, { isSharedMenuModule, resolveTrainingModulePreloads } from '../../vite.config.mjs';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

for (const chunk of ['site-training-ui', 'menu-training-controllers']) {
test(`only the dynamically imported ${chunk} skips its redundant JavaScript preload`, () => {
  const target = `assets/${chunk}-example.js`;
  const dependencies = [target, 'assets/shared-example.js', 'assets/site-training-ui-example.css'];
  assert.deepEqual(resolveTrainingModulePreloads(target, dependencies, { hostType: 'js' }), dependencies.slice(1));
  assert.deepEqual(dependencies, [target, 'assets/shared-example.js', 'assets/site-training-ui-example.css']);
  assert.equal(resolveTrainingModulePreloads(target, dependencies, { hostType: 'html' }), dependencies);
  for (const other of ['assets/menu-example.js', 'assets/share-composer-example.js', 'assets/site-training-runtime-example.js']) {
    assert.equal(resolveTrainingModulePreloads(other, dependencies, { hostType: 'js' }), dependencies);
  }
  assert.equal(config({ mode: 'production' }).build.modulePreload.resolveDependencies, resolveTrainingModulePreloads);
  assert.deepEqual(resolveTrainingModulePreloads(target, [
    'assets/menu-training-controllers-hash.js', 'assets/site-training-ui-hash.js',
    'assets/menu-hash.js', 'assets/share-composer-hash.js', 'assets/site-training-ui-hash.css',
  ], { hostType: 'js' }), [
    'assets/menu-hash.js', 'assets/share-composer-hash.js', 'assets/site-training-ui-hash.css',
  ]);
});
}

test('shared menu grouping includes only its existing shell and leaves feature modules optional', () => {
  assert.equal(isSharedMenuModule('/project/src/static/menu.js'), true);
  assert.equal(isSharedMenuModule('\0vite/modulepreload-polyfill.js'), true);
  for (const sheet of ['styles', 'product', 'menu', 'dominion-night', 'dominion-platinum']) {
    assert.equal(isSharedMenuModule(`/project/src/assets/${sheet}.css`), true);
    for (const entry of Object.values(PRODUCTION_ENTRYPOINTS)) {
      assert.ok(readFileSync(new URL(`../../${entry}`, import.meta.url), 'utf8').includes(`/src/assets/${sheet}.css`), `${entry} already uses ${sheet}`);
    }
  }
  // Dialog styling belongs to the shared menu's existing modal controls,
  // including the invitation page, which had omitted its direct stylesheet.
  assert.equal(isSharedMenuModule('/project/src/assets/dialog.css'), true);
  for (const module of ['menu-training-controllers.mjs', 'site-training-registry.mjs', 'site-training-ui.js', 'community.js', 'dashboard.js']) {
    assert.equal(isSharedMenuModule(`/project/src/static/${module}`), false);
  }
  for (const sheet of ['site-training', 'community', 'share-composer']) {
    assert.equal(isSharedMenuModule(`/project/src/assets/${sheet}.css`), false);
  }
  const [shell, controllers] = config({ mode: 'production' }).build.rollupOptions.output.codeSplitting.groups;
  assert.equal(shell.test, isSharedMenuModule);
  assert.ok(shell.priority > controllers.priority);
  assert.equal(controllers.test.test('/project/src/static/menu-training-controllers.mjs'), true);
  assert.equal(controllers.test.test('/project/src/static/site-training-ui.js'), false);
});
