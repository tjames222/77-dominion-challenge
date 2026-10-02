import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJournalReader,
  createJournalRestTransport,
  journalReaderError,
} from './journal-reader.mjs';
import { isJournalFutureDateError } from './journal-date-picker.mjs';

const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID = '11111111-1111-1111-1111-111111111111';
const SESSION = `${ACTOR}:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
const owner = () => ({ actorId: ACTOR, sessionIdentity: SESSION, token: 'bearer-a', epoch: 4, preview: false });
const entry = (overrides = {}) => ({
  id: ID,
  user_id: ACTOR,
  entry_date: '2026-10-01',
  challenge_day: 12,
  note: 'A note',
  win: 'A win',
  prayer: 'A prayer',
  mood: 'Steady',
  energy: 'Ready',
  created_at: '2026-10-01T12:00:00.123456+00:00',
  updated_at: '2026-10-01T12:00:01.123456+00:00',
  ...overrides,
});
const input = () => ({
  date: '2026-10-01', day: 12, note: 'A note', win: 'A win', prayer: 'A prayer', mood: 'Steady', energy: 'Ready',
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const state = { epoch: 4, actorId: ACTOR, sessionIdentity: SESSION, token: 'bearer-a', reads: 0, writes: 0 };
  const transport = {
    async readRows() { state.reads += 1; return [entry()]; },
    async readDatePolicy() { return { timeZone: 'America/Los_Angeles', today: '2026-10-01' }; },
    async createEntry() { state.writes += 1; return entry(); },
    async updateEntry() { state.writes += 1; return entry(); },
    ...overrides,
  };
  const reader = createJournalReader({
    async captureOwner(expected) {
      assert.equal(expected, ACTOR);
      return owner();
    },
    async verifyOwner(expected) {
      return state.epoch === expected.epoch && state.actorId === expected.actorId
        && state.sessionIdentity === expected.sessionIdentity && state.token === expected.token;
    },
    transport,
  });
  return { state, transport, reader };
}

test('opens an opaque route owner and returns a fixed page contract', async () => {
  const { reader } = fixture();
  const session = await reader.open({ expectedUserId: ACTOR });
  assert.deepEqual({ ...session, readPage: undefined, getDatePolicy: undefined, createEntry: undefined,
    updateEntry: undefined, isCurrent: undefined, invalidate: undefined, destroy: undefined }, {
    schemaVersion: 1, actorId: ACTOR, sessionIdentity: SESSION,
    readPage: undefined, getDatePolicy: undefined, createEntry: undefined,
    updateEntry: undefined, isCurrent: undefined, invalidate: undefined, destroy: undefined,
  });
  assert.equal('token' in session, false);
  assert.equal('epoch' in session, false);
  const page = await session.readPage();
  assert.equal(page.schemaVersion, 1);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].createdAt, '2026-10-01T12:00:00.123456+00:00');
  assert.equal(await session.isCurrent(), true);
  assert.deepEqual(await session.getDatePolicy(), { timeZone: 'America/Los_Angeles', today: '2026-10-01' });
});

test('coalesces one exact page while a caller abort only detaches that caller', async () => {
  const gate = deferred();
  const { reader, state } = fixture({ async readRows() { state.reads += 1; return gate.promise; } });
  const session = await reader.open({ expectedUserId: ACTOR });
  const controller = new AbortController();
  const first = session.readPage({ signal: controller.signal });
  const second = session.readPage();
  controller.abort();
  await assert.rejects(first, { code: 'JOURNAL_CANCELLED' });
  assert.equal(state.reads, 1);
  gate.resolve([entry()]);
  assert.equal((await second).entries[0].id, ID);
});

test('a pre-aborted or invalid signal never starts a read', async () => {
  const { reader, state } = fixture();
  const session = await reader.open({ expectedUserId: ACTOR });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.readPage({ signal: controller.signal }), { code: 'JOURNAL_CANCELLED' });
  await assert.rejects(session.readPage({ signal: {} }), { code: 'JOURNAL_INVALID_INPUT' });
  assert.equal(state.reads, 0);
});

test('same-actor session replacement and A-to-B-to-A epoch changes reject late pages', async () => {
  const gate = deferred();
  const { reader, state } = fixture({ async readRows() { state.reads += 1; return gate.promise; } });
  const session = await reader.open({ expectedUserId: ACTOR });
  const pending = session.readPage();
  await Promise.resolve();
  state.token = 'bearer-b';
  gate.resolve([entry()]);
  await assert.rejects(pending, { code: 'JOURNAL_OWNER_CHANGED' });
  assert.equal(await session.isCurrent(), false);

  state.token = 'bearer-a';
  state.epoch += 2;
  await assert.rejects(session.readPage(), { code: 'JOURNAL_OWNER_CHANGED' });
});

test('invalidating a handle synchronously poisons a pending response', async () => {
  const gate = deferred();
  const { reader } = fixture({ async readRows() { return gate.promise; } });
  const session = await reader.open({ expectedUserId: ACTOR });
  const pending = session.readPage();
  session.invalidate();
  gate.resolve([entry()]);
  await assert.rejects(pending, { code: 'JOURNAL_OWNER_CHANGED' });
});

test('invalidating during failed verification wins over an unavailable classification', async () => {
  const gate = deferred();
  const { transport } = fixture();
  const reader = createJournalReader({
    captureOwner: async () => owner(),
    verifyOwner: async () => gate.promise,
    transport,
  });
  const session = await reader.open({ expectedUserId: ACTOR });
  const pending = session.isCurrent();
  session.invalidate();
  gate.reject(journalReaderError('JOURNAL_UNAVAILABLE'));
  assert.equal(await pending, false);
});

test('returns confirmed writes only when identity and all saved fields match', async () => {
  const { reader, state } = fixture();
  const session = await reader.open({ expectedUserId: ACTOR });
  assert.deepEqual(await session.createEntry(input()), {
    id: ID,
    date: '2026-10-01',
    day: 12,
    note: 'A note',
    win: 'A win',
    prayer: 'A prayer',
    mood: 'Steady',
    energy: 'Ready',
    createdAt: '2026-10-01T12:00:00.123456+00:00',
    updatedAt: '2026-10-01T12:00:01.123456+00:00',
  });
  assert.equal(state.writes, 1);
  assert.equal(await session.isCurrent(), true, 'data-cache invalidation does not retire the owner session');
});

test('a validated success followed by owner replacement is marked committed but publishes no row', async () => {
  const { reader, state } = fixture({
    async createEntry() {
      state.writes += 1;
      queueMicrotask(() => { state.token = 'bearer-b'; });
      return entry();
    },
  });
  const session = await reader.open({ expectedUserId: ACTOR });
  await assert.rejects(session.createEntry(input()), (error) => (
    error.code === 'JOURNAL_OWNER_CHANGED'
      && error.writeOutcome === 'confirmed'
      && error.journalCommitted === true
  ));
});

test('network failure and malformed or mismatched success remain unknown and are never called committed', async () => {
  for (const createEntry of [
    async () => { throw new Error('network detail'); },
    async () => entry({ note: 'different saved value' }),
    async () => ({ ok: true }),
  ]) {
    const { reader } = fixture({ createEntry });
    const session = await reader.open({ expectedUserId: ACTOR });
    await assert.rejects(session.createEntry(input()), (error) => (
      error.code === 'JOURNAL_WRITE_UNCONFIRMED'
        && error.writeOutcome === 'unknown'
        && error.journalCommitted === false
        && !/network detail/.test(error.message)
    ));
  }
});

test('update validates the returned immutable entry id before confirming success', async () => {
  const { reader } = fixture({ async updateEntry() { return entry({ id: '22222222-2222-2222-2222-222222222222' }); } });
  const session = await reader.open({ expectedUserId: ACTOR });
  await assert.rejects(session.updateEntry(ID, input()), (error) => (
    error.code === 'JOURNAL_WRITE_UNCONFIRMED' && error.writeOutcome === 'unknown'
  ));
});

test('invalid writes and pre-aborted writes are not dispatched', async () => {
  const { reader, state } = fixture();
  const session = await reader.open({ expectedUserId: ACTOR });
  await assert.rejects(session.createEntry({ ...input(), date: '2026-02-30' }), (error) => (
    error.writeOutcome === 'not-dispatched' && error.journalCommitted === false
  ));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.createEntry(input(), { signal: controller.signal }), (error) => (
    error.code === 'JOURNAL_CANCELLED' && error.writeOutcome === 'not-dispatched'
  ));
  assert.equal(state.writes, 0);
});

test('the REST transport pins one bearer, no-store options and the exact continuation query', async () => {
  const calls = [];
  const cursor = {
    entryDate: '2026-10-01',
    createdAt: '2026-10-01T12:00:00.123456+00:00',
    id: ID,
  };
  const transport = createJournalRestTransport({
    baseUrl: 'https://project.supabase.co/__admin_fixture__',
    apiKey: 'publishable-key',
    async fetcher(url, options) {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify([entry()]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await transport.readRows(owner(), cursor);
  assert.equal(calls.length, 1, 'fetch has no automatic application retry');
  const call = calls[0];
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, 'Bearer bearer-a');
  assert.equal(call.options.headers.apikey, 'publishable-key');
  const url = new URL(call.url);
  assert.equal(url.pathname, '/__admin_fixture__/rest/v1/journal_entries');
  assert.equal(url.searchParams.get('user_id'), `eq.${ACTOR}`);
  assert.equal(url.searchParams.get('order'), 'entry_date.desc,created_at.desc,id.desc');
  assert.equal(url.searchParams.get('limit'), '26');
  assert.equal(url.searchParams.get('or'), `(${[
    'entry_date.lt.2026-10-01',
    'and(entry_date.eq.2026-10-01,created_at.lt.2026-10-01T12:00:00.123456+00:00)',
    `and(entry_date.eq.2026-10-01,created_at.eq.2026-10-01T12:00:00.123456+00:00,id.lt.${ID})`,
  ].join(',')})`);
});

test('accepts HTTPS and loopback transports while rejecting URL authority or query ambiguity', () => {
  const options = { apiKey: 'publishable-key', fetcher: async () => new Response('[]') };
  assert.doesNotThrow(() => createJournalRestTransport({ ...options, baseUrl: 'http://[::1]:54321/provider' }));
  for (const baseUrl of [
    'http://example.com/provider',
    'https://user:password@example.com/provider',
    'https://example.com/provider?redirect=https://other.invalid',
    'https://example.com/provider#other',
  ]) assert.throws(() => createJournalRestTransport({ ...options, baseUrl }), TypeError);
});

test('a canonical future-date provider rejection is safe and explicitly not committed', async () => {
  const { reader } = fixture({
    async createEntry() {
      throw Object.assign(new Error('provider copy is not published'), {
        code: '22023',
        details: 'journal_entry_date_in_future',
      });
    },
  });
  const session = await reader.open({ expectedUserId: ACTOR });
  await assert.rejects(session.createEntry(input()), (error) => (
    isJournalFutureDateError(error)
      && error.writeOutcome === 'rejected'
      && error.journalCommitted === false
      && !/provider copy/.test(error.message)
  ));
});

test('destroy is terminal and never exposes the captured bearer', async () => {
  const { reader } = fixture();
  const session = await reader.open({ expectedUserId: ACTOR });
  session.destroy();
  assert.equal(await session.isCurrent(), false);
  await assert.rejects(session.readPage(), { code: 'JOURNAL_OWNER_CHANGED' });
  assert.equal(JSON.stringify(session).includes('bearer-a'), false);
});

test('reader errors have only fixed public messages', () => {
  const error = journalReaderError('not-real');
  assert.equal(error.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(error.message, 'Your private journal is temporarily unavailable. Try again.');
});
