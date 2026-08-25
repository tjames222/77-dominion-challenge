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
  assert.match(
    stylesCss,
    /@font-face \{[\s\S]*?font-family: "Inter";[\s\S]*?fonts\/InterVariable\.woff2[\s\S]*?font-weight: 100 900;[\s\S]*?font-display: swap;/,
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
    'node scripts/validate-frontend-env.mjs && vite build && node scripts/verify-build-assets.mjs',
  );
  assert.match(buildAssetVerifier, /fonts\/Inter-LICENSE\.txt/);
  assert.match(buildAssetVerifier, /InterVariable-/);
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
