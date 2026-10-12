import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import configuration, { isSharedMenuModule } from '../vite.config.mjs';
import { PRODUCTION_ENTRYPOINTS } from '../app-entrypoints.mjs';
import { htmlAssetReferences } from './measure-frontend-bundles.mjs';
import { checkFrontendPerformance } from './check-frontend-performance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const HEADER_BASELINE_SHA = 'ec006e252d6cd333c73c8b769c682421bf3b2117';
const budgets = JSON.parse(readFileSync(new URL('../frontend-performance-budgets.json', import.meta.url), 'utf8'));

function measure(output) {
  const assets = new Map(output.map(asset => [asset.fileName, asset]));
  const measurements = new Map();
  const read = name => {
    if (!measurements.has(name)) {
      const asset = assets.get(name);
      const source = asset?.type === 'chunk' ? asset.code : asset?.source ?? readFileSync(new URL(`../public/${name}`, import.meta.url));
      measurements.set(name, { path: name, raw: Buffer.byteLength(source), gzip: gzipSync(source).length });
    }
    return measurements.get(name);
  };
  const routes = {};
  for (const [route, entry] of Object.entries(PRODUCTION_ENTRYPOINTS)) {
    const visited = new Set();
    const pending = htmlAssetReferences(String(assets.get(entry).source)).map(path => posix.normalize(path));
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      pending.push(...(assets.get(name)?.imports || []));
    }
    const total = extension => [...visited].filter(name => name.endsWith(extension))
      .reduce((sum, name) => ({ raw: sum.raw + read(name).raw, gzip: sum.gzip + read(name).gzip }), { raw: 0, gzip: 0 });
    const modules = [...visited].flatMap(name => Object.keys(assets.get(name)?.modules || {}));
    routes[route] = { entry, js: total('.js'), css: total('.css'), requestCount: visited.size,
      assets: [...visited].sort(), authRuntimeCount: modules.filter(id => id.endsWith('/auth-runtime-core.mjs')).length,
      hasMenu: modules.some(id => id.endsWith('/menu.js')),
      hasHeaderController: modules.some(id => id.endsWith('/shared-header-actions.js')) };
  }
  for (const asset of output) if (/\.(?:js|css)$/.test(asset.fileName)) read(asset.fileName);
  return { routes, assets: [...measurements.values()].sort((a, b) => b.gzip - a.gzip) };
}

export async function measureHeaderDeferral({ sourceSha = '0'.repeat(40), pinnedBaseline = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new TypeError('An exact lowercase source SHA is required.');
  // Only this slice's two modified runtime sources and menu chunk placement
  // are restored in memory. The baseline is pinned, not an untrusted git ref.
  const baseline = pinnedBaseline ? new Map(['menu.js', 'shared-header-actions.js'].map(name => [name,
    execFileSync('git', ['show', `${HEADER_BASELINE_SHA}:src/static/${name}`], { cwd: root, encoding: 'utf8' })])) : null;
  const modes = {};
  for (const mocks of [false, true]) {
    const environment = { CF_PAGES: '1', CF_PAGES_BRANCH: mocks ? 'develop' : 'main',
      VITE_BUILD_SHA: sourceSha, VITE_ENABLE_MOCKS: String(mocks), VITE_ENABLE_PRODUCTION_CONNECTIONS: String(!mocks),
      VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false', VITE_SUPABASE_URL: mocks ? '' : 'https://mimolwojppbtsbvtqwpo.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: mocks ? '' : 'sb_publishable_synthetic_build_only', VITE_SUPABASE_ANON_KEY: '',
      VITE_ENABLE_DOMINION_NIGHT_THEME: 'true', VITE_ENABLE_PUBLIC_SIGNUP: 'false', VITE_ENABLE_BILLING: 'false',
      VITE_ENABLE_GROUP_INTEGRATIONS: 'false', VITE_ENABLE_E2E_FIXTURES: 'false' };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    try {
      const builds = {};
      for (const deferred of [false, true]) {
        const settings = configuration({ mode: 'production' });
        if (!deferred) {
          if (baseline) {
            settings.build.rollupOptions.output.codeSplitting.groups.find(group => group.name === 'menu').test =
              id => !id.endsWith('/streak-summary.mjs') && isSharedMenuModule(id);
            settings.plugins.push({ name: 'pinned-header-baseline', enforce: 'pre', transform(code, id) {
              for (const [name, source] of baseline) if (id === `${root}src/static/${name}`) return source;
            } });
          } else {
            settings.build.rollupOptions.output.codeSplitting.groups.find(group => group.name === 'menu').test =
              id => isSharedMenuModule(id) || id.endsWith('/src/static/shared-header-actions.js');
            settings.plugins.push({ name: 'history-independent-eager-header-comparison', enforce: 'pre', transform(code, id) {
              if (!id.endsWith('/src/static/shared-header-loader.mjs')) return;
              const boundary = "() => import('./shared-header-actions.js')";
              if (!code.includes(boundary)) throw new Error('Missing deferred header boundary.');
              return "import { createAuthenticatedHeaderActions } from './shared-header-actions.js';\n"
                + code.replace(boundary, '() => Promise.resolve({ createAuthenticatedHeaderActions })');
            } });
          }
        }
        const artifact = await build({ ...settings, root, configFile: false, envDir: false, logLevel: 'silent',
          define: { ...settings.define, ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('VITE_'))
            .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])) },
          build: { ...settings.build, write: false } });
        const measured = measure(artifact.output);
        builds[deferred ? 'after' : 'before'] = { ...measured, budgets: checkFrontendPerformance(measured, budgets) };
      }
      modes[mocks ? 'mockDevelop' : 'realMain'] = builds;
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  return { schemaVersion: 1, sourceSha, baselineSha: pinnedBaseline ? HEADER_BASELINE_SHA : null, node: process.version,
    scope: pinnedBaseline ? 'Local paired current-tree builds with pinned pre-slice sources; no network, providers or deployment.'
      : 'History-independent current-tree eager/deferred graph comparison; no network, providers or deployment.', modes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await measureHeaderDeferral({ sourceSha: process.argv[2], pinnedBaseline: process.argv.includes('--pinned-baseline') }), null, 2));
}
