import {
  createCheckoutSession,
  createCustomerPortalSession,
  formatDateLabel,
  getBillingState,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
} from './api';
import { initReveal } from './reveal';

const SUBSCRIPTION_PRODUCT_KEY = 'dominion_membership';

const FEEDBACK = {
  success: 'Subscription received. We are syncing your access now.',
  canceled: 'Checkout was canceled. You can come back anytime.',
};

const subscriptionButton = document.getElementById('subscriptionCheckoutButton');
const manageBillingButton = document.getElementById('manageBillingButton');
const billingStatusTitle = document.getElementById('billingStatusTitle');
const billingStatusCopy = document.getElementById('billingStatusCopy');
const billingFeedback = document.getElementById('billingFeedback');
const subscriptionStatusPill = document.getElementById('subscriptionStatusPill');
const billingDashboardLink = document.getElementById('billingDashboardLink');

function setButtonBusy(button, label) {
  if (!button) return () => {};
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

function renderStatus(state) {
  const renewalDate = state.subscription?.currentPeriodEnd
    ? formatDateLabel(state.subscription.currentPeriodEnd)
    : null;

  if (billingDashboardLink) billingDashboardLink.hidden = !state.appAccess;
  if (subscriptionStatusPill) {
    subscriptionStatusPill.textContent = state.subscriptionActive ? 'Subscription active' : 'Subscription needed';
  }

  if (state.subscriptionActive) {
    billingStatusTitle.textContent = 'Your Dominion subscription is active.';
    billingStatusCopy.textContent = renewalDate
      ? `Your $7/month subscription is active through ${renewalDate}. Dashboard, daily actions, community, and journal are open.`
      : 'Your $7/month subscription is active. Dashboard, daily actions, community, and journal are open.';
  } else {
    billingStatusTitle.textContent = 'Finish setup and start the work.';
    billingStatusCopy.textContent = 'Activate membership for $7/month. You are one step from the tools that help daily decisions become lasting discipline.';
  }

  if (subscriptionButton) {
    subscriptionButton.disabled = state.subscriptionActive;
    subscriptionButton.textContent = state.subscriptionActive
      ? `Subscribed${renewalDate ? ` · renews ${renewalDate}` : ''}`
      : 'Activate membership';
  }

  if (manageBillingButton) manageBillingButton.hidden = !state.subscription;
}

async function pollAfterCheckout() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await getBillingState();
    renderStatus(state);
    if (state.subscriptionActive) return state;
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  return getBillingState();
}

async function hydrateBillingPage() {
  if (!hasSupabaseAuth() && isLocalDemoMode()) {
    billingStatusTitle.textContent = 'Billing is bypassed in local demo mode.';
    billingStatusCopy.textContent = 'Supabase or Stripe is not configured here, so the app stays open for local development.';
    if (subscriptionStatusPill) subscriptionStatusPill.textContent = 'Local demo';
    if (subscriptionButton) subscriptionButton.textContent = 'Open dashboard';
    if (manageBillingButton) manageBillingButton.hidden = true;
    return;
  }

  if (!hasSupabaseAuth()) {
    redirectToLogin('./billing.html');
    return;
  }

  const initialState = await getBillingState();
  if (!initialState.authenticated) {
    redirectToLogin('./billing.html');
    return;
  }

  renderStatus(initialState);

  const searchParams = new URLSearchParams(window.location.search);
  const checkoutStatus = searchParams.get('checkout');
  if (checkoutStatus && billingFeedback) {
    billingFeedback.textContent = FEEDBACK[checkoutStatus] || '';
    if (checkoutStatus === 'success') {
      const settledState = await pollAfterCheckout();
      renderStatus(settledState);
      if (settledState.appAccess) {
        billingFeedback.textContent = 'Subscription active. Taking you to the dashboard.';
        window.setTimeout(() => {
          window.location.href = './dashboard.html';
        }, 1200);
      }
    }
  }
}

subscriptionButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth()) {
    window.location.href = './dashboard.html';
    return;
  }
  const release = setButtonBusy(subscriptionButton, 'Opening checkout...');
  try {
    const { url } = await createCheckoutSession(SUBSCRIPTION_PRODUCT_KEY);
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open checkout right now.');
    release();
  }
});

manageBillingButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth()) return;
  const release = setButtonBusy(manageBillingButton, 'Opening portal...');
  try {
    const { url } = await createCustomerPortalSession();
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open billing portal right now.');
    release();
  }
});

hydrateBillingPage().catch((error) => {
  console.warn('Unable to hydrate billing page', error);
  if (billingStatusTitle) billingStatusTitle.textContent = 'Billing is temporarily unavailable.';
  if (billingStatusCopy) billingStatusCopy.textContent = 'We could not load your subscription state right now. Try refreshing in a moment.';
});

initReveal();
