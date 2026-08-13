import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SOLO_TRAINING_LAUNCH_STORAGE_KEY,
  createSoloTrainingLaunch,
  persistSoloTrainingLaunch,
} from './challenge-start-flow.mjs';
import {
  allowlistedSoloTrainingRoute,
  compareAndClearSoloTrainingControlRequest,
  createSoloFirstRunTraining,
  isVerifiedSoloTrainingActivation,
  persistSoloTrainingControlRequest,
  readSoloTrainingControlRequest,
  soloFirstRunCapabilities,
  soloTrainingControlModel,
} from './solo-first-run-training.mjs';

const USER = Object.freeze({ authenticated: true, userId: 'actor-1' });
const ACTIVE_SOLO = Object.freeze({
  readState: 'ready',
  contractValid: true,
  mode: 'solo',
  status: 'active',
  startDate: '2026-02-14',
  revision: 3,
  canParticipate: true,
  canMutateDailyStandards: true,
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function browser({ pathname = '/dashboard.html' } = {}) {
  const assigned = [];
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const location = {
    pathname,
    href: `https://dominion.test${pathname}`,
    origin: 'https://dominion.test',
    assign(value) { assigned.push(new URL(value).pathname); },
  };
  return {
    assigned,
    window: {
      location,
      localStorage,
      sessionStorage,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    },
  };
}

function trainingState({
  overallStatus = 'not_started',
  pageStatus = 'not_started',
  currentPageId = 'dashboard',
  currentPageIndex = 0,
} = {}) {
  const contentVersion = ['dashboard', 'community', 'profile'].includes(currentPageId) ? 3 : 2;
  return {
    contractValid: true,
    actorId: USER.userId,
    page: {
      pageId: currentPageId,
      contentVersion,
      status: pageStatus,
    },
    overall: {
      programId: 'solo-first-run',
      programVersion: 3,
      status: overallStatus,
      currentPageId,
      currentPageContentVersion: contentVersion,
      currentPageIndex,
      revision: overallStatus === 'not_started' ? 0 : 1,
    },
    transition: null,
  };
}

function fakeRuntimeFactory(initialState) {
  const calls = { hydrate: 0, start: [], resume: [], open: [], advance: 0, destroy: 0 };
  let callbacks;
  let state = structuredClone(initialState);
  const factory = (options) => {
    callbacks = options;
    const runtime = {
      get state() { return state; },
      async hydrate() { calls.hydrate += 1; return { state }; },
      async start(input) {
        calls.start.push(input);
        state = {
          ...state,
          page: { ...state.page, status: state.page.status === 'completed' ? 'completed' : 'in_progress' },
          overall: { ...state.overall, status: 'in_progress', revision: state.overall.revision + 1 },
          transition: { action: 'start', scope: 'overall', applied: true, nextRoute: null },
        };
        await callbacks.onTransition({
          actorId: USER.userId,
          state,
          transition: state.transition,
          scope: 'overall',
        });
        await callbacks.onStateChange({ state });
        return state;
      },
      async resume(input) {
        calls.resume.push(input);
        state = {
          ...state,
          page: { ...state.page, status: state.page.status === 'completed' ? 'completed' : 'in_progress' },
          overall: { ...state.overall, status: 'in_progress', revision: state.overall.revision + 1 },
          transition: { action: 'resume', scope: 'overall', applied: true, nextRoute: null },
        };
        await callbacks.onTransition({ actorId: USER.userId, state, transition: state.transition });
        return state;
      },
      open(input) { calls.open.push(input); return { state }; },
      async advanceCompletedPage() { calls.advance += 1; return state; },
      destroy() { calls.destroy += 1; },
    };
    return runtime;
  };
  return {
    calls,
    factory,
    get callbacks() { return callbacks; },
    get state() { return state; },
  };
}

function fakeControl() {
  const attributes = new Map();
  return Object.assign(new EventTarget(), {
    hidden: true,
    disabled: false,
    textContent: '',
    title: '',
    dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); if (name === 'title') this.title = ''; },
  });
}

describe('Solo first-run contracts', () => {
  test('accepts scheduled and active Solo only and blocks unlisted navigation', async () => {
    const registry = await import('./site-training-registry.mjs');
    const program = registry.SITE_TRAINING_REGISTRY.programs[0];
    assert.equal(isVerifiedSoloTrainingActivation(ACTIVE_SOLO), true);
    assert.equal(isVerifiedSoloTrainingActivation({ ...ACTIVE_SOLO, status: 'scheduled' }), true);
    assert.equal(isVerifiedSoloTrainingActivation({ ...ACTIVE_SOLO, mode: 'group' }), false);
    assert.equal(allowlistedSoloTrainingRoute(program, '/profile.html'), '/profile.html');
    assert.equal(allowlistedSoloTrainingRoute(program, '/login.html'), null);
    assert.equal(allowlistedSoloTrainingRoute(program, 'https://evil.test/profile.html'), null);
  });

  test('stores actor-bound one-shot route requests and compare-clears only the exact value', () => {
    const storage = memoryStorage();
    const request = persistSoloTrainingControlRequest(storage, {
      actorId: USER.userId,
      action: 'resume',
      route: '/profile.html',
      requestedAt: '2026-02-14T18:00:00.000Z',
    });
    assert.deepEqual(readSoloTrainingControlRequest(storage, USER.userId), request);
    assert.equal(compareAndClearSoloTrainingControlRequest(storage, {
      ...request,
      route: '/science.html',
    }), false);
    assert.equal(compareAndClearSoloTrainingControlRequest(storage, request), true);
    assert.equal(readSoloTrainingControlRequest(storage, USER.userId), null);
  });

  test('derives only privacy-safe capability booleans', () => {
    const elements = new Map([
      ['[data-training-target="global-share"], [data-training-target="rewards-sharing"]', { disabled: false }],
      ['#appearance', {}],
    ]);
    const document = {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: () => [],
    };
    const capabilities = soloFirstRunCapabilities({
      activation: ACTIVE_SOLO,
      document,
      window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    });
    assert.equal(capabilities['can-share-progress'], true);
    assert.equal(capabilities['daily-standards-open'], true);
    assert.equal(capabilities['themes-available'], true);
    assert.deepEqual(Object.values(capabilities).every((value) => typeof value === 'boolean'), true);
    assert.equal(JSON.stringify(capabilities).includes('actor-1'), false);
  });

  test('exposes Start, Resume, and Continue without blocking completed training', () => {
    assert.deepEqual(soloTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: trainingState(),
    }), { visible: true, label: 'Start Training', action: 'start' });
    assert.equal(soloTrainingControlModel({
      activation: { ...ACTIVE_SOLO, status: 'scheduled' },
      state: trainingState({ overallStatus: 'stopped', pageStatus: 'stopped' }),
    }).label, 'Resume Training');
    assert.equal(soloTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: trainingState({ overallStatus: 'in_progress', pageStatus: 'in_progress' }),
    }).label, 'Continue Training');
    assert.equal(soloTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: trainingState({ overallStatus: 'completed', pageStatus: 'completed' }),
    }).visible, false);
  });
});

describe('Solo first-run orchestration', () => {
  test('consumes the exact FOU-1440 handoff once after a confirmed actor-bound claim', async () => {
    const env = browser();
    const launch = createSoloTrainingLaunch({
      actorId: USER.userId,
      activation: ACTIVE_SOLO,
      requestedAt: '2026-02-14T18:00:00.000Z',
    });
    persistSoloTrainingLaunch(env.window.localStorage, launch);
    const runtime = fakeRuntimeFactory(trainingState());
    const apiCalls = [];
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: {
        async getChallengeActivation(input) { apiCalls.push(input); return ACTIVE_SOLO; },
      },
      runtimeFactory: runtime.factory,
    });

    await controller.refresh({ autoOpen: false });
    assert.equal(runtime.calls.start.length, 1);
    assert.equal(runtime.calls.start[0].scope, 'overall');
    assert.deepEqual(apiCalls, [
      { expectedUserId: USER.userId },
      { expectedUserId: USER.userId },
    ]);
    assert.equal(env.window.localStorage.getItem(SOLO_TRAINING_LAUNCH_STORAGE_KEY), null);

    await controller.refresh({ autoOpen: false });
    assert.equal(runtime.calls.start.length, 1);
    assert.equal(apiCalls.length, 3);
    controller.destroy();
  });

  test('keeps missing-handoff Solo progress untouched until Start Training is chosen', async () => {
    const env = browser();
    const runtime = fakeRuntimeFactory(trainingState());
    const control = fakeControl();
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtimeFactory: runtime.factory,
    });
    controller.attachControl(control);
    await controller.refresh({ autoOpen: false });
    assert.equal(runtime.calls.start.length, 0);
    assert.equal(control.hidden, false);
    assert.equal(control.textContent, 'Start Training');
    await controller.activate({ trigger: control });
    assert.equal(runtime.calls.start.length, 1);
  });

  test('lets scheduled users resume after Stop for now', async () => {
    const env = browser();
    const runtime = fakeRuntimeFactory(trainingState({
      overallStatus: 'stopped',
      pageStatus: 'stopped',
    }));
    const control = fakeControl();
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: { getChallengeActivation: async () => ({ ...ACTIVE_SOLO, status: 'scheduled' }) },
      runtimeFactory: runtime.factory,
    });
    controller.attachControl(control);
    await controller.refresh({ autoOpen: false });
    assert.equal(control.textContent, 'Resume Training');
    await controller.activate({ trigger: control });
    assert.equal(runtime.calls.resume.length, 1);
    assert.equal(runtime.calls.open.length, 0);
  });

  test('rejects a stale cached activation before Resume can open training', async () => {
    const env = browser();
    const runtime = fakeRuntimeFactory(trainingState({
      overallStatus: 'stopped',
      pageStatus: 'stopped',
    }));
    const control = fakeControl();
    const activations = [ACTIVE_SOLO, { ...ACTIVE_SOLO, mode: 'group' }];
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: { getChallengeActivation: async () => activations.shift() },
      runtimeFactory: runtime.factory,
    });
    controller.attachControl(control);
    await controller.refresh({ autoOpen: false });
    assert.equal(control.textContent, 'Resume Training');
    await assert.rejects(
      controller.activate({ trigger: control }),
      /verified scheduled or active Solo challenge/,
    );
    assert.equal(runtime.calls.resume.length, 0);
    assert.equal(runtime.calls.open.length, 0);
    assert.equal(runtime.calls.destroy, 1);
    assert.equal(control.hidden, true);
    controller.destroy();
  });

  test('automatic continuation restores focus to a visible control outside the closed drawer', async () => {
    const env = browser();
    const runtime = fakeRuntimeFactory(trainingState({
      overallStatus: 'in_progress',
      pageStatus: 'in_progress',
    }));
    const hiddenDrawerControl = Object.assign(fakeControl(), {
      focus() {},
      isConnected: true,
      closest(selector) {
        return selector.includes('[inert]') ? { inert: true } : null;
      },
    });
    const visibleMenuButton = {
      hidden: false,
      isConnected: true,
      focus() {},
      closest() { return null; },
    };
    const document = {
      activeElement: { nodeName: 'BODY' },
      body: null,
      documentElement: null,
      querySelector(selector) {
        return selector === '.global-menu-button' ? visibleMenuButton : null;
      },
      querySelectorAll: () => [],
    };
    document.body = document.activeElement;
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document,
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtimeFactory: runtime.factory,
    });
    controller.attachControl(hiddenDrawerControl);
    await controller.refresh();
    assert.equal(runtime.calls.open.length, 1);
    assert.equal(runtime.calls.open[0].trigger, visibleMenuButton);
    controller.destroy();
  });

  test('continues the final Science page as part of the signed-in training route set', async () => {
    const env = browser({ pathname: '/science.html' });
    const runtime = fakeRuntimeFactory(trainingState({
      overallStatus: 'in_progress',
      pageStatus: 'in_progress',
      currentPageId: 'science',
      currentPageIndex: 13,
    }));
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtimeFactory: runtime.factory,
    });

    assert.equal(controller.available, true);
    await controller.refresh();
    assert.equal(runtime.calls.open.length, 1);
    await runtime.callbacks.onTransition({
      actorId: USER.userId,
      state: trainingState({
        overallStatus: 'completed',
        pageStatus: 'completed',
        currentPageId: 'science',
        currentPageIndex: 13,
      }),
      transition: { action: 'finish', applied: true, nextRoute: null },
    });
    assert.deepEqual(env.assigned, []);
    controller.destroy();
  });

  test('navigates only to immutable program routes and carries a one-shot actor request', async () => {
    const env = browser();
    const runtime = fakeRuntimeFactory(trainingState({
      overallStatus: 'in_progress',
      pageStatus: 'completed',
      currentPageId: 'profile',
      currentPageIndex: 11,
    }));
    const navigations = [];
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtimeFactory: runtime.factory,
      navigate: (route) => navigations.push(route),
    });
    await controller.refresh({ autoOpen: false });
    await controller.activate();
    assert.deepEqual(navigations, ['/profile.html']);
    assert.deepEqual(readSoloTrainingControlRequest(env.window.sessionStorage, USER.userId), {
      schemaVersion: 1,
      actorId: USER.userId,
      action: 'continue',
      route: '/profile.html',
      requestedAt: readSoloTrainingControlRequest(env.window.sessionStorage, USER.userId).requestedAt,
    });

    await runtime.callbacks.onTransition({
      state: { actorId: USER.userId },
      transition: { action: 'finish', applied: true, nextRoute: '/login.html' },
    });
    assert.deepEqual(navigations, ['/profile.html']);
    await runtime.callbacks.onTransition({
      state: { actorId: USER.userId },
      transition: { action: 'finish', applied: true, nextRoute: '/bible-reading.html' },
    });
    assert.deepEqual(navigations, ['/profile.html', '/bible-reading.html']);
  });

  test('destroying on account swap invalidates a stale activation read before runtime creation', async () => {
    const env = browser();
    let resolveActivation;
    const runtime = fakeRuntimeFactory(trainingState());
    const controller = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      api: {
        getChallengeActivation: () => new Promise((resolve) => { resolveActivation = resolve; }),
      },
      runtimeFactory: runtime.factory,
    });
    const refresh = controller.refresh();
    await Promise.resolve();
    controller.destroy();
    resolveActivation(ACTIVE_SOLO);
    assert.equal(await refresh, null);
    assert.equal(runtime.calls.hydrate, 0);
    assert.equal(runtime.calls.start.length, 0);
  });
});
