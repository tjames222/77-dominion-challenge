import {
  cancelMfaOperations, clearAuthSession, ensureProfile, getAuthSession, getBillingState,
  getLocalOrSessionUser, getMfaAuthAdapter, hasSupabaseAuth,
  hasSupabaseAuthentication, isLocalDemoMode, saveLocalUserFromSession,
  subscribeToAuthStateChanges,
} from './api';
import { mfaError } from './mfa-auth.mjs';
import { mfaReturnTo } from './mfa-navigation.mjs';
import { clearThemeEntitlementState, hydrateThemeEntitlementState } from './theme-entitlement-state';
import { finishProtectedThemeHydration, initThemeState } from './theme-state';

const byId = (id) => document.getElementById(`security${id}`);
const ui = Object.fromEntries(['Card', 'Title', 'Lead', 'Preview', 'Setup', 'Enrollment', 'Enroll', 'Qr', 'Key', 'Copy', 'VerifyForm', 'CodeTitle', 'FactorLabel', 'Factor', 'Code', 'Verify', 'Cancel', 'Success', 'SuccessCopy', 'Continue', 'Status', 'Retry', 'ProfileLink', 'SignOut'].map((id) => [id, byId(id)]));
const params = new URLSearchParams(window.location.search);
const mode = ['challenge', 'step-up'].includes(params.get('mode')) ? params.get('mode') : 'setup';
const returnTo = mfaReturnTo(params.get('returnTo') || (mode === 'setup' ? './profile.html' : './dashboard.html'), window.location.origin);
const live = hasSupabaseAuthentication();
const preview = !live && isLocalDemoMode();
let adapter = null;
let currentState = null;
let pendingFactor = '';
let generation = 0;
let disposed = false;
let setupTimeout = null;
let busy = false;
let observedSessionIdentity = '';

initThemeState();

function status(message = '', error = false) {
  ui.Status.textContent = message;
  ui.Status.dataset.error = String(error);
}
function setBusy(value) {
  busy = value;
  ui.Card.setAttribute('aria-busy', String(value));
  for (const element of [ui.Enroll, ui.Verify, ui.Code, ui.Factor, ui.Continue, ui.Retry, ui.Copy]) element.disabled = value;
}
function clearSetup() {
  cancelMfaOperations();
  clearTimeout(setupTimeout);
  setupTimeout = null;
  const factorId = pendingFactor;
  pendingFactor = '';
  ui.Key.value = '';
  ui.Code.value = '';
  ui.Qr.removeAttribute('src');
  ui.Enrollment.hidden = true;
  if (factorId && adapter && currentState?.userId) {
    // Only forget local ownership. Never race a hosted verified-factor removal.
    void adapter.cancelEnrollment({ expectedUserId: currentState.userId, factorId });
  }
}
function hidePanels() {
  for (const panel of [ui.Setup, ui.Enrollment, ui.VerifyForm, ui.Success, ui.Retry]) panel.hidden = true;
}
function assertCurrent(captured, actorId = currentState?.userId) {
  if (disposed || captured !== generation || (actorId && currentState?.userId !== actorId)) throw mfaError('MFA_ACTOR_CHANGED');
}
function showFailure(error, { retry = false } = {}) {
  const safe = mfaError(error?.code);
  status(safe.message, true);
  ui.Retry.hidden = !retry;
  if (['MFA_ACTOR_CHANGED', 'MFA_SIGNED_OUT'].includes(error?.code)) {
    generation += 1;
    clearSetup();
    currentState = null;
    hidePanels();
    ui.Retry.hidden = false;
    ui.ProfileLink.hidden = true;
    clearThemeEntitlementState();
    setBusy(false);
  }
}
function renderState(state, { justVerified = false } = {}) {
  currentState = state;
  hidePanels();
  ui.SignOut.hidden = false;
  ui.Preview.hidden = !state.preview;
  ui.ProfileLink.hidden = state.requiresChallenge;
  const challenge = state.requiresChallenge || (mode === 'step-up' && state.factors.length > 0 && !justVerified);
  if (challenge) {
    ui.Title.textContent = mode === 'step-up' ? 'Verify it’s you' : 'Verify your login';
    ui.Lead.textContent = 'Enter a code from your existing authenticator to continue. Your setup key is not needed.';
    ui.CodeTitle.textContent = 'Enter your authenticator code';
    ui.Factor.replaceChildren(...state.factors.map((factor) => new Option(factor.friendlyName, factor.id)));
    ui.FactorLabel.hidden = state.factors.length <= 1;
    ui.VerifyForm.hidden = false;
    ui.Cancel.textContent = 'Sign out instead';
    if (!state.factors.length) {
      ui.VerifyForm.hidden = true;
      showFailure(mfaError('MFA_FACTOR_UNAVAILABLE'), { retry: true });
    }
  } else if (state.verified) {
    ui.Title.textContent = 'Account security';
    ui.Lead.textContent = state.preview ? 'Your simulated authenticator is ready.' : 'Your account has an extra layer of protection.';
    ui.Success.hidden = false;
    ui.SuccessCopy.textContent = state.preview
      ? 'Simulation complete. No live authenticator or production account was changed.'
      : 'Your authenticator and this session have been verified. Keep your authenticator available for your next login.';
  } else {
    ui.Title.textContent = 'Account security';
    ui.Lead.textContent = 'Add a second verification step with a free authenticator app.';
    ui.Setup.hidden = false;
  }
  ui.Card.dataset.state = challenge ? 'challenge' : state.verified ? 'verified' : 'setup';
}

async function initialize() {
  const captured = ++generation;
  clearSetup();
  currentState = null;
  hidePanels();
  status();
  setBusy(true);
  try {
    if (!adapter) {
      if (live) adapter = getMfaAuthAdapter();
      else if (preview) {
        const { createPreviewMfaAdapter } = await import('./mfa-preview.mjs');
        assertCurrent(captured);
        adapter = createPreviewMfaAdapter({ getUser: getLocalOrSessionUser, challenge: mode === 'challenge', stepUp: mode === 'step-up' });
      } else throw mfaError('MFA_UNAVAILABLE');
    }
    const state = await adapter.getState();
    assertCurrent(captured);
    renderState(state);
    if (!state.requiresChallenge || preview) {
      // Reward-theme authorization still comes from the existing actor-fenced
      // entitlement path; no protected reads occur during live AAL1 challenge.
      void hydrateThemeEntitlementState({ expectedUserId: state.userId });
    } else {
      clearThemeEntitlementState();
      finishProtectedThemeHydration();
    }
  } catch (error) {
    if (captured !== generation || disposed) return;
    if (error?.code === 'MFA_SIGNED_OUT') {
      const target = mode === 'setup' ? './account-security.html' : returnTo;
      window.location.replace(`./login.html?returnTo=${encodeURIComponent(target)}`);
      return;
    }
    showFailure(error, { retry: true });
    finishProtectedThemeHydration();
  } finally {
    if (captured === generation && !disposed) setBusy(false);
  }
}

ui.Enroll.addEventListener('click', async () => {
  if (busy || !currentState || currentState.requiresChallenge || currentState.factors.length) return;
  const captured = ++generation;
  const actorId = currentState.userId;
  clearSetup();
  status('Preparing your private setup key…');
  setBusy(true);
  try {
    const enrollment = await adapter.enroll({ expectedUserId: actorId });
    if (disposed || captured !== generation) {
      void adapter.cancelEnrollment({ expectedUserId: actorId, factorId: enrollment.factorId });
      return;
    }
    pendingFactor = enrollment.factorId;
    const { default: QRCode } = await import('qrcode');
    assertCurrent(captured, actorId);
    // Render a local, inert PNG rather than inserting provider SVG markup.
    // The URI/secret remain transient; neither is written to a URL or storage.
    const qr = await QRCode.toDataURL(`otpauth://totp/77%20Dominion:${encodeURIComponent(actorId.slice(0, 8))}?secret=${encodeURIComponent(enrollment.secret)}&issuer=77%20Dominion&algorithm=SHA1&digits=6&period=30`, { width: 240, margin: 2, errorCorrectionLevel: 'M' });
    assertCurrent(captured, actorId);
    ui.Key.value = enrollment.secret;
    ui.Qr.src = qr;
    hidePanels();
    ui.Enrollment.hidden = false;
    ui.VerifyForm.hidden = false;
    ui.FactorLabel.hidden = true;
    ui.CodeTitle.textContent = '2. Confirm the code from your app';
    ui.Cancel.textContent = 'Cancel setup';
    ui.Card.dataset.state = 'enrolling';
    status('Add the account to your authenticator, then enter its six-digit code below.');
    ui.Title.focus();
    setupTimeout = setTimeout(() => {
      generation += 1;
      clearSetup();
      renderState(currentState);
      setBusy(false);
      status('The setup key was cleared from this page for privacy. Start a fresh setup when you are ready. No existing authenticator was removed.');
    }, 10 * 60 * 1000);
  } catch (error) {
    if (captured !== generation || disposed) return;
    clearSetup();
    showFailure(error, { retry: true });
  } finally {
    if (captured === generation && !disposed) setBusy(false);
  }
});

ui.Copy.addEventListener('click', async () => {
  if (!ui.Key.value || busy) return;
  const captured = generation;
  try {
    await navigator.clipboard.writeText(ui.Key.value);
    assertCurrent(captured);
    status('Setup key copied. Paste it only into your authenticator, then clear your clipboard.');
  } catch {
    if (captured !== generation || disposed) return;
    ui.Key.focus();
    ui.Key.select();
    status('Copy is unavailable here. The setup key is selected so you can copy it manually.');
  }
});

ui.VerifyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !currentState) return;
  const captured = ++generation;
  const actorId = currentState.userId;
  const code = ui.Code.value.trim();
  const factorId = pendingFactor || ui.Factor.value;
  ui.Code.value = '';
  status('Verifying with your secure session…');
  setBusy(true);
  try {
    const state = await adapter.verify({ expectedUserId: actorId, factorId, code });
    assertCurrent(captured, actorId);
    if (!state.verified) throw mfaError('MFA_NOT_CONFIRMED');
    clearSetup();
    renderState(state, { justVerified: true });
    status(state.preview ? 'Simulation verified. Your live account is unchanged.' : 'Verification confirmed.');
    void hydrateThemeEntitlementState({ expectedUserId: actorId });
    ui.Title.focus();
  } catch (error) {
    if (captured !== generation || disposed) return;
    if (error?.factorVerified && pendingFactor) {
      clearSetup();
      try {
        const state = await adapter.getState({ expectedUserId: actorId });
        assertCurrent(captured, actorId);
        renderState(state);
      } catch (stateError) {
        if (captured === generation && !disposed) showFailure(stateError, { retry: true });
        return;
      }
    }
    showFailure(error);
  } finally {
    if (captured === generation && !disposed) {
      setBusy(false);
      if (!ui.VerifyForm.hidden) ui.Code.focus();
    }
  }
});

async function signOut() {
  generation += 1;
  clearSetup();
  hidePanels();
  currentState = null;
  setBusy(true);
  clearThemeEntitlementState();
  try {
    await clearAuthSession();
    window.location.replace('./login.html');
  } catch {
    status('Sign out could not be confirmed. Retry signing out before leaving this device.', true);
    setBusy(false);
  }
}
ui.SignOut.addEventListener('click', signOut);
ui.Cancel.addEventListener('click', () => {
  if (!pendingFactor) { void signOut(); return; }
  generation += 1;
  clearSetup();
  renderState(currentState);
  setBusy(false);
  status('Setup closed and its key cleared from this page. No existing authenticator was removed.');
  ui.Enroll.focus();
});
ui.Retry.addEventListener('click', () => { void initialize(); });

ui.Continue.addEventListener('click', async () => {
  if (busy || !currentState?.verified) return;
  const captured = ++generation;
  const actorId = currentState.userId;
  setBusy(true);
  status('Opening your account…');
  try {
    const state = await adapter.getState({ expectedUserId: actorId });
    assertCurrent(captured, actorId);
    if (!state.verified || state.requiresChallenge) throw mfaError('MFA_CHALLENGE_REQUIRED');
    if (live) {
      const session = await getAuthSession();
      assertCurrent(captured, actorId);
      if (session?.user?.id !== actorId || !session?.access_token) throw mfaError('MFA_ACTOR_CHANGED');
      if (hasSupabaseAuth()) await ensureProfile({ expectedUserId: actorId });
      assertCurrent(captured, actorId);
      saveLocalUserFromSession(session);
    }
    let target = returnTo;
    if (live && target === './dashboard.html') {
      const billing = await getBillingState();
      assertCurrent(captured, actorId);
      if (!billing.appAccess) target = './billing.html';
    }
    // Reconfirm identity/assurance immediately before leaving the Auth-only UI.
    const confirmed = await adapter.getState({ expectedUserId: actorId });
    assertCurrent(captured, actorId);
    if (!confirmed.verified || confirmed.requiresChallenge) throw mfaError('MFA_CHALLENGE_REQUIRED');
    window.location.assign(target);
  } catch (error) {
    if (captured === generation && !disposed) showFailure(error, { retry: true });
  } finally {
    if (captured === generation && !disposed) setBusy(false);
  }
});

// Synchronous identity cleanup only. Never await/call Supabase inside its Auth
// observer (the provider holds an internal auth lock while dispatching it).
const unsubscribe = subscribeToAuthStateChanges(({ event, user, sessionIdentity }) => {
  const changedSession = observedSessionIdentity && sessionIdentity !== observedSessionIdentity;
  observedSessionIdentity = sessionIdentity || '';
  if (event === 'SIGNED_OUT' || changedSession || (currentState?.userId && user?.userId !== currentState.userId)) {
    generation += 1;
    clearSetup();
    currentState = null;
    hidePanels();
    ui.ProfileLink.hidden = true;
    clearThemeEntitlementState();
    setBusy(false);
    status('The signed-in account changed. Reload account security to continue.', true);
    ui.Retry.hidden = false;
  }
});
window.addEventListener('storage', (event) => {
  if (!preview || !['dominion:user', 'dominion:mockUserId'].includes(event.key)) return;
  generation += 1;
  clearSetup();
  adapter?.dispose();
  adapter = null;
  currentState = null;
  hidePanels();
  ui.ProfileLink.hidden = true;
  setBusy(false);
  status('The preview account changed. Reload account security to continue.', true);
  ui.Retry.hidden = false;
});
window.addEventListener('pagehide', () => {
  disposed = true;
  generation += 1;
  clearSetup();
  unsubscribe();
  if (preview) adapter?.dispose();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
void initialize();
