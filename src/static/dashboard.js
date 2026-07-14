import { initReveal } from './reveal';
import {
  getBillingState,
  getDashboard,
  getGameSummary,
  hasSupabaseAuth,
  isLocalDemoMode,
  postCheckIn,
  recordAppVisit,
  redirectToLogin,
  saveChallengeEntry,
  updateProfile,
} from './api';

const TOTAL_DAYS = 77;
const YOUVERSION_VERSE_URL = import.meta.env.VITE_YOUVERSION_VERSE_URL || '';
const YOUVERSION_APP_URL = import.meta.env.VITE_YOUVERSION_APP_URL || 'https://www.bible.com/';
const YOUVERSION_PRAYER_URL = import.meta.env.VITE_YOUVERSION_PRAYER_URL || 'https://www.bible.com/prayer';
const APPLE_FITNESS_URL = import.meta.env.VITE_APPLE_FITNESS_URL || 'https://fitness.apple.com/';
const WALK_ALARM_URL = import.meta.env.VITE_WALK_ALARM_URL || '';
const scorecardGroups = [
  {
    key: 'mind',
    label: 'Mind',
    items: [
      ['bible', 'Bible Reading', '5–8 chapters'],
    ],
  },
  {
    key: 'spirit',
    label: 'Spirit',
    items: [
      ['morningPrayer', 'Morning Prayer', 'Start surrendered before the day starts speaking for you.'],
      ['worshipOnly', 'Worship Music Only', 'Instrumental, podcasts, and audiobooks permitted'],
      ['eveningPrayer', 'Evening Prayer', 'Close the loop with gratitude, confession, and trust.'],
    ],
  },
  {
    key: 'body',
    label: 'Body',
    items: [
      ['workoutOne', 'Workout #1', 'No required length'],
      ['walk', 'Intentional Walk', 'During the day'],
      ['workoutTwo', 'Workout #2', 'No required length'],
    ],
  },
];
const standards = scorecardGroups.flatMap(group => group.items);
const starterFeed = [
  { name: 'Josh', day: 12, status: 'complete', timestamp: 'Today' },
  { name: 'Sarah', day: 12, status: 'complete', timestamp: 'Today' },
  { name: 'Matt', day: 11, status: 'scheduled', timestamp: 'Yesterday' },
  { name: 'Tim', day: 12, status: 'complete', timestamp: 'Today' },
];
const fallbackVerse = {
  text: 'His mercies never come to an end; they are new every morning.',
  reference: 'Lamentations 3:22-23',
};
const countdownCallouts = [
  'Do the next right action before the day gets louder.',
  'Discipline gets lighter once you start. Pick one standard and move.',
  'You do not need the perfect window. You need the next faithful step.',
  'Small obedience now beats a rushed apology tonight.',
  'Your check-in is built one action at a time. Stack the next win.',
  'The clock is not here to shame you. It is here to wake you up.',
  'Protect the standard while the day is still in your hands.',
  'Start with the action you are most likely to avoid. That is the hinge.',
  'A complete day is still available. Take the next clean step.',
  'Make the next 20 minutes count. Momentum will meet you there.',
  'Do not negotiate with drift. Choose the standard and begin.',
  'You are training your future self right now.',
];
const worshipPlaylists = [
  { label: 'Morning worship focus', url: 'https://open.spotify.com/search/morning%20worship%20playlist' },
  { label: 'Acoustic worship reset', url: 'https://open.spotify.com/search/acoustic%20worship%20playlist' },
  { label: 'Praise and worship lift', url: 'https://open.spotify.com/search/praise%20and%20worship%20playlist' },
  { label: 'Instrumental worship flow', url: 'https://open.spotify.com/search/instrumental%20worship%20playlist' },
  { label: 'Gospel worship strength', url: 'https://open.spotify.com/search/gospel%20worship%20playlist' },
  { label: 'Evening worship surrender', url: 'https://open.spotify.com/search/evening%20worship%20playlist' },
  { label: 'Christian worship today', url: 'https://open.spotify.com/search/christian%20worship%20playlist' },
];
const workoutPlans = {
  easy: [
    '3 rounds: 10 pushups, 20 squats, 20-second plank, 10 glute bridges.',
    '3 rounds: 8 incline pushups, 12 reverse lunges per leg, 20 mountain climbers, 30-second wall sit.',
    '3 rounds: 10 chair dips, 15 air squats, 10 dead bugs per side, 45-second easy walk.',
    '3 rounds: 12 knee pushups, 20 step-ups, 20 jumping jacks, 20-second hollow hold.',
  ],
  medium: [
    '4 rounds: 12 pushups, 20 squats, 12 alternating lunges per leg, 30-second plank.',
    '4 rounds: 15 pushups, 15 jump squats, 20 bicycle crunches, 40-second side plank each side.',
    '4 rounds: 10 burpees, 20 walking lunges, 15 pike pushups, 30-second squat hold.',
    '4 rounds: 12 dips, 20 air squats, 12 mountain climbers per side, 1-minute brisk walk.',
  ],
  hard: [
    '5 rounds: 15 pushups, 25 squats, 20 walking lunges, 45-second plank.',
    '5 rounds: 12 burpees, 20 jump squats, 15 decline pushups, 30 bicycle crunches.',
    '5 rounds: 20 alternating lunges per leg, 15 diamond pushups, 20 mountain climbers per side, 1-minute wall sit.',
    '5 rounds: 15 pushups, 20 squat jumps, 20 sit-ups, 400-meter fast walk or jog.',
  ],
  extreme: [
    '6 rounds: 20 pushups, 30 squats, 20 burpees, 60-second plank.',
    '6 rounds: 15 hand-release pushups, 25 jump squats, 20 lunges per leg, 40 mountain climbers per side.',
    '6 rounds: 20 dips, 20 pistol-squat progressions per side, 15 burpees, 90-second plank.',
    '6 rounds: 25 pushups, 30 squats, 20 tuck jumps, 1-minute sprint or fast stair climb.',
  ],
};
const difficultyPointMap = { easy: 2, medium: 5, hard: 10, extreme: 15 };
const difficultyOptions = Object.keys(difficultyPointMap);
const defaultWorkoutDifficulty = { one: 'medium', two: 'medium' };
const POINTS_PER_LEVEL = 500;
const CONFETTI_DURATION_MS = 10800;
const REDUCED_CONFETTI_DURATION_MS = 2200;
const REWARD_TOAST_DURATION_MS = 5200;
const DAY_COMPLETE_TOAST_DURATION_MS = CONFETTI_DURATION_MS + 650;
const REWARD_TOAST_EXIT_MS = 320;
const BADGE_REVEAL_DURATION_MS = 5600;
const COMPLETION_HERO = {
  title: 'Congratulations, you did it!',
  lead: 'You reached the 77-day finish line. Hold the ground you gained while the next challenge is prepared.',
};
const demoBadgeDefinitions = {
  faithful_start: { key: 'faithful_start', name: 'Faithful Start', tier: 'bronze', icon: 'shield' },
  honest_partial: { key: 'honest_partial', name: 'Honest Standard', tier: 'bronze', icon: 'check' },
  first_sweat: { key: 'first_sweat', name: 'First Sweat', tier: 'bronze', icon: 'spark' },
  steady_grind: { key: 'steady_grind', name: 'Steady Grind', tier: 'bronze', icon: 'flame' },
  hard_path: { key: 'hard_path', name: 'Hard Path', tier: 'silver', icon: 'run' },
  extreme_fire: { key: 'extreme_fire', name: 'Extreme Fire', tier: 'gold', icon: 'flame' },
  iron_standard: { key: 'iron_standard', name: 'Iron Standard', tier: 'silver', icon: 'dumbbell' },
  seven_day_start: { key: 'seven_day_start', name: 'Seven-Day Start', tier: 'bronze', icon: 'calendar' },
  two_week_guard: { key: 'two_week_guard', name: 'Two-Week Guard', tier: 'silver', icon: 'shield' },
  three_week_wall: { key: 'three_week_wall', name: 'Three-Week Wall', tier: 'silver', icon: 'target' },
  third_way: { key: 'third_way', name: 'One-Third Dominion', tier: 'gold', icon: 'flag' },
  deep_roots: { key: 'deep_roots', name: 'Deep Roots', tier: 'silver', icon: 'mountain' },
  halfway_fire: { key: 'halfway_fire', name: 'Halfway Fire', tier: 'gold', icon: 'spark' },
  fifty_faithful: { key: 'fifty_faithful', name: 'Fifty Faithful', tier: 'silver', icon: 'star' },
  sixty_strong: { key: 'sixty_strong', name: 'Sixty Strong', tier: 'gold', icon: 'dumbbell' },
  final_watch: { key: 'final_watch', name: 'Final Watch', tier: 'gold', icon: 'eye' },
  streak_flame: { key: 'streak_flame', name: 'Streak Flame', tier: 'silver', icon: 'flame' },
  seven_sealed: { key: 'seven_sealed', name: 'Seven Sealed', tier: 'gold', icon: 'repeat' },
  full_streak_14: { key: 'full_streak_14', name: '14-Day Full Streak', tier: 'silver', icon: 'shield' },
  full_streak_21: { key: 'full_streak_21', name: '21-Day Full Streak', tier: 'silver', icon: 'target' },
  full_streak_28: { key: 'full_streak_28', name: '28-Day Full Streak', tier: 'silver', icon: 'dumbbell' },
  full_streak_35: { key: 'full_streak_35', name: '35-Day Full Streak', tier: 'gold', icon: 'flame' },
  full_streak_42: { key: 'full_streak_42', name: '42-Day Full Streak', tier: 'gold', icon: 'eye' },
  full_streak_49: { key: 'full_streak_49', name: '49-Day Full Streak', tier: 'gold', icon: 'repeat' },
  full_streak_56: { key: 'full_streak_56', name: '56-Day Full Streak', tier: 'gold', icon: 'mountain' },
  full_streak_63: { key: 'full_streak_63', name: '63-Day Full Streak', tier: 'gold', icon: 'star' },
  full_streak_70: { key: 'full_streak_70', name: '70-Day Full Streak', tier: 'gold', icon: 'flag' },
  morning_watch: { key: 'morning_watch', name: 'Morning Watch', tier: 'bronze', icon: 'eye' },
  watchman_week: { key: 'watchman_week', name: 'Watchman Week', tier: 'silver', icon: 'eye' },
  day_77_finisher: { key: 'day_77_finisher', name: '77-Day Finisher', tier: 'gold', icon: 'crown' },
};
const milestoneBadges = {
  7: 'seven_day_start',
  14: 'two_week_guard',
  21: 'three_week_wall',
  26: 'third_way',
  33: 'deep_roots',
  39: 'halfway_fire',
  50: 'fifty_faithful',
  60: 'sixty_strong',
  70: 'final_watch',
  77: 'day_77_finisher',
};
const fullStreakBadges = {
  7: 'seven_sealed',
  14: 'full_streak_14',
  21: 'full_streak_21',
  28: 'full_streak_28',
  35: 'full_streak_35',
  42: 'full_streak_42',
  49: 'full_streak_49',
  56: 'full_streak_56',
  63: 'full_streak_63',
  70: 'full_streak_70',
};
const specialCelebrationBadges = new Set(['third_way', 'halfway_fire']);
const finaleBadgeKey = 'day_77_finisher';
const badgePriority = [
  'day_77_finisher',
  'halfway_fire',
  'third_way',
  'final_watch',
  'sixty_strong',
  'fifty_faithful',
  'deep_roots',
  'three_week_wall',
  'two_week_guard',
  'seven_day_start',
  'full_streak_70',
  'full_streak_63',
  'full_streak_56',
  'full_streak_49',
  'full_streak_42',
  'full_streak_35',
  'full_streak_28',
  'full_streak_21',
  'full_streak_14',
  'seven_sealed',
  'streak_flame',
  'watchman_week',
  'morning_watch',
  'extreme_fire',
  'hard_path',
  'steady_grind',
  'first_sweat',
  'iron_standard',
  'honest_partial',
  'faithful_start',
];
const badgePriorityRank = new Map(badgePriority.map((key, index) => [key, index]));
const todayKey = () => new Date().toISOString().slice(0, 10);
const ENTRY_STORAGE_KEY = 'dominion:entries';
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const normalizeWorkoutDifficulty = (difficulty = {}) => ({
  one: difficultyOptions.includes(difficulty.one) ? difficulty.one : defaultWorkoutDifficulty.one,
  two: difficultyOptions.includes(difficulty.two) ? difficulty.two : defaultWorkoutDifficulty.two,
});
const localDemoMode = isLocalDemoMode();
const statusLabel = (item) => {
  if (item.status === 'scheduled') return 'scheduled miss';
  if (item.status === 'partial') return `partial check-in${item.completedCount ? ` (${item.completedCount}/7)` : ''}`;
  return 'complete';
};
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[char]));
const badgeChip = (badge) => `<span class="badge-chip ${badge.tier || 'bronze'}"><span class="app-icon icon-sm ${badgeIconClass(badge)}" aria-hidden="true"></span><span>${escapeHtml(badge.name || 'Badge')}</span></span>`;
const badgeIconClass = (badge) => {
  const icon = String(badge?.icon || '').replace(/[^a-z-]/g, '');
  return ['shield', 'check', 'spark', 'flame', 'dumbbell', 'run', 'repeat', 'eye', 'crown', 'calendar', 'target', 'flag', 'mountain', 'star'].includes(icon) ? `icon-${icon}` : 'icon-shield';
};
const badgeRank = (badge) => badgePriorityRank.get(badge?.key) ?? 999;
const oneBadgeForDisplay = (earnedBadges = []) => earnedBadges
  .filter(Boolean)
  .sort((left, right) => badgeRank(left) - badgeRank(right) || String(right.earnedAt || '').localeCompare(String(left.earnedAt || '')))
  .slice(0, 1);
const calculateLocalPoints = (entry, status) => {
  const completed = entry.completed || [];
  let points = completed.length * 10;
  if (status === 'complete') points += 30;
  if (status === 'partial') points += 10;
  if (status === 'scheduled') points += 15;
  if (completed.includes('workoutOne')) points += difficultyPointMap[workoutDifficulty.one || 'medium'] || 0;
  if (completed.includes('workoutTwo')) points += difficultyPointMap[workoutDifficulty.two || 'medium'] || 0;
  return points;
};
const badgeEarnedDate = (badge) => badge.entryDate || badge.earnedDate || badge.metadata?.entryDate || String(badge.earnedAt || '').slice(0, 10);
const badgeDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const safeBadgeTier = (badge) => {
  const tier = String(badge?.tier || '').toLowerCase();
  return ['bronze', 'silver', 'gold'].includes(tier) ? tier : 'bronze';
};
const badgeEarnedDisplay = (badge) => {
  const earnedDate = badgeEarnedDate(badge);
  if (!earnedDate) return { dateTime: '', label: 'Recently earned' };
  const dateTime = String(earnedDate).slice(0, 10);
  const date = new Date(`${dateTime}T00:00:00`);
  if (Number.isNaN(date.getTime())) return { dateTime: '', label: 'Recently earned' };
  return { dateTime, label: `Earned ${badgeDateFormatter.format(date)}` };
};
const progressionBadgeCard = (badge) => {
  const tier = safeBadgeTier(badge);
  const tierLabel = `${tier.charAt(0).toUpperCase()}${tier.slice(1)} badge`;
  const name = badge?.name || 'Badge';
  const description = badge?.description || 'Earned through faithful progress.';
  const earned = badgeEarnedDisplay(badge);
  const earnedMarkup = earned.dateTime
    ? `<time datetime="${escapeHtml(earned.dateTime)}">${escapeHtml(earned.label)}</time>`
    : `<span>${escapeHtml(earned.label)}</span>`;

  return `<article class="progression-badge-card ${tier}"><span class="progression-badge-icon app-icon ${badgeIconClass(badge)}" aria-hidden="true"></span><div class="progression-badge-copy"><div class="progression-badge-meta"><span>${escapeHtml(tierLabel)}</span>${earnedMarkup}</div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(description)}</p></div></article>`;
};
const dayCountLabel = (value) => `${value} ${value === 1 ? 'day' : 'days'}`;
const getLevelProgress = (rawTotalPoints) => {
  const numericPoints = Number(rawTotalPoints);
  const totalPoints = Number.isFinite(numericPoints) ? Math.max(0, Math.floor(numericPoints)) : 0;
  const level = Math.floor(totalPoints / POINTS_PER_LEVEL) + 1;
  const pointsIntoLevel = totalPoints % POINTS_PER_LEVEL;
  const pointsToNext = POINTS_PER_LEVEL - pointsIntoLevel;
  const progressPercent = (pointsIntoLevel / POINTS_PER_LEVEL) * 100;
  return { totalPoints, level, nextLevel: level + 1, pointsIntoLevel, pointsToNext, progressPercent };
};
const momentumMessageFor = ({ totalPoints, nextLevel, pointsToNext, appStreak, fullDayStreak, recentBadges }) => {
  if (totalPoints === 0) return 'Your first honest check-in starts the climb.';
  if (pointsToNext <= 100) return `Level ${nextLevel} is within reach—${pointsToNext} more points will get you there.`;
  if (fullDayStreak >= 7) return `${dayCountLabel(fullDayStreak)} at the full standard. Protect the streak today.`;
  if (fullDayStreak >= 3) return 'Momentum is taking shape. One more full-standard day keeps the chain alive.';
  if (appStreak >= 7) return 'You keep showing up. Turn today’s visit into a full-standard day.';
  if (appStreak >= 3) return 'The habit is forming. Carry today’s app streak into all seven actions.';
  if (recentBadges.length) return `${recentBadges[0].name || 'Your latest badge'} is on your shelf. Keep stacking the standard.`;
  return `${pointsToNext} points stand between you and Level ${nextLevel}.`;
};
const badgeExistsForDate = (date) => badges.some((badge) => badgeEarnedDate(badge) === date);
const workoutBadgeCandidates = (entry) => {
  const candidates = [];
  if ((entry.completed || []).includes('workoutOne')) candidates.push(workoutDifficulty.one || 'medium');
  if ((entry.completed || []).includes('workoutTwo')) candidates.push(workoutDifficulty.two || 'medium');
  if (candidates.includes('extreme')) return ['extreme_fire'];
  if (candidates.includes('hard')) return ['hard_path'];
  if (candidates.includes('medium')) return ['steady_grind'];
  if (candidates.includes('easy')) return ['first_sweat'];
  return [];
};
function badgeCandidatesForEntry(entry, status, nextFullStreak = 0) {
  const day = currentDay();
  const candidates = [];

  if (status === 'complete') {
    Object.entries(milestoneBadges)
      .sort(([left], [right]) => Number(right) - Number(left))
      .forEach(([threshold, key]) => {
        if (day >= Number(threshold)) candidates.push(key);
      });
    Object.entries(fullStreakBadges)
      .sort(([left], [right]) => Number(right) - Number(left))
      .forEach(([threshold, key]) => {
        if (nextFullStreak >= Number(threshold)) candidates.push(key);
      });
    if (nextFullStreak >= 3) candidates.push('streak_flame');
    if ((gameStats.currentAppStreak || 0) >= 7) candidates.push('watchman_week');
    if ((gameStats.currentAppStreak || 0) >= 3) candidates.push('morning_watch');
    candidates.push(...workoutBadgeCandidates(entry), 'iron_standard');
  } else if (status === 'partial') {
    candidates.push('honest_partial');
  }

  candidates.push('faithful_start');
  return candidates;
}
function awardLocalBadges(entry, status, nextFullStreak = 0) {
  if (badgeExistsForDate(entry.date)) return [];
  const existing = new Set(badges.map((badge) => badge.key));
  const key = badgeCandidatesForEntry(entry, status, nextFullStreak)
    .find((candidate) => !existing.has(candidate) && demoBadgeDefinitions[candidate]);

  if (!key) return [];

  const badge = {
    ...demoBadgeDefinitions[key],
    earnedAt: new Date().toISOString(),
    entryDate: entry.date,
    metadata: { entryDate: entry.date, challengeDay: currentDay() },
  };
  badges.unshift(badge);

  if (localDemoMode) save('dominion:badges', badges);
  return [badge];
}
function renderGameSummary() {
  const gamePointsTotal = $('gamePointsTotal');
  const gameLevelNumber = $('gameLevelNumber');
  const gameLevelLabel = $('gameLevelLabel');
  const gameLevelProgressLabel = $('gameLevelProgressLabel');
  const gamePointsToNext = $('gamePointsToNext');
  const gameLevelProgress = $('gameLevelProgress');
  const gameLevelProgressFill = $('gameLevelProgressFill');
  const gameMomentumMessage = $('gameMomentumMessage');
  const appStreakCount = $('appStreakCount');
  const appStreakUnit = $('appStreakUnit');
  const appStreakBest = $('appStreakBest');
  const fullDayStreakCount = $('fullDayStreakCount');
  const fullDayStreakUnit = $('fullDayStreakUnit');
  const fullDayStreakBest = $('fullDayStreakBest');
  const recentBadgeSummary = $('recentBadgeSummary');
  const badgeShelf = $('badgeShelf');
  const levelProgress = getLevelProgress(gameStats.totalPoints ?? gameStats.challengePoints ?? 0);
  const appStreak = Math.max(0, Math.floor(Number(gameStats.currentAppStreak) || 0));
  const bestAppStreak = Math.max(appStreak, Math.floor(Number(gameStats.bestAppStreak) || 0));
  const fullDayStreak = Math.max(0, Math.floor(Number(gameStats.currentFullDayStreak) || 0));
  const bestFullDayStreak = Math.max(fullDayStreak, Math.floor(Number(gameStats.bestFullDayStreak) || 0));
  const recentBadges = badges.filter(Boolean).slice(0, 4);

  if (gamePointsTotal) gamePointsTotal.textContent = levelProgress.totalPoints.toLocaleString();
  if (gameLevelNumber) gameLevelNumber.textContent = String(levelProgress.level);
  if (gameLevelLabel) gameLevelLabel.textContent = `Level ${levelProgress.level}`;
  if (gameLevelProgressLabel) gameLevelProgressLabel.textContent = `Level ${levelProgress.level} progress`;
  if (gamePointsToNext) gamePointsToNext.textContent = `${levelProgress.pointsToNext.toLocaleString()} points to Level ${levelProgress.nextLevel}`;
  if (gameLevelProgress) {
    gameLevelProgress.setAttribute('aria-valuenow', String(levelProgress.pointsIntoLevel));
    gameLevelProgress.setAttribute('aria-valuetext', `${levelProgress.pointsIntoLevel} of ${POINTS_PER_LEVEL} points earned toward Level ${levelProgress.nextLevel}`);
  }
  if (gameLevelProgressFill) gameLevelProgressFill.style.setProperty('--level-progress', `${levelProgress.progressPercent}%`);
  if (gameMomentumMessage) {
    const momentumMessage = momentumMessageFor({
      ...levelProgress,
      appStreak,
      fullDayStreak,
      recentBadges,
    });
    if (gameMomentumMessage.textContent !== momentumMessage) gameMomentumMessage.textContent = momentumMessage;
  }
  if (appStreakCount) appStreakCount.textContent = String(appStreak);
  if (appStreakUnit) appStreakUnit.textContent = appStreak === 1 ? 'day' : 'days';
  if (appStreakBest) appStreakBest.textContent = `Best ${dayCountLabel(bestAppStreak)}`;
  if (fullDayStreakCount) fullDayStreakCount.textContent = String(fullDayStreak);
  if (fullDayStreakUnit) fullDayStreakUnit.textContent = fullDayStreak === 1 ? 'day' : 'days';
  if (fullDayStreakBest) fullDayStreakBest.textContent = `Best ${dayCountLabel(bestFullDayStreak)}`;
  if (recentBadgeSummary) recentBadgeSummary.textContent = recentBadges.length ? `${recentBadges.length} recent` : 'No badges yet';
  if (badgeShelf) {
    badgeShelf.innerHTML = recentBadges.length
      ? recentBadges.map(progressionBadgeCard).join('')
      : '<article class="progression-badge-empty"><span class="app-icon icon-shield" aria-hidden="true"></span><div><strong>Your first badge is waiting.</strong><p>Complete an honest check-in to put proof of the work on your shelf.</p></div></article>';
  }
}
function launchConfetti({ endless = false } = {}) {
  const layer = $('confettiLayer');
  if (!layer) return;
  if (layer.parentElement !== document.body) document.body.appendChild(layer);
  const shell = document.querySelector('.dashboard-shell');
  const colors = ['#d6ad54', '#f0c96a', '#5fa36f', '#f8f5ef', '#5fa36f', '#2c2a27'];
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const totalPieces = endless ? (reduceMotion ? 72 : 360) : (reduceMotion ? 120 : 720);
  const burstCount = endless ? (reduceMotion ? 1 : 5) : (reduceMotion ? 2 : 8);
  const celebrationMs = reduceMotion ? REDUCED_CONFETTI_DURATION_MS : CONFETTI_DURATION_MS;
  const runId = confettiRunId + 1;
  confettiRunId = runId;

  if (confettiTimer) {
    window.clearTimeout(confettiTimer);
    confettiTimer = null;
  }

  layer.innerHTML = '';
  layer.classList.remove('active', 'endless');
  void layer.offsetWidth;
  layer.classList.add('active');
  if (endless) layer.classList.add('endless');
  if (!reduceMotion && !endless) {
    shell?.classList.remove('celebration-shake');
    void shell?.offsetWidth;
    shell?.classList.add('celebration-shake');
  }

  if (!reduceMotion && !endless && 'vibrate' in navigator) {
    navigator.vibrate([45, 35, 70, 45, 35, 30, 90]);
  }

  for (let index = 0; index < totalPieces; index += 1) {
    const piece = document.createElement('span');
    const burst = Math.floor(index / (totalPieces / burstCount));
    const shape = index % 11 === 0 ? 'spark' : index % 7 === 0 ? 'coin' : index % 5 === 0 ? 'round' : index % 3 === 0 ? 'ribbon' : '';
    const depth = index % 6 === 0 ? 'near' : index % 4 === 0 ? 'far' : 'mid';
    const baseWidth = 5 + Math.random() * 8;
    const width = shape === 'spark' ? baseWidth * 0.72 : shape === 'ribbon' ? baseWidth * 0.72 : shape === 'round' || shape === 'coin' ? baseWidth * 1.1 : baseWidth;
    const height = shape === 'spark' || shape === 'round' || shape === 'coin' ? width : baseWidth * (shape === 'ribbon' ? 2.2 : 1.4 + Math.random() * 1.4);
    const duration = endless ? 3800 + Math.random() * 2400 : 1650 + Math.random() * 1050;
    const dx = (Math.random() - 0.5) * (depth === 'near' ? 520 : depth === 'far' ? 280 : 420);
    const drift = (Math.random() - 0.5) * (depth === 'near' ? 170 : 115);
    const sway = (Math.random() - 0.5) * 74;
    const spin = Math.random() * (depth === 'near' ? 1920 : 1440) - 720;

    piece.style.setProperty('--x', `${-4 + Math.random() * 108}vw`);
    piece.style.setProperty('--dx', `${dx}px`);
    piece.style.setProperty('--dx-early', `${drift + sway}px`);
    piece.style.setProperty('--dx-mid', `${dx * 0.36 - sway}px`);
    piece.style.setProperty('--dx-sway', `${dx * 0.62 + sway * 0.45}px`);
    piece.style.setProperty('--dx-late', `${dx * 0.82}px`);
    const delay = endless
      ? -(Math.random() * duration)
      : burst * 760 + 120 + Math.random() * 360;
    piece.style.setProperty('--delay', `${delay}ms`);
    piece.style.setProperty('--duration', `${duration}ms`);
    piece.style.setProperty('--spin', `${spin}deg`);
    piece.style.setProperty('--spin-early', `${spin * 0.12}deg`);
    piece.style.setProperty('--spin-mid', `${spin * 0.55}deg`);
    piece.style.setProperty('--spin-late', `${spin * 0.82}deg`);
    piece.style.setProperty('--w', `${width}px`);
    piece.style.setProperty('--h', `${height}px`);
    piece.style.setProperty('--drift', `${drift}px`);
    piece.style.background = shape === 'coin'
      ? 'radial-gradient(circle at 35% 28%, #fff7c8 0 15%, #f0c96a 36%, #9d6c22 100%)'
      : shape === 'spark'
        ? '#f8f5ef'
        : colors[index % colors.length];
    piece.style.color = colors[index % colors.length];
    piece.className = `${shape} ${depth}`.trim();
    layer.appendChild(piece);
  }

  if (endless) return 0;

  confettiTimer = window.setTimeout(() => {
    if (confettiRunId !== runId || layer.classList.contains('endless')) return;
    layer.innerHTML = '';
    layer.classList.remove('active', 'endless');
    shell?.classList.remove('celebration-shake');
    confettiTimer = null;
  }, celebrationMs);
  return celebrationMs;
}
function startEndlessConfetti() {
  const layer = $('confettiLayer');
  if (layer?.classList.contains('endless') && layer.children.length) return;
  launchConfetti({ endless: true });
}
function stopEndlessConfetti() {
  const layer = $('confettiLayer');
  if (!layer?.classList.contains('endless')) return;
  confettiRunId += 1;
  if (confettiTimer) {
    window.clearTimeout(confettiTimer);
    confettiTimer = null;
  }
  layer.innerHTML = '';
  layer.classList.remove('active', 'endless');
}
function finishRewardToastDismiss(rewardToast, rewardBackdrop) {
  if (rewardToast.exitTimer) {
    window.clearTimeout(rewardToast.exitTimer);
    rewardToast.exitTimer = null;
  }
  if (rewardToast.exitAnimationListener) {
    rewardToast.removeEventListener('animationend', rewardToast.exitAnimationListener);
    rewardToast.exitAnimationListener = null;
  }
  rewardToast.classList.remove('active', 'exiting');
  rewardToast.hidden = true;
  if (rewardBackdrop) {
    rewardBackdrop.classList.remove('active', 'exiting');
    rewardBackdrop.hidden = true;
  }
}
function dismissRewardToast(rewardToast, rewardBackdrop) {
  const finishDismissal = () => finishRewardToastDismiss(rewardToast, rewardBackdrop);
  const onAnimationEnd = (event) => {
    if (event.target === rewardToast && event.animationName === 'reward-toast-dissolve-out') {
      finishDismissal();
    }
  };

  rewardToast.exitAnimationListener = onAnimationEnd;
  rewardToast.addEventListener('animationend', onAnimationEnd);
  rewardToast.classList.remove('active');
  rewardToast.classList.add('exiting');
  rewardBackdrop?.classList.remove('active');
  rewardBackdrop?.classList.add('exiting');
  rewardToast.exitTimer = window.setTimeout(finishDismissal, REWARD_TOAST_EXIT_MS + 80);
}
function showRewardToast({ points = 0, earnedBadges = [], status = 'complete' }) {
  const rewardToast = $('rewardToast');
  const rewardBackdrop = $('rewardBackdrop');
  const rewardTitle = $('rewardTitle');
  const rewardCopy = $('rewardCopy');
  const rewardBadges = $('rewardBadges');
  if (!rewardToast || !rewardTitle || !rewardCopy) return;
  const displayBadges = oneBadgeForDisplay(earnedBadges);

  if (status === 'visit') rewardTitle.textContent = 'Streak updated.';
  else rewardTitle.textContent = status === 'complete' ? 'Full day complete.' : 'Check-in posted.';
  rewardCopy.textContent = points
    ? `+${points} points added. Keep stacking the standard.`
    : status === 'visit'
      ? 'You showed up today. Keep the streak alive.'
      : 'Your check-in is posted. Points are being synced.';
  if (rewardBadges) {
    rewardBadges.innerHTML = displayBadges.length
      ? displayBadges.map(badgeChip).join('')
      : '<span class="badge-empty">Badges update as streaks grow.</span>';
  }
  if (rewardToast.hideTimer) {
    window.clearTimeout(rewardToast.hideTimer);
    rewardToast.hideTimer = null;
  }
  if (rewardToast.exitTimer) {
    window.clearTimeout(rewardToast.exitTimer);
    rewardToast.exitTimer = null;
  }
  if (rewardToast.exitAnimationListener) {
    rewardToast.removeEventListener('animationend', rewardToast.exitAnimationListener);
    rewardToast.exitAnimationListener = null;
  }
  rewardToast.hidden = false;
  if (rewardBackdrop) rewardBackdrop.hidden = false;
  rewardToast.classList.remove('active', 'exiting');
  rewardBackdrop?.classList.remove('active', 'exiting');
  rewardToast.getAnimations?.().forEach((animation) => animation.cancel());
  rewardBackdrop?.getAnimations?.().forEach((animation) => animation.cancel());
  void rewardToast.offsetWidth;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      rewardBackdrop?.classList.add('active');
      rewardToast.classList.add('active');
    });
  });
  const toastDuration = status === 'complete' ? DAY_COMPLETE_TOAST_DURATION_MS : REWARD_TOAST_DURATION_MS;
  rewardToast.hideTimer = window.setTimeout(() => {
    rewardToast.hideTimer = null;
    dismissRewardToast(rewardToast, rewardBackdrop);
  }, toastDuration);
  return toastDuration + REWARD_TOAST_EXIT_MS;
}
function showBadgeCelebration(badge) {
  const stage = $('badgeCelebration');
  const icon = $('badgeCelebrationIcon');
  const title = $('badgeCelebrationTitle');
  const copy = $('badgeCelebrationCopy');
  if (!stage || !badge) return;
  const isFinale = badge.key === finaleBadgeKey;
  const isSpecial = specialCelebrationBadges.has(badge.key);

  if (title) title.textContent = badge.name || 'Badge Earned';
  if (copy) {
    const tier = badge.tier ? `${badge.tier} badge` : 'badge';
    if (isFinale) copy.textContent = 'You completed all 77 days. Dominion finished strong.';
    else if (isSpecial) copy.textContent = `Milestone reached. You unlocked a ${tier} for crossing a major line.`;
    else copy.textContent = `You unlocked a ${tier}. Keep stacking faithful days.`;
  }
  if (icon) {
    icon.className = `badge-medal-icon app-icon ${badgeIconClass(badge)}`;
  }

  if (stage.hideTimer) window.clearTimeout(stage.hideTimer);
  if (stage.exitTimer) window.clearTimeout(stage.exitTimer);
  stage.hidden = false;
  stage.classList.remove('active', 'exiting', 'milestone', 'finale');
  stage.classList.toggle('milestone', isSpecial);
  stage.classList.toggle('finale', isFinale);
  void stage.offsetWidth;
  stage.classList.add('active');
  stage.exitTimer = window.setTimeout(() => {
    stage.classList.add('exiting');
  }, BADGE_REVEAL_DURATION_MS);
  stage.hideTimer = window.setTimeout(() => {
    stage.classList.remove('active', 'exiting');
    stage.hidden = true;
    stage.exitTimer = null;
    stage.hideTimer = null;
  }, BADGE_REVEAL_DURATION_MS + 420);
}
function queueBadgeCelebrations(earnedBadges = [], delay = 0) {
  oneBadgeForDisplay(earnedBadges).forEach((badge, index) => {
    window.setTimeout(() => showBadgeCelebration(badge), delay + index * (BADGE_REVEAL_DURATION_MS + 900));
  });
}
let theme = load('dominion:theme', 'dark');
let startDate = localDemoMode ? load('dominion:startDate', todayKey()) : todayKey();
let entries = load(ENTRY_STORAGE_KEY, []);
let feed = localDemoMode ? load('dominion:feed', starterFeed) : starterFeed;
let workoutDifficulty = normalizeWorkoutDifficulty(load('dominion:workoutDifficulty', defaultWorkoutDifficulty));
let gameStats = localDemoMode ? load('dominion:gameStats', {
  totalPoints: 0,
  currentAppStreak: 1,
  bestAppStreak: 1,
  currentFullDayStreak: 0,
  bestFullDayStreak: 0,
}) : {};
let badges = localDemoMode ? load('dominion:badges', []) : [];
let countdownTimer = null;
let activeCountdownCallout = '';
let confettiTimer = null;
let confettiRunId = 0;
let entrySaveQueue = Promise.resolve();
const $ = (id) => document.getElementById(id);
const verseText = $('verseText');
const verseReference = $('verseReference');
const verseAppLink = $('verseAppLink');
const dayIndex = () => Math.floor(new Date(`${todayKey()}T00:00:00`).getTime() / 86400000);
const pickDaily = (items, offset = 0) => items[(dayIndex() + offset) % items.length];
const todayEntry = () => {
  const entry = entries.find(item => item.date === todayKey()) || {};
  return {
    date: todayKey(),
    ...entry,
    completed: Array.isArray(entry.completed) ? entry.completed : [],
  };
};
const saveEntry = (entry) => {
  const index = entries.findIndex(item => item.date === entry.date);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  save(ENTRY_STORAGE_KEY, entries);
  if (hasSupabaseAuth()) {
    entrySaveQueue = entrySaveQueue
      .then(() => saveChallengeEntry(entry))
      .catch((error) => console.warn('Unable to sync challenge entry', error));
  }
};
const rawChallengeDay = () => Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000) + 1;
const currentDay = () => Math.min(Math.max(rawChallengeDay(), 1), TOTAL_DAYS);
const hasFinalBadge = () => badges.some((badge) => badge.key === finaleBadgeKey);
const isChallengeFinished = () => hasFinalBadge() || rawChallengeDay() > TOTAL_DAYS;
function renderChecklist(entry) {
  const checklist = $('checklist');
  if (!checklist) return;

  if (!checklist.dataset.mounted) {
    checklist.innerHTML = scorecardGroups.map((group) => {
      const rows = group.items.map(([id, label, detail]) => (
        `<button class="check-row" data-standard="${id}" aria-pressed="false" type="button"><span class="box"><span class="app-icon icon-sm icon-check" aria-hidden="true"></span></span><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span></button>`
      )).join('');
      const itemLabel = group.items.length === 1 ? 'action' : 'actions';
      return `<section class="checklist-group"><div class="checklist-group-header"><p class="checklist-group-title">${escapeHtml(group.label)}</p><span>${group.items.length} ${itemLabel}</span></div><div class="checklist-group-items">${rows}</div></section>`;
    }).join('');
    checklist.dataset.mounted = 'true';
  }

  const completed = new Set(entry.completed);
  const locked = Boolean(entry.scheduledMiss) || isChallengeFinished();
  checklist.querySelectorAll('[data-standard]').forEach((row) => {
    const isChecked = completed.has(row.dataset.standard);
    row.classList.toggle('checked', isChecked);
    row.disabled = locked;
    row.setAttribute('aria-pressed', String(isChecked));
  });
}
function renderTodayActionCompletion(entry) {
  const completed = new Set(entry.completed);
  const locked = Boolean(entry.scheduledMiss) || isChallengeFinished();

  document.querySelectorAll('[data-action-completion]').forEach((button) => {
    const isChecked = completed.has(button.dataset.actionCompletion);
    const label = button.dataset.actionName
      || button.getAttribute('aria-label')?.replace(/^Mark | complete$/g, '')
      || 'Action';
    const labelElement = button.querySelector('[data-completion-label]');
    button.dataset.actionName = label;
    button.classList.toggle('completed', isChecked);
    button.disabled = locked;
    button.setAttribute('aria-pressed', String(isChecked));
    button.setAttribute('aria-label', `Mark ${label} ${isChecked ? 'incomplete' : 'complete'}`);
    if (labelElement) labelElement.textContent = isChecked ? 'Completed' : `Mark ${label} complete`;
    button.closest('.action-card, .verse-card')?.classList.toggle('action-completed', isChecked);
  });

  const floatingCheckInCta = $('floatingCheckInCta');
  if (floatingCheckInCta) {
    const allActionsCompleted = standards.every(([id]) => completed.has(id)) && !locked;
    floatingCheckInCta.classList.toggle('visible', allActionsCompleted);
    floatingCheckInCta.setAttribute('aria-hidden', String(!allActionsCompleted));
    floatingCheckInCta.tabIndex = allActionsCompleted ? 0 : -1;
    document.body.classList.toggle('check-in-cta-visible', allActionsCompleted);
  }
}
function toggleStandard(id) {
  if (isChallengeFinished() || todayEntry().scheduledMiss) return;
  const currentEntry = todayEntry();
  const completed = new Set(currentEntry.completed);
  if (completed.has(id)) completed.delete(id);
  else completed.add(id);
  saveEntry({ ...currentEntry, completed: [...completed], scheduledMiss: false });
  render();
}
const padClock = (value) => String(value).padStart(2, '0');
function getDayTiming(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  const dayMs = end - start;
  const elapsedMs = Math.min(Math.max(now - start, 0), dayMs);
  const remainingSeconds = Math.max(Math.ceil((end - now) / 1000), 0);
  return {
    elapsedPercent: Math.min(Math.round((elapsedMs / dayMs) * 100), 100),
    remainingSeconds,
  };
}
function formatRemainingTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${padClock(hours)}h ${padClock(minutes)}m ${padClock(seconds)}s`;
}
function updateCountdownCard() {
  const countdownTime = $('countdownTime');
  const countdownProgress = $('countdownProgress');
  const countdownCallout = $('countdownCallout');
  const countdownProgressLabel = $('countdownProgressLabel');
  const countdownActionsLabel = $('countdownActionsLabel');
  if (!countdownTime || !countdownProgress || !countdownCallout) return;

  const entry = todayEntry();
  if (isChallengeFinished()) {
    countdownTime.textContent = '77 days complete';
    countdownProgress.style.setProperty('--progress', '100%');
    countdownCallout.textContent = 'You finished the 77-day challenge. Keep guarding what changed.';
    activeCountdownCallout = countdownCallout.textContent;
    if (countdownProgressLabel) countdownProgressLabel.textContent = 'Challenge complete';
    if (countdownActionsLabel) countdownActionsLabel.textContent = 'More challenges coming soon';
    return;
  }

  const { elapsedPercent, remainingSeconds } = getDayTiming();
  const calloutSlot = Math.floor(Date.now() / (30 * 60 * 1000));
  const callout = countdownCallouts[(dayIndex() + calloutSlot + entry.completed.length) % countdownCallouts.length];

  countdownTime.textContent = formatRemainingTime(remainingSeconds);
  countdownProgress.style.setProperty('--progress', `${elapsedPercent}%`);
  if (activeCountdownCallout !== callout) {
    countdownCallout.textContent = callout;
    activeCountdownCallout = callout;
  }
  if (countdownProgressLabel) countdownProgressLabel.textContent = `${elapsedPercent}% of the day used`;
  if (countdownActionsLabel) countdownActionsLabel.textContent = `${entry.completed.length} of 7 actions complete`;
}
function applyVerse(verse) {
  if (!verseText || !verseReference) return;
  verseText.textContent = verse.text;
  verseReference.textContent = verse.reference;
}
function applyDailyActions() {
  const morningPrayerLink = $('morningPrayerLink');
  const eveningPrayerLink = $('eveningPrayerLink');
  const worshipLink = $('worshipLink');
  const worshipPrompt = $('worshipPrompt');
  const workoutOneDifficulty = $('workoutOneDifficulty');
  const workoutTwoDifficulty = $('workoutTwoDifficulty');
  const workoutOneRecommendation = $('workoutOneRecommendation');
  const workoutTwoRecommendation = $('workoutTwoRecommendation');
  const workoutOneLink = $('workoutOneLink');
  const workoutTwoLink = $('workoutTwoLink');

  if (morningPrayerLink) morningPrayerLink.href = YOUVERSION_PRAYER_URL;
  if (eveningPrayerLink) eveningPrayerLink.href = YOUVERSION_PRAYER_URL;

  const worship = pickDaily(worshipPlaylists);
  if (worshipLink) {
    worshipLink.href = worship.url;
    const worshipLinkLabel = worshipLink.querySelector('span:nth-child(2)');
    if (worshipLinkLabel) worshipLinkLabel.textContent = 'Open today’s worship';
    else worshipLink.textContent = 'Open today’s worship';
  }
  if (worshipPrompt) worshipPrompt.textContent = worship.label;

  workoutDifficulty = normalizeWorkoutDifficulty(workoutDifficulty);
  if (workoutOneDifficulty) workoutOneDifficulty.value = workoutDifficulty.one;
  if (workoutTwoDifficulty) workoutTwoDifficulty.value = workoutDifficulty.two;

  const onePlan = pickDaily(workoutPlans[workoutDifficulty.one], 0);
  const twoPlan = pickDaily(workoutPlans[workoutDifficulty.two], 1);
  if (workoutOneRecommendation) workoutOneRecommendation.textContent = onePlan;
  if (workoutTwoRecommendation) workoutTwoRecommendation.textContent = twoPlan;
  if (workoutOneLink) workoutOneLink.href = APPLE_FITNESS_URL;
  if (workoutTwoLink) workoutTwoLink.href = APPLE_FITNESS_URL;
}
async function loadVerseOfDay() {
  if (!YOUVERSION_VERSE_URL) {
    applyVerse(fallbackVerse);
    return;
  }

  try {
    const response = await fetch(YOUVERSION_VERSE_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Verse request failed (${response.status})`);
    const data = await response.json();
    const verse = {
      text:
        data?.verse?.text ||
        data?.data?.verse?.text ||
        data?.data?.attributes?.text ||
        data?.text ||
        fallbackVerse.text,
      reference:
        data?.verse?.reference ||
        data?.data?.verse?.reference ||
        data?.data?.attributes?.reference ||
        data?.reference ||
        fallbackVerse.reference,
    };
    applyVerse(verse);
  } catch (error) {
    console.warn('Using fallback verse of the day', error);
    applyVerse(fallbackVerse);
  }
}
function render() {
  document.documentElement.dataset.theme = theme;
  const finished = isChallengeFinished();
  document.body.classList.toggle('challenge-finished', finished);
  const themeToggle = $('themeToggle');
  const dashboardTitle = $('dashboardTitle');
  const dashboardLead = $('dashboardLead');
  const challengeCompletePanel = $('challengeCompletePanel');
  const startDateInput = $('startDate');
  const challengePercentEl = $('challengePercent');
  const challengeDayEl = $('challengeDay');
  const challengeRing = $('challengeRing');
  const todayPercentEl = $('todayPercent');
  const todayCountEl = $('todayCount');
  const todayRing = $('todayRing');
  const checkInButton = $('checkInButton');
  const scheduledButton = $('scheduledButton');
  const selectAllActionsButton = $('selectAllActionsButton');
  const checklist = $('checklist');
  const feedEl = $('feed');
  const completedToday = $('completedToday');
  if (dashboardTitle) dashboardTitle.textContent = finished ? COMPLETION_HERO.title : 'Today’s Dominion';
  if (dashboardLead) dashboardLead.textContent = finished ? COMPLETION_HERO.lead : 'Track your standards, post your check-in, and stay honest.';
  if (challengeCompletePanel) challengeCompletePanel.hidden = !finished;
  if (themeToggle) themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
  if (startDateInput) startDateInput.value = startDate;
  const entry = todayEntry();
  const completedStandards = new Set(entry.completed);
  const challengePercent = finished ? 100 : Math.round((currentDay() / TOTAL_DAYS) * 100);
  const todayPercent = Math.round((entry.completed.length / standards.length) * 100);
  const hasCompletedActions = entry.completed.length > 0;
  const hasPostableCheckIn = !finished && (hasCompletedActions || entry.scheduledMiss);
  const allActionsCompleted = standards.every(([id]) => completedStandards.has(id));
  if (challengePercentEl) challengePercentEl.textContent = `${challengePercent}%`;
  if (challengeDayEl) challengeDayEl.textContent = `Day ${currentDay()} of 77`;
  if (challengeRing) challengeRing.style.setProperty('--value', `${challengePercent}%`);
  if (todayPercentEl) todayPercentEl.textContent = `${todayPercent}%`;
  if (todayCountEl) todayCountEl.textContent = entry.scheduledMiss ? 'Scheduled miss day' : `${entry.completed.length} of ${standards.length} done`;
  if (todayRing) todayRing.style.setProperty('--value', `${todayPercent}%`);
  if (checkInButton) checkInButton.disabled = !hasPostableCheckIn;
  if (scheduledButton) {
    scheduledButton.classList.toggle('active', !!entry.scheduledMiss);
    scheduledButton.disabled = finished || (hasCompletedActions && !entry.scheduledMiss);
    scheduledButton.textContent = entry.scheduledMiss ? 'Scheduled miss selected' : 'Scheduled miss day planned ahead';
    scheduledButton.setAttribute('aria-pressed', String(!!entry.scheduledMiss));
  }
  if (selectAllActionsButton) {
    selectAllActionsButton.classList.toggle('active', allActionsCompleted);
    selectAllActionsButton.disabled = finished || !!entry.scheduledMiss;
    selectAllActionsButton.textContent = allActionsCompleted ? 'Unselect all' : 'Select all';
    selectAllActionsButton.setAttribute('aria-pressed', String(allActionsCompleted));
  }
  if (checklist) renderChecklist(entry);
  renderTodayActionCompletion(entry);
  if (feedEl) {
    feedEl.innerHTML = feed.slice(0, 6).map((item) => {
      const points = item.pointsAwarded ? ` · +${item.pointsAwarded} pts` : '';
      return `<article class="feed-item"><div><strong>${escapeHtml(item.name)}</strong><p>Day ${item.day} ${statusLabel(item)}${points}</p></div><span class="feed-status"><span class="app-icon icon-sm ${item.status === 'complete' ? 'icon-check' : 'icon-repeat'}" aria-hidden="true"></span></span></article>`;
    }).join('');
  }
  if (completedToday) completedToday.textContent = `${feed.filter(item => item.status === 'complete' && item.timestamp === 'Today').length} people completed today`;
  if (verseAppLink) verseAppLink.href = YOUVERSION_APP_URL;
  applyDailyActions();
  renderGameSummary();
  updateCountdownCard();
  if (finished) startEndlessConfetti();
  else stopEndlessConfetti();
}
function startCountdownCard() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  updateCountdownCard();
  countdownTimer = window.setInterval(updateCountdownCard, 1000);
}
async function hydrateDashboardFromApi() {
  if (!hasSupabaseAuth()) return;

  try {
    const dashboard = await getDashboard();
    if (dashboard?.profile?.challengeStartDate) {
      startDate = dashboard.profile.challengeStartDate;
      save('dominion:startDate', startDate);
    }
    if (Array.isArray(dashboard?.entries)) {
      entries = dashboard.entries.map((entry) => ({
        date: entry.date,
        completed: Array.isArray(entry.completed) ? entry.completed : [],
        scheduledMiss: Boolean(entry.scheduledMiss),
      }));
      save(ENTRY_STORAGE_KEY, entries);
    }
    if (Array.isArray(dashboard?.feed) && dashboard.feed.length) {
      feed = dashboard.feed;
      save('dominion:feed', feed);
    }
    if (dashboard?.gameStats) {
      gameStats = dashboard.gameStats;
      save('dominion:gameStats', gameStats);
    }
    if (Array.isArray(dashboard?.badges)) {
      badges = dashboard.badges;
      save('dominion:badges', badges);
    }
    render();
  } catch (error) {
    console.warn('Unable to load dashboard from Supabase', error);
  }
}

async function refreshGameSummary(previousBadgeKeys = new Set()) {
  if (!hasSupabaseAuth()) return [];
  const summary = await getGameSummary();
  gameStats = summary.gameStats;
  badges = summary.badges || [];
  save('dominion:gameStats', gameStats);
  save('dominion:badges', badges);
  return badges.filter((badge) => !previousBadgeKeys.has(badge.key));
}

async function recordDailyAppVisit() {
  if (!hasSupabaseAuth()) return;
  const previousBadgeKeys = new Set(badges.map((badge) => badge.key));
  try {
    const visit = await recordAppVisit();
    if (visit) {
      gameStats = {
        ...gameStats,
        totalPoints: visit.totalPoints,
        currentAppStreak: visit.currentAppStreak,
        bestAppStreak: visit.bestAppStreak,
      };
      save('dominion:gameStats', gameStats);
    }
    await refreshGameSummary(previousBadgeKeys);
    render();
  } catch (error) {
    console.warn('Unable to record daily app visit', error);
  }
}

const themeToggle = $('themeToggle');
const startDateInput = $('startDate');
const checklist = $('checklist');
const scheduledButton = $('scheduledButton');
const selectAllActionsButton = $('selectAllActionsButton');
const checkInButton = $('checkInButton');
const countdownCheckInButton = $('countdownCheckInButton');
const walkReminderButton = $('walkReminderButton');
if (themeToggle) themeToggle.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('dominion:theme', theme); render(); });
if (startDateInput) startDateInput.addEventListener('input', event => {
  startDate = event.target.value || todayKey();
  if (localDemoMode) save('dominion:startDate', startDate);
  if (hasSupabaseAuth()) {
    updateProfile({ challengeStartDate: startDate }).catch((error) => console.warn('Unable to sync profile', error));
  }
  render();
});
document.querySelectorAll('[data-workout]').forEach((select) => {
  select.addEventListener('change', (event) => {
    const target = event.target;
    workoutDifficulty = normalizeWorkoutDifficulty({ ...workoutDifficulty, [target.dataset.workout]: target.value });
    save('dominion:workoutDifficulty', workoutDifficulty);
    applyDailyActions();
  });
});
document.querySelectorAll('[data-native-health]').forEach((button) => {
  button.addEventListener('click', () => {
    window.alert('Apple Health activity rings and step data require a native iOS/watchOS app with HealthKit permission. For now, keep using the daily checkboxes here; this is ready for the native bridge later.');
  });
});
if (walkReminderButton) walkReminderButton.addEventListener('click', () => {
  if (WALK_ALARM_URL) {
    window.location.href = WALK_ALARM_URL;
    return;
  }
  const time = window.prompt('What time should your walk alarm be?', '12:30 PM');
  const status = $('walkReminderStatus');
  if (time && status) status.textContent = `Set an alarm in Clock for ${time} and label it Dominion Walk.`;
});
if (checklist) checklist.addEventListener('click', event => {
  const row = event.target.closest('[data-standard]');
  if (!row) return;
  toggleStandard(row.dataset.standard);
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action-completion]');
  if (button) toggleStandard(button.dataset.actionCompletion);
});
window.addEventListener('storage', (event) => {
  if (event.key !== ENTRY_STORAGE_KEY) return;
  entries = load(ENTRY_STORAGE_KEY, []);
  render();
});
if (scheduledButton) scheduledButton.addEventListener('click', () => {
  if (isChallengeFinished()) return;
  const currentEntry = todayEntry();
  if (currentEntry.completed.length > 0 && !currentEntry.scheduledMiss) return;
  const entry = { ...currentEntry, completed: [], scheduledMiss: !currentEntry.scheduledMiss };
  saveEntry(entry);
  render();
});
if (selectAllActionsButton) selectAllActionsButton.addEventListener('click', () => {
  if (isChallengeFinished()) return;
  const currentEntry = todayEntry();
  if (currentEntry.scheduledMiss) return;
  const completedStandards = new Set(currentEntry.completed);
  const allActionsCompleted = standards.every(([id]) => completedStandards.has(id));
  const entry = {
    ...currentEntry,
    completed: allActionsCompleted ? [] : standards.map(([id]) => id),
    scheduledMiss: false,
  };
  saveEntry(entry);
  render();
});
if (checkInButton) checkInButton.addEventListener('click', async () => {
  const entry = todayEntry();
  if (isChallengeFinished()) {
    window.alert('The 77-day challenge is complete. More challenges are coming soon.');
    render();
    return;
  }
  if (!entry.scheduledMiss && entry.completed.length === 0) return;
  const status = entry.scheduledMiss ? 'scheduled' : entry.completed.length === standards.length ? 'complete' : 'partial';
  const previousBadgeKeys = new Set(badges.map((badge) => badge.key));
  const originalLabel = checkInButton.textContent;
  let feedItem = {
    name: 'You',
    day: currentDay(),
    status,
    completedCount: entry.completed.length,
    pointsAwarded: 0,
    timestamp: 'Today',
  };
  let earnedBadges = [];

  checkInButton.disabled = true;
  checkInButton.textContent = 'Posting...';

  try {
    if (hasSupabaseAuth()) {
      feedItem = {
        ...(await postCheckIn({
          date: entry.date,
          day: currentDay(),
          status,
          completedCount: entry.completed.length,
          completed: entry.completed,
          workoutDifficulty,
        })),
        name: 'You',
        timestamp: 'Today',
      };
      earnedBadges = oneBadgeForDisplay((await refreshGameSummary(previousBadgeKeys))
        .filter((badge) => badgeEarnedDate(badge) === entry.date));
    } else {
      let points = calculateLocalPoints(entry, status);
      let nextStreak = gameStats.currentFullDayStreak || 0;
      if (status === 'complete') {
        nextStreak += 1;
        const streakBonus = { 3: 25, 7: 75, 14: 150, 30: 300, 77: 777 }[nextStreak] || 0;
        points += streakBonus;
        gameStats.currentFullDayStreak = nextStreak;
        gameStats.bestFullDayStreak = Math.max(gameStats.bestFullDayStreak || 0, nextStreak);
      }
      gameStats.totalPoints = (gameStats.totalPoints || 0) + points;
      gameStats.challengePoints = (gameStats.challengePoints || 0) + points;
      feedItem.pointsAwarded = points;
      earnedBadges = awardLocalBadges(entry, status, nextStreak);
      save('dominion:gameStats', gameStats);
      save('dominion:badges', badges);
    }

    feed = [feedItem, ...feed].slice(0, 30);
    if (localDemoMode) save('dominion:feed', feed);
    const confettiDuration = status === 'complete' ? launchConfetti() || 0 : 0;
    const toastDuration = showRewardToast({ points: feedItem.pointsAwarded, earnedBadges, status }) || 0;
    queueBadgeCelebrations(earnedBadges, Math.max(confettiDuration, toastDuration) + 350);
  } catch (error) {
    console.warn('Unable to sync check-in', error);
    window.alert(error?.message || 'Unable to post that check-in right now.');
  } finally {
    checkInButton.textContent = originalLabel;
    render();
  }
});
if (countdownCheckInButton && checkInButton) countdownCheckInButton.addEventListener('click', () => {
  checkInButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
  checkInButton.focus({ preventScroll: true });
});

async function bootDashboard() {
  if (!hasSupabaseAuth() && !localDemoMode) {
    redirectToLogin();
    return;
  }

  if (hasSupabaseAuth() || localDemoMode) {
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin();
      return;
    }
    if (!billing.appAccess) {
      window.location.href = './billing.html?intent=subscription';
      return;
    }
  }

  render();
  await hydrateDashboardFromApi();
  recordDailyAppVisit();
  loadVerseOfDay();
  applyDailyActions();
  startCountdownCard();
  requestAnimationFrame(() => initReveal());
}

bootDashboard().catch((error) => {
  console.warn('Unable to boot dashboard', error);
  render();
  requestAnimationFrame(() => initReveal());
});
