import { createInvitationContinuation } from './early-access-invitation-contract.mjs';

// This entry has no Auth/menu/analytics imports. Remove the capability before
// loading any application runtime; only a plain route reaches login or MFA.
let storage;
try { storage = window.sessionStorage; } catch { /* Memory-only remains usable. */ }
const continuation = createInvitationContinuation({ storage });
let capability = null;
let invalid = false;
try { capability = continuation.capture(window.location, window.history); } catch { invalid = true; }
try {
  const { mountEarlyAccessInvitationPage } = await import('./early-access-invitation-page.mjs');
  mountEarlyAccessInvitationPage({ capability, continuation, invalid });
} catch {
  document.getElementById('earlyAccessInviteStatus').textContent = 'Invitation setup is temporarily unavailable. Reload this page or reopen the invitation email.';
}
