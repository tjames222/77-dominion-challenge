import {
  createJournalEntry,
  getBillingState,
  getCrews,
  getJournalEntries,
  getLocalOrSessionUser,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  subscribeToAuthStateChanges,
  updateJournalEntry,
} from './api';
import { createDialog } from './dialog.mjs';
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
const todayKey = () => new Date().toISOString().slice(0, 10);
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
  journalEntries: [],
};

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
    entry.energy ? `${entry.energy} energy` : '',
    formatEntryTime(entry.createdAt),
  ].filter(Boolean);
}

function renderEntry(entry, formattedDate) {
  const title = entry.win || 'Private entry';
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
          <p class="journal-entry-kicker">${escapeHtml(entry.mood || 'Journal entry')}</p>
          <h4>${escapeHtml(title)}</h4>
        </div>
        ${editButton}
      </header>
      ${metadata.length ? `<p class="journal-entry-meta">${metadata.map(escapeHtml).join(' · ')}</p>` : ''}
      ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ''}
      ${entry.prayer ? `<p><strong>Prayer or reflection:</strong> ${escapeHtml(entry.prayer)}</p>` : ''}
    </article>
  `;
}

function renderJournal() {
  const timeline = $('journalTimeline');
  if (!timeline) return;
  if (!state.journalEntries.length) {
    timeline.innerHTML = '<article class="empty-state card"><p>Your private journal is ready. Save a note and start building the record.</p></article>';
    return;
  }

  timeline.innerHTML = groupJournalEntriesByDate(state.journalEntries).map((group) => {
    const formattedDate = formatJournalDate(group.date);
    const headingId = `journal-date-${String(group.date || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const countLabel = `${group.entries.length} ${group.entries.length === 1 ? 'entry' : 'entries'}`;
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

async function refreshJournal() {
  state.journalEntries = await getJournalEntries();
  renderJournal();
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

const editForm = createJournalForm(journalFormTemplate, {
  formId: 'journalEditForm',
  idPrefix: 'journalEdit',
  label: 'Edit private journal entry',
  submitLabel: 'Save Changes',
  cancelLabel: 'Cancel',
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
  const entry = state.journalEntries.find((item) => item.id === entryId);
  if (!entry) {
    setFeedback('That journal entry is no longer available.');
    return;
  }
  state.editingEntryId = entry.id;
  writeJournalForm(editForm, entry);
  editDialog.open(trigger);
}

async function bootPrivateJournal() {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin(RETURN_PATH);
    return;
  }

  state.billing = await getBillingState();
  if (!state.billing.authenticated) {
    redirectToLogin(RETURN_PATH);
    return;
  }
  if (!state.billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }

  state.currentUser = await getLocalOrSessionUser();
  [state.crews, state.journalEntries] = await Promise.all([
    getCrews(),
    getJournalEntries(),
  ]);
  renderJournal();

  if (isLocalDemoMode()) {
    setFeedback('Preview mode: private journal entries use local mock data.');
  }
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!createForm.reportValidity()) return;

  const values = readJournalForm(createForm);
  setJournalFormBusy(createForm, true, 'Saving…');
  try {
    await createJournalEntry({
      ...values,
      day: challengeDay(activeCrew()?.challengeStartDate, values.date),
    });
    resetJournalForm(createForm, todayKey());
    await refreshJournal();
    setFeedback('Private journal entry saved.');
  } catch (error) {
    window.alert(error?.message || 'Unable to save your journal entry right now.');
  } finally {
    setJournalFormBusy(createForm, false);
  }
});

editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editForm.reportValidity() || !state.editingEntryId) return;

  const entryId = state.editingEntryId;
  const values = readJournalForm(editForm);
  let saved = false;
  editDialog.clearError();
  editDialog.setBusy(true, 'Saving changes…');
  setJournalFormBusy(editForm, true, 'Saving…');
  try {
    await updateJournalEntry(entryId, {
      ...values,
      day: challengeDay(activeCrew()?.challengeStartDate, values.date),
    });
    await refreshJournal();
    setFeedback('Journal entry updated.');
    saved = true;
  } catch (error) {
    editDialog.setError(error?.message || 'Unable to update this journal entry right now.');
  } finally {
    setJournalFormBusy(editForm, false);
    editDialog.setBusy(false);
  }
  if (saved) editDialog.close('saved');
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
  state.currentUser = null;
  state.billing = null;
  state.crews = [];
  state.journalEntries = [];
  setJournalFormBusy(editForm, false);
  editDialog.setBusy(false);
  editDialog.close('account-change');
  resetJournalForm(createForm, todayKey());
  renderJournal();
}

const unsubscribeJournalAuth = subscribeToAuthStateChanges(({ event, user }) => {
  const signedOut = event === 'SIGNED_OUT' || !user?.authenticated;
  const accountChanged = Boolean(
    user?.userId
    && state.currentUser?.userId
    && user.userId !== state.currentUser.userId
  );
  if (!signedOut && !accountChanged) return;
  scrubPrivateJournalState();
  if (signedOut) {
    redirectToLogin(RETURN_PATH);
  } else {
    window.location.reload();
  }
});

let journalAuthUnsubscribed = false;
window.addEventListener('pagehide', (event) => {
  if (!event.persisted && !journalAuthUnsubscribed) {
    journalAuthUnsubscribed = true;
    unsubscribeJournalAuth();
  }
});

bootPrivateJournal().catch((error) => {
  console.warn('Unable to load private journal', error);
  setFeedback(error?.message || 'Unable to load your private journal right now.');
});
