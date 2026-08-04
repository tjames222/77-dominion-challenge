import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../assets/styles.css', import.meta.url), 'utf8');
const product = await readFile(new URL('../assets/product.css', import.meta.url), 'utf8');
const dominionNight = await readFile(new URL('../assets/dominion-night.css', import.meta.url), 'utf8');

test('disabled primary controls use readable semantic tokens instead of whole-control opacity', () => {
  for (const token of [
    '--button-disabled-background',
    '--button-disabled-text',
    '--button-disabled-border',
  ]) {
    assert.match(styles, new RegExp(`${token}:`));
  }

  const disabledRule = styles.match(/\.primary:disabled\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(disabledRule, /color:\s*var\(--button-disabled-text\)/);
  assert.match(disabledRule, /background:\s*var\(--button-disabled-background\)/);
  assert.match(disabledRule, /box-shadow:\s*inset 0 0 0 1px var\(--button-disabled-border\)/);
  assert.match(disabledRule, /opacity:\s*1/);
  assert.doesNotMatch(disabledRule, /opacity:\s*\.45/);
});

test('secondary controls use the same readable disabled tokens', () => {
  const disabledRule = product.match(/\.danger-button:disabled,[\s\S]*?\.secondary-button:disabled\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(disabledRule, /border-color:\s*var\(--button-disabled-border\)/);
  assert.match(disabledRule, /background:\s*var\(--button-disabled-background\)/);
  assert.match(disabledRule, /color:\s*var\(--button-disabled-text\)/);
  assert.match(disabledRule, /opacity:\s*1/);
});

test('Dominion Night preserves semantic disabled colors after its generic control rule', () => {
  const genericIndex = dominionNight.indexOf(':where(button, input, select, textarea):disabled');
  const primaryIndex = dominionNight.indexOf('.primary:disabled:not(.is-complete)');
  const dangerIndex = dominionNight.indexOf('.danger-button:disabled');
  const secondaryIndex = dominionNight.indexOf('.secondary:disabled');

  assert.ok(genericIndex >= 0);
  assert.ok(primaryIndex > genericIndex);
  assert.ok(dangerIndex > genericIndex);
  assert.ok(secondaryIndex > genericIndex);
  assert.match(dominionNight.slice(primaryIndex, secondaryIndex), /color:\s*var\(--button-disabled-text\)/);
  assert.match(dominionNight.slice(dangerIndex), /color:\s*var\(--button-disabled-text\)/);
});
