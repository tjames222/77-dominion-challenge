import { memberActorId, normalizeMemberAccessContext } from './member-access-context.mjs';

const messages = Object.freeze({
  MEMBER_ACCESS_UNAVAILABLE: 'Member access could not be verified. Try again.',
  MEMBER_ACCESS_SIGNED_OUT: 'Log in again to continue.',
  MEMBER_ACCESS_CHANGED: 'The account or session changed. Refresh and try again.',
  MEMBER_ACCESS_MFA_REQUIRED: 'Verify your authenticator before continuing.',
  MEMBER_ACCESS_CANCELLED: 'The member access request was cancelled.',
});
export function memberAccessError(code = 'MEMBER_ACCESS_UNAVAILABLE') {
  const safe = Object.hasOwn(messages, code) ? code : 'MEMBER_ACCESS_UNAVAILABLE';
  return Object.assign(new Error(messages[safe]), { code: safe });
}
function safeError(error) {
  const code = error?.code === 'PT401' && error?.message === 'member_authentication_required' ? 'MEMBER_ACCESS_SIGNED_OUT'
    : error?.code === 'PT403' && error?.message === 'member_mfa_required' ? 'MEMBER_ACCESS_MFA_REQUIRED' : error?.code;
  return memberAccessError(code);
}

// Reuse the document's existing Auth singleton and synchronous owner epoch.
// Each invocation is a fresh read: no SDK, listener, storage or settled cache.
export async function readMemberBillingState({ getSession, getUser, requiresMfa, sessionIdentity,
  getEpoch, request } = {}, { billingEnabled = false, expectedEpoch, signal, timeoutMs = 20_000 } = {}) {
  if ([getSession, getUser, requiresMfa, sessionIdentity, getEpoch, request].some(fn => typeof fn !== 'function')
    || typeof billingEnabled !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) throw memberAccessError();
  const epoch = expectedEpoch ?? getEpoch();
  const controller = new AbortController();
  let closed = false;
  let abortCode = 'MEMBER_ACCESS_CANCELLED';
  const check = () => {
    if (epoch !== getEpoch()) throw memberAccessError('MEMBER_ACCESS_CHANGED');
    if (closed || controller.signal.aborted) throw memberAccessError(abortCode);
  };
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(memberAccessError(abortCode));
  const callerAbort = () => { abortCode = 'MEMBER_ACCESS_CANCELLED'; controller.abort(); };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', callerAbort, { once: true });
  const timer = setTimeout(() => { abortCode = 'MEMBER_ACCESS_UNAVAILABLE'; controller.abort(); }, timeoutMs);
  const wait = async task => { check(); const value = await task(); check(); return value; };
  const verifyMfa = async () => {
    const required = await wait(requiresMfa);
    if (typeof required !== 'boolean') throw memberAccessError();
    if (required) throw memberAccessError('MEMBER_ACCESS_MFA_REQUIRED');
  };
  try {
    if (signal?.aborted) callerAbort();
    const work = Promise.resolve().then(async () => {
      check();
      const session = await wait(getSession);
      if (!session?.user) return null;
      const actorId = session.user.id;
      const identity = sessionIdentity(session);
      const token = session.access_token;
      if (!memberActorId(actorId) || typeof identity !== 'string' || !identity
        || typeof token !== 'string' || !token) throw memberAccessError('MEMBER_ACCESS_SIGNED_OUT');
      const assertCurrent = async () => {
        const current = await wait(getSession);
        if (current?.user?.id !== actorId || sessionIdentity(current) !== identity || current?.access_token !== token) {
          throw memberAccessError('MEMBER_ACCESS_CHANGED');
        }
      };
      const user = await wait(() => getUser(token));
      if (!user?.id) throw memberAccessError('MEMBER_ACCESS_SIGNED_OUT');
      if (user.id !== actorId) throw memberAccessError('MEMBER_ACCESS_CHANGED');
      await verifyMfa();
      await assertCurrent();
      const options = { actorId, token, signal: controller.signal };
      const [entitlements, subscriptions] = await wait(() => Promise.all([
        request('entitlements', options),
        billingEnabled ? request('subscriptions', options) : Promise.resolve([]),
      ]));
      await assertCurrent();
      if (!Array.isArray(entitlements) || !Array.isArray(subscriptions)
        || [...entitlements, ...subscriptions].some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw memberAccessError();
      // Read authority after the detail requests, never infer membership from
      // a billing row, local metadata, price qualification or preview state.
      const context = normalizeMemberAccessContext(await wait(() => request('access', options)), actorId);
      await verifyMfa();
      await assertCurrent();
      return { context, entitlements, subscriptions };
    });
    const value = await Promise.race([work, aborted]);
    check(); return value;
  } catch (error) {
    if (epoch !== getEpoch()) throw memberAccessError('MEMBER_ACCESS_CHANGED');
    if (controller.signal.aborted) throw memberAccessError(abortCode);
    throw safeError(error);
  } finally {
    closed = true; clearTimeout(timer); controller.abort();
    signal?.removeEventListener('abort', callerAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

const columns = Object.freeze({
  entitlements: 'entitlement_key,status,starts_at,ends_at,source_type,source_id,metadata',
  subscriptions: 'id,product_key,status,cancel_at_period_end,current_period_start,current_period_end,canceled_at,created_at',
});
export function createMemberAccessTransport({ url, key, fetch: request = globalThis.fetch }) {
  const base = new URL(url);
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    || base.username || base.password
    || base.search || base.hash || typeof key !== 'string' || !key || typeof request !== 'function') throw memberAccessError();
  return async (kind, { actorId, token, signal }) => {
    if (!memberActorId(actorId) || typeof token !== 'string' || !token
      || !['access', 'entitlements', 'subscriptions'].includes(kind)) throw memberAccessError();
    const prefix = base.pathname.replace(/\/$/, '');
    const target = new URL(`${prefix}/rest/v1/${kind === 'access' ? 'rpc/get_member_access_context' : kind}`, base);
    if (kind !== 'access') {
      target.searchParams.set('select', columns[kind]);
      target.searchParams.set('user_id', `eq.${actorId}`);
      if (kind === 'subscriptions') target.searchParams.set('order', 'created_at.desc');
    }
    const response = await request(target.href, {
      method: kind === 'access' ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(kind === 'access' ? { body: JSON.stringify({ target_expected_actor_id: actorId }) } : {}),
    });
    const reader = response.body?.getReader();
    if (!reader) throw memberAccessError();
    const decoder = new TextDecoder(); let raw = ''; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > (kind === 'access' ? 4096 : 1048576) || signal.aborted) {
          await reader.cancel(); throw memberAccessError();
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    let value; try { value = JSON.parse(raw); } catch { throw memberAccessError(); }
    if (!response.ok) throw { code: value?.code, message: value?.message };
    return value;
  };
}
