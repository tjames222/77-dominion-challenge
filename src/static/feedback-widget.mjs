import { createFeedbackDialog } from './feedback-dialog.mjs';
import { createFeedbackContext } from './feedback-context.mjs';
import './feedback-dialog.css';
import './feedback-widget.css';

const FEEDBACK_GAP = 8;
const FEEDBACK_HIT_GRID = 5;
const FEEDBACK_PLACEMENT_PASSES = 10;
const FEEDBACK_SETTLEMENT_EVENTS = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
const FEEDBACK_OBSTRUCTIONS = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[role="button"]',
  'footer', '[data-sticky-secondary-tabs]', '[data-feedback-obstruction]',
].join(',');

const finiteRect = value => value && ['left', 'right', 'top', 'bottom'].every(key => Number.isFinite(value[key]));
const intersects = (a, b, gap) => a.left < b.right + gap && a.right > b.left - gap
  && a.top < b.bottom + gap && a.bottom > b.top - gap;

// Keep the fixed launcher on the right edge and lift it only far enough to
// clear visible actions or footers. The pure projection makes every geometry
// decision deterministic and independently testable.
export function feedbackLiftForObstructions({ anchor, obstructions = [], viewportTop = 0, gap = FEEDBACK_GAP } = {}) {
  if (!finiteRect(anchor) || !Number.isFinite(viewportTop) || !Number.isFinite(gap) || gap < 0
    || !Array.isArray(obstructions) || obstructions.some(rect => !finiteRect(rect))) throw new TypeError('Feedback placement requires finite rectangles.');
  if (anchor.top < viewportTop + gap) return Object.freeze({ lift: 0, clear: false });
  const maximum = Math.max(0, anchor.top - viewportTop - gap);
  let lift = 0;
  for (let pass = 0; pass <= obstructions.length; pass += 1) {
    const candidate = { left: anchor.left, right: anchor.right, top: anchor.top - lift, bottom: anchor.bottom - lift };
    const collisions = obstructions.filter(rect => intersects(candidate, rect, gap));
    if (!collisions.length) return Object.freeze({ lift, clear: true });
    const required = Math.max(...collisions.map(rect => anchor.bottom - rect.top + gap));
    if (required <= lift || required > maximum) return Object.freeze({ lift: maximum, clear: false });
    lift = required;
  }
  return Object.freeze({ lift: maximum, clear: false });
}

// Mounted only after a fresh server context permits EA feedback. Ambient data
// is limited to the explicitly documented context allowlist, captured on open.
export function mountFeedbackWidget({ client, owner, beforeOpen = () => {}, buildSha,
  document: ownerDocument = globalThis.document, window: ownerWindow = globalThis.window } = {}) {
  const binding = client.bindOwner(owner);
  let destroyed = false; let eligible = true; let dialog = null; let placementFrame = 0;
  const button = ownerDocument.createElement('button');
  button.type = 'button'; button.className = 'feedback-widget'; button.dataset.feedbackWidget = '';
  const icon = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  const path = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h7');
  icon.append(path); const label = ownerDocument.createElement('span'); label.textContent = 'Feedback';
  button.append(icon, label); button.setAttribute('aria-label', 'Send Feedback');
  // Inspect only a fixed grid around the candidate launcher rectangle. This
  // keeps scroll work independent of page/history length while still finding
  // the actionable element (or declared footer) underneath each hit point.
  function obstructionRects(candidate) {
    const viewport = ownerWindow.visualViewport;
    const left = viewport?.offsetLeft || 0; const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || ownerWindow.innerWidth);
    const bottom = top + (viewport?.height || ownerWindow.innerHeight);
    const points = (start, end) => Array.from({ length: FEEDBACK_HIT_GRID }, (_, index) =>
      Math.min(end, Math.max(start, start + ((end - start) * index) / (FEEDBACK_HIT_GRID - 1))));
    const xs = points(Math.max(left, candidate.left - FEEDBACK_GAP + .5),
      Math.min(right - .5, candidate.right + FEEDBACK_GAP - .5));
    const ys = points(Math.max(top, candidate.top - FEEDBACK_GAP + .5),
      Math.min(bottom - .5, candidate.bottom + FEEDBACK_GAP - .5));
    const nodes = new Set();
    for (const x of xs) for (const y of ys) {
      for (const hit of ownerDocument.elementsFromPoint(x, y)) {
        const node = hit.closest?.(FEEDBACK_OBSTRUCTIONS);
        if (node) nodes.add(node);
      }
    }
    const visibleNodes = [...nodes].filter(node => {
      if (node === button || button.contains(node) || node.closest('[hidden], [inert]')) return false;
      const style = ownerWindow.getComputedStyle(node);
      return style.display !== 'none' && style.visibility === 'visible';
    });
    return { nodes: visibleNodes, rects: visibleNodes.flatMap(node =>
      [...node.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }))
        .filter(rect => rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom)
    ) };
  }
  function settlePlacement() {
    placementFrame = 0;
    if (destroyed || button.hidden || !button.isConnected) return;
    const viewport = ownerWindow.visualViewport;
    button.style.setProperty('--feedback-viewport-right', `${Math.max(0, ownerWindow.innerWidth - ((viewport?.offsetLeft || 0) + (viewport?.width || ownerWindow.innerWidth)))}px`);
    button.style.setProperty('--feedback-viewport-bottom', `${Math.max(0, ownerWindow.innerHeight - ((viewport?.offsetTop || 0) + (viewport?.height || ownerWindow.innerHeight)))}px`);
    button.style.removeProperty('--feedback-lift');
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const safeTop = Number.parseFloat(ownerWindow.getComputedStyle(button).getPropertyValue('--feedback-safe-top')) || 0;
    const seen = []; const nextObserved = new Set();
    let placement = Object.freeze({ lift: 0, clear: true });
    for (let pass = 0; pass < FEEDBACK_PLACEMENT_PASSES; pass += 1) {
      const candidate = { left: rect.left, right: rect.right, top: rect.top - placement.lift, bottom: rect.bottom - placement.lift };
      const found = obstructionRects(candidate);
      found.nodes.forEach(node => nextObserved.add(node)); seen.push(...found.rects);
      const next = feedbackLiftForObstructions({ anchor: rect, obstructions: seen,
        viewportTop: (viewport?.offsetTop || 0) + Math.max(0, safeTop) });
      if (!next.clear || next.lift === placement.lift) { placement = next; break; }
      placement = next;
      if (pass === FEEDBACK_PLACEMENT_PASSES - 1) placement = Object.freeze({ lift: placement.lift, clear: false });
    }
    for (const node of observedObstructions) if (!nextObserved.has(node)) resizeObserver?.unobserve(node);
    for (const node of nextObserved) if (!observedObstructions.has(node)) resizeObserver?.observe(node);
    observedObstructions = nextObserved;
    button.style.setProperty('--feedback-lift', `${Math.ceil(placement.lift)}px`);
    button.toggleAttribute('data-obstructed', !placement.clear);
  }
  function schedulePlacement() {
    if (destroyed || placementFrame) return;
    placementFrame = ownerWindow.requestAnimationFrame(settlePlacement);
  }
  function handleMotionSettlement(event) {
    // Placement can itself transition bottom under shared reduced-motion
    // styles. Only surrounding content may schedule a settlement recheck.
    if (event.target === button || button.contains(event.target)) return;
    schedulePlacement();
  }
  function update() {
    if (destroyed) return;
    const retry = Boolean(dialog?.hasPendingIntent());
    button.hidden = !eligible && !retry;
    button.setAttribute('aria-label', retry ? 'Retry feedback submission' : 'Send Feedback');
    label.textContent = retry ? 'Retry' : 'Feedback';
    ownerDocument.body.toggleAttribute('data-feedback-mounted', !button.hidden);
    schedulePlacement();
  }
  function place() {
    if (destroyed) return;
    ownerDocument.body.append(button); schedulePlacement();
  }
  function destroy() {
    if (destroyed) return; destroyed = true;
    dialog?.destroy(); dialog = null; button.remove();
    if (placementFrame) ownerWindow.cancelAnimationFrame(placementFrame);
    ownerDocument.removeEventListener('scroll', schedulePlacement, true);
    for (const event of FEEDBACK_SETTLEMENT_EVENTS) ownerDocument.removeEventListener(event, handleMotionSettlement, true);
    ownerWindow.removeEventListener('resize', schedulePlacement);
    ownerWindow.visualViewport?.removeEventListener('resize', schedulePlacement);
    ownerWindow.visualViewport?.removeEventListener('scroll', schedulePlacement);
    resizeObserver?.disconnect(); mutationObserver?.disconnect();
    ownerDocument.body.removeAttribute('data-feedback-mounted'); unsubscribe();
  }
  let observedObstructions = new Set();
  const resizeObserver = typeof ownerWindow.ResizeObserver === 'function' ? new ownerWindow.ResizeObserver(schedulePlacement) : null;
  resizeObserver?.observe(ownerDocument.documentElement); resizeObserver?.observe(ownerDocument.body);
  const mutationObserver = typeof ownerWindow.MutationObserver === 'function' ? new ownerWindow.MutationObserver(records => {
    if (records.every(record => record.target === button && record.attributeName === 'style')) return;
    schedulePlacement();
  }) : null;
  mutationObserver?.observe(ownerDocument.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'open', 'hidden', 'inert', 'aria-hidden', 'data-dialog-open', 'data-feedback-obstruction'] });
  ownerDocument.addEventListener('scroll', schedulePlacement, { passive: true, capture: true });
  // Transform motion does not resize its box or mutate styles as it settles.
  // Recheck once at its boundary so a temporarily obstructed launcher recovers.
  for (const event of FEEDBACK_SETTLEMENT_EVENTS) ownerDocument.addEventListener(event, handleMotionSettlement, { passive: true, capture: true });
  ownerWindow.addEventListener('resize', schedulePlacement, { passive: true });
  ownerWindow.visualViewport?.addEventListener('resize', schedulePlacement, { passive: true });
  ownerWindow.visualViewport?.addEventListener('scroll', schedulePlacement, { passive: true });
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
  place(); update();
  return Object.freeze({ owner, isCurrent: () => !destroyed && binding.isCurrent(owner),
    setEligible(value) {
      eligible = value === true;
      if (!eligible && !dialog?.hasPendingIntent()) { dialog?.destroy(); dialog = null; }
      update();
    }, destroy });
}
