import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./private-journal.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadJournalPage(');
const end = source.indexOf('\nconst journalFormTemplate', start);
const pageFunction = source.slice(start, end);
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const failedRead of [false, true]) {
  test(`actual UI page function rejects a stale ${failedRead ? 'error' : 'success'} after its final asynchronous owner check`, async () => {
    const read = deferred(); const owner = deferred(); const entered = deferred();
    const state = { session: { readPage: () => read.promise }, epoch: 1, ready: true, pageRequest: 0,
      pageIndex: 0, pageCursors: [null, { id: 'cursor-only' }], journalEntries: ['previous page'], loading: false };
    let paints = 0; let focuses = 0;
    const context = vm.createContext({ state, AbortController,
      viewTicket: () => ({ session: state.session, epoch: state.epoch }),
      sameView: ticket => ticket.session === state.session && ticket.epoch === state.epoch,
      currentView: async () => { entered.resolve(); return owner.promise; },
      renderPaging: () => { paints += 1; },
      $: () => ({ focus: () => { focuses += 1; } }),
    });
    vm.runInContext(`${pageFunction}\nglobalThis.load = loadJournalPage;`, context);
    const result = context.load(1);
    if (failedRead) read.reject(new Error('stale provider error'));
    else read.resolve({ entries: ['STALE PRIVATE PAGE'], hasNext: false, nextCursor: null });
    await entered.promise;
    // Another user action starts while the old request awaits owner validation.
    ++state.pageRequest; state.journalEntries = ['CURRENT PAGE']; state.loading = false;
    owner.resolve(true);
    assert.equal(await result, false);
    assert.deepEqual(state.journalEntries, ['CURRENT PAGE']);
    assert.equal(state.loading, false); assert.equal(state.pageError, false);
    assert.equal(state.pageIndex, 0); assert.equal(paints, 1); assert.equal(focuses, 0);
  });
}

for (const failedVerification of [false, true]) {
  test(`actual owner verifier cannot publish stale ${failedVerification ? 'unavailable' : 'changed-owner'} recovery after page replacement`, async () => {
    const owner = deferred(); let relevant = true; let publishes = 0;
    const state = { journalEntries: ['CURRENT PAGE'] };
    const context = vm.createContext({ state, sameView: () => true,
      scrubPrivateJournalState: () => { publishes += 1; }, renderPaging: () => { publishes += 1; },
      setFeedback: () => { publishes += 1; },
    });
    const verifier = source.slice(source.indexOf('async function currentView('), source.indexOf('async function loadJournalPage('));
    vm.runInContext(`${verifier}\nglobalThis.verify = currentView;`, context);
    const result = context.verify({ session: { isCurrent: () => owner.promise } }, () => relevant);
    relevant = false;
    if (failedVerification) owner.reject(new Error('temporarily unavailable'));
    else owner.resolve(false);
    assert.equal(await result, false); assert.equal(publishes, 0);
    assert.deepEqual(state.journalEntries, ['CURRENT PAGE']);
  });
}

for (const code of ['JOURNAL_OWNER_CHANGED', 'JOURNAL_SIGNED_OUT']) {
  test(`actual bootstrap scrubs preserved drafts when reopening rejects ${code} before returning a handle`, async () => {
    const boot = source.slice(source.indexOf('async function bootPrivateJournal('), source.indexOf("createForm.addEventListener('submit'"));
    const state = { epoch: 0, pageRequest: 0, ownerIdentity: { actorId: 'A', sessionIdentity: 'old-session' },
      journalEntries: ['OLD PRIVATE ENTRY'], ready: true, loading: false, pageError: false };
    let draft = 'OLD PRIVATE DRAFT'; let editing = 'OLD EDIT DRAFT'; let scrubbed = 0;
    const context = vm.createContext({ state, createForm: {}, setJournalFormBusy: () => {}, renderPaging: () => {},
      hasSupabaseAuth: () => true, isLocalDemoMode: () => false,
      getLocalOrSessionUser: async () => ({ authenticated: true, userId: 'A' }),
      openJournalSession: async () => { throw Object.assign(new Error('Do not publish raw details'), { code }); },
      scrubPrivateJournalState: () => { ++scrubbed; ++state.epoch; draft = ''; editing = ''; state.journalEntries = []; },
      setFeedback: message => assert.doesNotMatch(message, /raw details/),
    });
    vm.runInContext(`${boot}\nglobalThis.boot = bootPrivateJournal;`, context);
    await context.boot({ preserveDraft: true });
    assert.equal(scrubbed, 1); assert.equal(draft, ''); assert.equal(editing, '');
    assert.deepEqual(state.journalEntries, []); assert.equal(state.pageError, true);
  });
}

test('actual bootstrap retains a draft on temporary reopen failure without starting a retry loop', async () => {
  const boot = source.slice(source.indexOf('async function bootPrivateJournal('), source.indexOf("createForm.addEventListener('submit'"));
  const state = { epoch: 0, pageRequest: 0, journalEntries: [], ready: true };
  let destroyed = 0; let opened = 0; const draft = 'PRIVATE DRAFT';
  state.session = { destroy() { ++destroyed; } };
  const context = vm.createContext({ state, createForm: {}, setJournalFormBusy: () => {}, renderPaging: () => {},
    hasSupabaseAuth: () => true, isLocalDemoMode: () => false,
    getLocalOrSessionUser: async () => ({ authenticated: true, userId: 'A' }),
    openJournalSession: async () => { ++opened; throw Object.assign(new Error('Temporary failure'), { code: 'JOURNAL_UNAVAILABLE' }); },
    scrubPrivateJournalState: () => assert.fail('Temporary failure must not erase draft'), setFeedback: () => {},
  });
  vm.runInContext(`${boot}\nglobalThis.boot = bootPrivateJournal;`, context);
  await context.boot({ preserveDraft: true });
  assert.equal(destroyed, 1); assert.equal(opened, 1); assert.equal(draft, 'PRIVATE DRAFT');
  assert.equal(state.ready, false); assert.equal(state.loading, false); assert.equal(state.pageError, true);
});

test('actual partial bootstrap disposes its handle and pending sibling after a failed date policy', async () => {
  const boot = source.slice(source.indexOf('async function bootPrivateJournal('), source.indexOf("createForm.addEventListener('submit'"));
  const state = { epoch: 0, pageRequest: 0, journalEntries: [], ready: false };
  const sibling = deferred(); let destroyed = 0; let readStarted = 0;
  const session = { actorId: 'A', sessionIdentity: 'A:session',
    destroy() { ++destroyed; sibling.resolve({ entries: ['LATE PRIVATE PAGE'] }); },
    readPage() { ++readStarted; return sibling.promise; },
    async getDatePolicy() { throw Object.assign(new Error('Policy failure'), { code: 'JOURNAL_UNAVAILABLE' }); },
  };
  const context = vm.createContext({ state, createForm: {}, setJournalFormBusy: () => {}, renderPaging: () => {},
    hasSupabaseAuth: () => true, isLocalDemoMode: () => false,
    getLocalOrSessionUser: async () => ({ authenticated: true, userId: 'A' }), openJournalSession: async () => session,
    viewTicket: () => ({}), currentView: async () => true, getBillingState: async () => ({ authenticated: true, appAccess: true }),
    getCrews: async () => [], setFeedback: () => {},
  });
  vm.runInContext(`${boot}\nglobalThis.boot = bootPrivateJournal;`, context);
  await context.boot(); await sibling.promise;
  assert.equal(readStarted, 1); assert.equal(destroyed, 1); assert.equal(state.session, null);
  assert.equal(state.ready, false); assert.equal(state.pageError, true); assert.equal(state.journalEntries.length, 0);
});

test('actual bootstrap distinguishes unavailable code from lost ownership without discarding drafts or reloading', async () => {
  const boot = source.slice(source.indexOf('async function bootPrivateJournal('), source.indexOf("createForm.addEventListener('submit'"));
  const state = { epoch: 0, pageRequest: 0, journalEntries: [], ready: true };
  const createForm = { draft: 'PRIVATE CREATE DRAFT' }; const editForm = { draft: 'PRIVATE EDIT DRAFT' };
  let reloads = 0; let opened = 0;
  const context = vm.createContext({ state, createForm, editForm,
    editDialog: { setBusy: () => {} }, setJournalFormBusy: () => {}, renderPaging: () => {},
    hasSupabaseAuth: () => true, isLocalDemoMode: () => false,
    getLocalOrSessionUser: async () => ({ authenticated: true, userId: 'A' }),
    openJournalSession: async () => { ++opened; throw Object.assign(new Error('PRIVATE RAW IMPORT ERROR'), { code: 'JOURNAL_CODE_UNAVAILABLE' }); },
    scrubPrivateJournalState: () => assert.fail('Code failure is not evidence of an owner change'),
    resetJournalForm: () => assert.fail('Code failure must not reset a draft'),
    window: { location: { reload: () => { ++reloads; } } },
    setFeedback: message => assert.doesNotMatch(message, /PRIVATE RAW/),
  });
  vm.runInContext(`${boot}\nglobalThis.boot = bootPrivateJournal;`, context);
  await context.boot({ preserveDraft: true });
  assert.equal(opened, 1); assert.equal(reloads, 0);
  assert.equal(createForm.draft, 'PRIVATE CREATE DRAFT'); assert.equal(editForm.draft, 'PRIVATE EDIT DRAFT');
  assert.equal(state.codeUnavailable, true); assert.equal(state.pageError, true); assert.equal(state.loading, false);
});
