import { defineConfig, loadEnv } from 'vite';
import { PRODUCTION_ENTRYPOINTS } from './app-entrypoints.mjs';
import { isCloudflarePreviewEnvironment } from './scripts/normalize-cloudflare-frontend-env.mjs';

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
