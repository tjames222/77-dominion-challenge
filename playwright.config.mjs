import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:' + port;
const themes = [
  { id: 'light', colorScheme: 'light' },
  { id: 'dark', colorScheme: 'dark' },
  { id: 'dominion-night', colorScheme: 'dark', entitlementGated: true },
];

const breakpoints = [
  {
    id: 'mobile',
    use: {
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 844 },
    },
  },
  {
    id: 'tablet',
    use: {
      ...devices['iPad Mini'],
      viewport: { width: 768, height: 1024 },
    },
  },
  {
    id: 'desktop',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 1000 },
    },
  },
];

const visualProjects = breakpoints.flatMap((breakpoint) => themes.map((theme) => ({
  name: 'visual-' + breakpoint.id + '-' + theme.id,
  testMatch: /visual-routes\.spec\.mjs/,
  metadata: {
    breakpoint: breakpoint.id,
    theme: theme.id,
    colorScheme: theme.colorScheme,
    entitlementGated: Boolean(theme.entitlementGated),
  },
  use: {
    ...breakpoint.use,
    colorScheme: theme.colorScheme,
  },
})));

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{projectName}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.03,
      threshold: 0.25,
    },
  },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: './node_modules/.bin/vite --host 127.0.0.1 --port ' + port,
        url: baseURL + '/index.html',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          VITE_ENABLE_MOCKS: 'true',
          VITE_ENABLE_E2E_FIXTURES: 'true',
          VITE_ENABLE_DOMINION_NIGHT_THEME: 'true',
        },
      },
  projects: [
    {
      name: 'chromium-functional',
      testIgnore: /visual-routes\.spec\.mjs/,
      metadata: {
        breakpoint: 'desktop',
        theme: 'dark',
        colorScheme: 'dark',
      },
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
      },
    },
    ...visualProjects,
  ],
});
