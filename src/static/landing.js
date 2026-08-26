import { getBillingState, getLocalOrSessionUser, hasSupabaseAuth, isLocalDemoMode } from './api';
import { initReveal } from './reveal';
import { RELEASE_GATES } from './release-gates.mjs';

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function renderLandingMode() {
  setText(
    'landingFirstStepTitle',
    RELEASE_GATES.publicSignupEnabled ? 'Create your account' : 'Receive an invitation',
  );
  if (!RELEASE_GATES.billingEnabled) return;
  setText('landingOfferEyebrow', 'Membership');
  setText('landingOfferLabel', 'Dominion');
  setText('landingOfferPrice', '$7 per month');
  setText(
    'landingOfferCopy',
    'Full access to the 77-day challenge, dashboard, daily actions, community, journal, and future member content.',
  );
  setText('landingOfferTitle', 'See what comes with membership.');
  setText(
    'landingOfferCloseCopy',
    RELEASE_GATES.publicSignupEnabled
      ? 'Review the details, create your account, and activate access when you’re ready to begin.'
      : 'Invited accounts can review the details and activate access when they are ready to begin.',
  );
}

async function hydrateLandingCtas() {
  const primaryCtas = [...document.querySelectorAll('[data-primary-cta]')];
  const billingCta = document.getElementById('pricingCta');
  if (!primaryCtas.length && !billingCta) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);
  let target = './membership.html';
  let label = RELEASE_GATES.billingEnabled ? 'See the membership' : 'See early access';

  if (isLoggedIn) {
    target = RELEASE_GATES.billingEnabled ? './billing.html' : './membership.html';
    label = RELEASE_GATES.billingEnabled ? 'Activate membership' : 'Early access details';
    if (hasSupabaseAuth() || isLocalDemoMode()) {
      try {
        const billing = await getBillingState();
        if (billing.appAccess) {
          target = './dashboard.html';
          label = 'Open dashboard';
        }
      } catch (error) {
        console.warn('Unable to personalize landing CTA', error);
      }
    }
  }

  primaryCtas.forEach((link) => {
    link.href = target;
    link.textContent = label;
  });

  if (billingCta) {
    billingCta.href = target;
    billingCta.textContent = isLoggedIn
      ? label
      : RELEASE_GATES.billingEnabled ? 'See what you get' : 'See early access details';
  }
}

renderLandingMode();
hydrateLandingCtas();
initReveal();
