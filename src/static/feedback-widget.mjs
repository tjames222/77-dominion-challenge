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
  const button = ownerDocument.createElement('button');
  button.type = 'button'; button.className = 'feedback-widget'; button.dataset.feedbackWidget = '';
  const icon = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  const path = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h7');
  icon.append(path); const label = ownerDocument.createElement('span'); label.textContent = 'Feedback';
  button.append(icon, label); button.setAttribute('aria-label', 'Send Feedback');
  let frame = 0; let controls = []; let refreshControls = true;
  function checkPlacement() {
    frame = 0; if (destroyed || button.hidden) return;
    // Keep the last unobstructed trigger geometry while the existing modal
    // system isolates the page. Its synchronous close can then restore focus.
    if (ownerDocument.body.hasAttribute('data-dialog-open') || ownerDocument.body.classList.contains('menu-open')) return;
    const rect = button.getBoundingClientRect();
    // Geometry/element roles only. Never inspect any page text, form value,
    // attributes containing content, or include these nodes in feedback data.
    // Cache role-bearing nodes until structure changes. Scroll/resize checks
    // only intersect rectangles; there is no per-frame selector/DOM scan and
    // narrow or partially overlapping controls cannot fall between samples.
    if (refreshControls) {
      controls = [...ownerDocument.querySelectorAll('button, a, input, textarea, select, summary, [role="button"]')]
        .filter(node => node !== button && !button.contains(node));
      refreshControls = false;
    }
    const obstructed = controls.some(node => node.isConnected && [...node.getClientRects()].some(other =>
      other.width > 0 && other.height > 0 && other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top));
    button.toggleAttribute('data-obstructed', obstructed);
  }
  function schedulePlacement() { if (!destroyed && !frame) frame = ownerWindow.requestAnimationFrame(checkPlacement); }
  const resize = typeof ownerWindow.ResizeObserver === 'function' ? new ownerWindow.ResizeObserver(schedulePlacement) : null;
  const mutation = new ownerWindow.MutationObserver(records => {
    if (records.some(record => record.type === 'childList')) refreshControls = true;
    schedulePlacement();
  });
  resize?.observe(ownerDocument.body); mutation.observe(ownerDocument.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'],
  });
  ownerWindow.addEventListener('scroll', schedulePlacement, true); ownerWindow.addEventListener('resize', schedulePlacement);
  ownerDocument.addEventListener('focusin', schedulePlacement); ownerDocument.addEventListener('focusout', schedulePlacement);
  function update() {
    if (destroyed) return;
    const retry = Boolean(dialog?.hasPendingIntent());
    button.hidden = !eligible && !retry;
    button.setAttribute('aria-label', retry ? 'Retry feedback submission' : 'Send Feedback');
    label.textContent = retry ? 'Retry' : 'Feedback'; schedulePlacement();
  }
  function destroy() {
    if (destroyed) return; destroyed = true;
    resize?.disconnect(); mutation.disconnect(); ownerWindow.cancelAnimationFrame(frame);
    ownerWindow.removeEventListener('scroll', schedulePlacement, true); ownerWindow.removeEventListener('resize', schedulePlacement);
    ownerDocument.removeEventListener('focusin', schedulePlacement); ownerDocument.removeEventListener('focusout', schedulePlacement);
    dialog?.destroy(); dialog = null; controls = []; button.remove(); ownerDocument.body.removeAttribute('data-feedback-mounted'); unsubscribe();
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
  ownerDocument.body.setAttribute('data-feedback-mounted', '');
  ownerDocument.body.append(button); checkPlacement();
  return Object.freeze({ owner, isCurrent: () => !destroyed && binding.isCurrent(owner),
    setEligible(value) {
      eligible = value === true;
      if (!eligible && !dialog?.hasPendingIntent()) { dialog?.destroy(); dialog = null; }
      update();
    }, destroy });
}
