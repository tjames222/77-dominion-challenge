import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_FOU_1452_PORT || 4188);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /fou-1452-hybrid-auth\.spec\.mjs/,
  outputDir: './test-results/fou-1452-hybrid-auth',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `./node_modules/.bin/vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'true',
      VITE_SUPABASE_URL: `${baseURL}/__fou_1452_supabase__`,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fou_1452_browser_fixture',
    },
  },
  projects: [{
    name: 'fou-1452-hybrid-auth',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'dark',
    },
  }],
});
