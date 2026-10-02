import {
  getBillingState,
  getCrews,
  getLocalOrSessionUser,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  subscribeToAuthStateChanges,
} from './api';
import { openJournalSession } from './journal-api-entry.mjs';
import { createConfirmationDialog, createDialog } from './dialog.mjs';
import { dateKeyForTimeZone } from './check-in.mjs';
import {
  createJournalDatePicker,
  isJournalFutureDateError,
} from './journal-date-picker.mjs';
import {
  JOURNAL_CARD_FIELD_DEFINITIONS,
  JOURNAL_CARD_TITLE,
} from './journal-fields.mjs';
import {
  createJournalForm,
  readJournalForm,
  resetJournalForm,
  setJournalFormBusy,
  writeJournalForm,
} from './journal-form.mjs';
import { groupJournalEntriesByDate } from './journal-entry.mjs';

const RETURN_PATH = './private-journal.html';
const $ = (id) => document.getElementById(id);
const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const initialTimeZone = browserTimeZone();
const initialToday = dateKeyForTimeZone(new Date(), initialTimeZone);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[char]));

const state = {
  billing: null,
  crews: [],
  currentUser: null,
  editingEntryId: null,
  journalDatePolicy: {
    timeZone: initialTimeZone,
    today: initialToday,
  },
  journalEntries: [],
  session: null,
  ownerIdentity: null,
  epoch: 0,
  pageRequest: 0,
  pageAbort: null,
  pageIndex: 0,
  pageCursors: [null],
  nextCursor: null,
  hasNext: false,
  loading: true,
  pageError: false,
  retryPage: 0,
  ready: false,
  saving: false,
  writeUnconfirmed: false,
  codeUnavailable: false,
};

const todayKey = () => state.journalDatePolicy.today;

function setFeedback(message = '') {
  const feedback = $('communityFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('active', Boolean(message));
}

function activeCrew() {
  const storedCrewId = localStorage.getItem('dominion:activeCrewId') || '';
  return state.crews.find((crew) => crew.id === storedCrewId) || state.crews[0] || null;
}

function challengeDay(startDate, entryDate) {
  if (!startDate || !entryDate) return null;
  const start = new Date(`${startDate}T00:00:00`);
  const target = new Date(`${entryDate}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(target.getTime())) return null;
  return Math.max(1, Math.floor((target - start) / 86400000) + 1);
}

function formatJournalDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!year || !month || !day) return value || 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function formatEntryTime(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function entryMetadata(entry) {
  return [
    entry.day ? `Challenge day ${entry.day}` : '',
    formatEntryTime(entry.createdAt),
  ].filter(Boolean);
}

function renderEntrySections(entry) {
  const sections = JOURNAL_CARD_FIELD_DEFINITIONS.flatMap((field) => {
    const value = String(entry?.[field.name] || '').trim();
    if (!value) return [];
    return [`
      <section class="journal-entry-section" data-journal-card-field="${escapeHtml(field.name)}">
        <h5>${escapeHtml(field.label)}</h5>
        <p>${escapeHtml(value)}</p>
      </section>
    `];
  });
  return sections.length
    ? `<div class="journal-entry-sections">${sections.join('')}</div>`
    : '';
}

function renderEntry(entry, formattedDate) {
  const metadata = entryMetadata(entry);
  const editButton = entry.id ? `
    <button
      class="journal-edit-button"
      type="button"
      data-edit-journal-entry="${escapeHtml(entry.id)}"
      aria-label="Edit journal entry from ${escapeHtml(formattedDate)}"
    ><span aria-hidden="true">✎</span></button>
  ` : '';

  return `
    <article class="card timeline-note" data-journal-entry-id="${escapeHtml(entry.id || '')}">
      <header class="journal-entry-heading">
        <div>
          <h4>${escapeHtml(JOURNAL_CARD_TITLE)}</h4>
        </div>
        ${editButton}
      </header>
      ${metadata.length ? `<p class="journal-entry-meta">${metadata.map(escapeHtml).join(' · ')}</p>` : ''}
      ${renderEntrySections(entry)}
    </article>
  `;
}

function renderJournal() {
  const timeline = $('journalTimeline');
  if (!timeline) return;
  timeline.setAttribute('aria-busy', String(state.loading));
  if (state.loading || state.pageError || !state.ready) {
    timeline.replaceChildren();
    return;
  }
  if (!state.journalEntries.length) {
    timeline.innerHTML = '<article class="empty-state card"><p>Your private journal is ready. Save a note and start building the record.</p></article>';
    return;
  }

  timeline.innerHTML = groupJournalEntriesByDate(state.journalEntries, { preserveOrder: true }).map((group) => {
    const formattedDate = formatJournalDate(group.date);
    const headingId = `journal-date-${String(group.date || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const countLabel = `${group.entries.length} ${group.entries.length === 1 ? 'entry' : 'entries'} on this page`;
    return `
      <section class="journal-date-group" aria-labelledby="${headingId}">
        <header class="journal-date-heading">
          <h3 id="${headingId}"><time datetime="${escapeHtml(group.date)}">${escapeHtml(formattedDate)}</time></h3>
          <span>${countLabel}</span>
        </header>
        <div class="journal-date-entries">
          ${group.entries.map((entry) => renderEntry(entry, formattedDate)).join('')}
        </div>
      </section>
    `;
  }).join('');
}

function renderPaging() {
  const blocked = state.loading || state.saving || !state.ready;
  $('journalPageNewer').disabled = blocked || state.pageIndex === 0;
  $('journalPageNewest').disabled = blocked || (state.pageIndex === 0 && !state.pageError && !state.writeUnconfirmed);
  $('journalPageOlder').disabled = blocked || state.pageError || !state.hasNext;
  $('journalPageRetry').disabled = state.loading || state.saving;
  $('journalPageRetry').hidden = state.codeUnavailable;
  $('journalPageReload').hidden = !state.codeUnavailable;
  $('journalPageReload').disabled = state.loading || state.saving;
  $('journalReconcile').hidden = !state.writeUnconfirmed;
  $('journalReconcile').disabled = blocked;
  if (state.writeUnconfirmed || state.codeUnavailable) {
    createForm.querySelector('[data-journal-submit]').disabled = true;
    editForm.querySelector('[data-journal-submit]').disabled = true;
  }
  $('journalPageError').hidden = !state.pageError;
  $('journalPageError').querySelector('p').textContent = state.codeUnavailable
    ? 'The journal’s code couldn’t load. Reload to try again. Reloading will clear unsaved drafts; copy any text you want to keep first.'
    : state.ready ? 'Your entries couldn’t load. Retry to load this page.'
      : 'Your private journal could not be opened. Retry to verify your session and load your entries.';
  $('journalHistoryTitle').textContent = state.pageIndex === 0 ? 'Recent entries' : `Earlier entries · page ${state.pageIndex + 1}`;
  $('journalPageStatus').textContent = state.loading
    ? 'Loading journal entries…'
    : state.codeUnavailable ? 'Journal code is unavailable. Reload to continue.'
      : state.pageError ? 'Entries are unavailable. Retry to load this page.'
      : `${state.journalEntries.length} ${state.journalEntries.length === 1 ? 'entry' : 'entries'} on this page${state.hasNext ? ' · Older entries available' : ''}.`;
  renderJournal();
}

function viewTicket() {
  return { epoch: state.epoch, session: state.session };
}

function sameView(ticket) {
  return ticket.epoch === state.epoch && ticket.session === state.session && Boolean(ticket.session);
}

async function currentView(ticket, isRelevant = () => true) {
  if (!sameView(ticket) || !isRelevant()) return false;
  let current = false;
  try { current = await ticket.session.isCurrent(); } catch {
    if (!sameView(ticket) || !isRelevant()) return false;
    // A failed verification is not proof of an account switch. Keep the draft
    // in memory, hide history and require a fresh read without a retry loop.
    if (state.saving) state.writeUnconfirmed = true;
    state.journalEntries = [];
    state.loading = false;
    state.pageError = true;
    renderPaging();
    setFeedback('Your session could not be verified. Retry loading entries when your connection is available.');
    return false;
  }
  if (!sameView(ticket) || !isRelevant()) return false;
  if (current) return true;
  scrubPrivateJournalState();
  state.pageError = true;
  renderPaging();
  setFeedback('Your session needs to be verified again. Retry loading entries to continue.');
  return false;
}

async function loadJournalPage(pageIndex, { focus = true, reset = false } = {}) {
  const ticket = viewTicket();
  if (!ticket.session || !state.ready) return false;
  const cursor = reset ? null : state.pageCursors[pageIndex];
  if (cursor === undefined) return false;
  state.pageAbort?.abort();
  const controller = new AbortController();
  state.pageAbort = controller;
  const request = ++state.pageRequest;
  state.loading = true;
  state.pageError = false;
  state.retryPage = pageIndex;
  state.journalEntries = [];
  renderPaging();
  try {
    const page = await ticket.session.readPage({ cursor, signal: controller.signal });
    if (!sameView(ticket) || request !== state.pageRequest
      || !await currentView(ticket, () => request === state.pageRequest && !controller.signal.aborted)) return false;
    if (request !== state.pageRequest || controller.signal.aborted) return false;
    if (reset) state.pageCursors = [null];
    state.pageIndex = pageIndex;
    state.journalEntries = page.entries;
    state.hasNext = page.hasNext;
    state.nextCursor = page.nextCursor;
    // Only cursors survive page changes; never cache prior private entry bodies.
    state.pageCursors.length = pageIndex + 1;
    if (page.hasNext) state.pageCursors.push(page.nextCursor);
    state.loading = false;
    if (reset && pageIndex === 0) {
      state.writeUnconfirmed = false;
      if (!state.saving) {
        setJournalFormBusy(createForm, false);
        setJournalFormBusy(editForm, false);
      }
    }
    renderPaging();
    if (focus) $('journalHistoryTitle').focus();
    return true;
  } catch {
    if (!sameView(ticket) || request !== state.pageRequest
      || !await currentView(ticket, () => request === state.pageRequest && !controller.signal.aborted)) return false;
    if (request !== state.pageRequest || controller.signal.aborted) return false;
    state.loading = false;
    state.pageError = true;
    renderPaging();
    if (focus) $('journalPageRetry').focus();
    return false;
  }
}

const journalFormTemplate = $('journalFormTemplate');
const createForm = createJournalForm(journalFormTemplate, {
  formId: 'journalForm',
  idPrefix: 'journal',
  label: 'New private journal entry',
  submitLabel: 'Save Private Entry',
});
$('journalCreateFormMount')?.append(createForm);
resetJournalForm(createForm, todayKey());
const createDatePicker = createJournalDatePicker(createForm, {
  idPrefix: 'journalCreate',
  maximumDate: todayKey,
});
// Auth, entries, and the actor-local date policy load together. Keep every
// control locked until the final reset so a late response cannot erase a draft.
setJournalFormBusy(createForm, true, 'Loading journal…');

const editForm = createJournalForm(journalFormTemplate, {
  formId: 'journalEditForm',
  idPrefix: 'journalEdit',
  label: 'Edit private journal entry',
  submitLabel: 'Save Changes',
  cancelLabel: 'Cancel',
});
const editDatePicker = createJournalDatePicker(editForm, {
  idPrefix: 'journalEdit',
  maximumDate: todayKey,
});

const editDialog = createDialog({
  id: 'journalEditDialog',
  eyebrow: 'Private Journal',
  title: 'Edit entry',
  description: 'Update this entry without changing any other note from that day.',
  closeLabel: 'Close journal editor',
  presentation: 'responsive',
  content: editForm,
  initialFocus: '#journalEditDate',
  onClose: () => {
    state.editingEntryId = null;
    resetJournalForm(editForm);
  },
});

function openJournalEditor(entryId, trigger) {
  if (!state.ready || state.loading || state.saving) return;
  const entry = state.journalEntries.find((item) => item.id === entryId);
  if (!entry) {
    setFeedback('That journal entry is no longer available.');
    return;
  }
  state.editingEntryId = entry.id;
  writeJournalForm(editForm, entry);
  editDialog.open(trigger);
}

async function bootPrivateJournal({ preserveDraft = false } = {}) {
  const epoch = ++state.epoch;
  ++state.pageRequest;
  state.pageAbort?.abort();
  state.session?.destroy();
  state.session = null;
  state.journalEntries = [];
  state.ready = false;
  state.loading = true;
  state.pageError = false;
  state.codeUnavailable = false;
  setJournalFormBusy(createForm, true, 'Loading journal…');
  renderPaging();
  let session = null;
  try {
    if (!hasSupabaseAuth() && !isLocalDemoMode()) {
      redirectToLogin(RETURN_PATH);
      return;
    }

    const user = await getLocalOrSessionUser();
    if (epoch !== state.epoch) return;
    if (!user?.authenticated) {
      redirectToLogin(RETURN_PATH);
      return;
    }
    session = await openJournalSession({ expectedUserId: user.userId });
    if (epoch !== state.epoch) { session.destroy(); return; }
    if (preserveDraft && state.ownerIdentity
      && (state.ownerIdentity.actorId !== session.actorId || state.ownerIdentity.sessionIdentity !== session.sessionIdentity)) {
      session.destroy();
      scrubPrivateJournalState();
      scheduleBoot();
      return;
    }
    state.session = session;
    state.ownerIdentity = { actorId: session.actorId, sessionIdentity: session.sessionIdentity };
    state.currentUser = user;
    const ticket = viewTicket();
    const billing = await getBillingState();
    if (!await currentView(ticket)) return;
    if (!billing.authenticated) {
      redirectToLogin(RETURN_PATH);
      return;
    }
    if (!billing.appAccess) {
      window.location.href = './billing.html?intent=subscription';
      return;
    }

    const [crews, policy, page] = await Promise.all([
      getCrews(),
      session.getDatePolicy({}),
      session.readPage({}),
    ]);
    if (!await currentView(ticket)) return;
    state.billing = billing;
    state.crews = crews;
    state.journalDatePolicy = policy;
    state.journalEntries = page.entries;
    state.pageIndex = 0;
    state.pageCursors = page.hasNext ? [null, page.nextCursor] : [null];
    state.nextCursor = page.nextCursor;
    state.hasNext = page.hasNext;
    state.ready = true;
    state.loading = false;
    createDatePicker.setMaximumDate(todayKey());
    editDatePicker.setMaximumDate(todayKey());
    if (!preserveDraft) resetJournalForm(createForm, todayKey());
    renderPaging();
    setJournalFormBusy(createForm, false);
    setJournalFormBusy(editForm, false);
    editDialog.setBusy(false);
    renderPaging();

    if (state.writeUnconfirmed) {
      setFeedback('We couldn’t confirm the pending save after your session refreshed. Your draft is still here. Review entries for the selected date before saving again.');
    } else if (isLocalDemoMode()) {
      setFeedback('Preview mode: private journal entries use local mock data.');
    }
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error?.code === 'JOURNAL_CODE_UNAVAILABLE') {
      state.codeUnavailable = true;
      state.loading = false;
      state.pageError = true;
      // Keep typed text available to copy/edit, but saving remains disabled.
      // Only the separate user-confirmed reload may discard the draft.
      setJournalFormBusy(createForm, false);
      setJournalFormBusy(editForm, false);
      editDialog.setBusy(false);
      renderPaging();
      return;
    }
    if (error?.code === 'JOURNAL_OWNER_CHANGED' || error?.code === 'JOURNAL_SIGNED_OUT'
      || (!session && error?.code !== 'JOURNAL_UNAVAILABLE')) {
      scrubPrivateJournalState();
      state.pageError = true;
      renderPaging();
      setFeedback('Your session needs to be verified again. Retry loading entries to continue.');
      return;
    }
    if (session && !await currentView(viewTicket())) return;
    state.loading = false;
    state.pageError = true;
    renderPaging();
    setFeedback('Unable to open your private journal right now. Retry loading entries.');
  } finally {
    if (epoch === state.epoch && !state.ready && session) {
      session.destroy();
      if (state.session === session) state.session = null;
    }
  }
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.ready || state.saving || state.writeUnconfirmed) return;
  if (!createDatePicker.validate({ announce: true, focus: true }) || !createForm.reportValidity()) return;

  const values = readJournalForm(createForm);
  const ticket = viewTicket();
  state.saving = true;
  renderPaging();
  setJournalFormBusy(createForm, true, 'Saving…');
  try {
    await ticket.session.createEntry(
      {
        ...values,
        day: challengeDay(activeCrew()?.challengeStartDate, values.date),
      },
      {},
    );
    if (!await currentView(ticket)) return;
    resetJournalForm(createForm, todayKey());
    const loaded = await loadJournalPage(0, { focus: true, reset: true });
    if (!sameView(ticket)) return;
    setFeedback(loaded ? 'Private journal entry saved.' : 'Private journal entry saved. Your history couldn’t refresh; retry loading entries, not saving again.');
  } catch (error) {
    if (!await currentView(ticket)) return;
    if (isJournalFutureDateError(error)) {
      createDatePicker.showFutureDateError();
      return;
    }
    if (error?.journalCommitted === true && error?.writeOutcome === 'confirmed') {
      resetJournalForm(createForm, todayKey());
      const loaded = await loadJournalPage(0, { reset: true });
      if (sameView(ticket)) setFeedback(loaded ? 'Private journal entry saved.' : 'Private journal entry saved. Retry loading your history, not saving again.');
    } else if (error?.writeOutcome === 'not-dispatched') {
      setFeedback('Your entry could not be sent. Your draft is still here; check it and try again.');
    } else {
      setFeedback('We couldn’t confirm this save. Your draft is still here. Review entries for the selected date before saving again.');
      state.writeUnconfirmed = true;
    }
  } finally {
    if (sameView(ticket)) {
      state.saving = false;
      setJournalFormBusy(createForm, false);
      renderPaging();
    }
  }
});

editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.ready || state.saving || state.writeUnconfirmed) return;
  if (!editDatePicker.validate({ announce: true, focus: true })
    || !editForm.reportValidity()
    || !state.editingEntryId) return;

  const entryId = state.editingEntryId;
  const values = readJournalForm(editForm);
  const ticket = viewTicket();
  state.saving = true;
  renderPaging();
  let saved = false;
  editDialog.clearError();
  editDialog.setBusy(true, 'Saving changes…');
  setJournalFormBusy(editForm, true, 'Saving…');
  try {
    await ticket.session.updateEntry(
      entryId,
      {
        ...values,
        day: challengeDay(activeCrew()?.challengeStartDate, values.date),
      },
      {},
    );
    if (!await currentView(ticket)) return;
    const loaded = await loadJournalPage(0, { focus: false, reset: true });
    if (!sameView(ticket)) return;
    setFeedback(loaded ? 'Journal entry updated.' : 'Journal entry updated. Your history couldn’t refresh; retry loading entries, not saving again.');
    saved = true;
  } catch (error) {
    if (!await currentView(ticket)) return;
    if (isJournalFutureDateError(error)) {
      editDatePicker.showFutureDateError();
    } else if (error?.journalCommitted === true && error?.writeOutcome === 'confirmed') {
      const loaded = await loadJournalPage(0, { focus: false, reset: true });
      if (sameView(ticket)) {
        setFeedback(loaded ? 'Journal entry updated.' : 'Journal entry updated. Retry loading your history, not saving again.');
        saved = true;
      }
    } else if (error?.writeOutcome === 'not-dispatched') {
      editDialog.setError('Your update could not be sent. Your draft is still here; check it and try again.');
    } else {
      editDialog.setError('We couldn’t confirm this update. Your draft is still here. Review entries for the selected date before trying again.');
      state.writeUnconfirmed = true;
    }
  } finally {
    if (sameView(ticket)) {
      state.saving = false;
      setJournalFormBusy(editForm, false);
      editDialog.setBusy(false);
      renderPaging();
    }
  }
  if (saved && sameView(ticket)) {
    editDialog.close('saved');
    $('journalHistoryTitle').focus();
  }
});

editForm.querySelector('[data-journal-cancel]')?.addEventListener('click', () => {
  editDialog.close('cancel');
});

$('journalTimeline')?.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-edit-journal-entry]');
  if (!trigger) return;
  openJournalEditor(trigger.dataset.editJournalEntry, trigger);
});

function scrubPrivateJournalState() {
  ++state.epoch;
  ++state.pageRequest;
  state.pageAbort?.abort();
  state.session?.destroy();
  state.session = null;
  state.ownerIdentity = null;
  state.ready = false;
  state.loading = false;
  state.pageError = false;
  state.saving = false;
  state.writeUnconfirmed = false;
  state.codeUnavailable = false;
  state.pageIndex = 0;
  state.pageCursors = [null];
  state.nextCursor = null;
  state.hasNext = false;
  state.currentUser = null;
  state.billing = null;
  state.crews = [];
  state.journalEntries = [];
  state.journalDatePolicy = { timeZone: initialTimeZone, today: initialToday };
  createDatePicker.setMaximumDate(todayKey());
  editDatePicker.setMaximumDate(todayKey());
  setJournalFormBusy(editForm, false);
  editDialog.setBusy(false);
  editDialog.close('account-change');
  reloadDialog?.close('account-change');
  createDatePicker.dialog.close('account-change');
  editDatePicker.dialog.close('account-change');
  resetJournalForm(createForm, todayKey());
  resetJournalForm(editForm);
  setJournalFormBusy(createForm, true, 'Loading journal…');
  setFeedback('');
  renderPaging();
}

let bootTimer = null;
let reloadDialog = null;
function scheduleBoot(options = {}) {
  window.clearTimeout(bootTimer);
  bootTimer = window.setTimeout(() => { bootTimer = null; void bootPrivateJournal(options); }, 0);
}

$('journalPageOlder').addEventListener('click', () => { void loadJournalPage(state.pageIndex + 1); });
$('journalPageNewer').addEventListener('click', () => { void loadJournalPage(state.pageIndex - 1); });
$('journalPageNewest').addEventListener('click', () => { void loadJournalPage(0, { reset: true }); });
$('journalReconcile').addEventListener('click', async () => {
  const ticket = viewTicket();
  // Reconcile a possible commit by reading only. Never repeat its mutation.
  if (await loadJournalPage(0, { reset: true }) && sameView(ticket)) {
    setFeedback('Newest entries refreshed. The previous save may already exist on its selected date, including an older page. Check that date before choosing to save again. Another save can create a duplicate.');
  }
});
$('journalPageRetry').addEventListener('click', () => {
  if (!state.ready) scheduleBoot({ preserveDraft: true });
  else void loadJournalPage(state.retryPage);
});
$('journalPageReload').addEventListener('click', (event) => {
  if (!state.codeUnavailable) return;
  reloadDialog ||= createConfirmationDialog({
    id: 'journalReloadDialog',
    title: 'Reload your journal?',
    description: 'Reloading will clear unsaved drafts. Copy any text you want to keep, then reload. Saved journal entries will not be changed.',
    cancelLabel: 'Keep draft',
    confirmLabel: 'Reload journal',
    pendingLabel: 'Reloading…',
    onConfirm: () => {
      if (state.codeUnavailable) window.location.reload();
    },
  });
  reloadDialog.open(event.currentTarget);
});

let observedJournalIdentity = null;
const unsubscribeJournalAuth = subscribeToAuthStateChanges(({ event, user, sessionIdentity }) => {
  const signedOut = event === 'SIGNED_OUT' || !user?.authenticated;
  // Keep the last notification even while a new handle is opening. Otherwise
  // a rapid A → B → A replacement can slip between two bootstrap awaits.
  const previousIdentity = state.ownerIdentity || observedJournalIdentity;
  observedJournalIdentity = signedOut ? null : { actorId: user.userId, sessionIdentity };
  const accountChanged = Boolean(
    previousIdentity && (user?.userId !== previousIdentity.actorId || sessionIdentity !== previousIdentity.sessionIdentity)
  );
  if (!signedOut && !accountChanged) {
    if (event === 'TOKEN_REFRESHED') {
      ++state.epoch;
      ++state.pageRequest;
      state.pageAbort?.abort();
      state.session?.destroy();
      state.session = null;
      state.journalEntries = [];
      if (state.saving) state.writeUnconfirmed = true;
      state.saving = false;
      setJournalFormBusy(createForm, true, 'Loading journal…');
      setJournalFormBusy(editForm, true, 'Loading journal…');
      editDialog.setBusy(false);
      scheduleBoot({ preserveDraft: true });
      state.loading = true;
      state.ready = false;
      renderPaging();
    }
    return;
  }
  scrubPrivateJournalState();
  if (signedOut) {
    redirectToLogin(RETURN_PATH);
  } else {
    scheduleBoot();
  }
});

let journalAuthUnsubscribed = false;
window.addEventListener('pagehide', (event) => {
  window.clearTimeout(bootTimer);
  scrubPrivateJournalState();
  if (!event.persisted && !journalAuthUnsubscribed) {
    journalAuthUnsubscribed = true;
    unsubscribeJournalAuth();
  }
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) scheduleBoot();
});

void bootPrivateJournal();
