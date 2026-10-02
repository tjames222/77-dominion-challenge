import {
  JOURNAL_PAGE_FETCH_LIMIT,
  journalPageFilter,
  normalizeJournalDate,
  normalizeJournalCursor,
  normalizeJournalPageEntry,
  projectJournalPage,
  selectPreviewJournalPage,
} from './journal-pagination.mjs';
import { JOURNAL_FUTURE_DATE_CODE, JOURNAL_FUTURE_DATE_MESSAGE } from './journal-date-contract.mjs';

const SELECT_FIELDS = 'id,user_id,entry_date,challenge_day,note,win,prayer,mood,energy,created_at,updated_at';
const WRITER_NAMES = Object.freeze(['create_journal_entry', 'update_journal_entry']);
const MESSAGES = Object.freeze({
  JOURNAL_SIGNED_OUT: 'Log in again to open your private journal.',
  JOURNAL_OWNER_CHANGED: 'The account or session changed. Reload your private journal to continue.',
  JOURNAL_INVALID_CURSOR: 'This journal page is no longer valid. Return to the newest entries.',
  JOURNAL_INVALID_DATA: 'Some saved journal history could not be read safely.',
  JOURNAL_INVALID_INPUT: 'Check the journal entry and try again.',
  JOURNAL_DATA_CHANGED: 'Your journal changed while this page was loading. Refresh the page.',
  JOURNAL_CANCELLED: 'The journal request was cancelled.',
  JOURNAL_WRITE_UNCONFIRMED: 'The journal update could not be confirmed. Refresh before trying again.',
  JOURNAL_UNAVAILABLE: 'Your private journal is temporarily unavailable. Try again.',
});

export function journalReaderError(code = 'JOURNAL_UNAVAILABLE', properties = {}) {
  const safe = Object.hasOwn(MESSAGES, code) ? code : 'JOURNAL_UNAVAILABLE';
  return Object.assign(new Error(MESSAGES[safe]), { code: safe }, properties);
}

function signalLike(signal) {
  return signal === undefined || Boolean(signal && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function');
}

function plain(value) {
  return Boolean(value && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function providerFailure(value, status) {
  const error = new Error(typeof value?.message === 'string' ? value.message : MESSAGES.JOURNAL_UNAVAILABLE);
  for (const key of ['code', 'details', 'hint']) {
    if (typeof value?.[key] === 'string') error[key] = value[key];
  }
  error.status = status;
  return error;
}

async function json(response) {
  try { return await response.json(); } catch { throw journalReaderError(); }
}

// A fixed REST transport is used instead of allowing the SDK to choose a
// bearer after dispatch. Browser/proxy caches are bypassed and fetch performs
// no automatic application retry.
export function createJournalRestTransport({ baseUrl, apiKey, fetcher = globalThis.fetch } = {}) {
  let endpoint;
  try { endpoint = new URL(String(baseUrl || '').replace(/\/$/, '')); } catch { throw new TypeError('A journal API URL is required.'); }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
  if (!((endpoint.protocol === 'https:') || (endpoint.protocol === 'http:' && loopback))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || typeof apiKey !== 'string' || !apiKey || typeof fetcher !== 'function') {
    throw new TypeError('A journal API key and fetch adapter are required.');
  }
  const prefix = endpoint.pathname.replace(/\/$/, '').replace(/^\/$/, '');
  const route = (path) => {
    const url = new URL(endpoint.origin);
    url.pathname = `${prefix}${path}`;
    return url;
  };
  const request = async (url, { token, signal, method = 'GET', body } = {}) => {
    const response = await fetcher(url, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await json(response);
    if (!response.ok) throw providerFailure(value, response.status);
    return value;
  };
  const rpc = (name, args, owner, signal) => {
    if (![...WRITER_NAMES, 'get_journal_date_policy'].includes(name)) throw journalReaderError('JOURNAL_INVALID_INPUT');
    return request(route(`/rest/v1/rpc/${name}`), {
      token: owner.token, signal, method: 'POST', body: args,
    });
  };
  return Object.freeze({
    async readRows(owner, cursor, { signal } = {}) {
      const url = route('/rest/v1/journal_entries');
      url.searchParams.set('select', SELECT_FIELDS);
      url.searchParams.set('user_id', `eq.${owner.actorId}`);
      url.searchParams.set('order', 'entry_date.desc,created_at.desc,id.desc');
      url.searchParams.set('limit', String(JOURNAL_PAGE_FETCH_LIMIT));
      const filter = journalPageFilter(cursor);
      if (filter) url.searchParams.set('or', `(${filter})`);
      const value = await request(url, { token: owner.token, signal });
      if (!Array.isArray(value)) throw journalReaderError('JOURNAL_INVALID_DATA');
      return value;
    },
    readDatePolicy(owner, { signal } = {}) {
      return rpc('get_journal_date_policy', { target_expected_actor_id: owner.actorId }, owner, signal);
    },
    createEntry(owner, payload, { signal } = {}) {
      return rpc('create_journal_entry', {
        target_entry_date: payload.entry_date,
        target_challenge_day: payload.challenge_day,
        target_note: payload.note,
        target_win: payload.win,
        target_prayer: payload.prayer,
        target_mood: payload.mood,
        target_energy: payload.energy,
        target_expected_actor_id: owner.actorId,
      }, owner, signal);
    },
    updateEntry(owner, entryId, payload, { signal } = {}) {
      return rpc('update_journal_entry', {
        target_entry_id: entryId,
        target_entry_date: payload.entry_date,
        target_challenge_day: payload.challenge_day,
        target_note: payload.note,
        target_win: payload.win,
        target_prayer: payload.prayer,
        target_mood: payload.mood,
        target_energy: payload.energy,
        target_expected_actor_id: owner.actorId,
      }, owner, signal);
    },
  });
}

export function createPreviewJournalTransport({ readEntries, readDatePolicy, createEntry, updateEntry } = {}) {
  if ([readEntries, readDatePolicy, createEntry, updateEntry].some((value) => typeof value !== 'function')) {
    throw new TypeError('Preview journal storage adapters are required.');
  }
  return Object.freeze({
    async readRows(owner, cursor) {
      return selectPreviewJournalPage(await readEntries(owner.actorId), cursor);
    },
    readDatePolicy(owner) { return readDatePolicy(owner.actorId); },
    createEntry(owner, payload) { return createEntry(owner.actorId, payload); },
    updateEntry(owner, entryId, payload) { return updateEntry(owner.actorId, entryId, payload); },
  });
}

function writePayload(entry) {
  if (!plain(entry)) throw journalReaderError('JOURNAL_INVALID_INPUT');
  const date = entry.date;
  const day = entry.day ?? null;
  try { normalizeJournalDate(date, 'JOURNAL_INVALID_INPUT'); }
  catch { throw journalReaderError('JOURNAL_INVALID_INPUT'); }
  if (day !== null && !Number.isSafeInteger(day)) throw journalReaderError('JOURNAL_INVALID_INPUT');
  const payload = { entry_date: date, challenge_day: day };
  for (const key of ['note', 'win', 'prayer', 'mood', 'energy']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') throw journalReaderError('JOURNAL_INVALID_INPUT');
    payload[key] = entry[key] || '';
  }
  return payload;
}

function policy(value) {
  if (!plain(value)) throw journalReaderError('JOURNAL_INVALID_DATA');
  const today = value.today ?? value.user_date;
  const timeZone = value.timeZone ?? value.time_zone;
  try { normalizeJournalDate(today); } catch { throw journalReaderError('JOURNAL_INVALID_DATA'); }
  if (typeof timeZone !== 'string' || !timeZone) throw journalReaderError('JOURNAL_INVALID_DATA');
  return Object.freeze({ timeZone, today });
}

function savedEntryMatches(saved, entryId, payload) {
  return (!entryId || saved.id === entryId)
    && saved.date === payload.entry_date
    && saved.day === payload.challenge_day
    && ['note', 'win', 'prayer', 'mood', 'energy'].every((key) => saved[key] === payload[key]);
}

function attachWriteOutcome(source, writeOutcome, journalCommitted = false) {
  const providerFutureDate = source?.code === '22023'
    && /journal_entry_date_in_future/i.test(String(source?.details || ''));
  if (providerFutureDate) {
    return Object.assign(new RangeError(JOURNAL_FUTURE_DATE_MESSAGE), {
      code: JOURNAL_FUTURE_DATE_CODE,
      writeOutcome: 'rejected',
      journalCommitted: false,
    });
  }
  const code = source?.code === 'JOURNAL_OWNER_CHANGED' ? 'JOURNAL_OWNER_CHANGED'
    : writeOutcome === 'unknown' ? 'JOURNAL_WRITE_UNCONFIRMED'
      : source?.code === 'JOURNAL_CANCELLED' ? 'JOURNAL_CANCELLED'
        : source?.code === 'JOURNAL_INVALID_INPUT' ? 'JOURNAL_INVALID_INPUT'
          : 'JOURNAL_UNAVAILABLE';
  const error = journalReaderError(code, { writeOutcome, journalCommitted });
  for (const key of ['details', 'hint']) if (typeof source?.[key] === 'string') error[key] = source[key];
  if (source?.code === 'JOURNAL_FUTURE_DATE') error.code = source.code;
  return error;
}

export function createJournalReader({ captureOwner, verifyOwner, transport } = {}) {
  if (typeof captureOwner !== 'function' || typeof verifyOwner !== 'function'
    || !transport || ['readRows', 'readDatePolicy', 'createEntry', 'updateEntry']
      .some((name) => typeof transport[name] !== 'function')) {
    throw new TypeError('Journal ownership and transport adapters are required.');
  }

  return Object.freeze({
    async open({ expectedUserId = '' } = {}) {
      const owner = await captureOwner(expectedUserId);
      if (!plain(owner) || !owner.actorId || !owner.sessionIdentity || !owner.token
        || !Number.isSafeInteger(owner.epoch) || owner.epoch < 0 || typeof owner.preview !== 'boolean') {
        throw journalReaderError('JOURNAL_SIGNED_OUT');
      }
      let generation = 0;
      let pageEpoch = 0;
      let destroyed = false;
      const pageReads = new Map();
      const operations = new Set();
      const publicOwner = Object.freeze({ actorId: owner.actorId, sessionIdentity: owner.sessionIdentity });

      const assertGeneration = (captured) => {
        if (destroyed || captured !== generation) throw journalReaderError('JOURNAL_OWNER_CHANGED');
      };
      const assertCurrent = async (captured) => {
        assertGeneration(captured);
        let current;
        try { current = await verifyOwner(owner); }
        catch (error) {
          assertGeneration(captured);
          throw error;
        }
        if (!current) throw journalReaderError('JOURNAL_OWNER_CHANGED');
        assertGeneration(captured);
      };
      const invalidatePages = () => {
        pageEpoch += 1;
        for (const operation of operations) {
          if (operation.kind === 'page') {
            operation.abortCode = 'JOURNAL_DATA_CHANGED';
            operation.controller.abort();
          }
        }
        pageReads.clear();
      };
      const invalidate = () => {
        generation += 1;
        pageEpoch += 1;
        for (const operation of operations) {
          operation.abortCode = 'JOURNAL_OWNER_CHANGED';
          operation.controller.abort();
        }
        pageReads.clear();
      };
      const callerWait = (promise, signal) => {
        if (!signalLike(signal)) return Promise.reject(journalReaderError('JOURNAL_INVALID_INPUT'));
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(journalReaderError('JOURNAL_CANCELLED'));
        let rejectAbort;
        const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
        const abort = () => rejectAbort(journalReaderError('JOURNAL_CANCELLED'));
        signal.addEventListener('abort', abort, { once: true });
        return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', abort));
      };
      const startRead = (kind, key, task) => {
        const captured = generation;
        const capturedPageEpoch = pageEpoch;
        const operation = { kind, controller: new AbortController(), abortCode: 'JOURNAL_CANCELLED' };
        operations.add(operation);
        const promise = (async () => {
          try {
            await assertCurrent(captured);
            const value = await task(operation.controller.signal);
            await assertCurrent(captured);
            if (kind === 'page' && capturedPageEpoch !== pageEpoch) throw journalReaderError('JOURNAL_DATA_CHANGED');
            return value;
          } catch (error) {
            if (destroyed || captured !== generation) throw journalReaderError('JOURNAL_OWNER_CHANGED');
            if (operation.controller.signal.aborted) throw journalReaderError(operation.abortCode);
            try { await assertCurrent(captured); }
            catch (currentError) {
              if (currentError?.code === 'JOURNAL_OWNER_CHANGED') throw currentError;
              if (String(currentError?.code || '').startsWith('JOURNAL_')) throw currentError;
              throw journalReaderError('JOURNAL_UNAVAILABLE');
            }
            if (String(error?.code || '').startsWith('JOURNAL_')) throw error;
            throw journalReaderError('JOURNAL_UNAVAILABLE');
          } finally {
            operations.delete(operation);
          }
        })();
        if (key) promise.finally(() => { if (pageReads.get(key) === promise) pageReads.delete(key); }).catch(() => {});
        return promise;
      };

      const handle = {
        schemaVersion: 1,
        ...publicOwner,
        readPage({ cursor = null, signal } = {}) {
          if (!signalLike(signal)) return Promise.reject(journalReaderError('JOURNAL_INVALID_INPUT'));
          if (signal?.aborted) return Promise.reject(journalReaderError('JOURNAL_CANCELLED'));
          let normalized;
          try { normalized = normalizeJournalCursor(cursor, { preview: owner.preview }); }
          catch (error) { return Promise.reject(error); }
          const key = JSON.stringify(normalized);
          let promise = pageReads.get(key);
          if (!promise) {
            promise = startRead('page', key, async (internalSignal) => {
              const rows = await transport.readRows(owner, normalized, { signal: internalSignal });
              return projectJournalPage(rows, { actorId: owner.actorId, preview: owner.preview });
            });
            pageReads.set(key, promise);
          }
          return callerWait(promise, signal);
        },
        getDatePolicy({ signal } = {}) {
          if (!signalLike(signal)) return Promise.reject(journalReaderError('JOURNAL_INVALID_INPUT'));
          if (signal?.aborted) return Promise.reject(journalReaderError('JOURNAL_CANCELLED'));
          const promise = startRead('policy', '', async (internalSignal) => policy(
            await transport.readDatePolicy(owner, { signal: internalSignal }),
          ));
          return callerWait(promise, signal);
        },
        createEntry(entry, { signal } = {}) {
          return mutate('create', '', entry, signal);
        },
        updateEntry(entryId, entry, { signal } = {}) {
          return mutate('update', String(entryId || '').trim(), entry, signal);
        },
        async isCurrent() {
          if (destroyed) return false;
          const captured = generation;
          try { await assertCurrent(captured); return true; }
          catch (error) {
            if (error?.code === 'JOURNAL_OWNER_CHANGED') return false;
            throw error;
          }
        },
        invalidate,
        destroy() {
          if (destroyed) return;
          invalidate();
          destroyed = true;
        },
      };

      async function mutate(kind, entryId, entry, signal) {
        if (!signalLike(signal)) throw attachWriteOutcome(journalReaderError('JOURNAL_INVALID_INPUT'), 'not-dispatched');
        if (kind === 'update' && !entryId) throw attachWriteOutcome(journalReaderError('JOURNAL_INVALID_INPUT'), 'not-dispatched');
        if (signal?.aborted) throw attachWriteOutcome(journalReaderError('JOURNAL_CANCELLED'), 'not-dispatched');
        let payload;
        try { payload = writePayload(entry); }
        catch (error) { throw attachWriteOutcome(error, 'not-dispatched'); }
        const captured = generation;
        const operation = { kind: 'mutation', controller: new AbortController(), abortCode: 'JOURNAL_CANCELLED' };
        operations.add(operation);
        let dispatched = false;
        let confirmed = false;
        const callerAbort = () => { operation.abortCode = 'JOURNAL_CANCELLED'; operation.controller.abort(); };
        signal?.addEventListener('abort', callerAbort, { once: true });
        invalidatePages();
        try {
          if (signal?.aborted) throw journalReaderError('JOURNAL_CANCELLED');
          await assertCurrent(captured);
          if (operation.controller.signal.aborted) throw journalReaderError(operation.abortCode);
          dispatched = true;
          const raw = kind === 'create'
            ? await transport.createEntry(owner, payload, { signal: operation.controller.signal })
            : await transport.updateEntry(owner, entryId, payload, { signal: operation.controller.signal });
          const saved = normalizeJournalPageEntry(raw, { actorId: owner.actorId, preview: owner.preview });
          if (!savedEntryMatches(saved, entryId, payload)) throw journalReaderError('JOURNAL_INVALID_DATA');
          confirmed = true;
          await assertCurrent(captured);
          return saved;
        } catch (error) {
          const outcome = confirmed ? 'confirmed' : dispatched ? 'unknown' : 'not-dispatched';
          if (destroyed || captured !== generation) {
            throw attachWriteOutcome(journalReaderError('JOURNAL_OWNER_CHANGED'), outcome, confirmed);
          }
          if (confirmed) throw attachWriteOutcome(error, outcome, true);
          try { await assertCurrent(captured); }
          catch (currentError) {
            if (currentError?.code === 'JOURNAL_OWNER_CHANGED') {
              throw attachWriteOutcome(currentError, outcome, false);
            }
            throw attachWriteOutcome(currentError, outcome, false);
          }
          if (operation.controller.signal.aborted) {
            throw attachWriteOutcome(journalReaderError(operation.abortCode), outcome, false);
          }
          throw attachWriteOutcome(error, outcome, false);
        } finally {
          operations.delete(operation);
          signal?.removeEventListener('abort', callerAbort);
          invalidatePages();
        }
      }

      return Object.freeze(handle);
    },
  });
}
