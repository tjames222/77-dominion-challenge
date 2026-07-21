import { defineConfig, loadEnv } from 'vite';
import { PRODUCTION_ENTRYPOINTS } from './app-entrypoints.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const dominionNightEnabled = env.VITE_ENABLE_DOMINION_NIGHT_THEME === 'true';

  return {
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
