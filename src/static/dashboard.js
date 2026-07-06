import { initReveal } from './reveal';

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
const todayKey = () => new Date().toISOString().slice(0, 10);
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const statusLabel = (item) => {
  if (item.status === 'scheduled') return 'scheduled miss';
  if (item.status === 'partial') return `partial check-in${item.completedCount ? ` (${item.completedCount}/7)` : ''}`;
  return 'complete';
};
let theme = load('dominion:theme', 'dark');
let startDate = load('dominion:startDate', todayKey());
let entries = load('dominion:entries', []);
let feed = load('dominion:feed', starterFeed);
let workoutDifficulty = load('dominion:workoutDifficulty', { one: 'medium', two: 'medium' });
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
  save('dominion:entries', entries);
};
const currentDay = () => Math.min(Math.max(Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000) + 1, 1), TOTAL_DAYS);
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
  if (checklist) {
    checklist.innerHTML = scorecardGroups.map((group) => {
      const rows = group.items.map(([id, label, detail]) => {
        const isChecked = entry.completed.includes(id);
        return `<button class="check-row ${isChecked ? 'checked' : ''}" data-standard="${id}" aria-pressed="${isChecked}" ${entry.scheduledMiss ? 'disabled' : ''}><span class="box"><span class="app-icon icon-sm icon-check" aria-hidden="true"></span></span><span><strong>${label}</strong><small>${detail}</small></span></button>`;
      }).join('');
      const itemLabel = group.items.length === 1 ? 'action' : 'actions';
      return `<section class="checklist-group"><div class="checklist-group-header"><p class="checklist-group-title">${group.label}</p><span>${group.items.length} ${itemLabel}</span></div><div class="checklist-group-items">${rows}</div></section>`;
    }).join('');
  }
  if (feedEl) {
    feedEl.innerHTML = feed.slice(0, 6).map(item => `<article class="feed-item"><div><strong>${item.name}</strong><p>Day ${item.day} ${statusLabel(item)}</p></div><span class="feed-status"><span class="app-icon icon-sm ${item.status === 'complete' ? 'icon-check' : 'icon-repeat'}" aria-hidden="true"></span></span></article>`).join('');
  }
  if (completedToday) completedToday.textContent = `${feed.filter(item => item.status === 'complete' && item.timestamp === 'Today').length} people completed today`;
  if (verseAppLink) verseAppLink.href = YOUVERSION_APP_URL;
  applyDailyActions();
  updateCountdownCard();
}
function startCountdownCard() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  updateCountdownCard();
  countdownTimer = window.setInterval(updateCountdownCard, 1000);
}
const themeToggle = $('themeToggle');
const startDateInput = $('startDate');
const checklist = $('checklist');
const scheduledButton = $('scheduledButton');
const checkInButton = $('checkInButton');
const countdownCheckInButton = $('countdownCheckInButton');
const walkReminderButton = $('walkReminderButton');
if (themeToggle) themeToggle.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('dominion:theme', theme); render(); });
if (startDateInput) startDateInput.addEventListener('input', event => { startDate = event.target.value || todayKey(); save('dominion:startDate', startDate); render(); });
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
  entry.completed = entry.completed.includes(id) ? entry.completed.filter(item => item !== id) : [...entry.completed, id];
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
if (checkInButton) checkInButton.addEventListener('click', () => {
  const entry = todayEntry();
  if (!entry.scheduledMiss && entry.completed.length === 0) return;
  const status = entry.scheduledMiss ? 'scheduled' : entry.completed.length === standards.length ? 'complete' : 'partial';
  feed.unshift({ name: 'You', day: currentDay(), status, completedCount: entry.completed.length, timestamp: 'Today' });
  save('dominion:feed', feed);
  render();
});
if (countdownCheckInButton && checkInButton) countdownCheckInButton.addEventListener('click', () => {
  checkInButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
  checkInButton.focus({ preventScroll: true });
});
render();
loadVerseOfDay();
applyDailyActions();
startCountdownCard();
requestAnimationFrame(() => initReveal());
