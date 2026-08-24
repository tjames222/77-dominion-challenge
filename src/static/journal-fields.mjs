export const JOURNAL_FIELD_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'date', label: 'Date', suffix: 'Date', cardSection: false }),
  Object.freeze({ name: 'mood', label: 'Mood', suffix: 'Mood', cardSection: true }),
  Object.freeze({ name: 'energy', label: 'Energy', suffix: 'Energy', cardSection: true }),
  Object.freeze({
    name: 'note',
    label: 'What did today reveal?',
    suffix: 'Note',
    cardSection: true,
  }),
  Object.freeze({ name: 'win', label: 'Win', suffix: 'Win', cardSection: true }),
  Object.freeze({
    name: 'prayer',
    label: 'Prayer or reflection',
    suffix: 'Prayer',
    cardSection: true,
  }),
]);

export const JOURNAL_CARD_TITLE = 'Journal Entry';

export const JOURNAL_CARD_FIELD_DEFINITIONS = Object.freeze(
  JOURNAL_FIELD_DEFINITIONS.filter((field) => field.cardSection),
);

export function journalFieldDefinition(name) {
  return JOURNAL_FIELD_DEFINITIONS.find((field) => field.name === name) || null;
}

export function journalFieldLabel(name) {
  return journalFieldDefinition(name)?.label || '';
}
