import { authSessionIdentity } from './mfa-auth.mjs';
import { canonicalHtmlRouteFileName } from './route-path.mjs';

function landingError(changed = false) {
  return Object.assign(new Error(changed
    ? 'The signed-in session changed. Log in again to continue.'
    : 'Unable to open your account right now. Please try again.'), {
    code: changed ? 'AUTH_LANDING_CHANGED' : 'AUTH_LANDING_UNAVAILABLE',
  });
}

// Navigation only: server context selects a destination, never grants access.
// Callers sanitize returnTo and keep their existing native MFA checks.
export async function finishAuthLanding({
  session, returnTo, getAuthSession, getSiteAdminContext, getBillingState,
  subscribeToAuthStateChanges, navigate, assertCurrent = () => {},
  beforeNavigate = async () => {}, lifecycle,
}) {
  const owner = { actorId: session?.user?.id, identity: authSessionIdentity(session), token: session?.access_token };
  if (!owner.actorId || !owner.identity || !owner.token) throw landingError(true);
  const controller = new AbortController();
  let changed = false;
  const invalidate = () => { changed = true; controller.abort(); };
  const unsubscribe = subscribeToAuthStateChanges(({ event, user, sessionIdentity }) => {
    if (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'PASSWORD_RECOVERY'].includes(event)
      || user?.userId !== owner.actorId || sessionIdentity !== owner.identity) invalidate();
  });
  lifecycle?.addEventListener('pagehide', invalidate);
  lifecycle?.addEventListener('storage', invalidate);
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const check = () => {
    assertCurrent();
    if (changed) throw landingError(true);
    if (controller.signal.aborted) throw landingError();
  };
  const wait = async (operation) => {
    check();
    let aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => reject(landingError(changed));
      controller.signal.addEventListener('abort', aborted, { once: true });
    });
    try { const result = await Promise.race([operation(), cancellation]); check(); return result; }
    finally { controller.signal.removeEventListener('abort', aborted); }
  };
  const confirmOwner = async () => {
    const current = await wait(getAuthSession);
    if (current?.user?.id !== owner.actorId || authSessionIdentity(current) !== owner.identity
      || current?.access_token !== owner.token) throw landingError(true);
  };
  try {
    await confirmOwner();
    let target = returnTo;
    if (!target || (!/[?#]/.test(target) && canonicalHtmlRouteFileName(target) === 'dashboard.html')) {
      const context = await wait(() => getSiteAdminContext({ expectedUserId: owner.actorId, signal: controller.signal }));
      await confirmOwner();
      if (context?.schemaVersion !== 1 || context.actorId !== owner.actorId
        || !['member', 'site_admin'].includes(context.role) || typeof context.adminReady !== 'boolean') throw landingError();
      if (context.role === 'site_admin') target = './admin.html';
      else {
        const billing = await wait(getBillingState);
        await confirmOwner();
        if (typeof billing?.appAccess !== 'boolean') throw landingError();
        target = billing.appAccess ? './dashboard.html' : './billing.html';
      }
    }
    await wait(beforeNavigate);
    await confirmOwner();
    check();
    // No await between the final owner check and the caller's navigation.
    navigate(target);
  } catch (error) {
    if (changed || ['AUTH_LANDING_CHANGED', 'MFA_ACTOR_CHANGED'].includes(error?.code)) throw landingError(true);
    throw landingError();
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    lifecycle?.removeEventListener('pagehide', invalidate);
    lifecycle?.removeEventListener('storage', invalidate);
  }
}
