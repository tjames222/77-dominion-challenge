import { initReveal } from './reveal';
import {
  claimChallengeUnlocks,
  getBillingState,
  getChallengeProgression,
  getDailyStandardDraft,
  getDashboard,
  getGameSummary,
  getLeaderboardPrestige,
  hasSupabaseAuth,
  isLocalDemoMode,
  mutateDailyStandardDraft,
  postCheckIn,
  recordAppVisit,
  redirectToLogin,
  setDailyStandardWorkoutDifficulty,
  startChallenge,
  updateProfile,
} from './api';
import {
  DEFAULT_WORKOUT_DIFFICULTY,
  calculateCheckInScore,
  normalizeWorkoutDifficulty,
} from './scoring.mjs';
import { dailyStandardRoute } from './daily-standard-routes.mjs';
import {
  CHECK_IN_ALREADY_COMPLETE_CODE,
  CHECK_IN_ALREADY_COMPLETE_MESSAGE,
  CHECK_IN_SUBMISSION_COOLDOWN_MS,
  addCheckInDate,
  calendarDayDifference,
  canStartCheckInSubmission,
  checkInCacheForOwner,
  createCheckInCache,
  createCheckInAlreadyCompleteError,
  currentFullDayStreakForDate,
  dateKeyForTimeZone,
  normalizeChallengeDays,
} from './check-in.mjs';
import { syncWorkoutDifficultyControls } from './workout-difficulty-controls.mjs';
import { resolveLeaderboardPrestige } from './leaderboard-prestige.mjs';
import {
  PREVIEW_CHALLENGE_STORAGE_KEY,
  PREVIEW_CHECK_IN_DATES_STORAGE_KEY,
  advancePreviewChallenge,
  advancePreviewStreaks,
  isPreviewChallengeActive,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDate,
  previewChallengeDay,
} from './preview-challenge.mjs';

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
  { name: 'Tim', day: 12, status: 'complete', timestamp: 'Today' },
];
const DEFAULT_DEMO_GAME_STATS = {
  totalPoints: 0,
  currentAppStreak: 1,
  bestAppStreak: 1,
  currentFullDayStreak: 0,
  bestFullDayStreak: 0,
};
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
const POINTS_PER_LEVEL = 500;
const CONFETTI_DURATION_MS = 10800;
const REDUCED_CONFETTI_DURATION_MS = 2200;
const REWARD_TOAST_DURATION_MS = 5200;
const DAY_COMPLETE_TOAST_DURATION_MS = CONFETTI_DURATION_MS + 650;
const REWARD_TOAST_EXIT_MS = 320;
const BADGE_REVEAL_DURATION_MS = 5600;
const COMPLETION_HERO = {
  title: 'Congratulations, you did it!',
  lead: 'You reached the 77-day finish line. Your next point-unlocked challenge is ready below.',
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
const BROWSER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
let userTimeZone = BROWSER_TIME_ZONE;
const calendarTodayKey = () => dateKeyForTimeZone(new Date(), userTimeZone);
const ENTRY_STORAGE_KEY = 'dominion:entries';
const CHECK_IN_DATES_STORAGE_KEY = 'dominion:checkInDates';
const WORKOUT_DIFFICULTY_STORAGE_KEY = 'dominion:workoutDifficulty';
const ACTIVE_CREW_STORAGE_KEY = 'dominion:activeCrewId';
const LEADERBOARD_PRESTIGE_WINDOW = 'week';
const LEADERBOARD_PRESTIGE_REFRESH_MS = 60_000;
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const localDemoMode = isLocalDemoMode();
let previewChallengeState = normalizePreviewChallengeState(
  localDemoMode ? load(PREVIEW_CHALLENGE_STORAGE_KEY, {}) : {},
  calendarTodayKey(),
);
const previewChallengeMode = () => isPreviewChallengeActive(localDemoMode, previewChallengeState);
const todayKey = () => previewChallengeMode()
  ? previewChallengeDate(previewChallengeState)
  : calendarTodayKey();
const checkInDatesStorageKey = () => previewChallengeMode()
  ? PREVIEW_CHECK_IN_DATES_STORAGE_KEY
  : CHECK_IN_DATES_STORAGE_KEY;
const statusLabel = (item) => {
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
  return calculateCheckInScore({
    completed: entry.completed,
    status,
    workoutDifficulty,
  }).totalPoints;
};
const badgeEarnedDate = (badge) => badge.entryDate || badge.earnedDate || badge.metadata?.entryDate || String(badge.earnedAt || '').slice(0, 10);
const badgeDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const challengeDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
function badgeCandidatesForEntry(entry, status, nextFullStreak = 0, challengeDay = currentDay()) {
  const day = challengeDay;
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
function awardLocalBadges(entry, status, nextFullStreak = 0, challengeDay = currentDay()) {
  if (badgeExistsForDate(entry.date)) return [];
  const existing = new Set(badges.map((badge) => badge.key));
  const key = badgeCandidatesForEntry(entry, status, nextFullStreak, challengeDay)
    .find((candidate) => !existing.has(candidate) && demoBadgeDefinitions[candidate]);

  if (!key) return [];

  const badge = {
    ...demoBadgeDefinitions[key],
    earnedAt: new Date().toISOString(),
    entryDate: entry.date,
    metadata: { entryDate: entry.date, challengeDay },
  };
  badges.unshift(badge);
  return [badge];
}
function renderGameSummary() {
  const gamePointsTotal = $('gamePointsTotal');
  const gameLevelEmblem = $('gameLevelEmblem');
  const gameLevelCrown = $('gameLevelCrown');
  const gameLevelNumber = $('gameLevelNumber');
  const gameLevelLabel = $('gameLevelLabel');
  const gamePrestigeStatus = $('gamePrestigeStatus');
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
  const fullDayStreak = currentFullDayStreakForDate(gameStats, todayKey());
  const bestFullDayStreak = Math.max(fullDayStreak, Math.floor(Number(gameStats.bestFullDayStreak) || 0));
  const recentBadges = badges.filter(Boolean).slice(0, 4);
  const prestige = resolveLeaderboardPrestige(leaderboardPositions);
  const levelLabel = prestige.shortLabel
    ? `Level ${levelProgress.level} · ${prestige.shortLabel}`
    : `Level ${levelProgress.level}`;
  const emblemLabel = `Level ${levelProgress.level} — ${prestige.accessibleLabel}`;

  if (gamePointsTotal) gamePointsTotal.textContent = levelProgress.totalPoints.toLocaleString();
  if (gameLevelEmblem) {
    gameLevelEmblem.dataset.prestige = prestige.key;
    gameLevelEmblem.setAttribute('aria-label', emblemLabel);
    gameLevelEmblem.title = emblemLabel;
  }
  if (gameLevelCrown) {
    gameLevelCrown.hidden = !prestige.crown;
    if (prestige.crown) gameLevelCrown.dataset.crown = prestige.crown;
    else delete gameLevelCrown.dataset.crown;
  }
  if (gameLevelNumber) gameLevelNumber.textContent = String(levelProgress.level);
  if (gameLevelLabel) gameLevelLabel.textContent = levelLabel;
  if (gamePrestigeStatus && gamePrestigeStatus.textContent !== prestige.accessibleLabel) {
    gamePrestigeStatus.textContent = prestige.accessibleLabel;
  }
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
const challengeIconClass = (challenge) => {
  const icon = String(challenge?.icon || '').replace(/[^a-z-]/g, '');
  return ['repeat', 'spark', 'dumbbell', 'flame', 'book', 'target', 'shield', 'check'].includes(icon)
    ? `icon-${icon}`
    : 'icon-target';
};
const challengeDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : challengeDateFormatter.format(date);
};
const challengeStatusLabel = (challenge) => {
  const status = ({ locked: 'Locked', available: 'Available', active: 'Active', completed: 'Completed' })[challenge.status] || 'Locked';
  return challenge.accessGranted ? status : `${status} · Access required`;
};
const challengeAccessMessage = (challenge) => {
  if (challenge.accessReason === 'membership_required') return 'An active membership is required for this track.';
  return challenge.accessReason || 'Access is required for this track.';
};
const challengeCard = (challenge) => {
  const pointsRequired = Math.max(0, Number(challenge.pointsRequired) || 0);
  const pointsRemaining = Math.max(0, Number(challenge.pointsRemaining) || 0);
  const duration = challenge.durationDays ? `${Number(challenge.durationDays).toLocaleString()} days` : 'Flexible length';
  const unlocked = challenge.status !== 'locked';
  const unlockedDate = challengeDate(challenge.unlockedAt);
  const startedDate = challengeDate(challenge.startedAt);
  const completedDate = challengeDate(challenge.completedAt);
  let detail = '';
  let action = '';

  if (!challenge.accessGranted) {
    detail = escapeHtml(challengeAccessMessage(challenge));
  } else if (challenge.status === 'locked') {
    detail = `${pointsRemaining.toLocaleString()} ${pointsRemaining === 1 ? 'point' : 'points'} remaining · Unlocks at ${pointsRequired.toLocaleString()}`;
  } else if (challenge.status === 'available') {
    detail = unlockedDate ? `Unlocked ${escapeHtml(unlockedDate)}` : 'Unlocked and ready to start';
    action = `<button class="challenge-start-button" type="button" data-start-challenge="${escapeHtml(challenge.key)}"${challengeActionKey === challenge.key ? ' disabled' : ''}>${challengeActionKey === challenge.key ? 'Starting…' : 'Start track'}</button>`;
  } else if (challenge.status === 'active') {
    detail = startedDate ? `Started ${escapeHtml(startedDate)}` : 'Track in progress';
  } else {
    detail = completedDate ? `Completed ${escapeHtml(completedDate)}` : 'Challenge completed';
  }

  return `<article class="challenge-card is-${escapeHtml(challenge.status)}${challenge.accessGranted ? '' : ' is-inaccessible'}"><div class="challenge-card-topline"><span class="challenge-card-icon app-icon ${challengeIconClass(challenge)}" aria-hidden="true"></span><span class="challenge-card-status">${escapeHtml(challengeStatusLabel(challenge))}</span></div><div class="challenge-card-copy"><p>${escapeHtml(challenge.type || 'Challenge')} · ${escapeHtml(duration)}</p><h3>${escapeHtml(challenge.title)}</h3><p>${escapeHtml(challenge.teaser || '')}</p></div><div class="challenge-card-footer"><small>${detail}</small>${action}</div>${unlocked ? '<span class="challenge-card-unlocked" aria-hidden="true"><span class="app-icon icon-check"></span></span>' : ''}</article>`;
};
function setChallengeVaultExpanded(expanded) {
  const vault = $('challengeVault');
  const toggle = $('challengeVaultToggle');
  const label = $('challengeVaultToggleLabel');
  const details = $('challengeVaultDetails');
  if (!vault || !toggle || !details) return;

  const nextExpanded = Boolean(expanded);
  vault.classList.toggle('is-expanded', nextExpanded);
  toggle.setAttribute('aria-expanded', String(nextExpanded));
  details.setAttribute('aria-hidden', String(!nextExpanded));
  details.toggleAttribute('inert', !nextExpanded);
  if (label) label.textContent = nextExpanded ? 'Hide challenge paths' : 'View challenge paths';
}
function renderChallengeProgression() {
  const catalog = $('challengeCatalog');
  const summary = $('challengeVaultSummary');
  const nextTitle = $('challengeNextTitle');
  const nextPoints = $('challengeNextPoints');
  const progress = $('challengeUnlockProgress');
  const progressFill = $('challengeUnlockProgressFill');
  if (!catalog) return;

  if (challengeProgressionStatus === 'loading') {
    catalog.setAttribute('aria-busy', 'true');
    catalog.innerHTML = '<article class="challenge-catalog-empty">Challenge progression is loading.</article>';
    if (summary) summary.textContent = 'Loading challenges';
    return;
  }

  catalog.setAttribute('aria-busy', 'false');
  if (challengeProgressionStatus === 'error') {
    catalog.innerHTML = `<article class="challenge-catalog-empty"><strong>Challenge tracks are temporarily unavailable.</strong><p>${escapeHtml(challengeProgressionError)}</p><button class="challenge-retry-button" type="button" data-retry-challenges>Try again</button></article>`;
    if (summary) summary.textContent = 'Unable to load';
    return;
  }

  const challenges = challengeProgression.challenges || [];
  const unlockedCount = challenges.filter((challenge) => challenge.status !== 'locked').length;
  const next = challengeProgression.nextUnlock;
  if (summary) summary.textContent = `${unlockedCount} of ${challenges.length} unlocked`;
  if (catalog) catalog.innerHTML = challenges.length
    ? challenges.map(challengeCard).join('')
    : '<article class="challenge-catalog-empty">No challenge tracks are configured yet.</article>';

  if (next) {
    const totalPoints = Math.min(challengeProgression.totalPoints, next.pointsRequired);
    if (nextTitle) nextTitle.textContent = next.title;
    if (nextPoints) nextPoints.textContent = `${next.pointsRemaining.toLocaleString()} points to go · ${challengeProgression.totalPoints.toLocaleString()} of ${next.pointsRequired.toLocaleString()}`;
    if (progress) {
      progress.setAttribute('aria-valuemax', String(next.pointsRequired));
      progress.setAttribute('aria-valuenow', String(totalPoints));
      progress.setAttribute('aria-valuetext', `${totalPoints} of ${next.pointsRequired} points earned toward ${next.title}`);
    }
    if (progressFill) progressFill.style.setProperty('--challenge-progress', `${next.progressPercent}%`);
  } else {
    const inaccessible = challenges.some((challenge) => challenge.status === 'locked' && !challenge.accessGranted);
    if (nextTitle) nextTitle.textContent = inaccessible ? 'Membership access is required.' : 'Every configured challenge is open.';
    if (nextPoints) nextPoints.textContent = inaccessible ? 'Restore access to continue your challenge progression.' : 'Keep building points for the tracks that come next.';
    if (progress) {
      progress.setAttribute('aria-valuemax', '1');
      progress.setAttribute('aria-valuenow', inaccessible ? '0' : '1');
      progress.setAttribute('aria-valuetext', inaccessible ? 'Challenge progression requires membership access' : 'All configured challenges unlocked');
    }
    if (progressFill) progressFill.style.setProperty('--challenge-progress', inaccessible ? '0%' : '100%');
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
  if (rewardToast.hidden || rewardToast.classList.contains('exiting')) return;
  if (rewardToast.hideTimer) {
    window.clearTimeout(rewardToast.hideTimer);
    rewardToast.hideTimer = null;
  }
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
function showChallengeUnlockCelebration(challenges = []) {
  const stage = $('challengeUnlockCelebration');
  const icon = $('challengeUnlockIcon');
  const title = $('challengeUnlockTitle');
  const copy = $('challengeUnlockCopy');
  if (!stage || !challenges.length) return;
  const [first] = challenges;
  const challengeNames = challenges.map((challenge) => challenge.title).filter(Boolean);

  if (icon) icon.className = `badge-medal-icon app-icon ${challengeIconClass(first)}`;
  if (title) title.textContent = challenges.length === 1 ? first.title : `${challenges.length} challenge tracks unlocked`;
  if (copy) copy.textContent = challenges.length === 1
    ? 'Your points opened a new path. It is ready in the Challenge Vault.'
    : `${challengeNames.join(', ')} are now ready in the Challenge Vault.`;
  if (stage.hideTimer) window.clearTimeout(stage.hideTimer);
  if (stage.exitTimer) window.clearTimeout(stage.exitTimer);
  stage.hidden = false;
  stage.classList.remove('active', 'exiting');
  void stage.offsetWidth;
  stage.classList.add('active');
  stage.exitTimer = window.setTimeout(() => stage.classList.add('exiting'), BADGE_REVEAL_DURATION_MS);
  stage.hideTimer = window.setTimeout(() => {
    stage.classList.remove('active', 'exiting');
    stage.hidden = true;
    stage.exitTimer = null;
    stage.hideTimer = null;
  }, BADGE_REVEAL_DURATION_MS + 420);
}
function queueChallengeUnlockCelebration(challenges = [], delay = 0) {
  if (!challenges.length) return;
  window.setTimeout(() => showChallengeUnlockCelebration(challenges), delay);
}
let theme = load('dominion:theme', 'dark');
let startDate = localDemoMode ? load('dominion:startDate', todayKey()) : todayKey();
let entries = load(ENTRY_STORAGE_KEY, []);
let checkInCacheOwner = localDemoMode
  ? `mock:${load('dominion:user', {}).email || 'preview'}`
  : '';
let initialCheckInCache = checkInCacheForOwner(load(checkInDatesStorageKey(), {}), checkInCacheOwner);
let submittedCheckInDates = new Set(initialCheckInCache.dates);
let submittedChallengeDays = new Set(initialCheckInCache.challengeDays);
let feed = localDemoMode ? load('dominion:feed', starterFeed) : starterFeed;
let workoutDifficulty = normalizeWorkoutDifficulty(load(WORKOUT_DIFFICULTY_STORAGE_KEY, DEFAULT_WORKOUT_DIFFICULTY));
let gameStats = localDemoMode ? load('dominion:gameStats', DEFAULT_DEMO_GAME_STATS) : {};
let badges = localDemoMode ? load('dominion:badges', []) : [];
let leaderboardPositions = {
  globalRank: null,
  privateRank: null,
  crewId: null,
  window: LEADERBOARD_PRESTIGE_WINDOW,
};
let leaderboardPrestigeRequestId = 0;
let leaderboardPrestigeTimer = null;
let challengeProgression = { totalPoints: 0, challenges: [], nextUnlock: null, unseenUnlocks: [] };
let challengeProgressionStatus = 'loading';
let challengeProgressionError = '';
let challengeActionKey = '';
let countdownTimer = null;
let activeCountdownCallout = '';
let confettiTimer = null;
let confettiRunId = 0;
let finishCelebrated = false;
let entrySaveQueue = Promise.resolve();
const pendingActionMutations = new Map();
const pendingWorkoutMutations = new Map();
let pendingDetailsNavigation = '';
let checkInSubmissionPending = false;
let checkInSubmissionDate = '';
let lastCheckInSubmissionAt = 0;
let checkInNotice = '';
let checkInNoticeDate = '';
let renderedDateKey = todayKey();
let checkInStatusHydratedDate = hasSupabaseAuth() ? '' : renderedDateKey;
let dashboardHydrationRequestId = 0;
const $ = (id) => document.getElementById(id);
const verseText = $('verseText');
const verseReference = $('verseReference');
const verseAppLink = $('verseAppLink');
async function refreshChallengeProgression({ claimCelebrations = false, celebrationDelay = 0 } = {}) {
  if (!$('challengeCatalog')) return [];
  challengeProgressionStatus = challengeProgression.challenges.length ? 'ready' : 'loading';
  challengeProgressionError = '';
  renderChallengeProgression();
  try {
    if (claimCelebrations) {
      const result = await claimChallengeUnlocks();
      challengeProgression = result.progression;
      challengeProgressionStatus = 'ready';
      renderChallengeProgression();
      queueChallengeUnlockCelebration(result.claimedUnlocks, celebrationDelay);
      return result.claimedUnlocks;
    }
    challengeProgression = await getChallengeProgression();
    challengeProgressionStatus = 'ready';
    renderChallengeProgression();
    return [];
  } catch (error) {
    challengeProgressionStatus = 'error';
    challengeProgressionError = error?.message || 'Please try again in a moment.';
    renderChallengeProgression();
    console.warn('Unable to load challenge progression', error);
    return [];
  }
}
const dayIndex = () => Math.floor(new Date(`${todayKey()}T00:00:00`).getTime() / 86400000);
const pickDaily = (items, offset = 0) => items[(dayIndex() + offset) % items.length];
const todayEntry = () => {
  const entry = entries.find(item => item.date === todayKey()) || {};
  return {
    ...entry,
    date: todayKey(),
    completed: Array.isArray(entry.completed) ? entry.completed : [],
    workoutDifficulty: normalizeWorkoutDifficulty(entry.workoutDifficulty || workoutDifficulty),
    version: Math.max(Number.parseInt(entry.version, 10) || 0, 0),
  };
};
const hasSubmittedCheckIn = (dateKey = todayKey(), challengeDay = currentDay()) => (
  submittedCheckInDates.has(dateKey) || submittedChallengeDays.has(challengeDay)
);
const isCheckInPending = (dateKey = todayKey()) => checkInSubmissionPending && checkInSubmissionDate === dateKey;
const isCheckInStatusReady = (dateKey = todayKey()) => (
  !hasSupabaseAuth() || checkInStatusHydratedDate === dateKey
);
function setCheckInNotice(dateKey, message) {
  checkInNoticeDate = dateKey;
  checkInNotice = message;
}
function replaceSubmittedCheckIns({ dates = [], challengeDays = [] }) {
  const cache = createCheckInCache(checkInCacheOwner, dates, challengeDays);
  submittedCheckInDates = new Set(cache.dates);
  submittedChallengeDays = new Set(cache.challengeDays);
  save(checkInDatesStorageKey(), cache);
}
function markCheckInSubmitted(dateKey, challengeDay) {
  const cached = checkInCacheForOwner(load(checkInDatesStorageKey(), {}), checkInCacheOwner);
  const result = addCheckInDate([...submittedCheckInDates, ...cached.dates], dateKey);
  const challengeDays = normalizeChallengeDays([
    ...submittedChallengeDays,
    ...cached.challengeDays,
    challengeDay,
  ]);
  const alreadySubmitted = !result.added || challengeDays.some((day) => (
    day === challengeDay && (submittedChallengeDays.has(day) || cached.challengeDays.includes(day))
  ));
  replaceSubmittedCheckIns({ dates: result.dates, challengeDays });
  return !alreadySubmitted;
}
const checkInStatusForEntry = (entry) => {
  if (!entry.completed.length) return null;
  return entry.completed.length === standards.length ? 'complete' : 'partial';
};
const replaceEntry = (entry) => {
  const index = entries.findIndex(item => item.date === entry.date);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  save(ENTRY_STORAGE_KEY, entries);
};

const withPendingDraftMutations = (draft) => {
  const completed = new Set(draft.completed);
  pendingActionMutations.forEach((isCompleted, actionId) => {
    if (isCompleted) completed.add(actionId);
    else completed.delete(actionId);
  });
  const nextDifficulty = { ...draft.workoutDifficulty };
  pendingWorkoutMutations.forEach((difficulty, workoutId) => {
    nextDifficulty[workoutId] = difficulty;
  });
  return {
    ...draft,
    completed: [...completed],
    workoutDifficulty: normalizeWorkoutDifficulty(nextDifficulty),
  };
};

async function reconcileDailyStandardDraft(date, fallbackMessage) {
  try {
    const authoritative = await getDailyStandardDraft(date);
    const reconciled = withPendingDraftMutations(authoritative);
    replaceEntry(reconciled);
    workoutDifficulty = normalizeWorkoutDifficulty(reconciled.workoutDifficulty);
    save(WORKOUT_DIFFICULTY_STORAGE_KEY, workoutDifficulty);
    setCheckInNotice(date, fallbackMessage);
    render();
  } catch (error) {
    console.warn('Unable to reconcile Daily Standards draft', error);
    setCheckInNotice(date, 'Unable to sync that change. Refresh and try again.');
    render();
  }
}
const rawChallengeDay = () => previewChallengeMode()
  ? previewChallengeState.day
  : calendarDayDifference(todayKey(), startDate) + 1;
const currentDay = () => Math.min(Math.max(rawChallengeDay(), 1), TOTAL_DAYS);
const hasFinalBadge = () => badges.some((badge) => badge.key === finaleBadgeKey);
const isChallengeFinished = () => previewChallengeMode()
  ? isPreviewChallengeComplete(previewChallengeState)
  : hasFinalBadge() || rawChallengeDay() > TOTAL_DAYS;
function advanceCommittedPreviewPost(entry, submissionDay) {
  const nextState = advancePreviewChallenge(previewChallengeState);
  save(PREVIEW_CHALLENGE_STORAGE_KEY, nextState);
  previewChallengeState = nextState;

  if (isPreviewChallengeComplete(previewChallengeState)) {
    setCheckInNotice(entry.date, 'Day 77 is posted. The preview challenge is complete.');
  } else {
    const nextDate = previewChallengeDate(previewChallengeState);
    setCheckInNotice(nextDate, `Day ${submissionDay} is posted. Day ${previewChallengeDay(previewChallengeState)} is ready.`);
  }

  renderedDateKey = todayKey();
}
function renderChecklist(entry) {
  const checklist = $('checklist');
  if (!checklist) return;

  if (!checklist.dataset.mounted) {
    checklist.innerHTML = scorecardGroups.map((group) => {
      const rows = group.items.map(([id, label, detail]) => {
        const route = dailyStandardRoute(id);
        const difficultyDescriptionId = `${id}DifficultyDescription`;
        const difficultyControl = route?.workoutId
          ? `<label class="check-row-difficulty" for="${id}Difficulty"><span>Difficulty <small id="${difficultyDescriptionId}">Context only · still +1</small></span><select id="${id}Difficulty" name="${id}Difficulty" data-workout="${route.workoutId}" aria-label="${escapeHtml(label)} difficulty" aria-describedby="${difficultyDescriptionId}"><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="extreme">Extreme</option></select></label>`
          : '';
        return `<article class="check-row" id="standard-${id}" data-standard-card="${id}"><button class="check-row-toggle" data-standard="${id}" aria-label="Mark ${escapeHtml(label)} complete, worth 1 point" aria-pressed="false" type="button"><span class="box"><span class="app-icon icon-sm icon-check" aria-hidden="true"></span></span><span class="check-row-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span><span class="action-point-value" aria-label="1 point">+1</span></button><a class="check-row-details" href="${route?.route || './dashboard.html#daily-standards'}" aria-label="Open ${escapeHtml(label)} details">Details<span aria-hidden="true">→</span></a>${difficultyControl}</article>`;
      }).join('');
      const itemLabel = group.items.length === 1 ? 'action' : 'actions';
      return `<section class="checklist-group" aria-labelledby="checklistGroup-${group.key}"><div class="checklist-group-header"><h3 class="checklist-group-title" id="checklistGroup-${group.key}">${escapeHtml(group.label)}</h3><span>${group.items.length} ${itemLabel}</span></div><div class="checklist-group-items">${rows}</div></section>`;
    }).join('');
    checklist.dataset.mounted = 'true';
  }

  const completed = new Set(entry.completed);
  const draftBusy = pendingActionMutations.size > 0 || pendingWorkoutMutations.size > 0;
  const locked = isChallengeFinished()
    || !isCheckInStatusReady(entry.date)
    || hasSubmittedCheckIn(entry.date)
    || isCheckInPending(entry.date)
    || draftBusy;
  checklist.querySelectorAll('[data-standard]').forEach((row) => {
    const isChecked = completed.has(row.dataset.standard);
    const card = row.closest('[data-standard-card]');
    card?.classList.toggle('checked', isChecked);
    card?.classList.toggle('is-locked', locked);
    row.disabled = locked;
    row.setAttribute('aria-pressed', String(isChecked));
    row.setAttribute('aria-label', `Mark ${dailyStandardRoute(row.dataset.standard)?.title || 'action'} ${isChecked ? 'incomplete' : 'complete'}, worth 1 point`);
  });
  checklist.querySelectorAll('.check-row-details').forEach((link) => {
    link.setAttribute('aria-disabled', String(draftBusy));
  });

  const requestedFocus = new URLSearchParams(window.location.search).get('focus');
  const focusTarget = requestedFocus && dailyStandardRoute(requestedFocus)
    ? checklist.querySelector(`[data-standard="${requestedFocus}"]`)
    : null;
  if (focusTarget && !checklist.dataset.focusRestored) {
    checklist.dataset.focusRestored = 'true';
    requestAnimationFrame(() => {
      focusTarget.focus({ preventScroll: true });
      focusTarget.closest('[data-standard-card]')?.scrollIntoView({ block: 'center' });
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    });
  }
}
function renderTodayActionCompletion(entry) {
  const completed = new Set(entry.completed);
  const locked = isChallengeFinished()
    || !isCheckInStatusReady(entry.date)
    || hasSubmittedCheckIn(entry.date)
    || isCheckInPending(entry.date);

  document.querySelectorAll('[data-action-completion]').forEach((button) => {
    if (!button.querySelector('.action-point-value')) {
      const pointValue = document.createElement('span');
      pointValue.className = 'action-point-value';
      pointValue.textContent = '+1';
      pointValue.setAttribute('aria-label', '1 point');
      button.append(pointValue);
    }
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
  if (isChallengeFinished() || !isCheckInStatusReady() || hasSubmittedCheckIn() || isCheckInPending()) return;
  const currentEntry = todayEntry();
  const completed = new Set(currentEntry.completed);
  const nextCompleted = !completed.has(id);
  if (nextCompleted) completed.add(id);
  else completed.delete(id);
  pendingActionMutations.set(id, nextCompleted);
  replaceEntry({ ...currentEntry, completed: [...completed], version: currentEntry.version + 1 });
  render();

  if (!hasSupabaseAuth()) {
    pendingActionMutations.delete(id);
    render();
    return;
  }
  entrySaveQueue = entrySaveQueue
    .then(() => mutateDailyStandardDraft({
      date: currentEntry.date,
      actionId: id,
      completed: nextCompleted,
      expectedVersion: currentEntry.version,
    }))
    .then((authoritative) => {
      if (pendingActionMutations.get(id) === nextCompleted) pendingActionMutations.delete(id);
      const reconciled = withPendingDraftMutations(authoritative);
      replaceEntry(reconciled);
      workoutDifficulty = normalizeWorkoutDifficulty(reconciled.workoutDifficulty);
      save(WORKOUT_DIFFICULTY_STORAGE_KEY, workoutDifficulty);
      if (authoritative.staleWriteReconciled) {
        setCheckInNotice(currentEntry.date, 'Your change was merged with newer activity from another tab.');
      }
      render();
    })
    .catch((error) => {
      if (pendingActionMutations.get(id) === nextCompleted) pendingActionMutations.delete(id);
      console.warn('Unable to sync Daily Standard', error);
      return reconcileDailyStandardDraft(currentEntry.date, error?.message || 'That change could not be saved.');
    });
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
  const currentDateKey = todayKey();
  if (renderedDateKey !== currentDateKey) {
    renderedDateKey = currentDateKey;
    if (hasSupabaseAuth()) checkInStatusHydratedDate = '';
    render();
    if (hasSupabaseAuth()) hydrateDashboardFromApi();
    return;
  }

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
    countdownCallout.textContent = 'You finished the 77-day challenge. Your next path is waiting in the Challenge Vault.';
    activeCountdownCallout = countdownCallout.textContent;
    if (countdownProgressLabel) countdownProgressLabel.textContent = 'Challenge complete';
    if (countdownActionsLabel) countdownActionsLabel.textContent = 'Point-unlocked tracks are ready';
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
  const workoutOneRecommendation = $('workoutOneRecommendation');
  const workoutTwoRecommendation = $('workoutTwoRecommendation');
  const workoutOneLink = $('workoutOneLink');
  const workoutTwoLink = $('workoutTwoLink');
  const workoutOneDifficulty = $('workoutOneDifficulty');
  const workoutTwoDifficulty = $('workoutTwoDifficulty');
  const scorecardLocked = !isCheckInStatusReady()
    || hasSubmittedCheckIn()
    || isChallengeFinished()
    || isCheckInPending()
    || pendingActionMutations.size > 0
    || pendingWorkoutMutations.size > 0;

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
  syncWorkoutDifficultyControls(
    document.querySelectorAll('[data-workout]'),
    workoutDifficulty,
  );
  if (workoutOneDifficulty) workoutOneDifficulty.disabled = scorecardLocked;
  if (workoutTwoDifficulty) workoutTwoDifficulty.disabled = scorecardLocked;

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
  const checkInStatus = $('checkInStatus');
  const countdownCheckInButton = $('countdownCheckInButton');
  const selectAllActionsButton = $('selectAllActionsButton');
  const selectAllActionsLabel = $('selectAllActionsLabel');
  const scorecardSelectionStatus = $('scorecardSelectionStatus');
  const workoutOneDifficulty = $('workoutOneDifficulty');
  const workoutTwoDifficulty = $('workoutTwoDifficulty');
  const checklist = $('checklist');
  const feedEl = $('feed');
  const completedToday = $('completedToday');
  if (dashboardTitle) dashboardTitle.textContent = finished ? COMPLETION_HERO.title : 'Today’s Dominion';
  if (dashboardLead) dashboardLead.textContent = finished ? COMPLETION_HERO.lead : 'Track your standards, post your check-in, and stay honest.';
  if (challengeCompletePanel) challengeCompletePanel.hidden = !finished;
  if (themeToggle) themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
  if (startDateInput) {
    startDateInput.value = previewChallengeMode() ? previewChallengeState.anchorDate : startDate;
    const startDateLocked = previewChallengeMode() || submittedCheckInDates.size > 0 || submittedChallengeDays.size > 0;
    startDateInput.disabled = !isCheckInStatusReady() || startDateLocked;
    startDateInput.title = !isCheckInStatusReady()
      ? 'Confirming the current challenge status.'
      : previewChallengeMode()
        ? 'The preview simulator controls the challenge date.'
      : startDateLocked
        ? 'The challenge start date is locked after the first check-in.'
        : '';
  }
  const entry = todayEntry();
  const completedStandards = new Set(entry.completed);
  const challengePercent = finished ? 100 : Math.round((currentDay() / TOTAL_DAYS) * 100);
  const todayPercent = Math.round((entry.completed.length / standards.length) * 100);
  const hasCompletedActions = entry.completed.length > 0;
  const submittedToday = hasSubmittedCheckIn(entry.date);
  const submissionPendingToday = isCheckInPending(entry.date);
  const checkInStatusReady = isCheckInStatusReady(entry.date);
  const scorecardLocked = !checkInStatusReady || submittedToday || submissionPendingToday;
  const dailyDraftBusy = pendingActionMutations.size > 0 || pendingWorkoutMutations.size > 0;
  const hasPostableCheckIn = !finished && !scorecardLocked && hasCompletedActions;
  const allActionsCompleted = standards.every(([id]) => completedStandards.has(id));
  if (challengePercentEl) challengePercentEl.textContent = `${challengePercent}%`;
  if (challengeDayEl) challengeDayEl.textContent = `Day ${currentDay()} of 77`;
  if (challengeRing) challengeRing.style.setProperty('--value', `${challengePercent}%`);
  if (todayPercentEl) todayPercentEl.textContent = `${todayPercent}%`;
  if (todayCountEl) todayCountEl.textContent = `${entry.completed.length} of ${standards.length} done`;
  if (todayRing) todayRing.style.setProperty('--value', `${todayPercent}%`);
  document.body.classList.toggle('check-in-complete', submittedToday);
  if (checkInButton) {
    checkInButton.disabled = !hasPostableCheckIn || dailyDraftBusy;
    checkInButton.classList.toggle('is-complete', submittedToday);
    checkInButton.textContent = submissionPendingToday
      ? 'Posting...'
      : submittedToday
        ? 'Today’s Check-In Complete'
        : 'Post Check-In';
  }
  if (checkInStatus) {
    const currentNotice = checkInNoticeDate === entry.date ? checkInNotice : '';
    const statusCopy = !checkInStatusReady
      ? currentNotice || 'Confirming today’s check-in status…'
      : submittedToday
      ? currentNotice || 'Today’s check-in is posted. Come back tomorrow for the next challenge day.'
      : currentNotice;
    checkInStatus.textContent = statusCopy;
    checkInStatus.classList.toggle('is-complete', submittedToday);
    checkInStatus.setAttribute('aria-busy', String(submissionPendingToday));
  }
  if (countdownCheckInButton) {
    countdownCheckInButton.disabled = finished || !checkInStatusReady || submittedToday || submissionPendingToday;
    countdownCheckInButton.textContent = submittedToday ? 'Today’s check-in complete' : 'Go to check-in';
  }
  if (workoutOneDifficulty) workoutOneDifficulty.disabled = finished || scorecardLocked;
  if (workoutTwoDifficulty) workoutTwoDifficulty.disabled = finished || scorecardLocked;
  if (selectAllActionsButton) {
    selectAllActionsButton.classList.toggle('active', allActionsCompleted);
    selectAllActionsButton.disabled = finished || scorecardLocked || dailyDraftBusy;
    selectAllActionsButton.setAttribute('aria-pressed', String(allActionsCompleted));
    selectAllActionsButton.setAttribute('aria-label', allActionsCompleted
      ? 'Clear all daily actions'
      : 'Mark all seven daily actions complete');
  }
  const selectAllLabel = allActionsCompleted ? 'Clear all' : 'Mark all complete';
  if (selectAllActionsLabel && selectAllActionsLabel.textContent !== selectAllLabel) {
    selectAllActionsLabel.textContent = selectAllLabel;
  }
  if (scorecardSelectionStatus) {
    const selectionStatus = `${entry.completed.length} of ${standards.length} complete`;
    if (scorecardSelectionStatus.textContent !== selectionStatus) {
      scorecardSelectionStatus.textContent = selectionStatus;
    }
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
  renderChallengeProgression();
  updateCountdownCard();
  if (finished && !finishCelebrated) {
    finishCelebrated = true;
    launchConfetti();
  } else if (!finished) {
    finishCelebrated = false;
    stopEndlessConfetti();
  }
}
function startCountdownCard() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  updateCountdownCard();
  countdownTimer = window.setInterval(updateCountdownCard, 1000);
}
async function hydrateDashboardFromApi() {
  if (!hasSupabaseAuth()) return;
  const requestId = ++dashboardHydrationRequestId;
  const requestStartedAt = new Date();

  try {
    const dashboard = await getDashboard();
    if (requestId !== dashboardHydrationRequestId) return;
    const dashboardOwner = String(dashboard?.profile?.userId || '');
    if (dashboardOwner && dashboardOwner !== checkInCacheOwner) {
      checkInCacheOwner = dashboardOwner;
      const ownerCache = checkInCacheForOwner(load(CHECK_IN_DATES_STORAGE_KEY, {}), checkInCacheOwner);
      submittedCheckInDates = new Set(ownerCache.dates);
      submittedChallengeDays = new Set(ownerCache.challengeDays);
    }
    if (dashboard?.profile?.timeZone) {
      userTimeZone = dashboard.profile.timeZone;
      renderedDateKey = todayKey();
    }
    if (dashboard?.profile?.challengeStartDate) {
      startDate = dashboard.profile.challengeStartDate;
      save('dominion:startDate', startDate);
    }
    if (Array.isArray(dashboard?.entries)) {
      entries = dashboard.entries.map((entry) => (
        entry.date === todayKey() ? withPendingDraftMutations(entry) : entry
      ));
      save(ENTRY_STORAGE_KEY, entries);
      const currentDraft = entries.find((entry) => entry.date === todayKey());
      if (currentDraft?.workoutDifficulty) {
        workoutDifficulty = normalizeWorkoutDifficulty(currentDraft.workoutDifficulty);
        save(WORKOUT_DIFFICULTY_STORAGE_KEY, workoutDifficulty);
      }
    }
    if (Array.isArray(dashboard?.checkIns)) {
      replaceSubmittedCheckIns({
        dates: [...submittedCheckInDates, ...dashboard.checkIns.map((checkIn) => checkIn.date)],
        challengeDays: [
          ...submittedChallengeDays,
          ...dashboard.checkIns.map((checkIn) => checkIn.challengeDay),
        ],
      });
    }
    const hydratedDate = dateKeyForTimeZone(requestStartedAt, userTimeZone);
    if (todayKey() === hydratedDate) checkInStatusHydratedDate = hydratedDate;
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
    if (!isCheckInStatusReady()) hydrateDashboardFromApi();
  } catch (error) {
    if (requestId !== dashboardHydrationRequestId) return;
    console.warn('Unable to load dashboard from Supabase', error);
    if (!isCheckInStatusReady()) {
      setCheckInNotice(todayKey(), 'Unable to confirm today’s check-in status. Refresh to try again.');
      render();
    }
  }
}

async function refreshLeaderboardPrestige({ renderAfter = true } = {}) {
  const requestId = ++leaderboardPrestigeRequestId;
  try {
    const positions = await getLeaderboardPrestige({
      crewId: localStorage.getItem(ACTIVE_CREW_STORAGE_KEY),
      window: LEADERBOARD_PRESTIGE_WINDOW,
    });
    if (requestId !== leaderboardPrestigeRequestId) return null;

    leaderboardPositions = positions;
    if (positions.crewId && localStorage.getItem(ACTIVE_CREW_STORAGE_KEY) !== positions.crewId) {
      localStorage.setItem(ACTIVE_CREW_STORAGE_KEY, positions.crewId);
    }
    if (renderAfter) renderGameSummary();
    return positions;
  } catch (error) {
    if (requestId !== leaderboardPrestigeRequestId) return null;
    console.warn('Unable to refresh leaderboard prestige', error);
    return null;
  }
}

function startLeaderboardPrestigeRefresh() {
  if (leaderboardPrestigeTimer) return;
  const refreshIfVisible = () => {
    if (document.hidden) return;
    refreshLeaderboardPrestige();
    if (hasSupabaseAuth()) hydrateDashboardFromApi();
  };
  leaderboardPrestigeTimer = window.setInterval(refreshIfVisible, LEADERBOARD_PRESTIGE_REFRESH_MS);
  window.addEventListener('focus', refreshIfVisible);
  document.addEventListener('visibilitychange', refreshIfVisible);
}

async function refreshGameSummary(previousBadgeKeys = new Set()) {
  if (!hasSupabaseAuth()) return [];
  const [summary] = await Promise.all([
    getGameSummary(),
    refreshLeaderboardPrestige({ renderAfter: false }),
  ]);
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
  } finally {
    await refreshChallengeProgression({ claimCelebrations: true, celebrationDelay: 450 });
  }
}

const themeToggle = $('themeToggle');
const startDateInput = $('startDate');
const checklist = $('checklist');
const selectAllActionsButton = $('selectAllActionsButton');
const checkInButton = $('checkInButton');
const countdownCheckInButton = $('countdownCheckInButton');
const walkReminderButton = $('walkReminderButton');
const rewardBackdrop = $('rewardBackdrop');
const rewardToast = $('rewardToast');
const challengeCatalog = $('challengeCatalog');
const challengeVaultToggle = $('challengeVaultToggle');
if (challengeVaultToggle) {
  setChallengeVaultExpanded(false);
  challengeVaultToggle.addEventListener('click', () => {
    setChallengeVaultExpanded(challengeVaultToggle.getAttribute('aria-expanded') !== 'true');
  });
}
if (themeToggle) themeToggle.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('dominion:theme', theme); render(); });
if (rewardBackdrop && rewardToast) {
  rewardBackdrop.addEventListener('click', () => dismissRewardToast(rewardToast, rewardBackdrop));
}
if (startDateInput) startDateInput.addEventListener('input', event => {
  if (previewChallengeMode() || !isCheckInStatusReady() || submittedCheckInDates.size > 0 || submittedChallengeDays.size > 0) {
    event.target.value = previewChallengeMode() ? previewChallengeState.anchorDate : startDate;
    return;
  }
  startDate = event.target.value || todayKey();
  if (localDemoMode) save('dominion:startDate', startDate);
  if (hasSupabaseAuth()) {
    updateProfile({ challengeStartDate: startDate }).catch((error) => console.warn('Unable to sync profile', error));
  }
  render();
});
document.addEventListener('change', (event) => {
  const target = event.target.closest?.('[data-workout]');
  if (!target) return;
  if (!isCheckInStatusReady() || hasSubmittedCheckIn() || isCheckInPending()) {
    applyDailyActions();
    return;
  }
  if (target.type === 'radio' && !target.checked) return;
  const currentEntry = todayEntry();
  workoutDifficulty = normalizeWorkoutDifficulty({ ...workoutDifficulty, [target.dataset.workout]: target.value });
  pendingWorkoutMutations.set(target.dataset.workout, target.value);
  save(WORKOUT_DIFFICULTY_STORAGE_KEY, workoutDifficulty);
  replaceEntry({ ...currentEntry, workoutDifficulty, version: currentEntry.version + 1 });
  applyDailyActions();

  if (!hasSupabaseAuth()) {
    pendingWorkoutMutations.delete(target.dataset.workout);
    render();
    return;
  }
  entrySaveQueue = entrySaveQueue
    .then(() => setDailyStandardWorkoutDifficulty({
      date: currentEntry.date,
      workoutId: target.dataset.workout,
      difficulty: target.value,
      expectedVersion: currentEntry.version,
    }))
    .then((authoritative) => {
      if (pendingWorkoutMutations.get(target.dataset.workout) === target.value) pendingWorkoutMutations.delete(target.dataset.workout);
      const reconciled = withPendingDraftMutations(authoritative);
      replaceEntry(reconciled);
      workoutDifficulty = normalizeWorkoutDifficulty(reconciled.workoutDifficulty);
      save(WORKOUT_DIFFICULTY_STORAGE_KEY, workoutDifficulty);
      render();
    })
    .catch((error) => {
      if (pendingWorkoutMutations.get(target.dataset.workout) === target.value) pendingWorkoutMutations.delete(target.dataset.workout);
      console.warn('Unable to sync workout difficulty', error);
      return reconcileDailyStandardDraft(currentEntry.date, error?.message || 'That difficulty could not be saved.');
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
if (checklist) checklist.addEventListener('click', (event) => {
  const link = event.target.closest('.check-row-details');
  if (!link || (pendingActionMutations.size === 0 && pendingWorkoutMutations.size === 0)) return;
  event.preventDefault();
  if (pendingDetailsNavigation) return;
  pendingDetailsNavigation = link.href;
  link.setAttribute('aria-busy', 'true');
  entrySaveQueue.finally(() => {
    window.location.href = pendingDetailsNavigation;
  });
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action-completion]');
  if (button) toggleStandard(button.dataset.actionCompletion);
});
window.addEventListener('storage', (event) => {
  if (event.key === PREVIEW_CHALLENGE_STORAGE_KEY) {
    previewChallengeState = normalizePreviewChallengeState(
      localDemoMode ? load(PREVIEW_CHALLENGE_STORAGE_KEY, {}) : {},
      calendarTodayKey(),
    );
    if (localDemoMode) startDate = load('dominion:startDate', calendarTodayKey());
    const cache = checkInCacheForOwner(load(checkInDatesStorageKey(), {}), checkInCacheOwner);
    submittedCheckInDates = new Set(cache.dates);
    submittedChallengeDays = new Set(cache.challengeDays);
    renderedDateKey = todayKey();
    checkInNotice = '';
    checkInNoticeDate = '';
  } else if (event.key === 'dominion:startDate') startDate = load('dominion:startDate', calendarTodayKey());
  else if (event.key === ENTRY_STORAGE_KEY) {
    entries = load(ENTRY_STORAGE_KEY, []);
    workoutDifficulty = normalizeWorkoutDifficulty(todayEntry().workoutDifficulty);
  }
  else if (event.key === checkInDatesStorageKey()) {
    const cache = checkInCacheForOwner(load(checkInDatesStorageKey(), {}), checkInCacheOwner);
    submittedCheckInDates = new Set(cache.dates);
    submittedChallengeDays = new Set(cache.challengeDays);
    if (hasSubmittedCheckIn()) setCheckInNotice(todayKey(), CHECK_IN_ALREADY_COMPLETE_MESSAGE);
  }
  else if (event.key === WORKOUT_DIFFICULTY_STORAGE_KEY) {
    workoutDifficulty = normalizeWorkoutDifficulty(load(WORKOUT_DIFFICULTY_STORAGE_KEY, DEFAULT_WORKOUT_DIFFICULTY));
  } else if (event.key === 'dominion:feed') {
    feed = localDemoMode ? load('dominion:feed', starterFeed) : starterFeed;
  } else if (event.key === 'dominion:badges') {
    badges = localDemoMode ? load('dominion:badges', []) : [];
  } else if (event.key === 'dominion:gameStats') {
    gameStats = load('dominion:gameStats', DEFAULT_DEMO_GAME_STATS);
    refreshChallengeProgression({ claimCelebrations: true, celebrationDelay: 350 });
    refreshLeaderboardPrestige();
  } else if (event.key === 'dominion:mockChallengeStates' || event.key === 'dominion:mockChallengeThresholdsVersion') {
    refreshChallengeProgression();
  } else if (event.key === ACTIVE_CREW_STORAGE_KEY) {
    refreshLeaderboardPrestige();
    return;
  } else return;
  render();
});
if (challengeCatalog) challengeCatalog.addEventListener('click', async (event) => {
  const retryButton = event.target.closest('[data-retry-challenges]');
  if (retryButton) {
    await refreshChallengeProgression({ claimCelebrations: true });
    return;
  }
  const startButton = event.target.closest('[data-start-challenge]');
  if (!startButton || challengeActionKey) return;
  const feedback = $('challengeCatalogFeedback');
  challengeActionKey = startButton.dataset.startChallenge;
  renderChallengeProgression();
  try {
    challengeProgression = await startChallenge(challengeActionKey);
    challengeProgressionStatus = 'ready';
    const activeChallenge = challengeProgression.challenges.find((challenge) => challenge.key === challengeActionKey);
    if (feedback) feedback.textContent = `${activeChallenge?.title || 'Challenge'} started.`;
  } catch (error) {
    if (feedback) feedback.textContent = error?.message || 'Unable to start that challenge right now.';
    console.warn('Unable to start challenge', error);
  } finally {
    challengeActionKey = '';
    renderChallengeProgression();
  }
});
if (selectAllActionsButton) selectAllActionsButton.addEventListener('click', () => {
  if (isChallengeFinished() || !isCheckInStatusReady() || hasSubmittedCheckIn() || isCheckInPending()) return;
  const currentEntry = todayEntry();
  const completedStandards = new Set(currentEntry.completed);
  const allActionsCompleted = standards.every(([id]) => completedStandards.has(id));
  standards.forEach(([id]) => {
    if (completedStandards.has(id) === allActionsCompleted) toggleStandard(id);
  });
});
if (checkInButton) checkInButton.addEventListener('click', async () => {
  let entry = todayEntry();
  const submissionDay = currentDay();
  const simulatedPreviewPost = previewChallengeMode();
  if (!isCheckInStatusReady(entry.date)) return;
  if (isCheckInPending(entry.date)) return;
  if (hasSubmittedCheckIn(entry.date)) {
    setCheckInNotice(entry.date, CHECK_IN_ALREADY_COMPLETE_MESSAGE);
    render();
    return;
  }
  if (isChallengeFinished()) {
    window.alert('The 77-day challenge is complete. Choose your next path in the Challenge Vault.');
    render();
    return;
  }
  if (entry.completed.length === 0) return;
  const submissionStartedAt = Date.now();
  if (!canStartCheckInSubmission(lastCheckInSubmissionAt, submissionStartedAt, CHECK_IN_SUBMISSION_COOLDOWN_MS)) return;
  lastCheckInSubmissionAt = submissionStartedAt;
  let status = entry.completed.length === standards.length ? 'complete' : 'partial';
  const previousBadgeKeys = new Set(badges.map((badge) => badge.key));
  let feedItem = {
    date: entry.date,
    name: 'You',
    day: submissionDay,
    status,
    completedCount: entry.completed.length,
    pointsAwarded: 0,
    timestamp: 'Today',
  };
  let earnedBadges = [];
  let submissionCommitted = false;

  checkInSubmissionPending = true;
  checkInSubmissionDate = entry.date;
  setCheckInNotice(entry.date, 'Posting today’s check-in…');
  render();

  try {
    if (hasSupabaseAuth()) {
      await entrySaveQueue;
      entry = await getDailyStandardDraft(entry.date);
      replaceEntry(entry);
      workoutDifficulty = normalizeWorkoutDifficulty(entry.workoutDifficulty);
      status = entry.completed.length === standards.length ? 'complete' : 'partial';
      if (!entry.completed.length) throw new Error('Complete at least one action before posting.');
      const postedCheckIn = await postCheckIn({
        date: entry.date,
        day: submissionDay,
        status,
        completedCount: entry.completed.length,
        completed: entry.completed,
        workoutDifficulty,
        timeZone: userTimeZone,
      });
      submissionCommitted = true;
      feedItem = {
        ...postedCheckIn,
        name: 'You',
        timestamp: 'Today',
      };
      markCheckInSubmitted(entry.date, submissionDay);
      setCheckInNotice(entry.date, 'Today’s check-in is posted. Come back tomorrow for the next challenge day.');
      earnedBadges = oneBadgeForDisplay((await refreshGameSummary(previousBadgeKeys))
        .filter((badge) => badgeEarnedDate(badge) === entry.date));
    } else {
      if (!markCheckInSubmitted(entry.date, submissionDay)) throw createCheckInAlreadyCompleteError();
      submissionCommitted = true;
      setCheckInNotice(entry.date, 'Today’s check-in is posted. Come back tomorrow for the next challenge day.');
      let points = calculateLocalPoints(entry, status);
      let nextStreak = gameStats.currentFullDayStreak || 0;
      if (simulatedPreviewPost) {
        gameStats = advancePreviewStreaks(gameStats, status, entry.date);
        nextStreak = gameStats.currentFullDayStreak;
      } else if (status === 'complete') {
        nextStreak += 1;
        gameStats.currentFullDayStreak = nextStreak;
        gameStats.bestFullDayStreak = Math.max(gameStats.bestFullDayStreak || 0, nextStreak);
      }
      gameStats.totalPoints = (gameStats.totalPoints || 0) + points;
      gameStats.challengePoints = (gameStats.challengePoints || 0) + points;
      feedItem.pointsAwarded = points;
      earnedBadges = awardLocalBadges(entry, status, nextStreak, submissionDay);
      if (simulatedPreviewPost) advanceCommittedPreviewPost(entry, submissionDay);
      save('dominion:gameStats', gameStats);
      save('dominion:badges', badges);
      await refreshLeaderboardPrestige({ renderAfter: false });
    }

    feedItem.timestamp = entry.date === todayKey() ? 'Today' : entry.date;
    feed = [feedItem, ...feed].slice(0, 30);
    if (localDemoMode) save('dominion:feed', feed);
    const confettiDuration = status === 'complete' ? launchConfetti() || 0 : 0;
    const toastDuration = showRewardToast({ points: feedItem.pointsAwarded, earnedBadges, status }) || 0;
    const rewardDelay = Math.max(confettiDuration, toastDuration) + 350;
    queueBadgeCelebrations(earnedBadges, rewardDelay);
    const unlockDelay = rewardDelay + (earnedBadges.length ? BADGE_REVEAL_DURATION_MS + 900 : 0);
    await refreshChallengeProgression({
      claimCelebrations: true,
      celebrationDelay: unlockDelay,
    });
  } catch (error) {
    console.warn('Unable to sync check-in', error);
    if (error?.code === CHECK_IN_ALREADY_COMPLETE_CODE) {
      markCheckInSubmitted(entry.date, submissionDay);
      setCheckInNotice(entry.date, error.message || CHECK_IN_ALREADY_COMPLETE_MESSAGE);
      if (hasSupabaseAuth()) await hydrateDashboardFromApi();
    } else if (submissionCommitted) {
      setCheckInNotice(entry.date, 'Today’s check-in is posted. Your rewards are still syncing and will appear after a refresh.');
      if (hasSupabaseAuth()) await hydrateDashboardFromApi();
    } else {
      window.alert(error?.message || 'Unable to post that check-in right now.');
    }
  } finally {
    if (checkInSubmissionDate === entry.date) {
      checkInSubmissionPending = false;
      checkInSubmissionDate = '';
    }
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
  await Promise.all([
    hydrateDashboardFromApi(),
    refreshLeaderboardPrestige({ renderAfter: false }),
  ]);
  render();
  if (hasSupabaseAuth()) await recordDailyAppVisit();
  else await refreshChallengeProgression({ claimCelebrations: true, celebrationDelay: 450 });
  loadVerseOfDay();
  applyDailyActions();
  startCountdownCard();
  startLeaderboardPrestigeRefresh();
  requestAnimationFrame(() => initReveal());
}

bootDashboard().catch((error) => {
  console.warn('Unable to boot dashboard', error);
  render();
  requestAnimationFrame(() => initReveal());
});
