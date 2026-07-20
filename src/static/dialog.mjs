const activeDialogs = new WeakMap();
let dialogSequence = 0;

export const DIALOG_MOBILE_BREAKPOINT = 640;
export const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

const text = (value) => String(value ?? '').trim();

function setAttributeIf(element, name, value) {
  if (value) element.setAttribute(name, value);
  else element.removeAttribute(name);
}

function visibleToKeyboard(element) {
  if (!element || element.hidden || element.disabled || element.tabIndex < 0) return false;
  if (element.getAttribute?.('aria-hidden') === 'true') return false;
  if (element.closest?.('[hidden], [inert]')) return false;

  const view = element.ownerDocument?.defaultView;
  const computed = view?.getComputedStyle?.(element);
  return !computed || (computed.display !== 'none' && computed.visibility !== 'hidden');
}

export function getDialogFocusableElements(container) {
  if (!container?.querySelectorAll) return [];
  return [...container.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)].filter(visibleToKeyboard);
}

export function resolveDialogInitialFocus(panel, initialFocus) {
  let candidate = initialFocus;

  if (typeof candidate === 'function') candidate = candidate(panel);
  if (typeof candidate === 'string') {
    try {
      candidate = panel?.querySelector?.(candidate);
    } catch {
      candidate = null;
    }
  }

  if (visibleToKeyboard(candidate)) return candidate;

  const preferred = panel?.querySelector?.('[data-dialog-initial-focus]');
  if (visibleToKeyboard(preferred)) return preferred;

  return getDialogFocusableElements(panel)[0] || panel;
}

export function trapDialogFocus(event, panel, ownerDocument = panel?.ownerDocument) {
  if (event?.key !== 'Tab') return false;

  const focusable = getDialogFocusableElements(panel);
  if (!focusable.length) {
    event.preventDefault?.();
    panel?.focus?.();
    return true;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = ownerDocument?.activeElement;
  const activeInside = panel?.contains?.(active);

  if (!activeInside || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault?.();
    (event.shiftKey ? last : first).focus();
    return true;
  }

  return false;
}

export function createDialogSemantics({ titleId, descriptionId, ariaLabel, alert = false } = {}) {
  const attributes = {
    role: alert ? 'alertdialog' : 'dialog',
    'aria-modal': 'true',
  };

  if (titleId) attributes['aria-labelledby'] = titleId;
  else if (text(ariaLabel)) attributes['aria-label'] = text(ariaLabel);

  if (descriptionId) attributes['aria-describedby'] = descriptionId;
  return attributes;
}

export function resolveDialogPresentation(presentation = 'responsive', viewportWidth = Infinity) {
  if (presentation === 'sheet' || presentation === 'dialog') return presentation;
  return viewportWidth <= DIALOG_MOBILE_BREAKPOINT ? 'sheet' : 'dialog';
}

export function canDismissDialog(reason, {
  busy = false,
  closeOnBackdrop = true,
  closeOnEscape = true,
} = {}) {
  if (busy && !['destroy', 'replaced'].includes(reason)) return false;
  if (reason === 'backdrop') return closeOnBackdrop;
  if (reason === 'escape') return closeOnEscape;
  return true;
}

export function isolateDialogPage(ownerDocument, layer) {
  const body = ownerDocument?.body;
  if (!body || !layer) return () => {};

  const view = ownerDocument.defaultView;
  const root = ownerDocument.documentElement;
  const scrollX = Number(view?.scrollX || 0);
  const scrollY = Number(view?.scrollY || root?.scrollTop || 0);
  const bodyAttribute = body.getAttribute('data-dialog-open');
  const bodyStyles = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
  };
  const siblings = [...body.children]
    .filter((element) => element !== layer)
    .map((element) => ({
      element,
      hadInert: element.hasAttribute('inert'),
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));

  siblings.forEach(({ element }) => {
    element.inert = true;
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
  });

  body.setAttribute('data-dialog-open', '');
  body.style.position = 'fixed';
  body.style.top = `${-scrollY}px`;
  body.style.left = `${-scrollX}px`;
  body.style.right = '0';
  body.style.width = '100%';
  body.style.overflow = 'hidden';

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;

    siblings.forEach(({ element, hadInert, inert, ariaHidden }) => {
      element.inert = inert;
      if (hadInert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    });

    if (bodyAttribute === null) body.removeAttribute('data-dialog-open');
    else body.setAttribute('data-dialog-open', bodyAttribute);
    Object.assign(body.style, bodyStyles);

    if (view?.scrollTo) {
      try {
        view.scrollTo(scrollX, scrollY);
      } catch {
        // Some test and embedded environments expose scrollTo without implementing it.
      }
    }
  };
}

export async function executeDialogAction(action, dialog, event) {
  if (!action || action.disabled || dialog?.isBusy) return false;

  dialog.clearError?.();
  dialog.setBusy?.(true, action.pendingLabel || 'Working…');

  let shouldClose = action.closeOnSelect !== false;
  try {
    const result = await action.onSelect?.({ action, dialog, event, value: action.value });
    if (result === false) shouldClose = false;
  } catch (error) {
    shouldClose = false;
    const message = text(action.errorMessage)
      || text(error?.message)
      || 'Something went wrong. Try again.';
    dialog.setError?.(message);
    action.onError?.(error, dialog);
  } finally {
    dialog.setBusy?.(false);
  }

  if (shouldClose) dialog.close?.(action.closeReason || 'action');
  return shouldClose;
}

function appendDialogContent(container, content, controller) {
  if (typeof content === 'function') {
    const result = content({ container, dialog: controller });
    if (result?.nodeType) container.append(result);
    return;
  }
  if (content?.nodeType) container.append(content);
  else if (content !== undefined && content !== null) container.textContent = String(content);
}

/**
 * Creates one reusable modal controller. The returned controller owns its DOM,
 * but does not open until `open(trigger)` is called.
 */
export function createDialog(options = {}) {
  const ownerDocument = options.document || globalThis.document;
  if (!ownerDocument?.createElement || !ownerDocument.body) {
    throw new TypeError('createDialog requires a browser document.');
  }

  const title = text(options.title);
  const ariaLabel = text(options.ariaLabel);
  if (!title && !ariaLabel) {
    throw new TypeError('Dialogs require a visible title or an ariaLabel.');
  }

  dialogSequence += 1;
  const id = text(options.id) || `app-dialog-${dialogSequence}`;
  const titleId = title ? `${id}-title` : '';
  const description = text(options.description);
  const descriptionId = description ? `${id}-description` : '';
  const presentation = ['dialog', 'sheet', 'responsive'].includes(options.presentation)
    ? options.presentation
    : 'responsive';

  const layer = ownerDocument.createElement('div');
  layer.className = 'app-dialog-layer';
  layer.dataset.presentation = presentation;
  layer.dataset.pattern = text(options.pattern) || 'default';
  layer.hidden = true;
  layer.setAttribute('aria-hidden', 'true');

  const backdrop = ownerDocument.createElement('div');
  backdrop.className = 'app-dialog-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  const panel = ownerDocument.createElement('section');
  panel.id = id;
  panel.className = 'app-dialog-panel';
  panel.dataset.presentation = presentation;
  panel.tabIndex = -1;
  Object.entries(createDialogSemantics({
    titleId,
    descriptionId,
    ariaLabel,
    alert: options.alert,
  })).forEach(([name, value]) => panel.setAttribute(name, value));

  const header = ownerDocument.createElement('header');
  header.className = 'app-dialog-header';
  const heading = ownerDocument.createElement('div');
  heading.className = 'app-dialog-heading';

  if (text(options.eyebrow)) {
    const eyebrow = ownerDocument.createElement('p');
    eyebrow.className = 'app-dialog-eyebrow';
    eyebrow.textContent = text(options.eyebrow);
    heading.append(eyebrow);
  }

  if (title) {
    const titleElement = ownerDocument.createElement('h2');
    titleElement.id = titleId;
    titleElement.textContent = title;
    heading.append(titleElement);
  }

  const closeButton = ownerDocument.createElement('button');
  closeButton.className = 'app-dialog-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', text(options.closeLabel) || 'Close dialog');
  closeButton.innerHTML = '<span aria-hidden="true">×</span>';
  header.append(heading, closeButton);

  const body = ownerDocument.createElement('div');
  body.className = 'app-dialog-body';

  if (description) {
    const descriptionElement = ownerDocument.createElement('p');
    descriptionElement.className = 'app-dialog-description';
    descriptionElement.id = descriptionId;
    descriptionElement.textContent = description;
    body.append(descriptionElement);
  }

  const content = ownerDocument.createElement('div');
  content.className = 'app-dialog-content';
  body.append(content);

  const status = ownerDocument.createElement('div');
  status.className = 'app-dialog-status';

  const progress = ownerDocument.createElement('p');
  progress.className = 'app-dialog-progress';
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  progress.hidden = true;

  const error = ownerDocument.createElement('p');
  error.className = 'app-dialog-error';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'assertive');
  error.hidden = true;
  status.append(progress, error);

  const footer = ownerDocument.createElement('footer');
  footer.className = 'app-dialog-actions';
  footer.dataset.pattern = text(options.pattern) || 'default';

  panel.append(header, body, status, footer);
  layer.append(backdrop, panel);
  ownerDocument.body.append(layer);

  const state = {
    busy: false,
    destroyed: false,
    focusVersion: 0,
    open: false,
    restorePage: null,
    returnFocus: null,
  };

  let controller;

  const setBusy = (busy, message = '') => {
    state.busy = Boolean(busy);
    panel.setAttribute('aria-busy', String(state.busy));
    layer.dataset.busy = String(state.busy);
    progress.textContent = state.busy ? text(message) || 'Working…' : '';
    progress.hidden = !state.busy;
    [...footer.querySelectorAll('button'), closeButton].forEach((button) => {
      setAttributeIf(button, 'aria-disabled', state.busy ? 'true' : '');
    });
  };

  const setError = (message) => {
    const normalized = text(message);
    error.textContent = normalized;
    error.hidden = !normalized;
    layer.dataset.error = String(Boolean(normalized));
  };

  const clearError = () => setError('');

  const finishClose = (reason, { force = false, restoreFocus = true } = {}) => {
    if (!state.open) return false;
    if (!force && !canDismissDialog(reason, {
      busy: state.busy,
      closeOnBackdrop: options.closeOnBackdrop !== false,
      closeOnEscape: options.closeOnEscape !== false,
    })) return false;

    state.open = false;
    state.focusVersion += 1;
    ownerDocument.removeEventListener('keydown', onKeydown, true);
    delete layer.dataset.open;
    state.restorePage?.();
    state.restorePage = null;
    if (activeDialogs.get(ownerDocument) === controller) activeDialogs.delete(ownerDocument);

    const returnFocus = state.returnFocus;
    state.returnFocus = null;
    if (restoreFocus && returnFocus?.focus && returnFocus.isConnected !== false) {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch {
        returnFocus.focus();
      }
    }

    layer.hidden = true;
    layer.setAttribute('aria-hidden', 'true');

    options.onClose?.({ dialog: controller, reason });
    return true;
  };

  const onKeydown = (event) => {
    if (!state.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishClose('escape');
      return;
    }
    trapDialogFocus(event, panel, ownerDocument);
  };

  controller = {
    elements: { layer, backdrop, panel, header, body, content, footer, closeButton, progress, error },
    get isBusy() { return state.busy; },
    get isOpen() { return state.open; },
    clearError,
    setBusy,
    setError,
    focus(target = options.initialFocus) {
      const focusTarget = resolveDialogInitialFocus(panel, target);
      focusTarget?.focus?.({ preventScroll: true });
      return focusTarget;
    },
    open(trigger = ownerDocument.activeElement) {
      if (state.destroyed) throw new Error('Cannot open a destroyed dialog.');
      if (state.open) return controller;

      const active = activeDialogs.get(ownerDocument);
      if (active && active !== controller) {
        active.__closeForReplacement?.();
      }

      state.returnFocus = trigger?.focus ? trigger : ownerDocument.activeElement;
      state.open = true;
      state.focusVersion += 1;
      const focusVersion = state.focusVersion;
      clearError();
      setBusy(false);
      layer.hidden = false;
      layer.setAttribute('aria-hidden', 'false');
      layer.dataset.open = '';
      controller.focus();
      state.restorePage = isolateDialogPage(ownerDocument, layer);
      activeDialogs.set(ownerDocument, controller);
      ownerDocument.addEventListener('keydown', onKeydown, true);

      const schedule = ownerDocument.defaultView?.requestAnimationFrame
        ? (callback) => ownerDocument.defaultView.requestAnimationFrame(callback)
        : (callback) => queueMicrotask(callback);
      schedule(() => {
        if (
          state.open
          && focusVersion === state.focusVersion
          && !panel.contains(ownerDocument.activeElement)
        ) controller.focus();
      });
      options.onOpen?.({ dialog: controller, trigger: state.returnFocus });
      return controller;
    },
    close(reason = 'programmatic') {
      return finishClose(reason);
    },
    destroy() {
      finishClose('destroy', { force: true });
      state.destroyed = true;
      layer.remove();
    },
    __closeForReplacement() {
      return finishClose('replaced', { force: true, restoreFocus: false });
    },
  };

  const actions = Array.isArray(options.actions) ? options.actions : [];
  footer.hidden = actions.length === 0;
  actions.forEach((action, index) => {
    const button = ownerDocument.createElement('button');
    const key = text(action.id || action.value) || `action-${index + 1}`;
    button.className = `app-dialog-action is-${text(action.variant) || 'secondary'}`;
    button.type = 'button';
    button.textContent = text(action.label) || 'Continue';
    button.dataset.dialogAction = key;
    button.disabled = Boolean(action.disabled);
    if (action.initialFocus) button.dataset.dialogInitialFocus = '';
    if (text(action.ariaLabel)) button.setAttribute('aria-label', text(action.ariaLabel));
    button.addEventListener('click', (event) => {
      if (state.busy || button.disabled) return;
      void executeDialogAction({ ...action, value: action.value ?? key }, controller, event);
    });
    footer.append(button);
  });

  closeButton.addEventListener('click', () => finishClose('close-button'));
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) finishClose('backdrop');
  });

  appendDialogContent(content, options.content, controller);
  return controller;
}

export function createActionListDialog(options = {}) {
  return createDialog({
    ...options,
    pattern: 'action-list',
    actions: (options.actions || []).map((action) => ({
      closeOnSelect: action.closeOnSelect !== false,
      ...action,
    })),
  });
}

export function createConfirmationDialog(options = {}) {
  return createDialog({
    ...options,
    pattern: 'confirmation',
    initialFocus: options.initialFocus || '[data-dialog-action="cancel"]',
    actions: [
      {
        id: 'cancel',
        label: options.cancelLabel || 'Cancel',
        closeReason: 'cancel',
        onSelect: options.onCancel,
        variant: 'secondary',
      },
      {
        id: 'confirm',
        label: options.confirmLabel || 'Confirm',
        pendingLabel: options.pendingLabel || 'Working…',
        errorMessage: options.errorMessage,
        onSelect: options.onConfirm,
        variant: options.destructive ? 'danger' : 'primary',
      },
    ],
  });
}
