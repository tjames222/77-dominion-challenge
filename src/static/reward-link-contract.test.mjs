import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rewardKeyFromLocation } from './reward-link-contract.mjs';
import { rewardKeyFromLocation as compatibilityParser, rewardCelebrationHref } from './reward-celebrations.mjs';

// The pre-extraction implementation is the behavioral oracle, including URL's
// first-parameter and coercion behavior. This change is not a new URL policy.
function originalParser(location) {
  const safeKey = (value) => /^[a-z0-9][a-z0-9_.:-]*$/.test(String(value || '')) ? String(value) : '';
  try { return safeKey(new URL(location.href).searchParams.get('reward')); } catch { return ''; }
}

test('the celebration module retains the exact parser export', () => {
  assert.equal(compatibilityParser, rewardKeyFromLocation);
});

test('deep links preserve first-parameter selection, decoding and exact key validation', () => {
  const cases = [
    ['', ''], ['?reward', ''], ['?reward=x', 'x'],
    ['?reward=dominion%5Fnight%5Ftheme#rewards', 'dominion_night_theme'],
    ['?reward=a.b:c-d_e', 'a.b:c-d_e'], ['?reward=0', '0'],
    ['?reward=x&reward=y', 'x'], ['?reward=&reward=x', ''],
    ['?reward=%3Cscript%3E&reward=x', ''], ['?reward=x&reward=%3Cscript%3E', 'x'],
    ['?reward=%252F', ''], ['?reward=a%2Fb', ''], ['?reward=a+b', ''],
    ['?reward=a%20b', ''], ['?reward=%00', ''], ['?reward=%ZZ', ''],
    ['?reward=UPPER', ''], ['?reward=caf%C3%A9', ''], ['?reward=.leading', ''],
    ['?reward=__proto__', ''], ['?reward=constructor', 'constructor'],
    ['?reward=prototype', 'prototype'], ['?reward=toString', ''],
    ['?reward=does_not_exist', 'does_not_exist'], ['#reward=x', ''],
  ];
  for (const [suffix, expected] of cases) {
    const location = { href: `https://app.test/badges-rewards.html${suffix}` };
    assert.equal(rewardKeyFromLocation(location), expected, suffix);
    assert.equal(rewardKeyFromLocation(location), originalParser(location), suffix);
  }
});

test('malformed, missing, inherited and coercible location inputs retain old behavior', () => {
  const inputs = [
    undefined, null, '', 42, {}, Object.create(null), { href: undefined },
    { href: '/badges-rewards.html?reward=x' }, { href: 'not a URL' },
    { href: new URL('https://app.test/?reward=x') },
    Object.create({ href: 'https://app.test/?reward=constructor' }),
    { href: { toString: () => 'https://app.test/?reward=prototype' } },
    { href: Symbol('invalid') },
    { get href() { throw new Error('blocked'); } },
    { href: { toString() { throw new Error('blocked'); } } },
    { href: 'http://[invalid/?reward=x' }, { href: 'data:text/plain,body?reward=x' },
  ];
  for (const input of inputs) assert.equal(rewardKeyFromLocation(input), originalParser(input));
  let reads = 0;
  assert.equal(rewardKeyFromLocation({ get href() { reads += 1; return 'https://app.test/?reward=x'; } }), 'x');
  assert.equal(reads, 1);
});

test('parser and outbound link key language remain identical without a recovery import', () => {
  for (const key of ['x', '0', 'a.b:c-d_e', 'constructor', 'prototype', 'unknown_reward', '', '__proto__', 'A', 'a/b', 'a b', 'é', '<script>']) {
    const href = rewardCelebrationHref(key);
    const expected = href.includes('?reward=') ? key : '';
    assert.equal(rewardKeyFromLocation({ href: `https://app.test/${href}` }), expected, key);
  }
  const parserSource = readFileSync(new URL('./reward-link-contract.mjs', import.meta.url), 'utf8');
  const recoverySource = readFileSync(new URL('./reward-celebrations.mjs', import.meta.url), 'utf8');
  assert.equal(parserSource.match(/^const safeKey = .+;$/m)?.[0], recoverySource.match(/^const safeKey = .+;$/m)?.[0]);
  assert.doesNotMatch(parserSource, /\bimport\b|\b(?:window|document|localStorage|sessionStorage|supabase)\b/);
});
