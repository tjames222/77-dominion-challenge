import { initReveal } from './reveal';
import {
  createCustomerPortalSession,
  getBillingState,
  getProfile,
  hasSupabaseAuth,
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

const user = load('dominion:user', { name: 'Member', email: 'Logged in' });
document.getElementById('profileName').textContent = user?.name || 'Member';
document.getElementById('profileEmail').textContent = user?.email || 'Logged in';
const manageBillingButton = document.getElementById('profileManageBillingButton');

function updateBillingSummary(state) {
  document.getElementById('profileChallengeStatus').textContent = state.challengeAccess ? 'Status: Active' : 'Status: Locked';
  document.getElementById('profileBillingTitle').textContent = state.membershipActive
    ? 'Challenge and membership active'
    : state.challengeAccess
      ? 'Challenge active'
      : 'Billing needed';
  document.getElementById('profileBillingCopy').textContent = state.membershipActive
    ? 'Your monthly membership is active, so premium community and future challenge content stay open.'
    : state.challengeAccess
      ? 'Your flagship challenge is unlocked. Add membership when you want premium community and fresh programs after day 77.'
      : 'Buy the 77-day challenge to unlock the dashboard, daily action page, and full tracking flow.';
  document.getElementById('profileChallengePill').textContent = state.challengeAccess ? 'Challenge unlocked' : 'Challenge locked';
  document.getElementById('profileMembershipPill').textContent = state.membershipActive ? 'Membership active' : 'Membership inactive';
  manageBillingButton.hidden = !state.challengePurchase && !state.membershipSubscription;
}

async function hydrateProfile() {
  if (!hasSupabaseAuth()) {
    updateBillingSummary({
      challengeAccess: true,
      membershipActive: false,
      challengePurchase: null,
      membershipSubscription: null,
    });
    return;
  }

  try {
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return;
    }

    const profile = await getProfile();
    const syncedUser = {
      name: profile.name || 'Member',
      email: profile.email || 'Logged in',
      authenticated: true,
    };
    save('dominion:user', syncedUser);
    document.getElementById('profileName').textContent = syncedUser.name;
    document.getElementById('profileEmail').textContent = syncedUser.email;
    updateBillingSummary(billing);
  } catch (error) {
    console.warn('Unable to load profile from Supabase', error);
  }
}

manageBillingButton?.addEventListener('click', async () => {
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
