import { initReveal } from './reveal';

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
const themeToggle = document.getElementById('themeToggle');
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  if (themeToggle) themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
}
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    save('dominion:theme', theme);
    applyTheme();
  });
}
applyTheme();

const user = load('dominion:user', { name: 'Member', email: 'Logged in' });
document.getElementById('profileName').textContent = user?.name || 'Member';
document.getElementById('profileEmail').textContent = user?.email || 'Logged in';

initReveal();
