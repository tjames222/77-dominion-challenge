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
const screenshotCss = readFileSync(
  new URL('../../tests/e2e/support/screenshot.css', import.meta.url),
  'utf8',
);
const screenshotFont = readFileSync(
  new URL('../../tests/e2e/support/InterVariable.woff2', import.meta.url),
);
const screenshotFontLicense = readFileSync(
  new URL('../../tests/e2e/support/Inter-LICENSE.txt', import.meta.url),
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

test('visual comparisons use the pinned open-source Inter font', () => {
  assert.match(
    screenshotCss,
    /font-family: "Dominion E2E Inter";[\s\S]*?InterVariable\.woff2/,
  );
  assert.match(screenshotCss, /html \{[\s\S]*?Dominion E2E Inter[\s\S]*?!important/);
  assert.equal(
    createHash('sha256').update(screenshotFont).digest('hex'),
    '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3',
  );
  assert.match(screenshotFontLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
});
