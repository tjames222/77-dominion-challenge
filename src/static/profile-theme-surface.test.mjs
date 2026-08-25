import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const productCss = await readFile(new URL('../assets/product.css', import.meta.url), 'utf8');

test('owned theme choices restore the full card radius when progress is hidden', () => {
  const ownedProgressRule = productCss.match(/\.appearance-reward-choice\.is-owned \.appearance-reward-progress\s*\{[\s\S]*?\}/)?.[0] || '';
  const ownedOptionRule = productCss.match(/\.appearance-reward-choice\.is-owned \.appearance-option\s*\{[\s\S]*?\}/)?.[0] || '';

  assert.match(ownedProgressRule, /display:\s*none/);
  assert.match(ownedOptionRule, /border-radius:\s*16px/);
});
