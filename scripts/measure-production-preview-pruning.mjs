import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import configuration from '../vite.config.mjs';
import { PRODUCTION_ENTRYPOINTS } from '../app-entrypoints.mjs';
import { htmlAssetReferences } from './measure-frontend-bundles.mjs';
import { checkFrontendPerformance } from './check-frontend-performance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const budgets = JSON.parse(readFileSync(new URL('../frontend-performance-budgets.json', import.meta.url), 'utf8'));
const guard = '(BUILD_SUPPORTS_LOCAL_DEMO && isLocalDemoMode())';

// The baseline changes only the new optimization, in memory. Both outputs use
// the same source, compiler, flag values and embedded SHA. Nothing is deployed.
function withoutBuildGuard() {
  return { name: 'preview-pruning-comparison-baseline', enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/src/static/api.js')) {
        if (!code.includes(guard)) throw new Error('Missing facade pruning guard.');
        return code.replace('  BUILD_SUPPORTS_LOCAL_DEMO,\n', '').replaceAll(guard, 'isLocalDemoMode()');
      }
      if (id.endsWith('/src/static/auth-runtime-core.mjs')) {
        return code.replace("export const BUILD_SUPPORTS_LOCAL_DEMO = import.meta.env.DEV\n  || import.meta.env.VITE_ENABLE_MOCKS !== 'false';\n", '');
      }
    },
  };
}

function measure(output) {
  const assets = new Map(output.map(asset => [asset.fileName, asset]));
  const assetNames = [...assets.keys()].filter(name => /\.(?:js|css)$/.test(name));
  const stableAssetName = name => name.replace(/-[\w-]{8}(?=\.(?:js|css)$)/, '-HASH');
  const stableSource = source => assetNames.reduce((value, name) =>
    value.replaceAll(posix.basename(name), posix.basename(stableAssetName(name))), String(source));
  const measuredAssets = new Map();
  const read = name => {
    if (measuredAssets.has(name)) return measuredAssets.get(name);
    const asset = assets.get(name);
    const source = asset?.type === 'chunk' ? asset.code
      : asset?.source ?? readFileSync(new URL(`../public/${name}`, import.meta.url));
    const value = { path: name, raw: Buffer.byteLength(source), gzip: gzipSync(source).length };
    measuredAssets.set(name, value);
    return value;
  };
  const routes = {};
  for (const [route, entry] of Object.entries(PRODUCTION_ENTRYPOINTS)) {
    const visited = new Set();
    const pending = htmlAssetReferences(String(assets.get(entry).source)).map(path => posix.normalize(path));
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      const asset = assets.get(name);
      if (asset?.type === 'chunk') pending.push(...asset.imports);
    }
    const total = extension => [...visited].filter(name => name.endsWith(extension))
      .reduce((sum, name) => ({ raw: sum.raw + read(name).raw, gzip: sum.gzip + read(name).gzip }), { raw: 0, gzip: 0 });
    const modules = [...visited].flatMap(name => Object.keys(assets.get(name)?.modules || {}));
    const normalizedJs = [...visited].filter(name => name.endsWith('.js')).sort()
      .map(name => stableSource(assets.get(name)?.code ?? readFileSync(new URL(`../public/${name}`, import.meta.url))))
      .join('\n');
    routes[route] = { entry, js: total('.js'), css: total('.css'), requestCount: visited.size,
      assets: [...visited].sort(),
      normalizedJsSha256: createHash('sha256').update(normalizedJs).digest('hex'),
      authRuntimeCount: modules.filter(id => id.endsWith('/auth-runtime-core.mjs')).length,
      hasMenu: modules.some(id => /\/src\/static\/(?:menu\.js|shared-header-actions\.js|menu-training-controllers\.mjs)$/.test(id)),
    };
  }
  for (const asset of output) if (/\.(?:js|css)$/.test(asset.fileName)) read(asset.fileName);
  return { routes, assets: [...measuredAssets.values()].sort((a, b) => b.gzip - a.gzip) };
}

export async function measureProductionPreviewPruning({ sourceSha = '0'.repeat(40) } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new TypeError('An exact lowercase source SHA is required.');
  const modes = {};
  for (const mocks of [false, true]) {
    const environment = {
      CF_PAGES: '1', CF_PAGES_BRANCH: mocks ? 'develop' : 'main',
      VITE_BUILD_SHA: sourceSha, VITE_ENABLE_MOCKS: String(mocks),
      VITE_ENABLE_PRODUCTION_CONNECTIONS: String(!mocks), VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false',
      VITE_SUPABASE_URL: mocks ? '' : 'https://mimolwojppbtsbvtqwpo.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: mocks ? '' : 'sb_publishable_synthetic_build_only',
      VITE_SUPABASE_ANON_KEY: '', VITE_ENABLE_DOMINION_NIGHT_THEME: 'true',
      VITE_ENABLE_PUBLIC_SIGNUP: 'false', VITE_ENABLE_BILLING: 'false',
      VITE_ENABLE_GROUP_INTEGRATIONS: 'false', VITE_ENABLE_E2E_FIXTURES: 'false',
    };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    try {
      const settings = configuration({ mode: 'production' });
      const builds = {};
      for (const prune of [false, true]) {
        const artifact = await build({ ...settings, root, configFile: false, envDir: false, logLevel: 'silent',
          define: { ...settings.define, ...Object.fromEntries(Object.entries(environment)
            .filter(([key]) => key.startsWith('VITE_')).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])) },
          plugins: [...settings.plugins, ...(!prune ? [withoutBuildGuard()] : [])],
          build: { ...settings.build, write: false },
        });
        const measured = measure(artifact.output);
        builds[prune ? 'after' : 'before'] = { ...measured, budgets: checkFrontendPerformance(measured, budgets) };
      }
      modes[mocks ? 'mockDevelop' : 'realMain'] = builds;
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  return { schemaVersion: 1, sourceSha, node: process.version,
    scope: 'Paired in-memory builds only; synthetic publishable key; no provider requests, deployment, browser timings or customer data.',
    modes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await measureProductionPreviewPruning({ sourceSha: process.argv[2] }), null, 2));
}
