import { createFeedbackDialog } from './feedback-dialog.mjs';
import { createFeedbackContext } from './feedback-context.mjs';
import './feedback-dialog.css';
import './feedback-widget.css';

// Mounted only after a fresh server context permits EA feedback. Ambient data
// is limited to the explicitly documented context allowlist, captured on open.
export function mountFeedbackWidget({ client, owner, beforeOpen = () => {}, buildSha,
  document: ownerDocument = globalThis.document, window: ownerWindow = globalThis.window } = {}) {
  const binding = client.bindOwner(owner);
  let destroyed = false; let eligible = true; let dialog = null;
  const header = ownerDocument.querySelector('.topbar');
  const phone = ownerWindow.matchMedia('(max-width: 600px)');
  const headerSlot = ownerDocument.createElement('div'); headerSlot.className = 'feedback-header-slot';
  const button = ownerDocument.createElement('button');
  button.type = 'button'; button.className = 'feedback-widget'; button.dataset.feedbackWidget = '';
  const icon = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  const path = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h7');
  icon.append(path); const label = ownerDocument.createElement('span'); label.textContent = 'Feedback';
  button.append(icon, label); button.setAttribute('aria-label', 'Send Feedback');
  function update() {
    if (destroyed) return;
    const retry = Boolean(dialog?.hasPendingIntent());
    button.hidden = !eligible && !retry;
    button.setAttribute('aria-label', retry ? 'Retry feedback submission' : 'Send Feedback');
    label.textContent = retry ? 'Retry' : 'Feedback';
    // A reserved header slot on phones preserves their full content width;
    // wider screens use a stable outside edge. No page-content scans on scroll.
    ownerDocument.body.toggleAttribute('data-feedback-mounted', !button.hidden);
    headerSlot.hidden = button.hidden;
  }
  function place() {
    if (destroyed) return;
    if (phone.matches && header) {
      header.append(headerSlot); headerSlot.append(button);
    } else {
      ownerDocument.body.append(button); headerSlot.remove();
    }
  }
  function destroy() {
    if (destroyed) return; destroyed = true;
    dialog?.destroy(); dialog = null; button.remove(); headerSlot.remove();
    phone.removeEventListener('change', place);
    ownerDocument.body.removeAttribute('data-feedback-mounted'); unsubscribe();
  }
  const unsubscribe = client.subscribe(destroy);
  button.addEventListener('click', () => {
    if (!binding.isCurrent(owner)) { destroy(); return; }
    if (!eligible && !dialog?.hasPendingIntent()) { update(); return; }
    try {
      beforeOpen();
      if (!dialog?.isAvailable() || !dialog.hasPendingIntent()) {
        dialog?.destroy();
        const context = createFeedbackContext({ pathname: ownerWindow.location.pathname,
          theme: ownerDocument.documentElement.getAttribute('data-theme'),
          width: ownerWindow.innerWidth, height: ownerWindow.innerHeight,
          buildSha, userAgent: ownerWindow.navigator.userAgent });
        dialog = createFeedbackDialog({ ...binding, context, document: ownerDocument, onSaved: update });
      }
      dialog.open(button); update();
    } catch { /* Missing release/context information must never submit guessed data. */ }
  });
  place(); phone.addEventListener('change', place); update();
  return Object.freeze({ owner, isCurrent: () => !destroyed && binding.isCurrent(owner),
    setEligible(value) {
      eligible = value === true;
      if (!eligible && !dialog?.hasPendingIntent()) { dialog?.destroy(); dialog = null; }
      update();
    }, destroy });
}
