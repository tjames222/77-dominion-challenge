export function normalizeJournalEntry(entry = {}) {
  return {
    id: entry.id,
    date: entry.entry_date ?? entry.date,
    day: entry.challenge_day ?? entry.day ?? null,
    note: entry.note || '',
    win: entry.win || '',
    prayer: entry.prayer || '',
    mood: entry.mood || '',
    energy: entry.energy || '',
    createdAt: entry.created_at ?? entry.createdAt ?? null,
    updatedAt: entry.updated_at ?? entry.updatedAt ?? null,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareJournalEntries(left, right) {
  const dateOrder = String(right?.date || '').localeCompare(String(left?.date || ''));
  if (dateOrder) return dateOrder;

  const createdOrder = timestamp(right?.createdAt) - timestamp(left?.createdAt);
  if (createdOrder) return createdOrder;

  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

export function sortJournalEntries(entries) {
  return [...entries].sort(compareJournalEntries);
}

export function groupJournalEntriesByDate(entries) {
  const groups = [];
  for (const entry of sortJournalEntries(entries)) {
    const lastGroup = groups.at(-1);
    if (lastGroup?.date === entry.date) {
      lastGroup.entries.push(entry);
    } else {
      groups.push({ date: entry.date, entries: [entry] });
    }
  }
  return groups;
}
