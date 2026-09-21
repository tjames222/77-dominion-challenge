import productionConfig from '../../../vite.config.mjs';
import { PRODUCTION_ENTRYPOINTS } from '../../../app-entrypoints.mjs';

// This extra entry is only for production-compiled API tests. Do not add it to
// the application entrypoint inventory or alter production split/CSS settings.
export default (environment) => {
  const config = productionConfig(environment);
  config.build.rollupOptions.input = {
    ...PRODUCTION_ENTRYPOINTS,
    previewBadgeTest: 'tests/e2e/fixtures/preview-badges.html',
  };
  return config;
};
