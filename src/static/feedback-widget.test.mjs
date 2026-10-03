import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./feedback-widget.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('./feedback-widget.css', import.meta.url), 'utf8');
const mountFeedbackWidget = new Function('createFeedbackDialog', 'createFeedbackContext',
  `${source.replace(/^import .*;\n/gmu, '').replace('export function', 'function')}\nreturn mountFeedbackWidget;`)(
  () => { throw new Error('Placement must never create a dialog.'); },
  () => { throw new Error('Placement must never capture feedback context.'); });

function eventTarget() {
  const listeners = new Map();
  return { listeners,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatch(type) { for (const callback of listeners.get(type) || []) callback({ type }); },
  };
}

function fixture({ visualViewport = true } = {}) {
  const writes = []; const frames = new Map(); let frameId = 0;
  const element = () => {
    const values = new Map(); const attributes = new Map();
    return { ...eventTarget(), dataset: {}, children: [], isConnected: false,
      style: { getPropertyValue: key => values.get(key) || '',
        setProperty(key, value) { values.set(key, value); writes.push([key, value]); } },
      setAttribute(key, value) { attributes.set(key, value); },
      getAttribute: key => attributes.get(key),
      toggleAttribute(key, enabled) { if (enabled) attributes.set(key, ''); else attributes.delete(key); },
      removeAttribute(key) { attributes.delete(key); },
      append(...children) { this.children.push(...children); for (const child of children) child.isConnected = true; },
      remove() { this.isConnected = false; },
    };
  };
  const viewport = visualViewport ? { ...eventTarget(), offsetLeft: 0, offsetTop: 0, width: 1440, height: 1000 } : undefined;
  const window = { ...eventTarget(), innerWidth: 1440, innerHeight: 1000, visualViewport: viewport,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const document = { ...eventTarget(), body: element(), documentElement: element(),
    createElement: element, createElementNS: element };
  let ownerChanged; let unsubscribed = 0; let current = true;
  const owner = Object.freeze({ userId: 'synthetic-owner' });
  const client = {
    bindOwner(value) { assert.equal(value, owner); return { isCurrent: value => current && value === owner }; },
    subscribe(callback) { ownerChanged = callback; return () => { unsubscribed += 1; }; },
  };
  const widget = mountFeedbackWidget({ client, owner, document, window });
  const button = document.body.children[0];
  return { window, viewport, document, widget, button, writes, frames,
    flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    loseOwner() { current = false; ownerChanged(); },
    get unsubscribed() { return unsubscribed; } };
}

test('fixed launcher initializes zero viewport insets without measuring page content', () => {
  const f = fixture();
  assert.equal(f.document.body.children.length, 1);
  assert.equal(f.button.className, 'feedback-widget');
  assert.equal(f.button.getAttribute('aria-label'), 'Send Feedback');
  assert.equal(f.button.hidden, false);
  assert.deepEqual(f.writes, [['--feedback-viewport-right', '0px'], ['--feedback-viewport-bottom', '0px']]);
  assert.equal(f.frames.size, 0);
  assert.equal(f.document.listeners.size, 0, 'no document scroll or motion listeners');
  assert.deepEqual([...f.window.listeners.keys()], ['resize']);
  assert.deepEqual([...f.viewport.listeners.keys()], ['resize', 'scroll']);
  f.widget.destroy();
});

test('ordinary scroll and unchanged viewport events never rewrite the anchor', () => {
  const f = fixture();
  for (let index = 0; index < 100; index += 1) {
    f.document.dispatch('scroll'); f.viewport.dispatch('scroll'); f.window.dispatch('resize');
    assert.equal(f.frames.size, 1, 'viewport events coalesce');
    f.flush();
  }
  assert.equal(f.writes.length, 2, 'unchanged insets cause zero additional writes');
  f.widget.destroy();
});

test('keyboard and zoom update only changed viewport insets in one frame', () => {
  const f = fixture();
  Object.assign(f.viewport, { offsetLeft: 120, width: 900, offsetTop: 80, height: 500 });
  f.viewport.dispatch('resize'); f.viewport.dispatch('scroll'); f.window.dispatch('resize');
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.button.style.getPropertyValue('--feedback-viewport-right'), '420px');
  assert.equal(f.button.style.getPropertyValue('--feedback-viewport-bottom'), '420px');
  f.viewport.height = 600; f.viewport.dispatch('resize'); f.flush();
  assert.deepEqual(f.writes.slice(4), [['--feedback-viewport-bottom', '320px']]);
  Object.assign(f.viewport, { offsetLeft: 0, width: 1440, offsetTop: 0, height: 1000 });
  f.viewport.dispatch('resize'); f.flush();
  assert.deepEqual(f.writes.slice(-2), [['--feedback-viewport-right', '0px'], ['--feedback-viewport-bottom', '0px']]);
  f.widget.destroy();
});

test('viewport overshoot clamps to zero and missing visualViewport keeps CSS fixed placement', () => {
  const f = fixture();
  Object.assign(f.viewport, { offsetLeft: 50, width: 1500, offsetTop: 20, height: 1100 });
  f.viewport.dispatch('resize'); f.flush();
  assert.equal(f.writes.length, 2);
  f.widget.destroy();
  const fallback = fixture({ visualViewport: false });
  fallback.window.innerWidth = 390; fallback.window.innerHeight = 844;
  fallback.window.dispatch('resize'); fallback.flush();
  assert.equal(fallback.writes.length, 2);
  fallback.widget.destroy();
});

test('owner teardown removes the original viewport listeners and cancels queued work', () => {
  const f = fixture();
  f.viewport.dispatch('resize');
  const retainedFrame = [...f.frames.values()][0];
  const retainedListener = [...f.viewport.listeners.get('scroll')][0];
  f.window.visualViewport = { ...eventTarget() };
  f.loseOwner();
  assert.equal(f.frames.size, 0);
  assert.equal(f.button.isConnected, false);
  assert.equal(f.widget.isCurrent(), false);
  assert.equal(f.document.body.getAttribute('data-feedback-mounted'), undefined);
  for (const callbacks of [...f.window.listeners.values(), ...f.viewport.listeners.values()]) assert.equal(callbacks.size, 0);
  retainedListener(); retainedFrame(); f.viewport.dispatch('scroll'); f.window.dispatch('resize');
  assert.equal(f.frames.size, 0);
  assert.equal(f.writes.length, 2);
  f.widget.destroy();
  assert.equal(f.unsubscribed, 1);
});

test('eligibility still controls launcher visibility without changing its position', () => {
  const f = fixture();
  f.widget.setEligible(false);
  assert.equal(f.button.hidden, true);
  assert.equal(f.document.body.getAttribute('data-feedback-mounted'), undefined);
  f.widget.setEligible(true);
  assert.equal(f.button.hidden, false);
  assert.equal(f.document.body.getAttribute('data-feedback-mounted'), '');
  assert.equal(f.writes.length, 2);
  assert.equal(f.frames.size, 0);
  f.widget.destroy();
});

test('launcher is fixed in the foreground with safe areas, no collision engine or positional animation', () => {
  assert.match(source, /ownerDocument\.body\.append\(button\)/u);
  assert.doesNotMatch(source, /feedbackLift|obstruction|elementsFromPoint|getBoundingClientRect|getClientRects|ResizeObserver|MutationObserver|transitionend|animationend|feedback-header-slot/iu);
  assert.match(css, /\.feedback-widget\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*1180;/u);
  assert.match(css, /--feedback-safe-right:\s*env\(safe-area-inset-right,\s*0px\)/u);
  assert.match(css, /--feedback-safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/u);
  assert.match(css, /right:[^;]*--feedback-safe-right[^;]*--feedback-viewport-right/u);
  assert.match(css, /bottom:[^;]*--feedback-safe-bottom[^;]*--feedback-viewport-bottom/u);
  assert.match(css, /min-width:\s*44px;[\s\S]*?min-height:\s*44px;/u);
  assert.match(css, /transition-property:\s*none;/u);
  assert.doesNotMatch(css, /feedback-lift|data-obstructed|translate|transform:|body\.challenge-finished/iu);
  assert.match(css, /\.app-dialog-layer\[data-pattern="feedback"\]\s*\{\s*z-index:\s*1185;/u);
});

test('foreground launcher still yields to every interaction-owning overlay', () => {
  for (const selector of ['[hidden]', 'menu-open', 'data-dialog-open', 'dialog:modal', 'permanent-reward-celebration',
    'reward-backdrop.active', 'reward-toast.active', 'badge-celebration.active', 'crew-training-layer', 'site-training-layer']) {
    assert.ok(css.includes(selector), `missing overlay guard: ${selector}`);
  }
  assert.match(css, /visibility:\s*hidden;\s*pointer-events:\s*none;/u);
});
