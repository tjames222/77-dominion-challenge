import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'vite';
import { groupIntegrationsEnabled } from './group-integration-launch.mjs';

const guard = "import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS !== 'false' && ";
const flags = ['false', 'true', undefined, null, '', ' FALSE ', ' TRUE ', 'False', 'True',
  '0', '1', false, true, 0, 1, 'yes', 'no'];
const fragments = ['', '#unrelated=keep', '#integration-setup=synthetic%2Btoken',
  '#integration-error=authorization_denied', '#integration-error=unknown',
  '#integration-setup=synthetic%2Btoken&integration-error=unknown&unrelated=remove'];
const routes = [
  ['community', 'takeIntegrationCallbackFragment'],
  ['group-settings', 'captureIntegrationCallback'],
].map(([route, callback]) => {
  const source = readFileSync(new URL(`./${route}.js`, import.meta.url), 'utf8');
  const declaration = source.match(/const GROUP_INTEGRATIONS_ENABLED = [\s\S]*?\n\);/)?.[0];
  const body = source.match(new RegExp(`function ${callback}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(declaration?.includes(guard), `${route}: exactly the conservative guard is present`);
  assert.ok(body, `${route}: exercise the actual callback body`);
  return { route, callback, declaration, body };
});

function fixture({ declaration, body, callback }, baseline = false) {
  return `
    ${baseline ? declaration.replace(guard, '') : declaration}
    return function run(hash) {
      const state = { integrationSetupToken: 'previous', integrationSetup: { previous: true } };
      const changes = [], feedback = [];
      const window = { location: { hash, pathname: '/fixture.html', search: '?keep=1' },
        history: { replaceState(...args) { changes.push(args); } } };
      const setFeedback = (...args) => feedback.push(args);
      ${body}
      ${callback}();
      return { enabled: GROUP_INTEGRATIONS_ENABLED, state, changes, feedback };
    };
  `;
}

test('compiled integration guard preserves all 17 flag values and 204 callback outcomes', async () => {
  for (const flag of flags) {
    const source = `import { groupIntegrationsEnabled } from ${JSON.stringify(fileURLToPath(new URL('./group-integration-launch.mjs', import.meta.url)))};
      ${routes.map((route, index) => `export const route${index} = (() => { ${fixture(route)} })();`).join('\n')}`;
    const result = await build({ configFile: false, logLevel: 'silent', envDir: false,
      define: { 'import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS': JSON.stringify(flag) ?? 'undefined' },
      plugins: [{ name: 'compiled-integration-semantics', enforce: 'pre',
        resolveId(id) { if (id === 'integration-semantics' || id.endsWith('/integration-semantics')) return '\0integration-semantics'; },
        load(id) { if (id === '\0integration-semantics') return source; },
      }],
      build: { write: false, lib: { entry: 'integration-semantics', name: 'IntegrationSemantics', formats: ['iife'] } },
    });
    const chunks = [result].flat().flatMap(bundle => bundle.output).filter(asset => asset.type === 'chunk');
    assert.equal(chunks.length, 1);
    const context = { URLSearchParams, fetch() { assert.fail('Semantics tests cannot make requests.'); } };
    runInNewContext(chunks[0].code, context);
    for (const [index, route] of routes.entries()) {
      const baseline = new Function('groupIntegrationsEnabled', 'flag',
        fixture(route, true).replaceAll('import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS', 'flag'))(groupIntegrationsEnabled, flag);
      for (const fragment of fragments) {
        const observed = JSON.parse(JSON.stringify(context.IntegrationSemantics[`route${index}`](fragment)));
        assert.deepEqual(observed, baseline(fragment), `${route.route}/${String(flag)}/${fragment}`);
        if (fragment.includes('integration-')) assert.deepEqual(observed.changes, [[{}, '', '/fixture.html?keep=1']],
          'The capability is scrubbed even while providers are disabled.');
        else assert.deepEqual(observed.changes, [], 'Unrelated fragments retain their current behavior.');
      }
    }
  }
});

test('compiled integration browser cases stay in both required main-suite engines', async () => {
  const { default: config } = await import('../../playwright.config.mjs');
  const file = 'group-integration-pruning.spec.mjs';
  const desktop = config.projects.find(project => project.name === 'chromium-functional');
  const mobile = config.projects.find(project => project.name === 'webkit-frontend-performance-mobile');
  assert.ok(desktop);
  assert.equal(desktop.testIgnore.some(pattern => pattern.test(file)), false);
  assert.equal(mobile.use.browserName, 'webkit');
  assert.equal(mobile.testMatch.test(file), true);
  assert.equal(mobile.testMatch.test('frontend-performance.spec.mjs'), true, 'Existing performance cases remain selected.');
  assert.equal(mobile.testMatch.test('admin-live.spec.mjs'), false, 'Do not broaden into unrelated live suites.');
});
