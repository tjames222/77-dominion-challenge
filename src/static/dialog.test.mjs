import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  DIALOG_FOCUSABLE_SELECTOR,
  DIALOG_MOBILE_BREAKPOINT,
  canDismissDialog,
  createActionListDialog,
  createConfirmationDialog,
  createDialog,
  createDialogSemantics,
  executeDialogAction,
  isolateDialogPage,
  resolveDialogPresentation,
  trapDialogFocus,
} from './dialog.mjs';

const dialogCss = readFileSync(new URL('../assets/dialog.css', import.meta.url), 'utf8');
const pageNames = [
  'billing.html',
  'bible-reading.html',
  'community.html',
  'dashboard.html',
  'evening-prayer.html',
  'index.html',
  'intentional-walk.html',
  'login.html',
  'membership.html',
  'morning-prayer.html',
  'profile.html',
  'register.html',
  'science.html',
  'workout-one.html',
  'workout-two.html',
  'worship.html',
];

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {
      position: '', top: '', left: '', right: '', width: '', overflow: '',
    };
    this.hidden = false;
    this.disabled = false;
    this.inert = false;
    this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1;
    this.listeners = new Map();
    this.textContent = '';
  }

  append(...elements) {
    elements.forEach((element) => {
      element.parentElement = this;
      this.children.push(element);
    });
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    if (
      name === 'aria-hidden'
      && String(value) === 'true'
      && this.contains(this.ownerDocument.activeElement)
    ) this.ownerDocument.hidFocusedContent = true;
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    const normalized = { target: this, ...event };
    (this.listeners.get(type) || []).forEach((listener) => listener(normalized));
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === '[data-dialog-initial-focus]') {
      return Object.hasOwn(this.dataset, 'dialogInitialFocus');
    }
    const action = selector.match(/^\[data-dialog-action="([^"]+)"\]$/)?.[1];
    if (action) return this.dataset.dialogAction === action;
    if (selector === DIALOG_FOCUSABLE_SELECTOR) {
      return ['A', 'AREA', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IFRAME'].includes(this.tagName)
        || this.hasAttribute('tabindex')
        || this.getAttribute('contenteditable') === 'true';
    }
    return false;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => element.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  contains(element) {
    return element === this || this.descendants().includes(element);
  }

  closest(selector) {
    if (selector !== '[hidden], [inert]') return null;
    let current = this;
    while (current) {
      if (current.hidden || current.hasAttribute('inert')) return current;
      current = current.parentElement;
    }
    return null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  get isConnected() {
    return Boolean(this.ownerDocument?.body?.contains(this));
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.scrollCalls = [];
    this.hidFocusedContent = false;
    this.documentElement = { scrollTop: 0 };
    this.defaultView = {
      scrollX: 8,
      scrollY: 144,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      requestAnimationFrame: (callback) => callback(),
      scrollTo: (x, y) => this.scrollCalls.push([x, y]),
    };
    this.body = new FakeElement('body', this);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== listener));
  }

  keydown(key, options = {}) {
    const event = {
      key,
      shiftKey: Boolean(options.shiftKey),
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    (this.listeners.get('keydown') || []).forEach((listener) => listener(event));
    return event;
  }
}

function createPage() {
  const document = new FakeDocument();
  const page = document.createElement('main');
  const trigger = document.createElement('button');
  page.append(trigger);
  document.body.append(page);
  trigger.focus();
  return { document, page, trigger };
}

describe('dialog accessibility contract', () => {
  test('provides modal name and description semantics for screen readers', () => {
    assert.deepEqual(createDialogSemantics({
      titleId: 'share-title',
      descriptionId: 'share-description',
    }), {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'share-title',
      'aria-describedby': 'share-description',
    });
    assert.deepEqual(createDialogSemantics({ ariaLabel: 'Remove group', alert: true }), {
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-label': 'Remove group',
    });
  });

  test('opens with initial focus, traps Tab, closes on Escape, and restores focus', () => {
    const { document, page, trigger } = createPage();
    const dialog = createConfirmationDialog({
      document,
      id: 'share-confirmation',
      title: 'Share progress?',
      description: 'Choose whether to share this update.',
      onConfirm: () => true,
    });
    const [cancelButton, confirmButton] = dialog.elements.footer.querySelectorAll('button');

    assert.equal(dialog.elements.panel.getAttribute('role'), 'dialog');
    assert.equal(dialog.elements.panel.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.elements.panel.id, 'share-confirmation');
    dialog.open(trigger);

    assert.equal(document.activeElement, cancelButton);
    assert.equal(page.hasAttribute('inert'), true);
    assert.equal(page.getAttribute('aria-hidden'), 'true');
    assert.equal(document.body.style.position, 'fixed');
    assert.equal(document.body.style.top, '-144px');
    assert.equal(document.hidFocusedContent, false);

    confirmButton.focus();
    const tab = document.keydown('Tab');
    assert.equal(tab.prevented, true);
    assert.equal(document.activeElement, dialog.elements.closeButton);

    dialog.elements.closeButton.focus();
    document.keydown('Tab', { shiftKey: true });
    assert.equal(document.activeElement, confirmButton);

    const escape = document.keydown('Escape');
    assert.equal(escape.prevented, true);
    assert.equal(escape.stopped, true);
    assert.equal(dialog.isOpen, false);
    assert.equal(document.activeElement, trigger);
    assert.equal(page.hasAttribute('inert'), false);
    assert.equal(page.getAttribute('aria-hidden'), null);
    assert.equal(document.body.style.position, '');
    assert.deepEqual(document.scrollCalls, [[8, 144]]);
    assert.equal(document.hidFocusedContent, false);
  });

  test('supports explicit close and backdrop dismissal while blocking dismissal when busy', () => {
    const { document, trigger } = createPage();
    const reasons = [];
    const dialog = createDialog({
      document,
      title: 'Streak details',
      onClose: ({ reason }) => reasons.push(reason),
    });

    dialog.open(trigger);
    dialog.setBusy(true, 'Saving share…');
    assert.equal(dialog.close('escape'), false);
    assert.equal(dialog.elements.panel.getAttribute('aria-busy'), 'true');
    assert.equal(dialog.elements.closeButton.getAttribute('aria-disabled'), 'true');
    assert.equal(dialog.elements.progress.hidden, false);

    dialog.setBusy(false);
    dialog.elements.backdrop.dispatch('click');
    assert.deepEqual(reasons, ['backdrop']);

    dialog.open(trigger);
    dialog.elements.closeButton.dispatch('click');
    assert.deepEqual(reasons, ['backdrop', 'close-button']);
  });

  test('does not dismiss when backdrop and Escape dismissal are disabled', () => {
    const { document, trigger } = createPage();
    const dialog = createDialog({
      document,
      title: 'Required choice',
      closeOnBackdrop: false,
      closeOnEscape: false,
    });

    dialog.open(trigger);
    dialog.elements.backdrop.dispatch('click');
    document.keydown('Escape');
    assert.equal(dialog.isOpen, true);
    dialog.close();
  });
});

describe('dialog async and reusable patterns', () => {
  test('keeps the dialog stable until async work succeeds', async () => {
    let release;
    const calls = [];
    const dialog = {
      busy: false,
      get isBusy() { return this.busy; },
      clearError: () => calls.push(['clearError']),
      setBusy(value, message) {
        this.busy = value;
        calls.push(['busy', value, message]);
      },
      setError: (message) => calls.push(['error', message]),
      close: (reason) => calls.push(['close', reason]),
    };
    const resultPromise = executeDialogAction({
      pendingLabel: 'Publishing…',
      closeReason: 'published',
      onSelect: () => new Promise((resolve) => { release = resolve; }),
    }, dialog);

    await Promise.resolve();
    assert.equal(dialog.isBusy, true);
    assert.equal(calls.some(([type]) => type === 'close'), false);
    release(true);

    assert.equal(await resultPromise, true);
    assert.deepEqual(calls, [
      ['clearError'],
      ['busy', true, 'Publishing…'],
      ['busy', false, undefined],
      ['close', 'published'],
    ]);
  });

  test('announces async errors and leaves the dialog open for retry', async () => {
    const calls = [];
    const dialog = {
      isBusy: false,
      clearError: () => calls.push(['clearError']),
      setBusy: (value) => calls.push(['busy', value]),
      setError: (message) => calls.push(['error', message]),
      close: () => calls.push(['close']),
    };

    const didClose = await executeDialogAction({
      onSelect: async () => { throw new Error('Network unavailable'); },
    }, dialog);

    assert.equal(didClose, false);
    assert.deepEqual(calls, [
      ['clearError'],
      ['busy', true],
      ['error', 'Network unavailable'],
      ['busy', false],
    ]);
  });

  test('builds reusable action-list and confirmation controls', () => {
    const first = createPage();
    const actionList = createActionListDialog({
      document: first.document,
      title: 'Share to',
      actions: [
        { id: 'copy', label: 'Copy link' },
        { id: 'system', label: 'More options' },
      ],
    });
    assert.equal(actionList.elements.layer.dataset.pattern, 'action-list');
    assert.deepEqual(
      actionList.elements.footer.querySelectorAll('button').map((button) => button.textContent),
      ['Copy link', 'More options'],
    );

    const second = createPage();
    const confirmation = createConfirmationDialog({
      document: second.document,
      title: 'Leave group?',
      destructive: true,
      confirmLabel: 'Leave group',
    });
    const [cancel, confirm] = confirmation.elements.footer.querySelectorAll('button');
    assert.equal(confirmation.elements.layer.dataset.pattern, 'confirmation');
    assert.equal(cancel.dataset.dialogAction, 'cancel');
    assert.equal(confirm.dataset.dialogAction, 'confirm');
    assert.match(confirm.className, /is-danger/);
  });
});

describe('dialog responsive and page-isolation behavior', () => {
  test('uses a bottom sheet at the mobile breakpoint and a dialog above it', () => {
    assert.equal(resolveDialogPresentation('responsive', DIALOG_MOBILE_BREAKPOINT), 'sheet');
    assert.equal(resolveDialogPresentation('responsive', DIALOG_MOBILE_BREAKPOINT + 1), 'dialog');
    assert.equal(resolveDialogPresentation('sheet', 1200), 'sheet');
  });

  test('preserves prior inert, aria-hidden, body, and scroll state exactly', () => {
    const { document, page } = createPage();
    const preserved = document.createElement('aside');
    preserved.inert = true;
    preserved.setAttribute('inert', '');
    preserved.setAttribute('aria-hidden', 'false');
    const layer = document.createElement('div');
    document.body.style.position = 'relative';
    document.body.append(preserved, layer);

    const restore = isolateDialogPage(document, layer);
    assert.equal(page.inert, true);
    assert.equal(preserved.getAttribute('aria-hidden'), 'true');
    restore();
    restore();

    assert.equal(page.inert, false);
    assert.equal(page.getAttribute('aria-hidden'), null);
    assert.equal(preserved.inert, true);
    assert.equal(preserved.hasAttribute('inert'), true);
    assert.equal(preserved.getAttribute('aria-hidden'), 'false');
    assert.equal(document.body.style.position, 'relative');
    assert.deepEqual(document.scrollCalls, [[8, 144]]);
  });

  test('codifies dismissal policy for keyboard, backdrop, and async states', () => {
    assert.equal(canDismissDialog('escape'), true);
    assert.equal(canDismissDialog('backdrop'), true);
    assert.equal(canDismissDialog('escape', { closeOnEscape: false }), false);
    assert.equal(canDismissDialog('backdrop', { closeOnBackdrop: false }), false);
    assert.equal(canDismissDialog('close-button', { busy: true }), false);
    assert.equal(canDismissDialog('destroy', { busy: true }), true);
  });

  test('ships reduced-motion, safe-area, themed, and responsive styles to every page', () => {
    [
      '@media (prefers-reduced-motion: reduce)',
      '@media (max-width: 640px)',
      'env(safe-area-inset-bottom)',
      '100dvh',
      'var(--surface)',
      'var(--text)',
      'var(--accent)',
      ':focus-visible',
      '[data-presentation="sheet"]',
    ].forEach((contract) => assert.ok(dialogCss.includes(contract), `missing CSS contract: ${contract}`));

    pageNames.forEach((pageName) => {
      const html = readFileSync(new URL(`../../${pageName}`, import.meta.url), 'utf8');
      assert.equal(
        html.match(/src\/assets\/dialog\.css/g)?.length,
        1,
        `${pageName} must load the shared dialog styles exactly once`,
      );
    });
  });
});

describe('focus trap helper', () => {
  test('falls back to the panel if a dialog has no interactive descendants', () => {
    const document = new FakeDocument();
    const panel = document.createElement('section');
    const event = {
      key: 'Tab',
      prevented: false,
      preventDefault() { this.prevented = true; },
    };

    assert.equal(trapDialogFocus(event, panel, document), true);
    assert.equal(event.prevented, true);
    assert.equal(document.activeElement, panel);
  });
});
