import { initReveal } from './reveal';

const TOTAL_DAYS = 77;
const YOUVERSION_VERSE_URL = import.meta.env.VITE_YOUVERSION_VERSE_URL || '';
const YOUVERSION_APP_URL = import.meta.env.VITE_YOUVERSION_APP_URL || 'https://www.bible.com/';
const YOUVERSION_PRAYER_URL = import.meta.env.VITE_YOUVERSION_PRAYER_URL || 'https://www.bible.com/prayer';
const APPLE_FITNESS_URL = import.meta.env.VITE_APPLE_FITNESS_URL || 'https://fitness.apple.com/';
const WALK_ALARM_URL = import.meta.env.VITE_WALK_ALARM_URL || '';
const standards = [
  ['bible', 'Bible Reading', '5–8 chapters'],
  ['morningPrayer', 'Morning Prayer', 'Spirit'],
  ['eveningPrayer', 'Evening Prayer', 'Spirit'],
  ['worshipOnly', 'Worship Music Only', 'Instrumental, podcasts, and audiobooks permitted'],
  ['workoutOne', 'Workout #1', 'No required length'],
  ['walk', 'Intentional Walk', 'During the day'],
  ['workoutTwo', 'Workout #2', 'No required length'],
];
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
    '20 min mobility, light core, and a relaxed cooldown.',
    '25 min low-impact strength with slow reps and steady breathing.',
    '30 min recovery ride or walk with 10 min stretching.',
  ],
  medium: [
    '35 min full-body strength with a controlled finisher.',
    '30 min intervals plus 10 min core.',
    '40 min upper/lower split at a sustainable pace.',
  ],
  hard: [
    '45 min strength circuit with short rests and a hard finisher.',
    '35 min HIIT plus 15 min mobility recovery.',
    '50 min legs, core, and conditioning.',
  ],
  extreme: [
    '60 min advanced strength and conditioning. Warm up seriously.',
    '45 min high-output intervals plus 20 min accessory work.',
    '75 min endurance push. Hydrate and scale if form slips.',
  ],
};
const todayKey = () => new Date().toISOString().slice(0, 10);
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
let startDate = load('dominion:startDate', todayKey());
let memberName = load('dominion:memberName', load('dominion:user', { name: '' }).name || '');
let entries = load('dominion:entries', []);
let feed = load('dominion:feed', starterFeed);
let workoutDifficulty = load('dominion:workoutDifficulty', { one: 'medium', two: 'medium' });
const $ = (id) => document.getElementById(id);
const verseText = $('verseText');
const verseReference = $('verseReference');
const verseAppLink = $('verseAppLink');
const dayIndex = () => Math.floor(new Date(`${todayKey()}T00:00:00`).getTime() / 86400000);
const pickDaily = (items, offset = 0) => items[(dayIndex() + offset) % items.length];
const todayEntry = () => entries.find(entry => entry.date === todayKey()) || { date: todayKey(), completed: [] };
const saveEntry = (entry) => {
  const index = entries.findIndex(item => item.date === entry.date);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  save('dominion:entries', entries);
};
const currentDay = () => Math.min(Math.max(Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000) + 1, 1), TOTAL_DAYS);
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
    worshipLink.textContent = 'Open today’s worship';
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
  const memberNameInput = $('memberName');
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
  if (memberNameInput) memberNameInput.value = memberName;
  if (startDateInput) startDateInput.value = startDate;
  const entry = todayEntry();
  const challengePercent = Math.round((currentDay() / TOTAL_DAYS) * 100);
  const todayPercent = Math.round((entry.completed.length / standards.length) * 100);
  if (challengePercentEl) challengePercentEl.textContent = `${challengePercent}%`;
  if (challengeDayEl) challengeDayEl.textContent = `Day ${currentDay()} of 77`;
  if (challengeRing) challengeRing.style.setProperty('--value', `${challengePercent}%`);
  if (todayPercentEl) todayPercentEl.textContent = `${todayPercent}%`;
  if (todayCountEl) todayCountEl.textContent = `${entry.completed.length} of 7 done`;
  if (todayRing) todayRing.style.setProperty('--value', `${todayPercent}%`);
  if (checkInButton) checkInButton.disabled = entry.completed.length !== standards.length && !entry.scheduledMiss;
  if (scheduledButton) scheduledButton.classList.toggle('active', !!entry.scheduledMiss);
  if (checklist) {
    checklist.innerHTML = standards.map(([id, label, detail]) => `<button class="check-row ${entry.completed.includes(id) ? 'checked' : ''}" data-standard="${id}"><span class="box"><span class="app-icon icon-sm icon-check" aria-hidden="true"></span></span><span><strong>${label}</strong><small>${detail}</small></span></button>`).join('');
  }
  if (feedEl) {
    feedEl.innerHTML = feed.slice(0, 6).map(item => `<article class="feed-item"><div><strong>${item.name}</strong><p>Day ${item.day} ${item.status === 'complete' ? 'complete' : 'scheduled miss'}</p></div><span class="feed-status"><span class="app-icon icon-sm ${item.status === 'complete' ? 'icon-check' : 'icon-repeat'}" aria-hidden="true"></span></span></article>`).join('');
  }
  if (completedToday) completedToday.textContent = `${feed.filter(item => item.status === 'complete' && item.timestamp === 'Today').length} people completed today`;
  if (verseAppLink) verseAppLink.href = YOUVERSION_APP_URL;
  applyDailyActions();
}
const themeToggle = $('themeToggle');
const memberNameInput = $('memberName');
const startDateInput = $('startDate');
const checklist = $('checklist');
const scheduledButton = $('scheduledButton');
const checkInButton = $('checkInButton');
const walkReminderButton = $('walkReminderButton');
if (themeToggle) themeToggle.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('dominion:theme', theme); render(); });
if (memberNameInput) memberNameInput.addEventListener('input', event => { memberName = event.target.value; save('dominion:memberName', memberName); });
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
  const entry = { ...todayEntry(), completed: [...todayEntry().completed] };
  const id = row.dataset.standard;
  entry.completed = entry.completed.includes(id) ? entry.completed.filter(item => item !== id) : [...entry.completed, id];
  saveEntry(entry);
  render();
});
if (scheduledButton) scheduledButton.addEventListener('click', () => {
  const entry = { ...todayEntry(), scheduledMiss: !todayEntry().scheduledMiss };
  saveEntry(entry);
  render();
});
if (checkInButton) checkInButton.addEventListener('click', () => {
  feed.unshift({ name: memberName || 'Anonymous', day: currentDay(), status: todayEntry().scheduledMiss ? 'scheduled' : 'complete', timestamp: 'Today' });
  save('dominion:feed', feed);
  render();
});
render();
loadVerseOfDay();
applyDailyActions();
requestAnimationFrame(() => initReveal());
