import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  JOURNAL_FUTURE_DATE_CODE,
  JOURNAL_FUTURE_DATE_MESSAGE,
  addJournalCalendarDays,
  addJournalCalendarMonths,
  assertJournalDateAllowed,
  buildJournalCalendarMonth,
  formatJournalDateChoice,
  isJournalDateKey,
  isJournalFutureDateError,
  journalMonthKey,
} from './journal-date-picker.mjs';
import {
  JOURNAL_CARD_FIELD_DEFINITIONS,
  JOURNAL_CARD_TITLE,
  JOURNAL_FIELD_DEFINITIONS,
} from './journal-fields.mjs';

describe('journal date contract', () => {
  test('validates real calendar dates without silently changing them', () => {
    assert.equal(isJournalDateKey('2028-02-29'), true);
    assert.equal(isJournalDateKey('2027-02-29'), false);
    assert.equal(isJournalDateKey('2026-13-01'), false);
    assert.equal(assertJournalDateAllowed('2026-08-24', '2026-08-24'), '2026-08-24');
    assert.equal(assertJournalDateAllowed('2026-08-23', '2026-08-24'), '2026-08-23');

    assert.throws(
      () => assertJournalDateAllowed('2026-08-25', '2026-08-24'),
      (error) => error.code === JOURNAL_FUTURE_DATE_CODE
        && error.message === JOURNAL_FUTURE_DATE_MESSAGE,
    );
  });

  test('recognizes both local and Postgres future-date errors', () => {
    assert.equal(isJournalFutureDateError({ code: JOURNAL_FUTURE_DATE_CODE }), true);
    assert.equal(isJournalFutureDateError({
      code: '22023',
      message: 'Journal entries cannot be dated in the future.',
      details: 'journal_entry_date_in_future',
    }), true);
    assert.equal(isJournalFutureDateError({ code: '42501', message: 'Permission denied' }), false);
  });

  test('builds a six-week calendar with distinct selected, today, and disabled states', () => {
    const days = buildJournalCalendarMonth('2026-08-01', {
      maximumDate: '2026-08-24',
      selectedDate: '2026-08-20',
    });

    assert.equal(days.length, 42);
    assert.equal(days.find((day) => day.value === '2026-08-20')?.selected, true);
    assert.equal(days.find((day) => day.value === '2026-08-20')?.today, false);
    assert.equal(days.find((day) => day.value === '2026-08-24')?.today, true);
    assert.equal(days.find((day) => day.value === '2026-08-24')?.selected, false);
    assert.equal(days.find((day) => day.value === '2026-08-25')?.disabled, true);
    assert.equal(days.find((day) => day.value === '2026-08-23')?.disabled, false);
  });

  test('moves by calendar boundaries instead of elapsed milliseconds', () => {
    assert.equal(addJournalCalendarDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addJournalCalendarDays('2028-02-29', 1), '2028-03-01');
    assert.equal(addJournalCalendarMonths('2026-12-15', 1), '2027-01-01');
    assert.equal(journalMonthKey('2026-08-24'), '2026-08-01');
    assert.match(formatJournalDateChoice('2026-08-24', 'en-US'), /Mon, Aug 24, 2026/);
  });
});

describe('shared journal field source', () => {
  test('keeps form and card labels in one intentional order', () => {
    assert.deepEqual(JOURNAL_FIELD_DEFINITIONS.map((field) => field.name), [
      'date', 'mood', 'energy', 'note', 'win', 'prayer',
    ]);
    assert.deepEqual(JOURNAL_CARD_FIELD_DEFINITIONS.map((field) => field.label), [
      'Mood',
      'Energy',
      'What did today reveal?',
      'Win',
      'Prayer or reflection',
    ]);
    assert.equal(JOURNAL_CARD_TITLE, 'Journal Entry');
  });
});
