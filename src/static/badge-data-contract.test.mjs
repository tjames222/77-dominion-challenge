import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as data from './badge-data-contract.mjs';
import * as presentation from './badges-rewards.mjs';

test('badge presentation preserves compatible references to the pure data contract', () => {
  for (const name of ['badgeAwardIdentity', 'normalizeEarnedBadges', 'validBadgeTimestamp']) {
    assert.equal(presentation[name], data[name]);
  }
  const source = readFileSync(new URL('./badge-data-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b|\b(?:document|window|localStorage|sessionStorage|fetch)\b/);
  for (const file of ['./api.js', './badge-preview-state.mjs']) {
    const consumer = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(consumer, /from '\.\/badge-data-contract\.mjs'/);
    assert.doesNotMatch(consumer, /from '\.\/badges-rewards\.mjs'/);
  }
});

test('pure badge normalization retains scoped identities, ordering and input data', () => {
  const records = Object.freeze([
    Object.freeze({ key: 'same', scopeKey: 'original77:2026-01-01', name: 'Earlier', earnedAt: '2026-02-01T00:00:00Z' }),
    Object.freeze({ key: 'same', scopeKey: 'original77:2026-03-01', name: 'Different scope', earnedAt: '2026-04-01T00:00:00Z' }),
    Object.freeze({ key: 'same', scopeKey: 'original77:2026-01-01', name: 'Latest', earnedAt: '2026-02-02T00:00:00Z' }),
    Object.freeze({ key: 'same', awardId: 'distinct-award', name: 'Award identity', earnedAt: '2026-02-03T00:00:00Z' }),
  ]);
  assert.deepEqual(data.normalizeEarnedBadges(records).map(badge => badge.name), ['Different scope', 'Award identity', 'Latest']);
  assert.equal(records[0].name, 'Earlier');
  assert.equal(data.validBadgeTimestamp('2026-02-30T12:00:00Z'), null);
  assert.equal(data.validBadgeTimestamp('2026-02-28T24:00:00Z'), null);
  assert.equal(data.validBadgeTimestamp('2026-02-28T12:00:00'), null);
});

test('normalization keeps fresh result records and the existing nested-data references', () => {
  const evidence = { schemaVersion: 1, kind: 'check_in', qualifyingValue: 1 };
  const metadata = { earningEvidence: evidence };
  const input = { key: 'start', name: 'Original', metadata };
  const first = data.normalizeEarnedBadges([input]);
  const second = data.normalizeEarnedBadges([input]);
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.equal(first[0].metadata, metadata);
  assert.equal(first[0].earningEvidence, evidence);
  input.name = 'Updated';
  input.scopeKey = 'original77:2026-03-01';
  const [updated] = data.normalizeEarnedBadges([input]);
  assert.equal(updated.name, 'Updated');
  assert.equal(updated.scopeKey, input.scopeKey);
  assert.equal(first[0].name, 'Original');
  assert.equal(first[0].scopeKey, 'lifetime');
});

test('badge display defaults and invalid-tier fallback remain unchanged', () => {
  const [badge] = data.normalizeEarnedBadges([{ key: 'start', tier: 'unsupported' }]);
  assert.deepEqual(badge, {
    key: 'start', awardId: '', scopeKey: 'lifetime', name: 'Badge',
    description: 'Earned through challenge progress.', category: 'challenge',
    tier: 'bronze', icon: 'shield', earnedAt: null, entryDate: null, metadata: {},
    requirement: '', earningEvidence: null, legacy: false, retired: false,
    displayOrder: 10000,
  });
});
