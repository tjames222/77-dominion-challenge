import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShareComposerLoader } from './share-composer-loader.mjs';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(load) {
  let handler;
  const attributes = new Map();
  const trigger = { disabled: false, isConnected: true, clicks: 0,
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key) ?? null,
    removeAttribute: (key) => attributes.delete(key),
    click: () => { trigger.clicks += 1; } };
  const status = { setAttribute() {}, textContent: '' };
  const document = { querySelectorAll: () => [trigger], createElement: () => status,
    body: { append() {} }, addEventListener: (type, listener, capture) => {
      assert.equal(type, 'click'); assert.equal(capture, true); handler = listener;
    } };
  const loader = createShareComposerLoader(load);
  loader.initShareComposer(document);
  const click = () => handler({ target: { closest: () => trigger }, preventDefault() {}, stopPropagation() {} });
  return { loader, document, trigger, status, click };
}

test('share module is not requested until interaction and repeated clicks coalesce', async () => {
  const pending = deferred(); let loads = 0; let initialized = 0;
  const state = fixture(() => { loads += 1; return pending.promise; });
  assert.equal(loads, 0);
  assert.equal(state.trigger.getAttribute('aria-haspopup'), 'dialog');
  const first = state.click();
  const latest = state.click();
  await Promise.resolve();
  assert.equal(loads, 1);
  assert.equal(state.trigger.getAttribute('aria-busy'), 'true');
  pending.resolve({ initShareComposer: () => { initialized += 1; } });
  await Promise.all([first, latest]);
  assert.equal(initialized, 1);
  assert.equal(state.trigger.clicks, 1);
  assert.equal(state.trigger.getAttribute('aria-busy'), null);
  assert.equal(state.status.textContent, '');
});

test('account reset synchronously cancels pending opening without requesting an unloaded module', async () => {
  const pending = deferred(); let loads = 0; let resets = 0;
  const state = fixture(() => { loads += 1; return pending.promise; });
  state.loader.closeShareComposer();
  assert.equal(loads, 0);
  const click = state.click();
  state.loader.closeShareComposer('auth-change');
  assert.equal(state.trigger.getAttribute('aria-busy'), null);
  pending.resolve({ initShareComposer() {}, closeShareComposer: () => { resets += 1; } });
  await click;
  assert.equal(state.trigger.clicks, 0);
  state.loader.closeShareComposer();
  assert.equal(resets, 1);
});

test('failed chunks announce a retry and do not leave the control busy', async () => {
  let loads = 0;
  const state = fixture(() => {
    loads += 1;
    if (loads === 1) throw new Error('offline');
    return { initShareComposer() {} };
  });
  await state.click();
  assert.match(state.status.textContent, /could not load/);
  assert.equal(state.trigger.getAttribute('aria-busy'), null);
  assert.equal(state.trigger.clicks, 0);
  await state.click();
  assert.equal(loads, 2);
  assert.equal(state.trigger.clicks, 1);
});

test('disconnected or disabled controls never reopen after delayed imports', async () => {
  for (const change of [(trigger) => { trigger.isConnected = false; },
    (trigger) => { trigger.disabled = true; }, (trigger) => trigger.setAttribute('aria-disabled', 'true')]) {
    const pending = deferred();
    const state = fixture(() => pending.promise);
    const click = state.click();
    change(state.trigger);
    pending.resolve({ initShareComposer() {} });
    await click;
    assert.equal(state.trigger.clicks, 0);
    assert.equal(state.trigger.getAttribute('aria-busy'), null);
  }
});
