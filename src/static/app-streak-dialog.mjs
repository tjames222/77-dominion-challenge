import { createDialog } from './dialog.mjs';
import { STREAK_METRIC_DEFINITIONS, streakMetrics } from './streak-summary.mjs';
import { normalizeChallengeStartDate } from './shared-header-state.mjs';

function element(document, tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatChallengeStartDate(value) {
  const normalized = normalizeChallengeStartDate(value);
  if (!normalized) return 'Not set';
  const [year, month, day] = normalized.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

// Presentation only. The eager header retains reads, writes, owner checks and
// request coalescing; importing this module does not construct UI or do I/O.
export function createAppStreakDialog({ document, onOpen, onClose, onSubmit, getState }) {
  const content = element(document, 'div', 'global-streak-details');
  const loadStatus = element(document, 'p', 'global-streak-load-status', 'Loading your current streaks…');
  loadStatus.dataset.globalStreakLoadStatus = '';
  loadStatus.setAttribute('role', 'status');
  loadStatus.setAttribute('aria-live', 'polite');
  const zeroState = element(document, 'p', 'global-streak-zero',
    'No streak history yet. Complete all seven Daily Actions to start a perfect-day streak.');
  zeroState.dataset.globalStreakZero = '';
  zeroState.hidden = true;
  const grid = element(document, 'div', 'global-streak-grid');
  STREAK_METRIC_DEFINITIONS.forEach(({ key, kind, label }) => {
    const metric = element(document, 'article', 'global-streak-metric');
    metric.dataset.streakKind = kind === 'Personal best' ? 'best' : 'current';
    metric.append(element(document, 'span', 'global-streak-kind', kind), element(document, 'h3', '', label));
    const valueRow = element(document, 'p', 'global-streak-value');
    const value = element(document, 'strong', '', '0'); value.dataset.globalStreakValue = key;
    const unit = element(document, 'span', '', 'days'); unit.dataset.globalStreakUnit = key;
    valueRow.append(value, unit); metric.append(valueRow); grid.append(metric);
  });
  const timeline = element(document, 'section', 'global-streak-start-date');
  const heading = element(document, 'div', 'global-streak-start-date-heading');
  const headingCopy = element(document, 'div');
  headingCopy.append(element(document, 'p', 'eyebrow', 'Challenge timeline'), element(document, 'h3', '', 'Challenge start date'));
  const dateDisplay = element(document, 'strong', 'global-streak-start-date-display', 'Not set');
  dateDisplay.dataset.globalStreakStartDateDisplay = '';
  heading.append(headingCopy, dateDisplay);
  const form = element(document, 'form', 'global-streak-start-date-form');
  form.dataset.globalStreakStartDateForm = '';
  const label = element(document, 'label');
  label.append(element(document, 'span', '', 'Start date'));
  const dateInput = document.createElement('input');
  dateInput.type = 'date'; dateInput.name = 'challengeStartDate'; dateInput.required = true;
  dateInput.disabled = true; dateInput.dataset.globalStreakStartDateInput = '';
  label.append(dateInput);
  const saveButton = element(document, 'button', 'primary', 'Save start date');
  saveButton.type = 'submit'; saveButton.disabled = true; saveButton.dataset.globalStreakStartDateSave = '';
  form.append(label, saveButton);
  const dateHelp = element(document, 'p', 'global-streak-start-date-help');
  dateHelp.dataset.globalStreakStartDateHelp = '';
  const dateFeedback = element(document, 'p', 'global-streak-start-date-feedback');
  dateFeedback.dataset.globalStreakStartDateFeedback = '';
  dateFeedback.setAttribute('role', 'status'); dateFeedback.setAttribute('aria-live', 'polite');
  dateFeedback.setAttribute('aria-atomic', 'true');
  timeline.append(heading, form, dateHelp, dateFeedback);
  content.append(loadStatus, zeroState, grid, timeline);
  const dialog = createDialog({
    document,
    id: 'globalStreakDetailsDialog', title: 'App Streak', eyebrow: 'Your consistency',
    description: 'See current and personal-best streaks, and manage the date that anchors your 77-day challenge.',
    presentation: 'responsive', content,
    onOpen: () => { dialog.elements.body.scrollTop = 0; onOpen(); }, onClose,
  });
  const renderTimeline = () => {
    const { currentStartDate, startDateLocked, currentActivation, previewActive } = getState();
    dateInput.value = currentStartDate; dateInput.disabled = startDateLocked; saveButton.disabled = true;
    dateDisplay.textContent = formatChallengeStartDate(currentStartDate);
    dateHelp.textContent = previewActive ? 'The preview simulator controls this challenge date.'
      : currentActivation?.readState === 'error' ? 'Challenge timeline controls stay locked until your activation status can be refreshed.'
        : currentActivation?.status === 'not_started' ? 'Start your challenge before setting its timeline.'
          : currentActivation?.mode === 'group' ? 'Your crew owns the Group challenge start date.'
            : startDateLocked ? 'The challenge start date is locked after the first check-in.'
              : 'Set this before your first check-in. After a check-in is posted, the date stays locked to protect challenge progress.';
  };
  form.addEventListener('submit', event => { event.preventDefault(); void onSubmit(dateInput.value); });
  dateInput.addEventListener('input', () => {
    const { currentStartDate, startDateLocked } = getState();
    const next = normalizeChallengeStartDate(dateInput.value);
    dateFeedback.textContent = '';
    saveButton.disabled = startDateLocked || !next || next === currentStartDate;
  });
  return {
    get isOpen() { return dialog.isOpen; }, get isBusy() { return dialog.isBusy; },
    open: trigger => dialog.open(trigger), close: reason => dialog.close(reason),
    destroy: () => dialog.destroy(), clearError: () => dialog.clearError(),
    setError: message => dialog.setError(message),
    setBusy: (busy, message) => dialog.setBusy(busy, message),
    disableSave: () => { saveButton.disabled = true; },
    setDateFeedback: message => { dateFeedback.textContent = message; },
    focusDate: () => dateInput.focus(), renderTimeline,
    loading(message = '') { loadStatus.hidden = !message; loadStatus.textContent = message; },
    render(summary) {
      streakMetrics(summary).forEach(({ key, value, unit }) => {
        content.querySelector(`[data-global-streak-value="${key}"]`).textContent = String(value);
        content.querySelector(`[data-global-streak-unit="${key}"]`).textContent = unit;
      });
      zeroState.hidden = summary.hasHistory;
      renderTimeline();
    },
  };
}
