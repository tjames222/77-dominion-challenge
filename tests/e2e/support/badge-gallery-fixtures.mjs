export const GALLERY_BADGES = [
  { key: 'faithful_start', name: 'Faithful Start', description: 'Your first honest check-in.', tier: 'bronze', icon: 'shield', earnedAt: '2026-02-01T20:00:00Z', requirement: 'Post your first check-in.', earningEvidence: { schemaVersion: 1, kind: 'check_in', qualifyingValue: 1 } },
  { key: 'perfect_week', name: 'Seven for Seven', description: 'Seven complete days together.', tier: 'silver', icon: 'star', earnedAt: '2026-02-10T20:00:00Z', requirement: 'Complete all seven Daily Standards for seven consecutive days.', earningEvidence: { schemaVersion: 1, kind: 'perfect_streak', qualifyingValue: 7 } },
  { key: 'legacy_gold', name: 'Legacy Gold', description: 'An earned legacy milestone.', tier: 'gold', icon: 'crown', earnedAt: '2026-02-12T20:00:00Z', requirement: 'Complete the original milestone.', legacy: true, retired: true },
];

export async function seedBadgeGallery(page, app, { badges = GALLERY_BADGES, theme = 'dark' } = {}) {
  await app.seed('rewardsUnlocked', theme);
  await page.addInitScript((records) => {
    // These are explicit evidence-bearing presentation fixtures, not a legacy
    // list that the importer must conservatively label as unverifiable.
    const awards = records.map(record => ({ ...record, legacy: record.legacy === true,
      scopeKey: record.scopeKey || 'lifetime',
      awardId: record.awardId || `fixture:${record.key}:${record.scopeKey || 'lifetime'}`,
      celebrationSeenAt: record.earnedAt }));
    localStorage.setItem('dominion:badges', JSON.stringify(awards));
    localStorage.setItem('dominion:badgeState:v1', JSON.stringify({
      schemaVersion: 1, awards, checkIns: [], visits: [], completionEvents: [],
    }));
  }, badges);
}

export async function replaceBadgeGalleryAwards(page, records) {
  await page.evaluate(records => {
    const owner = localStorage.getItem('dominion:mockUserId');
    const key = 'dominion:challengeAggregateV2:' + owner;
    const aggregate = JSON.parse(localStorage.getItem(key));
    if (aggregate?.actorId !== owner || aggregate.schemaVersion !== 2) throw new Error('The gallery fixture has no current aggregate.');
    const awards = records.map(record => ({ ...record, legacy: record.legacy === true,
      scopeKey: record.scopeKey || 'lifetime',
      awardId: record.awardId || `fixture:${record.key}:${record.scopeKey || 'lifetime'}`,
      celebrationSeenAt: record.earnedAt }));
    aggregate.values['dominion:badgeState:v1'].awards = awards;
    aggregate.values['dominion:badges'] = awards;
    aggregate.generation += 1;
    aggregate.updatedAt = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify(aggregate));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, records);
}
