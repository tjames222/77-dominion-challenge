import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_RECOVERY_PORT || 4442);
const baseURL = `http://127.0.0.1:${port}`;
const output = `/tmp/77dc-recovery-e2e-dist-${port}`;

export default defineConfig({
  testDir: './tests/e2e', testMatch: /recovery-mfa\.spec\.mjs/,
  outputDir: './test-results/recovery-mfa', fullyParallel: true,
  forbidOnly: Boolean(process.env.CI), retries: 0, workers: 2,
  timeout: 45_000, expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: { baseURL, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm exec vite build --outDir ${output} && pnpm exec vite preview --outDir ${output} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/reset-password.html`, reuseExistingServer: false, timeout: 120_000,
    env: {
      CF_PAGES: 'false', VITE_ENABLE_MOCKS: 'false', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
      VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false', VITE_ENABLE_E2E_FIXTURES: 'false',
      VITE_ENABLE_DOMINION_NIGHT_THEME: 'true', VITE_ENABLE_BILLING: 'false',
      VITE_ENABLE_PUBLIC_SIGNUP: 'false', VITE_ENABLE_GROUP_INTEGRATIONS: 'false',
      VITE_SUPABASE_URL: baseURL,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_recovery_browser_fixture',
    },
  },
  projects: [
    { name: 'recovery-chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'recovery-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit', viewport: { width: 390, height: 844 } } },
  ],
});
