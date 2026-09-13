import { defineConfig, loadEnv } from 'vite';
import { readFile } from 'node:fs/promises';
import { PRODUCTION_ENTRYPOINTS } from './app-entrypoints.mjs';
import { isCloudflarePreviewEnvironment } from './scripts/normalize-cloudflare-frontend-env.mjs';
import { renderInitialPreviewFeedback } from './src/static/preview-feedback.mjs';

export function isSharedMenuModule(id) {
  return /\/src\/static\/menu\.js$/.test(id)
    || /\/src\/assets\/(?:styles|product|dialog|menu|dominion-night|dominion-platinum)\.css$/.test(id)
    || id === '\0vite/modulepreload-polyfill.js';
}

export function resolveTrainingModulePreloads(filename, dependencies, { hostType }) {
  // WebKit retains a failed modulepreload across location.reload, even for a
  // no-store HTTP 503. Native import alone recovers in the new document. Omit
  // only these optional training chunks' redundant JS preload; Vite still appends and awaits
  // its CSS dependencies. Other imports and HTML preloads are unchanged.
  const optionalTrainingJs = /(?:^|\/)(?:site-training-ui|menu-training-controllers)(?:-[\w-]+)?\.js$/;
  if (hostType === 'js' && optionalTrainingJs.test(filename)) {
    // UI imports also refer back to the already-loaded controller/catalog.
    // Preloading it again is redundant and WebKit may fetch it twice.
    return dependencies.filter((dependency) => !optionalTrainingJs.test(dependency));
  }
  return dependencies;
}

export function productionShareRouteEnabled(env, buildEnvironment = process.env) {
  return ['1', 'true', 'yes'].includes(buildEnvironment.CF_PAGES)
    && buildEnvironment.CF_PAGES_BRANCH === 'main'
    && env.VITE_ENABLE_MOCKS === 'false'
    && env.VITE_ENABLE_PRODUCTION_CONNECTIONS === 'true'
    && env.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS !== 'true'
    && env.VITE_ENABLE_E2E_FIXTURES !== 'true'
    && env.VITE_SUPABASE_URL === 'https://mimolwojppbtsbvtqwpo.supabase.co';
}

export function productionShareRoutePlugin(env, buildEnvironment = process.env) {
  return {
    name: 'dominion-production-public-share-route',
    apply: 'build',
    async generateBundle() {
      if (!productionShareRouteEnabled(env, buildEnvironment)) return;
      this.emitFile({ type: 'asset', fileName: '_worker.js',
        source: await readFile(new URL('./src/cloudflare/public-share-worker.mjs', import.meta.url), 'utf8') });
      // Only shares invoke the Worker; ordinary site assets remain static.
      this.emitFile({ type: 'asset', fileName: '_routes.json',
        source: JSON.stringify({ version: 1, include: ['/share', '/share/*'], exclude: [] }) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const isCloudflarePreview = isCloudflarePreviewEnvironment(process.env);
  // Preview builds receive only the wrapper's sanitized process environment.
  // Do not let a checked-out local env file restore a live connection after it
  // has been deliberately removed.
  const env = isCloudflarePreview ? process.env : loadEnv(mode, '.', '');
  const dominionNightEnabled = env.VITE_ENABLE_DOMINION_NIGHT_THEME === 'true';

  return {
    ...(isCloudflarePreview ? { envDir: false } : {}),
    base: './',
    plugins: [
      productionShareRoutePlugin(env),
      {
        name: 'dominion-theme-feature-flags',
        enforce: 'pre',
        transformIndexHtml(html) {
          const themedHtml = html.replaceAll(
            'data-enable-dominion-night="false"',
            `data-enable-dominion-night="${String(dominionNightEnabled)}"`,
          );
          return renderInitialPreviewFeedback(themedHtml, {
            mocksEnabled: env.VITE_ENABLE_MOCKS === 'true',
            integrationsEnabled: env.VITE_ENABLE_GROUP_INTEGRATIONS === 'true',
          });
        },
      },
    ],
    build: {
      modulePreload: { resolveDependencies: resolveTrainingModulePreloads },
      rollupOptions: {
        input: PRODUCTION_ENTRYPOINTS,
        output: {
          codeSplitting: {
            groups: [
              // Keep exactly the existing static menu graph together. Moving
              // the controllers out must not turn its shared state/contract
              // helpers into additional startup requests on every route.
              { name: 'menu', test: isSharedMenuModule, priority: 20 },
              // The optional controllers and catalog share one failure/reload
              // boundary. The higher-priority menu owns their common helpers;
              // dynamic imports (including the coachmark UI) stay separate.
              { name: 'menu-training-controllers', test: /\/src\/static\/menu-training-controllers\.mjs$/, priority: 10 },
            ],
          },
        },
      },
    },
  };
});
