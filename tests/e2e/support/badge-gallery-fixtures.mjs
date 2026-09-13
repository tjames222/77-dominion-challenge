export const GALLERY_BADGES = [
  { key: 'faithful_start', name: 'Faithful Start', description: 'Your first honest check-in.', tier: 'bronze', icon: 'shield', earnedAt: '2026-02-01T20:00:00Z', requirement: 'Post your first check-in.', earningEvidence: { schemaVersion: 1, kind: 'check_in', qualifyingValue: 1 } },
  { key: 'perfect_week', name: 'Seven for Seven', description: 'Seven complete days together.', tier: 'silver', icon: 'star', earnedAt: '2026-02-10T20:00:00Z', requirement: 'Complete all seven Daily Standards for seven consecutive days.', earningEvidence: { schemaVersion: 1, kind: 'perfect_streak', qualifyingValue: 7 } },
  { key: 'legacy_gold', name: 'Legacy Gold', description: 'An earned legacy milestone.', tier: 'gold', icon: 'crown', earnedAt: '2026-02-12T20:00:00Z', requirement: 'Complete the original milestone.', legacy: true, retired: true },
];

export async function seedBadgeGallery(page, app, { badges = GALLERY_BADGES, theme = 'dark' } = {}) {
  await app.seed('rewardsUnlocked', theme);
  await page.addInitScript((records) => localStorage.setItem('dominion:badges', JSON.stringify(records)), badges);
}
