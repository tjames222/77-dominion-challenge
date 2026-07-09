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
const CONFETTI_DURATION_MS = 8600;
const REDUCED_CONFETTI_DURATION_MS = 2400;
const REWARD_TOAST_DURATION_MS = 5200;
const BADGE_REVEAL_DURATION_MS = 5600;
const demoBadgeDefinitions = {
  faithful_start: { key: 'faithful_start', name: 'Faithful Start', tier: 'bronze', icon: 'shield' },
  honest_partial: { key: 'honest_partial', name: 'Honest Standard', tier: 'bronze', icon: 'check' },
  first_sweat: { key: 'first_sweat', name: 'First Sweat', tier: 'bronze', icon: 'spark' },
  steady_grind: { key: 'steady_grind', name: 'Steady Grind', tier: 'bronze', icon: 'flame' },
  iron_standard: { key: 'iron_standard', name: 'Iron Standard', tier: 'silver', icon: 'dumbbell' },
  hard_path: { key: 'hard_path', name: 'Hard Path', tier: 'silver', icon: 'run' },
  extreme_fire: { key: 'extreme_fire', name: 'Extreme Fire', tier: 'gold', icon: 'flame' },
};
const todayKey = () => new Date().toISOString().slice(0, 10);
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
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
const badgeChip = (badge) => `<span class="badge-chip ${badge.tier || 'bronze'}"><span>${escapeHtml(badge.name || 'Badge')}</span></span>`;
const badgeIconClass = (badge) => {
  const icon = String(badge?.icon || '').replace(/[^a-z-]/g, '');
  return ['shield', 'check', 'spark', 'flame', 'dumbbell', 'run'].includes(icon) ? `icon-${icon}` : 'icon-shield';
};
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
function awardLocalBadges(entry, status) {
  const earned = [];
  const existing = new Set(badges.map((badge) => badge.key));
  const maybeAward = (key) => {
    if (existing.has(key) || !demoBadgeDefinitions[key]) return;
    const badge = { ...demoBadgeDefinitions[key], earnedAt: new Date().toISOString() };
    badges.unshift(badge);
    earned.push(badge);
    existing.add(key);
  };

  maybeAward('faithful_start');
  if (status === 'partial') maybeAward('honest_partial');
  if (status === 'complete') maybeAward('iron_standard');
  if ((entry.completed || []).includes('workoutOne') && workoutDifficulty.one === 'easy') maybeAward('first_sweat');
  if ((entry.completed || []).includes('workoutTwo') && workoutDifficulty.two === 'easy') maybeAward('first_sweat');
  if ((entry.completed || []).includes('workoutOne') && workoutDifficulty.one === 'medium') maybeAward('steady_grind');
  if ((entry.completed || []).includes('workoutTwo') && workoutDifficulty.two === 'medium') maybeAward('steady_grind');
  if ((entry.completed || []).includes('workoutOne') && workoutDifficulty.one === 'hard') maybeAward('hard_path');
  if ((entry.completed || []).includes('workoutTwo') && workoutDifficulty.two === 'hard') maybeAward('hard_path');
  if ((entry.completed || []).includes('workoutOne') && workoutDifficulty.one === 'extreme') maybeAward('extreme_fire');
  if ((entry.completed || []).includes('workoutTwo') && workoutDifficulty.two === 'extreme') maybeAward('extreme_fire');

  if (localDemoMode) save('dominion:badges', badges);
  return earned;
}
function renderGameSummary() {
  const gamePointsTotal = $('gamePointsTotal');
  const gameStreakSummary = $('gameStreakSummary');
  const appStreakCount = $('appStreakCount');
  const fullDayStreakCount = $('fullDayStreakCount');
  const badgeShelf = $('badgeShelf');
  const totalPoints = gameStats.totalPoints || gameStats.challengePoints || 0;
  const appStreak = gameStats.currentAppStreak || 0;
  const fullDayStreak = gameStats.currentFullDayStreak || 0;

  if (gamePointsTotal) gamePointsTotal.textContent = `${totalPoints.toLocaleString()} points`;
  if (gameStreakSummary) {
    gameStreakSummary.textContent = `${appStreak} day app streak · ${fullDayStreak} full-standard day streak`;
  }
  if (appStreakCount) appStreakCount.textContent = String(appStreak);
  if (fullDayStreakCount) fullDayStreakCount.textContent = String(fullDayStreak);
  if (badgeShelf) {
    badgeShelf.innerHTML = badges.length
      ? badges.slice(0, 6).map(badgeChip).join('')
      : '<span class="badge-empty">Badges unlock as you check in.</span>';
  }
}
function launchConfetti() {
  const layer = $('confettiLayer');
  if (!layer) return;
  if (layer.parentElement !== document.body) document.body.appendChild(layer);
  const shell = document.querySelector('.dashboard-shell');
  const colors = ['#d6ad54', '#f0c96a', '#5fa36f', '#f8f5ef', '#5fa36f', '#2c2a27'];
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const totalPieces = reduceMotion ? 80 : 360;
  const celebrationMs = reduceMotion ? REDUCED_CONFETTI_DURATION_MS : CONFETTI_DURATION_MS;

  layer.innerHTML = '';
  if (!reduceMotion) {
    shell?.classList.remove('celebration-shake');
    void shell?.offsetWidth;
    shell?.classList.add('celebration-shake');
  }

  if (!reduceMotion && 'vibrate' in navigator) {
    navigator.vibrate([45, 35, 70, 45, 35, 30, 90]);
  }

  for (let index = 0; index < totalPieces; index += 1) {
    const piece = document.createElement('span');
    const burst = Math.floor(index / (totalPieces / 4));
    const shape = index % 5 === 0 ? 'round' : index % 3 === 0 ? 'ribbon' : '';
    const baseWidth = 5 + Math.random() * 8;
    const width = shape === 'ribbon' ? baseWidth * 0.72 : shape === 'round' ? baseWidth * 1.1 : baseWidth;
    const height = shape === 'round' ? width : baseWidth * (shape === 'ribbon' ? 2.2 : 1.4 + Math.random() * 1.4);
    const duration = 5400 + Math.random() * 3200;
    const dx = (Math.random() - 0.5) * 420;
    const spin = Math.random() * 1440 - 720;

    piece.style.setProperty('--x', `${-4 + Math.random() * 108}vw`);
    piece.style.setProperty('--dx', `${dx}px`);
    piece.style.setProperty('--dx-mid', `${dx * 0.45}px`);
    piece.style.setProperty('--dx-late', `${dx * 0.82}px`);
    piece.style.setProperty('--delay', `${burst * 950 + Math.random() * 900}ms`);
    piece.style.setProperty('--duration', `${duration}ms`);
    piece.style.setProperty('--spin', `${spin}deg`);
    piece.style.setProperty('--spin-early', `${spin * 0.12}deg`);
    piece.style.setProperty('--spin-mid', `${spin * 0.55}deg`);
    piece.style.setProperty('--spin-late', `${spin * 0.82}deg`);
    piece.style.setProperty('--w', `${width}px`);
    piece.style.setProperty('--h', `${height}px`);
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 110}px`);
    piece.style.background = colors[index % colors.length];
    piece.style.color = colors[index % colors.length];
    piece.className = shape;
    layer.appendChild(piece);
  }
  window.setTimeout(() => {
    layer.innerHTML = '';
    shell?.classList.remove('celebration-shake');
  }, celebrationMs);
  return celebrationMs;
}
function showRewardToast({ points = 0, earnedBadges = [], status = 'complete' }) {
  const rewardToast = $('rewardToast');
  const rewardTitle = $('rewardTitle');
  const rewardCopy = $('rewardCopy');
  const rewardBadges = $('rewardBadges');
  if (!rewardToast || !rewardTitle || !rewardCopy) return;

  if (status === 'visit') rewardTitle.textContent = 'Streak updated.';
  else rewardTitle.textContent = status === 'complete' ? 'Full day complete.' : 'Check-in posted.';
  rewardCopy.textContent = points
    ? `+${points} points added. Keep stacking the standard.`
    : status === 'visit'
      ? 'You showed up today. Keep the streak alive.'
      : 'Your check-in is posted. Points are being synced.';
  if (rewardBadges) {
    rewardBadges.innerHTML = earnedBadges.length
      ? earnedBadges.map(badgeChip).join('')
      : '<span class="badge-empty">Badges update as streaks grow.</span>';
  }
  rewardToast.hidden = false;
  rewardToast.classList.remove('active');
  void rewardToast.offsetWidth;
  rewardToast.classList.add('active');
  if (rewardToast.hideTimer) window.clearTimeout(rewardToast.hideTimer);
  rewardToast.hideTimer = window.setTimeout(() => {
    rewardToast.classList.remove('active');
    rewardToast.hidden = true;
    rewardToast.hideTimer = null;
  }, REWARD_TOAST_DURATION_MS);
  return REWARD_TOAST_DURATION_MS;
}
function showBadgeCelebration(badge) {
  const stage = $('badgeCelebration');
  const icon = $('badgeCelebrationIcon');
  const title = $('badgeCelebrationTitle');
  const copy = $('badgeCelebrationCopy');
  if (!stage || !badge) return;

  if (title) title.textContent = badge.name || 'Badge Earned';
  if (copy) {
    const tier = badge.tier ? `${badge.tier} badge` : 'badge';
    copy.textContent = `You unlocked a ${tier}. Keep stacking faithful days.`;
  }
  if (icon) {
    icon.className = `badge-medal-icon app-icon ${badgeIconClass(badge)}`;
  }

  if (stage.hideTimer) window.clearTimeout(stage.hideTimer);
  if (stage.exitTimer) window.clearTimeout(stage.exitTimer);
  stage.hidden = false;
  stage.classList.remove('active', 'exiting');
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
  earnedBadges.slice(0, 4).forEach((badge, index) => {
    window.setTimeout(() => showBadgeCelebration(badge), delay + index * (BADGE_REVEAL_DURATION_MS + 900));
  });
}
let theme = load('dominion:theme', 'dark');
let startDate = localDemoMode ? load('dominion:startDate', todayKey()) : todayKey();
let entries = localDemoMode ? load('dominion:entries', []) : [];
let feed = localDemoMode ? load('dominion:feed', starterFeed) : starterFeed;
let workoutDifficulty = localDemoMode ? load('dominion:workoutDifficulty', { one: 'medium', two: 'medium' }) : { one: 'medium', two: 'medium' };
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
  if (localDemoMode) save('dominion:entries', entries);
  if (hasSupabaseAuth()) {
    saveChallengeEntry(entry).catch((error) => console.warn('Unable to sync challenge entry', error));
  }
};
const currentDay = () => Math.min(Math.max(Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000) + 1, 1), TOTAL_DAYS);
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
  checklist.querySelectorAll('[data-standard]').forEach((row) => {
    const isChecked = completed.has(row.dataset.standard);
    row.classList.toggle('checked', isChecked);
    row.disabled = Boolean(entry.scheduledMiss);
    row.setAttribute('aria-pressed', String(isChecked));
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
  const countdownTime = $('countdownTime');
  const countdownProgress = $('countdownProgress');
  const countdownCallout = $('countdownCallout');
  const countdownProgressLabel = $('countdownProgressLabel');
  const countdownActionsLabel = $('countdownActionsLabel');
  if (!countdownTime || !countdownProgress || !countdownCallout) return;

  const entry = todayEntry();
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

  if (workoutOneDifficulty) workoutOneDifficulty.value = workoutDifficulty.one || 'medium';
  if (workoutTwoDifficulty) workoutTwoDifficulty.value = workoutDifficulty.two || 'medium';

  const onePlan = pickDaily(workoutPlans[workoutDifficulty.one || 'medium'], 0);
  const twoPlan = pickDaily(workoutPlans[workoutDifficulty.two || 'medium'], 1);
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
  const themeToggle = $('themeToggle');
  const startDateInput = $('startDate');
  const challengePercentEl = $('challengePercent');
  const challengeDayEl = $('challengeDay');
  const challengeRing = $('challengeRing');
  const todayPercentEl = $('todayPercent');
  const todayCountEl = $('todayCount');
  const todayRing = $('todayRing');
  const checkInButton = $('checkInButton');
  const scheduledButton = $('scheduledButton');
  const checklist = $('checklist');
  const feedEl = $('feed');
  const completedToday = $('completedToday');
  if (themeToggle) themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
  if (startDateInput) startDateInput.value = startDate;
  const entry = todayEntry();
  const challengePercent = Math.round((currentDay() / TOTAL_DAYS) * 100);
  const todayPercent = Math.round((entry.completed.length / standards.length) * 100);
  const hasCompletedActions = entry.completed.length > 0;
  const hasPostableCheckIn = hasCompletedActions || entry.scheduledMiss;
  if (challengePercentEl) challengePercentEl.textContent = `${challengePercent}%`;
  if (challengeDayEl) challengeDayEl.textContent = `Day ${currentDay()} of 77`;
  if (challengeRing) challengeRing.style.setProperty('--value', `${challengePercent}%`);
  if (todayPercentEl) todayPercentEl.textContent = `${todayPercent}%`;
  if (todayCountEl) todayCountEl.textContent = entry.scheduledMiss ? 'Scheduled miss day' : `${entry.completed.length} of ${standards.length} done`;
  if (todayRing) todayRing.style.setProperty('--value', `${todayPercent}%`);
  if (checkInButton) checkInButton.disabled = !hasPostableCheckIn;
  if (scheduledButton) {
    scheduledButton.classList.toggle('active', !!entry.scheduledMiss);
    scheduledButton.disabled = hasCompletedActions && !entry.scheduledMiss;
    scheduledButton.textContent = entry.scheduledMiss ? 'Scheduled miss selected' : 'Scheduled miss day planned ahead';
    scheduledButton.setAttribute('aria-pressed', String(!!entry.scheduledMiss));
  }
  if (checklist) renderChecklist(entry);
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
      save('dominion:entries', entries);
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
    const earnedBadges = await refreshGameSummary(previousBadgeKeys);
    if (earnedBadges.length) {
      const toastDuration = showRewardToast({ points: 0, earnedBadges, status: 'visit' }) || 0;
      queueBadgeCelebrations(earnedBadges, toastDuration + 350);
    }
    render();
  } catch (error) {
    console.warn('Unable to record daily app visit', error);
  }
}

const themeToggle = $('themeToggle');
const startDateInput = $('startDate');
const checklist = $('checklist');
const scheduledButton = $('scheduledButton');
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
    workoutDifficulty = { ...workoutDifficulty, [target.dataset.workout]: target.value };
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
  if (todayEntry().scheduledMiss) return;
  const entry = { ...todayEntry(), completed: [...todayEntry().completed], scheduledMiss: false };
  const id = row.dataset.standard;
  const willBeChecked = !entry.completed.includes(id);
  entry.completed = willBeChecked ? [...entry.completed, id] : entry.completed.filter(item => item !== id);
  saveEntry(entry);
  render();
});
if (scheduledButton) scheduledButton.addEventListener('click', () => {
  const currentEntry = todayEntry();
  if (currentEntry.completed.length > 0 && !currentEntry.scheduledMiss) return;
  const entry = { ...currentEntry, completed: [], scheduledMiss: !currentEntry.scheduledMiss };
  saveEntry(entry);
  render();
});
if (checkInButton) checkInButton.addEventListener('click', async () => {
  const entry = todayEntry();
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
      earnedBadges = await refreshGameSummary(previousBadgeKeys);
    } else {
      let points = calculateLocalPoints(entry, status);
      if (status === 'complete') {
        const nextStreak = (gameStats.currentFullDayStreak || 0) + 1;
        const streakBonus = { 3: 25, 7: 75, 14: 150, 30: 300, 77: 777 }[nextStreak] || 0;
        points += streakBonus;
        gameStats.currentFullDayStreak = nextStreak;
        gameStats.bestFullDayStreak = Math.max(gameStats.bestFullDayStreak || 0, nextStreak);
      }
      gameStats.totalPoints = (gameStats.totalPoints || 0) + points;
      gameStats.challengePoints = (gameStats.challengePoints || 0) + points;
      feedItem.pointsAwarded = points;
      earnedBadges = awardLocalBadges(entry, status);
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
