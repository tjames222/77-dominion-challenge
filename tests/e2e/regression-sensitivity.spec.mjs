import { test, expect } from './support/app-test.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
  assertVisualBuffersEqual,
} from './support/quality-gates.mjs';

test('accessibility gate rejects a controlled inaccessible fixture', async ({ page }) => {
  await page.setContent([
    '<main>',
    '<button id="unnamed"></button>',
    '<input id="unlabelled-input">',
    '</main>',
  ].join(''));
  const results = await analyzeAccessibility(page);

  expect(() => assertNoBlockingAxeViolations(results))
    .toThrow(/Blocking accessibility violations/);
});

test('visual gate detects a controlled rendered change without failing CI', async ({ page }) => {
  await page.setContent([
    '<style>',
    'body{margin:0;background:#101712}',
    '#sentinel{width:240px;height:120px;background:#c8aa64;border:8px solid #f5f1e8}',
    '#sentinel.changed{background:#7b2941;transform:translateX(12px)}',
    '</style>',
    '<div id="sentinel" aria-label="Visual regression sentinel"></div>',
  ].join(''));

  const sentinel = page.locator('#sentinel');
  await expect(sentinel).toHaveScreenshot('visual-gate-sentinel.png');
  const expected = await sentinel.screenshot();
  expect(() => assertVisualBuffersEqual(expected, expected)).not.toThrow();

  await sentinel.evaluate((element) => element.classList.add('changed'));
  const changed = await sentinel.screenshot();
  expect(() => assertVisualBuffersEqual(expected, changed))
    .toThrow(/Visual output changed/);
});
