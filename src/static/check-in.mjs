export const CHECK_IN_ALREADY_COMPLETE_CODE = 'CHECK_IN_ALREADY_COMPLETE';
export const CHECK_IN_ALREADY_COMPLETE_MESSAGE = 'Today\u2019s check-in is already posted. Your original entry and points are unchanged.';
export const CHECK_IN_DATE_UNIQUE_INDEX = 'check_ins_user_entry_date_unique_idx';
export const CHECK_IN_DAY_UNIQUE_INDEX = 'check_ins_user_challenge_day_unique_idx';
export const CHECK_IN_SUBMISSION_COOLDOWN_MS = 750;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function dateKeyForTimeZone(value = new Date(), timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid date is required.');

  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (timeZone) options.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat('en', options).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarDayNumber(dateKey) {
  if (!DATE_KEY_PATTERN.test(String(dateKey || ''))) throw new TypeError('A valid YYYY-MM-DD date is required.');
  const [year, month, day] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function calendarDayDifference(currentDateKey, startDateKey) {
  return calendarDayNumber(currentDateKey) - calendarDayNumber(startDateKey);
}

export function normalizeCheckInDates(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => DATE_KEY_PATTERN.test(value)))]
    .sort((a, b) => b.localeCompare(a));
}

export function normalizeChallengeDays(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 77))]
    .sort((a, b) => b - a);
}

export function createCheckInCache(owner, dates = [], challengeDays = []) {
  return {
    owner: String(owner || ''),
    dates: normalizeCheckInDates(dates).slice(0, 100),
    challengeDays: normalizeChallengeDays(challengeDays),
  };
}

export function checkInCacheForOwner(cache, owner) {
  const normalizedOwner = String(owner || '');
  if (!normalizedOwner || cache?.owner !== normalizedOwner) return createCheckInCache(normalizedOwner);
  return createCheckInCache(normalizedOwner, cache.dates, cache.challengeDays);
}

export function addCheckInDate(values, dateKey) {
  const dates = normalizeCheckInDates(values);
  if (!DATE_KEY_PATTERN.test(String(dateKey || ''))) return { dates, added: false };
  if (dates.includes(dateKey)) return { dates, added: false };
  return { dates: normalizeCheckInDates([dateKey, ...dates]).slice(0, 100), added: true };
}

export function isDuplicateCheckInError(error) {
  if (error?.code !== '23505') return false;
  const detail = [error?.message, error?.details, error?.constraint].filter(Boolean).join(' ');
  return detail.includes(CHECK_IN_DATE_UNIQUE_INDEX)
    || detail.includes(CHECK_IN_DAY_UNIQUE_INDEX)
    || detail.includes('(user_id, entry_date)')
    || detail.includes('(user_id, challenge_day)');
}

export function createCheckInAlreadyCompleteError(cause) {
  const error = new Error(CHECK_IN_ALREADY_COMPLETE_MESSAGE);
  error.code = CHECK_IN_ALREADY_COMPLETE_CODE;
  if (cause) error.cause = cause;
  return error;
}

export function canStartCheckInSubmission(lastStartedAt, nextStartedAt, cooldownMs = CHECK_IN_SUBMISSION_COOLDOWN_MS) {
  const previous = Number(lastStartedAt) || 0;
  const next = Number(nextStartedAt) || 0;
  const cooldown = Math.max(0, Number(cooldownMs) || 0);
  return previous <= 0 || next - previous >= cooldown;
}
