import { createSiteTrainingCoachmark } from './site-training-coachmark.mjs';
import {
  SITE_TRAINING_REGISTRY,
  siteTrainingPageForRoute,
  siteTrainingProgramForPage,
} from './site-training-registry.mjs';
import { createSiteTrainingState, newSiteTrainingRequestId } from './site-training-state.mjs';

const text = (value) => String(value || '').trim();

function accountChangedError() {
  const error = new Error('The signed-in account changed. Try again.');
  error.code = 'SITE_TRAINING_ACTOR_CHANGED';
  return error;
}

function requireReadyState(state, actorId, page) {
  if (!actorId) throw new TypeError('A captured signed-in account is required for page training.');
  if (!state?.contractValid || state.actorId !== actorId) {
    throw new Error('Load page training for the current account before continuing.');
  }
  if (page && (
    state.page?.pageId !== page.id
    || state.page?.contentVersion !== page.contentVersion
  )) {
    throw new Error('Continue site training from its current page before updating progress.');
  }
  return state;
}

export function createSiteTrainingRuntime({
  registry = SITE_TRAINING_REGISTRY,
  pathname = globalThis.location?.pathname || '',
  expectedUserId = '',
  capabilities = {},
  api = null,
  document: ownerDocument = globalThis.document,
  coachmarkFactory = createSiteTrainingCoachmark,
  onStateChange = null,
} = {}) {
  if (onStateChange !== null && typeof onStateChange !== 'function') {
    throw new TypeError('Page training state changes require a function listener.');
  }
  const page = siteTrainingPageForRoute(registry, pathname);
  const program = siteTrainingProgramForPage(registry, page);
  let actorId = text(expectedUserId);
  let trainingState = createSiteTrainingState('loading');
  let generation = 0;
  let latestRead = 0;
  let destroyed = false;
  let pendingMutation = null;
  let coachmark = null;
  let activeScope = 'page';
  let replayIndex = null;
  let resolvedApiPromise = null;
  const listeners = new Set();
  let controller = null;

  const notifyListener = (listener, snapshot) => {
    try {
      Promise.resolve(listener(snapshot)).catch(() => {
        // Controls are observers; an async rejection must never mask persistence.
      });
    } catch {
      // Controls are observers; a synchronous throw must never interrupt persistence.
    }
  };

  const notifyStateChange = () => {
    if (!controller) return;
    const snapshot = controller.snapshot;
    listeners.forEach((listener) => notifyListener(listener, snapshot));
  };

  const resolveApi = async () => {
    if (api) return api;
    resolvedApiPromise ||= import('./api.js');
    return resolvedApiPromise;
  };

  const currentCapabilities = () => (
    typeof capabilities === 'function' ? capabilities() || {} : capabilities || {}
  );

  const assertCurrent = (capturedActorId, capturedGeneration) => {
    if (destroyed || actorId !== capturedActorId || generation !== capturedGeneration) {
      throw accountChangedError();
    }
  };

  const renderIndex = (index, { replay = false } = {}) => {
    const step = page?.steps?.[index];
    if (!step) throw new Error('The published page training step is no longer available.');
    coachmark.render({
      step,
      index,
      total: page.steps.length,
      capabilities: currentCapabilities(),
      replay,
    });
  };

  const renderLiveState = () => renderIndex(trainingState.page.currentStepIndex);

  const recoverStaleProgress = async (
    service,
    error,
    capturedActorId,
    capturedGeneration,
    scope = activeScope,
  ) => {
    if (error?.code !== '40001'
      || !['site_training_stale_revision', 'site_training_stale_page'].includes(error?.details)) {
      throw error;
    }
    const refreshed = await service.getSiteTrainingState({
      page,
      program: scope === 'overall' ? program : null,
      expectedUserId: capturedActorId,
    });
    assertCurrent(capturedActorId, capturedGeneration);
    if (!refreshed?.contractValid || refreshed.actorId !== capturedActorId) throw error;
    trainingState = refreshed;
    if (refreshed.page.status === 'in_progress'
      && refreshed.page.pageId === page.id
      && refreshed.page.contentVersion === page.contentVersion) {
      if (coachmark) renderLiveState();
    } else coachmark?.close();
    notifyStateChange();
    const recovered = new Error('Page training changed in another tab. The latest progress is loaded; try again.');
    recovered.code = error.code;
    recovered.details = error.details;
    throw recovered;
  };

  const performTransition = async (action) => {
    if (pendingMutation) throw new Error('Page training is already being updated.');
    const current = requireReadyState(trainingState, actorId, page);
    const capturedActorId = actorId;
    const capturedGeneration = generation;
    const mutation = {};
    pendingMutation = mutation;
    coachmark?.setBusy(true);
    notifyStateChange();
    try {
      const service = await resolveApi();
      assertCurrent(capturedActorId, capturedGeneration);
      let result;
      try {
        result = await service.transitionSiteTraining({
          page,
          program: activeScope === 'overall' ? program : null,
          scope: activeScope,
          action,
          requestId: newSiteTrainingRequestId(),
          expectedRevision: activeScope === 'overall'
            ? current.overall?.revision
            : current.page.revision,
          expectedPageRevision: current.page.revision,
          expectedUserId: capturedActorId,
        });
      } catch (error) {
        await recoverStaleProgress(service, error, capturedActorId, capturedGeneration, activeScope);
        return null;
      }
      assertCurrent(capturedActorId, capturedGeneration);
      if (!result?.contractValid || result.actorId !== capturedActorId) throw accountChangedError();
      trainingState = result;
      if (action === 'stop' || action === 'finish') coachmark?.close();
      else renderLiveState();
      notifyStateChange();
      return result;
    } finally {
      if (pendingMutation === mutation) {
        pendingMutation = null;
        coachmark?.setBusy(false);
        notifyStateChange();
      }
    }
  };

  const performReplayAction = async (action) => {
    if (replayIndex === null) return false;
    if (action === 'stop' || action === 'finish') {
      replayIndex = null;
      coachmark?.close();
      notifyStateChange();
      return true;
    }
    if (action === 'back') replayIndex = Math.max(0, replayIndex - 1);
    else if (action === 'next') replayIndex = Math.min(page.steps.length - 1, replayIndex + 1);
    else throw new TypeError('Choose a valid replay action.');
    renderIndex(replayIndex, { replay: true });
    notifyStateChange();
    return true;
  };

  const ensureCoachmark = () => {
    coachmark ||= coachmarkFactory({
      document: ownerDocument,
      onAction: (action) => replayIndex === null
        ? performTransition(action)
        : performReplayAction(action),
    });
    return coachmark;
  };

  const hydrate = async () => {
    if (destroyed) throw new Error('Page training has been destroyed.');
    if (!page) {
      trainingState = createSiteTrainingState('ready');
      notifyStateChange();
      return controller.snapshot;
    }
    const capturedActorId = actorId;
    if (!capturedActorId) throw new TypeError('A captured signed-in account is required for page training.');
    const capturedGeneration = generation;
    const readId = ++latestRead;
    trainingState = createSiteTrainingState('loading');
    notifyStateChange();
    try {
      const service = await resolveApi();
      assertCurrent(capturedActorId, capturedGeneration);
      const result = await service.getSiteTrainingState({
        page,
        program,
        expectedUserId: capturedActorId,
      });
      assertCurrent(capturedActorId, capturedGeneration);
      if (readId !== latestRead) return controller.snapshot;
      if (!result?.contractValid || result.actorId !== capturedActorId) {
        trainingState = result || createSiteTrainingState('error');
      } else trainingState = result;
      notifyStateChange();
      return controller.snapshot;
    } catch (error) {
      assertCurrent(capturedActorId, capturedGeneration);
      if (readId === latestRead) {
        trainingState = createSiteTrainingState('error');
        trainingState.errorMessage = error?.message || 'Unable to load page training.';
        notifyStateChange();
      }
      throw error;
    }
  };

  const claim = async (action, { scope = 'page', trigger = ownerDocument?.activeElement } = {}) => {
    if (!page) throw new Error('Page training is not published for this page.');
    const normalizedScope = scope === 'overall' ? 'overall' : 'page';
    if (normalizedScope === 'overall' && !program) {
      throw new Error('This page is not part of a published site training program.');
    }
    if (pendingMutation) throw new Error('Page training is already being updated.');
    const current = requireReadyState(trainingState, actorId, page);
    const capturedActorId = actorId;
    const capturedGeneration = generation;
    const mutation = {};
    pendingMutation = mutation;
    notifyStateChange();
    try {
      const service = await resolveApi();
      assertCurrent(capturedActorId, capturedGeneration);
      let result;
      try {
        result = await service.claimSiteTraining({
          page,
          program: normalizedScope === 'overall' ? program : null,
          scope: normalizedScope,
          action,
          requestId: newSiteTrainingRequestId(),
          expectedRevision: normalizedScope === 'overall'
            ? current.overall?.revision
            : current.page.revision,
          expectedPageRevision: current.page.revision,
          expectedUserId: capturedActorId,
        });
      } catch (error) {
        await recoverStaleProgress(
          service,
          error,
          capturedActorId,
          capturedGeneration,
          normalizedScope,
        );
        return null;
      }
      assertCurrent(capturedActorId, capturedGeneration);
      if (!result?.contractValid || result.actorId !== capturedActorId) throw accountChangedError();
      if (result.page.status === 'completed') {
        throw new Error('This lesson is complete. Use replay to review it without changing progress.');
      }
      trainingState = result;
      activeScope = normalizedScope;
      replayIndex = null;
      ensureCoachmark().open({ trigger, replay: false });
      renderLiveState();
      notifyStateChange();
      return result;
    } finally {
      if (pendingMutation === mutation) {
        pendingMutation = null;
        notifyStateChange();
      }
    }
  };

  const restart = async ({ trigger = ownerDocument?.activeElement } = {}) => {
    if (!page) throw new Error('Page training is not published for this page.');
    if (pendingMutation) throw new Error('Page training is already being updated.');
    const current = requireReadyState(trainingState, actorId, page);
    if (!['in_progress', 'stopped'].includes(current.page.status)) {
      throw new Error('Only unfinished page training can be restarted.');
    }
    const capturedActorId = actorId;
    const capturedGeneration = generation;
    const mutation = {};
    pendingMutation = mutation;
    notifyStateChange();
    try {
      const service = await resolveApi();
      assertCurrent(capturedActorId, capturedGeneration);
      let result;
      try {
        result = await service.transitionSiteTraining({
          page,
          program: null,
          scope: 'page',
          action: 'restart',
          requestId: newSiteTrainingRequestId(),
          expectedRevision: current.page.revision,
          expectedPageRevision: current.page.revision,
          expectedUserId: capturedActorId,
        });
      } catch (error) {
        await recoverStaleProgress(service, error, capturedActorId, capturedGeneration, 'page');
        return null;
      }
      assertCurrent(capturedActorId, capturedGeneration);
      if (!result?.contractValid || result.actorId !== capturedActorId) throw accountChangedError();
      const overallUnchanged = result.overall === null
        || JSON.stringify(result.overall) === JSON.stringify(current.overall);
      if (result.page.status !== 'in_progress'
        || result.page.currentStepIndex !== 0
        || result.page.furthestStepIndex !== 0
        || result.page.currentStepId !== page.steps[0].id
        || result.page.attemptNumber !== current.page.attemptNumber + 1
        || result.page.revision !== current.page.revision + 1
        || result.page.startedAt === null
        || result.page.startedAt === current.page.startedAt
        || result.page.everCompleted !== current.page.everCompleted
        || result.page.completionCount !== current.page.completionCount
        || !overallUnchanged) {
        const error = new Error('The page training restart response was invalid. Refresh and try again.');
        error.code = 'SITE_TRAINING_CONTRACT_INVALID';
        throw error;
      }
      trainingState = result;
      activeScope = 'page';
      replayIndex = null;
      ensureCoachmark().open({ trigger, replay: false });
      renderLiveState();
      notifyStateChange();
      return result;
    } finally {
      if (pendingMutation === mutation) {
        pendingMutation = null;
        notifyStateChange();
      }
    }
  };

  controller = {
    get available() { return Boolean(page); },
    get page() { return page; },
    get program() { return program; },
    get state() { return trainingState; },
    get snapshot() {
      return Object.freeze({
        available: Boolean(page),
        actorId,
        page,
        program,
        state: trainingState,
        activeScope,
        replaying: replayIndex !== null,
        busy: pendingMutation !== null,
        destroyed,
      });
    },
    hydrate,
    start(options = {}) { return claim('start', options); },
    resume(options = {}) { return claim('resume', options); },
    restart,
    replay({ trigger = ownerDocument?.activeElement } = {}) {
      const current = requireReadyState(trainingState, actorId, page);
      if (!page || current.page.status !== 'completed') {
        throw new Error('Complete this page training before replaying it.');
      }
      activeScope = 'page';
      replayIndex = 0;
      ensureCoachmark().open({ trigger, replay: true });
      renderIndex(replayIndex, { replay: true });
      notifyStateChange();
      return controller.snapshot;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Page training state changes require a function listener.');
      }
      if (destroyed) throw new Error('Page training has been destroyed.');
      listeners.add(listener);
      notifyListener(listener, controller.snapshot);
      return () => listeners.delete(listener);
    },
    setActor(nextActorId) {
      const next = text(nextActorId);
      if (next === actorId) return false;
      generation += 1;
      latestRead += 1;
      actorId = next;
      pendingMutation = null;
      replayIndex = null;
      activeScope = 'page';
      trainingState = createSiteTrainingState('loading');
      coachmark?.close({ restoreFocus: false });
      notifyStateChange();
      return true;
    },
    destroy() {
      if (destroyed) return false;
      destroyed = true;
      generation += 1;
      latestRead += 1;
      replayIndex = null;
      pendingMutation = null;
      coachmark?.destroy();
      coachmark = null;
      notifyStateChange();
      listeners.clear();
      return true;
    },
  };

  if (onStateChange) controller.subscribe(onStateChange);

  return controller;
}
