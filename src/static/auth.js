import { initReveal } from './reveal';
import { authEntryTransition } from './auth-entry-transition.mjs';
import { authSessionIdentity, mfaError } from './mfa-auth.mjs';
// A stateless entry-local copy avoids a new initial shared-chunk request.
import { finishAuthLanding } from './auth-landing.mjs?auth-entry';
import { mfaChallengeHref } from './mfa-navigation.mjs';
import { buildInviteAuthHref, isInviteReturnPath } from './invite-flow.mjs';
import {
  buildChallengeStartAuthHref,
  isChallengeStartReturnPath,
} from './challenge-start-intent.mjs';
import {
  getBillingState,
  getAuthSession,
  getMfaAuthAdapter,
  getSiteAdminContext,
  hasPendingPasswordRecovery,
  hasSupabaseAuthentication,
  isLocalDemoMode,
  saveLocalMockUser,
  saveLocalUserFromSession,
  sanitizeReturnTo,
  signInWithPassword,
  signUpWithPassword,
  subscribeToAuthStateChanges,
} from './api';
import {
  PUBLIC_SIGNUP_CLOSED_MESSAGE,
  RELEASE_GATES,
} from './release-gates.mjs';

const form = document.getElementById('authForm');
const nameInput = document.getElementById('name');
const signupPage = Boolean(nameInput);
const signupEyebrow = document.getElementById('signupEyebrow');
const signupTitle = document.getElementById('signupTitle');
const signupLead = document.getElementById('signupLead');
const signupUnavailable = document.getElementById('signupUnavailable');
const signupEncouragement = document.getElementById('signupEncouragement');
const signupLegalNote = document.getElementById('signupLegalNote');

function hydrateSignupGate() {
  if (!signupPage) return;
  const signupOpen = RELEASE_GATES.publicSignupEnabled;
  if (form) form.hidden = !signupOpen;
  if (signupUnavailable) signupUnavailable.hidden = signupOpen;
  if (signupEncouragement) signupEncouragement.hidden = !signupOpen;
  if (signupLegalNote) signupLegalNote.hidden = !signupOpen;
  if (!signupOpen) return;

  if (signupEyebrow) signupEyebrow.textContent = 'Step 1 of 2';
  if (signupTitle) signupTitle.textContent = 'Create your account';
  if (signupLead) {
    signupLead.textContent = 'Create an account to track your actions, check-ins, and progress through all 77 days.';
  }
}

hydrateSignupGate();

const rawReturnTo = new URLSearchParams(window.location.search).get('returnTo');
const returnTo = sanitizeReturnTo(rawReturnTo);
const inviteReturn = isInviteReturnPath(returnTo);
const groupStartReturn = isChallengeStartReturnPath(returnTo);
const authSwitchLink = document.querySelector('[data-auth-switch]');
let cancelSavedLogin = () => {};
if (authSwitchLink && (inviteReturn || groupStartReturn)) {
  const switchingToRegister = Boolean(document.getElementById('email') && !nameInput);
  if (switchingToRegister && !RELEASE_GATES.publicSignupEnabled) {
    authSwitchLink.parentElement.textContent = 'Dominion is currently open to invited accounts only.';
  } else {
    authSwitchLink.href = inviteReturn
      ? buildInviteAuthHref(switchingToRegister ? 'register' : 'login')
      : buildChallengeStartAuthHref(switchingToRegister ? 'register' : 'login');
    if (switchingToRegister) authSwitchLink.textContent = 'Create an account';
  }
}
if (form) {
  // Typing or submitting means the member has chosen an explicit sign-in.
  form.addEventListener('input', () => cancelSavedLogin());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    cancelSavedLogin();
    if (signupPage && !RELEASE_GATES.publicSignupEnabled) {
      window.alert(PUBLIC_SIGNUP_CLOSED_MESSAGE);
      return;
    }
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton?.textContent;
    const name = nameInput ? nameInput.value.trim() : 'Member';
    const email = emailInput.value.trim();
    const password = passwordInput?.value || '';
    const resumeOptionalHydration = authEntryTransition.begin();
    let navigationCommitted = false;
    const continueTo = (href) => {
      window.location.href = href;
      navigationCommitted = true;
    };

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Working...';
    }

    try {
      if (hasSupabaseAuthentication()) {
        const result = nameInput
          ? await signUpWithPassword({ name, email, password })
          : await signInWithPassword({ email, password });

        if (!result.session?.access_token) {
          window.alert('Check your email to confirm your account, then log in.');
          return;
        }

        if (result.mfaRequired) {
          if (passwordInput) passwordInput.value = '';
          continueTo(mfaChallengeHref(returnTo, window.location.origin));
          return;
        }

        await finishAuthLanding({
          session: result.session, returnTo, getAuthSession, getSiteAdminContext,
          getBillingState, subscribeToAuthStateChanges, lifecycle: window,
          navigate(target) {
            saveLocalUserFromSession(result.session, name);
            continueTo(target);
          },
        });
        return;
      }

      if (!isLocalDemoMode()) {
        window.alert('Authentication is not configured for this production deployment yet.');
        return;
      }

      saveLocalMockUser({
        name,
        email,
      });
      continueTo(returnTo || './dashboard.html');
    } catch (error) {
      window.alert(error?.message || 'Unable to authenticate right now.');
    } finally {
      if (!navigationCommitted) resumeOptionalHydration();
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }
  });
}

// Resume a saved, verified session without creating a new password session.
// Callback/recovery URLs retain their existing dedicated flow.
const hasAuthCallback = (params) => [...params].some(([key, value]) =>
  ['code', 'token', 'token_hash', 'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token',
    'error', 'error_code', 'error_description'].includes(key.toLowerCase())
  || (key.toLowerCase() === 'type' && value.toLowerCase() === 'recovery'));
const callbackParams = [new URLSearchParams(window.location.search), new URLSearchParams(window.location.hash?.slice(1))];
const allowsSavedResume = (target) => {
  try {
    const url = new URL(target, window.location.origin);
    return !/\/(?:login|register|forgot-password|reset-password)(?:\.html)?\/?$/.test(url.pathname)
      && !hasAuthCallback(url.searchParams) && !hasAuthCallback(new URLSearchParams(url.hash.slice(1)));
  } catch { return false; }
};
const resumeTargetAllowed = allowsSavedResume(returnTo) && (!rawReturnTo || allowsSavedResume(rawReturnTo));
if (!signupPage && !callbackParams.some(hasAuthCallback) && resumeTargetAllowed
  && hasSupabaseAuthentication() && !hasPendingPasswordRecovery()) {
  void (async () => {
    const resumeOptionalHydration = authEntryTransition.begin();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    cancelSavedLogin = cancel;
    let session = null;
    let observedIdentity;
    let initialRefreshIdentity;
    let navigationCommitted = false;
    const status = document.getElementById('authResumeStatus');
    const assertCurrent = () => {
      if (controller.signal.aborted) throw mfaError('MFA_ACTOR_CHANGED');
    };
    // Subscribe before the first read so sign-out, recovery and A→B→A cannot
    // revive a saved decision. An ordinary initial refresh may supply session.
    const unsubscribe = subscribeToAuthStateChanges(({ event, user, sessionIdentity }) => {
      if (['SIGNED_OUT', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED'].includes(event)
        || (session && (event === 'TOKEN_REFRESHED' || user?.userId !== session.user.id
          || sessionIdentity !== authSessionIdentity(session)))
        || (observedIdentity !== undefined && observedIdentity !== sessionIdentity)) cancel();
      if (event === 'TOKEN_REFRESHED') {
        if (initialRefreshIdentity !== undefined || !sessionIdentity) cancel();
        initialRefreshIdentity = sessionIdentity;
      }
      observedIdentity = sessionIdentity;
    });
    window.addEventListener('pagehide', cancel);
    window.addEventListener('storage', cancel);
    const timeout = setTimeout(cancel, 10_000);
    const wait = async (operation) => {
      assertCurrent();
      let abort;
      const cancellation = new Promise((_, reject) => {
        abort = () => reject(mfaError('MFA_ACTOR_CHANGED'));
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      try { const value = await Promise.race([operation(), cancellation]); assertCurrent(); return value; }
      finally { controller.signal.removeEventListener('abort', abort); }
    };
    const confirmMfa = async () => {
      const state = await wait(() => getMfaAuthAdapter().getState({ expectedUserId: session.user.id }));
      if (!state.verified || state.requiresChallenge) throw mfaError('MFA_CHALLENGE_REQUIRED');
    };
    try {
      session = await wait(getAuthSession);
      if (!session?.user?.id || !session.access_token || !authSessionIdentity(session)) return;
      if (initialRefreshIdentity !== undefined && initialRefreshIdentity !== authSessionIdentity(session)) {
        throw mfaError('MFA_ACTOR_CHANGED');
      }
      if (status) { status.textContent = 'Checking your saved sign-in…'; status.hidden = false; }
      const state = await wait(() => getMfaAuthAdapter().getState({ expectedUserId: session.user.id }));
      const current = await wait(getAuthSession);
      if (current?.access_token !== session.access_token || authSessionIdentity(current) !== authSessionIdentity(session)) {
        throw mfaError('MFA_ACTOR_CHANGED');
      }
      assertCurrent();
      if (state.requiresChallenge) {
        window.location.replace(mfaChallengeHref(returnTo, window.location.origin));
        navigationCommitted = true;
      } else if (state.verified) {
        await finishAuthLanding({
          session, returnTo, getAuthSession, getSiteAdminContext, getBillingState,
          subscribeToAuthStateChanges, lifecycle: window, assertCurrent,
          beforeNavigate: confirmMfa, signal: controller.signal,
          navigate(target) {
            saveLocalUserFromSession(session);
            window.location.replace(target);
            navigationCommitted = true;
          },
        });
      }
    } catch {
      // The explicit login form remains retryable; never log provider payloads.
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      window.removeEventListener('pagehide', cancel);
      window.removeEventListener('storage', cancel);
      if (cancelSavedLogin === cancel) cancelSavedLogin = () => {};
      if (!navigationCommitted) {
        if (status) { status.textContent = ''; status.hidden = true; }
        resumeOptionalHydration();
      }
    }
  })();
}
initReveal();
