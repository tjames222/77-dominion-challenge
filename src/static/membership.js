import { getBillingState, getLocalOrSessionUser, hasSupabaseAuth } from './api';
import { initReveal } from './reveal';

const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
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

async function hydrateMembershipCtas() {
  const ctas = [...document.querySelectorAll('[data-membership-cta]')];
  if (!ctas.length) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);
  let target = './register.html?returnTo=./billing.html';
  let label = 'Sign up now';

  if (isLoggedIn) {
    target = './billing.html';
    label = 'Activate membership';
    if (hasSupabaseAuth()) {
      try {
        const billing = await getBillingState();
        if (billing.appAccess) {
          target = './dashboard.html';
          label = 'Open dashboard';
        }
      } catch (error) {
        console.warn('Unable to personalize membership CTA', error);
      }
    }
  }

  ctas.forEach((cta) => {
    cta.href = target;
    cta.textContent = label;
  });
}

applyTheme();
hydrateMembershipCtas();
initReveal();
