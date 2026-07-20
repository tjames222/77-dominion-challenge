import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const workflow = readFileSync(
  new URL('../../.github/workflows/browser-quality.yml', import.meta.url),
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
