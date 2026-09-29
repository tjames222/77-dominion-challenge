import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.E2E_STREAK_PORT || 4871);
const baseURL = `http://127.0.0.1:${port}`;
const output = `/tmp/77dc-app-streak-dist-${port}`;
export default defineConfig({
  testDir: './tests/e2e', testMatch: /app-streak-live\.spec\.mjs/,
  outputDir: './test-results/app-streak', fullyParallel: true,
  forbidOnly: Boolean(process.env.CI), retries: 0, workers: 2,
  timeout: 45000, expect: { timeout: 10000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { baseURL, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm exec vite build --outDir ${output} && pnpm exec vite preview --outDir ${output} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/science.html`, reuseExistingServer: false, timeout: 120000,
    env: { CF_PAGES: 'false', VITE_BUILD_SHA: 'a'.repeat(40), VITE_ENABLE_MOCKS: 'false',
      VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true', VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false',
      VITE_ENABLE_E2E_FIXTURES: 'false', VITE_ENABLE_DOMINION_NIGHT_THEME: 'true',
      VITE_ENABLE_BILLING: 'false', VITE_ENABLE_PUBLIC_SIGNUP: 'false', VITE_ENABLE_GROUP_INTEGRATIONS: 'false',
      VITE_SUPABASE_URL: `${baseURL}/__admin_fixture__`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_streak_fixture' },
  },
  projects: [
    { name: 'streak-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'streak-webkit', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
