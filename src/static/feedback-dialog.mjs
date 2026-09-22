import { createDialog } from './dialog.mjs';
import { FEEDBACK_TYPES, FEEDBACK_IMPACTS, FEEDBACK_LIMITS, normalizeFeedbackContext,
  normalizeFeedbackOwner, createFeedbackIntent, normalizeFeedbackReceipt } from './feedback-contract.mjs';

// The caller must load feedback-dialog.css with the lazy UI,
// verify the canonical EA owner and provide an owner-bound submit adapter.
// This controller never inspects Auth, page content, browser storage or network.
export function createFeedbackDialog({ owner: suppliedOwner, context: suppliedContext,
  isCurrent, submit, onSaved, requestTimeoutMs = 20000, document: ownerDocument = globalThis.document } = {}) {
  const owner = normalizeFeedbackOwner(suppliedOwner);
  const context = normalizeFeedbackContext(suppliedContext);
  if (typeof isCurrent !== 'function' || typeof submit !== 'function') throw new TypeError('Feedback requires owner and submission adapters.');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) throw new TypeError('Feedback requires a bounded request deadline.');
  let destroyed = false; let generation = 0; let state = 'editing'; let intent = null; let request = null;
  let restoreScrollBehavior = () => {};
  const fields = {};
  const make = (tag, text = '') => { const node = ownerDocument.createElement(tag); node.textContent = text; return node; };
  const form = make('form'); form.className = 'feedback-form'; form.noValidate = true; form.autocomplete = 'off';
  const dialog = createDialog({ document: ownerDocument, title: 'Send Feedback', eyebrow: 'Early Access',
    description: 'Tell us what happened or what could be better. We save your feedback before delivery to our team.',
    pattern: 'feedback', content: form,
    onClose({ reason }) {
      restoreScrollBehavior();
      if (['destroy', 'replaced'].includes(reason)) {
        destroyed = true; generation += 1; request?.abort(); request = null;
        scrub();
        // Shared-dialog replacement closes, but does not remove, the old layer.
        dialog.elements.layer.remove();
        return;
      }
      if (state !== 'uncertain') scrub();
    },
  });
  const status = make('p'); status.className = 'feedback-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const addField = (name, label, tag = 'select', choices = null) => {
    const wrapper = make('label'); wrapper.className = 'feedback-field';
    const labelText = make('span', label); const control = make(tag); control.name = name;
    if (choices) {
      const empty = make('option', 'Choose an option'); empty.value = ''; control.append(empty);
      for (const [value, text] of Object.entries(choices)) { const option = make('option', text); option.value = value; control.append(option); }
    }
    fields[name] = control; wrapper.append(labelText, control); form.append(wrapper); return control;
  };
  const type = addField('type', 'Feedback type', 'select', FEEDBACK_TYPES); type.required = true; type.dataset.dialogInitialFocus = '';
  const description = addField('description', 'What happened or what would you like to change? (10,000 characters maximum)', 'textarea');
  description.required = true; description.maxLength = FEEDBACK_LIMITS.description; description.rows = 5;
  const expected = addField('expectedBehavior', 'Expected or desired behavior (optional, 5,000 characters maximum)', 'textarea');
  expected.maxLength = FEEDBACK_LIMITS.expectedBehavior; expected.rows = 3;
  const impact = addField('impact', 'Impact', 'select', FEEDBACK_IMPACTS); impact.required = true;
  const contactLabel = make('label'); contactLabel.className = 'feedback-contact';
  const contact = make('input'); contact.type = 'checkbox'; contact.name = 'contactAllowed'; fields.contactAllowed = contact;
  contactLabel.append(contact, make('span', 'You may contact me about this feedback.')); form.append(contactLabel);
  const privacy = make('p', 'Includes this page name, theme, screen size, app version and coarse browser/device type. Your account and Early Access status are verified by the server. No journal, prayer, form or other page content is collected automatically. Images are not supported in this form.');
  privacy.className = 'feedback-privacy'; form.append(privacy);
  const summary = make('p', `Page: ${context.route} · Theme: ${context.theme} · Screen: ${context.viewport.width} × ${context.viewport.height}`);
  summary.className = 'feedback-context'; form.append(summary, status);
  const actions = make('div'); actions.className = 'feedback-actions';
  const cancel = make('button', 'Cancel'); cancel.type = 'button';
  const send = make('button', 'Send feedback'); send.type = 'submit';
  actions.append(cancel, send); form.append(actions);
  const current = () => {
    try { return !destroyed && isCurrent(owner) === true; } catch { return false; }
  };
  function scrub() {
    for (const field of Object.values(fields)) { field.value = ''; field.checked = false; field.disabled = false; field.removeAttribute('aria-invalid'); }
    intent = null; state = 'editing'; status.textContent = ''; send.textContent = 'Send feedback'; send.disabled = false; cancel.disabled = false;
  }
  function destroy() {
    if (destroyed) { restoreScrollBehavior(); scrub(); dialog.elements.layer.remove(); return; }
    destroyed = true; generation += 1; request?.abort(); request = null;
    // Never return focus to a now-ineligible feature trigger on owner teardown.
    dialog.__closeForReplacement(); dialog.destroy(); restoreScrollBehavior(); scrub();
  }
  cancel.addEventListener('click', () => {
    if (!current()) { destroy(); return; }
    if (state !== 'submitting') dialog.close('cancel');
  });
  function showUncertain() {
    state = 'uncertain'; request = null; dialog.setBusy(false);
    dialog.setError('We could not confirm whether this feedback was saved. Retry the same submission to avoid a duplicate. Closing for now keeps this draft on this page; leaving the page or signing out clears it.');
    cancel.disabled = false; cancel.textContent = 'Close for now';
    send.textContent = 'Retry same submission'; send.disabled = false;
  }
  function submitWithDeadline(original, controller) {
    let timer; let abort;
    const pending = new Promise((resolve, reject) => {
      abort = () => reject(new Error('Feedback request ended without confirmation.'));
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        if (!current() || controller.signal.aborted) throw new Error('Feedback owner changed.');
        Promise.resolve(submit(original, { signal: controller.signal })).then(resolve, reject);
      } catch (error) { reject(error); }
    });
    return pending.finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current()) { destroy(); return; }
    if (state === 'submitting' || state === 'saved') return;
    dialog.clearError();
    for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
    if (!intent) {
      try {
        intent = createFeedbackIntent({ type: type.value, description: description.value,
          expectedBehavior: expected.value, impact: impact.value, contactAllowed: contact.checked }, context);
      } catch (error) {
        const field = fields[error?.field];
        if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
        dialog.setError('Choose a type and impact, and describe your feedback within the shown field limits.');
        return;
      }
    }
    const captured = generation; const original = intent;
    state = 'submitting'; request = new AbortController(); const controller = request;
    for (const field of Object.values(fields)) field.disabled = true;
    cancel.disabled = true; send.disabled = true; send.textContent = 'Saving…';
    status.textContent = ''; dialog.setBusy(true, 'Saving feedback…');
    try {
      const value = await submitWithDeadline(original, controller);
      if (captured !== generation || controller.signal.aborted || !current()) { destroy(); return; }
      const receipt = normalizeFeedbackReceipt(value, original, owner);
      state = 'saved'; request = null; dialog.setBusy(false); dialog.clearError();
      // Only an exact persisted receipt permits erasing the private draft.
      for (const field of Object.values(fields)) { field.value = ''; field.checked = false; }
      intent = null; send.textContent = 'Saved'; send.disabled = true; cancel.disabled = false; cancel.textContent = 'Close';
      status.textContent = 'Your feedback is saved. Delivery to our team may still be pending.';
      cancel.focus();
      try { onSaved?.(receipt); } catch { /* A presentation callback cannot undo a durable receipt. */ }
    } catch {
      if (captured !== generation || !current()) { destroy(); return; }
      // Deadline abort is uncertainty, not owner teardown or proof of rollback.
      showUncertain(); send.focus();
    }
  });
  return Object.freeze({
    hasPendingIntent: () => !destroyed && Boolean(intent),
    isAvailable: () => current(),
    open(trigger) {
      if (!current()) { destroy(); return false; }
      if (!dialog.isOpen) {
        const retrying = state === 'uncertain';
        if (!retrying) { scrub(); cancel.textContent = 'Cancel'; }
        // The shared modal restores document scroll before returning focus.
        // Smooth scrolling would pass other controls under the fixed launcher
        // after focus returns, making safe-overlap hiding discard that focus.
        const rootStyle = ownerDocument.documentElement?.style;
        if (rootStyle) {
          const previous = rootStyle.scrollBehavior; rootStyle.scrollBehavior = 'auto';
          restoreScrollBehavior = () => { rootStyle.scrollBehavior = previous; restoreScrollBehavior = () => {}; };
        }
        try { dialog.open(trigger); } catch (error) { restoreScrollBehavior(); throw error; }
        if (retrying) { showUncertain(); send.focus(); }
      }
      return true;
    },
    destroy,
  });
}
