import { defineConfig, devices } from '@playwright/test';

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for the local production rehearsal.`);
  return value;
};

const supabaseUrl = required('LOCAL_SUPABASE_URL');
const parsedSupabaseUrl = new URL(supabaseUrl);
if (!['127.0.0.1', 'localhost'].includes(parsedSupabaseUrl.hostname)) {
  throw new Error('The local production rehearsal refuses a non-local Supabase URL.');
}
required('LOCAL_SUPABASE_ANON_KEY');
required('LOCAL_SUPABASE_SERVICE_ROLE_KEY');
required('LOCAL_DOCKER_BIN');
const postgresContainer = required('LOCAL_POSTGRES_CONTAINER');
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(postgresContainer)) {
  throw new Error('LOCAL_POSTGRES_CONTAINER is not a valid container name.');
}

const port = Number(process.env.LOCAL_PRODUCTION_PORT || 4192);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /local-production-stack\.spec\.mjs/,
  outputDir: './test-results/local-production-stack',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
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
    command: `./node_modules/.bin/vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{
    name: 'local-production-stack',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'dark',
    },
  }],
});
