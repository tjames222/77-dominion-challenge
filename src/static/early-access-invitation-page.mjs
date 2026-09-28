import { loadInvitationAcceptanceClient } from './api.js';
import { createInvitationAcceptanceIntent, EARLY_ACCESS_INVITATION_PAGE } from './early-access-invitation-contract.mjs';
import { invitationClientError } from './early-access-invitation-client.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

const failures = Object.freeze({
  invitation_unavailable: 'This invitation is expired, replaced, revoked, or already used. Reopen the latest invitation email or contact support.',
  account_setup_required: 'Account setup has not finished for this invitation. Finish the separate setup email, then sign in and reopen this invitation.',
  account_unavailable: 'This account does not match the current invitation. Sign in with the invited email address or contact support.',
  delivery_not_ready: 'This invitation is not ready to accept yet. Wait a moment, then explicitly review it again.',
  program_unavailable: 'Early Access is not currently accepting invitations. Contact support for next steps.',
  already_qualified: 'Your account already has a recorded Early Access decision. Contact support if access is missing.',
  rate_limited: 'Too many attempts. Wait before retrying this same acceptance.',
});

export function mountEarlyAccessInvitationPage({ capability, continuation, invalid = false }) {
  const status = document.getElementById('earlyAccessInviteStatus');
  const form = document.getElementById('earlyAccessAcceptForm');
  const acknowledge = document.getElementById('earlyAccessAcceptAcknowledgement');
  const accept = document.getElementById('earlyAccessAccept');
  const review = document.getElementById('earlyAccessReview');
  const signIn = document.getElementById('earlyAccessSignIn');
  const mfa = document.getElementById('earlyAccessMfa');
  const onward = document.getElementById('earlyAccessContinue');
  mfa.href = mfaChallengeHref(EARLY_ACCESS_INVITATION_PAGE, location.origin);
  let client; let owner; let intent; let epoch = 0; let disposed = false; let busy = false; let completed = false; let unsubscribe; let activeAttempt;
  const controllers = new Set();
  const current = version => !disposed && !completed && version === epoch;
  const scrub = ({ preserveAttempt = false } = {}) => {
    epoch++; owner = null; intent = null; busy = false;
    if (!preserveAttempt) activeAttempt = null;
    for (const controller of controllers) controller.abort(); controllers.clear();
    form.reset(); form.hidden = true; form.removeAttribute('aria-busy'); acknowledge.disabled = true; accept.disabled = true;
    accept.textContent = 'Accept Early Access'; review.disabled = false;
  };
  const clearLinks = () => { signIn.hidden = true; mfa.hidden = true; onward.hidden = true; review.hidden = true; };
  function errorState(error) {
    const code = typeof error?.code === 'string' ? error.code : 'INVITATION_UNAVAILABLE';
    status.textContent = invitationClientError(code).message;
    signIn.hidden = code !== 'INVITATION_SIGNED_OUT'; mfa.hidden = code !== 'INVITATION_MFA_REQUIRED';
    review.hidden = !capability || ['INVITATION_SIGNED_OUT', 'INVITATION_MFA_REQUIRED'].includes(code);
  }
  async function prepare() {
    scrub(); clearLinks();
    if (!capability || invalid) { status.textContent = 'Open the current invitation link from your email to continue.'; return; }
    const version = epoch; review.disabled = true; status.textContent = 'Checking your signed-in account…';
    const attempt = {}; activeAttempt = attempt;
    const controller = new AbortController(); controllers.add(controller);
    try {
      client ||= await loadInvitationAcceptanceClient();
      if (!current(version)) return;
      if (!client) { status.textContent = 'Invitation acceptance requires the live site and a verified account. It is unavailable in mock previews.'; return; }
      if (!unsubscribe) unsubscribe = client.subscribe(() => {
        if (disposed) return;
        completed = false;
        // Client failures synchronously invalidate owners before rejecting.
        // Preserve only this attempt marker so its fixed sign-in/MFA error can
        // be displayed; never preserve its owner, consent, or write intent.
        scrub({ preserveAttempt: true }); clearLinks();
        status.textContent = capability ? 'Your account or session changed. Review this invitation again.' : 'Your account or session changed. Reopen the invitation email to continue.';
        review.hidden = !capability;
      });
      const result = await client.review({ signal: controller.signal });
      if (!current(version) || !client.isCurrent(result.owner)) return;
      owner = result.owner; intent = createInvitationAcceptanceIntent(capability);
      status.textContent = 'Review the terms above, then confirm acceptance. The server will verify that this account matches the invitation.';
      acknowledge.disabled = false; acknowledge.checked = false; form.hidden = false; accept.disabled = true;
    } catch (error) { if (!disposed && !completed && activeAttempt === attempt) { clearLinks(); errorState(error); } }
    finally { controllers.delete(controller); if (current(version)) review.disabled = false; }
  }
  acknowledge.addEventListener('change', () => { accept.disabled = busy || !owner || !intent || !acknowledge.checked; });
  review.addEventListener('click', () => void prepare());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (disposed || completed || busy || !owner || !intent || !acknowledge.checked || !client?.isCurrent(owner)) return;
    const version = epoch; const originalOwner = owner; const originalIntent = intent;
    const attempt = {}; activeAttempt = attempt;
    busy = true; acknowledge.disabled = true; accept.disabled = true; review.disabled = true; form.setAttribute('aria-busy', 'true');
    status.textContent = 'Confirming your acceptance…';
    const controller = new AbortController(); controllers.add(controller);
    try {
      const result = await client.accept(originalOwner, originalIntent, { signal: controller.signal });
      if (!current(version) || owner !== originalOwner || intent !== originalIntent) return;
      if (result.ok) {
        completed = true; continuation.clear(); capability = null; owner = null; intent = null; form.reset(); form.hidden = true; clearLinks();
        status.textContent = 'Early Access accepted. Your $3.50 USD monthly beta-price qualification is recorded. No subscription or charge has started.';
        onward.hidden = false;
      } else if (result.errorCode === 'rate_limited') {
        status.textContent = failures.rate_limited; accept.textContent = 'Retry same acceptance';
      } else {
        scrub(); clearLinks(); status.textContent = failures[result.errorCode];
        if (result.errorCode === 'invitation_unavailable') { continuation.clear(); capability = null; }
        else review.hidden = false;
        if (result.errorCode === 'account_unavailable') signIn.hidden = false;
      }
    } catch (error) {
      if (disposed || completed || activeAttempt !== attempt) return;
      if (!current(version) || owner !== originalOwner || intent !== originalIntent) {
        // An Auth failure may have synchronously scrubbed this attempt. Its
        // safe next-step message may survive, but never its prior retry intent.
        clearLinks(); errorState(error); return;
      }
      if (['INVITATION_UNCONFIRMED', 'INVITATION_UNAVAILABLE', 'INVITATION_CANCELLED'].includes(error?.code)) {
        status.textContent = 'The result could not be confirmed; your acceptance may already be recorded. Retry this same acceptance to retrieve its result. Nothing retries automatically.';
        accept.textContent = 'Retry same acceptance';
      } else { scrub(); clearLinks(); errorState(error); }
    } finally {
      controllers.delete(controller);
      if (current(version)) { busy = false; acknowledge.disabled = false; accept.disabled = !owner || !intent || !acknowledge.checked; review.disabled = false; form.removeAttribute('aria-busy'); }
    }
  });
  window.addEventListener('pagehide', () => {
    disposed = true; completed = false; scrub(); clearLinks(); capability = null;
    unsubscribe?.(); unsubscribe = null; client?.invalidate();
    status.textContent = 'Review your invitation again when you return.';
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    disposed = false; invalid = false; capability = continuation.read();
    // BFCache restores no owner or consent. A new read can prepare a fresh
    // confirmation, but returning to the page can never replay acceptance.
    void prepare();
  });
  void prepare();
}
