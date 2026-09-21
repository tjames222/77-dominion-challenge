import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const workflow = readFileSync(
  new URL('../../.github/workflows/browser-quality.yml', import.meta.url),
  'utf8',
);
const playwrightConfig = readFileSync(
  new URL('../../playwright.config.mjs', import.meta.url),
  'utf8',
);
const mfaPlaywrightConfig = readFileSync(new URL('../../playwright.mfa.config.mjs', import.meta.url), 'utf8');
const dailyBootstrapConfig = readFileSync(new URL('../../playwright.daily-bootstrap.config.mjs', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const deployWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);
const screenshotCss = readFileSync(
  new URL('../../tests/e2e/support/screenshot.css', import.meta.url),
  'utf8',
);
const stylesCss = readFileSync(
  new URL('../assets/styles.css', import.meta.url),
  'utf8',
);
const fontFacesCss = readFileSync(new URL('../assets/fonts/inter-fonts.css', import.meta.url), 'utf8');
const shareComposerCss = readFileSync(
  new URL('../assets/share-composer.css', import.meta.url),
  'utf8',
);
const appTestHarness = readFileSync(
  new URL('../../tests/e2e/support/app-test.mjs', import.meta.url),
  'utf8',
);
const productionFont = readFileSync(
  new URL('../assets/fonts/InterVariable.woff2', import.meta.url),
);
const productionFontLicense = readFileSync(
  new URL('../../public/fonts/Inter-LICENSE.txt', import.meta.url),
  'utf8',
);
const buildAssetVerifier = readFileSync(
  new URL('../../scripts/verify-build-assets.mjs', import.meta.url),
  'utf8',
);

const workflowJob = (id) => {
  const job = workflow.split(new RegExp(`^  ${id}:\\n`, 'm'))[1];
  assert.ok(job, `Missing workflow job ${id}`);
  return job.split(/^  [\w-]+:\n/m)[0];
};

test('two standard-runner shards preserve preliminary checks and the full main matrix', () => {
  const preflight = workflowJob('preflight');
  for (const command of ['pnpm test', 'pnpm build', 'pnpm test:e2e:auth', 'pnpm test:e2e:mfa', 'pnpm test:e2e:admin', 'pnpm test:e2e:daily-bootstrap', 'pnpm test:e2e:preview-badges']) {
    assert.ok(preflight.includes(`run: ${command}\n`), `Missing preliminary ${command}`);
  }
  const shards = workflowJob('browser-shards');
  assert.match(shards, /needs: preflight/);
  assert.match(shards, /fail-fast: false/);
  assert.match(shards, /shard: \[1, 2\]/);
  for (const command of ['pnpm test:e2e', 'pnpm test:e2e:update']) {
    assert.ok(shards.includes(`run: ${command} --shard=\${{ matrix.shard }}/2 --reporter=github,html,json\n`));
  }
  assert.doesNotMatch(shards, /--grep|--project|--workers|--retries|--timeout|continue-on-error/);
  assert.equal((workflow.match(/runs-on: ubuntu-latest/g) || []).length, 3);
  assert.equal((workflow.match(/timeout-minutes: 60/g) || []).length, 3);
  assert.match(playwrightConfig, /workers: process\.env\.CI \? 2 : undefined/);
  assert.match(playwrightConfig, /retries: process\.env\.CI \? 1 : 0/);
  assert.match(playwrightConfig, /timeout: 45_000/);
});

test('the unchanged required check is an always-run fail-closed aggregate', () => {
  const aggregate = workflowJob('browser-quality');
  assert.equal((workflow.match(/name: Routes, accessibility, and visuals/g) || []).length, 1);
  assert.match(aggregate, /needs: \[preflight, browser-shards\]\n\s+if: always\(\)/);
  assert.match(aggregate, /BROWSER_NEEDS: \$\{\{ toJSON\(needs\) \}\}[\s\S]*?run: node scripts\/browser-shard-artifacts\.mjs needs/);
  assert.doesNotMatch(workflow, /continue-on-error|merge-multiple/);
  assert.ok(aggregate.indexOf('browser-shard-artifacts.mjs needs') < aggregate.indexOf('- name: Download shard 1'));
  assert.ok(aggregate.indexOf('browser-shard-artifacts.mjs needs') < aggregate.indexOf('run: pnpm install --frozen-lockfile'));
  assert.ok(aggregate.indexOf('run: pnpm install --frozen-lockfile') < aggregate.indexOf('browser-shard-artifacts.mjs merge'));
  assert.ok(aggregate.indexOf('browser-shard-artifacts.mjs merge') < aggregate.indexOf('- name: Upload generated visual baselines'));
  assert.match(aggregate, /- name: Upload generated visual baselines\n\s+if: needs\.preflight\.outputs\.generate == 'true'/);
});

test('zero-baseline pull requests fail after complete review evidence rather than passing without comparison', () => {
  assert.match(workflowJob('browser-quality'), /- name: Require committed baselines after bootstrap\n\s+if: github\.event_name == 'pull_request' && needs\.preflight\.outputs\.present != 'true'[\s\S]*?exit 1/);
});

test('artifact transport separates exact-run shards and opts in only bounded hidden evidence', () => {
  const preflight = workflowJob('preflight');
  const shards = workflowJob('browser-shards');
  const aggregate = workflowJob('browser-quality');
  assert.match(preflight, /name: browser-plan-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(shards, /name: browser-shard-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(shards, /name: browser-quality-shard-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  for (const index of [1, 2]) assert.ok(aggregate.includes(`path: .browser-quality/received/shard-${index}/`));
  assert.equal((workflow.match(/include-hidden-files: true/g) || []).length, 3);
  assert.match(shards, /- name: Upload shard staging evidence[\s\S]*?retention-days: 3/);
  assert.match(preflight, /- name: Upload exact-run test plan[\s\S]*?retention-days: 3/);
});

test('manual baseline generation forcibly rewrites every screenshot', () => {
  assert.equal(
    packageJson.scripts['test:e2e:update'],
    'playwright test --update-snapshots=all',
  );
  assert.match(
    workflow,
    /- name: Generate reviewable Linux visual baselines[\s\S]*?run: pnpm test:e2e:update/,
  );
});

test('required browser CI includes production-mode MFA with only a local synthetic provider', () => {
  assert.equal(packageJson.scripts['test:e2e:mfa'], 'playwright test --config=playwright.mfa.config.mjs');
  assert.equal(packageJson.scripts['test:e2e:admin'], 'playwright test --config=playwright.admin.config.mjs');
  assert.match(workflow, /- name: Verify production-built admin read boundaries\n\s+run: pnpm test:e2e:admin/);
  assert.match(workflow, /- name: Hybrid dev authentication regression\n\s+run: pnpm test:e2e:auth\n\n\s+- name: MFA production-mode authentication regression\n\s+run: pnpm test:e2e:mfa/);
  assert.match(playwrightConfig, /\/mfa-live-auth\\\.spec\\\.mjs\//);
  assert.match(mfaPlaywrightConfig, /VITE_ENABLE_MOCKS: 'false', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true'/);
  assert.match(mfaPlaywrightConfig, /VITE_SUPABASE_URL: `\$\{baseURL\}\/__mfa_fixture__`/);
  assert.match(mfaPlaywrightConfig, /const baseURL = `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.doesNotMatch(mfaPlaywrightConfig, /supabase\.co|SUPABASE_ACCESS_TOKEN|SERVICE_ROLE_KEY|CLOUDFLARE_API_TOKEN/);
  assert.match(mfaPlaywrightConfig, /outputFolder: 'playwright-report'/);
});

test('Daily Action bootstrap gates use production wiring with only synthetic local data', () => {
  assert.equal(packageJson.scripts['test:e2e:daily-bootstrap'], 'playwright test --config=playwright.daily-bootstrap.config.mjs');
  assert.equal(packageJson.scripts['test:daily-bootstrap-sql'], 'node --test scripts/daily-action-bootstrap.sql.test.mjs');
  assert.match(workflow, /- name: Verify focused production-built Daily Action reads\n\s+run: pnpm test:e2e:daily-bootstrap/);
  assert.match(ciWorkflow, /- name: Verify focused Daily Action SQL and canonical date boundaries\n\s+run: pnpm run test:daily-bootstrap-sql/);
  assert.match(playwrightConfig, /\/daily-action-bootstrap-live\\\.spec\\\.mjs\//);
  assert.match(dailyBootstrapConfig, /VITE_ENABLE_MOCKS: 'false', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true'/);
  assert.match(dailyBootstrapConfig, /VITE_SUPABASE_URL: `\$\{baseURL\}\/__daily_fixture__`/);
  assert.match(dailyBootstrapConfig, /const baseURL = `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.doesNotMatch(dailyBootstrapConfig, /supabase\.co|SUPABASE_ACCESS_TOKEN|SERVICE_ROLE_KEY|CLOUDFLARE_API_TOKEN/);
});

test('optional preview badge tests are a required isolated compiled and hybrid browser gate', () => {
  const config = readFileSync(new URL('../../playwright.preview-badges.config.mjs', import.meta.url), 'utf8');
  const buildConfig = readFileSync(new URL('../../tests/e2e/support/preview-badge-vite.config.mjs', import.meta.url), 'utf8');
  assert.equal(packageJson.scripts['test:e2e:preview-badges'], 'playwright test --config=playwright.preview-badges.config.mjs');
  assert.match(workflow, /run: pnpm test:e2e:daily-bootstrap\n\n\s+- name: Verify optional preview badge ownership boundaries\n\s+run: pnpm test:e2e:preview-badges/);
  assert.ok(playwrightConfig.includes('/preview-badges-(?:built|hybrid)\\.spec\\.mjs/'));
  assert.match(config, /retries: 0/);
  assert.match(config, /vite build --config tests\/e2e\/support\/preview-badge-vite\.config\.mjs/);
  assert.match(config, /VITE_ENABLE_MOCKS: 'true', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'false'/);
  assert.match(config, /VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false', VITE_ENABLE_E2E_FIXTURES: 'false'/);
  assert.match(config, /VITE_SUPABASE_URL: `\$\{hybridURL\}\/__fou_1452_supabase__`/);
  assert.match(config, /outputFolder: 'playwright-report'/);
  assert.doesNotMatch(config, /supabase\.co|SUPABASE_ACCESS_TOKEN|SERVICE_ROLE_KEY|CLOUDFLARE_API_TOKEN/);
  assert.match(buildConfig, /\.\.\.PRODUCTION_ENTRYPOINTS/);
  assert.match(buildConfig, /previewBadgeTest: 'tests\/e2e\/fixtures\/preview-badges\.html'/);
  assert.doesNotMatch(buildConfig, /codeSplitting|modulePreload|\.css|define:/);
});

test('browser diagnostics are short-lived and uploaded only when the gate fails', () => {
  assert.match(
    workflow,
    /- name: Upload browser diagnostics\n\s+if: failure\(\)[\s\S]*?retention-days: 3/,
  );
  assert.doesNotMatch(
    workflow,
    /- name: Upload browser diagnostics\n\s+if: always\(\)/,
  );
  assert.match(
    workflow,
    /- name: Upload browser diagnostics[\s\S]*?path: playwright-report\/\n[\s\S]*?retention-days: 3/,
  );
  assert.doesNotMatch(
    workflow,
    /- name: Upload browser diagnostics[\s\S]*?path:[\s\S]*?test-results\//,
  );
  assert.match(
    playwrightConfig,
    /video: process\.env\.CI \? 'off' : 'retain-on-failure'/,
  );
});

test('review baselines and release frontend artifacts keep their dedicated retention', () => {
  assert.match(
    workflow,
    /- name: Upload generated visual baselines[\s\S]*?name: browser-visual-baselines-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 14/,
  );
  assert.match(
    deployWorkflow,
    /- name: Upload frontend artifact[\s\S]*?name: production-frontend-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 7/,
  );
});

test('production bundles the pinned Inter variable font as the brand family', () => {
  assert.match(stylesCss, /@import '\.\/fonts\/inter-fonts\.css';/);
  assert.match(
    fontFacesCss,
    /@font-face \{[\s\S]*?font-family: "Inter";[\s\S]*?InterVariable\.woff2[\s\S]*?font-weight: 100 900;[\s\S]*?font-display: swap;/,
  );
  assert.match(
    stylesCss,
    /:root \{[\s\S]*?--font-sans: "Inter"[\s\S]*?--font-display: var\(--font-sans\);[\s\S]*?font-family: var\(--font-sans\);/,
  );
  assert.equal(
    createHash('sha256').update(productionFont).digest('hex'),
    '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3',
  );
  assert.match(productionFontLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.equal(
    packageJson.scripts.build,
    'node scripts/build-frontend.mjs',
  );
  assert.match(buildAssetVerifier, /fonts\/Inter-LICENSE\.txt/);
  assert.match(buildAssetVerifier, /InterVariable-/);
});

test('the everyday font stays under 100 KB without removing extended-language coverage', () => {
  const font = readFileSync(new URL('../assets/fonts/InterLatinUI.woff2', import.meta.url));
  const metadata = JSON.parse(readFileSync(new URL('../assets/fonts/inter-subset.json', import.meta.url), 'utf8'));
  assert.ok(font.length <= 100_000);
  assert.equal(font.length, metadata.subsetBytes);
  assert.equal(createHash('sha256').update(font).digest('hex'), metadata.subsetSha256);
  assert.equal(metadata.subsetGlyphCodepoints + metadata.extendedGlyphCodepoints, 2852);
  const faces = [...fontFacesCss.matchAll(/unicode-range: ([^;]+);/g)].map((match) => {
    const points = new Set();
    for (const range of match[1].split(',')) {
      const [start, end = start] = range.replace('U+', '').split('-').map((hex) => Number.parseInt(hex, 16));
      for (let codepoint = start; codepoint <= end; codepoint += 1) points.add(codepoint);
    }
    return points;
  });
  assert.equal(faces.length, 2);
  assert.equal(faces[0].size, metadata.extendedGlyphCodepoints);
  assert.equal(faces[1].size, metadata.subsetGlyphCodepoints);
  assert.ok([...faces[1]].every((codepoint) => !faces[0].has(codepoint)));
  for (const codepoint of [0x41, 0xe9, 0x2014, 0x2192, 0x2605, 0x2713]) assert.ok(faces[1].has(codepoint));
  for (const codepoint of [0x100, 0x391, 0x410]) assert.ok(faces[0].has(codepoint));
  assert.ok(faces.every((face) => !face.has(0x1f680)), 'Unsupported emoji must not request either font.');
  assert.match(buildAssetVerifier, /uiFontStats\.size > 100_000/);
});

test('visual comparisons wait for the production brand font without replacing it', () => {
  assert.doesNotMatch(screenshotCss, /@font-face|Dominion E2E Inter/);
  assert.match(appTestHarness, /data-dominion-e2e-screenshot-style/);
  assert.match(
    appTestHarness,
    /document\.fonts\.load\('400 16px "Inter"'\)/,
  );
  assert.doesNotMatch(appTestHarness, /Dominion E2E Inter/);
  assert.doesNotMatch(appTestHarness, /stylePath:\s*app\.screenshotStyle/);
});

test('share composer metrics use the authoritative display font token', () => {
  assert.match(
    shareComposerCss,
    /\.share-preview-metric \{[\s\S]*?font-family: var\(--font-display\);/,
  );
  assert.doesNotMatch(shareComposerCss, /--display-font/);
});

test('full-page screenshots neutralize scroll-responsive topbar visuals', () => {
  assert.match(
    screenshotCss,
    /\.topbar\.topbar-scrolled::before \{[\s\S]*?box-shadow: none !important/,
  );
  assert.match(
    screenshotCss,
    /\.topbar\.topbar-collapsed::before \{[\s\S]*?background:[\s\S]*?transform: none !important/,
  );
  assert.match(
    screenshotCss,
    /\.topbar\.topbar-collapsed > \* \{[\s\S]*?transform: none !important/,
  );
  assert.match(
    screenshotCss,
    /\.topbar\.topbar-collapsed \.global-menu-button span:nth-child\(1\) \{[\s\S]*?width: 20px !important/,
  );
});
