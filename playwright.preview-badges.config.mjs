import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PREVIEW_BADGES_PORT || 4497);
const hybridPort = Number(process.env.E2E_PREVIEW_BADGES_HYBRID_PORT || 4498);
const baseURL = `http://127.0.0.1:${port}`;
const hybridURL = `http://127.0.0.1:${hybridPort}`;
const output = `./test-results/preview-badges-dist-${port}`;
const flags = {
  CF_PAGES: 'false', VITE_ENABLE_MOCKS: 'true', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'false',
  VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false', VITE_ENABLE_E2E_FIXTURES: 'false',
  VITE_ENABLE_DOMINION_NIGHT_THEME: 'true', VITE_ENABLE_BILLING: 'false',
  VITE_ENABLE_PUBLIC_SIGNUP: 'false', VITE_ENABLE_GROUP_INTEGRATIONS: 'false',
  VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: '',
};

export default defineConfig({
  testDir: './tests/e2e', testMatch: /preview-badges-(?:built|hybrid)\.spec\.mjs/,
  outputDir: './test-results/preview-badges', fullyParallel: false, workers: 1,
  forbidOnly: Boolean(process.env.CI), retries: 0, timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: { locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: `pnpm exec vite build --config tests/e2e/support/preview-badge-vite.config.mjs --outDir ${output} && pnpm exec vite preview --outDir ${output} --host 127.0.0.1 --port ${port} --strictPort`,
      url: `${baseURL}/tests/e2e/fixtures/preview-badges.html`, reuseExistingServer: false, timeout: 120_000, env: flags,
    },
    {
      // Hybrid preview intentionally exists only in DEV. These additional
      // real-SDK tests must not turn on hybrid Auth in a production build.
      command: `pnpm exec vite --host 127.0.0.1 --port ${hybridPort} --strictPort`,
      url: `${hybridURL}/tests/e2e/fixtures/preview-badges.html`, reuseExistingServer: false, timeout: 120_000,
      env: { ...flags, VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'true',
        VITE_SUPABASE_URL: `${hybridURL}/__fou_1452_supabase__`,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fou_1452_browser_fixture' },
    },
  ],
  projects: [
    { name: 'preview-badges-built-chromium', testMatch: /preview-badges-built\.spec\.mjs/,
      use: { ...devices['Desktop Chrome'], baseURL, browserName: 'chromium' } },
    { name: 'preview-badges-built-webkit', testMatch: /preview-badges-built\.spec\.mjs/,
      use: { ...devices['iPhone 13'], baseURL, browserName: 'webkit' } },
    { name: 'preview-badges-hybrid-chromium', testMatch: /preview-badges-hybrid\.spec\.mjs/,
      use: { ...devices['Desktop Chrome'], baseURL: hybridURL, browserName: 'chromium' } },
    { name: 'preview-badges-hybrid-webkit', testMatch: /preview-badges-hybrid\.spec\.mjs/,
      use: { ...devices['iPhone 13'], baseURL: hybridURL, browserName: 'webkit' } },
  ],
});
