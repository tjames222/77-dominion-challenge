import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeCollectionModel } from './badge-collection.mjs';

const rule = (extra = {}) => ({ key: 'check_ins_7', name: '7 Check-Ins', series: 'progress', tier: 'silver', icon: 'check',
  requirement: 'Post 7 check-ins in your challenge.', displayOrder: 100, status: 'active', visibility: 'public',
  earnedInCurrentScope: false, showProgress: true, progress: { metric: 'instance_check_in_count', current: 5, target: 7 }, ...extra });
const collection = (items) => ({ catalogVersion: 1, items });

test('collection uses authoritative current-scope progress without inferring an award', () => {
  const model = badgeCollectionModel({ collection: collection([rule()]), awards: [{ key: 'check_ins_7', scopeKey: 'old-instance', earnedAt: '2025-01-01T12:00:00Z' }] });
  assert.equal(model.earnedCount, 1);
  assert.equal(model.groups[0].earned.length, 1);
  assert.equal(model.groups[0].locked[0].progress.label, '5 of 7 check-ins');
  assert.equal(model.groups[0].locked[0].status, 'Not yet earned');
  const atTarget = badgeCollectionModel({ collection: collection([rule({ progress: { metric: 'instance_check_in_count', current: 7, target: 7 } })]) });
  assert.equal(atTarget.earnedCount, 0);
  assert.equal(atTarget.groups[0].locked[0].status, 'Not yet earned');
});

test('hidden, retired and current-scope earned definitions are never shown as locked', () => {
  const model = badgeCollectionModel({ collection: collection([rule({ visibility: 'hidden' }), rule({ key: 'old', status: 'retired' }), rule({ key: 'owned', earnedInCurrentScope: true })]),
    awards: [{ key: 'old', legacy: true, retired: true }, { key: 'secret-earned', category: 'community' }] });
  assert.equal(model.earnedCount, 2);
  assert.equal(model.groups.flatMap((group) => group.locked).length, 0);
  assert.equal(model.groups.find((group) => group.key === 'legacy').earned[0].key, 'old');
});

test('unsupported catalog versions fail closed and invalid progress is not fabricated as zero', () => {
  for (const value of [undefined, { catalogVersion: 2, items: [] }, { catalogVersion: 1 }]) {
    assert.throws(() => badgeCollectionModel({ collection: value }), /temporarily unavailable/);
  }
  for (const progress of [null, {}, { metric: 'unknown', current: 2, target: 7 }, { metric: 'app_streak', current: '2', target: 7 }, { metric: 'app_streak', current: -1, target: 7 }]) {
    const model = badgeCollectionModel({ collection: collection([rule({ progress })]) });
    assert.equal(model.groups[0].locked[0].progress, null);
  }
});

test('blocked completion requirements cannot render progress or appear earnable', () => {
  const model = badgeCollectionModel({ collection: collection([rule({ status: 'blocked', series: 'completion' })]) });
  assert.equal(model.groups[0].label, 'Challenge completion');
  assert.equal(model.groups[0].locked[0].status, 'Not available yet');
  assert.equal(model.groups[0].locked[0].progress, null);
});

test('deterministic grouping preserves a complete scoped collection and excludes unsafe extra data', () => {
  const payload = { collection: collection([rule(), rule({ key: 'start', series: 'foundation', displayOrder: 1 }), rule({ key: 'finish', displayOrder: 200 })]),
    awards: [{ key: 'check_ins_7', awardId: 'one', scopeKey: 'first' }, { key: 'check_ins_7', awardId: 'two', scopeKey: 'second' }] };
  const model = badgeCollectionModel(payload);
  assert.equal(model.earnedCount, 2);
  assert.deepEqual(model.groups.map((group) => group.key), ['foundation', 'progress']);
  assert.deepEqual(model.groups[1].locked.map((badge) => badge.key), ['check_ins_7', 'finish']);
  assert.deepEqual(model, badgeCollectionModel({ collection: collection([...payload.collection.items].reverse()), awards: [...payload.awards].reverse() }));
});
