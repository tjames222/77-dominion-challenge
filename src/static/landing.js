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
  let target = './register.html';
  let label = 'Start for $7/month';

  if (isLoggedIn) {
    target = './billing.html';
    label = 'View plans';
    if (hasSupabaseAuth()) {
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

  if (billingCta) billingCta.href = isLoggedIn ? './billing.html' : './register.html';
}

hydrateLandingCtas();
initReveal();
