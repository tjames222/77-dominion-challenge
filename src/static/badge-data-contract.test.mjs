import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as data from './badge-data-contract.mjs';
import * as presentation from './badges-rewards.mjs';
import * as evaluation from './badge-evaluation.mjs';
import { BADGE_DISPLAY_ORDER } from './badge-display-order.generated.mjs';
import { generateBadgeDisplayOrder } from '../../scripts/generate-badge-display-order.mjs';

test('badge presentation preserves compatible references to the pure data contract', () => {
  for (const name of ['badgeAwardIdentity', 'normalizeEarnedBadges', 'validBadgeTimestamp']) {
    assert.equal(presentation[name], data[name]);
  }
  const source = readFileSync(new URL('./badge-data-contract.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]), ['./badge-display-order.generated.mjs']);
  assert.doesNotMatch(source, /\b(?:document|window|localStorage|sessionStorage|fetch)\b/);
  for (const file of ['./api.js', './badge-preview-state.mjs']) {
    const consumer = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(consumer, /from '\.\/badge-data-contract\.mjs'/);
    assert.doesNotMatch(consumer, /from '\.\/badges-rewards\.mjs'/);
  }
});

test('canonical order projection is mechanically exact, immutable and contains no evaluation criteria', () => {
  const catalog = JSON.parse(readFileSync(new URL('./badge-catalog.v1.json', import.meta.url), 'utf8'));
  const generated = readFileSync(new URL('./badge-display-order.generated.mjs', import.meta.url), 'utf8');
  assert.equal(generated, generateBadgeDisplayOrder(catalog));
  assert.deepEqual(BADGE_DISPLAY_ORDER, catalog.badges.map(({ key, displayOrder }) => [key, displayOrder]));
  assert.equal(Object.isFrozen(BADGE_DISPLAY_ORDER), true);
  assert.ok(BADGE_DISPLAY_ORDER.every((entry) => Object.isFrozen(entry) && entry.length === 2));
  assert.doesNotMatch(generated, /\b(?:import|fetch|window|localStorage|threshold|predicate)\b/);
  for (const field of ['key', 'displayOrder']) {
    const changed = structuredClone(catalog); changed.badges[0][field] = field === 'key' ? 'different' : -42;
    assert.notEqual(generated, generateBadgeDisplayOrder(changed));
  }
  // Projection preserves duplicates and order rather than silently choosing a
  // last value or giving prototype-looking keys special object semantics.
  const unusual = { badges: [{ key: '__proto__', displayOrder: 3 }, { key: '__proto__', displayOrder: 1 }] };
  assert.match(generateBadgeDisplayOrder(unusual), /\[\["__proto__",3\],\["__proto__",1\]\]/);
});

test('ordering preserves canonical first match, strict keys, unknown defaults and both existing ties', () => {
  assert.equal(evaluation.badgeCatalogOrder, data.badgeCatalogOrder);
  assert.equal(evaluation.badgeCelebrationReason, data.badgeCelebrationReason);
  const oldOrder = (left, right) => {
    const order = (badge) => evaluation.BADGE_CATALOG.find((rule) => rule.key === badge.key)?.displayOrder ?? 10000;
    return order(left) - order(right) || String(left.earnedAt || '').localeCompare(String(right.earnedAt || '')) || String(left.key).localeCompare(String(right.key));
  };
  const records = [...evaluation.BADGE_CATALOG.map((rule) => ({ key: rule.key, displayOrder: -999 })),
    ...['unknown', '__proto__', 'constructor', '', undefined, null, 5, new String('faithful_start')].map((key) => ({ key })),
    { key: 'faithful_start', earnedAt: '2026-01-01', displayOrder: 99999 },
    { key: 'faithful_start', earnedAt: '2025-01-01' }, { key: 'faithful_start', earnedAt: 0 }];
  for (const left of records) for (const right of records) assert.equal(data.badgeCatalogOrder(left, right), oldOrder(left, right));
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
