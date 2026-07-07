import {
  createCheckoutSession,
  createCustomerPortalSession,
  formatCurrency,
  formatDateLabel,
  getBillingState,
  hasSupabaseAuth,
  redirectToLogin,
} from './api';
import { initReveal } from './reveal';

const FEEDBACK = {
  challenge_77: {
    success: 'Payment received. We are unlocking your 77-day challenge access now.',
    canceled: 'Checkout was canceled. Your challenge spot is still waiting for you.',
  },
  dominion_membership: {
    success: 'Membership purchase received. We are syncing your premium access now.',
    canceled: 'Membership checkout was canceled. You can come back anytime.',
  },
};

const challengeButton = document.getElementById('challengeCheckoutButton');
const membershipButton = document.getElementById('membershipCheckoutButton');
const manageBillingButton = document.getElementById('manageBillingButton');
const billingStatusTitle = document.getElementById('billingStatusTitle');
const billingStatusCopy = document.getElementById('billingStatusCopy');
const billingFeedback = document.getElementById('billingFeedback');
const challengeStatusPill = document.getElementById('challengeStatusPill');
const membershipStatusPill = document.getElementById('membershipStatusPill');
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
  const challengeDate = state.challengePurchase?.purchasedAt ? formatDateLabel(state.challengePurchase.purchasedAt) : null;
  const membershipDate = state.membershipSubscription?.currentPeriodEnd
    ? formatDateLabel(state.membershipSubscription.currentPeriodEnd)
    : null;

  if (billingDashboardLink) billingDashboardLink.hidden = !state.challengeAccess;
  if (challengeStatusPill) challengeStatusPill.textContent = state.challengeAccess ? 'Challenge unlocked' : 'Challenge locked';
  if (membershipStatusPill) membershipStatusPill.textContent = state.membershipActive ? 'Membership active' : 'Membership inactive';

  if (state.challengeAccess && state.membershipActive) {
    billingStatusTitle.textContent = 'You have both the challenge and membership active.';
    billingStatusCopy.textContent = membershipDate
      ? `Your membership is active through ${membershipDate}. Keep moving after the 77-day challenge with new programs and premium community.`
      : 'Your flagship challenge and membership are both active.';
  } else if (state.challengeAccess) {
    billingStatusTitle.textContent = 'Your 77-day challenge is unlocked.';
    billingStatusCopy.textContent = challengeDate
      ? `Challenge access was purchased on ${challengeDate}. Membership is optional if you want fresh programs and premium community after day 77.`
      : 'Challenge access is active. Membership is optional if you want fresh programs and premium community after day 77.';
  } else {
    billingStatusTitle.textContent = 'Challenge access is still locked.';
    billingStatusCopy.textContent = 'Buy the flagship challenge to unlock the dashboard, daily action page, and your full 77-day tracking flow.';
  }

  if (challengeButton) {
    challengeButton.disabled = state.challengeAccess;
    challengeButton.textContent = state.challengeAccess
      ? `Challenge unlocked${state.challengePurchase?.amountTotal ? ` · ${formatCurrency(state.challengePurchase.amountTotal, state.challengePurchase.currency)}` : ''}`
      : 'Join the 77 for $77';
  }

  if (membershipButton) {
    membershipButton.disabled = state.membershipActive;
    membershipButton.textContent = state.membershipActive
      ? `Membership active${membershipDate ? ` · renews ${membershipDate}` : ''}`
      : 'Unlock membership';
  }

  if (manageBillingButton) manageBillingButton.hidden = !state.challengePurchase && !state.membershipSubscription;
}

async function pollAfterCheckout(productKey) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await getBillingState();
    renderStatus(state);
    const satisfied = productKey === 'challenge_77' ? state.challengeAccess : state.membershipActive;
    if (satisfied) return state;
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  return getBillingState();
}

async function hydrateBillingPage() {
  if (!hasSupabaseAuth()) {
    billingStatusTitle.textContent = 'Billing is bypassed in local demo mode.';
    billingStatusCopy.textContent = 'Supabase or Stripe is not configured here, so the challenge stays open for local development.';
    if (challengeStatusPill) challengeStatusPill.textContent = 'Challenge open';
    if (membershipStatusPill) membershipStatusPill.textContent = 'Membership unavailable';
    if (challengeButton) challengeButton.textContent = 'Open dashboard';
    if (membershipButton) membershipButton.hidden = true;
    if (manageBillingButton) manageBillingButton.hidden = true;
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
  const productKey = searchParams.get('product');
  if (checkoutStatus && productKey && billingFeedback) {
    billingFeedback.textContent = FEEDBACK[productKey]?.[checkoutStatus] || '';
    if (checkoutStatus === 'success') {
      const settledState = await pollAfterCheckout(productKey);
      renderStatus(settledState);
      if (productKey === 'challenge_77' && settledState.challengeAccess) {
        billingFeedback.textContent = 'Challenge unlocked. Taking you to the dashboard.';
        window.setTimeout(() => {
          window.location.href = './dashboard.html';
        }, 1200);
      }
    }
  }
}

challengeButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth()) {
    window.location.href = './dashboard.html';
    return;
  }
  const release = setButtonBusy(challengeButton, 'Opening checkout...');
  try {
    const { url } = await createCheckoutSession('challenge_77');
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open checkout right now.');
    release();
  }
});

membershipButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth()) return;
  const release = setButtonBusy(membershipButton, 'Opening checkout...');
  try {
    const { url } = await createCheckoutSession('dominion_membership');
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open membership checkout right now.');
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
  if (billingStatusCopy) billingStatusCopy.textContent = 'We could not load your access state right now. Try refreshing in a moment.';
});

initReveal();
