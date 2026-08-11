import {
  getBillingState,
  getCrews,
  getJournalEntries,
  getLocalOrSessionUser,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  saveJournalEntry,
  subscribeToAuthStateChanges,
} from './api';

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
  journalEntries: [],
};

function setFeedback(message = '') {
  const feedback = $('communityFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('active', Boolean(message));
}

function setButtonBusy(button, label) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = original;
  };
}

function activeCrew() {
  const storedCrewId = localStorage.getItem('dominion:activeCrewId') || '';
  return state.crews.find((crew) => crew.id === storedCrewId) || state.crews[0] || null;
}

function dayNumber(startDate) {
  if (!startDate) return null;
  const start = new Date(`${startDate}T00:00:00`);
  const today = new Date(`${todayKey()}T00:00:00`);
  return Math.max(1, Math.floor((today - start) / 86400000) + 1);
}

function renderJournal() {
  const timeline = $('journalTimeline');
  if (!timeline) return;
  if (!state.journalEntries.length) {
    timeline.innerHTML = '<article class="empty-state card"><p>Your private journal is ready. Save a note and start building the record.</p></article>';
    return;
  }

  timeline.innerHTML = state.journalEntries.map((entry) => `
    <article class="card timeline-note">
      <span>${entry.day ? `Day ${entry.day}` : escapeHtml(entry.date)}</span>
      <strong>${escapeHtml(entry.win || entry.mood || 'Private entry')}</strong>
      ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ''}
      ${entry.prayer ? `<p>${escapeHtml(entry.prayer)}</p>` : ''}
      ${entry.energy ? `<small>Energy: ${escapeHtml(entry.energy)}</small>` : ''}
    </article>
  `).join('');
}

function fillJournalFormForDate() {
  const selectedDate = $('journalDate')?.value || todayKey();
  const entry = state.journalEntries.find((item) => item.date === selectedDate);
  $('journalNote').value = entry?.note || '';
  $('journalWin').value = entry?.win || '';
  $('journalPrayer').value = entry?.prayer || '';
  $('journalMood').value = entry?.mood || '';
  $('journalEnergy').value = entry?.energy || '';
}

async function refreshJournal() {
  state.journalEntries = await getJournalEntries();
  renderJournal();
  fillJournalFormForDate();
}

async function bootPrivateJournal() {
  $('journalDate').value = todayKey();

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
  fillJournalFormForDate();

  if (isLocalDemoMode()) {
    setFeedback('Preview mode: private journal entries use local mock data.');
  }
}

$('journalDate')?.addEventListener('change', fillJournalFormForDate);

$('journalForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const release = setButtonBusy(event.submitter, 'Saving...');
  try {
    await saveJournalEntry({
      date: $('journalDate').value,
      day: dayNumber(activeCrew()?.challengeStartDate),
      note: $('journalNote').value.trim(),
      win: $('journalWin').value.trim(),
      prayer: $('journalPrayer').value.trim(),
      mood: $('journalMood').value,
      energy: $('journalEnergy').value,
    });
    setFeedback('Private journal entry saved.');
    await refreshJournal();
  } catch (error) {
    window.alert(error?.message || 'Unable to save your journal entry right now.');
  } finally {
    release();
  }
});

function scrubPrivateJournalState() {
  state.currentUser = null;
  state.billing = null;
  state.crews = [];
  state.journalEntries = [];
  renderJournal();
  fillJournalFormForDate();
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
