import { acquireDialogLayer } from './dialog.mjs';
import { resolveSiteTrainingStep } from './site-training-registry.mjs';

const STYLE_URL = new URL('../assets/site-training.css', import.meta.url).href;
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// The scrim has a real hole; no target reparenting, z-index promotion, or clone
// can change product layout, accessible names, disabled state, or live content.
export function siteTrainingGeometry(target, panel, viewport) {
  if (target.right <= target.left || target.bottom <= target.top) return null;
  const margin = 12;
  const edge = 4;
  const gap = 14;
  const left = viewport.left || 0;
  const top = viewport.top || 0;
  const right = left + viewport.width;
  const bottom = top + viewport.height;
  const safeLeft = left + Math.max(margin, viewport.padding?.left || 0);
  const safeTop = top + Math.max(margin, viewport.padding?.top || 0);
  const safeRight = right - Math.max(margin, viewport.padding?.right || 0);
  const safeBottom = bottom - Math.max(margin, viewport.padding?.bottom || 0);
  const hole = {
    left: Math.max(left + edge, target.left - 8),
    top: Math.max(top + edge, target.top - 8),
    right: Math.min(right - edge, target.right + 8),
    bottom: Math.min(bottom - edge, target.bottom + 8),
  };
  if (hole.right <= hole.left || hole.bottom <= hole.top) return null;
  const width = Math.min(panel.width, safeRight - safeLeft);
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const alignedLeft = clamp(hole.left, safeLeft, safeRight - width);
  const alignedTop = clamp(hole.top, safeTop, safeBottom - panel.height);
  const candidates = [
    { left: alignedLeft, top: hole.bottom + gap, height: safeBottom - hole.bottom - gap },
    { left: alignedLeft, top: safeTop, height: hole.top - gap - safeTop, above: true },
    ...(safeRight - hole.right - gap >= width
      ? [{ left: hole.right + gap, top: alignedTop, height: safeBottom - alignedTop }] : []),
    ...(hole.left - gap - safeLeft >= width
      ? [{ left: hole.left - gap - width, top: alignedTop, height: safeBottom - alignedTop }] : []),
  ];
  const fit = candidates.find((candidate) => candidate.height >= panel.height)
    || candidates.reduce((best, candidate) => candidate.height > best.height ? candidate : best);
  // Very large targets can leave no separate usable region. Keep a bounded,
  // scrollable coachmark; never move or clone the product to manufacture space.
  const height = Math.min(panel.height, Math.max(240, fit.height), safeBottom - safeTop);
  const panelTop = fit.above ? hole.top - gap - height : fit.top;
  return {
    hole,
    panel: {
      left: fit.left,
      top: clamp(panelTop, safeTop, safeBottom - height),
      maxHeight: height,
    },
    panes: [
      { left, top, width: viewport.width, height: hole.top - top },
      { left: hole.right, top: hole.top, width: right - hole.right, height: hole.bottom - hole.top },
      { left, top: hole.bottom, width: viewport.width, height: bottom - hole.bottom },
      { left, top: hole.top, width: hole.left - left, height: hole.bottom - hole.top },
    ],
  };
}

function element(ownerDocument, tag, className = '', value = '') {
  const node = ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}

export function siteTrainingTargetSelector(token) {
  if (!TARGET_PATTERN.test(String(token || ''))) return '';
  return `[data-training-target="${token}"]`;
}

export function siteTrainingTargetAvailable(target, ownerWindow = globalThis.window) {
  if (!target || target.hidden || target.closest?.('[hidden]')) return false;
  const styles = ownerWindow?.getComputedStyle?.(target);
  if (styles && (styles.display === 'none' || styles.visibility === 'hidden')) return false;
  return typeof target.getClientRects !== 'function' || target.getClientRects().length > 0;
}

function ensureStyles(ownerDocument) {
  const stylesReady = ownerDocument.defaultView?.getComputedStyle?.(ownerDocument.documentElement)
    ?.getPropertyValue?.('--site-training-styles-ready')
    ?.trim() === '1';
  if (stylesReady) return;
  const existing = [...(ownerDocument.head?.querySelectorAll?.('link[rel="stylesheet"]') || [])]
    .find((link) => link.href === STYLE_URL || link.dataset.siteTrainingStyles !== undefined);
  if (existing) return;
  const stylesheet = ownerDocument.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = STYLE_URL;
  stylesheet.dataset.siteTrainingStyles = '';
  ownerDocument.head?.append(stylesheet);
}

export function createSiteTrainingCoachmark({
  document: ownerDocument = globalThis.document,
  onAction = async () => {},
} = {}) {
  if (!ownerDocument?.body || !ownerDocument.createElement) {
    throw new TypeError('Site training requires a browser document.');
  }
  ensureStyles(ownerDocument);

  const layer = element(ownerDocument, 'div', 'site-training-layer');
  layer.hidden = true;
  layer.setAttribute('aria-hidden', 'true');
  const backdrop = element(ownerDocument, 'div', 'site-training-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  const panes = Array.from({ length: 4 }, () => element(ownerDocument, 'div', 'site-training-scrim'));
  const spotlight = element(ownerDocument, 'div', 'site-training-spotlight');
  backdrop.append(...panes, spotlight);
  const panel = element(ownerDocument, 'section', 'site-training-coachmark');
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'siteTrainingTitle');
  panel.setAttribute('aria-describedby', 'siteTrainingDescription');

  const header = element(ownerDocument, 'header', 'site-training-header');
  const progress = element(ownerDocument, 'p', 'eyebrow site-training-progress', 'Page training');
  progress.id = 'siteTrainingProgress';
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  progress.setAttribute('aria-atomic', 'true');
  const closeButton = element(ownerDocument, 'button', 'site-training-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Stop training for now');
  header.append(progress, closeButton);

  const title = element(ownerDocument, 'h2');
  title.id = 'siteTrainingTitle';
  title.tabIndex = -1;
  const description = element(ownerDocument, 'p', 'site-training-description');
  description.id = 'siteTrainingDescription';
  const fallback = element(
    ownerDocument,
    'p',
    'site-training-fallback',
    'This lesson is available without an on-page highlight.',
  );
  fallback.id = 'siteTrainingFallback';
  fallback.hidden = true;
  const error = element(ownerDocument, 'p', 'site-training-error');
  error.id = 'siteTrainingError';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'assertive');
  error.hidden = true;

  const actions = element(ownerDocument, 'div', 'site-training-actions');
  const backButton = element(ownerDocument, 'button', 'secondary', 'Back');
  backButton.type = 'button';
  backButton.dataset.trainingAction = 'back';
  const stopButton = element(ownerDocument, 'button', 'secondary', 'Stop for now');
  stopButton.type = 'button';
  stopButton.dataset.trainingAction = 'stop';
  const nextButton = element(ownerDocument, 'button', 'primary', 'Next');
  nextButton.type = 'button';
  nextButton.dataset.trainingAction = 'next';
  actions.append(backButton, stopButton, nextButton);
  panel.append(header, title, description, fallback, error, actions);
  layer.append(backdrop, panel);
  ownerDocument.body.append(layer);

  const state = {
    busy: false,
    destroyed: false,
    finalStep: false,
    modalOwner: null,
    open: false,
    replay: false,
    target: null,
    observedTargets: [],
    trigger: null,
  };
  let resizeFrame = null;

  const clearTarget = () => {
    if (resizeFrame !== null) {
      ownerDocument.defaultView?.cancelAnimationFrame?.(resizeFrame);
      resizeFrame = null;
    }
    resizeObserver?.unobserve(panel);
    state.observedTargets.forEach((target) => resizeObserver?.unobserve(target));
    state.observedTargets = [];
    state.target?.classList?.remove('site-training-target');
    state.target = null;
    panel.style.removeProperty('--site-training-left');
    panel.style.removeProperty('--site-training-top');
    panel.style.removeProperty('max-height');
    panel.style.removeProperty('max-width');
    layer.classList.remove('has-target');
  };

  const setBusy = (busy, message = 'Saving page training…') => {
    state.busy = Boolean(busy);
    panel.setAttribute('aria-busy', String(state.busy));
    [backButton, stopButton, nextButton, closeButton].forEach((button) => {
      button.disabled = state.busy;
    });
    progress.textContent = state.busy ? message : progress.dataset.label || 'Page training';
  };

  const setError = (message = '') => {
    error.textContent = String(message || '').trim();
    error.hidden = !error.textContent;
  };

  const setFallback = (visible) => {
    fallback.hidden = !visible;
    panel.setAttribute('aria-describedby', visible
      ? 'siteTrainingDescription siteTrainingFallback' : 'siteTrainingDescription');
  };

  const focusTitle = () => {
    const focus = () => {
      if (state.open) title.focus?.({ preventScroll: true });
    };
    if (ownerDocument.defaultView?.requestAnimationFrame) {
      ownerDocument.defaultView.requestAnimationFrame(focus);
    } else {
      queueMicrotask(focus);
    }
  };

  const revealTarget = () => {
    if (!state.open || !state.target) return;
    state.target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const body = ownerDocument.body;
    if (!state.modalOwner?.isActive || body.style.position !== 'fixed' || !body.hasAttribute('data-dialog-open')) return;
    const view = ownerDocument.defaultView;
    const viewport = view.visualViewport;
    const css = view.getComputedStyle(layer);
    const top = (viewport?.offsetTop || 0) + Math.max(12, Number.parseFloat(css.paddingTop) || 0) + 8;
    const bottom = (viewport?.offsetTop || 0) + (viewport?.height || view.innerHeight)
      - Math.max(12, Number.parseFloat(css.paddingBottom) || 0) - 8;
    const bounds = state.target.getBoundingClientRect();
    if (bounds.top >= top && bounds.bottom <= bottom) return;
    // The modal owns a fixed-body scroll lock, so native scrolling can reveal
    // nested scrollers but not the page itself. Move only its visual offset;
    // the dialog's original styles/scroll snapshot remains the restore point.
    const previousTop = body.style.top;
    const currentOffset = Number.parseFloat(previousTop) || 0;
    const maxScroll = Math.max(0, body.scrollHeight - view.innerHeight);
    const nextScroll = Math.max(0, Math.min(maxScroll, -currentOffset + bounds.top - top));
    body.style.top = `${-nextScroll}px`;
    // Viewport-fixed targets do not travel with the body. Do not move the
    // surrounding page when the target itself could not be revealed that way.
    if (Math.abs(state.target.getBoundingClientRect().top - bounds.top) < 0.5) body.style.top = previousTop;
  };

  const position = () => {
    if (!state.open || !state.target) return;
    const view = ownerDocument.defaultView;
    if (!siteTrainingTargetAvailable(state.target, view) || state.target.isConnected === false) {
      clearTarget();
      setFallback(true);
      return;
    }
    const targetBounds = state.target.getBoundingClientRect();
    // Nested scrollers can clip an otherwise visible target. Illuminate only
    // the visible intersection, with the outline outside their clipping tree.
    const visible = { left: targetBounds.left, top: targetBounds.top, right: targetBounds.right, bottom: targetBounds.bottom };
    for (let ancestor = state.target.parentElement; ancestor && ancestor !== ownerDocument.body; ancestor = ancestor.parentElement) {
      const css = view.getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        visible.left = Math.max(visible.left, bounds.left);
        visible.right = Math.min(visible.right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        visible.top = Math.max(visible.top, bounds.top);
        visible.bottom = Math.min(visible.bottom, bounds.bottom);
      }
    }
    const viewport = view.visualViewport;
    const layerStyle = view.getComputedStyle(layer);
    const padding = Object.fromEntries(['left', 'top', 'right', 'bottom'].map((side) => [
      side, Math.max(12, Number.parseFloat(layerStyle.getPropertyValue(`padding-${side}`)) || 0),
    ]));
    // Pinch zoom changes the visual viewport without changing CSS breakpoints.
    // Clamp the actual rendered width before measuring wrapping and height.
    panel.style.maxWidth = `${Math.max(0, (viewport?.width || view.innerWidth) - padding.left - padding.right)}px`;
    const panelBounds = panel.getBoundingClientRect();
    const geometry = siteTrainingGeometry(visible, {
      width: panelBounds.width,
      height: Math.max(panelBounds.height, panel.scrollHeight + panelBounds.height - panel.clientHeight),
    }, { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || view.innerWidth, height: viewport?.height || view.innerHeight, padding });
    layer.classList.toggle('has-target', Boolean(geometry));
    setFallback(!geometry);
    if (!geometry) { panel.style.removeProperty('max-height'); return; }
    const setRect = (node, bounds) => Object.entries(bounds).forEach(([property, value]) => {
      node.style[property] = `${value}px`;
    });
    geometry.panes.forEach((bounds, index) => setRect(panes[index], bounds));
    const { hole } = geometry;
    setRect(spotlight, { left: hole.left, top: hole.top, width: hole.right - hole.left, height: hole.bottom - hole.top });
    panel.style.setProperty('--site-training-left', `${geometry.panel.left}px`);
    panel.style.setProperty('--site-training-top', `${geometry.panel.top}px`);
    panel.style.maxHeight = `${geometry.panel.maxHeight}px`;
  };

  const repositionForResize = () => {
    revealTarget();
    position();
  };

  // Positioning can resize the observed panel. Defer that write to the next
  // frame instead of causing a ResizeObserver delivery loop in WebKit.
  const schedulePosition = () => {
    if (!state.open || resizeFrame !== null) return;
    const view = ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) { position(); return; }
    resizeFrame = view.requestAnimationFrame(() => {
      resizeFrame = null;
      position();
    });
  };

  const runAction = async (action) => {
    if (!state.open || state.busy) return false;
    setError('');
    try {
      await onAction(action, controller);
      return true;
    } catch (actionError) {
      setError(actionError?.message || 'Page training could not be saved. Try again.');
      return false;
    }
  };

  const controller = {
    elements: {
      layer, backdrop, panel, progress, closeButton, title, description, fallback, error,
      actions, backButton, stopButton, nextButton,
    },
    get isBusy() { return state.busy; },
    get isOpen() { return state.open; },
    get isReplay() { return state.replay; },
    get target() { return state.target; },
    setBusy,
    setError,
    render({
      step,
      index,
      total,
      pageIndex = null,
      pageTotal = null,
      capabilities = {},
      replay = false,
    } = {}) {
      if (!step || !Number.isInteger(index) || !Number.isInteger(total) || total < 1) {
        throw new TypeError('A published page training step is required.');
      }
      clearTarget();
      const resolved = resolveSiteTrainingStep(step, capabilities);
      const selector = siteTrainingTargetSelector(resolved.target);
      const target = selector ? ownerDocument.querySelector(selector) : null;
      if (resolved.available && siteTrainingTargetAvailable(target, ownerDocument.defaultView)) {
        state.target = target;
        target.classList.add('site-training-target');
        resizeObserver?.observe(panel);
        for (let observed = target; observed && observed !== ownerDocument.body; observed = observed.parentElement) {
          state.observedTargets.push(observed);
          resizeObserver?.observe(observed);
        }
      }
      state.finalStep = index === total - 1;
      state.replay = Boolean(replay);
      const hasOverallProgress = Number.isInteger(pageIndex)
        && Number.isInteger(pageTotal)
        && pageIndex >= 0
        && pageIndex < pageTotal
        && pageTotal > 0;
      progress.dataset.label = state.replay
        ? `Replay · Step ${index + 1} of ${total}`
        : hasOverallProgress
          ? `Page ${pageIndex + 1} of ${pageTotal} · Step ${index + 1} of ${total}`
          : `Step ${index + 1} of ${total}`;
      progress.textContent = progress.dataset.label;
      title.textContent = resolved.title;
      description.textContent = resolved.description;
      setFallback(!state.target);
      backButton.hidden = index === 0;
      stopButton.textContent = state.replay ? 'Close replay' : 'Stop for now';
      nextButton.textContent = state.finalStep ? 'Finish' : 'Next';
      layer.classList.toggle('has-target', Boolean(state.target));
      setError('');
      revealTarget();
      position();
      focusTitle();
      return resolved;
    },
    open({ trigger = ownerDocument.activeElement, replay = false } = {}) {
      if (state.destroyed) throw new Error('Cannot open destroyed page training.');
      if (state.open) return controller;
      // A body overlay cannot outrank the browser's native modal top layer.
      // Defer instead of closing/reparenting a live product dialog or stealing
      // its focus. Current published training has no native-dialog targets.
      if (ownerDocument.querySelector?.('dialog:modal')) {
        throw new Error('Close the open dialog before starting page training.');
      }
      state.open = true;
      state.replay = Boolean(replay);
      state.trigger = trigger?.focus ? trigger : null;
      layer.hidden = false;
      layer.setAttribute('aria-hidden', 'false');
      state.modalOwner = acquireDialogLayer({
        document: ownerDocument,
        layer,
        panel,
        onEscape: () => { void runAction('stop'); },
        onReplace: () => controller.close({ restoreFocus: false }),
      });
      focusTitle();
      return controller;
    },
    close({ restoreFocus = true } = {}) {
      if (!state.open) return false;
      const trigger = state.trigger;
      state.open = false;
      state.trigger = null;
      clearTarget();
      state.modalOwner?.release();
      state.modalOwner = null;
      layer.hidden = true;
      layer.setAttribute('aria-hidden', 'true');
      setBusy(false);
      setError('');
      if (restoreFocus && trigger?.isConnected !== false) trigger?.focus?.({ preventScroll: true });
      return true;
    },
    destroy() {
      controller.close({ restoreFocus: false });
      state.destroyed = true;
      ownerDocument.defaultView?.removeEventListener?.('resize', repositionForResize);
      ownerDocument.defaultView?.removeEventListener?.('scroll', position, true);
      ownerDocument.defaultView?.visualViewport?.removeEventListener?.('resize', repositionForResize);
      ownerDocument.defaultView?.visualViewport?.removeEventListener?.('scroll', position);
      resizeObserver?.disconnect();
      layer.remove();
    },
  };

  backButton.addEventListener('click', () => { void runAction('back'); });
  stopButton.addEventListener('click', () => { void runAction('stop'); });
  nextButton.addEventListener('click', () => { void runAction(state.finalStep ? 'finish' : 'next'); });
  closeButton.addEventListener('click', () => { void runAction('stop'); });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || panes.includes(event.target)) void runAction('stop');
  });
  ownerDocument.defaultView?.addEventListener?.('resize', repositionForResize, { passive: true });
  ownerDocument.defaultView?.addEventListener?.('scroll', position, { passive: true, capture: true });
  ownerDocument.defaultView?.visualViewport?.addEventListener?.('resize', repositionForResize, { passive: true });
  ownerDocument.defaultView?.visualViewport?.addEventListener?.('scroll', position, { passive: true });
  const resizeObserver = ownerDocument.defaultView?.ResizeObserver
    ? new ownerDocument.defaultView.ResizeObserver(schedulePosition) : null;

  return controller;
}
