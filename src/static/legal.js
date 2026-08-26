import { initReveal } from './reveal';
import { RELEASE_GATES } from './release-gates.mjs';

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function renderOpenBillingPolicies() {
  if (!RELEASE_GATES.billingEnabled) return;

  setText('supportBillingTitle', 'Billing help');
  setText(
    'supportBillingCopy',
    'Manage payment information or cancel membership from the signed-in billing page.',
  );
  const supportBillingLink = document.getElementById('supportBillingLink');
  if (supportBillingLink) supportBillingLink.hidden = false;

  setText(
    'termsBillingCopy',
    'Dominion membership is currently offered for $7 per month. Stripe processes payment and the subscription renews monthly until canceled. Current price and billing details are shown before checkout. You can manage or cancel membership from Billing.',
  );
  const termsCancellationCopy = document.getElementById('termsCancellationCopy');
  if (termsCancellationCopy) {
    termsCancellationCopy.innerHTML = 'Cancellation removes paid app access immediately under the current product flow. Canceling does not erase your account or its data. Refund eligibility is explained in the <a href="./cancellation-refunds.html">Cancellation and Refund Policy</a>.';
  }

  setText(
    'cancellationHeroLead',
    'Last updated August 13, 2026. Here is what happens when a Dominion membership is canceled.',
  );
  setText('cancellationHowTitle', 'Cancel anytime');
  const cancellationHowCopy = document.getElementById('cancellationHowCopy');
  if (cancellationHowCopy) {
    cancellationHowCopy.innerHTML = 'Open <a href="./billing.html">Billing</a> while signed in and choose Cancel membership. Dominion asks for confirmation before sending the cancellation to Stripe.';
  }
  setText(
    'cancellationAccessCopy',
    'Under the current product flow, a confirmed cancellation ends the Stripe subscription and removes paid Dominion access immediately. Your account remains available for login, but member-only challenge pages stay locked unless membership is activated again.',
  );
  setText(
    'cancellationRefundCopy',
    'Membership charges are generally nonrefundable once processed, except where required by law. If you believe a charge was duplicated, unauthorized, or caused by a technical error, contact Support promptly so it can be reviewed. A request does not guarantee a refund.',
  );
  const cancellationAccountCopy = document.getElementById('cancellationAccountCopy');
  if (cancellationAccountCopy) {
    cancellationAccountCopy.innerHTML = 'Canceling membership does not delete your profile, journal, progress, group membership, or account. Signed-in members can separately request a data export or account deletion from <a href="./profile.html#account-data">Profile</a>.';
  }
  const cancellationHelpCopy = document.getElementById('cancellationHelpCopy');
  if (cancellationHelpCopy) {
    cancellationHelpCopy.innerHTML = 'Visit <a href="./support.html">Support</a> for billing help. Include only the email on your Dominion account and a short description; never send full payment-card details.';
  }
}

renderOpenBillingPolicies();
initReveal();
