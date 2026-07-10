import {
  cancelMembership,
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
const paymentMethodButton = document.getElementById('paymentMethodButton');
const cancelMembershipButton = document.getElementById('cancelMembershipButton');
const billingHeroStep = document.getElementById('billingHeroStep');
const billingHeroTitle = document.getElementById('billingHeroTitle');
const billingHeroLead = document.getElementById('billingHeroLead');
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
  const isPreviewBilling = state.billingEnabled === false;

  if (billingHeroStep) billingHeroStep.textContent = state.subscriptionActive ? 'Membership active' : 'Step 2 of 2';
  if (billingHeroTitle) billingHeroTitle.textContent = state.subscriptionActive ? 'You are signed up.' : 'Activate the rhythm.';
  if (billingHeroLead) {
    billingHeroLead.textContent = state.subscriptionActive
      ? 'Your Dominion membership is active. The dashboard, daily standard, community, journal, and member tools are open.'
      : 'You are one step from the dashboard, the daily standard, and the accountability that helps discipline turn into a new normal.';
  }

  if (billingDashboardLink) billingDashboardLink.hidden = !state.appAccess;
  if (subscriptionStatusPill) {
    subscriptionStatusPill.textContent = isPreviewBilling
      ? 'Preview mock'
      : state.subscriptionActive ? 'Subscription active' : 'Subscription needed';
  }

  if (state.subscriptionActive && isPreviewBilling) {
    billingStatusTitle.textContent = 'Preview membership is active.';
    billingStatusCopy.textContent = renewalDate
      ? `Your mock $7/month membership is active through ${renewalDate}. Dashboard, daily actions, community, and journal are open in this preview.`
      : 'Your mock $7/month membership is active. Dashboard, daily actions, community, and journal are open in this preview.';
  } else if (state.subscriptionActive) {
    billingStatusTitle.textContent = 'Your Dominion subscription is active.';
    billingStatusCopy.textContent = renewalDate
      ? `Your $7/month subscription is active through ${renewalDate}. Dashboard, daily actions, community, and journal are open.`
      : 'Your $7/month subscription is active. Dashboard, daily actions, community, and journal are open.';
  } else if (isPreviewBilling) {
    billingStatusTitle.textContent = 'Preview membership checkout.';
    billingStatusCopy.textContent = 'Activate a mock $7/month membership to test the dashboard, daily actions, community, and journal without touching Stripe.';
  } else {
    billingStatusTitle.textContent = 'Finish setup and start the work.';
    billingStatusCopy.textContent = 'Activate membership for $7/month. You are one step from the tools that help daily decisions become lasting discipline.';
  }

  if (subscriptionButton) {
    subscriptionButton.disabled = state.subscriptionActive;
    subscriptionButton.textContent = state.subscriptionActive
      ? `${isPreviewBilling ? 'Preview active' : 'Subscribed'}${renewalDate ? ` · renews ${renewalDate}` : ''}`
      : isPreviewBilling ? 'Activate preview membership' : 'Activate membership';
  }

  if (manageBillingButton) manageBillingButton.hidden = !state.subscription;
  if (paymentMethodButton) {
    paymentMethodButton.hidden = false;
    paymentMethodButton.textContent = state.subscriptionActive ? 'Edit payment information' : 'Add payment information';
  }
  if (cancelMembershipButton) cancelMembershipButton.hidden = !state.subscriptionActive;
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
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
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
  const paymentStatus = searchParams.get('payment');
  const canceledStatus = searchParams.get('membership');
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
  if (paymentStatus === 'updated' && billingFeedback) {
    billingFeedback.textContent = 'Payment information updated in Stripe.';
  }
  if (canceledStatus === 'canceled' && billingFeedback) {
    billingFeedback.textContent = 'Membership canceled. App access has been removed.';
  }
}

subscriptionButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin('./billing.html');
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
  if (!hasSupabaseAuth() && !isLocalDemoMode()) return;
  const release = setButtonBusy(manageBillingButton, 'Opening portal...');
  try {
    const { url } = await createCustomerPortalSession();
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open billing portal right now.');
    release();
  }
});

paymentMethodButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin('./billing.html');
    return;
  }
  const release = setButtonBusy(paymentMethodButton, 'Opening Stripe...');
  try {
    const { url } = await createCustomerPortalSession({
      flow: 'payment_method_update',
      returnPath: './billing.html?payment=updated',
    });
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open payment information right now.');
    release();
  }
});

cancelMembershipButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) return;
  const confirmed = window.confirm('Cancel your membership now? This removes access to the dashboard, daily actions, community, and journal immediately.');
  if (!confirmed) return;

  const release = setButtonBusy(cancelMembershipButton, 'Canceling...');
  try {
    await cancelMembership();
    const state = await getBillingState();
    renderStatus(state);
    if (billingFeedback) billingFeedback.textContent = 'Membership canceled. App access has been removed.';
  } catch (error) {
    window.alert(error?.message || 'Unable to cancel membership right now.');
  } finally {
    release();
  }
});

hydrateBillingPage().catch((error) => {
  console.warn('Unable to hydrate billing page', error);
  if (billingStatusTitle) billingStatusTitle.textContent = 'Billing is temporarily unavailable.';
  if (billingStatusCopy) billingStatusCopy.textContent = 'We could not load your subscription state right now. Try refreshing in a moment.';
});

initReveal();
