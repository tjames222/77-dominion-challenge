import { initReveal } from './reveal';
import { buildInviteAuthHref, isInviteReturnPath } from './invite-flow.mjs';
import {
  getBillingState,
  hasSupabaseAuth,
  isLocalDemoMode,
  saveLocalUserFromSession,
  sanitizeReturnTo,
  signInWithPassword,
  signUpWithPassword,
} from './api';

const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const form = document.getElementById('authForm');
const rawReturnTo = new URLSearchParams(window.location.search).get('returnTo');
const returnTo = sanitizeReturnTo(rawReturnTo);
const inviteReturn = isInviteReturnPath(returnTo);
const authSwitchLink = document.querySelector('[data-auth-switch]');
if (authSwitchLink && inviteReturn) {
  const switchingToRegister = Boolean(document.getElementById('email') && !document.getElementById('name'));
  authSwitchLink.href = buildInviteAuthHref(switchingToRegister ? 'register' : 'login');
  if (switchingToRegister) authSwitchLink.textContent = 'Create an account';
}
if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nameInput = document.getElementById('name');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton?.textContent;
    const name = nameInput ? nameInput.value.trim() : 'Member';
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
        if (returnTo && returnTo !== './dashboard.html') {
          window.location.href = returnTo;
          return;
        }

        const billing = await getBillingState();
        window.location.href = billing.appAccess ? './dashboard.html' : './billing.html';
        return;
      }

      if (!isLocalDemoMode()) {
        window.alert('Authentication is not configured for this production deployment yet.');
        return;
      }

      const user = {
        name,
        email,
        authenticated: true,
      };
      save('dominion:user', user);
      if (user.name) save('dominion:memberName', user.name);
      window.location.href = returnTo || './dashboard.html';
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
