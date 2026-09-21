import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createFeedbackDialog } from './feedback-dialog.mjs';
import { createDialog } from './dialog.mjs';
import { feedbackTestPage } from './feedback-test-dom.mjs';
const actorId = '11111111-1111-4111-8111-111111111111';
const owner = { actorId, sessionIdentity: `${actorId}:22222222-2222-4222-8222-222222222222` };
const context = { route: 'private-journal.html', theme: 'dominion-platinum', viewport: { width: 390, height: 844 }, buildSha: 'a'.repeat(40), browser: 'safari', platform: 'ios' };
const saved = intent => ({ schemaVersion: 1, status: 'saved', actorId, operationId: intent.operationId, feedbackId: '33333333-3333-4333-8333-333333333333' });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(options = {}) {
  const page = feedbackTestPage(); const calls = []; let current = true;
  const controller = createFeedbackDialog({ document: page.document, owner, context,
    isCurrent: candidate => current && candidate.actorId === owner.actorId && candidate.sessionIdentity === owner.sessionIdentity,
    submit: async (intent, request) => { calls.push({ intent, request }); return saved(intent); }, ...options });
  const field = name => page.find(node => node.name === name);
  const form = page.find(node => node.tagName === 'FORM');
  const button = text => page.find(node => node.tagName === 'BUTTON' && node.textContent === text);
  const fill = () => { field('type').value = 'bug'; field('description').value = '  Original private feedback\n'; field('expectedBehavior').value = '\nExpected\n'; field('impact').value = 'minor'; field('contactAllowed').checked = true; };
  return { ...page, controller, field, form, button, fill, calls, changeOwner() { current = false; } };
}

test('unmounted dialog does not submit; native labels, focus trap, Escape and cancellation use existing dialog', async () => {
  const ui = setup(); assert.equal(ui.calls.length, 0);
  assert.equal(ui.controller.open(ui.trigger), true);
  assert.equal(ui.document.activeElement, ui.field('type'));
  const panel = ui.find(node => node.getAttribute('role') === 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true'); assert.ok(panel.getAttribute('aria-labelledby'));
  for (const name of ['type', 'description', 'expectedBehavior', 'impact', 'contactAllowed']) assert.equal(ui.field(name).parentElement.tagName, 'LABEL');
  const last = ui.button('Send feedback'); last.focus();
  assert.equal(ui.document.keydown('Tab').prevented, true);
  assert.equal(ui.document.activeElement.getAttribute('aria-label'), 'Close dialog');
  assert.equal(ui.document.keydown('Tab', true).prevented, true); assert.equal(ui.document.activeElement, last);
  ui.fill(); ui.document.keydown('Escape'); assert.equal(ui.document.activeElement, ui.trigger);
  assert.equal(ui.field('description').value, ''); assert.equal(ui.calls.length, 0);
  ui.controller.open(ui.trigger); ui.fill(); await ui.button('Cancel').dispatch('click');
  assert.equal(ui.field('description').value, ''); assert.equal(ui.calls.length, 0); ui.controller.destroy();
});

test('invalid input preserves draft, focuses the failing field and never calls submit', async () => {
  const ui = setup(); ui.controller.open(ui.trigger); ui.fill(); ui.field('description').value = ' \n ';
  await ui.form.dispatch('submit'); assert.equal(ui.calls.length, 0);
  assert.equal(ui.field('description').value, ' \n '); assert.equal(ui.document.activeElement, ui.field('description'));
  assert.equal(ui.field('description').getAttribute('aria-invalid'), 'true'); ui.controller.destroy();
});

test('pending submission cannot double-submit, dismiss or clear text before exact durable receipt', async () => {
  const waiting = deferred(); const calls = []; const ui = setup({ submit: (intent, options) => { calls.push({ intent, options }); return waiting.promise; } });
  ui.controller.open(ui.trigger); ui.fill(); const first = ui.form.dispatch('submit'); await ui.form.dispatch('submit');
  assert.equal(calls.length, 1); assert.equal(ui.field('description').value, '  Original private feedback\n');
  assert.equal(ui.field('description').disabled, true); assert.equal(ui.button('Cancel').disabled, true);
  ui.document.keydown('Escape'); assert.ok(ui.find(node => node.dataset.open === ''));
  waiting.resolve(saved(calls[0].intent)); await first;
  assert.equal(ui.field('description').value, ''); assert.match(ui.text(), /feedback is saved/);
  assert.equal(ui.document.activeElement, ui.button('Close')); ui.controller.destroy();
});

test('uncertain retry preserves same immutable intent and ignores raw provider errors or edited disabled DOM', async () => {
  const calls = []; const ui = setup({ submit: async intent => { calls.push(intent); if (calls.length === 1) throw new Error('secret-provider-token'); return saved(intent); } });
  ui.controller.open(ui.trigger); ui.fill(); await ui.form.dispatch('submit');
  assert.doesNotMatch(ui.text(), /secret-provider-token/); assert.match(ui.text(), /could not confirm/);
  assert.equal(ui.field('description').value, '  Original private feedback\n');
  ui.document.keydown('Escape'); assert.equal(ui.find(node => node.dataset.open === ''), undefined);
  assert.equal(ui.document.activeElement, ui.trigger); assert.equal(ui.field('description').value, '  Original private feedback\n');
  ui.controller.open(ui.trigger); assert.ok(ui.button('Retry same submission'));
  ui.field('description').value = 'tampered disabled field'; await ui.form.dispatch('submit');
  assert.equal(calls[0], calls[1]); assert.equal(calls[1].input.description, '  Original private feedback\n');
  assert.match(ui.text(), /feedback is saved/); ui.controller.destroy();
});

test('malformed or wrong-owner persisted responses stay uncertain instead of claiming success', async () => {
  for (const patch of [{ status: 'queued' }, { actorId: '44444444-4444-4444-8444-444444444444' }, { operationId: 'bad' }, { provider: 'sent' }]) {
    const ui = setup({ submit: async intent => ({ ...saved(intent), ...patch }) }); ui.controller.open(ui.trigger); ui.fill(); await ui.form.dispatch('submit');
    assert.ok(ui.button('Retry same submission')); assert.equal(ui.field('description').value, '  Original private feedback\n');
    assert.equal(ui.find(node => node.className === 'feedback-status').textContent, ''); ui.controller.destroy();
  }
});

test('owner loss and explicit teardown abort and scrub; ignored abort responses cannot publish or restore stale trigger focus', async () => {
  for (const explicit of [false, true]) {
    const waiting = deferred(); let captured; let signal; let notices = 0;
    const ui = setup({ submit: (intent, options) => { captured = intent; signal = options.signal; return waiting.promise; }, onSaved: () => notices++ });
    ui.controller.open(ui.trigger); ui.fill(); const pending = ui.form.dispatch('submit');
    ui.changeOwner(); if (explicit) ui.controller.destroy(); waiting.resolve(saved(captured)); await pending;
    assert.equal(signal.aborted, true); assert.equal(ui.field('description'), undefined); assert.equal(notices, 0);
    assert.notEqual(ui.document.activeElement, ui.trigger); assert.equal(ui.controller.open(ui.trigger), false);
  }
});

test('shared-dialog replacement scrubs and retires feedback even while its transport ignores abort', async () => {
  const waiting = deferred(); let intent; let signal;
  const ui = setup({ submit: (value, options) => { intent = value; signal = options.signal; return waiting.promise; } });
  ui.controller.open(ui.trigger); ui.fill(); const pending = ui.form.dispatch('submit');
  const other = createDialog({ document: ui.document, title: 'Other dialog' }); other.open();
  assert.equal(signal.aborted, true); assert.equal(ui.field('description'), undefined);
  waiting.resolve(saved(intent)); await pending; assert.equal(ui.controller.open(ui.trigger), false); other.destroy();
});

test('saved callback failure does not reclassify receipt; a later new submission gets a new operation', async () => {
  const ui = setup({ onSaved: () => { throw new Error('presentation failed'); } });
  ui.controller.open(ui.trigger); ui.fill(); await ui.form.dispatch('submit'); assert.match(ui.text(), /Your feedback is saved/);
  await ui.button('Close').dispatch('click'); ui.controller.open(ui.trigger); ui.fill(); await ui.form.dispatch('submit');
  assert.equal(ui.calls.length, 2); assert.notEqual(ui.calls[0].intent.operationId, ui.calls[1].intent.operationId); ui.controller.destroy();
});

test('bounded deadline abort retains draft and same intent, permits closing, and fences the late result', async () => {
  const held = deferred(); const calls = []; let signal; let notices = 0;
  const ui = setup({ requestTimeoutMs: 5, submit: (intent, options) => {
    calls.push(intent); signal = options.signal; return calls.length === 1 ? held.promise : Promise.resolve(saved(intent));
  }, onSaved: () => notices++ });
  ui.controller.open(ui.trigger); ui.fill(); await ui.form.dispatch('submit');
  assert.equal(signal.aborted, true); assert.equal(ui.field('description').value, '  Original private feedback\n');
  assert.ok(ui.button('Close for now')); await ui.button('Close for now').dispatch('click');
  held.resolve(saved(calls[0])); await Promise.resolve(); assert.equal(notices, 0);
  assert.equal(ui.field('description').value, '  Original private feedback\n');
  ui.controller.open(ui.trigger); await ui.form.dispatch('submit');
  assert.equal(calls[0], calls[1]); assert.equal(notices, 1); ui.controller.destroy();
});

test('deadline configuration stays bounded and a throwing or changed owner never dispatches', async () => {
  for (const requestTimeoutMs of [0, -1, NaN, Infinity, 60001, '100']) assert.throws(() => setup({ requestTimeoutMs }));
  const throwing = setup({ isCurrent: () => { throw new Error('Owner unavailable'); } });
  assert.equal(throwing.controller.open(throwing.trigger), false); assert.equal(throwing.calls.length, 0);
  const ui = setup(); ui.controller.open(ui.trigger); ui.fill(); ui.changeOwner();
  await ui.form.dispatch('submit'); assert.equal(ui.calls.length, 0); assert.equal(ui.field('description'), undefined);
});

test('the leaf does not collect private ambient data, perform network/Auth calls or add broad CSS', () => {
  const source = readFileSync(new URL('./feedback-dialog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|fetch\(|supabase|navigator\.|location\.|document\.(?:querySelector|forms)/);
  const css = readFileSync(new URL('./feedback-dialog.css', import.meta.url), 'utf8');
  assert.match(css, /\.feedback-actions\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
  const shared = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');
  for (const token of [...css.matchAll(/var\((--[a-z-]+)\)/g)].map(match => match[1])) assert.ok(shared.includes(`${token}:`), `shared theme token ${token}`);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /@import|url\(|\bbody\b/);
  for (const selector of rules.split('}').map(rule => rule.split('{')[0].trim()).filter(Boolean)) {
    assert.ok(selector.startsWith('.app-dialog-layer[data-pattern="feedback"]'), selector);
  }
});
