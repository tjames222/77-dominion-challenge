import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { feedbackTestPage } from './feedback-test-dom.mjs';
import { createAppStreakDialog } from './app-streak-dialog.mjs';
import { normalizeChallengeStartDate } from './shared-header-state.mjs';
import { buildStreakSummary, streakIndicatorLabel } from './streak-summary.mjs';

const source = readFileSync(new URL('./shared-header-actions.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup({ load, update, timer } = {}) {
  const page = feedbackTestPage(); const { document } = page;
  const prototype = Object.getPrototypeOf(document.body);
  const originalMatches = prototype.matches;
  // Extend the existing focused DOM double only for this module's selectors.
  const decorate = node => {
    node.classList = { add() {}, remove() {} };
    node.insertBefore = function(child, before) { child.parentElement = this; const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, child); };
    node.matches = function(selector) {
      if (selector.startsWith('.')) return this.className?.split(' ').includes(selector.slice(1));
      const data = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
      if (data) { const key = data[1].replace(/-([a-z])/g, (_, x) => x.toUpperCase()); return Object.hasOwn(this.dataset, key) && (data[2] === undefined || this.dataset[key] === data[2]); }
      return originalMatches.call(this, selector);
    };
    return node;
  };
  const create = document.createElement.bind(document);
  document.createElement = tag => decorate(create(tag));
  const topbar = document.createElement('header'); document.body.append(topbar);
  const calls = { loads: 0, factories: 0, mutations: [], reads: 0, reloads: 0, confirmations: [] };
  let generation = 0; let confirmation = false;
  document.defaultView.confirm = message => { calls.confirmations.push(message); return confirmation; };
  document.defaultView.location = { reload() { calls.reloads++; } };
  document.defaultView.dispatchEvent = () => {};
  const activation = { readState: 'ready', contractValid: true, mode: 'solo', status: 'active', canParticipate: true,
    canEditStartDate: true, startDate: '2026-09-01', timeZone: 'America/Los_Angeles', revision: 4,
    currentInstance: { id: '11111111-1111-4111-8111-111111111111' } };
  const module = { createAppStreakDialog: options => { calls.factories++; return createAppStreakDialog(options); } };
  const runtime = {
    ...{ buildStreakSummary, streakIndicatorLabel, normalizeChallengeStartDate },
    dateKeyForTimeZone: () => '2026-09-28', isLocalDemoMode: () => false, initShareComposer() {},
    getChallengeActivation: async () => { calls.reads++; return activation; }, recordAppVisit: async () => {},
    getGameSummary: async () => ({ gameStats: { currentAppStreak: 6, bestAppStreak: 8 } }),
    updateChallengeStartDate: async input => { calls.mutations.push(input); return update ? update(input) : { ...activation, startDate: input.startDate, revision: 5 }; },
    __load: () => { calls.loads++; return load ? load(module) : Promise.resolve(module); },
    setTimeout: timer || setTimeout, clearTimeout, Date, Intl, Error, TypeError,
    console: { warn() {} },
  };
  const compiled = source.replace(/^import[\s\S]*?;\n/gm, '').replace('export function createAuthenticatedHeaderActions', 'function createAuthenticatedHeaderActions')
    .replace("import('./app-streak-dialog.mjs')", '__load()');
  const factory = runInNewContext(compiled + '\ncreateAuthenticatedHeaderActions', runtime);
  const controller = factory({ topbar, user: { userId: 'A', authenticated: true }, document,
    captureLifecycle: () => generation, isCurrentLifecycle: value => value === generation });
  const button = () => topbar.querySelector('.shared-header-streak');
  return { ...page, controller, calls, button, module, activation, nextGeneration() { generation++; },
    approveReload() { confirmation = true; }, field: () => page.find(node => node.name === 'challengeStartDate'),
    form: () => page.find(node => Object.hasOwn(node.dataset, 'globalStreakStartDateForm')) };
}

test('dialog code and DOM are absent until click; repeated opens share one module and restore trigger focus', async () => {
  const ui = setup(); await tick(); assert.equal(ui.calls.loads, 0); assert.equal(ui.calls.factories, 0);
  assert.equal(ui.find(node => node.getAttribute('role') === 'dialog'), undefined);
  await ui.button().dispatch('click'); await tick();
  assert.equal(ui.calls.loads, 1); assert.equal(ui.calls.factories, 1);
  ui.document.keydown('Escape'); assert.equal(ui.document.activeElement, ui.button());
  await ui.button().dispatch('click'); await tick(); assert.equal(ui.calls.factories, 1);
  assert.equal(ui.button().getAttribute('aria-expanded'), 'true'); ui.controller.destroy();
});
for (const cause of ['same-user-session', 'A-B-A', 'logout', 'pagehide']) {
  test(`a delayed import cannot mount after ${cause}`, async () => {
    const gate = deferred(); const ui = setup({ load: () => gate.promise }); await tick();
    await ui.button().dispatch('click'); await ui.button().dispatch('click');
    assert.equal(ui.calls.loads, 1); ui.nextGeneration();
    if (cause === 'A-B-A') { ui.controller.setUser({ userId: 'B' }); ui.nextGeneration(); ui.controller.setUser({ userId: 'A' }); }
    if (cause === 'logout') ui.controller.destroy();
    gate.resolve(ui.module); await tick(); assert.equal(ui.calls.factories, 0); assert.equal(ui.calls.mutations.length, 0);
    ui.controller.destroy();
  });
}
test('import failure remains clearly announced across header refresh and explicit cancelled reload never retries', async () => {
  const ui = setup({ load: async () => { throw new Error('PRIVATE IMPORT SENTINEL'); } }); await tick();
  await ui.button().dispatch('click'); await tick(); await ui.controller.refresh();
  assert.match(ui.button().getAttribute('aria-label'), /Reload.*Save/);
  assert.match(ui.button().querySelector('.shared-header-action-label').textContent, /Reload/);
  assert.doesNotMatch(ui.text(), /PRIVATE IMPORT SENTINEL/);
  await ui.button().dispatch('click'); assert.equal(ui.calls.reloads, 0); assert.equal(ui.calls.loads, 1);
  assert.match(ui.calls.confirmations[0], /Save any unfinished work/);
  ui.approveReload(); await ui.button().dispatch('click'); assert.equal(ui.calls.reloads, 1); assert.equal(ui.calls.loads, 1); ui.controller.destroy();
});
test('a timed-out import cannot publish a late module or start a mutation', async () => {
  const gate = deferred(); let timeout; const ui = setup({ load: () => gate.promise, timer: callback => { timeout = callback; return 0; } });
  await tick(); await ui.button().dispatch('click'); timeout(); await tick(); gate.resolve(ui.module); await tick();
  assert.equal(ui.calls.factories, 0); assert.equal(ui.calls.mutations.length, 0); assert.match(ui.button().getAttribute('aria-label'), /Reload/); ui.controller.destroy();
});
test('date save remains in eager owner, preserves actor/revision/timezone and cannot replay while pending', async () => {
  const gate = deferred(); const ui = setup({ update: () => gate.promise }); await tick();
  await ui.button().dispatch('click'); await tick(); ui.field().value = '2026-09-02';
  await ui.form().dispatch('submit'); await ui.form().dispatch('submit'); assert.equal(ui.calls.mutations.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.mutations[0])), { startDate: '2026-09-02', timeZone: 'America/Los_Angeles', expectedRevision: 4, expectedUserId: 'A', expectedInstanceId: ui.activation.currentInstance.id });
  gate.resolve({ ...ui.activation, startDate: '2026-09-02', revision: 5 }); await tick();
  assert.match(ui.text(), /Challenge start date saved/); ui.controller.destroy();
});
test('a start-date response cannot overwrite a different current run in the same account', async () => {
  const gate = deferred(); const ui = setup({ update: () => gate.promise }); await tick();
  await ui.button().dispatch('click'); await tick(); ui.field().value = '2026-09-02';
  await ui.form().dispatch('submit');
  const prior = { ...ui.activation, currentInstance: { ...ui.activation.currentInstance } };
  ui.activation.currentInstance = { id: '22222222-2222-4222-8222-222222222222' };
  ui.activation.startDate = '2026-09-29'; ui.activation.canEditStartDate = false;
  await ui.controller.refresh();
  gate.resolve({ ...prior, startDate: '2026-09-02', revision: 5 }); await tick();
  assert.doesNotMatch(ui.text(), /Challenge start date saved/);
  assert.equal(ui.activation.startDate, '2026-09-29'); ui.controller.destroy();
});
test('locked timeline remains disabled and cannot mutate even through a synthetic submit', async () => {
  const ui = setup(); ui.activation.canEditStartDate = false; await tick();
  await ui.button().dispatch('click'); await tick(); assert.equal(ui.field().disabled, true);
  ui.field().value = '2026-09-02'; await ui.form().dispatch('submit'); assert.equal(ui.calls.mutations.length, 0); ui.controller.destroy();
});
test('deferred factory has no API imports and existing menu lifecycle supplies the delayed-open fence', () => {
  const view = readFileSync(new URL('./app-streak-dialog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /from ['"].*(?:api|auth-runtime)|createClient|fetch\(|localStorage|sessionStorage/);
  const menu = readFileSync(new URL('./menu.js', import.meta.url), 'utf8');
  assert.match(menu, /captureLifecycle: \(\) => menuHydrationRequest/);
  assert.match(menu, /isCurrentLifecycle: generation => generation === menuHydrationRequest/);
  assert.match(menu, /subscribeToAuthStateChanges\([\s\S]*?menuHydrationRequest \+= 1/);
  assert.match(menu, /addEventListener\('pagehide'[\s\S]*?menuHydrationRequest \+= 1/);
});
