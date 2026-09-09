import { defineConfig, loadEnv } from 'vite';
import { readFile } from 'node:fs/promises';
import { PRODUCTION_ENTRYPOINTS } from './app-entrypoints.mjs';
import { isCloudflarePreviewEnvironment } from './scripts/normalize-cloudflare-frontend-env.mjs';

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
          return html.replaceAll(
            'data-enable-dominion-night="false"',
            `data-enable-dominion-night="${String(dominionNightEnabled)}"`,
          );
        },
      },
    ],
    build: {
      rollupOptions: {
        input: PRODUCTION_ENTRYPOINTS,
      },
    },
  };
});
