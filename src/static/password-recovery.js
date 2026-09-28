import {
  completePasswordRecovery,
  getAuthSession,
  getPasswordRecoveryState,
  hasSupabaseAuthentication,
  loadPasswordRecoveryController,
  requestPasswordRecovery,
  subscribeToPasswordRecoveryState,
  verifyPasswordRecoverySession,
} from './api';
import { passwordRecoverySessionError } from './account-recovery-session.mjs';
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
let recoveryOwner = null;
let verificationQueued = false;

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
  } catch {
    setFeedback(requestFeedback, 'We could not send a reset link right now. Wait a moment and try again.', 'error');
  } finally {
    setFormBusy(requestForm, false, 'Sending...');
  }
});

function setResetSessionReady(ready) {
  if (!resetForm || resetCompleted) return;
  resetForm.querySelectorAll('input').forEach((control) => { control.disabled = !ready; });
  if (resetSubmit) resetSubmit.disabled = !ready;
  if (ready) {
    setFeedback(resetFeedback, 'Choose a new password for this account.');
    resetPassword?.focus();
  }
}

function observeRecoveryState(state) {
  if (!resetForm || resetCompleted) return;
  const previous = recoveryOwner;
  recoveryOwner = state?.owner || null;
  if (previous !== recoveryOwner || state?.phase === 'blocked') resetForm.reset();
  setResetSessionReady(state?.phase === 'ready' && !resetInFlight);
  if (state?.phase === 'blocked' || state?.phase === 'idle') {
    setFeedback(resetFeedback, passwordRecoverySessionError(state?.code).message, 'error');
  }
  if (state?.phase === 'pending' && !verificationQueued) {
    verificationQueued = true;
    // Supabase waits for auth callbacks; never call its methods within one.
    setTimeout(() => {
      verificationQueued = false;
      if (getPasswordRecoveryState()?.phase === 'pending') {
        void verifyPasswordRecoverySession().catch(() => { /* State owns fixed feedback. */ });
      }
    }, 0);
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
    setResetSessionReady(false);
    return;
  }

  // URL cleanup must also finish when the lazy reset-only chunk fails to load.
  // Only the singleton consumes native URL credentials; its stored session is
  // never treated as recovery authorization by this initialization wait.
  const initialized = getAuthSession().catch(() => null).then(() => {
    const cleanUrl = cleanPasswordRecoveryUrl(window.location);
    if (cleanUrl) window.history.replaceState({}, document.title, cleanUrl);
  }).catch(() => { /* No credential or provider error enters UI/logs. */ });
  try { await loadPasswordRecoveryController(); }
  catch { setFeedback(resetFeedback, 'Password reset could not be loaded. Reload this page.', 'error'); return; }
  const unsubscribe = subscribeToPasswordRecoveryState(observeRecoveryState);
  window.addEventListener('pagehide', () => {
    recoveryOwner = null;
    resetForm.reset();
    setResetSessionReady(false);
    unsubscribe();
  }, { once: true });
  observeRecoveryState(getPasswordRecoveryState());
  await initialized;
}

resetForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (resetInFlight || resetCompleted || !recoveryOwner || getPasswordRecoveryState()?.phase !== 'ready') return;
  const validation = validateNewPassword(resetPassword?.value, resetConfirmation?.value);
  if (validation) {
    setFeedback(resetFeedback, validation, 'error');
    return;
  }

  resetInFlight = true;
  const submittedOwner = recoveryOwner;
  setFormBusy(resetForm, true, 'Saving...');
  setFeedback(resetFeedback, 'Saving your new password...');
  try {
    const result = await completePasswordRecovery(resetPassword.value, submittedOwner);
    if (recoveryOwner !== submittedOwner) return;
    resetCompleted = true;
    resetForm.reset();
    resetForm.hidden = true;
    if (resetComplete) resetComplete.hidden = false;
    setFeedback(
      resetFeedback,
      result.sessionsRevoked === 'global'
        ? 'Password changed. Sign-in sessions were revoked. Log in again with your new password.'
        : result.sessionsRevoked === 'local'
          ? 'Password changed. This recovery session was revoked, but other sessions could not be confirmed. Log in again.'
          : 'Password changed, but session revocation could not be confirmed. Close this window and log in again; review your other signed-in devices.',
    );
  } catch (error) {
    if (recoveryOwner === submittedOwner) {
      setFeedback(resetFeedback, passwordRecoverySessionError(error?.code).message, 'error');
    }
  } finally {
    resetInFlight = false;
    if (!resetCompleted) {
      setFormBusy(resetForm, false, 'Saving...');
      setResetSessionReady(getPasswordRecoveryState()?.phase === 'ready');
    }
  }
});

void hydrateResetSession();
initReveal();
