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

export function sortJournalEntries(entries) {
  return [...entries].sort((left, right) => (
    new Date(right.date).getTime() - new Date(left.date).getTime()
  ));
}
