import { initReveal } from './reveal';
import { authEntryTransition } from './auth-entry-transition.mjs';
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
  hasSupabaseAuthentication,
  isLocalDemoMode,
  saveLocalMockUser,
  saveLocalUserFromSession,
  sanitizeReturnTo,
  signInWithPassword,
  signUpWithPassword,
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
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
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

        saveLocalUserFromSession(result.session, name);
        if (returnTo && returnTo !== './dashboard.html') {
          continueTo(returnTo);
          return;
        }

        const billing = await getBillingState();
        continueTo(billing.appAccess ? './dashboard.html' : './billing.html');
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

// A user returning to Login mid-challenge keeps the pending second-factor flow.
if (!signupPage && hasSupabaseAuthentication()) {
  void (async () => {
    try {
      const session = await getAuthSession();
      if (!session?.user?.id) return;
      const state = await getMfaAuthAdapter().getState({ expectedUserId: session.user.id });
      if (state.requiresChallenge) window.location.replace(mfaChallengeHref(returnTo, window.location.origin));
    } catch {
      // The explicit login form remains retryable; never log provider payloads.
    }
  })();
}
initReveal();
