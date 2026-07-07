import { initReveal } from './reveal';
import {
  getBillingState,
  hasSupabaseAuth,
  saveLocalUserFromSession,
  sanitizeReturnTo,
  signInWithPassword,
  signUpWithPassword,
} from './api';

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
applyTheme();

const form = document.getElementById('authForm');
if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nameInput = document.getElementById('name');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton?.textContent;
    const name = nameInput ? nameInput.value.trim() : load('dominion:user', { name: 'Member' }).name || 'Member';
    const email = emailInput.value.trim();
    const password = passwordInput?.value || '';

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Working...';
    }

    try {
      if (hasSupabaseAuth()) {
        const result = nameInput
          ? await signUpWithPassword({ name, email, password })
          : await signInWithPassword({ email, password });

        if (!result.session?.access_token) {
          window.alert('Check your email to confirm your account, then log in.');
          return;
        }

        saveLocalUserFromSession(result.session, name);
        const returnTo = sanitizeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
        if (returnTo && returnTo !== './dashboard.html') {
          window.location.href = returnTo;
          return;
        }

        const billing = await getBillingState();
        window.location.href = billing.challengeAccess ? './dashboard.html' : './billing.html';
        return;
      }

      const user = {
        name,
        email,
        authenticated: true,
      };
      save('dominion:user', user);
      if (user.name) save('dominion:memberName', user.name);
      window.location.href = './dashboard.html';
    } catch (error) {
      window.alert(error?.message || 'Unable to authenticate right now.');
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }
  });
}
initReveal();
