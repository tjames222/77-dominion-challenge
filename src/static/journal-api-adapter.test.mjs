import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJournalApiClient, createJournalApiClientFromShared } from './journal-api-adapter.mjs';
import { createJournalApplicationLoader, createJournalSessionOpener } from './journal-api-entry.mjs';
import { peekPreviewUserValue } from './preview-user-state.mjs';

const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION = `${ACTOR}:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
const TOKEN = 'bearer-a';
const row = () => ({
  id: '11111111-1111-1111-1111-111111111111',
  user_id: ACTOR,
  entry_date: '2026-10-01',
  challenge_day: null,
  note: '', win: '', prayer: '', mood: '', energy: '',
  created_at: '2026-10-01T12:00:00.123456+00:00',
  updated_at: '2026-10-01T12:00:00.123456+00:00',
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function liveFixture() {
  const state = {
    epoch: 3,
    session: { user: { id: ACTOR }, access_token: TOKEN, identity: SESSION },
    getUserTokens: [],
    requests: [],
    needsMfa: false,
    userError: null,
    getUserCheck: null,
    mfaCheck: null,
    sessionCheck: null,
  };
  const client = createJournalApiClient({
    baseUrl: 'https://project.supabase.co/provider',
    apiKey: 'publishable-key',
    getEpoch: () => state.epoch,
    auth: {
      getSession: async () => state.sessionCheck ? state.sessionCheck() : state.session,
      async getUser(token) {
        state.getUserTokens.push(token);
        if (state.getUserCheck) return state.getUserCheck(token);
        if (state.userError) throw state.userError;
        return { id: ACTOR };
      },
      requiresMfa: async () => state.mfaCheck ? state.mfaCheck() : state.needsMfa,
      sessionIdentity: session => session?.identity || '',
    },
    async fetcher(url, options) {
      state.requests.push({ url: String(url), options });
      return new Response(JSON.stringify([row()]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { client, state };
}

test('live journal sessions verify the exact captured bearer and retire silent replacements', async () => {
  const { client, state } = liveFixture();
  const session = await client.open({ expectedUserId: ACTOR });
  assert.equal(state.getUserTokens[0], TOKEN);
  await session.readPage();
  assert.equal(state.requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(state.requests[0].url.startsWith('https://project.supabase.co/provider/rest/v1/'), true);
  state.session = { ...state.session, access_token: 'bearer-b' };
  assert.equal(await session.isCurrent(), false);
});

test('epoch changes reject A-to-B-to-A even when actor, identity and bearer return', async () => {
  const { client, state } = liveFixture();
  const session = await client.open({ expectedUserId: ACTOR });
  state.epoch += 2;
  await assert.rejects(session.readPage(), { code: 'JOURNAL_OWNER_CHANGED' });
});

test('isCurrent reports a confirmed replacement but rethrows transient verification failures', async () => {
  const { client, state } = liveFixture();
  const session = await client.open({ expectedUserId: ACTOR });
  state.userError = new Error('temporary provider outage');
  await assert.rejects(session.isCurrent(), { code: 'JOURNAL_UNAVAILABLE' });
  state.userError = null;
  state.session = { ...state.session, access_token: 'replacement' };
  assert.equal(await session.isCurrent(), false);
});

test('a rejected owner verification classifies replacements before transient outages', async () => {
  {
    const { client, state } = liveFixture();
    const session = await client.open({ expectedUserId: ACTOR });
    const started = deferred();
    const result = deferred();
    state.getUserCheck = () => { started.resolve(); return result.promise; };
    const pending = session.isCurrent();
    await started.promise;
    state.session = { ...state.session, access_token: 'same-actor-replacement' };
    result.reject(new Error('old bearer request failed'));
    assert.equal(await pending, false);
  }
  {
    const { client, state } = liveFixture();
    const session = await client.open({ expectedUserId: ACTOR });
    const started = deferred();
    const result = deferred();
    state.mfaCheck = () => { started.resolve(); return result.promise; };
    const pending = session.isCurrent();
    await started.promise;
    state.session = {
      user: { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
      access_token: 'other-actor-bearer',
      identity: 'other-actor-session',
    };
    result.reject(new Error('MFA request failed'));
    assert.equal(await pending, false);
  }
});

test('capture rejects a replacement that occurs while owner verification fails', async () => {
  const { client, state } = liveFixture();
  const started = deferred();
  const result = deferred();
  state.getUserCheck = () => { started.resolve(); return result.promise; };
  const pending = client.open({ expectedUserId: ACTOR });
  await started.promise;
  state.session = { ...state.session, access_token: 'same-actor-replacement' };
  result.reject(new Error('old bearer request failed'));
  await assert.rejects(pending, { code: 'JOURNAL_OWNER_CHANGED' });
});

test('an epoch change wins over a rejecting session lookup', async () => {
  const { client, state } = liveFixture();
  const session = await client.open({ expectedUserId: ACTOR });
  const started = deferred();
  const result = deferred();
  state.sessionCheck = () => { started.resolve(); return result.promise; };
  const pending = session.isCurrent();
  await started.promise;
  state.epoch += 1;
  result.reject(new Error('session lookup failed'));
  assert.equal(await pending, false);
});

test('capture classifies an epoch change during a rejecting first session lookup', async () => {
  const { client, state } = liveFixture();
  const started = deferred();
  const result = deferred();
  state.sessionCheck = () => { started.resolve(); return result.promise; };
  const pending = client.open({ expectedUserId: ACTOR });
  await started.promise;
  state.epoch += 1;
  result.reject(new Error('session lookup failed'));
  await assert.rejects(pending, { code: 'JOURNAL_OWNER_CHANGED' });
});

test('a known MFA downgrade wins over an unavailable final session lookup', async () => {
  const { client, state } = liveFixture();
  const session = await client.open({ expectedUserId: ACTOR });
  state.needsMfa = true;
  let sessionChecks = 0;
  state.sessionCheck = () => {
    sessionChecks += 1;
    if (sessionChecks === 1) return state.session;
    throw new Error('final session lookup failed');
  };
  assert.equal(await session.isCurrent(), false);
  assert.equal(sessionChecks, 1, 'known MFA loss needs no ambiguous final lookup');
});

test('distinguishes authoritative sign-out from transient verification failure', async () => {
  {
    const { client, state } = liveFixture();
    state.userError = Object.assign(new Error('expired'), { status: 401, code: 'session_not_found' });
    await assert.rejects(client.open({ expectedUserId: ACTOR }), { code: 'JOURNAL_SIGNED_OUT' });
  }
  {
    const { client, state } = liveFixture();
    state.userError = new Error('network private detail');
    await assert.rejects(client.open({ expectedUserId: ACTOR }), (error) => (
      error.code === 'JOURNAL_UNAVAILABLE' && !/private detail/.test(error.message)
    ));
  }
});

test('preview sessions page legacy ids without persisting a sliced page', async () => {
  const storage = Array.from({ length: 30 }, (_, index) => ({
    id: `preview_journal_${String(99 - index).padStart(2, '0')}`,
    date: '2026-10-01',
    day: null,
    note: `note-${index}`,
    win: '', prayer: '', mood: '', energy: '',
    createdAt: `2026-10-01T12:00:00.${String(999999 - index).padStart(6, '0')}Z`,
    updatedAt: null,
  }));
  let writes = 0;
  let storageWrites = 0;
  const stored = new Map([
    ['dominion:previewUserStateLegacyOwner', 'preview_actor'],
    ['dominion:journalEntries', JSON.stringify(storage)],
  ]);
  const storageSpy = {
    getItem: key => stored.get(key) ?? null,
    setItem(key, value) { storageWrites += 1; stored.set(key, value); },
  };
  const client = createJournalApiClientFromShared({
    getEpoch: () => 0,
    preview: {
      getUser: async () => ({ authenticated: true, email: 'preview@example.test' }),
      getActorId: () => 'preview_actor',
      identityHash: value => `hash:${value}`,
      normalizeIdentity: value => String(value || '').trim().toLowerCase(),
      journalKey: 'dominion:journalEntries',
      storage: storageSpy,
      readAggregate: () => null,
      peekValue: peekPreviewUserValue,
      readDatePolicy: ({ expectedUserId }) => {
        assert.equal(expectedUserId, 'preview_actor');
        return { timeZone: 'UTC', today: '2026-10-01' };
      },
      createEntry: () => { writes += 1; throw new Error('not used'); },
      updateEntry: () => { writes += 1; throw new Error('not used'); },
    },
  });
  const session = await client.open({ expectedUserId: 'preview_actor' });
  const page = await session.readPage();
  assert.equal(page.entries.length, 25);
  assert.equal(page.hasNext, true);
  assert.equal(storage.length, 30);
  assert.equal(writes, 0);
  assert.equal(storageWrites, 0, 'paging uses the real read-only preview helper');
});

test('the journal route keeps implementation behind a route-only dynamic boundary', () => {
  const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('./journal-api-entry.mjs', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./private-journal.js', import.meta.url), 'utf8');
  const imports = source.slice(0, source.indexOf('const e2eRewardFixturesEnabled'));
  assert.doesNotMatch(imports, /journal-(?:api-adapter|reader|pagination)\.mjs/);
  assert.doesNotMatch(source, /journal-api-(?:entry|application)\.mjs|openJournalSession/);
  assert.match(page, /import \{ openJournalSession \} from '\.\/journal-api-entry\.mjs'/);
  assert.match(entry, /import\('\.\/journal-api-application\.mjs'\)/);
  assert.match(entry, /export const openJournalSession = createJournalSessionOpener/);
  assert.doesNotMatch(entry, /readAggregate|peekValue|storage:|readEntries|getAuth:|requiresMfa/);
});

test('a failed application module load stays closed until document reload', async () => {
  let imports = 0;
  const failure = new Error('module unavailable');
  const load = createJournalApplicationLoader(async () => {
    imports += 1;
    throw failure;
  });
  await assert.rejects(load(), error => error === failure);
  await assert.rejects(load(), error => error === failure);
  assert.equal(imports, 1, 'the browser cannot reliably retry a rejected ES module in this document');
});

test('only an application import failure becomes a safe reload-required error', async () => {
  const secretFailure = new Error('private module URL detail');
  const unavailable = createJournalSessionOpener(async () => { throw secretFailure; });
  await assert.rejects(unavailable(), error => (
    error.code === 'JOURNAL_CODE_UNAVAILABLE'
      && /Reload this page/.test(error.message)
      && !/private module/.test(error.message)
  ));

  const ownerFailure = Object.assign(new Error('safe owner failure'), { code: 'JOURNAL_UNAVAILABLE' });
  const ownerCheck = createJournalSessionOpener(async () => ({ open: async () => { throw ownerFailure; } }));
  await assert.rejects(ownerCheck(), error => error === ownerFailure);
});
