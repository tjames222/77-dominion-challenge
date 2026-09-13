import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { badgeEvidenceSummary, badgeGalleryModel } from './badge-gallery.mjs';
import { buildBadgesRewardsPageModel, normalizeEarnedBadges, validBadgeTimestamp } from './badges-rewards.mjs';

describe('earned badge gallery contract', () => {
  it('handles empty, invalid and missing records without mutating the source', () => {
    assert.deepEqual(badgeGalleryModel(null), []);
    const records = [{ key: 'one', earnedAt: 'invalid', entryDate: '2026-07-12' }, null, {}];
    const original = structuredClone(records);
    const [badge] = badgeGalleryModel(records);
    assert.equal(badge.earnedLabel, '');
    assert.doesNotMatch(badge.accessibleName, /earned /);
    assert.deepEqual(records, original);
  });

  it('uses true timestamp order, deduplicates and breaks ties by stable key', () => {
    const records = [
      { key: 'b', earnedAt: '2026-07-12T10:00:00Z' },
      { key: 'invalid', earnedAt: 'zzz' },
      { key: 'a', earnedAt: '2026-07-12T10:00:00Z' },
      { key: 'offset', earnedAt: '2026-07-12T08:00:00-07:00' },
      { key: 'a', earnedAt: '2026-07-01T00:00:00Z' },
      { key: 'missing' },
    ];
    assert.deepEqual(badgeGalleryModel(records).map((badge) => badge.key), ['offset', 'a', 'b', 'invalid', 'missing']);
    assert.deepEqual(badgeGalleryModel(records), badgeGalleryModel([...records].reverse()));
  });

  it('keeps complete accessible names and authoritative requirement/evidence', () => {
    const [badge] = badgeGalleryModel([{
      key: 'start', name: 'Faithful Start', tier: 'bronze', icon: 'shield',
      earnedAt: '2026-07-12T12:00:00Z', requirement: 'Post your first check-in.',
      earningEvidence: { schemaVersion: 1, kind: 'check_in', qualifyingValue: 1, userId: 'never-render' },
    }]);
    assert.match(badge.accessibleName, /^View Faithful Start badge details — Bronze badge, earned July 12, 2026$/);
    assert.equal(badge.requirement, 'Post your first check-in.');
    assert.equal(badge.evidenceSummary, 'Posting your first check-in.');
    assert.doesNotMatch(JSON.stringify(badge), /never-render/);
  });

  it('never guesses earning evidence from names, raw metadata or unsupported versions', () => {
    for (const evidence of [null, {}, { schemaVersion: 2, kind: 'check_in', qualifyingValue: 1 },
      { schemaVersion: 1, kind: 'unknown', summary: 'private detail' },
      { schemaVersion: 1, kind: 'check_in', qualifyingValue: -1 }]) {
      assert.equal(badgeEvidenceSummary(evidence), '');
    }
    const [badge] = badgeGalleryModel([{ key: 'legacy', name: '77 Perfect Days', description: 'Recorded legacy requirement.', metadata: { raw: 'private' } }]);
    assert.equal(badge.evidenceSummary, '');
    assert.equal(badge.requirement, 'Recorded legacy requirement.');
    const page = buildBadgesRewardsPageModel({ badges: [{ key: 'unknown' }] });
    assert.match(badgeGalleryModel(page.badges)[0].requirement, /original requirement is unavailable/);
    assert.equal(normalizeEarnedBadges(normalizeEarnedBadges([{ key: 'unknown' }]))[0].requirement, '');
  });

  it('rejects impossible calendar dates, times and missing zones without normalization', () => {
    for (const timestamp of ['2026-02-31T12:00:00Z', '2026-02-29T12:00:00Z', '2026-12-01T24:00:00Z', '2026-12-01T12:00:00', '2026-12-01T12:00:00+25:00']) {
      assert.equal(validBadgeTimestamp(timestamp), null);
      assert.equal(badgeGalleryModel([{ key: 'bad', earnedAt: timestamp }])[0].earnedLabel, '');
    }
    assert.notEqual(validBadgeTimestamp('2024-02-29T12:00:00Z'), null);
  });

  it('exposes only safe typed workout, streak and action evidence', () => {
    assert.equal(badgeEvidenceSummary({ schemaVersion: 1, kind: 'workout', workout: 'one', difficulty: 'hard' }), 'Completing Workout One at Hard difficulty.');
    assert.equal(badgeEvidenceSummary({ schemaVersion: 1, kind: 'workout', workout: 'someone-else', difficulty: 'hard' }), '');
    assert.equal(badgeEvidenceSummary({ schemaVersion: 1, kind: 'workout', workout: 'constructor', difficulty: 'toString' }), '');
    assert.equal(badgeEvidenceSummary({ schemaVersion: 1, kind: 'perfect_streak', qualifyingValue: 7 }), 'Reaching a 7-day perfect streak.');
    assert.equal(badgeEvidenceSummary({ schemaVersion: 1, kind: 'daily_standards', completedCount: 8 }), '');
    assert.match(badgeEvidenceSummary({ schemaVersion: 1, kind: 'daily_standards', completedCount: 3 }), /3 of the seven/);
  });

  it('supports all tiers, safe icons, retired records and large collections', () => {
    const records = Array.from({ length: 250 }, (_, index) => ({ key: `badge_${index}`, tier: ['bronze', 'silver', 'gold'][index % 3], icon: 'share' }));
    assert.equal(badgeGalleryModel(records).length, 250);
    const [retired] = badgeGalleryModel([{ key: 'retired', tier: 'gold', retired: true, icon: '<script>', legacy: true,
      earningEvidence: { schemaVersion: 1, kind: 'check_in', qualifyingValue: 1 } }]);
    assert.equal(retired.retired, true);
    assert.equal(retired.iconClass, 'icon-shield');
    assert.equal(retired.evidenceSummary, '');
  });

  it('uses identical material tokens in gallery and celebration without changing their values', () => {
    const gallery = readFileSync(new URL('../assets/badges-rewards.css', import.meta.url), 'utf8');
    const product = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');
    for (const tier of ['bronze', 'silver', 'gold']) {
      for (const part of ['light', 'mid', 'dark', 'ink']) {
        assert.ok(gallery.includes(`var(--badge-${tier}-${part})`));
        assert.ok(product.includes(`var(--badge-${tier}-${part})`));
      }
    }
  });
});
