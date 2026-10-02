import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { build } from 'vite';
import config, { isSharedMenuModule, isPublicShellModule, isSharedAuthModule, resolveTrainingModulePreloads } from '../../vite.config.mjs';
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

test('the dynamic Journal application omits only its own redundant JS preload for explicit reload recovery', () => {
  const target = 'assets/journal-api-application-hash.js';
  const dependencies = [target, 'assets/auth-shared-hash.js', 'assets/public-shell-hash.js',
    'assets/journal-api-application-hash.css', 'assets/site-training-ui-hash.js'];
  assert.deepEqual(resolveTrainingModulePreloads(target, dependencies, { hostType: 'js' }), dependencies.slice(1));
  assert.equal(dependencies.length, 5, 'the input remains unchanged');
  assert.equal(resolveTrainingModulePreloads(target, dependencies, { hostType: 'html' }), dependencies);
  for (const other of ['assets/privateJournal-hash.js', 'assets/journal-api-adapter-hash.js', 'assets/journal-reader-hash.js']) {
    assert.equal(resolveTrainingModulePreloads(other, dependencies, { hostType: 'js' }), dependencies);
  }
});

test('shared menu grouping includes only its existing shell and leaves feature modules optional', () => {
  assert.equal(isSharedMenuModule('/project/src/static/menu.js'), true);
  assert.equal(isSharedMenuModule('\0vite/modulepreload-polyfill.js'), false);
  for (const sheet of ['styles', 'product', 'menu', 'dominion-night', 'dominion-platinum']) {
    assert.equal(isSharedMenuModule(`/project/src/assets/${sheet}.css`), true);
    for (const entry of Object.values(PRODUCTION_ENTRYPOINTS)) {
      const html = readFileSync(new URL(`../../${entry}`, import.meta.url), 'utf8');
      // Menu-free entries use isolated CSS identities: Vite's normal CSS
      // wrappers must not import the shared menu chunk for side effects.
      if (['account-security.html', 'early-access-invite.html'].includes(entry) && sheet === 'menu') {
        assert.ok(!html.includes('/src/static/menu.js'));
        assert.ok(!html.includes('/src/assets/menu.css'));
      } else {
        assert.ok(html.includes(`/src/assets/${sheet}.css`), `${entry} already uses ${sheet}`);
        if (['account-security.html', 'early-access-invite.html'].includes(entry)) {
          assert.ok(html.includes(`/src/assets/${sheet}.css?isolated-shell`));
          assert.equal(isSharedMenuModule(`/project/src/assets/${sheet}.css?isolated-shell`), false);
        }
      }
    }
  }
  // Dialog styling belongs to the shared menu's existing modal controls.
  assert.equal(isSharedMenuModule('/project/src/assets/dialog.css'), true);
  for (const module of ['menu-training-controllers.mjs', 'site-training-registry.mjs', 'site-training-ui.js', 'community.js', 'dashboard.js']) {
    assert.equal(isSharedMenuModule(`/project/src/static/${module}`), false);
  }
  for (const sheet of ['site-training', 'community', 'share-composer']) {
    assert.equal(isSharedMenuModule(`/project/src/assets/${sheet}.css`), false);
  }
  for (const module of ['reveal.js', 'daily-standard-routes.mjs', 'group-integration-launch.mjs']) {
    assert.equal(isSharedMenuModule(`/project/src/static/${module}`), true);
  }
  const [publicShell, auth, navigation, shell, communityStyles, controllers] = config({ mode: 'production' }).build.rollupOptions.output.codeSplitting.groups;
  assert.equal(publicShell.test, isPublicShellModule); assert.equal(auth.test, isSharedAuthModule);
  assert.ok(publicShell.priority > auth.priority && auth.priority > shell.priority);
  for (const id of ['\0vite/modulepreload-polyfill.js', '\0vite/preload-helper.js']) assert.equal(isPublicShellModule(id), true);
  for (const id of ['/project/src/static/api.js', '/project/src/static/theme-state.js', '/project/src/static/theme-entitlement-state.js']) assert.equal(isSharedAuthModule(id), true);
  assert.equal(isPublicShellModule('/project/src/static/api.js'), false);
  assert.equal(isPublicShellModule('/project/src/assets/menu.css'), false);
  assert.equal(isPublicShellModule('/project/src/assets/styles.css'), false);
  assert.equal(isPublicShellModule('/project/src/assets/styles.css?isolated-shell'), false);
  for (const name of ['invite-flow', 'mfa-navigation']) assert.equal(navigation.test.test(`/project/src/static/${name}.mjs`), true);
  assert.equal(navigation.test.test('/project/src/static/auth.js'), false);
  assert.equal(communityStyles.test.test('/project/src/assets/community.css'), true);
  assert.equal(communityStyles.test.test('/project/src/assets/crew-invite.css'), true);
  assert.equal(communityStyles.test.test('/project/src/static/community.js'), false);
  assert.equal(isSharedAuthModule('/project/src/static/menu.js'), false);
  assert.equal(shell.test, isSharedMenuModule);
  assert.equal(shell.entriesAwareMergeThreshold, undefined);
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
  const trainingService = artifact.output.find(asset => asset.type === 'chunk'
    && Object.keys(asset.modules).some(id => id.endsWith('/src/static/site-training-api.mjs')));
  assert.equal(trainingService?.name, 'menu-training-controllers', 'training service shares the existing optional request');
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
  const invitationModules = graph('early-access-invite.html').filter(asset => asset.type === 'chunk').flatMap(asset => Object.keys(asset.modules));
  for (const name of ['api.js', 'menu.js', 'auth-runtime-core.mjs', 'early-access-invitation-page.mjs', 'early-access-invitation-client.mjs']) {
    assert.ok(!invitationModules.some(id => id.endsWith(`/src/static/${name}`)), `invitation strips its capability before loading ${name}`);
  }
  for (const entry of Object.values(PRODUCTION_ENTRYPOINTS)) {
    const modules = graph(entry).filter(asset => asset.type === 'chunk').flatMap(asset => Object.keys(asset.modules));
    assert.equal(modules.filter(id => id.endsWith('/src/static/auth-runtime-core.mjs')).length, entry === 'early-access-invite.html' ? 0 : 1, `${entry} shared Auth runtime (invitation defers until fragment cleanup)`);
    for (const name of ['site-training-api.mjs', 'site-training-state.mjs', 'app-streak-dialog.mjs']) {
      assert.ok(!modules.some(id => id.endsWith(`/src/static/${name}`)), `${entry} keeps optional service/presentation deferred`);
    }
    const landingModules = modules.filter(id => /\/src\/static\/auth-landing\.mjs(?:\?.*)?$/.test(id));
    const landingEntry = ['login.html', 'register.html'].includes(entry) ? 'auth' : entry === 'account-security.html' ? 'security' : '';
    assert.equal(landingModules.length, landingEntry ? 1 : 0, `${entry} owns only its entry-local post-auth helper`);
    if (landingEntry) {
      assert.ok(landingModules[0].endsWith(`/auth-landing.mjs?${landingEntry}-entry`));
      const chunk = graph(entry).find(asset => asset.type === 'chunk' && landingModules[0] in asset.modules);
      const controller = landingEntry === 'auth' ? 'auth.js' : 'account-security.js';
      assert.ok(Object.keys(chunk.modules).some(id => id.endsWith(`/src/static/${controller}`)), `${entry} does not add a separate helper request`);
      assert.ok(!modules.some(id => id.endsWith('/src/static/route-path.mjs?auth-landing')), `${entry} does not add a shared parser request`);
    }
    assert.equal(modules.some(id => id.endsWith('/src/static/reward-link-contract.mjs')), entry === 'badges-rewards.html', `${entry} loads the pure reward-link parser only when needed`);
    for (const name of ['reward-celebrations.mjs', 'celebration-delivery-token.mjs']) {
      assert.equal(modules.some(id => id.endsWith(`/src/static/${name}`)), entry === 'dashboard.html', `${entry} keeps reward delivery/recovery owned by Dashboard`);
    }
    for (const name of ['badge-catalog.v1.json', 'badge-evaluation.mjs', 'badge-preview-state.mjs', 'preview-delivery-ledger.mjs']) {
      assert.ok(!modules.some(id => id.endsWith(`/${name}`)), `${entry} keeps preview badge evaluation optional`);
    }
  }
  for (const asset of artifact.output) {
    assert.doesNotMatch(asset.type === 'chunk' ? asset.code : String(asset.source), /__previewBadgeTest|Local test harness only/);
    if (asset.type === 'chunk') assert.ok(!Object.keys(asset.modules).some(id => id.includes('/tests/e2e/')));
  }
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
    assert.ok(!modules.some(id => id.includes('/node_modules/qrcode/')), `${entry} keeps optional QR rendering out of its initial graph`);
    assert.ok(!modules.some(id => id.endsWith('/src/static/admin-preview.mjs')), `${entry} keeps synthetic administration out of its initial graph`);
  }
});
