import {
  SOLO_TRAINING_LAUNCH_EVENT,
  SOLO_TRAINING_LAUNCH_STORAGE_KEY,
  compareAndClearSoloTrainingLaunch,
  readSoloTrainingLaunch,
  soloTrainingLaunchMatchesActivation,
} from './challenge-start-flow.mjs';
import {
  SITE_TRAINING_REGISTRY,
  siteTrainingPageForRoute,
  siteTrainingProgramForPage,
} from './site-training-registry.mjs';
import { createSiteTrainingRuntime } from './site-training-runtime.mjs';

export const SOLO_FIRST_RUN_PROGRAM_ID = 'solo-first-run';
export const SOLO_TRAINING_CONTROL_REQUEST_KEY = 'dominion:soloTrainingControlRequests';

const ACTIVE_SOLO_STATUSES = new Set(['scheduled', 'active']);
const CONTROL_ACTIONS = new Set(['start', 'resume', 'continue']);
const text = (value) => String(value ?? '').trim();

function visible(element, ownerWindow) {
  if (!element || element.hidden || element.closest?.('[hidden]')) return false;
  const styles = ownerWindow?.getComputedStyle?.(element);
  return !styles || (styles.display !== 'none' && styles.visibility !== 'hidden');
}

function usableFocusTrigger(element, ownerWindow) {
  return Boolean(
    element?.focus
    && element.isConnected !== false
    && !element.closest?.('[inert], [aria-hidden="true"]')
    && visible(element, ownerWindow),
  );
}

export function soloFirstRunCapabilities({
  activation,
  document: ownerDocument = globalThis.document,
  window: windowLike = globalThis.window,
} = {}) {
  const query = (selector) => ownerDocument?.querySelector?.(selector) || null;
  const anyVisible = (selector) => [...(ownerDocument?.querySelectorAll?.(selector) || [])]
    .some((element) => visible(element, windowLike));
  const share = query('[data-training-target="global-share"], [data-training-target="rewards-sharing"]');
  return Object.freeze({
    'billing-management-available': anyVisible([
      '#manageBillingButton:not([hidden])',
      '#paymentMethodButton:not([hidden])',
      '#cancelMembershipButton:not([hidden])',
      '#subscriptionCheckoutButton:not([hidden])',
    ].join(',')),
    'can-share-progress': activation?.canParticipate === true
      && visible(share, windowLike)
      && share?.disabled !== true,
    'crew-integration-authorized': anyVisible(
      '#integrationConnectActions:not([hidden]), #integrationConfirmForm:not([hidden])',
    ),
    'daily-standards-open': activation?.canMutateDailyStandards === true,
    'group-integrations-enabled': visible(query('#crewIntegrationsCard'), windowLike),
    'has-active-crew': anyVisible([
      '#crewManageCard:not([hidden])',
      '#crewMembersCard:not([hidden])',
      '#integrationConsentContent:not([hidden])',
    ].join(',')),
    'themes-available': visible(query('#appearance'), windowLike),
  });
}

export function isVerifiedSoloTrainingActivation(activation) {
  return Boolean(
    activation?.readState === 'ready'
    && activation.contractValid === true
    && activation.mode === 'solo'
    && ACTIVE_SOLO_STATUSES.has(activation.status),
  );
}

export function allowlistedSoloTrainingRoute(program, route) {
  const normalized = text(route);
  if (!normalized || !program?.pages?.some((page) => page.route === normalized)) return null;
  return normalized;
}

function readRequestStore(storage) {
  try {
    const value = JSON.parse(storage?.getItem?.(SOLO_TRAINING_CONTROL_REQUEST_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeControlRequest(request) {
  const actorId = text(request?.actorId);
  const action = text(request?.action).toLowerCase();
  const route = text(request?.route);
  const requestedAt = text(request?.requestedAt);
  if (request?.schemaVersion !== 1
    || !actorId
    || !CONTROL_ACTIONS.has(action)
    || !/^\/[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(route)
    || !Number.isFinite(Date.parse(requestedAt))) return null;
  return { schemaVersion: 1, actorId, action, route, requestedAt };
}

export function persistSoloTrainingControlRequest(storage, request) {
  if (typeof storage?.setItem !== 'function') return null;
  const normalized = normalizeControlRequest({
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    ...request,
  });
  if (!normalized) return null;
  const requests = readRequestStore(storage);
  requests[normalized.actorId] = normalized;
  storage.setItem(SOLO_TRAINING_CONTROL_REQUEST_KEY, JSON.stringify(requests));
  return normalized;
}

export function readSoloTrainingControlRequest(storage, actorId) {
  const normalizedActorId = text(actorId);
  const request = normalizeControlRequest(readRequestStore(storage)[normalizedActorId]);
  return request?.actorId === normalizedActorId ? request : null;
}

export function compareAndClearSoloTrainingControlRequest(storage, expectedRequest) {
  if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function') return false;
  const expected = normalizeControlRequest(expectedRequest);
  if (!expected) return false;
  const requests = readRequestStore(storage);
  const current = normalizeControlRequest(requests[expected.actorId]);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
  delete requests[expected.actorId];
  if (Object.keys(requests).length) {
    storage.setItem(SOLO_TRAINING_CONTROL_REQUEST_KEY, JSON.stringify(requests));
  } else if (typeof storage.removeItem === 'function') {
    storage.removeItem(SOLO_TRAINING_CONTROL_REQUEST_KEY);
  } else {
    storage.setItem(SOLO_TRAINING_CONTROL_REQUEST_KEY, '{}');
  }
  return true;
}

export function soloTrainingControlModel({ activation, state, onCurrentRoute = false } = {}) {
  if (!isVerifiedSoloTrainingActivation(activation)
    || !state?.contractValid
    || !state.overall) return { visible: false, label: '', action: null };
  if (state.overall.status === 'completed') return { visible: false, label: '', action: null };
  if (state.overall.status === 'not_started') {
    return { visible: true, label: 'Start Training', action: 'start' };
  }
  if (state.overall.status === 'stopped') {
    return { visible: true, label: 'Resume Training', action: 'resume' };
  }
  if (state.overall.status === 'in_progress') {
    return {
      visible: true,
      label: onCurrentRoute ? 'Continue Training' : 'Continue Training',
      action: 'continue',
    };
  }
  return { visible: false, label: '', action: null };
}

export function createSoloFirstRunTraining({
  user,
  registry = SITE_TRAINING_REGISTRY,
  document: ownerDocument = globalThis.document,
  window: windowLike = globalThis.window,
  api = null,
  runtimeFactory = createSiteTrainingRuntime,
  navigate = null,
} = {}) {
  const actorId = text(user?.userId);
  const page = siteTrainingPageForRoute(registry, windowLike?.location?.pathname || '');
  const program = siteTrainingProgramForPage(registry, page);
  const available = Boolean(
    user?.authenticated
    && actorId
    && page
    && program?.id === SOLO_FIRST_RUN_PROGRAM_ID
    && program.audience === 'solo',
  );
  let activation = null;
  let runtime = null;
  let servicePromise = null;
  let control = null;
  let controlListener = null;
  let destroyed = false;
  let generation = 0;
  let operationPromise = null;
  let refreshPromise = null;
  let lastError = '';

  const localStorage = windowLike?.localStorage;
  const sessionStorage = windowLike?.sessionStorage;
  const resolveApi = async () => {
    if (api) return api;
    servicePromise ||= import('./api.js');
    return servicePromise;
  };
  const assertCurrent = (capturedGeneration = generation) => {
    if (destroyed || generation !== capturedGeneration) {
      const error = new Error('The signed-in account changed. Try again.');
      error.code = 'SITE_TRAINING_ACTOR_CHANGED';
      throw error;
    }
  };
  const currentReference = () => program?.pages?.find((candidate, index) => (
    candidate.pageId === runtime?.state?.overall?.currentPageId
    && candidate.contentVersion === runtime?.state?.overall?.currentPageContentVersion
    && index === runtime?.state?.overall?.currentPageIndex
  )) || null;
  const onCurrentRoute = () => {
    const reference = currentReference();
    return Boolean(reference && page
      && reference.pageId === page.id
      && reference.contentVersion === page.contentVersion);
  };
  const confirmedProgramProgress = () => Boolean(
    runtime?.state?.contractValid
    && runtime.state.actorId === actorId
    && runtime.state.overall
    && runtime.state.overall.status !== 'not_started',
  );
  const resolveTrigger = (candidate = null) => {
    if (usableFocusTrigger(candidate, windowLike)) return candidate;
    const activeElement = ownerDocument?.activeElement;
    if (activeElement !== ownerDocument?.body
      && activeElement !== ownerDocument?.documentElement
      && usableFocusTrigger(activeElement, windowLike)) return activeElement;
    const menuButton = ownerDocument?.querySelector?.('.global-menu-button');
    return usableFocusTrigger(menuButton, windowLike) ? menuButton : null;
  };
  const readActivation = async (capturedGeneration = generation) => {
    const service = await resolveApi();
    const nextActivation = await service.getChallengeActivation({ expectedUserId: actorId });
    assertCurrent(capturedGeneration);
    activation = nextActivation;
    return activation;
  };
  const invalidateActivation = () => {
    generation += 1;
    activation = null;
    runtime?.destroy();
    runtime = null;
    renderControl();
  };

  const renderControl = ({ busy = false } = {}) => {
    if (!control) return;
    const model = soloTrainingControlModel({
      activation,
      state: runtime?.state,
      onCurrentRoute: onCurrentRoute(),
    });
    control.hidden = !available || !model.visible;
    control.disabled = busy;
    control.textContent = busy ? 'Loading Training…' : model.label;
    control.dataset.trainingControlAction = model.action || '';
    control.setAttribute('aria-busy', String(Boolean(busy)));
    if (lastError) control.title = lastError;
    else control.removeAttribute('title');
  };

  const navigateTo = (route) => {
    const safeRoute = allowlistedSoloTrainingRoute(program, route);
    if (!safeRoute) {
      lastError = 'Training navigation was blocked because the destination is not published.';
      renderControl();
      return false;
    }
    if (typeof navigate === 'function') navigate(safeRoute);
    else {
      const destination = new URL(safeRoute, windowLike.location.href);
      if (destination.origin !== windowLike.location.origin || destination.pathname !== safeRoute) {
        lastError = 'Training navigation was blocked because the destination is not safe.';
        renderControl();
        return false;
      }
      windowLike.location.assign(destination.href);
    }
    return true;
  };

  const handleRuntimeTransition = async ({ transition, state }) => {
    if (destroyed || state?.actorId !== actorId) return;
    renderControl();
    if (transition?.action !== 'finish' || !transition.applied) return;
    if (transition.nextRoute) navigateTo(transition.nextRoute);
  };

  const ensureRuntime = async () => {
    if (runtime) return runtime;
    const service = await resolveApi();
    runtime = runtimeFactory({
      registry,
      pathname: windowLike.location.pathname,
      expectedUserId: actorId,
      api: service,
      document: ownerDocument,
      capabilities: () => soloFirstRunCapabilities({
        activation,
        document: ownerDocument,
        window: windowLike,
      }),
      onStateChange: async () => renderControl(),
      onTransition: handleRuntimeTransition,
    });
    return runtime;
  };

  const clearLaunchAfterConfirmation = (launch) => {
    if (!launch || !confirmedProgramProgress()) return false;
    return compareAndClearSoloTrainingLaunch(localStorage, launch);
  };

  const advanceCompletedPage = async () => {
    if (runtime.state.page.status !== 'completed') return runtime.state;
    return runtime.advanceCompletedPage({ scope: 'overall' });
  };

  const continueOnCurrentRoute = async ({ trigger = null, launch = null } = {}) => {
    if (!onCurrentRoute()) return null;
    const focusTrigger = resolveTrigger(trigger);
    const overall = runtime.state.overall;
    let result = runtime.state;
    try {
      if (overall.status === 'not_started') {
        result = await runtime.start({ scope: 'overall', trigger: focusTrigger });
      } else if (overall.status === 'stopped') {
        result = await runtime.resume({ scope: 'overall', trigger: focusTrigger });
      } else if (overall.status === 'in_progress') {
        if (runtime.state.page.status === 'in_progress') {
          runtime.open({ scope: 'overall', trigger: focusTrigger });
        } else if (runtime.state.page.status === 'completed') {
          result = await advanceCompletedPage();
        } else {
          result = await runtime.start({ scope: 'overall', trigger: focusTrigger });
        }
      }
    } catch (error) {
      if (launch && confirmedProgramProgress()) {
        clearLaunchAfterConfirmation(launch);
        if (runtime.state.overall.status === 'in_progress'
          && runtime.state.page.status === 'in_progress'
          && onCurrentRoute()) runtime.open({ scope: 'overall', trigger: focusTrigger });
        return runtime.state;
      }
      throw error;
    }
    clearLaunchAfterConfirmation(launch);
    if (runtime.state.overall.status === 'in_progress'
      && runtime.state.page.status === 'completed'
      && onCurrentRoute()) result = await advanceCompletedPage();
    return result;
  };

  const activate = ({ trigger = null, launch = null, request = null } = {}) => {
    if (!available || destroyed) return Promise.resolve(null);
    if (operationPromise) return operationPromise;
    operationPromise = (async () => {
      lastError = '';
      renderControl({ busy: true });
      const capturedGeneration = generation;
      try {
        const freshActivation = await readActivation(capturedGeneration);
        if (!isVerifiedSoloTrainingActivation(freshActivation)) {
          runtime?.destroy();
          runtime = null;
          throw new Error('Solo training requires a verified scheduled or active Solo challenge.');
        }
        if (launch && !soloTrainingLaunchMatchesActivation(launch, freshActivation, actorId)) {
          throw new Error('The Solo training launch no longer matches the current challenge.');
        }
        const training = await ensureRuntime();
        assertCurrent(capturedGeneration);
        if (!training.state?.contractValid) await training.hydrate();
        assertCurrent(capturedGeneration);
        const reference = currentReference();
        if (!reference) throw new Error('The current training page could not be verified.');
        if (!onCurrentRoute()) {
          const action = training.state.overall.status === 'not_started'
            ? 'start'
            : training.state.overall.status === 'stopped' ? 'resume' : 'continue';
          const controlRequest = persistSoloTrainingControlRequest(sessionStorage, {
            actorId,
            action,
            route: reference.route,
          });
          if (!controlRequest || !navigateTo(reference.route)) {
            throw new Error('Training could not continue to its published page.');
          }
          return training.state;
        }
        const result = await continueOnCurrentRoute({ trigger, launch });
        if (request && confirmedProgramProgress()) {
          compareAndClearSoloTrainingControlRequest(sessionStorage, request);
        }
        return result;
      } catch (error) {
        lastError = text(error?.message).slice(0, 300) || 'Training is temporarily unavailable.';
        throw error;
      } finally {
        operationPromise = null;
        renderControl();
      }
    })();
    return operationPromise;
  };

  const refresh = ({
    autoOpen = true,
    consumeHandoff = true,
    invalidateCachedActivation = false,
  } = {}) => {
    if (!available || destroyed) return Promise.resolve(null);
    if (invalidateCachedActivation) invalidateActivation();
    if (refreshPromise) {
      return refreshPromise.then(() => refresh({ autoOpen, consumeHandoff }));
    }
    lastError = '';
    refreshPromise = (async () => {
      const capturedGeneration = generation;
      try {
        await readActivation(capturedGeneration);
        if (!isVerifiedSoloTrainingActivation(activation)) {
          runtime?.destroy();
          runtime = null;
          renderControl();
          return null;
        }
        const training = await ensureRuntime();
        await training.hydrate();
        assertCurrent(capturedGeneration);
        renderControl();

        const launch = consumeHandoff ? readSoloTrainingLaunch(localStorage, actorId) : null;
        const matchingLaunch = launch
          && soloTrainingLaunchMatchesActivation(launch, activation, actorId)
          ? launch
          : null;
        const request = readSoloTrainingControlRequest(sessionStorage, actorId);
        const requestMatchesRoute = request
          && allowlistedSoloTrainingRoute(program, request.route) === page.route;

        if (matchingLaunch && training.state.overall.status === 'not_started') {
          await activate({ launch: matchingLaunch });
        } else if (requestMatchesRoute) {
          await activate({ request });
        } else if (autoOpen
          && training.state.overall.status === 'in_progress'
          && onCurrentRoute()) {
          await activate({ launch: matchingLaunch });
        } else if (matchingLaunch && confirmedProgramProgress()) {
          clearLaunchAfterConfirmation(matchingLaunch);
        }
        return training.state;
      } catch (error) {
        if (error?.code !== 'SITE_TRAINING_ACTOR_CHANGED') {
          lastError = text(error?.message).slice(0, 300) || 'Training is temporarily unavailable.';
          console.warn('Unable to prepare Solo site training', error);
        }
        renderControl();
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const controller = {
    get available() { return available; },
    get actorId() { return actorId; },
    get activation() { return activation; },
    get runtime() { return runtime; },
    get state() { return runtime?.state || null; },
    attachControl(nextControl) {
      if (control && controlListener) control.removeEventListener('click', controlListener);
      control = nextControl?.addEventListener ? nextControl : null;
      controlListener = control
        ? () => { void activate({ trigger: control }).catch(() => {}); }
        : null;
      if (controlListener) control.addEventListener('click', controlListener);
      renderControl();
      return Boolean(control);
    },
    activate,
    refresh,
    consumeHandoff(detail = null) {
      if (detail?.actorId && detail.actorId !== actorId) return Promise.resolve(null);
      return refresh({ autoOpen: false, consumeHandoff: true });
    },
    destroy() {
      if (destroyed) return false;
      destroyed = true;
      generation += 1;
      if (control && controlListener) control.removeEventListener('click', controlListener);
      if (control) control.hidden = true;
      control = null;
      controlListener = null;
      runtime?.destroy();
      runtime = null;
      return true;
    },
  };

  return controller;
}

export { SOLO_TRAINING_LAUNCH_EVENT, SOLO_TRAINING_LAUNCH_STORAGE_KEY };
