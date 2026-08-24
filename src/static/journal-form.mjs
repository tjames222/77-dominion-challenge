import { JOURNAL_FIELD_DEFINITIONS } from './journal-fields.mjs';

function control(form, name) {
  return form?.querySelector?.(`[name="${name}"]`) || null;
}

export function createJournalForm(template, {
  formId,
  idPrefix,
  label,
  submitLabel,
  cancelLabel = '',
} = {}) {
  const form = template?.content?.firstElementChild?.cloneNode?.(true);
  if (!form) throw new TypeError('A journal form template is required.');

  form.id = formId || '';
  if (label) form.setAttribute('aria-label', label);

  for (const { name, label: fieldLabel, suffix } of JOURNAL_FIELD_DEFINITIONS) {
    const field = control(form, name);
    if (!field) throw new TypeError(`Journal form field is missing: ${name}`);
    field.id = `${idPrefix || 'journal'}${suffix}`;
    const fieldLabelElement = field.closest('label')
      || field.closest('[data-journal-field]')?.querySelector?.('label');
    fieldLabelElement?.setAttribute('for', field.id);
    const labelText = fieldLabelElement?.querySelector?.('[data-journal-field-label]');
    if (labelText) labelText.textContent = fieldLabel;
  }

  const submit = form.querySelector('[data-journal-submit]');
  if (submitLabel) submit.textContent = submitLabel;

  const cancel = form.querySelector('[data-journal-cancel]');
  if (cancelLabel) {
    cancel.textContent = cancelLabel;
    cancel.hidden = false;
  } else {
    cancel.remove();
  }

  return form;
}

export function readJournalForm(form) {
  return {
    date: control(form, 'date')?.value || '',
    note: control(form, 'note')?.value.trim() || '',
    win: control(form, 'win')?.value.trim() || '',
    prayer: control(form, 'prayer')?.value.trim() || '',
    mood: control(form, 'mood')?.value || '',
    energy: control(form, 'energy')?.value || '',
  };
}

export function writeJournalForm(form, entry = {}) {
  control(form, 'date').value = entry.date || '';
  control(form, 'note').value = entry.note || '';
  control(form, 'win').value = entry.win || '';
  control(form, 'prayer').value = entry.prayer || '';
  control(form, 'mood').value = entry.mood || '';
  control(form, 'energy').value = entry.energy || '';
  control(form, 'date')?.dispatchEvent?.(new Event('journal:date-sync'));
  return form;
}

export function resetJournalForm(form, date = '') {
  form?.reset?.();
  return writeJournalForm(form, { date });
}

export function setJournalFormBusy(form, busy, pendingLabel = 'Saving…') {
  if (!form) return;
  const submit = form.querySelector('[data-journal-submit]');
  if (submit && !submit.dataset.readyLabel) submit.dataset.readyLabel = submit.textContent;

  form.setAttribute('aria-busy', String(Boolean(busy)));
  form.querySelectorAll('input, select, textarea, button').forEach((field) => {
    field.disabled = Boolean(busy);
  });
  if (submit) submit.textContent = busy ? pendingLabel : submit.dataset.readyLabel;
}
