const TOTAL_DAYS = 77;
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
const todayKey = () => new Date().toISOString().slice(0, 10);
const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
let startDate = load('dominion:startDate', todayKey());
let memberName = load('dominion:memberName', load('dominion:user', { name: '' }).name || '');
let entries = load('dominion:entries', []);
let feed = load('dominion:feed', starterFeed);
const $ = (id) => document.getElementById(id);
const todayEntry = () => entries.find(entry => entry.date === todayKey()) || { date: todayKey(), completed: [] };
const saveEntry = (entry) => {
  const index = entries.findIndex(item => item.date === entry.date);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  save('dominion:entries', entries);
};
const currentDay = () => Math.min(Math.max(Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000) + 1, 1), TOTAL_DAYS);
function render() {
  document.documentElement.dataset.theme = theme;
  $('themeToggle').textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
  $('memberName').value = memberName;
  $('startDate').value = startDate;
  const entry = todayEntry();
  const challengePercent = Math.round((currentDay() / TOTAL_DAYS) * 100);
  const todayPercent = Math.round((entry.completed.length / standards.length) * 100);
  $('challengePercent').textContent = `${challengePercent}%`;
  $('challengeDay').textContent = `Day ${currentDay()} of 77`;
  $('challengeRing').style.setProperty('--value', `${challengePercent}%`);
  $('todayPercent').textContent = `${todayPercent}%`;
  $('todayCount').textContent = `${entry.completed.length} of 7 done`;
  $('todayRing').style.setProperty('--value', `${todayPercent}%`);
  $('checkInButton').disabled = entry.completed.length !== standards.length && !entry.scheduledMiss;
  $('scheduledButton').classList.toggle('active', !!entry.scheduledMiss);
  $('checklist').innerHTML = standards.map(([id, label, detail]) => `<button class="check-row ${entry.completed.includes(id) ? 'checked' : ''}" data-standard="${id}"><span class="box">✓</span><span><strong>${label}</strong><small>${detail}</small></span></button>`).join('');
  $('feed').innerHTML = feed.slice(0, 6).map(item => `<article class="feed-item"><div><strong>${item.name}</strong><p>Day ${item.day} ${item.status === 'complete' ? 'complete' : 'scheduled miss'}</p></div><span>${item.status === 'complete' ? '✓' : '↺'}</span></article>`).join('');
  $('completedToday').textContent = `${feed.filter(item => item.status === 'complete' && item.timestamp === 'Today').length} people completed today`;
}
$('themeToggle').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('dominion:theme', theme); render(); });
$('memberName').addEventListener('input', event => { memberName = event.target.value; save('dominion:memberName', memberName); });
$('startDate').addEventListener('input', event => { startDate = event.target.value || todayKey(); save('dominion:startDate', startDate); render(); });
$('checklist').addEventListener('click', event => {
  const row = event.target.closest('[data-standard]');
  if (!row) return;
  const entry = { ...todayEntry(), completed: [...todayEntry().completed] };
  const id = row.dataset.standard;
  entry.completed = entry.completed.includes(id) ? entry.completed.filter(item => item !== id) : [...entry.completed, id];
  saveEntry(entry);
  render();
});
$('scheduledButton').addEventListener('click', () => {
  const entry = { ...todayEntry(), scheduledMiss: !todayEntry().scheduledMiss };
  saveEntry(entry);
  render();
});
$('checkInButton').addEventListener('click', () => {
  feed.unshift({ name: memberName || 'Anonymous', day: currentDay(), status: todayEntry().scheduledMiss ? 'scheduled' : 'complete', timestamp: 'Today' });
  save('dominion:feed', feed);
  render();
});
render();
