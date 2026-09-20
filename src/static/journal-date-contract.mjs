export const JOURNAL_FUTURE_DATE_CODE = 'JOURNAL_FUTURE_DATE';
export const JOURNAL_FUTURE_DATE_MESSAGE = 'Choose today or an earlier date. Journal entries can’t be dated in the future.';

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

export function assertJournalDateAllowed(value, maximumDate) {
  if (!isJournalDateKey(value)) throw new TypeError('Choose a valid journal date.');
  if (!isJournalDateKey(maximumDate)) throw new TypeError('A valid journal date limit is required.');
  if (value <= maximumDate) return value;
  const error = new RangeError(JOURNAL_FUTURE_DATE_MESSAGE);
  error.code = JOURNAL_FUTURE_DATE_CODE;
  throw error;
}
