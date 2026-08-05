import { acquireDialogLayer } from './dialog.mjs';
import { resolveSiteTrainingStep } from './site-training-registry.mjs';

const STYLE_URL = new URL('../assets/site-training.css', import.meta.url).href;
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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
    trigger: null,
  };

  const clearTarget = () => {
    state.target?.classList?.remove('site-training-target');
    state.target = null;
    panel.style.removeProperty('--site-training-left');
    panel.style.removeProperty('--site-training-top');
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

  const position = () => {
    if (!state.open || !state.target) return;
    const view = ownerDocument.defaultView;
    if (view?.matchMedia?.('(max-width: 640px)').matches) return;
    const targetBounds = state.target.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const margin = 16;
    const gap = 14;
    const maxLeft = Math.max(margin, view.innerWidth - panelBounds.width - margin);
    const left = Math.min(Math.max(targetBounds.left, margin), maxLeft);
    let top = targetBounds.bottom + gap;
    if (top + panelBounds.height > view.innerHeight - margin) {
      top = targetBounds.top - panelBounds.height - gap;
    }
    top = Math.min(Math.max(top, margin), Math.max(margin, view.innerHeight - panelBounds.height - margin));
    panel.style.setProperty('--site-training-left', `${Math.round(left)}px`);
    panel.style.setProperty('--site-training-top', `${Math.round(top)}px`);
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
      fallback.hidden = Boolean(state.target);
      panel.setAttribute(
        'aria-describedby',
        fallback.hidden ? 'siteTrainingDescription' : 'siteTrainingDescription siteTrainingFallback',
      );
      backButton.hidden = index === 0;
      stopButton.textContent = state.replay ? 'Close replay' : 'Stop for now';
      nextButton.textContent = state.finalStep ? 'Finish' : 'Next';
      layer.classList.toggle('has-target', Boolean(state.target));
      setError('');
      position();
      if (state.target) {
        const reduceMotion = ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        state.target.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      }
      focusTitle();
      return resolved;
    },
    open({ trigger = ownerDocument.activeElement, replay = false } = {}) {
      if (state.destroyed) throw new Error('Cannot open destroyed page training.');
      if (state.open) return controller;
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
      ownerDocument.defaultView?.removeEventListener?.('resize', position);
      ownerDocument.defaultView?.removeEventListener?.('scroll', position);
      layer.remove();
    },
  };

  backButton.addEventListener('click', () => { void runAction('back'); });
  stopButton.addEventListener('click', () => { void runAction('stop'); });
  nextButton.addEventListener('click', () => { void runAction(state.finalStep ? 'finish' : 'next'); });
  closeButton.addEventListener('click', () => { void runAction('stop'); });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) void runAction('stop');
  });
  ownerDocument.defaultView?.addEventListener?.('resize', position, { passive: true });
  ownerDocument.defaultView?.addEventListener?.('scroll', position, { passive: true });

  return controller;
}
