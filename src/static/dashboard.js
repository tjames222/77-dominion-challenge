import { initReveal } from './reveal';

const TOTAL_DAYS = 77;
const YOUVERSION_VERSE_URL = import.meta.env.VITE_YOUVERSION_VERSE_URL || '';
const YOUVERSION_APP_URL = import.meta.env.VITE_YOUVERSION_APP_URL || 'https://www.bible.com/';
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
const todayKey = () => new Date().toISOString().slice(0, 10);
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
let startDate = load('dominion:startDate', todayKey());
let memberName = load('dominion:memberName', load('dominion:user', { name: '' }).name || '');
let entries = load('dominion:entries', []);
let feed = load('dominion:feed', starterFeed);
const $ = (id) => document.getElementById(id);
const verseText = $('verseText');
const verseReference = $('verseReference');
const verseAppLink = $('verseAppLink');
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
}
const themeToggle = $('themeToggle');
const memberNameInput = $('memberName');
const startDateInput = $('startDate');
const checklist = $('checklist');
const scheduledButton = $('scheduledButton');
const checkInButton = $('checkInButton');
if (themeToggle) themeToggle.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('dominion:theme', theme); render(); });
if (memberNameInput) memberNameInput.addEventListener('input', event => { memberName = event.target.value; save('dominion:memberName', memberName); });
if (startDateInput) startDateInput.addEventListener('input', event => { startDate = event.target.value || todayKey(); save('dominion:startDate', startDate); render(); });
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
requestAnimationFrame(() => initReveal());
