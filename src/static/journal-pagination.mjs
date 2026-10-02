export const JOURNAL_PAGE_SIZE = 25;
export const JOURNAL_PAGE_FETCH_LIMIT = JOURNAL_PAGE_SIZE + 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const ORDERING_FIELDS = Object.freeze(['entryDate', 'createdAt', 'id']);

const plain = (value) => Boolean(value && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const fail = (code = 'JOURNAL_INVALID_DATA') => Object.assign(
  new Error(code === 'JOURNAL_INVALID_CURSOR'
    ? 'This journal page is no longer valid. Return to the newest entries.'
    : 'Some saved journal history could not be read safely.'),
  { code },
);

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;
}

function parseDateParts(value, code) {
  const match = DATE.exec(value);
  if (!match) throw fail(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw fail(code);
  return { year, month, day };
}

function daysBeforeYear(year) {
  const prior = BigInt(year - 1);
  return 365n * prior + prior / 4n - prior / 100n + prior / 400n;
}

function daysBeforeMonth(year, month) {
  const totals = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return BigInt(totals[month] + (month > 2 && leapYear(year) ? 1 : 0));
}

// Parse without Date so six-digit PostgreSQL precision and explicit offsets
// remain ordering evidence. Unsupported infinity/BC/out-of-domain values fail
// the whole page instead of disappearing from a member's private history.
export function journalTimestampMicros(value, code = 'JOURNAL_INVALID_DATA') {
  if (typeof value !== 'string') throw fail(code);
  const match = TIMESTAMP.exec(value);
  if (!match) throw fail(code);
  const { year, month, day } = parseDateParts(`${match[1]}-${match[2]}-${match[3]}`, code);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) throw fail(code);
  let offsetMinutes = 0;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 15 || offsetMinute > 59) throw fail(code);
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[8][0] === '-' ? -1 : 1);
  }
  const dayIndex = daysBeforeYear(year) + daysBeforeMonth(year, month) + BigInt(day - 1);
  const seconds = dayIndex * 86400n
    + BigInt(hour * 3600 + minute * 60 + second - offsetMinutes * 60);
  return seconds * 1000000n + BigInt((match[7] || '').padEnd(6, '0'));
}

function journalId(value, preview, code) {
  if (typeof value !== 'string' || !(preview ? PREVIEW_ID : UUID).test(value)) throw fail(code);
  return value;
}

export function normalizeJournalDate(value, code = 'JOURNAL_INVALID_DATA') {
  if (typeof value !== 'string') throw fail(code);
  parseDateParts(value, code);
  return value;
}

function exactCursor(value) {
  return plain(value) && Reflect.ownKeys(value).length === ORDERING_FIELDS.length
    && ORDERING_FIELDS.every((key) => Object.hasOwn(value, key));
}

export function normalizeJournalCursor(value, { preview = false } = {}) {
  if (value === null || value === undefined) return null;
  if (!exactCursor(value)) throw fail('JOURNAL_INVALID_CURSOR');
  const cursor = {
    entryDate: normalizeJournalDate(value.entryDate, 'JOURNAL_INVALID_CURSOR'),
    createdAt: String(value.createdAt || ''),
    id: journalId(value.id, preview, 'JOURNAL_INVALID_CURSOR'),
  };
  journalTimestampMicros(cursor.createdAt, 'JOURNAL_INVALID_CURSOR');
  return Object.freeze(cursor);
}

function orderingRecord(value, { actorId = '', preview = false, cursor = false } = {}) {
  const code = cursor ? 'JOURNAL_INVALID_CURSOR' : 'JOURNAL_INVALID_DATA';
  if (!plain(value)) throw fail(code);
  const rawActor = value.user_id ?? value.userId;
  if (!preview && actorId && (!UUID.test(String(rawActor || '')) || rawActor !== actorId)) throw fail(code);
  const record = {
    entryDate: normalizeJournalDate(value.entry_date ?? value.date ?? value.entryDate, code),
    createdAt: String(value.created_at ?? value.createdAt ?? ''),
    id: journalId(value.id, preview, code),
  };
  record.createdAtMicros = journalTimestampMicros(record.createdAt, code);
  return record;
}

function compareText(left, right) {
  return left === right ? 0 : left > right ? -1 : 1;
}

// Negative means left sorts before right in the canonical descending order.
export function compareJournalOrdering(left, right, options = {}) {
  const a = orderingRecord(left, options);
  const b = orderingRecord(right, options);
  const date = compareText(a.entryDate, b.entryDate);
  if (date) return date;
  if (a.createdAtMicros !== b.createdAtMicros) return a.createdAtMicros > b.createdAtMicros ? -1 : 1;
  return compareText(a.id.toLowerCase(), b.id.toLowerCase());
}

function text(value) {
  if (typeof value !== 'string') throw fail();
  return value;
}

export function normalizeJournalPageEntry(value, { actorId = '', preview = false } = {}) {
  const ordering = orderingRecord(value, { actorId, preview });
  const challengeDay = value.challenge_day ?? value.day ?? null;
  if (challengeDay !== null && !Number.isSafeInteger(challengeDay)) throw fail();
  const updatedAt = value.updated_at ?? value.updatedAt ?? null;
  if (updatedAt !== null && (typeof updatedAt !== 'string' || !updatedAt)) throw fail();
  return Object.freeze({
    id: ordering.id,
    date: ordering.entryDate,
    day: challengeDay,
    note: text(value.note ?? ''),
    win: text(value.win ?? ''),
    prayer: text(value.prayer ?? ''),
    mood: text(value.mood ?? ''),
    energy: text(value.energy ?? ''),
    createdAt: ordering.createdAt,
    updatedAt,
  });
}

function cursorFromEntry(entry, preview) {
  return normalizeJournalCursor({ entryDate: entry.date, createdAt: entry.createdAt, id: entry.id }, { preview });
}

export function projectJournalPage(values, { actorId = '', preview = false } = {}) {
  if (!Array.isArray(values) || values.length > JOURNAL_PAGE_FETCH_LIMIT) throw fail();
  const entries = values.map((value) => normalizeJournalPageEntry(value, { actorId, preview }));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareJournalOrdering(entries[index - 1], entries[index], { preview }) >= 0) throw fail();
  }
  const hasNext = entries.length === JOURNAL_PAGE_FETCH_LIMIT;
  const displayed = Object.freeze(entries.slice(0, JOURNAL_PAGE_SIZE));
  return Object.freeze({
    schemaVersion: 1,
    entries: displayed,
    hasNext,
    nextCursor: hasNext ? cursorFromEntry(displayed.at(-1), preview) : null,
  });
}

export function selectPreviewJournalPage(values, cursor = null) {
  if (!Array.isArray(values)) throw fail();
  const normalizedCursor = normalizeJournalCursor(cursor, { preview: true });
  const ordered = values.map((value) => normalizeJournalPageEntry(value, { preview: true }))
    .sort((left, right) => compareJournalOrdering(left, right, { preview: true }));
  for (let index = 1; index < ordered.length; index += 1) {
    if (compareJournalOrdering(ordered[index - 1], ordered[index], { preview: true }) === 0) throw fail();
  }
  const after = normalizedCursor
    ? ordered.filter((entry) => compareJournalOrdering(entry, normalizedCursor, { preview: true }) > 0)
    : ordered;
  return after.slice(0, JOURNAL_PAGE_FETCH_LIMIT);
}

function postgrestValue(value) {
  // Validators exclude PostgREST boolean grammar, grouping characters and
  // commas. URLSearchParams performs the remaining transport encoding.
  if (/[(),]/.test(value)) throw fail('JOURNAL_INVALID_CURSOR');
  return value;
}

export function journalPageFilter(cursor) {
  const value = normalizeJournalCursor(cursor);
  if (!value) return '';
  const date = postgrestValue(value.entryDate);
  const createdAt = postgrestValue(value.createdAt);
  const id = postgrestValue(value.id);
  return `entry_date.lt.${date},and(entry_date.eq.${date},created_at.lt.${createdAt}),and(entry_date.eq.${date},created_at.eq.${createdAt},id.lt.${id})`;
}
