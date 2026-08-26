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
import { RELEASE_GATES } from './release-gates.mjs';
import { INVITE_PAGE_PATH, getStoredInviteContinuation } from './invite-flow.mjs';
import {
  CHALLENGE_START_INTENT_PATH,
  readChallengeStartIntent,
} from './challenge-start-intent.mjs';

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
const billingOfferEyebrow = document.getElementById('billingOfferEyebrow');
const billingOfferTitle = document.getElementById('billingOfferTitle');
const billingOfferCopy = document.getElementById('billingOfferCopy');
const billingPolicyEyebrow = document.getElementById('billingPolicyEyebrow');
const billingPolicyTitle = document.getElementById('billingPolicyTitle');
const billingPolicyCopy = document.getElementById('billingPolicyCopy');

function renderOpenBillingShell() {
  if (!RELEASE_GATES.billingEnabled) return;
  if (billingHeroStep) billingHeroStep.textContent = 'Step 2 of 2';
  if (billingHeroTitle) billingHeroTitle.textContent = 'Activate your membership.';
  if (billingHeroLead) {
    billingHeroLead.textContent = 'Subscribe to open the dashboard, daily actions, private groups, and private journal.';
  }
  if (billingStatusTitle) billingStatusTitle.textContent = 'Checking your access...';
  if (billingStatusCopy) billingStatusCopy.textContent = 'Loading your subscription status…';
  if (subscriptionStatusPill) subscriptionStatusPill.textContent = 'Subscription needed';
  if (billingDashboardLink) billingDashboardLink.hidden = false;
  if (subscriptionButton) subscriptionButton.hidden = false;
  if (paymentMethodButton) paymentMethodButton.hidden = false;
  if (billingOfferEyebrow) billingOfferEyebrow.textContent = 'Dominion Subscription';
  if (billingOfferTitle) billingOfferTitle.textContent = '$7 per month';
  if (billingOfferCopy) {
    billingOfferCopy.textContent = 'Finish setup to use the challenge, dashboard, daily action pages, private groups, and private journal.';
  }
  if (billingPolicyEyebrow) billingPolicyEyebrow.textContent = 'Billing Help';
  if (billingPolicyTitle) billingPolicyTitle.textContent = 'Know what happens before you subscribe or cancel.';
  if (billingPolicyCopy) {
    billingPolicyCopy.textContent = 'Membership renews monthly until canceled. Under the current flow, cancellation removes paid access immediately.';
  }
}

function continuationDestination() {
  if (getStoredInviteContinuation(sessionStorage)) return INVITE_PAGE_PATH;
  if (readChallengeStartIntent(sessionStorage)) return CHALLENGE_START_INTENT_PATH;
  return './dashboard.html';
}

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
  const billingOpen = RELEASE_GATES.billingEnabled;

  if (!billingOpen) {
    if (billingHeroStep) billingHeroStep.textContent = 'Invite-only early access';
    if (billingHeroTitle) {
      billingHeroTitle.textContent = state.appAccess
        ? 'Your early access is active.'
        : 'Dominion is opening gradually.';
    }
    if (billingHeroLead) {
      billingHeroLead.textContent = state.appAccess
        ? 'This invited account can use the dashboard, Daily Actions, private groups, journal, and other member tools.'
        : 'We are starting with a small invited group. Billing is not open yet.';
    }
    if (billingDashboardLink) {
      billingDashboardLink.hidden = !state.appAccess;
      billingDashboardLink.href = continuationDestination();
      billingDashboardLink.textContent = getStoredInviteContinuation(sessionStorage)
        ? 'Return to invitation'
        : readChallengeStartIntent(sessionStorage)
          ? 'Continue Group challenge start'
          : 'Go to dashboard';
    }
    if (subscriptionStatusPill) {
      subscriptionStatusPill.textContent = state.appAccess
        ? 'Early access active'
        : 'Invitation required';
    }
    if (billingStatusTitle) {
      billingStatusTitle.textContent = state.appAccess
        ? 'This account has early access.'
        : 'This account does not have early access yet.';
    }
    if (billingStatusCopy) {
      billingStatusCopy.textContent = state.appAccess
        ? 'You’re all set. This invited account is approved for early access.'
        : 'If you were invited, make sure you logged in with the same email. Otherwise, check back when early access opens more broadly.';
    }
    if (subscriptionButton) subscriptionButton.hidden = true;
    if (manageBillingButton) manageBillingButton.hidden = true;
    if (paymentMethodButton) paymentMethodButton.hidden = true;
    if (cancelMembershipButton) cancelMembershipButton.hidden = true;
    if (billingOfferEyebrow) billingOfferEyebrow.textContent = 'Early access';
    if (billingOfferTitle) billingOfferTitle.textContent = 'Invitations are opening in small groups.';
    if (billingOfferCopy) {
      billingOfferCopy.textContent = 'If you have been invited, log in with the email connected to that account. We’ll open membership billing after the first invited group is running smoothly.';
    }
    if (billingPolicyEyebrow) billingPolicyEyebrow.textContent = 'Early-access help';
    if (billingPolicyTitle) billingPolicyTitle.textContent = 'Need help with an invitation?';
    if (billingPolicyCopy) {
      billingPolicyCopy.textContent = 'Use Support if an invited account is not recognized. No payment is needed during early access.';
    }
    return;
  }

  if (billingOfferEyebrow) billingOfferEyebrow.textContent = 'Dominion Subscription';
  if (billingOfferTitle) billingOfferTitle.textContent = '$7 per month';
  if (billingOfferCopy) {
    billingOfferCopy.textContent = 'Finish setup to use the challenge, dashboard, daily action pages, private groups, and private journal.';
  }
  if (billingPolicyEyebrow) billingPolicyEyebrow.textContent = 'Billing Help';
  if (billingPolicyTitle) billingPolicyTitle.textContent = 'Know what happens before you subscribe or cancel.';
  if (billingPolicyCopy) {
    billingPolicyCopy.textContent = 'Membership renews monthly until canceled. Under the current flow, cancellation removes paid access immediately.';
  }

  if (billingHeroStep) billingHeroStep.textContent = state.subscriptionActive ? 'Membership active' : 'Step 2 of 2';
  if (billingHeroTitle) billingHeroTitle.textContent = state.subscriptionActive ? 'Your membership is active.' : 'Activate your membership.';
  if (billingHeroLead) {
    billingHeroLead.textContent = state.subscriptionActive
      ? 'Your Dominion membership is active. You can use the dashboard, Daily Actions, private groups, journal, and other member tools.'
      : 'Subscribe to open the dashboard, Daily Actions, private groups, and private journal.';
  }

  if (billingDashboardLink) {
    billingDashboardLink.hidden = !state.appAccess;
    billingDashboardLink.href = continuationDestination();
    billingDashboardLink.textContent = getStoredInviteContinuation(sessionStorage)
      ? 'Return to invitation'
      : readChallengeStartIntent(sessionStorage)
        ? 'Continue Group challenge start'
        : 'Go to dashboard';
  }
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
    billingStatusTitle.textContent = 'Finish setting up your membership.';
    billingStatusCopy.textContent = 'Activate membership for $7/month to use all member features.';
  }

  if (subscriptionButton) {
    subscriptionButton.hidden = false;
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
  if (RELEASE_GATES.billingEnabled && checkoutStatus && billingFeedback) {
    billingFeedback.textContent = FEEDBACK[checkoutStatus] || '';
    if (checkoutStatus === 'success') {
      const settledState = await pollAfterCheckout();
      renderStatus(settledState);
      if (settledState.appAccess) {
        billingFeedback.textContent = 'Subscription active. Taking you to the dashboard.';
        window.setTimeout(() => {
          window.location.href = continuationDestination();
        }, 1200);
      }
    }
  }
  if (RELEASE_GATES.billingEnabled && paymentStatus === 'updated' && billingFeedback) {
    billingFeedback.textContent = 'Payment information updated in Stripe.';
  }
  if (RELEASE_GATES.billingEnabled && canceledStatus === 'canceled' && billingFeedback) {
    billingFeedback.textContent = 'Membership canceled. App access has been removed.';
  }
}

subscriptionButton?.addEventListener('click', async () => {
  if (!RELEASE_GATES.billingEnabled) return;
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
  if (!RELEASE_GATES.billingEnabled) return;
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
  if (!RELEASE_GATES.billingEnabled) return;
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
  if (!RELEASE_GATES.billingEnabled) return;
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

renderOpenBillingShell();
hydrateBillingPage().catch((error) => {
  console.warn('Unable to hydrate billing page', error);
  if (billingStatusTitle) {
    billingStatusTitle.textContent = RELEASE_GATES.billingEnabled
      ? 'Billing is temporarily unavailable.'
      : 'Access is temporarily unavailable.';
  }
  if (billingStatusCopy) {
    billingStatusCopy.textContent = RELEASE_GATES.billingEnabled
      ? 'We could not load your subscription state right now. Try refreshing in a moment.'
      : 'We could not verify this account’s early access right now. Try refreshing in a moment.';
  }
});

initReveal();
