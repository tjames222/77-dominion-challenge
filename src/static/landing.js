import { getBillingState, getLocalOrSessionUser, hasSupabaseAuth, isLocalDemoMode } from './api';
import { initReveal } from './reveal';

async function hydrateLandingCtas() {
  const primaryCtas = [...document.querySelectorAll('[data-primary-cta]')];
  const billingCta = document.getElementById('pricingCta');
  if (!primaryCtas.length && !billingCta) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);
  let target = './membership.html';
  let label = 'See the membership';

  if (isLoggedIn) {
    target = './billing.html';
    label = 'Activate membership';
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
    billingCta.textContent = isLoggedIn ? label : 'See what you get';
  }
}

hydrateLandingCtas();
initReveal();
