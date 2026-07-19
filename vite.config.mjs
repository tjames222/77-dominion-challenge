import { defineConfig } from 'vite';
import { PRODUCTION_ENTRYPOINTS } from './app-entrypoints.mjs';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: PRODUCTION_ENTRYPOINTS,
    },
  },
});
