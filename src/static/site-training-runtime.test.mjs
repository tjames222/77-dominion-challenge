import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defineSiteTrainingRegistry } from './site-training-registry.mjs';
import {
  applySiteTrainingTransition,
  createSiteTrainingPageProgress,
  normalizeSiteTrainingMutation,
  normalizeSiteTrainingState,
} from './site-training-state.mjs';
import { createSiteTrainingRuntime } from './site-training-runtime.mjs';

const registry = defineSiteTrainingRegistry({
  pages: [
    {
      id: 'dashboard', route: '/dashboard.html', contentVersion: 1, title: 'Dashboard',
      steps: ['welcome', 'progress'].map((id) => ({
        id, title: id, description: `${id} description`, unavailable: { description: `${id} fallback` },
      })),
    },
    {
      id: 'rewards', route: '/rewards.html', contentVersion: 1, title: 'Rewards',
      steps: [{ id: 'rewards', title: 'Rewards', description: 'Rewards description' }],
    },
  ],
  programs: [{
    id: 'site-basics', version: 1, title: 'Site basics',
    pages: [
      { pageId: 'dashboard', contentVersion: 1 },
      { pageId: 'rewards', contentVersion: 1 },
    ],
  }],
});
const page = registry.pages[0];

function readyState(actorId = 'actor-1') {
  return normalizeSiteTrainingState(createSiteTrainingPageProgress(page, actorId), { expectedPage: page });
}

function fakeCoachmark() {
  let onAction;
  const controller = {
    openCalls: 0,
    closeCalls: 0,
    renderCalls: [],
    busy: [],
    factory(options) {
      onAction = options.onAction;
      return controller;
    },
    open() { controller.openCalls += 1; },
    close() { controller.closeCalls += 1; },
    destroy() {},
    render(value) { controller.renderCalls.push(value); },
    setBusy(value) { controller.busy.push(value); },
    invoke(action) { return onAction(action); },
  };
  return controller;
}

describe('site training runtime', () => {
  for (const invalidate of ['actor-cycle', 'dismiss', 'destroy']) {
    test(`a delayed UI import cannot claim or open after ${invalidate}`, async () => {
      const coachmark = fakeCoachmark();
      let release;
      const loaded = new Promise((resolve) => { release = resolve; });
      let imports = 0;
      let writes = 0;
      const runtime = createSiteTrainingRuntime({
        registry, pathname: '/dashboard.html', expectedUserId: 'actor-1',
        api: {
          getSiteTrainingState: async () => readyState(),
          claimSiteTraining: async () => { writes += 1; },
        },
        loadCoachmark: () => { imports += 1; return loaded; },
      });
      await runtime.hydrate();
      assert.equal(imports, 0, 'State reads must not load presentation code.');
      const pending = runtime.start();
      assert.equal(imports, 1);
      assert.equal(writes, 0, 'A failed UI import must not start durable training.');
      if (invalidate === 'actor-cycle') {
        runtime.setActor('actor-2');
        runtime.setActor('actor-1');
      } else runtime[invalidate]();
      const rejected = assert.rejects(pending, {
        code: invalidate === 'dismiss' ? 'SITE_TRAINING_OPEN_CANCELLED' : 'SITE_TRAINING_ACTOR_CHANGED',
      });
      release({ createSiteTrainingCoachmark: coachmark.factory });
      await rejected;
      assert.equal(writes, 0);
      assert.equal(coachmark.openCalls, 0);
    });
  }

  test('a failed UI import retries without writes and closes a reopened menu immediately before creating its layer', async () => {
    const coachmark = fakeCoachmark();
    const order = [];
    let imports = 0;
    let writes = 0;
    let state = readyState();
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1',
      api: {
        getSiteTrainingState: async () => state,
        claimSiteTraining: async (input) => {
          writes += 1;
          state = normalizeSiteTrainingMutation(applySiteTrainingTransition(state, input.action), { expectedPage: page });
          return state;
        },
      },
      loadCoachmark: async () => {
        if (++imports === 1) throw new Error('Offline');
        return { createSiteTrainingCoachmark: (options) => { order.push('create-layer'); return coachmark.factory(options); } };
      },
      beforeOpen: () => { order.push('close-menu'); },
    });
    await runtime.hydrate();
    await assert.rejects(runtime.start(), /Offline/);
    assert.equal(writes, 0);
    await runtime.start();
    assert.equal(imports, 2);
    assert.equal(writes, 1);
    assert.equal(coachmark.openCalls, 1);
    assert.deepEqual(order, ['close-menu', 'create-layer']);
  });

  test('dismissing during a successful claim preserves confirmed progress without reopening', async () => {
    const coachmark = fakeCoachmark();
    let finish;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1',
      api: {
        getSiteTrainingState: async () => readyState(),
        claimSiteTraining: () => new Promise((resolve) => { finish = resolve; started(); }),
      },
      coachmarkFactory: coachmark.factory,
    });
    await runtime.hydrate();
    const pending = runtime.start();
    await requestStarted;
    runtime.dismiss();
    finish(normalizeSiteTrainingMutation(applySiteTrainingTransition(readyState(), 'start'), { expectedPage: page }));
    assert.equal((await pending).page.status, 'in_progress');
    assert.equal(runtime.state.page.status, 'in_progress');
    assert.equal(coachmark.openCalls, 0);
  });

  test('hydrates without claiming or opening and persists every live navigation action', async () => {
    const coachmark = fakeCoachmark();
    let state = readyState();
    const calls = { get: 0, claim: [], transition: [] };
    const api = {
      async getSiteTrainingState() { calls.get += 1; return state; },
      async claimSiteTraining(input) {
        calls.claim.push(input);
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, input.action),
          { expectedPage: page },
        );
        return state;
      },
      async transitionSiteTraining(input) {
        calls.transition.push(input);
        const targetStepId = input.action === 'next' ? 'progress' : input.action === 'back' ? 'welcome' : null;
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, input.action, { targetStepId }),
          { expectedPage: page },
        );
        return state;
      },
    };
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1', api,
      coachmarkFactory: coachmark.factory,
    });

    await runtime.hydrate();
    assert.equal(calls.get, 1);
    assert.equal(calls.claim.length, 0);
    assert.equal(coachmark.openCalls, 0);
    await runtime.start();
    assert.equal(coachmark.openCalls, 1);
    assert.equal(calls.claim[0].expectedRevision, 0);
    assert.equal(calls.claim[0].expectedPageRevision, 0);
    assert.match(calls.claim[0].requestId, /^[0-9a-f-]{36}$/i);
    await coachmark.invoke('next');
    await coachmark.invoke('back');
    await coachmark.invoke('stop');
    assert.deepEqual(calls.transition.map((call) => call.action), ['next', 'back', 'stop']);
    assert.equal(calls.transition[1].expectedRevision, 2);
    assert.equal(calls.transition[1].expectedPageRevision, 2);
    assert.equal(new Set(calls.transition.map((call) => call.requestId)).size, 3);
    assert.equal(coachmark.closeCalls, 1);
  });

  test('replays completed training locally without claiming or mutating durable state', async () => {
    const coachmark = fakeCoachmark();
    let completed = applySiteTrainingTransition(readyState(), 'start');
    completed = applySiteTrainingTransition(completed, 'next', { targetStepId: 'progress' });
    completed = normalizeSiteTrainingMutation(
      applySiteTrainingTransition(completed, 'finish'),
      { expectedPage: page },
    );
    let writes = 0;
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1',
      api: {
        getSiteTrainingState: async () => completed,
        claimSiteTraining: async () => { writes += 1; },
        transitionSiteTraining: async () => { writes += 1; },
      },
      coachmarkFactory: coachmark.factory,
    });
    await runtime.hydrate();
    await runtime.replay();
    await coachmark.invoke('next');
    await coachmark.invoke('finish');
    assert.equal(writes, 0);
    assert.deepEqual(coachmark.renderCalls.map((call) => call.index), [0, 1]);
    assert.equal(coachmark.closeCalls, 1);
  });

  test('preserves the verified overall snapshot across page-only Start, Resume, and Restart responses', async () => {
    const coachmark = fakeCoachmark();
    const raw = createSiteTrainingPageProgress(page, 'actor-1');
    raw.overall = {
      programId: 'site-basics',
      programVersion: 1,
      status: 'in_progress',
      currentPageId: 'dashboard',
      currentPageContentVersion: 1,
      currentPageIndex: 0,
      revision: 7,
      startedAt: '2026-02-14T18:00:00.000Z',
      stoppedAt: null,
      completedAt: null,
      updatedAt: '2026-02-14T18:00:00.000Z',
    };
    let durable = normalizeSiteTrainingState(raw, {
      expectedPage: page,
      expectedProgram: registry.programs[0],
    });
    const originalOverall = structuredClone(durable.overall);
    const pageOnlyResult = (action) => {
      durable = normalizeSiteTrainingMutation(
        applySiteTrainingTransition(durable, action),
        { expectedPage: page, expectedProgram: registry.programs[0] },
      );
      return normalizeSiteTrainingMutation(
        { ...structuredClone(durable), overall: null },
        { expectedPage: page },
      );
    };
    const runtime = createSiteTrainingRuntime({
      registry,
      pathname: '/dashboard.html',
      expectedUserId: 'actor-1',
      coachmarkFactory: coachmark.factory,
      api: {
        getSiteTrainingState: async () => durable,
        claimSiteTraining: async ({ action }) => pageOnlyResult(action),
        transitionSiteTraining: async ({ action }) => pageOnlyResult(action),
      },
    });

    await runtime.hydrate();
    await runtime.start({ scope: 'page' });
    assert.deepEqual(runtime.state.overall, originalOverall);
    await coachmark.invoke('stop');
    await runtime.resume({ scope: 'page' });
    assert.deepEqual(runtime.state.overall, originalOverall);
    await coachmark.invoke('stop');
    await runtime.restart();
    assert.deepEqual(runtime.state.overall, originalOverall);
    assert.equal(runtime.state.overall.revision, 7);
  });

  test('publishes transitions to shared observers without allowing rejected observers to mask persistence', async () => {
    const coachmark = fakeCoachmark();
    let current = readyState();
    const runtime = createSiteTrainingRuntime({
      registry,
      pathname: '/dashboard.html',
      expectedUserId: 'actor-1',
      coachmarkFactory: coachmark.factory,
      api: {
        getSiteTrainingState: async () => current,
        claimSiteTraining: async ({ action }) => {
          current = normalizeSiteTrainingMutation(
            applySiteTrainingTransition(current, action),
            { expectedPage: page },
          );
          return current;
        },
        transitionSiteTraining: async ({ action }) => {
          current = normalizeSiteTrainingMutation(
            applySiteTrainingTransition(current, action),
            { expectedPage: page },
          );
          return current;
        },
      },
    });
    const observed = [];
    const unsubscribe = runtime.subscribeTransitions((payload) => observed.push(payload));
    runtime.subscribeTransitions(() => { throw new Error('broken transition observer'); });
    runtime.subscribeTransitions(async () => {
      await Promise.resolve();
      throw new Error('broken async transition observer');
    });

    await runtime.hydrate();
    await runtime.start({ scope: 'page' });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].transition.action, 'start');
    assert.equal(observed[0].scope, 'page');
    assert.equal(observed[0].actorId, 'actor-1');
    assert.equal(unsubscribe(), true);
    await coachmark.invoke('stop');
    assert.equal(observed.length, 1);
    assert.equal(runtime.state.page.status, 'stopped');
  });

  test('restarts unfinished page progress and publishes observable busy/state changes', async () => {
    const coachmark = fakeCoachmark();
    let state = readyState();
    const calls = [];
    const observed = [];
    const subscribed = [];
    const api = {
      async getSiteTrainingState() { return state; },
      async claimSiteTraining(input) {
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, input.action),
          { expectedPage: page },
        );
        return state;
      },
      async transitionSiteTraining(input) {
        calls.push(input);
        const targetStepId = input.action === 'next' ? 'progress' : null;
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, input.action, { targetStepId }),
          { expectedPage: page },
        );
        return state;
      },
    };
    const runtime = createSiteTrainingRuntime({
      registry,
      pathname: '/dashboard.html',
      expectedUserId: 'actor-1',
      api,
      coachmarkFactory: coachmark.factory,
      onStateChange(snapshot) {
        observed.push({
          busy: snapshot.busy,
          readState: snapshot.state.readState,
          status: snapshot.state.page?.status || null,
          attemptNumber: snapshot.state.page?.attemptNumber ?? null,
        });
      },
    });
    const unsubscribe = runtime.subscribe((snapshot) => subscribed.push(snapshot));
    runtime.subscribe(() => { throw new Error('broken observer'); });
    runtime.subscribe(async () => {
      await Promise.resolve();
      throw new Error('broken async observer');
    });

    await runtime.hydrate();
    await runtime.start();
    await coachmark.invoke('next');
    await coachmark.invoke('stop');
    const priorStartedAt = runtime.state.page.startedAt;
    const restarted = await runtime.restart();

    assert.deepEqual({
      status: restarted.page.status,
      currentStepId: restarted.page.currentStepId,
      currentStepIndex: restarted.page.currentStepIndex,
      furthestStepIndex: restarted.page.furthestStepIndex,
      attemptNumber: restarted.page.attemptNumber,
      revision: restarted.page.revision,
    }, {
      status: 'in_progress',
      currentStepId: 'welcome',
      currentStepIndex: 0,
      furthestStepIndex: 0,
      attemptNumber: 2,
      revision: 4,
    });
    assert.match(calls.at(-1).requestId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(restarted.page.startedAt, priorStartedAt);
    assert.deepEqual({
      action: calls.at(-1).action,
      scope: calls.at(-1).scope,
      program: calls.at(-1).program,
      expectedRevision: calls.at(-1).expectedRevision,
      expectedPageRevision: calls.at(-1).expectedPageRevision,
    }, {
      action: 'restart',
      scope: 'page',
      program: null,
      expectedRevision: 3,
      expectedPageRevision: 3,
    });
    assert.equal(coachmark.renderCalls.at(-1).index, 0);
    assert.equal(coachmark.openCalls, 2);
    assert.ok(observed.some((snapshot) => snapshot.busy));
    assert.ok(observed.some((snapshot) => (
      !snapshot.busy && snapshot.status === 'in_progress' && snapshot.attemptNumber === 2
    )));
    const subscribedCount = subscribed.length;
    assert.equal(unsubscribe(), true);
    runtime.setActor('actor-2');
    assert.equal(subscribed.length, subscribedCount);
  });

  test('fails closed when a Restart response changes protected completion or overall state', async () => {
    const coachmark = fakeCoachmark();
    const raw = createSiteTrainingPageProgress(page, 'actor-1');
    raw.overall = {
      programId: 'site-basics',
      programVersion: 1,
      status: 'not_started',
      currentPageId: 'dashboard',
      currentPageContentVersion: 1,
      currentPageIndex: 0,
      revision: 0,
      startedAt: null,
      stoppedAt: null,
      completedAt: null,
      updatedAt: null,
    };
    let state = normalizeSiteTrainingState(raw, {
      expectedPage: page,
      expectedProgram: registry.programs[0],
    });
    state = normalizeSiteTrainingMutation(
      applySiteTrainingTransition(state, 'start'),
      { expectedPage: page, expectedProgram: registry.programs[0] },
    );
    state = normalizeSiteTrainingMutation(
      applySiteTrainingTransition(state, 'stop'),
      { expectedPage: page, expectedProgram: registry.programs[0] },
    );
    const durableBefore = structuredClone(state);
    const api = {
      async getSiteTrainingState() { return state; },
      async transitionSiteTraining() {
        const invalid = applySiteTrainingTransition(state, 'restart');
        invalid.page.revision += 1;
        invalid.page.completionCount = 1;
        invalid.page.everCompleted = true;
        invalid.page.startedAt = state.page.startedAt;
        invalid.overall.revision = 1;
        return normalizeSiteTrainingMutation(invalid, {
          expectedPage: page,
          expectedProgram: registry.programs[0],
        });
      },
    };
    const runtime = createSiteTrainingRuntime({
      registry,
      pathname: '/dashboard.html',
      expectedUserId: 'actor-1',
      api,
      coachmarkFactory: coachmark.factory,
    });
    await runtime.hydrate();
    await assert.rejects(runtime.restart(), { code: 'SITE_TRAINING_CONTRACT_INVALID' });
    assert.deepEqual(runtime.state, durableBefore);
    assert.equal(coachmark.openCalls, 0);
  });

  test('rehydrates a stale tab so modal actions remain recoverable', async () => {
    const coachmark = fakeCoachmark();
    let state = readyState();
    let reads = 0;
    const api = {
      async getSiteTrainingState() { reads += 1; return state; },
      async claimSiteTraining(input) {
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, input.action),
          { expectedPage: page },
        );
        return state;
      },
      async transitionSiteTraining() {
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, 'next', { targetStepId: 'progress' }),
          { expectedPage: page },
        );
        const error = new Error('stale');
        error.code = '40001';
        error.details = 'site_training_stale_revision';
        throw error;
      },
    };
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1', api,
      coachmarkFactory: coachmark.factory,
    });
    await runtime.hydrate();
    await runtime.start();
    await assert.rejects(coachmark.invoke('next'), /latest progress is loaded/);
    assert.equal(reads, 2);
    assert.equal(runtime.state.page.currentStepId, 'progress');
    assert.equal(coachmark.renderCalls.at(-1).index, 1);
    assert.equal(coachmark.closeCalls, 0);
  });

  test('rehydrates a stale Start claim before opening the coachmark', async () => {
    const coachmark = fakeCoachmark();
    let state = readyState();
    let reads = 0;
    const api = {
      async getSiteTrainingState() { reads += 1; return state; },
      async claimSiteTraining() {
        state = normalizeSiteTrainingMutation(
          applySiteTrainingTransition(state, 'start'),
          { expectedPage: page },
        );
        const error = new Error('stale');
        error.code = '40001';
        error.details = 'site_training_stale_revision';
        throw error;
      },
    };
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1', api,
      coachmarkFactory: coachmark.factory,
    });
    await runtime.hydrate();
    await assert.rejects(runtime.start(), /latest progress is loaded/);
    assert.equal(reads, 2);
    assert.equal(runtime.state.page.status, 'in_progress');
    assert.equal(runtime.state.page.revision, 1);
    assert.equal(coachmark.openCalls, 0);
  });

  test('invalidates a stale in-flight read when the signed-in account changes', async () => {
    let resolveRead;
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/dashboard.html', expectedUserId: 'actor-1',
      api: {
        getSiteTrainingState: () => new Promise((resolve) => { resolveRead = resolve; }),
      },
      coachmarkFactory: fakeCoachmark().factory,
    });
    const hydration = runtime.hydrate();
    await Promise.resolve();
    runtime.setActor('actor-2');
    resolveRead(readyState('actor-1'));
    await assert.rejects(hydration, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
    assert.equal(runtime.snapshot.actorId, 'actor-2');
    assert.equal(runtime.state.readState, 'loading');
  });

  test('keeps unpublished pages inert for follow-on content tickets', async () => {
    const runtime = createSiteTrainingRuntime({
      registry, pathname: '/profile.html', expectedUserId: 'actor-1', api: {},
    });
    const snapshot = await runtime.hydrate();
    assert.equal(snapshot.available, false);
    await assert.rejects(runtime.start(), /not published/);
  });
});
