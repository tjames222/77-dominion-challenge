import { getBillingState, getLocalOrSessionUser, hasSupabaseAuth, isLocalDemoMode } from './api';
import { initReveal } from './reveal';

const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
const themeToggle = document.getElementById('themeToggle');
const heroPoster = document.querySelector('.hero-poster img');
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  if (heroPoster) heroPoster.src = theme === 'light' ? heroPoster.dataset.lightSrc : heroPoster.dataset.darkSrc;
  if (themeToggle) themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
}
if (themeToggle) {
  themeToggle.addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    save('dominion:theme', theme);
    applyTheme();
  });
}
applyTheme();

async function hydrateLandingCtas() {
  const primaryCtas = [...document.querySelectorAll('[data-primary-cta]')];
  const billingCta = document.getElementById('pricingCta');
  if (!primaryCtas.length && !billingCta) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);
  let target = './membership.html';
  let label = 'See the membership';

  if (isLoggedIn) {
    target = './billing.html';
    label = 'Activate membership';
    if (hasSupabaseAuth() || isLocalDemoMode()) {
      try {
        const billing = await getBillingState();
        if (billing.appAccess) {
          target = './dashboard.html';
          label = 'Open dashboard';
        }
      } catch (error) {
        console.warn('Unable to personalize landing CTA', error);
      }
    }
  }

  primaryCtas.forEach((link) => {
    link.href = target;
    link.textContent = label;
  });

  if (billingCta) {
    billingCta.href = target;
    billingCta.textContent = isLoggedIn ? label : 'See what you get';
  }
}

hydrateLandingCtas();
initReveal();
