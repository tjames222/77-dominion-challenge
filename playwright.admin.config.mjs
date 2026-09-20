import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.E2E_ADMIN_PORT || 4452);
const baseURL = `http://127.0.0.1:${port}`;
const output = `/tmp/77dc-admin-live-e2e-dist-${port}`;
export default defineConfig({
  testDir: './tests/e2e', testMatch: /admin-(?:live|early-access-live)\.spec\.mjs/, outputDir: './test-results/admin-live',
  fullyParallel: true, forbidOnly: Boolean(process.env.CI), retries: 0, workers: 2,
  timeout: 45_000, expect: { timeout: 10_000 }, reporter: [['list']],
  use: { baseURL, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm exec vite build --outDir ${output} && pnpm exec vite preview --outDir ${output} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/admin.html`, reuseExistingServer: false, timeout: 120_000,
    env: { CF_PAGES: 'false', VITE_ENABLE_MOCKS: 'false', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false', VITE_ENABLE_E2E_FIXTURES: 'false', VITE_ENABLE_DOMINION_NIGHT_THEME: 'true',
      VITE_ENABLE_BILLING: 'false', VITE_ENABLE_PUBLIC_SIGNUP: 'false', VITE_ENABLE_GROUP_INTEGRATIONS: 'false',
      VITE_SUPABASE_URL: `${baseURL}/__admin_fixture__`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_admin_browser_fixture' },
  },
  projects: [
    { name: 'admin-live-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'admin-live-webkit', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
