import { createDialog } from './dialog.mjs';

export const JOURNAL_FUTURE_DATE_CODE = 'JOURNAL_FUTURE_DATE';
export const JOURNAL_FUTURE_DATE_MESSAGE = 'Choose today or an earlier date. Journal entries can’t be dated in the future.';

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

export function isJournalDateKey(value) {
  const match = DATE_KEY_PATTERN.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateFromKey(value) {
  if (!isJournalDateKey(value)) throw new TypeError('A valid YYYY-MM-DD date is required.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function dateKey(date) {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateKey(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addJournalCalendarDays(value, amount) {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + Number(amount || 0));
  return dateKey(date);
}

export function journalMonthKey(value) {
  const date = dateFromKey(value);
  date.setUTCDate(1);
  return dateKey(date);
}

export function addJournalCalendarMonths(value, amount) {
  const date = dateFromKey(journalMonthKey(value));
  date.setUTCMonth(date.getUTCMonth() + Number(amount || 0));
  return dateKey(date);
}

export function buildJournalCalendarMonth(monthValue, {
  maximumDate,
  selectedDate = '',
} = {}) {
  const monthStart = dateFromKey(journalMonthKey(monthValue));
  const firstVisible = new Date(monthStart);
  firstVisible.setUTCDate(1 - monthStart.getUTCDay());
  const visibleMonth = monthStart.getUTCMonth();

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstVisible);
    date.setUTCDate(firstVisible.getUTCDate() + index);
    const value = dateKey(date);
    return Object.freeze({
      value,
      day: date.getUTCDate(),
      currentMonth: date.getUTCMonth() === visibleMonth,
      disabled: isJournalDateKey(maximumDate) && value > maximumDate,
      selected: value === selectedDate,
      today: value === maximumDate,
    });
  });
}

export function formatJournalDateChoice(value, locale = undefined) {
  if (!isJournalDateKey(value)) return 'Choose a date';
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(value));
}

export function assertJournalDateAllowed(value, maximumDate) {
  if (!isJournalDateKey(value)) throw new TypeError('Choose a valid journal date.');
  if (!isJournalDateKey(maximumDate)) throw new TypeError('A valid journal date limit is required.');
  if (value <= maximumDate) return value;
  const error = new RangeError(JOURNAL_FUTURE_DATE_MESSAGE);
  error.code = JOURNAL_FUTURE_DATE_CODE;
  throw error;
}

export function isJournalFutureDateError(error) {
  const details = [error?.code, error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ');
  return error?.code === JOURNAL_FUTURE_DATE_CODE
    || /journal_entry_date_in_future|journal entries cannot be dated in the future|can’t be dated in the future/i.test(details);
}

function monthHeading(value, locale) {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(value));
}

function calendarDayLabel(value, locale) {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(value));
}

function currentMaximum(options, fallback) {
  const candidate = typeof options.maximumDate === 'function'
    ? options.maximumDate()
    : options.maximumDate;
  return isJournalDateKey(candidate) ? candidate : fallback;
}

export function createJournalDatePicker(form, options = {}) {
  const input = form?.querySelector?.('input[name="date"]');
  if (!input) throw new TypeError('A journal date input is required.');
  if (input.__journalDatePicker) return input.__journalDatePicker;

  // Inputs cloned from a <template> can temporarily belong to an inert
  // document without a body. Build overlays in the active browser document so
  // the picker also works before a shared form is mounted in its parent dialog.
  const ownerDocument = input.ownerDocument?.body
    ? input.ownerDocument
    : (globalThis.document || input.ownerDocument);
  const idPrefix = String(options.idPrefix || input.id || 'journalDate');
  const fallbackMaximum = isJournalDateKey(input.max)
    ? input.max
    : localDateKey();
  let maximumDate = currentMaximum(options, fallbackMaximum);
  let displayMonth = journalMonthKey(maximumDate);
  let focusDate = maximumDate;

  const control = ownerDocument.createElement('div');
  control.className = 'journal-date-control';
  input.parentNode.insertBefore(control, input);
  control.append(input);

  const trigger = ownerDocument.createElement('button');
  trigger.type = 'button';
  trigger.className = 'journal-date-picker-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', 'Open calendar');
  trigger.innerHTML = [
    '<span class="app-icon icon-calendar" aria-hidden="true"></span>',
    '<span class="sr-only">Open calendar</span>',
  ].join('');
  control.append(trigger);

  const feedback = ownerDocument.createElement('span');
  feedback.id = `${idPrefix}DateError`;
  feedback.className = 'journal-date-error';
  feedback.setAttribute('role', 'alert');
  feedback.setAttribute('aria-live', 'polite');
  control.after(feedback);
  input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), feedback.id]
    .filter(Boolean).join(' '));

  const calendar = ownerDocument.createElement('div');
  calendar.className = 'journal-calendar';

  const navigation = ownerDocument.createElement('div');
  navigation.className = 'journal-calendar-navigation';
  const previous = ownerDocument.createElement('button');
  previous.type = 'button';
  previous.className = 'journal-calendar-month-button';
  previous.setAttribute('aria-label', 'Previous month');
  previous.innerHTML = '<span aria-hidden="true">‹</span>';
  const monthLabel = ownerDocument.createElement('p');
  monthLabel.id = `${idPrefix}CalendarMonth`;
  monthLabel.className = 'journal-calendar-month';
  monthLabel.setAttribute('aria-live', 'polite');
  const next = ownerDocument.createElement('button');
  next.type = 'button';
  next.className = 'journal-calendar-month-button';
  next.setAttribute('aria-label', 'Next month');
  next.innerHTML = '<span aria-hidden="true">›</span>';
  navigation.append(previous, monthLabel, next);

  const weekdays = ownerDocument.createElement('div');
  weekdays.className = 'journal-calendar-weekdays';
  weekdays.setAttribute('aria-hidden', 'true');
  WEEKDAY_LABELS.forEach((label) => {
    const weekday = ownerDocument.createElement('span');
    weekday.textContent = label;
    weekdays.append(weekday);
  });

  const grid = ownerDocument.createElement('div');
  grid.className = 'journal-calendar-grid';
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-labelledby', monthLabel.id);

  const todayButton = ownerDocument.createElement('button');
  todayButton.type = 'button';
  todayButton.className = 'journal-calendar-today';
  todayButton.textContent = 'Choose today';
  calendar.append(navigation, weekdays, grid, todayButton);

  function invalidMessage() {
    return isJournalDateKey(input.value) && input.value > maximumDate
      ? JOURNAL_FUTURE_DATE_MESSAGE
      : '';
  }

  function syncValidation({ announce = false } = {}) {
    const message = invalidMessage();
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    trigger.setAttribute('aria-invalid', String(Boolean(message)));
    if (announce || !message) feedback.textContent = message;
    return !message;
  }

  function syncControl(options = {}) {
    input.max = maximumDate;
    syncValidation(options);
  }

  function dayButtonFor(value) {
    return [...grid.querySelectorAll('[data-journal-calendar-date]')]
      .find((button) => button.dataset.journalCalendarDate === value) || null;
  }

  function renderCalendar({ restoreFocus = false } = {}) {
    if (journalMonthKey(displayMonth) > journalMonthKey(maximumDate)) {
      displayMonth = journalMonthKey(maximumDate);
    }
    monthLabel.textContent = monthHeading(displayMonth, ownerDocument.documentElement?.lang || undefined);
    next.disabled = addJournalCalendarMonths(displayMonth, 1) > journalMonthKey(maximumDate);
    grid.replaceChildren();

    const days = buildJournalCalendarMonth(displayMonth, {
      maximumDate,
      selectedDate: input.value,
    });
    for (let week = 0; week < 6; week += 1) {
      const row = ownerDocument.createElement('div');
      row.className = 'journal-calendar-week';
      row.setAttribute('role', 'row');
      for (const day of days.slice(week * 7, week * 7 + 7)) {
        const button = ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'journal-calendar-day';
        button.dataset.journalCalendarDate = day.value;
        button.dataset.outsideMonth = String(!day.currentMonth);
        button.setAttribute('role', 'gridcell');
        button.setAttribute('aria-label', calendarDayLabel(day.value, ownerDocument.documentElement?.lang || undefined));
        button.setAttribute('aria-selected', String(day.selected));
        if (day.today) button.setAttribute('aria-current', 'date');
        button.disabled = day.disabled;
        button.tabIndex = !day.disabled && day.value === focusDate ? 0 : -1;
        button.textContent = String(day.day);
        button.addEventListener('click', () => selectDate(day.value));
        row.append(button);
      }
      grid.append(row);
    }

    if (!dayButtonFor(focusDate) || dayButtonFor(focusDate)?.disabled) {
      focusDate = input.value <= maximumDate && isJournalDateKey(input.value)
        ? input.value
        : maximumDate;
      const fallback = dayButtonFor(focusDate)
        || [...grid.querySelectorAll('[data-journal-calendar-date]')].find((button) => !button.disabled);
      if (fallback) fallback.tabIndex = 0;
    }

    if (restoreFocus) {
      ownerDocument.defaultView?.requestAnimationFrame?.(() => dayButtonFor(focusDate)?.focus());
    }
  }

  function selectDate(value) {
    assertJournalDateAllowed(value, maximumDate);
    input.value = value;
    focusDate = value;
    displayMonth = journalMonthKey(value);
    const EventConstructor = ownerDocument.defaultView?.Event || globalThis.Event;
    input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    input.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    dialog.close('date-selected');
  }

  function moveFocus(value) {
    if (!isJournalDateKey(value) || value > maximumDate) return;
    focusDate = value;
    displayMonth = journalMonthKey(value);
    renderCalendar({ restoreFocus: true });
  }

  const dialog = createDialog({
    document: ownerDocument,
    id: `${idPrefix}CalendarDialog`,
    eyebrow: 'Private Journal',
    title: 'Choose a journal date',
    description: 'Future dates are unavailable. Choose today or an earlier day.',
    closeLabel: 'Close journal date calendar',
    presentation: 'responsive',
    pattern: 'journal-calendar',
    content: calendar,
    initialFocus: () => dayButtonFor(focusDate) || grid,
    onOpen: () => {
      maximumDate = currentMaximum(options, maximumDate);
      input.max = maximumDate;
      const selected = isJournalDateKey(input.value) && input.value <= maximumDate
        ? input.value
        : maximumDate;
      focusDate = selected;
      displayMonth = journalMonthKey(selected);
      trigger.setAttribute('aria-expanded', 'true');
      renderCalendar({ restoreFocus: true });
    },
    onClose: () => trigger.setAttribute('aria-expanded', 'false'),
  });

  previous.addEventListener('click', () => {
    displayMonth = addJournalCalendarMonths(displayMonth, -1);
    focusDate = displayMonth;
    renderCalendar({ restoreFocus: true });
  });
  next.addEventListener('click', () => {
    const candidate = addJournalCalendarMonths(displayMonth, 1);
    if (candidate > journalMonthKey(maximumDate)) return;
    displayMonth = candidate;
    focusDate = candidate;
    renderCalendar({ restoreFocus: true });
  });
  todayButton.addEventListener('click', () => selectDate(maximumDate));
  grid.addEventListener('keydown', (event) => {
    const value = event.target?.dataset?.journalCalendarDate;
    if (!isJournalDateKey(value)) return;
    const dayOfWeek = dateFromKey(value).getUTCDay();
    const targets = {
      ArrowLeft: addJournalCalendarDays(value, -1),
      ArrowRight: addJournalCalendarDays(value, 1),
      ArrowUp: addJournalCalendarDays(value, -7),
      ArrowDown: addJournalCalendarDays(value, 7),
      Home: addJournalCalendarDays(value, -dayOfWeek),
      End: addJournalCalendarDays(value, 6 - dayOfWeek),
      PageUp: addJournalCalendarMonths(value, -1),
      PageDown: addJournalCalendarMonths(value, 1),
    };
    const target = targets[event.key];
    if (!target) return;
    event.preventDefault();
    moveFocus(target);
  });

  trigger.addEventListener('click', () => dialog.open(trigger));
  input.addEventListener('input', () => syncControl({ announce: true }));
  input.addEventListener('change', () => syncControl({ announce: true }));
  input.addEventListener('journal:date-sync', () => syncControl());

  const controller = {
    input,
    trigger,
    dialog,
    get maximumDate() { return maximumDate; },
    setMaximumDate(value) {
      if (!isJournalDateKey(value)) throw new TypeError('A valid journal date limit is required.');
      maximumDate = value;
      syncControl();
      if (dialog.isOpen) renderCalendar();
      return maximumDate;
    },
    validate({ announce = true, focus = false } = {}) {
      const valid = syncValidation({ announce });
      if (!valid && focus) input.focus();
      return valid;
    },
    showFutureDateError() {
      input.setCustomValidity(JOURNAL_FUTURE_DATE_MESSAGE);
      input.setAttribute('aria-invalid', 'true');
      trigger.setAttribute('aria-invalid', 'true');
      feedback.textContent = JOURNAL_FUTURE_DATE_MESSAGE;
      input.focus();
    },
    sync: syncControl,
  };
  input.__journalDatePicker = controller;
  syncControl();
  renderCalendar();
  return controller;
}
