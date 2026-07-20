import { getBillingState, getLocalOrSessionUser, hasSupabaseAuth, isLocalDemoMode } from './api';
import { initReveal } from './reveal';

async function hydrateMembershipCtas() {
  const ctas = [...document.querySelectorAll('[data-membership-cta]')];
  if (!ctas.length) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);
  let target = './register.html?returnTo=./billing.html';
  let label = 'Sign up now';

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
        console.warn('Unable to personalize membership CTA', error);
      }
    }
  }

  ctas.forEach((cta) => {
    cta.href = target;
    cta.textContent = label;
  });
}

hydrateMembershipCtas();
initReveal();
