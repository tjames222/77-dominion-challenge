import { initReveal } from './reveal';
import { getProfile, hasSupabaseAuth } from './api';

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
const themeOptions = [...document.querySelectorAll('[data-theme-mode]')];
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  themeOptions.forEach((option) => {
    const isActive = option.dataset.themeMode === theme;
    option.classList.toggle('active', isActive);
    option.setAttribute('aria-pressed', String(isActive));
  });
}
themeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    theme = option.dataset.themeMode || 'dark';
    save('dominion:theme', theme);
    applyTheme();
  });
});
applyTheme();

const user = load('dominion:user', { name: 'Member', email: 'Logged in' });
document.getElementById('profileName').textContent = user?.name || 'Member';
document.getElementById('profileEmail').textContent = user?.email || 'Logged in';

async function hydrateProfile() {
  if (!hasSupabaseAuth()) return;

  try {
    const profile = await getProfile();
    const syncedUser = {
      name: profile.name || 'Member',
      email: profile.email || 'Logged in',
      authenticated: true,
    };
    save('dominion:user', syncedUser);
    document.getElementById('profileName').textContent = syncedUser.name;
    document.getElementById('profileEmail').textContent = syncedUser.email;
  } catch (error) {
    console.warn('Unable to load profile from Supabase', error);
  }
}

hydrateProfile();
initReveal();
