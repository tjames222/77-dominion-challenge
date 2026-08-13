import { initReveal } from './reveal';
import { acquireDialogLayer } from './dialog.mjs';
import {
  claimChallengeUnlocks,
  getBillingState,
  getChallengeActivation,
  getDailyStandardDraft,
  getDashboard,
  getGameSummary,
  getLocalOrSessionUser,
  hasSupabaseAuth,
  isLocalDemoMode,
  mutateDailyStandardDraft,
  postCheckIn,
  recordAppVisit,
  redirectToLogin,
  setDailyStandardWorkoutDifficulty,
  subscribeToAuthStateChanges,
} from './api';
import { DIFFICULTY_OPTIONS, calculateCheckInScore, normalizeWorkoutDifficulty } from './scoring.mjs';
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
  dateKeyForTimeZone,
  migrateMockCheckInCache,
  mockCheckInOwnerForUser,
  normalizeChallengeDays,
} from './check-in.mjs';
import { syncWorkoutDifficultyControls } from './workout-difficulty-controls.mjs';
import { createCelebrationQueue } from './celebration-queue.mjs';
import { createChallengeActivationState } from './challenge-activation.mjs';
import { createChallengeStartFlow } from './challenge-start-flow.js';
import { dashboardActivationGate } from './challenge-start-flow.mjs';
import {
  PREVIEW_USER_STATE_STORAGE_KEY,
  readPreviewUserValue,
  writePreviewUserValue,
} from './preview-user-state.mjs';
import {
  compareBadgesNewestFirst,
  completedTodayLabel,
  normalizeBadgeTier,
  selectLatestAccountabilityPosts,
} from './dashboard-rewards.mjs';
import {
  preserveBestStreaks,
} from './streak-summary.mjs';
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
const countdownCallouts = [
  'Do the next right action before the day gets louder.',
  'Starting is usually the hardest part. Pick one action and begin.',
  'You don’t need a perfect time. Take the next step now.',
  'Complete one action now so you’re not rushing tonight.',
  'Your check-in comes together one action at a time.',
  'Use the time left as a reminder, not a reason to feel guilty.',
  'Keep going while you still have time today.',
  'Start with the action you’re most likely to avoid.',
  'You still have time to complete today’s actions.',
  'Use the next 20 minutes well.',
  'Choose one action and begin.',
  'What you do today helps build tomorrow’s habits.',
];
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
  honest_partial: { key: 'honest_partial', name: 'Honest Check-In', tier: 'bronze', icon: 'check' },
  first_sweat: { key: 'first_sweat', name: 'Easy Workout', tier: 'bronze', icon: 'spark' },
  steady_grind: { key: 'steady_grind', name: 'Medium Workout', tier: 'bronze', icon: 'flame' },
  hard_path: { key: 'hard_path', name: 'Hard Workout', tier: 'silver', icon: 'run' },
  extreme_fire: { key: 'extreme_fire', name: 'Extreme Workout', tier: 'gold', icon: 'flame' },
  iron_standard: { key: 'iron_standard', name: 'Seven for Seven', tier: 'silver', icon: 'dumbbell' },
  seven_day_start: { key: 'seven_day_start', name: 'Seven Days Complete', tier: 'bronze', icon: 'calendar' },
  two_week_guard: { key: 'two_week_guard', name: 'Two Weeks Complete', tier: 'silver', icon: 'shield' },
  three_week_wall: { key: 'three_week_wall', name: 'Three Weeks Complete', tier: 'silver', icon: 'target' },
  third_way: { key: 'third_way', name: 'One-Third Complete', tier: 'gold', icon: 'flag' },
  deep_roots: { key: 'deep_roots', name: 'Day 33', tier: 'silver', icon: 'mountain' },
  halfway_fire: { key: 'halfway_fire', name: 'Halfway', tier: 'gold', icon: 'spark' },
  fifty_faithful: { key: 'fifty_faithful', name: 'Day 50', tier: 'silver', icon: 'star' },
  sixty_strong: { key: 'sixty_strong', name: 'Day 60', tier: 'gold', icon: 'dumbbell' },
  final_watch: { key: 'final_watch', name: 'Final Week', tier: 'gold', icon: 'eye' },
  streak_flame: { key: 'streak_flame', name: '3-Day Perfect Streak', tier: 'silver', icon: 'flame' },
  seven_sealed: { key: 'seven_sealed', name: '7-Day Perfect Streak', tier: 'gold', icon: 'repeat' },
  full_streak_14: { key: 'full_streak_14', name: '14-Day Perfect Streak', tier: 'silver', icon: 'shield' },
  full_streak_21: { key: 'full_streak_21', name: '21-Day Perfect Streak', tier: 'silver', icon: 'target' },
  full_streak_28: { key: 'full_streak_28', name: '28-Day Perfect Streak', tier: 'silver', icon: 'dumbbell' },
  full_streak_35: { key: 'full_streak_35', name: '35-Day Perfect Streak', tier: 'gold', icon: 'flame' },
  full_streak_42: { key: 'full_streak_42', name: '42-Day Perfect Streak', tier: 'gold', icon: 'eye' },
  full_streak_49: { key: 'full_streak_49', name: '49-Day Perfect Streak', tier: 'gold', icon: 'repeat' },
  full_streak_56: { key: 'full_streak_56', name: '56-Day Perfect Streak', tier: 'gold', icon: 'mountain' },
  full_streak_63: { key: 'full_streak_63', name: '63-Day Perfect Streak', tier: 'gold', icon: 'star' },
  full_streak_70: { key: 'full_streak_70', name: '70-Day Perfect Streak', tier: 'gold', icon: 'flag' },
  morning_watch: { key: 'morning_watch', name: '3-Day App Streak', tier: 'bronze', icon: 'eye' },
  watchman_week: { key: 'watchman_week', name: '7-Day App Streak', tier: 'silver', icon: 'eye' },
  day_77_finisher: { key: 'day_77_finisher', name: '77 Days Complete', tier: 'gold', icon: 'crown' },
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
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const workoutDifficultySelection = (value = {}) => ({
  one: DIFFICULTY_OPTIONS.includes(value?.one) ? value.one : '',
  two: DIFFICULTY_OPTIONS.includes(value?.two) ? value.two : '',
});
const localDemoMode = isLocalDemoMode();
let previewChallengeState = normalizePreviewChallengeState({}, calendarTodayKey());
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
  return ['shield', 'check', 'spark', 'flame', 'dumbbell', 'run', 'repeat', 'eye', 'crown', 'calendar', 'target', 'flag', 'mountain', 'star', 'share'].includes(icon) ? `icon-${icon}` : 'icon-shield';
};
const badgeRank = (badge) => badgePriorityRank.get(badge?.key) ?? 999;
const oneBadgeForDisplay = (earnedBadges = []) => earnedBadges
  .filter(Boolean)
  .slice()
  .sort((left, right) => badgeRank(left) - badgeRank(right) || String(right.earnedAt || '').localeCompare(String(left.earnedAt || '')))
  .slice(0, 1);
const badgesForCelebration = (earnedBadges = []) => [...earnedBadges]
  .filter(Boolean)
  .sort((left, right) => badgeRank(left) - badgeRank(right) || compareBadgesNewestFirst(left, right));
const calculateLocalPoints = (entry, status) => {
  return calculateCheckInScore({
    completed: entry.completed,
    status,
    workoutDifficulty,
  }).totalPoints;
};
const badgeEarnedDate = (badge) => badge.entryDate || badge.earnedDate || badge.metadata?.entryDate || String(badge.earnedAt || '').slice(0, 10);
const badgeDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const safeBadgeTier = normalizeBadgeTier;
const badgeEarnedDisplay = (badge) => {
  const earnedDate = badgeEarnedDate(badge);
  if (!earnedDate) return { dateTime: '', label: 'Recently earned' };
  const dateTime = String(earnedDate).slice(0, 10);
  const date = new Date(`${dateTime}T00:00:00`);
  if (Number.isNaN(date.getTime())) return { dateTime: '', label: 'Recently earned' };
  return { dateTime, label: `Earned ${badgeDateFormatter.format(date)}` };
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
const challengeIconClass = (challenge) => {
  const icon = String(challenge?.icon || '').replace(/[^a-z-]/g, '');
  return ['repeat', 'spark', 'dumbbell', 'flame', 'book', 'target', 'shield', 'check'].includes(icon)
    ? `icon-${icon}`
    : 'icon-target';
};
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
function stopCelebrationConfetti() {
  const layer = $('confettiLayer');
  confettiRunId += 1;
  if (confettiTimer) {
    window.clearTimeout(confettiTimer);
    confettiTimer = null;
  }
  layer?.replaceChildren();
  layer?.classList.remove('active', 'endless');
  document.querySelector('.dashboard-shell')?.classList.remove('celebration-shake');
}
function finishRewardToastDismiss(rewardToast, rewardBackdrop) {
  rewardToast.presentationRunId = (rewardToast.presentationRunId || 0) + 1;
  rewardToast.classList.remove('active', 'exiting');
  rewardToast.hidden = true;
  if (rewardBackdrop) {
    rewardBackdrop.classList.remove('active', 'exiting');
    rewardBackdrop.hidden = true;
  }
}
const reducedMotionEnabled = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function focusCelebrationClose(stage) {
  const runId = stage.presentationRunId;
  requestAnimationFrame(() => {
    if (stage.hidden || stage.presentationRunId !== runId) return;
    stage.querySelector('[data-dismiss-celebration]')?.focus({ preventScroll: true });
  });
}
function activateCelebrationModal(layer, panel = layer) {
  return acquireDialogLayer({
    document,
    layer,
    panel,
    onEscape: () => celebrationSequence.dismissCurrent('escape'),
    onReplace: () => celebrationSequence.dismissCurrent('replaced'),
  });
}
function waitForOverlayExit(stage, animationName, fallbackMs, finish) {
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer = null;
    const complete = () => {
      if (settled) return;
      settled = true;
      stage.removeEventListener('animationend', onAnimationEnd);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      finish();
      resolve();
    };
    const onAnimationEnd = (event) => {
      if (event.target === stage && event.animationName === animationName) complete();
    };
    fallbackTimer = window.setTimeout(complete, reducedMotionEnabled() ? 20 : fallbackMs);
    stage.addEventListener('animationend', onAnimationEnd);
  });
}
function dismissRewardToast(rewardToast, rewardBackdrop, reason = 'dismissed') {
  if (!rewardToast || rewardToast.hidden) return Promise.resolve();
  rewardToast.presentationRunId = (rewardToast.presentationRunId || 0) + 1;
  if (reason !== 'auto') stopCelebrationConfetti();
  if (reason === 'replaced' || reason === 'cleared') {
    finishRewardToastDismiss(rewardToast, rewardBackdrop);
    return Promise.resolve();
  }
  rewardToast.classList.remove('active');
  rewardToast.classList.add('exiting');
  rewardBackdrop?.classList.remove('active');
  rewardBackdrop?.classList.add('exiting');
  return waitForOverlayExit(
    rewardToast,
    'reward-toast-dissolve-out',
    REWARD_TOAST_EXIT_MS + 80,
    () => finishRewardToastDismiss(rewardToast, rewardBackdrop),
  );
}
function showRewardToast({ points = 0, earnedBadges = [], status = 'complete' }) {
  const rewardToast = $('rewardToast');
  const rewardBackdrop = $('rewardBackdrop');
  const rewardTitle = $('rewardTitle');
  const rewardCopy = $('rewardCopy');
  const rewardBadges = $('rewardBadges');
  const rewardLayer = $('rewardCelebrationLayer') || rewardToast;
  if (!rewardToast || !rewardTitle || !rewardCopy) return {};
  const displayBadges = oneBadgeForDisplay(earnedBadges);

  if (status === 'visit') rewardTitle.textContent = 'Streak updated.';
  else rewardTitle.textContent = status === 'complete' ? 'Full day complete.' : 'Check-in posted.';
  rewardCopy.textContent = points
    ? `+${points} points added. Keep going.`
    : status === 'visit'
      ? 'You showed up today. Keep the streak alive.'
      : 'Your check-in is posted. Points are being synced.';
  if (rewardBadges) {
    rewardBadges.innerHTML = displayBadges.length
      ? displayBadges.map(badgeChip).join('')
      : '<span class="badge-empty">Badges update as streaks grow.</span>';
  }
  rewardToast.presentationRunId = (rewardToast.presentationRunId || 0) + 1;
  const runId = rewardToast.presentationRunId;
  rewardToast.hidden = false;
  if (rewardBackdrop) rewardBackdrop.hidden = false;
  rewardToast.classList.remove('active', 'exiting');
  rewardBackdrop?.classList.remove('active', 'exiting');
  rewardToast.getAnimations?.().forEach((animation) => animation.cancel());
  rewardBackdrop?.getAnimations?.().forEach((animation) => animation.cancel());
  const modal = activateCelebrationModal(rewardLayer, rewardToast);
  void rewardToast.offsetWidth;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (rewardToast.hidden || rewardToast.presentationRunId !== runId) return;
      rewardBackdrop?.classList.add('active');
      rewardToast.classList.add('active');
    });
  });
  focusCelebrationClose(rewardToast);
  return {
    dismiss: (reason) => dismissRewardToast(rewardToast, rewardBackdrop, reason),
    cleanup: (reason) => {
      if (!rewardToast.hidden) dismissRewardToast(rewardToast, rewardBackdrop, reason === 'cleared' ? 'cleared' : 'replaced');
      modal.release();
    },
  };
}
function showBadgeCelebration(badge) {
  const stage = $('badgeCelebration');
  const icon = $('badgeCelebrationIcon');
  const eyebrow = $('badgeCelebrationEyebrow');
  const title = $('badgeCelebrationTitle');
  const copy = $('badgeCelebrationCopy');
  if (!stage || !badge) return {};
  const isFinale = badge.key === finaleBadgeKey;
  const isSpecial = specialCelebrationBadges.has(badge.key);
  const tier = safeBadgeTier(badge);
  const tierLabel = `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;

  if (title) title.textContent = badge.name || 'Badge Earned';
  if (eyebrow) eyebrow.textContent = `${tierLabel} Badge Earned`;
  if (copy) {
    if (isFinale) copy.textContent = 'You completed all 77 days. Dominion finished strong.';
    else if (isSpecial) copy.textContent = `You reached a milestone and earned a ${tier} badge.`;
    else copy.textContent = `You earned a ${tier} badge. Keep showing up each day.`;
  }
  if (icon) {
    icon.className = `badge-medal-icon app-icon ${badgeIconClass(badge)}`;
  }

  stage.presentationRunId = (stage.presentationRunId || 0) + 1;
  stage.dataset.tier = tier;
  stage.hidden = false;
  stage.classList.remove('active', 'exiting', 'milestone', 'finale');
  stage.classList.toggle('milestone', isSpecial);
  stage.classList.toggle('finale', isFinale);
  const modal = activateCelebrationModal(stage);
  void stage.offsetWidth;
  stage.classList.add('active');
  focusCelebrationClose(stage);
  return {
    dismiss: (reason) => dismissBadgeCelebration(stage, reason),
    cleanup: (reason) => {
      if (!stage.hidden) dismissBadgeCelebration(stage, reason === 'cleared' ? 'cleared' : 'replaced');
      modal.release();
    },
  };
}
function finishBadgeCelebrationDismiss(stage) {
  stage.presentationRunId = (stage.presentationRunId || 0) + 1;
  stage.classList.remove('active', 'exiting', 'milestone', 'finale');
  stage.hidden = true;
  delete stage.dataset.tier;
}
function dismissBadgeCelebration(stage, reason = 'dismissed') {
  if (!stage || stage.hidden) return Promise.resolve();
  stage.presentationRunId = (stage.presentationRunId || 0) + 1;
  if (reason === 'replaced' || reason === 'cleared') {
    finishBadgeCelebrationDismiss(stage);
    return Promise.resolve();
  }
  stage.classList.remove('active');
  stage.classList.add('exiting');
  return waitForOverlayExit(stage, 'badge-stage-out', 420, () => finishBadgeCelebrationDismiss(stage));
}
function showChallengeUnlockCelebration(challenges = []) {
  const stage = $('challengeUnlockCelebration');
  const icon = $('challengeUnlockIcon');
  const title = $('challengeUnlockTitle');
  const copy = $('challengeUnlockCopy');
  if (!stage || !challenges.length) return {};
  const [first] = challenges;
  const challengeNames = challenges.map((challenge) => challenge.title).filter(Boolean);

  if (icon) icon.className = `badge-medal-icon app-icon ${challengeIconClass(first)}`;
  if (title) title.textContent = challenges.length === 1 ? first.title : `${challenges.length} challenge tracks unlocked`;
  if (copy) copy.textContent = challenges.length === 1
    ? 'You earned a new challenge. Find it in Badges & Rewards.'
    : `${challengeNames.join(', ')} are ready in Badges & Rewards.`;
  stage.presentationRunId = (stage.presentationRunId || 0) + 1;
  delete stage.dataset.tier;
  stage.hidden = false;
  stage.classList.remove('active', 'exiting');
  const modal = activateCelebrationModal(stage);
  void stage.offsetWidth;
  stage.classList.add('active');
  focusCelebrationClose(stage);
  return {
    dismiss: (reason) => dismissBadgeCelebration(stage, reason),
    cleanup: (reason) => {
      if (!stage.hidden) dismissBadgeCelebration(stage, reason === 'cleared' ? 'cleared' : 'replaced');
      modal.release();
    },
  };
}
function queueChallengeUnlockCelebration(challenges = [], delay = 0, owner = captureMutationOwner()) {
  if (!challenges.length || !isCurrentMutationOwner(owner)) return;
  const challengeKey = challenges.map((challenge) => challenge.key || challenge.id || challenge.title).sort().join(':');
  const enqueue = () => {
    if (!isCurrentMutationOwner(owner)) return;
    enqueueCelebrationItems({
      id: `challenge:${challengeKey}`,
      kind: 'challenge',
      challenges,
      durationMs: BADGE_REVEAL_DURATION_MS,
    });
  };
  if (delay > 0) window.setTimeout(enqueue, delay);
  else enqueue();
}
let startDate = '';
let challengeActivation = createChallengeActivationState('loading');
let entries = [];
let checkInCacheOwner = '';
let submittedCheckInDates = new Set();
let submittedChallengeDays = new Set();
let feed = [];
let completedTodayCount = 0;
let workoutDifficulty = normalizeWorkoutDifficulty({});
let selectedWorkoutDifficulty = workoutDifficultySelection({});
let gameStats = preserveBestStreaks({}, {});
let badges = [];
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
let checkInStatusHydratedDate = '';
let dashboardHydrationRequestId = 0;
let observedAuthOwner = '';
let hydratedAuthOwner = '';
let authOwnerEpoch = 0;
let celebrationReturnFocus = null;
let challengeStartFlow = null;
const $ = (id) => document.getElementById(id);
const restoreCelebrationFocus = () => {
  const target = celebrationReturnFocus;
  celebrationReturnFocus = null;
  window.setTimeout(() => {
    if (document.body.hasAttribute('data-dialog-open')) return;
    if (
      target?.isConnected
      && target !== document.body
      && target !== document.documentElement
      && !target.matches?.(':disabled, [aria-hidden="true"]')
      && typeof target.focus === 'function'
    ) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    const fallback = $('checkInStatus') || $('dashboardTitle');
    if (fallback) {
      fallback.focus({ preventScroll: true });
    }
  }, 0);
};
const presentCelebrationItem = (item) => {
  if (item.kind === 'reward') return showRewardToast(item.reward);
  if (item.kind === 'badge') return showBadgeCelebration(item.badge);
  if (item.kind === 'challenge') return showChallengeUnlockCelebration(item.challenges);
  return {};
};
const celebrationSequence = createCelebrationQueue({
  present: presentCelebrationItem,
  handoffMs: reducedMotionEnabled() ? 40 : 240,
  onIdle: restoreCelebrationFocus,
});
function enqueueCelebrationItems(items) {
  const candidates = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!candidates.length) return;
  const state = celebrationSequence.state();
  if (!state.active && !state.pending.length && !celebrationReturnFocus) {
    celebrationReturnFocus = document.activeElement;
  }
  celebrationSequence.enqueue(candidates);
}
function queueCheckInCelebrations({ id, points = 0, earnedBadges = [], status = 'complete' }) {
  const items = [{
    id: `reward:${id}`,
    kind: 'reward',
    reward: { points, earnedBadges, status },
    durationMs: status === 'complete' ? DAY_COMPLETE_TOAST_DURATION_MS : REWARD_TOAST_DURATION_MS,
  }];
  badgesForCelebration(earnedBadges).forEach((badge) => {
    items.push({
      id: `badge:${badge.key || badge.name || 'earned'}:${badge.earnedAt || badgeEarnedDate(badge) || 'unknown'}`,
      kind: 'badge',
      badge,
      durationMs: BADGE_REVEAL_DURATION_MS,
    });
  });
  enqueueCelebrationItems(items);
}
async function refreshChallengeProgression({
  claimCelebrations = false,
  celebrationDelay = 0,
  owner = captureMutationOwner(),
} = {}) {
  if (!claimCelebrations) return [];
  if (!owner || !isCurrentMutationOwner(owner)) return [];
  try {
    const result = await claimChallengeUnlocks({ expectedUserId: owner.userId });
    if (!isCurrentMutationOwner(owner)) return [];
    queueChallengeUnlockCelebration(result.claimedUnlocks, celebrationDelay, owner);
    return result.claimedUnlocks;
  } catch (error) {
    console.warn('Unable to claim challenge unlock celebrations', error);
    return [];
  }
}
const dayIndex = () => Math.floor(new Date(`${todayKey()}T00:00:00`).getTime() / 86400000);
const todayEntry = () => {
  const entry = entries.find(item => item.date === todayKey()) || {};
  return {
    ...entry,
    date: todayKey(),
    completed: Array.isArray(entry.completed) ? entry.completed : [],
    workoutDifficulty: normalizeWorkoutDifficulty(entry.workoutDifficulty || workoutDifficulty),
    workoutDifficultySelections: workoutDifficultySelection(
      entry.workoutDifficultySelections || selectedWorkoutDifficulty,
    ),
    version: Math.max(Number.parseInt(entry.version, 10) || 0, 0),
  };
};
const hasSubmittedCheckIn = (dateKey = todayKey(), challengeDay = currentDay()) => (
  submittedCheckInDates.has(dateKey) || submittedChallengeDays.has(challengeDay)
);
const isCheckInPending = (dateKey = todayKey()) => checkInSubmissionPending && checkInSubmissionDate === dateKey;
const hasHydratedAuthOwner = () => Boolean(
  hydratedAuthOwner && observedAuthOwner === hydratedAuthOwner,
);
const captureMutationOwner = () => hasHydratedAuthOwner()
  ? { userId: hydratedAuthOwner, epoch: authOwnerEpoch }
  : null;
const isCurrentMutationOwner = (owner) => Boolean(
  owner
  && owner.epoch === authOwnerEpoch
  && owner.userId === hydratedAuthOwner
  && owner.userId === observedAuthOwner,
);
const isCheckInStatusReady = (dateKey = todayKey()) => (
  hasHydratedAuthOwner() && (!hasSupabaseAuth() || checkInStatusHydratedDate === dateKey)
);
const canParticipateInChallenge = () => previewChallengeMode()
  || challengeActivation.canParticipate === true;
const canMutateChallenge = () => hasHydratedAuthOwner() && (
  previewChallengeMode() || challengeActivation.canMutateDailyStandards === true
);
function readPreviewDashboardUserState(ownerId) {
  const storedPreview = readPreviewUserValue(
    localStorage,
    ownerId,
    PREVIEW_CHALLENGE_STORAGE_KEY,
    {},
  );
  previewChallengeState = normalizePreviewChallengeState(storedPreview, calendarTodayKey());

  const storedEntries = readPreviewUserValue(localStorage, ownerId, ENTRY_STORAGE_KEY, []);
  entries = Array.isArray(storedEntries) ? storedEntries : [];
  const storedDifficulty = readPreviewUserValue(
    localStorage,
    ownerId,
    WORKOUT_DIFFICULTY_STORAGE_KEY,
    {},
  );
  workoutDifficulty = normalizeWorkoutDifficulty(storedDifficulty);
  selectedWorkoutDifficulty = workoutDifficultySelection(storedDifficulty);

  const storedFeed = readPreviewUserValue(localStorage, ownerId, 'dominion:feed', starterFeed);
  feed = Array.isArray(storedFeed) ? storedFeed : [];
  completedTodayCount = feed.filter((item) => item?.status === 'complete' && item?.timestamp === 'Today').length;
  const storedStats = readPreviewUserValue(
    localStorage,
    ownerId,
    'dominion:gameStats',
    DEFAULT_DEMO_GAME_STATS,
  );
  gameStats = preserveBestStreaks(
    storedStats && typeof storedStats === 'object' && !Array.isArray(storedStats)
      ? storedStats
      : DEFAULT_DEMO_GAME_STATS,
    {},
  );
  const storedBadges = readPreviewUserValue(localStorage, ownerId, 'dominion:badges', []);
  badges = Array.isArray(storedBadges) ? storedBadges : [];
}

function persistPreviewDashboardUserState(ownerId = hydratedAuthOwner) {
  if (!localDemoMode || !ownerId || ownerId !== hydratedAuthOwner || ownerId !== observedAuthOwner) return;
  writePreviewUserValue(localStorage, ownerId, PREVIEW_CHALLENGE_STORAGE_KEY, previewChallengeState);
  writePreviewUserValue(localStorage, ownerId, ENTRY_STORAGE_KEY, entries);
  writePreviewUserValue(localStorage, ownerId, WORKOUT_DIFFICULTY_STORAGE_KEY, selectedWorkoutDifficulty);
  writePreviewUserValue(localStorage, ownerId, 'dominion:feed', feed);
  writePreviewUserValue(localStorage, ownerId, 'dominion:gameStats', gameStats);
  writePreviewUserValue(localStorage, ownerId, 'dominion:badges', badges);
}
function setCheckInNotice(dateKey, message) {
  checkInNoticeDate = dateKey;
  checkInNotice = message;
}
function replaceSubmittedCheckIns({ dates = [], challengeDays = [] }) {
  const cache = createCheckInCache(checkInCacheOwner, dates, challengeDays);
  submittedCheckInDates = new Set(cache.dates);
  submittedChallengeDays = new Set(cache.challengeDays);
  if (localDemoMode) {
    writePreviewUserValue(localStorage, hydratedAuthOwner, checkInDatesStorageKey(), cache);
  } else {
    save(checkInDatesStorageKey(), cache);
  }
}
function markCheckInSubmitted(dateKey, challengeDay) {
  const storedCache = localDemoMode
    ? readPreviewUserValue(localStorage, hydratedAuthOwner, checkInDatesStorageKey(), {})
    : load(checkInDatesStorageKey(), {});
  const cached = checkInCacheForOwner(storedCache, checkInCacheOwner);
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
  if (localDemoMode) persistPreviewDashboardUserState();
};

const withPendingDraftMutations = (draft) => {
  const completed = new Set(draft.completed);
  pendingActionMutations.forEach((isCompleted, actionId) => {
    if (isCompleted) completed.add(actionId);
    else completed.delete(actionId);
  });
  const nextDifficulty = { ...draft.workoutDifficulty };
  const nextDifficultySelections = { ...draft.workoutDifficultySelections };
  pendingWorkoutMutations.forEach((difficulty, workoutId) => {
    nextDifficulty[workoutId] = difficulty;
    nextDifficultySelections[workoutId] = difficulty;
  });
  return {
    ...draft,
    completed: [...completed],
    workoutDifficulty: normalizeWorkoutDifficulty(nextDifficulty),
    workoutDifficultySelections: workoutDifficultySelection(nextDifficultySelections),
  };
};

async function reconcileDailyStandardDraft(date, fallbackMessage, owner = captureMutationOwner()) {
  if (!owner) return;
  try {
    const authoritative = await getDailyStandardDraft(date, { expectedUserId: owner.userId });
    if (!isCurrentMutationOwner(owner)) return;
    const reconciled = withPendingDraftMutations(authoritative);
    replaceEntry(reconciled);
    workoutDifficulty = normalizeWorkoutDifficulty(reconciled.workoutDifficulty);
    selectedWorkoutDifficulty = workoutDifficultySelection(reconciled.workoutDifficultySelections);
    persistPreviewDashboardUserState();
    setCheckInNotice(date, fallbackMessage);
    render();
  } catch (error) {
    if (!isCurrentMutationOwner(owner)) return;
    console.warn('Unable to reconcile Daily Actions draft', error);
    setCheckInNotice(date, 'Unable to sync that change. Refresh and try again.');
    render();
  }
}
const rawChallengeDay = () => previewChallengeMode()
  ? previewChallengeState.day
  : Number.isInteger(challengeActivation.challengeDay)
    ? challengeActivation.challengeDay
    : canParticipateInChallenge() && startDate
      ? calendarDayDifference(todayKey(), startDate) + 1
      : 0;
const currentDay = () => canParticipateInChallenge()
  ? Math.min(Math.max(rawChallengeDay(), 1), TOTAL_DAYS)
  : 0;
const hasFinalBadge = () => badges.some((badge) => badge.key === finaleBadgeKey);
const isChallengeFinished = () => previewChallengeMode()
  ? isPreviewChallengeComplete(previewChallengeState)
  : canParticipateInChallenge() && (hasFinalBadge() || rawChallengeDay() > TOTAL_DAYS);
function advanceCommittedPreviewPost(entry, submissionDay) {
  const nextState = advancePreviewChallenge(previewChallengeState);
  previewChallengeState = nextState;
  persistPreviewDashboardUserState();

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
        const difficultyLabelId = `${id}DifficultyLabel`;
        const difficultyControl = route?.workoutId
          ? `<label class="check-row-difficulty" for="${id}Difficulty"><span class="sr-only" id="${difficultyLabelId}">${escapeHtml(label)} difficulty</span><select id="${id}Difficulty" name="${id}Difficulty" data-workout="${route.workoutId}" aria-labelledby="${difficultyLabelId}" disabled><option value="" disabled>Difficulty</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="extreme">Extreme</option></select></label>`
          : '';
        return `<article class="check-row" id="standard-${id}" data-standard-card="${id}"><button class="check-row-toggle" data-standard="${id}" aria-label="Mark ${escapeHtml(label)} complete, worth 1 point" aria-pressed="false" type="button" disabled><span class="box"><span class="app-icon icon-sm icon-check" aria-hidden="true"></span></span><span class="check-row-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span><span class="action-point-value" aria-label="1 point">+1</span></button><a class="check-row-details" data-enabled-href="${route?.route || './dashboard.html#daily-standards'}" aria-label="Open ${escapeHtml(label)} details" aria-disabled="true" aria-describedby="checkInStatus" tabindex="-1">Details<span aria-hidden="true">→</span></a>${difficultyControl}</article>`;
      }).join('');
      const itemLabel = group.items.length === 1 ? 'action' : 'actions';
      return `<section class="checklist-group" aria-labelledby="checklistGroup-${group.key}"><div class="checklist-group-header"><h3 class="checklist-group-title" id="checklistGroup-${group.key}">${escapeHtml(group.label)}</h3><span>${group.items.length} ${itemLabel}</span></div><div class="checklist-group-items">${rows}</div></section>`;
    }).join('');
    checklist.dataset.mounted = 'true';
  }

  const completed = new Set(entry.completed);
  const draftBusy = pendingActionMutations.size > 0 || pendingWorkoutMutations.size > 0;
  const locked = isChallengeFinished()
    || !canMutateChallenge()
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
    const navigationLocked = !canParticipateInChallenge() || draftBusy;
    if (navigationLocked) {
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('aria-describedby', 'checkInStatus');
      link.setAttribute('tabindex', '-1');
    } else {
      link.href = link.dataset.enabledHref;
      link.removeAttribute('aria-disabled');
      link.removeAttribute('aria-describedby');
      link.removeAttribute('tabindex');
    }
  });
  const difficultyControls = checklist.querySelectorAll('[data-workout]');
  syncWorkoutDifficultyControls(
    difficultyControls,
    canParticipateInChallenge() ? selectedWorkoutDifficulty : {},
  );
  difficultyControls.forEach((control) => { control.disabled = locked; });

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
function toggleStandard(id) {
  if (!canMutateChallenge() || isChallengeFinished() || !isCheckInStatusReady() || hasSubmittedCheckIn() || isCheckInPending()) return;
  const owner = captureMutationOwner();
  if (!owner) return;
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
      expectedUserId: owner.userId,
    }))
    .then((authoritative) => {
      if (!isCurrentMutationOwner(owner)) return;
      if (pendingActionMutations.get(id) === nextCompleted) pendingActionMutations.delete(id);
      const reconciled = withPendingDraftMutations(authoritative);
      replaceEntry(reconciled);
      workoutDifficulty = normalizeWorkoutDifficulty(reconciled.workoutDifficulty);
      selectedWorkoutDifficulty = workoutDifficultySelection(reconciled.workoutDifficultySelections);
      persistPreviewDashboardUserState();
      if (authoritative.staleWriteReconciled) {
        setCheckInNotice(currentEntry.date, 'Your change was merged with newer activity from another tab.');
      }
      render();
    })
    .catch((error) => {
      if (!isCurrentMutationOwner(owner)) return;
      if (pendingActionMutations.get(id) === nextCompleted) pendingActionMutations.delete(id);
      console.warn('Unable to sync Daily Action', error);
      return reconcileDailyStandardDraft(
        currentEntry.date,
        error?.message || 'That change could not be saved.',
        owner,
      );
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
    checkInStatusHydratedDate = '';
    render();
    if (hasSupabaseAuth() || localDemoMode) void hydrateDashboardFromApi(observedAuthOwner);
    return;
  }

  const countdownTime = $('countdownTime');
  const countdownProgress = $('countdownProgress');
  const countdownCallout = $('countdownCallout');
  const countdownProgressLabel = $('countdownProgressLabel');
  const countdownActionsLabel = $('countdownActionsLabel');
  if (!countdownTime || !countdownProgress || !countdownCallout) return;

  if (!canParticipateInChallenge()) {
    const scheduled = !previewChallengeMode() && challengeActivation.status === 'scheduled';
    const failed = !previewChallengeMode() && challengeActivation.readState === 'error';
    countdownTime.textContent = scheduled ? 'Scheduled' : failed ? 'Unavailable' : 'Not started';
    countdownProgress.style.setProperty('--progress', '0%');
    countdownCallout.textContent = scheduled
      ? `Daily Actions become available when your challenge begins ${challengeActivation.startDate}.`
      : failed
        ? 'Challenge access stays locked until your activation status can be refreshed.'
        : 'Start your challenge to open today’s seven Daily Actions.';
    activeCountdownCallout = countdownCallout.textContent;
    if (countdownProgressLabel) countdownProgressLabel.textContent = scheduled
      ? 'Challenge start scheduled'
      : 'Challenge participation locked';
    if (countdownActionsLabel) countdownActionsLabel.textContent = '0 of 7 actions available';
    return;
  }

  const entry = todayEntry();
  if (isChallengeFinished()) {
    countdownTime.textContent = '77 days complete';
    countdownProgress.style.setProperty('--progress', '100%');
    countdownCallout.textContent = 'You finished the 77-day challenge. Review your next challenge in Badges & Rewards.';
    activeCountdownCallout = countdownCallout.textContent;
    if (countdownProgressLabel) countdownProgressLabel.textContent = 'Challenge complete';
    if (countdownActionsLabel) countdownActionsLabel.textContent = 'New challenges are ready';
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

function setDashboardActivationStatus(message, { focus = false } = {}) {
  const status = $('dashboardActivationStatus');
  if (!status) return;
  status.textContent = String(message || '');
  if (focus) status.focus({ preventScroll: true });
}

function renderChallengeStartGate() {
  const gate = $('challengeStartGate');
  const title = $('challengeStartGateTitle');
  const description = $('challengeStartGateDescription');
  const startButton = $('startChallengeButton');
  const retryButton = $('retryChallengeActivationButton');
  if (!gate || !title || !description || !startButton || !retryButton) return;

  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const ownerKnown = hasHydratedAuthOwner()
    || Boolean(observedAuthOwner && challengeActivation.readState === 'error');
  const gateState = dashboardActivationGate(challengeActivation, {
    hydrated: ownerKnown,
    online,
  });
  gate.hidden = !gateState.showStartGate;
  startButton.hidden = gateState.showRetry;
  retryButton.hidden = !gateState.showRetry;
  const startDisabled = !gateState.canStart;
  startButton.disabled = startDisabled;
  if (startDisabled && document.activeElement === startButton) startButton.blur();
  retryButton.disabled = !gateState.showRetry || !online;

  if (gateState.showRetry) {
    title.textContent = 'We need to refresh your challenge status.';
    description.textContent = online
      ? 'We couldn’t verify that this challenge is active. Refresh the status to continue.'
      : 'You appear to be offline. Reconnect so Dominion can verify your challenge status.';
    return;
  }

  title.textContent = 'Choose how you want to take the challenge.';
  description.textContent = online
    ? 'Start on your own or with a private group, then choose your start date.'
    : 'Reconnect before starting your challenge.';
}

function render() {
  const finished = isChallengeFinished();
  document.body.classList.toggle('challenge-finished', finished);
  const dashboardTitle = $('dashboardTitle');
  const dashboardLead = $('dashboardLead');
  const challengeCompletePanel = $('challengeCompletePanel');
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
  const checklist = $('checklist');
  const feedEl = $('feed');
  const completedToday = $('completedToday');
  renderChallengeStartGate();
  if (dashboardTitle) dashboardTitle.textContent = finished ? COMPLETION_HERO.title : 'Today’s Dominion';
  if (dashboardLead) dashboardLead.textContent = finished ? COMPLETION_HERO.lead : 'Track today’s actions and post your check-in.';
  if (challengeCompletePanel) challengeCompletePanel.hidden = !finished;
  const participationOpen = canParticipateInChallenge();
  const storedEntry = todayEntry();
  const entry = participationOpen
    ? storedEntry
    : { ...storedEntry, completed: [] };
  const completedStandards = new Set(entry.completed);
  const challengePercent = participationOpen
    ? finished ? 100 : Math.round((currentDay() / TOTAL_DAYS) * 100)
    : 0;
  const todayPercent = Math.round((entry.completed.length / standards.length) * 100);
  const hasCompletedActions = entry.completed.length > 0;
  const submittedToday = participationOpen && hasSubmittedCheckIn(entry.date);
  const submissionPendingToday = participationOpen && isCheckInPending(entry.date);
  const checkInStatusReady = isCheckInStatusReady(entry.date);
  const scorecardLocked = !canMutateChallenge()
    || !checkInStatusReady
    || submittedToday
    || submissionPendingToday;
  const dailyDraftBusy = pendingActionMutations.size > 0 || pendingWorkoutMutations.size > 0;
  const hasPostableCheckIn = !finished && !scorecardLocked && hasCompletedActions;
  const allActionsCompleted = standards.every(([id]) => completedStandards.has(id));
  if (challengePercentEl) challengePercentEl.textContent = challengeActivation.readState === 'loading'
    && !previewChallengeMode() ? '—' : `${challengePercent}%`;
  if (challengeDayEl) challengeDayEl.textContent = canParticipateInChallenge()
    ? `Day ${currentDay()} of 77`
    : challengeActivation.status === 'scheduled'
      ? 'Scheduled'
      : challengeActivation.readState === 'error'
        ? 'Unavailable'
        : challengeActivation.readState === 'loading'
          ? 'Confirming…'
          : 'Not started';
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
    const statusCopy = !previewChallengeMode() && challengeActivation.readState === 'error'
      ? 'Challenge activation could not be confirmed. Refresh to try again.'
      : !previewChallengeMode() && challengeActivation.status === 'not_started'
        ? 'Start your challenge to begin tracking Daily Actions.'
        : !previewChallengeMode() && challengeActivation.status === 'scheduled'
          ? `Your challenge is scheduled to begin ${challengeActivation.startDate}.`
          : !checkInStatusReady
      ? currentNotice || 'Confirming today’s check-in status…'
      : submittedToday
      ? currentNotice || 'Today’s check-in is posted. Come back tomorrow for the next challenge day.'
      : currentNotice;
    checkInStatus.textContent = statusCopy;
    checkInStatus.classList.toggle('is-complete', submittedToday);
    checkInStatus.setAttribute('aria-busy', String(submissionPendingToday));
  }
  if (countdownCheckInButton) {
    countdownCheckInButton.disabled = !canMutateChallenge()
      || finished
      || !checkInStatusReady
      || submittedToday
      || submissionPendingToday;
    countdownCheckInButton.textContent = submittedToday ? 'Today’s check-in complete' : 'Go to check-in';
  }
  if (selectAllActionsButton) {
    selectAllActionsButton.classList.toggle('active', allActionsCompleted);
    selectAllActionsButton.disabled = !canMutateChallenge() || finished || scorecardLocked || dailyDraftBusy;
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
  if (feedEl) {
    feedEl.innerHTML = selectLatestAccountabilityPosts(feed, 3).map((item) => {
      const points = item.pointsAwarded ? ` · +${item.pointsAwarded} pts` : '';
      return `<article class="feed-item"><div><strong>${escapeHtml(item.name)}</strong><p>Day ${item.day} ${statusLabel(item)}${points}</p></div><span class="feed-status"><span class="app-icon icon-sm ${item.status === 'complete' ? 'icon-check' : 'icon-repeat'}" aria-hidden="true"></span></span></article>`;
    }).join('');
  }
  if (completedToday) completedToday.textContent = completedTodayLabel(feed, completedTodayCount);
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

function applyAuthoritativeChallengeActivation(nextActivation) {
  if (!nextActivation?.contractValid || nextActivation.readState !== 'ready') return false;
  challengeActivation = nextActivation;
  userTimeZone = nextActivation.timeZone || BROWSER_TIME_ZONE;
  startDate = nextActivation.startDate || '';
  renderedDateKey = todayKey();
  checkInStatusHydratedDate = hasSupabaseAuth() ? '' : renderedDateKey;
  checkInNotice = '';
  checkInNoticeDate = '';
  render();
  return true;
}

function clearDashboardUserState() {
  previewChallengeState = normalizePreviewChallengeState({}, calendarTodayKey());
  userTimeZone = BROWSER_TIME_ZONE;
  startDate = '';
  challengeActivation = createChallengeActivationState('loading');
  entries = [];
  checkInCacheOwner = '';
  submittedCheckInDates = new Set();
  submittedChallengeDays = new Set();
  feed = [];
  completedTodayCount = 0;
  workoutDifficulty = normalizeWorkoutDifficulty({});
  selectedWorkoutDifficulty = workoutDifficultySelection({});
  gameStats = preserveBestStreaks({}, {});
  badges = [];
  pendingActionMutations.clear();
  pendingWorkoutMutations.clear();
  pendingDetailsNavigation = '';
  checkInSubmissionPending = false;
  checkInSubmissionDate = '';
  lastCheckInSubmissionAt = 0;
  checkInNotice = '';
  checkInNoticeDate = '';
  checkInStatusHydratedDate = '';
  renderedDateKey = calendarTodayKey();
  activeCountdownCallout = '';
  finishCelebrated = false;
  entrySaveQueue = Promise.resolve();
  celebrationSequence.clear({ forgetCompleted: true });
  celebrationReturnFocus = null;
  stopCelebrationConfetti();
  document.querySelectorAll('.check-row-details[aria-busy="true"]')
    .forEach((link) => link.removeAttribute('aria-busy'));
}
function invalidateDashboardOwner(nextOwner = '') {
  challengeStartFlow?.closeForOwnerChange();
  authOwnerEpoch += 1;
  dashboardHydrationRequestId += 1;
  observedAuthOwner = String(nextOwner || '');
  hydratedAuthOwner = '';
  clearDashboardUserState();
  render();
}

async function hydrateDashboardFromApi(expectedOwnerId = observedAuthOwner) {
  if (!hasSupabaseAuth() && !localDemoMode) return;
  const requestId = ++dashboardHydrationRequestId;
  const requestStartedAt = new Date();
  const requestedOwner = String(expectedOwnerId || '');

  try {
    if (localDemoMode) {
      const currentUser = await getLocalOrSessionUser();
      const dashboardOwner = String(currentUser?.userId || '');
      if (!dashboardOwner) throw new Error('You need to log in again.');
      if ((requestedOwner && requestedOwner !== dashboardOwner)
        || (observedAuthOwner && observedAuthOwner !== dashboardOwner)) return;
      const activation = await getChallengeActivation({ expectedUserId: dashboardOwner });
      if (requestId !== dashboardHydrationRequestId
        || (observedAuthOwner && observedAuthOwner !== dashboardOwner)) return;
      observedAuthOwner ||= dashboardOwner;
      hydratedAuthOwner = dashboardOwner;
      challengeActivation = activation;
      userTimeZone = activation.timeZone || BROWSER_TIME_ZONE;
      readPreviewDashboardUserState(dashboardOwner);
      checkInCacheOwner = mockCheckInOwnerForUser(dashboardOwner);
      const storedCache = readPreviewUserValue(
        localStorage,
        dashboardOwner,
        checkInDatesStorageKey(),
        {},
      );
      const ownerCache = migrateMockCheckInCache(storedCache, dashboardOwner, currentUser.email);
      writePreviewUserValue(localStorage, dashboardOwner, checkInDatesStorageKey(), ownerCache);
      submittedCheckInDates = new Set(ownerCache.dates);
      submittedChallengeDays = new Set(ownerCache.challengeDays);
      startDate = activation.startDate || '';
      renderedDateKey = todayKey();
      checkInStatusHydratedDate = renderedDateKey;
      render();
      return;
    }

    const dashboard = await getDashboard();
    if (requestId !== dashboardHydrationRequestId) return;
    const dashboardOwner = String(dashboard?.profile?.userId || '');
    if (!dashboardOwner) throw new Error('Unable to verify the dashboard account.');
    if ((requestedOwner && requestedOwner !== dashboardOwner)
      || (observedAuthOwner && observedAuthOwner !== dashboardOwner)) return;
    observedAuthOwner ||= dashboardOwner;
    hydratedAuthOwner = dashboardOwner;
    if (dashboardOwner !== checkInCacheOwner) {
      checkInCacheOwner = dashboardOwner;
      const ownerCache = checkInCacheForOwner(load(CHECK_IN_DATES_STORAGE_KEY, {}), checkInCacheOwner);
      submittedCheckInDates = new Set(ownerCache.dates);
      submittedChallengeDays = new Set(ownerCache.challengeDays);
    }
    challengeActivation = dashboard?.activation || createChallengeActivationState('error');
    if (challengeActivation.timeZone || dashboard?.profile?.timeZone) {
      userTimeZone = challengeActivation.timeZone || dashboard.profile.timeZone;
      renderedDateKey = todayKey();
    }
    startDate = challengeActivation.startDate || '';
    if (Array.isArray(dashboard?.entries)) {
      entries = dashboard.entries.map((entry) => (
        entry.date === todayKey() ? withPendingDraftMutations(entry) : entry
      ));
      const currentDraft = entries.find((entry) => entry.date === todayKey());
      if (currentDraft?.workoutDifficulty) {
        workoutDifficulty = normalizeWorkoutDifficulty(currentDraft.workoutDifficulty);
        selectedWorkoutDifficulty = workoutDifficultySelection(currentDraft.workoutDifficultySelections);
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
    if (Array.isArray(dashboard?.feed)) {
      feed = dashboard.feed;
    }
    if (Number.isInteger(dashboard?.completedTodayCount) && dashboard.completedTodayCount >= 0) {
      completedTodayCount = dashboard.completedTodayCount;
    }
    if (dashboard?.gameStats) {
      gameStats = preserveBestStreaks(dashboard.gameStats, gameStats);
    }
    if (Array.isArray(dashboard?.badges)) {
      badges = dashboard.badges;
    }
    render();
    if (!isCheckInStatusReady()) void hydrateDashboardFromApi(dashboardOwner);
  } catch (error) {
    if (requestId !== dashboardHydrationRequestId) return;
    console.warn('Unable to load dashboard from Supabase', error);
    hydratedAuthOwner = '';
    clearDashboardUserState();
    challengeActivation = createChallengeActivationState('error');
    if (!isCheckInStatusReady()) {
      setCheckInNotice(todayKey(), 'Unable to confirm today’s check-in status. Refresh to try again.');
    }
    render();
  }
}

async function handleDashboardAuthOwnerChange(nextUser, { force = false } = {}) {
  const nextOwner = String(nextUser?.userId || '');
  if (!force && nextOwner && nextOwner === observedAuthOwner) return;
  invalidateDashboardOwner(nextOwner);
  if (!nextOwner) {
    redirectToLogin();
    return;
  }

  try {
    const billing = await getBillingState();
    if (observedAuthOwner !== nextOwner) return;
    if (!billing.authenticated) {
      redirectToLogin();
      return;
    }
    if (!billing.appAccess) {
      window.location.href = './billing.html?intent=subscription';
      return;
    }
    await hydrateDashboardFromApi(nextOwner);
  } catch (error) {
    if (observedAuthOwner !== nextOwner) return;
    console.warn('Unable to rehydrate the dashboard after an account change', error);
    clearDashboardUserState();
    challengeActivation = createChallengeActivationState('error');
    render();
  }
}

async function refreshGameSummary(previousBadgeKeys = new Set(), owner = captureMutationOwner()) {
  if (!hasSupabaseAuth() || !owner) return [];
  const summary = await getGameSummary();
  if (!isCurrentMutationOwner(owner)) return [];
  gameStats = preserveBestStreaks(summary.gameStats, gameStats);
  badges = summary.badges || [];
  return badges.filter((badge) => !previousBadgeKeys.has(badge.key));
}

function startDashboardForegroundRefresh() {
  const refreshIfVisible = () => {
    if (document.hidden || !hasSupabaseAuth()) return;
    void hydrateDashboardFromApi(observedAuthOwner);
  };
  window.addEventListener('focus', refreshIfVisible);
  document.addEventListener('visibilitychange', refreshIfVisible);
}

async function recordDailyAppVisit() {
  if (!hasSupabaseAuth() || !canParticipateInChallenge()) return;
  const owner = captureMutationOwner();
  if (!owner) return;
  const previousBadgeKeys = new Set(badges.map((badge) => badge.key));
  try {
    const visit = await recordAppVisit({ expectedUserId: owner.userId });
    if (!isCurrentMutationOwner(owner)) return;
    if (visit) {
      gameStats = preserveBestStreaks({
        ...gameStats,
        totalPoints: visit.totalPoints,
        currentAppStreak: visit.currentAppStreak,
        bestAppStreak: visit.bestAppStreak,
      }, gameStats);
    }
    await refreshGameSummary(previousBadgeKeys, owner);
    if (!isCurrentMutationOwner(owner)) return;
    render();
  } catch (error) {
    if (!isCurrentMutationOwner(owner)) return;
    console.warn('Unable to record daily app visit', error);
  } finally {
    if (isCurrentMutationOwner(owner) && canParticipateInChallenge()) {
      await refreshChallengeProgression({ claimCelebrations: true, celebrationDelay: 450 });
    }
  }
}

const checklist = $('checklist');
const selectAllActionsButton = $('selectAllActionsButton');
const checkInButton = $('checkInButton');
const countdownCheckInButton = $('countdownCheckInButton');
const scorecardSection = $('check-in');
const startChallengeButton = $('startChallengeButton');
const retryChallengeActivationButton = $('retryChallengeActivationButton');
const rewardBackdrop = $('rewardBackdrop');
const rewardToast = $('rewardToast');

challengeStartFlow = createChallengeStartFlow({
  captureOwner: captureMutationOwner,
  isCurrentOwner: isCurrentMutationOwner,
  getActivationState: () => challengeActivation,
  onActivation: async (activation, owner) => {
    if (!isCurrentMutationOwner(owner)) return;
    applyAuthoritativeChallengeActivation(activation);
    const EventConstructor = window.CustomEvent;
    if (typeof EventConstructor === 'function') {
      window.dispatchEvent(new EventConstructor('dominion:challenge-activation-updated', {
        detail: { activation },
      }));
    }
    await hydrateDashboardFromApi(owner.userId);
  },
  onStatus: setDashboardActivationStatus,
});

startChallengeButton?.addEventListener('click', () => {
  challengeStartFlow?.open(startChallengeButton);
});

retryChallengeActivationButton?.addEventListener('click', async () => {
  const retryOwner = String(observedAuthOwner || '');
  if (!retryOwner || retryChallengeActivationButton.disabled) return;
  retryChallengeActivationButton.disabled = true;
  setDashboardActivationStatus('Refreshing challenge activation…');
  await hydrateDashboardFromApi(retryOwner);
  if (observedAuthOwner !== retryOwner) return;
  setDashboardActivationStatus(
    challengeActivation.readState === 'ready'
      ? 'Challenge activation refreshed.'
      : 'Challenge activation is still unavailable. Try again when your connection is stable.',
  );
  render();
});

window.addEventListener('offline', () => {
  challengeStartFlow?.setOnline(false);
  setDashboardActivationStatus('You are offline. Challenge participation remains locked.');
  render();
});
window.addEventListener('online', () => {
  challengeStartFlow?.setOnline(true);
  setDashboardActivationStatus('Connection restored. Refreshing challenge activation…');
  render();
  if (observedAuthOwner) void hydrateDashboardFromApi(observedAuthOwner);
});

if (rewardBackdrop && rewardToast) {
  rewardBackdrop.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    celebrationSequence.dismissCurrent('backdrop');
  });
}
document.querySelectorAll('.badge-celebration').forEach((stage) => {
  stage.addEventListener('click', (event) => {
    if (event.target.closest('.badge-medal')) return;
    event.preventDefault();
    event.stopPropagation();
    celebrationSequence.dismissCurrent('backdrop');
  });
});
document.querySelectorAll('[data-dismiss-celebration]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    celebrationSequence.dismissCurrent('close');
  });
});
document.addEventListener('change', (event) => {
  const target = event.target.closest?.('[data-workout]');
  if (!target) return;
  if (!DIFFICULTY_OPTIONS.includes(target.value)) {
    render();
    return;
  }
  if (!canMutateChallenge() || !isCheckInStatusReady() || hasSubmittedCheckIn() || isCheckInPending()) {
    render();
    return;
  }
  const owner = captureMutationOwner();
  if (!owner) return;
  const currentEntry = todayEntry();
  workoutDifficulty = normalizeWorkoutDifficulty({ ...workoutDifficulty, [target.dataset.workout]: target.value });
  selectedWorkoutDifficulty = { ...selectedWorkoutDifficulty, [target.dataset.workout]: target.value };
  pendingWorkoutMutations.set(target.dataset.workout, target.value);
  if (localDemoMode) persistPreviewDashboardUserState();
  replaceEntry({
    ...currentEntry,
    workoutDifficulty,
    workoutDifficultySelections: selectedWorkoutDifficulty,
    version: currentEntry.version + 1,
  });
  render();

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
      expectedUserId: owner.userId,
    }))
    .then((authoritative) => {
      if (!isCurrentMutationOwner(owner)) return;
      if (pendingWorkoutMutations.get(target.dataset.workout) === target.value) pendingWorkoutMutations.delete(target.dataset.workout);
      const reconciled = withPendingDraftMutations(authoritative);
      replaceEntry(reconciled);
      workoutDifficulty = normalizeWorkoutDifficulty(reconciled.workoutDifficulty);
      selectedWorkoutDifficulty = workoutDifficultySelection(reconciled.workoutDifficultySelections);
      if (localDemoMode) persistPreviewDashboardUserState();
      render();
    })
    .catch((error) => {
      if (!isCurrentMutationOwner(owner)) return;
      if (pendingWorkoutMutations.get(target.dataset.workout) === target.value) pendingWorkoutMutations.delete(target.dataset.workout);
      console.warn('Unable to sync workout difficulty', error);
      return reconcileDailyStandardDraft(
        currentEntry.date,
        error?.message || 'That difficulty could not be saved.',
        owner,
      );
    });
});
if (checklist) checklist.addEventListener('click', event => {
  const row = event.target.closest('[data-standard]');
  if (!row) return;
  toggleStandard(row.dataset.standard);
});
function handleDashboardDetailsNavigation(event) {
  const link = event.target.closest('.check-row-details');
  if (!link) return;
  if (!canParticipateInChallenge() || !link.hasAttribute('href')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    return;
  }
  if (pendingActionMutations.size === 0 && pendingWorkoutMutations.size === 0) return;
  event.preventDefault();
  if (pendingDetailsNavigation) return;
  const navigationOwner = captureMutationOwner();
  if (!navigationOwner) return;
  const requestedDestination = link.href;
  pendingDetailsNavigation = requestedDestination;
  link.setAttribute('aria-busy', 'true');
  entrySaveQueue.finally(() => {
    if (!isCurrentMutationOwner(navigationOwner)
      || pendingDetailsNavigation !== requestedDestination) return;
    pendingDetailsNavigation = '';
    window.location.href = requestedDestination;
  });
}
if (checklist) checklist.addEventListener('click', handleDashboardDetailsNavigation);
if (checklist) checklist.addEventListener('auxclick', handleDashboardDetailsNavigation);
window.addEventListener('storage', (event) => {
  if (event.key === 'dominion:user' && localDemoMode) {
    invalidateDashboardOwner('');
    void getLocalOrSessionUser()
      .then((user) => handleDashboardAuthOwnerChange(user, { force: true }))
      .catch((error) => {
        console.warn('Unable to resolve the updated preview account', error);
        redirectToLogin();
      });
    return;
  }
  if (localDemoMode && event.key === checkInDatesStorageKey()) {
    const storedCache = readPreviewUserValue(
      localStorage,
      hydratedAuthOwner,
      checkInDatesStorageKey(),
      {},
    );
    const cache = checkInCacheForOwner(storedCache, checkInCacheOwner);
    submittedCheckInDates = new Set(cache.dates);
    submittedChallengeDays = new Set(cache.challengeDays);
    if (hasSubmittedCheckIn()) setCheckInNotice(todayKey(), CHECK_IN_ALREADY_COMPLETE_MESSAGE);
    render();
    return;
  }
  if (localDemoMode && [
    PREVIEW_USER_STATE_STORAGE_KEY,
    PREVIEW_CHALLENGE_STORAGE_KEY,
    ENTRY_STORAGE_KEY,
    WORKOUT_DIFFICULTY_STORAGE_KEY,
    'dominion:startDate',
    'dominion:feed',
    'dominion:gameStats',
    'dominion:badges',
    'dominion:mockChallengeActivation',
    'dominion:mockChallengeStates',
    'dominion:mockChallengeThresholdsVersion',
  ].includes(event.key)) {
    void hydrateDashboardFromApi(observedAuthOwner);
    return;
  } else return;
});
window.addEventListener('dominion:challenge-start-date-updated', (event) => {
  const nextActivation = event.detail?.activation;
  if (nextActivation?.contractValid && nextActivation.readState === 'ready') {
    challengeActivation = nextActivation;
    userTimeZone = nextActivation.timeZone || BROWSER_TIME_ZONE;
    startDate = nextActivation.startDate || '';
    renderedDateKey = todayKey();
    checkInStatusHydratedDate = hasSupabaseAuth() ? '' : renderedDateKey;
    checkInNotice = '';
    checkInNoticeDate = '';
  } else {
    challengeActivation = createChallengeActivationState('loading');
    startDate = '';
  }
  render();
  if (hasSupabaseAuth() || localDemoMode) void hydrateDashboardFromApi();
});
if (selectAllActionsButton) selectAllActionsButton.addEventListener('click', () => {
  if (!canMutateChallenge() || isChallengeFinished() || !isCheckInStatusReady() || hasSubmittedCheckIn() || isCheckInPending()) return;
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
  if (!canMutateChallenge() || !isCheckInStatusReady(entry.date)) return;
  const submissionOwner = captureMutationOwner();
  if (!submissionOwner) return;
  if (isCheckInPending(entry.date)) return;
  if (hasSubmittedCheckIn(entry.date)) {
    setCheckInNotice(entry.date, CHECK_IN_ALREADY_COMPLETE_MESSAGE);
    render();
    return;
  }
  if (isChallengeFinished()) {
    window.alert('The 77-day challenge is complete. Choose your next challenge in Badges & Rewards.');
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
    id: `local:${entry.date}:${submissionStartedAt}`,
    date: entry.date,
    name: 'You',
    day: submissionDay,
    status,
    completedCount: entry.completed.length,
    pointsAwarded: 0,
    timestamp: 'Today',
    createdAt: new Date(submissionStartedAt).toISOString(),
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
      if (!isCurrentMutationOwner(submissionOwner)) return;
      entry = await getDailyStandardDraft(entry.date, {
        expectedUserId: submissionOwner.userId,
      });
      if (!isCurrentMutationOwner(submissionOwner)) return;
      replaceEntry(entry);
      workoutDifficulty = normalizeWorkoutDifficulty(entry.workoutDifficulty);
      status = entry.completed.length === standards.length ? 'complete' : 'partial';
      if (!entry.completed.length) throw new Error('Complete at least one action before posting.');
      const postedCheckIn = await postCheckIn(
        {
          date: entry.date,
          day: submissionDay,
          status,
          completedCount: entry.completed.length,
          completed: entry.completed,
          workoutDifficulty,
          timeZone: userTimeZone,
        },
        { expectedUserId: submissionOwner.userId },
      );
      if (!isCurrentMutationOwner(submissionOwner)) return;
      submissionCommitted = true;
      feedItem = {
        ...postedCheckIn,
        name: 'You',
        timestamp: 'Today',
      };
      markCheckInSubmitted(entry.date, submissionDay);
      setCheckInNotice(entry.date, 'Today’s check-in is posted. Come back tomorrow for the next challenge day.');
      earnedBadges = (await refreshGameSummary(previousBadgeKeys, submissionOwner))
        .filter((badge) => badgeEarnedDate(badge) === entry.date);
    } else {
      if (!markCheckInSubmitted(entry.date, submissionDay)) throw createCheckInAlreadyCompleteError();
      submissionCommitted = true;
      setCheckInNotice(entry.date, 'Today’s check-in is posted. Come back tomorrow for the next challenge day.');
      let points = calculateLocalPoints(entry, status);
      let nextStreak = gameStats.currentFullDayStreak || 0;
      if (simulatedPreviewPost) {
        gameStats = preserveBestStreaks(advancePreviewStreaks(gameStats, status, entry.date), gameStats);
        nextStreak = gameStats.currentFullDayStreak;
      } else if (status === 'complete') {
        nextStreak += 1;
        gameStats.currentFullDayStreak = nextStreak;
        gameStats.bestFullDayStreak = Math.max(gameStats.bestFullDayStreak || 0, nextStreak);
      }
      gameStats.totalPoints = (gameStats.totalPoints || 0) + points;
      gameStats.challengePoints = (gameStats.challengePoints || 0) + points;
      gameStats.dailyStandardsPoints = (gameStats.dailyStandardsPoints || 0) + points;
      feedItem.pointsAwarded = points;
      earnedBadges = awardLocalBadges(entry, status, nextStreak, submissionDay);
      if (simulatedPreviewPost) advanceCommittedPreviewPost(entry, submissionDay);
    }

    if (!isCurrentMutationOwner(submissionOwner)) return;

    feedItem.timestamp = entry.date === todayKey() ? 'Today' : entry.date;
    feed = [feedItem, ...feed];
    if (status === 'complete' && feedItem.timestamp === 'Today' && Number.isInteger(completedTodayCount)) {
      completedTodayCount += 1;
    }
    if (localDemoMode) persistPreviewDashboardUserState();
    if (status === 'complete') launchConfetti();
    queueCheckInCelebrations({
      id: entry.date,
      points: feedItem.pointsAwarded,
      earnedBadges,
      status,
    });
    await refreshChallengeProgression({
      claimCelebrations: true,
      celebrationDelay: 0,
    });
  } catch (error) {
    if (!isCurrentMutationOwner(submissionOwner)) return;
    console.warn('Unable to sync check-in', error);
    if (error?.code === CHECK_IN_ALREADY_COMPLETE_CODE) {
      markCheckInSubmitted(entry.date, submissionDay);
      setCheckInNotice(entry.date, error.message || CHECK_IN_ALREADY_COMPLETE_MESSAGE);
      if (hasSupabaseAuth()) await hydrateDashboardFromApi(submissionOwner.userId);
    } else if (submissionCommitted) {
      setCheckInNotice(entry.date, 'Today’s check-in is posted. Your rewards are still syncing and will appear after a refresh.');
      if (hasSupabaseAuth()) await hydrateDashboardFromApi(submissionOwner.userId);
    } else {
      window.alert(error?.message || 'Unable to post that check-in right now.');
    }
  } finally {
    if (isCurrentMutationOwner(submissionOwner) && checkInSubmissionDate === entry.date) {
      checkInSubmissionPending = false;
      checkInSubmissionDate = '';
    }
    if (isCurrentMutationOwner(submissionOwner)) render();
  }
});
if (countdownCheckInButton && scorecardSection) countdownCheckInButton.addEventListener('click', () => {
  if (!canParticipateInChallenge() || !canMutateChallenge()) return;
  scorecardSection.scrollIntoView({ behavior: reducedMotionEnabled() ? 'auto' : 'smooth', block: 'start' });
  scorecardSection.focus({ preventScroll: true });
});

async function bootDashboard() {
  invalidateDashboardOwner('');
  if (!hasSupabaseAuth() && !localDemoMode) {
    redirectToLogin();
    return;
  }

  if (hasSupabaseAuth() || localDemoMode) {
    const currentUser = await getLocalOrSessionUser();
    if (!currentUser?.userId) {
      redirectToLogin();
      return;
    }
    invalidateDashboardOwner(currentUser.userId);
    const unsubscribeAuth = subscribeToAuthStateChanges(({ user }) => {
      void handleDashboardAuthOwnerChange(user);
    });
    window.addEventListener('pagehide', unsubscribeAuth, { once: true });

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
  await hydrateDashboardFromApi(observedAuthOwner);
  render();
  if (hasSupabaseAuth()) await recordDailyAppVisit();
  else if (canParticipateInChallenge()) {
    await refreshChallengeProgression({ claimCelebrations: true, celebrationDelay: 450 });
  }
  startCountdownCard();
  startDashboardForegroundRefresh();
  requestAnimationFrame(() => initReveal());
}

bootDashboard().catch((error) => {
  console.warn('Unable to boot dashboard', error);
  hydratedAuthOwner = '';
  clearDashboardUserState();
  challengeActivation = createChallengeActivationState('error');
  render();
  requestAnimationFrame(() => initReveal());
});
