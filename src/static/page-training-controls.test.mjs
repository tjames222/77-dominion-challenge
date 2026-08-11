import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createPageTrainingControls,
  isVerifiedPageTrainingActivation,
  pageTrainingControlModel,
} from './page-training-controls.mjs';
import { SITE_TRAINING_REGISTRY } from './site-training-registry.mjs';
import { createSoloFirstRunTraining } from './solo-first-run-training.mjs';

const USER = Object.freeze({ authenticated: true, userId: 'actor-1' });
const ACTIVE_SOLO = Object.freeze({
  readState: 'ready',
  contractValid: true,
  mode: 'solo',
  status: 'active',
  canParticipate: true,
});
const ACTIVE_GROUP = Object.freeze({
  ...ACTIVE_SOLO,
  mode: 'group',
});

function state(status = 'not_started', {
  overall = null,
  page = SITE_TRAINING_REGISTRY.pages[0],
} = {}) {
  return {
    readState: 'ready',
    contractValid: true,
    actorId: USER.userId,
    page: {
      pageId: page.id,
      contentVersion: page.contentVersion,
      status,
      currentStepId: status === 'not_started' ? null : 'orientation',
      currentStepIndex: 0,
      furthestStepIndex: 0,
      attemptNumber: status === 'not_started' ? 0 : 1,
      revision: status === 'not_started' ? 0 : 1,
    },
    overall,
    transition: null,
  };
}

function fakeRuntime(initialState = state(), {
  actorId = USER.userId,
  page = SITE_TRAINING_REGISTRY.pages[0],
} = {}) {
  let current = structuredClone(initialState);
  let nextHydration = null;
  const stateListeners = new Set();
  const transitionListeners = new Set();
  const calls = {
    destroy: 0,
    dismiss: 0,
    hydrate: 0,
    open: [],
    replay: [],
    restart: [],
    resume: [],
    start: [],
  };
  const notify = () => stateListeners.forEach((listener) => listener(runtime.snapshot));
  const transition = async (action, scope) => {
    current = {
      ...current,
      transition: { action, applied: true, scope, nextRoute: null },
    };
    notify();
    const payload = {
      actorId,
      state: current,
      transition: current.transition,
      scope,
    };
    await Promise.all([...transitionListeners].map((listener) => listener(payload)));
  };
  const runtime = {
    calls,
    page,
    get snapshot() {
      return { actorId, state: current, busy: false, destroyed: false };
    },
    get state() { return current; },
    setState(next) { current = structuredClone(next); notify(); },
    queueHydration(next) { nextHydration = structuredClone(next); },
    async hydrate() {
      calls.hydrate += 1;
      if (nextHydration) {
        current = nextHydration;
        nextHydration = null;
      }
      notify();
      return runtime.snapshot;
    },
    async start(input) {
      calls.start.push(input);
      current = {
        ...current,
        page: { ...current.page, status: 'in_progress' },
        overall: input.scope === 'overall'
          ? { ...current.overall, status: 'in_progress', revision: current.overall.revision + 1 }
          : current.overall,
      };
      await transition('start', input.scope);
      return current;
    },
    async resume(input) {
      calls.resume.push(input);
      current = {
        ...current,
        page: { ...current.page, status: 'in_progress' },
        overall: input.scope === 'overall'
          ? { ...current.overall, status: 'in_progress', revision: current.overall.revision + 1 }
          : current.overall,
      };
      await transition('resume', input.scope);
      return current;
    },
    open(input) { calls.open.push(input); notify(); return runtime.snapshot; },
    replay(input) { calls.replay.push(input); notify(); return runtime.snapshot; },
    dismiss() { calls.dismiss += 1; return false; },
    async restart(input) {
      calls.restart.push(input);
      current = {
        ...current,
        page: {
          ...current.page,
          status: 'in_progress',
          currentStepIndex: 0,
          furthestStepIndex: 0,
          attemptNumber: current.page.attemptNumber + 1,
          revision: current.page.revision + 1,
        },
      };
      await transition('restart', 'page');
      return current;
    },
    subscribe(listener) {
      stateListeners.add(listener);
      listener(runtime.snapshot);
      return () => stateListeners.delete(listener);
    },
    subscribeTransitions(listener) {
      transitionListeners.add(listener);
      return () => transitionListeners.delete(listener);
    },
    destroy() { calls.destroy += 1; stateListeners.clear(); transitionListeners.clear(); },
  };
  return runtime;
}

function fakeControl() {
  const attributes = new Map();
  return Object.assign(new EventTarget(), {
    dataset: {},
    disabled: false,
    hidden: true,
    isConnected: true,
    textContent: '',
    closest() { return null; },
    focus() {},
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
  });
}

function environment({ pathname = '/dashboard.html', menuButton = fakeControl() } = {}) {
  menuButton.hidden = false;
  const document = {
    activeElement: null,
    body: {},
    documentElement: {},
    querySelector(selector) {
      return selector === '.global-menu-button' ? menuButton : null;
    },
    querySelectorAll() { return []; },
  };
  return {
    document,
    menuButton,
    window: {
      location: { pathname },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    },
  };
}

function fakeConfirmationFactory(log) {
  return (options) => {
    const dialog = {
      destroyed: false,
      open(trigger) { log.opens.push(trigger); },
      destroy() { dialog.destroyed = true; log.destroys += 1; },
      confirm() { return options.onConfirm(); },
      cancel() { return options.onCancel?.(); },
      options,
    };
    log.dialogs.push(dialog);
    return dialog;
  };
}

describe('page training control model', () => {
  test('publishes the exact Start, Resume, Restart, and Replay labels on all 14 registered routes', () => {
    assert.equal(SITE_TRAINING_REGISTRY.pages.length, 14);
    for (const page of SITE_TRAINING_REGISTRY.pages) {
      assert.match(page.route, /^\/[a-z0-9-]+\.html$/);
      assert.deepEqual(pageTrainingControlModel({
        activation: ACTIVE_SOLO,
        state: state('not_started'),
      }), {
        visible: true,
        label: 'Start page training',
        action: 'start',
        restartVisible: false,
        busy: false,
      });
      assert.deepEqual(pageTrainingControlModel({
        activation: ACTIVE_SOLO,
        state: state('in_progress'),
      }), {
        visible: true,
        label: 'Resume page training',
        action: 'resume',
        restartVisible: true,
        busy: false,
      });
      assert.equal(pageTrainingControlModel({
        activation: ACTIVE_SOLO,
        state: state('stopped'),
      }).label, 'Resume page training');
      assert.equal(pageTrainingControlModel({
        activation: ACTIVE_SOLO,
        state: state('completed'),
      }).label, 'Replay page training');
    }
  });

  test('resolves and wires the matching page contract for every registered pathname', async () => {
    for (const page of SITE_TRAINING_REGISTRY.pages) {
      for (const pathname of [page.route, page.route.replace(/\.html$/, '')]) {
        const env = environment({ pathname });
        const runtime = fakeRuntime(state('not_started', { page }), { page });
        const primary = fakeControl();
        const controller = createPageTrainingControls({
          user: USER,
          window: env.window,
          document: env.document,
          api: { getChallengeActivation: async () => ACTIVE_GROUP },
          runtime,
        });
        controller.attachControls({
          feedback: fakeControl(),
          group: fakeControl(),
          primary,
          restart: fakeControl(),
        });
        await controller.refresh();
        assert.equal(controller.available, true, pathname);
        assert.equal(controller.page.id, page.id, pathname);
        assert.equal(primary.hidden, false, pathname);
        assert.equal(primary.textContent, 'Start page training', pathname);
        controller.destroy();
      }
    }
  });

  test('fails closed for unactivated, loading, error, and invalid contracts', () => {
    const hiddenActivations = [
      null,
      { ...ACTIVE_SOLO, readState: 'loading' },
      { ...ACTIVE_SOLO, readState: 'error' },
      { ...ACTIVE_SOLO, contractValid: false },
      { ...ACTIVE_SOLO, status: 'not_started', mode: null },
      { ...ACTIVE_SOLO, mode: null },
    ];
    hiddenActivations.forEach((activation) => {
      assert.equal(pageTrainingControlModel({ activation, state: state() }).visible, false);
    });
    assert.equal(pageTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: { ...state(), readState: 'loading' },
    }).visible, false);
    assert.equal(pageTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: { ...state(), contractValid: false },
    }).visible, false);
    assert.equal(pageTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: state(),
      available: false,
    }).visible, false);
    assert.equal(pageTrainingControlModel({
      activation: ACTIVE_SOLO,
      state: { ...state(), actorId: 'another-actor' },
      expectedActorId: USER.userId,
      expectedPage: SITE_TRAINING_REGISTRY.pages[0],
    }).visible, false);
  });

  test('allows verified scheduled Solo and activated Group users', () => {
    assert.equal(isVerifiedPageTrainingActivation({ ...ACTIVE_SOLO, status: 'scheduled' }), true);
    assert.equal(isVerifiedPageTrainingActivation(ACTIVE_GROUP), true);
    assert.equal(pageTrainingControlModel({
      activation: ACTIVE_GROUP,
      state: state(),
    }).visible, true);
  });
});

describe('page training controller', () => {
  test('keeps every action page-local and replay free of training mutations', async () => {
    const env = environment();
    const runtime = fakeRuntime(state('not_started'));
    const primary = fakeControl();
    const restart = fakeControl();
    const group = fakeControl();
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => ACTIVE_GROUP },
      runtime,
    });
    controller.attachControls({ group, primary, restart });
    await controller.refresh();
    assert.equal(primary.textContent, 'Start page training');
    await controller.activate('start', { control: primary });
    assert.equal(runtime.calls.start[0].scope, 'page');
    assert.equal(runtime.state.overall, null, 'Group page training must not create Solo overall progress');

    runtime.setState(state('completed'));
    assert.equal(primary.textContent, 'Replay page training');
    const writesBeforeReplay = runtime.calls.start.length
      + runtime.calls.resume.length
      + runtime.calls.restart.length;
    await controller.activate('replay', { control: primary });
    assert.equal(runtime.calls.replay.length, 1);
    assert.equal(
      runtime.calls.start.length + runtime.calls.resume.length + runtime.calls.restart.length,
      writesBeforeReplay,
    );
    controller.destroy();
    assert.equal(runtime.calls.destroy, 0, 'a shared runtime is owned by its coordinator');
  });

  test('resumes the exact stopped page and opens an in-progress page without another write', async () => {
    const env = environment();
    const runtime = fakeRuntime(state('stopped'));
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtime,
    });
    await controller.refresh();
    await controller.activate('resume');
    assert.equal(runtime.calls.resume.length, 1);
    assert.equal(runtime.calls.resume[0].scope, 'page');
    await controller.activate('resume');
    assert.equal(runtime.calls.resume.length, 1);
    assert.equal(runtime.calls.open.length, 1);
    assert.equal(runtime.calls.open[0].scope, 'page');
    controller.destroy();
  });

  test('requires explicit restart confirmation and uses the newest visible trigger after reattach', async () => {
    const firstMenuButton = fakeControl();
    const env = environment({ menuButton: firstMenuButton });
    const runtime = fakeRuntime(state('stopped'));
    const dialogLog = { destroys: 0, dialogs: [], opens: [] };
    let currentMenuButton = firstMenuButton;
    env.document.querySelector = (selector) => (
      selector === '.global-menu-button' ? currentMenuButton : null
    );
    const beforeOpen = ({ control }) => {
      control.closest = (selector) => (selector.includes('[inert]') ? {} : null);
      return control;
    };
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtime,
      beforeOpen,
      confirmationFactory: fakeConfirmationFactory(dialogLog),
    });
    const firstRestart = fakeControl();
    controller.attachControls({
      group: fakeControl(), primary: fakeControl(), restart: firstRestart,
    });
    await controller.refresh();
    assert.equal(controller.openRestartConfirmation(), true);
    assert.equal(runtime.calls.restart.length, 0, 'opening or canceling must not write');
    assert.equal(dialogLog.opens[0], firstMenuButton, 'an inert drawer control is never a focus trigger');

    const secondMenuButton = fakeControl();
    secondMenuButton.hidden = false;
    currentMenuButton = secondMenuButton;
    const secondRestart = fakeControl();
    controller.attachControls({
      group: fakeControl(), primary: fakeControl(), restart: secondRestart,
    });
    assert.equal(dialogLog.destroys, 1, 'reattaching replaces the dialog that captured old DOM');
    controller.openRestartConfirmation();
    const currentDialog = dialogLog.dialogs.at(-1);
    assert.equal(dialogLog.opens.at(-1), secondMenuButton);
    secondMenuButton.closest = (selector) => (
      selector.includes('[inert]') || selector.includes('[aria-hidden') ? {} : null
    );
    await currentDialog.confirm();
    assert.equal(runtime.calls.restart.length, 1);
    assert.equal(runtime.calls.restart[0].trigger, secondMenuButton);
    controller.destroy();
  });

  test('hides controls when the fresh activation no longer authorizes training', async () => {
    const env = environment();
    const runtime = fakeRuntime(state('stopped'));
    const primary = fakeControl();
    const activations = [ACTIVE_SOLO, { ...ACTIVE_SOLO, status: 'not_started', mode: null }];
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => activations.shift() },
      runtime,
    });
    controller.attachControls({ group: fakeControl(), primary, restart: fakeControl() });
    await controller.refresh();
    assert.equal(primary.hidden, false);
    await assert.rejects(controller.activate('resume'), /verified scheduled or active challenge/);
    assert.equal(primary.hidden, true);
    assert.equal(runtime.calls.resume.length, 0);
    controller.destroy();
  });

  test('closes a coachmark that finishes opening after activation invalidation', async () => {
    const env = environment();
    const runtime = fakeRuntime(state('not_started'));
    const originalStart = runtime.start;
    let releaseStart;
    let surfaceOpen = false;
    let dismissedAfterOpen = false;
    runtime.start = async (input) => {
      await new Promise((resolve) => { releaseStart = resolve; });
      const result = await originalStart(input);
      surfaceOpen = true;
      return result;
    };
    runtime.dismiss = () => {
      runtime.calls.dismiss += 1;
      if (surfaceOpen) dismissedAfterOpen = true;
      surfaceOpen = false;
      return true;
    };
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtime,
    });
    await controller.refresh();
    const action = controller.activate('start');
    while (!releaseStart) await Promise.resolve();
    const invalidation = controller.refresh({ invalidateCachedActivation: true });
    releaseStart();
    await assert.rejects(action, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
    assert.equal(dismissedAfterOpen, true);
    await invalidation;
    controller.destroy();
  });

  test('updates attached labels from shared-runtime changes in either direction', async () => {
    const env = environment();
    const runtime = fakeRuntime(state('not_started'));
    const primary = fakeControl();
    const restart = fakeControl();
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtime,
    });
    controller.attachControls({ group: fakeControl(), primary, restart });
    await controller.refresh();
    assert.equal(primary.textContent, 'Start page training');
    runtime.setState(state('in_progress'));
    assert.equal(primary.textContent, 'Resume page training');
    assert.equal(restart.hidden, false);
    runtime.setState(state('completed'));
    assert.equal(primary.textContent, 'Replay page training');
    assert.equal(restart.hidden, true);
    controller.destroy();
    runtime.setState(state('not_started'));
    assert.equal(primary.hidden, true);
  });

  test('hides a stale label while reopening refreshes externally changed progress', async () => {
    const env = environment();
    const runtime = fakeRuntime(state('not_started'));
    const section = fakeControl();
    const primary = fakeControl();
    const controller = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api: { getChallengeActivation: async () => ACTIVE_SOLO },
      runtime,
    });
    controller.attachControls({
      section,
      group: fakeControl(),
      primary,
      restart: fakeControl(),
      feedback: fakeControl(),
    });
    await controller.refresh();
    assert.equal(primary.textContent, 'Start page training');
    runtime.queueHydration(state('completed'));
    const refresh = controller.refresh({ hideWhileLoading: true });
    assert.equal(section.hidden, true, 'stale actions stay hidden during the authoritative read');
    await refresh;
    assert.equal(section.hidden, false);
    assert.equal(primary.textContent, 'Replay page training');
    controller.destroy();
  });

  test('shares one runtime so a page resume can continue the full Solo sequence in one click', async () => {
    const env = environment();
    env.window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    env.window.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    env.window.location.href = 'https://dominion.test/dashboard.html';
    env.window.location.origin = 'https://dominion.test';
    const overall = {
      programId: 'solo-first-run',
      programVersion: 2,
      status: 'in_progress',
      currentPageId: 'dashboard',
      currentPageContentVersion: SITE_TRAINING_REGISTRY.pages[0].contentVersion,
      currentPageIndex: 0,
      revision: 2,
    };
    const runtime = fakeRuntime(state('stopped', { overall }));
    const api = { getChallengeActivation: async () => ACTIVE_SOLO };
    const pageController = createPageTrainingControls({
      user: USER,
      window: env.window,
      document: env.document,
      api,
      runtime,
    });
    const overallController = createSoloFirstRunTraining({
      user: USER,
      window: env.window,
      document: env.document,
      api,
      runtime,
    });

    await pageController.refresh();
    await overallController.refresh({ autoOpen: false, consumeHandoff: false });
    await pageController.activate('resume');
    assert.equal(runtime.calls.resume.length, 1);
    assert.equal(runtime.calls.resume[0].scope, 'page');
    await overallController.activate({ trigger: env.menuButton });
    assert.equal(runtime.calls.open.length, 1);
    assert.equal(runtime.calls.open[0].scope, 'overall');
    assert.equal(runtime.calls.destroy, 0);

    overallController.destroy();
    pageController.destroy();
    assert.equal(runtime.calls.destroy, 0, 'neither observer destroys its coordinator-owned runtime');
  });
});
