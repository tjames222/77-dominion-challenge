import { initReveal } from './reveal';
import {
  createCustomerPortalSession,
  getBillingState,
  getLocalOrSessionUser,
  getProfile,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
} from './api';

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
const themeOptions = [...document.querySelectorAll('[data-theme-mode]')];
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  themeOptions.forEach((option) => {
    const isActive = option.dataset.themeMode === theme;
    option.classList.toggle('active', isActive);
    option.setAttribute('aria-pressed', String(isActive));
  });
}
themeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    theme = option.dataset.themeMode || 'dark';
    save('dominion:theme', theme);
    applyTheme();
  });
});
applyTheme();

const profileNameEl = document.getElementById('profileName');
const profileEmailEl = document.getElementById('profileEmail');
const manageBillingButton = document.getElementById('profileManageBillingButton');

function updateBillingSummary(state) {
  document.getElementById('profileChallengeStatus').textContent = state.appAccess ? 'Status: Active' : 'Status: Subscription required';
  document.getElementById('profileBillingTitle').textContent = state.subscriptionActive
    ? 'Subscription active'
    : 'Subscription needed';
  document.getElementById('profileBillingCopy').textContent = state.subscriptionActive
    ? 'Your $7/month subscription is active, so the dashboard, daily actions, community, journal, and future member content stay open.'
    : 'Subscribe for $7/month to unlock the dashboard, daily action page, community, journal, and full tracking flow.';
  document.getElementById('profileSubscriptionPill').textContent = state.subscriptionActive ? 'Subscription active' : 'Subscription needed';
  manageBillingButton.hidden = !state.subscription;
}

async function hydrateProfile() {
  if (!hasSupabaseAuth() && isLocalDemoMode()) {
    const user = load('dominion:user', { name: 'Member', email: 'Logged in' });
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return;
    }
    if (profileNameEl) profileNameEl.textContent = user?.name || 'Member';
    if (profileEmailEl) profileEmailEl.textContent = user?.email || 'Logged in';
    updateBillingSummary(billing);
    return;
  }

  if (!hasSupabaseAuth()) {
    redirectToLogin('./profile.html');
    return;
  }

  try {
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return;
    }

    const sessionUser = await getLocalOrSessionUser();
    const profile = await getProfile();
    const syncedUser = {
      name: profile.name || sessionUser?.name || 'Member',
      email: profile.email || sessionUser?.email || 'Logged in',
      authenticated: true,
    };
    save('dominion:user', syncedUser);
    if (profileNameEl) profileNameEl.textContent = syncedUser.name;
    if (profileEmailEl) profileEmailEl.textContent = syncedUser.email;
    updateBillingSummary(billing);
  } catch (error) {
    console.warn('Unable to load profile from Supabase', error);
  }
}

manageBillingButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) return;
  const original = manageBillingButton.textContent;
  manageBillingButton.disabled = true;
  manageBillingButton.textContent = 'Opening...';
  try {
    const { url } = await createCustomerPortalSession();
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open the billing portal right now.');
    manageBillingButton.disabled = false;
    manageBillingButton.textContent = original;
  }
});

hydrateProfile();
initReveal();
