// Focused DOM double for feedback's actual shared-dialog composition. Native
// browser/AT behavior remains a separate integration gate, not a claim here.
import { DIALOG_FOCUSABLE_SELECTOR } from './dialog.mjs';
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.nodeType = 1;
    this.children = []; this.parentElement = null; this.attributes = new Map(); this.dataset = {}; this.listeners = new Map();
    this.style = { position: '', top: '', left: '', right: '', width: '', overflow: '' };
    this.hidden = false; this.disabled = false; this.inert = false; this.textContent = ''; this.value = ''; this.checked = false;
    this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1;
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
  dispatch(type, event = {}) { return Promise.all((this.listeners.get(type) || []).map(fn => fn({ target: this, preventDefault() {}, ...event }))); }
  descendants() { return this.children.flatMap(node => [node, ...node.descendants()]); }
  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === '[data-dialog-initial-focus]') return Object.hasOwn(this.dataset, 'dialogInitialFocus');
    if (selector === DIALOG_FOCUSABLE_SELECTOR) return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(this.tagName) || this.hasAttribute('tabindex');
    return false;
  }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return node === this || this.descendants().includes(node); }
  closest(selector) {
    if (selector !== '[hidden], [inert]') return null;
    for (let node = this; node; node = node.parentElement) if (node.hidden || node.hasAttribute('inert')) return node;
    return null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  get isConnected() { return this.ownerDocument.body.contains(this); }
}
export function feedbackTestPage() {
  const document = {
    listeners: new Map(), documentElement: { scrollTop: 0 },
    defaultView: { scrollX: 0, scrollY: 0, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), requestAnimationFrame: fn => fn(), scrollTo() {} },
    createElement(tag) { return new Element(tag, this); },
    addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); },
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); },
    keydown(key, shiftKey = false) {
      const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
      for (const listener of this.listeners.get('keydown') || []) listener(event);
      return event;
    },
  };
  document.body = document.createElement('body'); document.activeElement = document.body;
  const page = document.createElement('main'); const trigger = document.createElement('button');
  page.append(trigger); document.body.append(page); trigger.focus();
  return { document, page, trigger,
    find: predicate => document.body.descendants().find(predicate),
    text: () => document.body.descendants().map(node => node.textContent).join('\n'),
  };
}
