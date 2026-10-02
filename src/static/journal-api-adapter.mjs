import {
  createJournalReader,
  createJournalRestTransport,
  createPreviewJournalTransport,
  journalReaderError,
} from './journal-reader.mjs';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`Journal ${name} adapter is required.`);
  return value;
}

function authRejected(error) {
  return [401, 403].includes(error?.status)
    || ['session_not_found', 'refresh_token_not_found'].includes(error?.code);
}

function entryFromPayload(payload) {
  return {
    date: payload.entry_date,
    day: payload.challenge_day,
    note: payload.note,
    win: payload.win,
    prayer: payload.prayer,
    mood: payload.mood,
    energy: payload.energy,
  };
}

// This entire adapter is reached only by the Journal route's dynamic application
// bridge. It reuses the one existing Auth runtime and accepts no alternate
// storage, client, authority or bearer source.
export function createJournalApiClient({ baseUrl, apiKey, fetcher, getEpoch, auth = null, preview = null } = {}) {
  requireFunction(getEpoch, 'epoch');
  if (!auth && !preview) throw new TypeError('Journal Auth or preview adapters are required.');
  if (auth) {
    for (const name of ['getSession', 'getUser', 'requiresMfa', 'sessionIdentity']) requireFunction(auth[name], `Auth ${name}`);
    if (auth.onVerifiedUser !== undefined) requireFunction(auth.onVerifiedUser, 'verified-user');
  }
  if (preview) {
    for (const name of ['getUser', 'getActorId', 'sessionIdentity', 'readEntries', 'readDatePolicy', 'createEntry', 'updateEntry']) {
      requireFunction(preview[name], `preview ${name}`);
    }
  }

  const authOwnerStatus = async (owner) => {
    if (getEpoch() !== owner.epoch) return 'changed';
    let session;
    try { session = await auth.getSession(); }
    catch { return getEpoch() === owner.epoch ? 'unknown' : 'changed'; }
    if (getEpoch() !== owner.epoch || session?.user?.id !== owner.actorId
      || auth.sessionIdentity(session) !== owner.sessionIdentity || session?.access_token !== owner.token) {
      return 'changed';
    }
    return 'current';
  };

  const captureOwner = async (expectedUserId = '') => {
    const epoch = getEpoch();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw journalReaderError();
    if (auth) {
      let first;
      try { first = await auth.getSession(); }
      catch {
        if (getEpoch() !== epoch) throw journalReaderError('JOURNAL_OWNER_CHANGED');
        throw journalReaderError('JOURNAL_UNAVAILABLE');
      }
      const actorId = first?.user?.id || '';
      const sessionIdentity = auth.sessionIdentity(first);
      const token = first?.access_token;
      if (!actorId || !sessionIdentity || typeof token !== 'string' || !token) {
        throw journalReaderError('JOURNAL_SIGNED_OUT');
      }
      if (expectedUserId && actorId !== expectedUserId) throw journalReaderError('JOURNAL_OWNER_CHANGED');
      const owner = Object.freeze({ actorId, sessionIdentity, token, epoch, preview: Boolean(preview) });
      let user;
      let needsMfa;
      try {
        user = await auth.getUser(token);
        needsMfa = await auth.requiresMfa();
      } catch (error) {
        const status = await authOwnerStatus(owner);
        if (status === 'changed') throw journalReaderError('JOURNAL_OWNER_CHANGED');
        if (authRejected(error)) throw journalReaderError('JOURNAL_SIGNED_OUT');
        throw journalReaderError('JOURNAL_UNAVAILABLE');
      }
      if (needsMfa || user?.id !== actorId) throw journalReaderError('JOURNAL_OWNER_CHANGED');
      const status = await authOwnerStatus(owner);
      if (status === 'unknown') throw journalReaderError('JOURNAL_UNAVAILABLE');
      if (status === 'changed') throw journalReaderError('JOURNAL_OWNER_CHANGED');
      try { auth.onVerifiedUser?.(user); }
      catch { throw journalReaderError('JOURNAL_UNAVAILABLE'); }
      return owner;
    }

    const user = await preview.getUser();
    if (!user?.authenticated) throw journalReaderError('JOURNAL_SIGNED_OUT');
    let actorId;
    try { actorId = preview.getActorId(); } catch { throw journalReaderError('JOURNAL_SIGNED_OUT'); }
    if (!actorId) throw journalReaderError('JOURNAL_SIGNED_OUT');
    if (expectedUserId && actorId !== expectedUserId) throw journalReaderError('JOURNAL_OWNER_CHANGED');
    const sessionIdentity = preview.sessionIdentity(actorId, user);
    if (!sessionIdentity) throw journalReaderError('JOURNAL_SIGNED_OUT');
    return Object.freeze({ actorId, sessionIdentity, token: `preview:${actorId}`, epoch, preview: true });
  };

  const verifyOwner = async (owner) => {
    if (getEpoch() !== owner.epoch) return false;
    if (auth) {
      let before;
      try { before = await auth.getSession(); }
      catch {
        if (getEpoch() !== owner.epoch) return false;
        throw journalReaderError('JOURNAL_UNAVAILABLE');
      }
      if (getEpoch() !== owner.epoch || before?.user?.id !== owner.actorId
        || auth.sessionIdentity(before) !== owner.sessionIdentity || before?.access_token !== owner.token) return false;
      let user;
      let needsMfa;
      try {
        user = await auth.getUser(owner.token);
        needsMfa = await auth.requiresMfa();
      } catch (error) {
        const status = await authOwnerStatus(owner);
        if (status === 'changed') return false;
        if (authRejected(error)) return false;
        throw journalReaderError('JOURNAL_UNAVAILABLE');
      }
      if (needsMfa || user?.id !== owner.actorId) return false;
      const status = await authOwnerStatus(owner);
      if (status === 'unknown') throw journalReaderError('JOURNAL_UNAVAILABLE');
      return status === 'current';
    }
    const user = await preview.getUser();
    if (!user?.authenticated) return false;
    let actorId;
    try { actorId = preview.getActorId(); } catch { return false; }
    return getEpoch() === owner.epoch && actorId === owner.actorId
      && preview.sessionIdentity(actorId, user) === owner.sessionIdentity;
  };

  const transport = preview
    ? createPreviewJournalTransport({
        readEntries: preview.readEntries,
        readDatePolicy: preview.readDatePolicy,
        createEntry: (actorId, payload) => preview.createEntry(actorId, entryFromPayload(payload)),
        updateEntry: (actorId, entryId, payload) => preview.updateEntry(actorId, entryId, entryFromPayload(payload)),
      })
    : createJournalRestTransport({ baseUrl, apiKey, fetcher });
  return createJournalReader({ captureOwner, verifyOwner, transport });
}

// Keep route-specific dependency wiring behind the route-local dynamic bridge. These
// callbacks are the existing application Auth and preview authorities; this
// factory does not create another client, bearer source or storage owner.
export function createJournalApiClientFromShared({
  baseUrl,
  apiKey,
  fetcher,
  getEpoch,
  auth: sharedAuth = null,
  preview: sharedPreview = null,
} = {}) {
  const auth = sharedAuth ? {
    getSession: sharedAuth.getSession,
    async getUser(token) {
      const { data, error } = await sharedAuth.getAuth().getUser(token);
      if (error) throw error;
      return data?.user;
    },
    requiresMfa: () => sharedAuth.requiresMfa(sharedAuth.getAuth()),
    sessionIdentity: sharedAuth.sessionIdentity,
    onVerifiedUser: sharedAuth.onVerifiedUser,
  } : null;
  const preview = sharedPreview ? {
    getUser: sharedPreview.getUser,
    getActorId: sharedPreview.getActorId,
    sessionIdentity(actorId, user) {
      return `preview:${actorId}:${sharedPreview.identityHash(
        sharedPreview.normalizeIdentity(user?.email) || actorId,
      )}`;
    },
    readEntries(actorId) {
      const aggregate = sharedPreview.readAggregate(actorId);
      const entries = aggregate && Object.hasOwn(aggregate.values, sharedPreview.journalKey)
        ? aggregate.values[sharedPreview.journalKey]
        : sharedPreview.peekValue(sharedPreview.storage, actorId, sharedPreview.journalKey, []);
      return structuredClone(entries);
    },
    readDatePolicy: actorId => sharedPreview.readDatePolicy({ expectedUserId: actorId }),
    createEntry: (actorId, entry) => sharedPreview.createEntry(entry, { expectedUserId: actorId }),
    updateEntry: (actorId, entryId, entry) => sharedPreview.updateEntry(entryId, entry, { expectedUserId: actorId }),
  } : null;
  return createJournalApiClient({ baseUrl, apiKey, fetcher, getEpoch, auth, preview });
}
