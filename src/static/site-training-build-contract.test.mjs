import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { build } from 'vite';
import config, { isSharedMenuModule, resolveTrainingModulePreloads } from '../../vite.config.mjs';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
import { htmlAssetReferences } from '../../scripts/measure-frontend-bundles.mjs';

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
      const html = readFileSync(new URL(`../../${entry}`, import.meta.url), 'utf8');
      // MFA is deliberately menu-free. Entry-aware grouping below must not
      // pull the menu's code/CSS into that entry via its shared API imports.
      if (entry === 'account-security.html' && sheet === 'menu') {
        assert.ok(!html.includes('/src/static/menu.js'));
        assert.ok(!html.includes('/src/assets/menu.css'));
      } else assert.ok(html.includes(`/src/assets/${sheet}.css`), `${entry} already uses ${sheet}`);
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
  assert.equal(shell.entriesAware, true);
  assert.equal(shell.entriesAwareMergeThreshold, 30000);
  assert.ok(shell.priority > controllers.priority);
  assert.equal(controllers.test.test('/project/src/static/menu-training-controllers.mjs'), true);
  assert.equal(controllers.test.test('/project/src/static/site-training-ui.js'), false);
});

test('actual production graph keeps MFA free of menu side effects and training stays optional', async () => {
  const artifact = await build({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    configFile: fileURLToPath(new URL('../../vite.config.mjs', import.meta.url)),
    logLevel: 'silent',
    define: {
      'import.meta.env.VITE_ENABLE_MOCKS': JSON.stringify('true'),
      'import.meta.env.VITE_ENABLE_PRODUCTION_CONNECTIONS': JSON.stringify('false'),
      'import.meta.env.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS': JSON.stringify('false'),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
    },
    build: { write: false },
  });
  const assets = new Map(artifact.output.map(asset => [asset.fileName, asset]));
  function graph(entry) {
    const visited = new Set();
    const pending = htmlAssetReferences(String(assets.get(entry).source)).map(path => posix.normalize(path));
    while (pending.length) {
      const path = pending.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      const asset = assets.get(path);
      if (asset?.type === 'chunk') pending.push(...asset.imports);
    }
    return [...visited].map(path => assets.get(path)).filter(Boolean);
  }
  const security = graph('account-security.html');
  const securityModules = security.filter(asset => asset.type === 'chunk').flatMap(asset => Object.keys(asset.modules));
  assert.ok(securityModules.some(id => id.endsWith('/src/static/api.js')));
  assert.ok(securityModules.some(id => id.endsWith('/src/static/journal-date-contract.mjs')));
  for (const name of ['menu.js', 'shared-header-actions.js', 'menu-training-controllers.mjs', 'site-training-ui.js', 'journal-date-picker.mjs', 'dialog.mjs', 'badges-rewards.mjs', 'admin-role-detail.mjs', 'admin-role-contract.mjs', 'admin-role-write-client.mjs']) {
    assert.ok(!securityModules.some(id => id.endsWith(`/src/static/${name}`)), `MFA must not execute ${name}`);
  }
  const securityCss = security.filter(asset => asset.fileName.endsWith('.css')).map(asset => String(asset.source)).join('');
  // Existing theme sheets contain menu color overrides; the menu's own
  // controller/recovery rules must not become a new Security dependency.
  assert.doesNotMatch(securityCss, /\.global-menu-training-load-(?:status|recovery)/);
  for (const entry of ['index.html', 'login.html', 'dashboard.html', 'badges-rewards.html', 'community.html', 'profile.html', 'bible-reading.html']) {
    const modules = graph(entry).filter(asset => asset.type === 'chunk').flatMap(asset => Object.keys(asset.modules));
    assert.ok(modules.some(id => id.endsWith('/src/static/menu.js')), `${entry} keeps working navigation`);
    assert.equal(modules.some(id => id.endsWith('/src/static/badges-rewards.mjs')), entry === 'badges-rewards.html', `${entry} loads reward presentation only when needed`);
    assert.ok(!modules.some(id => id.endsWith('/src/static/journal-date-picker.mjs')), `${entry} does not load journal calendar UI`);
    assert.ok(!modules.some(id => /\/(?:menu-training-controllers|site-training-ui|site-training-coachmark)\.(?:js|mjs)$/.test(id)), `${entry} keeps training optional`);
    assert.ok(!modules.some(id => /\/admin-role-(?:detail|contract|write-client)\.mjs$/.test(id)), `${entry} does not load role review or mutation code`);
  }
});
