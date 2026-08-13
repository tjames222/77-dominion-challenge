import {
  completePasswordRecovery,
  getAuthSession,
  hasSupabaseAuthentication,
  requestPasswordRecovery,
  subscribeToAuthStateChanges,
} from './api';
import {
  cleanPasswordRecoveryUrl,
  passwordRecoveryErrorFromLocation,
  validateNewPassword,
} from './account-recovery.mjs';
import { initReveal } from './reveal';

const requestForm = document.getElementById('passwordRecoveryRequestForm');
const requestEmail = document.getElementById('passwordRecoveryEmail');
const requestFeedback = document.getElementById('passwordRecoveryRequestFeedback');
const resetForm = document.getElementById('passwordResetForm');
const resetPassword = document.getElementById('newPassword');
const resetConfirmation = document.getElementById('confirmNewPassword');
const resetFeedback = document.getElementById('passwordResetFeedback');
const resetSubmit = resetForm?.querySelector('button[type="submit"]');
const resetComplete = document.getElementById('passwordResetComplete');
let resetInFlight = false;
let resetCompleted = false;
let recoveryEventObserved = false;

function setFeedback(element, message, tone = '') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', tone === 'error');
}

function setFormBusy(form, busy, busyLabel) {
  if (!form) return;
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll('input, button').forEach((control) => { control.disabled = busy; });
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  submit.dataset.idleLabel ||= submit.textContent;
  submit.textContent = busy ? busyLabel : submit.dataset.idleLabel;
}

requestForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!requestEmail?.value.trim()) return;
  setFormBusy(requestForm, true, 'Sending...');
  setFeedback(requestFeedback, 'Sending a secure reset link...');
  try {
    await requestPasswordRecovery(requestEmail.value);
    // Keep this identical for known and unknown addresses to avoid account
    // enumeration through the browser UI.
    setFeedback(
      requestFeedback,
      'If an account uses that email, a password reset link is on its way. Check spam if it does not arrive.',
    );
    requestForm.reset();
  } catch (error) {
    console.warn('Unable to request password recovery', error);
    setFeedback(requestFeedback, 'We could not send a reset link right now. Wait a moment and try again.', 'error');
  } finally {
    setFormBusy(requestForm, false, 'Sending...');
  }
});

async function setResetSessionReady(ready) {
  if (!resetForm || resetCompleted) return;
  resetForm.querySelectorAll('input').forEach((control) => { control.disabled = !ready; });
  if (resetSubmit) resetSubmit.disabled = !ready;
  if (ready) {
    setFeedback(resetFeedback, 'Choose a new password for this account.');
    resetPassword?.focus();
  }
}

async function hydrateResetSession() {
  if (!resetForm) return;
  const providerError = passwordRecoveryErrorFromLocation(window.location);
  if (providerError) {
    setFeedback(resetFeedback, 'This reset link is invalid or expired. Request a new one.', 'error');
  }

  if (!hasSupabaseAuthentication()) {
    setFeedback(resetFeedback, 'Password reset is unavailable in this local preview.', 'error');
    await setResetSessionReady(false);
    return;
  }

  const unsubscribe = subscribeToAuthStateChanges(({ event, user }) => {
    if (resetCompleted) return;
    if (event === 'PASSWORD_RECOVERY' && user?.authenticated) {
      recoveryEventObserved = true;
      void setResetSessionReady(true);
    } else if (event === 'SIGNED_OUT') {
      void setResetSessionReady(false);
    }
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });

  try {
    const session = await getAuthSession();
    await setResetSessionReady(Boolean(session?.user) && recoveryEventObserved);
    if ((!session?.user || !recoveryEventObserved) && !providerError) {
      setFeedback(resetFeedback, 'Open the current reset link from your email to continue.', 'error');
    }
  } catch (error) {
    console.warn('Unable to verify password recovery session', error);
    setFeedback(resetFeedback, 'This reset link could not be verified. Request a new one.', 'error');
    await setResetSessionReady(false);
  } finally {
    const cleanUrl = cleanPasswordRecoveryUrl(window.location);
    if (cleanUrl) window.history.replaceState({}, document.title, cleanUrl);
  }
}

resetForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (resetInFlight || resetCompleted) return;
  const validation = validateNewPassword(resetPassword?.value, resetConfirmation?.value);
  if (validation) {
    setFeedback(resetFeedback, validation, 'error');
    return;
  }

  resetInFlight = true;
  setFormBusy(resetForm, true, 'Saving...');
  setFeedback(resetFeedback, 'Saving your new password...');
  try {
    const result = await completePasswordRecovery(resetPassword.value);
    resetCompleted = true;
    resetForm.reset();
    resetForm.hidden = true;
    if (resetComplete) resetComplete.hidden = false;
    setFeedback(
      resetFeedback,
      result.sessionsRevoked === 'global'
        ? 'Password changed. For security, all sessions were signed out.'
        : 'Password changed and this browser was signed out. We couldn’t confirm sign-out on your other devices.',
    );
  } catch (error) {
    console.warn('Unable to complete password recovery', error);
    setFeedback(resetFeedback, error?.message || 'Unable to change the password. Request a new link and try again.', 'error');
  } finally {
    resetInFlight = false;
    if (!resetCompleted) setFormBusy(resetForm, false, 'Saving...');
  }
});

void hydrateResetSession();
initReveal();
