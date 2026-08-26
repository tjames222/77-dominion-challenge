import { getBillingState, getLocalOrSessionUser, hasSupabaseAuth, isLocalDemoMode } from './api';
import { initReveal } from './reveal';
import {
  RELEASE_GATES,
  RELEASE_MODES,
  resolveReleaseMode,
} from './release-gates.mjs';

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function renderMembershipMode() {
  const mode = resolveReleaseMode(RELEASE_GATES);
  if (mode === RELEASE_MODES.INVITE_ONLY) return;

  if (mode === RELEASE_MODES.SIGNUP_EARLY_ACCESS) {
    setText('membershipHeroEyebrow', 'Early access');
    setText(
      'membershipHeroLead',
      'Account creation is open, but access is still being added in small groups. No payment is needed yet.',
    );
    setText('membershipHeroActionNote', 'Create your account now. We’ll let you know when early access is approved.');
    setText('membershipStepsEyebrow', 'How early access works');
    setText('membershipStepOneTitle', 'Create your account');
    setText('membershipStepOneCopy', 'Add the basic details for your profile.');
    setText('membershipStepTwoTitle', 'Wait for early-access approval');
    setText('membershipStepTwoCopy', 'We are adding a small group at a time before opening access more broadly.');
    setText('membershipFinalEyebrow', 'Want to join early access?');
    setText('membershipFinalTitle', 'Create your account.');
    setText('membershipFinalCopy', 'No payment is needed yet. We’ll let you know when your account is approved.');
    return;
  }

  setText('membershipHeroEyebrow', 'Dominion Membership');
  setText(
    'membershipHeroLead',
    'For $7/month, you get the 77-day challenge, daily action tools, private groups, a private journal, and more challenges after day 77.',
  );
  const publicSignup = mode === RELEASE_MODES.PUBLIC_MEMBERSHIP;
  setText(
    'membershipHeroActionNote',
    publicSignup
      ? 'Create your account, then activate your membership.'
      : 'Already invited? Log in, then activate your membership.',
  );
  setText('membershipStepsEyebrow', publicSignup ? 'How signup works' : 'How membership works');
  setText('membershipStepOneTitle', publicSignup ? 'Create your account' : 'Log in with your invited account');
  setText(
    'membershipStepOneCopy',
    publicSignup ? 'Add the basic details for your profile.' : 'Use the same email connected to your invitation.',
  );
  setText('membershipStepTwoTitle', 'Activate membership');
  setText('membershipStepTwoCopy', 'Subscribe for $7/month to use the full app.');
  setText('membershipFinalEyebrow', publicSignup ? 'Ready to begin?' : 'Already invited?');
  setText(
    'membershipFinalTitle',
    publicSignup ? 'Create your account and choose your start date.' : 'Log in and activate your membership.',
  );
  setText(
    'membershipFinalCopy',
    publicSignup
      ? 'You don’t need a perfect day. Start with the next action and keep going.'
      : 'Use the email connected to your invitation, then finish membership setup.',
  );
  setText('membershipPolicyCopy', 'Membership renews monthly until canceled. Review the details before joining.');
}

async function hydrateMembershipCtas() {
  const ctas = [...document.querySelectorAll('[data-membership-cta]')];
  const earlyAccessLogin = document.getElementById('membershipEarlyAccessLogin');
  if (!ctas.length && !earlyAccessLogin) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);
  let target = RELEASE_GATES.billingEnabled
    ? './register.html?returnTo=./billing.html'
    : './register.html';
  let label = RELEASE_GATES.billingEnabled ? 'Sign up now' : 'Create account';
  let showCta = RELEASE_GATES.publicSignupEnabled;

  if (isLoggedIn) {
    target = RELEASE_GATES.billingEnabled ? './billing.html' : './membership.html';
    label = RELEASE_GATES.billingEnabled ? 'Activate membership' : 'Early access details';
    showCta = RELEASE_GATES.billingEnabled;
    if (hasSupabaseAuth() || isLocalDemoMode()) {
      try {
        const billing = await getBillingState();
        if (billing.appAccess) {
          target = './dashboard.html';
          label = 'Open dashboard';
          showCta = true;
        }
      } catch (error) {
        console.warn('Unable to personalize membership CTA', error);
      }
    }
  }

  ctas.forEach((cta) => {
    cta.hidden = !showCta;
    cta.href = target;
    cta.textContent = label;
  });
  if (earlyAccessLogin) {
    earlyAccessLogin.hidden = isLoggedIn || RELEASE_GATES.publicSignupEnabled;
  }
}

renderMembershipMode();
hydrateMembershipCtas();
initReveal();
