import { normalizeChallengeActivation } from './challenge-activation.mjs';
import { normalizeDailyStandardDraft } from './daily-standard-draft.mjs';

export function dailyActionBootstrapError(code = 'DAILY_ACTION_UNAVAILABLE') {
  const messages = {
    DAILY_ACTION_UNAVAILABLE: 'Today’s action could not be loaded. Try again.',
    DAILY_ACTION_CHANGED: 'The account or session changed. Reload this action to continue.',
    DAILY_ACTION_SIGNED_OUT: 'Log in again to open this Daily Action.',
    DAILY_ACTION_INVALID_INPUT: 'Choose a valid Daily Action date and time zone.',
  };
  return Object.assign(new Error(messages[code] || messages.DAILY_ACTION_UNAVAILABLE), { code });
}
const dateKey = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value.slice(0, 4) !== '0000' && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
function canonicalDateAt(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}
export function normalizeDailyActionBootstrap(value, expectedActor, requestedDate = null) {
  if (!value || value.schemaVersion !== 1 || value.actorId !== expectedActor
    || typeof value.appAccess !== 'boolean' || typeof value.asOf !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T/.test(value.asOf) || !Number.isFinite(Date.parse(value.asOf))) {
    throw dailyActionBootstrapError();
  }
  const base = { schemaVersion: 1, actorId: expectedActor, asOf: value.asOf, appAccess: value.appAccess };
  if (!value.appAccess) {
    if (['activation', 'timeZone', 'entryDate', 'draft'].some((key) => value[key] !== null)) throw dailyActionBootstrapError();
    return { ...base, activation: null, timeZone: null, entryDate: null, draft: null };
  }
  const activation = normalizeChallengeActivation(value.activation);
  const raw = value.draft;
  if (!activation.contractValid || activation.readState !== 'ready' || !validTimeZone(value.timeZone)
    || !dateKey(value.entryDate) || (requestedDate !== null && requestedDate !== value.entryDate)
    || (requestedDate === null && canonicalDateAt(value.asOf, value.timeZone) !== value.entryDate)
    || !raw || raw.entry_date !== value.entryDate || !Array.isArray(raw.completed)
    || !Number.isSafeInteger(raw.version) || raw.version < 0
    || typeof raw.locked !== 'boolean' || typeof raw.submitted !== 'boolean'
    || raw.activation_status !== activation.status
    || (!raw.locked && (raw.submitted || !activation.canMutateDailyStandards))) throw dailyActionBootstrapError();
  return { ...base, activation, timeZone: value.timeZone, entryDate: value.entryDate,
    draft: normalizeDailyStandardDraft(raw, value.entryDate) };
}

// Only pending transport is coalesced. No settled private response, Auth user,
// session token or entitlement is cached. The identity marker is NOT authority.
export function createDailyActionBootstrapClient({ getSession, getUser, sessionIdentity, requiresMfa, subscribe, request, timeoutMs = 20_000 }) {
  let epoch = 0; let observedIdentity; let disposed = false;
  const pending = new Map();
  const invalidate = () => {
    epoch += 1;
    for (const operation of pending.values()) operation.controller.abort();
    pending.clear();
  };
  const unsubscribe = subscribe?.(({ event, sessionIdentity: identity }) => {
    const next = typeof identity === 'string' ? identity : '';
    if (['SIGNED_OUT', 'USER_UPDATED'].includes(event)
      || (observedIdentity !== undefined && next !== observedIdentity)) invalidate();
    observedIdentity = next;
  });
  const assertEpoch = (version) => { if (disposed || epoch !== version) throw dailyActionBootstrapError('DAILY_ACTION_CHANGED'); };
  async function verifyOwner(actorId, version, identity = null) {
    assertEpoch(version);
    const session = await getSession(); assertEpoch(version);
    const marker = sessionIdentity(session);
    if (!marker || !session?.user?.id) throw dailyActionBootstrapError('DAILY_ACTION_SIGNED_OUT');
    if (session.user.id !== actorId || (identity !== null && marker !== identity)) throw dailyActionBootstrapError('DAILY_ACTION_CHANGED');
    if (await requiresMfa()) throw dailyActionBootstrapError('DAILY_ACTION_SIGNED_OUT');
    assertEpoch(version);
    const user = await getUser(actorId); assertEpoch(version);
    const current = await getSession(); assertEpoch(version);
    if (user?.id !== actorId || sessionIdentity(current) !== marker) throw dailyActionBootstrapError('DAILY_ACTION_CHANGED');
    return marker;
  }
  return {
    async read({ expectedUserId, timeZone, entryDate = null } = {}) {
      if (typeof expectedUserId !== 'string' || !expectedUserId.trim()
        || !validTimeZone(timeZone) || (entryDate !== null && !dateKey(entryDate))) throw dailyActionBootstrapError('DAILY_ACTION_INVALID_INPUT');
      const actorId = expectedUserId.trim();
      const version = epoch;
      const key = JSON.stringify([version, actorId, timeZone, entryDate]);
      let operation = pending.get(key);
      if (!operation) {
        operation = { controller: new AbortController(), promise: null };
        pending.set(key, operation);
        let timedOut = false; let onAbort;
        const cancellation = new Promise((resolve, reject) => {
          onAbort = () => reject(dailyActionBootstrapError(timedOut ? 'DAILY_ACTION_UNAVAILABLE' : 'DAILY_ACTION_CHANGED'));
          operation.controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const timer = setTimeout(() => { timedOut = true; operation.controller.abort(); }, timeoutMs);
        const work = (async () => {
          const identity = await verifyOwner(actorId, version);
          if (operation.controller.signal.aborted) throw dailyActionBootstrapError('DAILY_ACTION_CHANGED');
          const raw = await request({ target_expected_actor_id: actorId,
            target_time_zone: timeZone, target_entry_date: entryDate }, operation.controller.signal);
          if (operation.controller.signal.aborted) throw dailyActionBootstrapError('DAILY_ACTION_CHANGED');
          await verifyOwner(actorId, version, identity);
          return normalizeDailyActionBootstrap(raw, actorId, entryDate);
        })();
        operation.promise = Promise.race([work, cancellation]).catch((error) => {
          assertEpoch(version);
          throw dailyActionBootstrapError(error?.code);
        }).finally(() => {
          clearTimeout(timer);
          operation.controller.signal.removeEventListener('abort', onAbort);
          if (pending.get(key) === operation) pending.delete(key);
        });
      }
      const result = await operation.promise;
      assertEpoch(version);
      return structuredClone(result);
    },
    invalidate,
    destroy() { invalidate(); disposed = true; unsubscribe?.(); },
  };
}
