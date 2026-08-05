import { createConfirmationDialog } from './dialog.mjs';
import { soloFirstRunCapabilities } from './solo-first-run-training.mjs';
import {
  SITE_TRAINING_REGISTRY,
  siteTrainingPageForRoute,
} from './site-training-registry.mjs';
import { createSiteTrainingRuntime } from './site-training-runtime.mjs';

const ACTIVE_ACTIVATION_STATUSES = new Set(['scheduled', 'active']);
const ACTIVATION_MODES = new Set(['solo', 'group']);
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

function preservedDialogTrigger(element, ownerWindow) {
  return Boolean(
    element?.focus
    && element.isConnected !== false
    && visible(element, ownerWindow),
  );
}

export function isVerifiedPageTrainingActivation(activation) {
  return Boolean(
    activation?.readState === 'ready'
    && activation.contractValid === true
    && ACTIVE_ACTIVATION_STATUSES.has(activation.status)
    && ACTIVATION_MODES.has(activation.mode),
  );
}

export function pageTrainingControlModel({
  activation,
  state,
  available = true,
  busy = false,
  expectedActorId = '',
  expectedPage = null,
} = {}) {
  const hidden = Object.freeze({
    visible: false,
    label: '',
    action: null,
    restartVisible: false,
    busy: Boolean(busy),
  });
  if (!available
    || !isVerifiedPageTrainingActivation(activation)
    || state?.readState !== 'ready'
    || state.contractValid !== true
    || (expectedActorId && state.actorId !== expectedActorId)
    || (expectedPage && (
      state.page?.pageId !== expectedPage.id
      || state.page?.contentVersion !== expectedPage.contentVersion
    ))) return hidden;

  if (state.page?.status === 'not_started') {
    return Object.freeze({
      visible: true,
      label: 'Start page training',
      action: 'start',
      restartVisible: false,
      busy: Boolean(busy),
    });
  }
  if (state.page?.status === 'in_progress' || state.page?.status === 'stopped') {
    return Object.freeze({
      visible: true,
      label: 'Resume page training',
      action: 'resume',
      restartVisible: true,
      busy: Boolean(busy),
    });
  }
  if (state.page?.status === 'completed') {
    return Object.freeze({
      visible: true,
      label: 'Replay page training',
      action: 'replay',
      restartVisible: false,
      busy: Boolean(busy),
    });
  }
  return hidden;
}

export function createPageTrainingControls({
  user,
  registry = SITE_TRAINING_REGISTRY,
  document: ownerDocument = globalThis.document,
  window: windowLike = globalThis.window,
  api = null,
  runtime: sharedRuntime = null,
  runtimeFactory = createSiteTrainingRuntime,
  confirmationFactory = createConfirmationDialog,
  beforeOpen = null,
} = {}) {
  const actorId = text(user?.userId);
  const page = siteTrainingPageForRoute(registry, windowLike?.location?.pathname || '');
  const sharedRuntimeCompatible = !sharedRuntime || Boolean(
    page
    && sharedRuntime.page?.id === page.id
    && sharedRuntime.page?.contentVersion === page.contentVersion
    && sharedRuntime.snapshot?.actorId === actorId,
  );
  const available = Boolean(user?.authenticated && actorId && page && sharedRuntimeCompatible);
  const ownsRuntime = !sharedRuntime;
  let activation = null;
  let runtime = sharedRuntime;
  let runtimeUnsubscribe = null;
  let servicePromise = null;
  let refreshPromise = null;
  let operationPromise = null;
  let confirmationDialog = null;
  let destroyed = false;
  let generation = 0;
  let lastError = '';
  let controls = {
    feedback: null,
    group: null,
    primary: null,
    restart: null,
    section: null,
  };
  let listeners = { primary: null, restart: null };

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
  const setControlError = (control) => {
    if (!control?.setAttribute) return;
    if (lastError) control.setAttribute('title', lastError);
    else control.removeAttribute('title');
  };
  const renderControls = () => {
    const model = pageTrainingControlModel({
      activation,
      state: runtime?.state,
      available,
      busy: Boolean(operationPromise || runtime?.snapshot?.busy),
      expectedActorId: actorId,
      expectedPage: page,
    });
    const busy = model.busy;
    if (controls.primary) {
      controls.primary.hidden = !model.visible;
      controls.primary.disabled = busy;
      controls.primary.textContent = model.label || 'Start page training';
      controls.primary.dataset.trainingControlAction = model.action || '';
      controls.primary.setAttribute('aria-busy', String(busy));
      setControlError(controls.primary);
    }
    if (controls.restart) {
      controls.restart.hidden = !model.restartVisible;
      controls.restart.disabled = busy;
      controls.restart.textContent = 'Restart page training';
      controls.restart.setAttribute('aria-busy', String(busy));
      controls.restart.setAttribute('aria-haspopup', 'dialog');
      setControlError(controls.restart);
    }
    if (controls.group) {
      controls.group.hidden = !model.visible;
      controls.group.setAttribute('aria-busy', String(busy));
    }
    if (controls.section) controls.section.hidden = !model.visible;
    if (controls.feedback) {
      controls.feedback.textContent = model.visible ? lastError : '';
      controls.feedback.hidden = !controls.feedback.textContent;
    }
  };
  const ensureRuntime = () => {
    if (!runtime) {
      runtime = runtimeFactory({
        registry,
        pathname: windowLike?.location?.pathname || '',
        expectedUserId: actorId,
        api,
        document: ownerDocument,
        capabilities: () => soloFirstRunCapabilities({
          activation,
          document: ownerDocument,
          window: windowLike,
        }),
      });
    }
    runtimeUnsubscribe ||= runtime.subscribe(() => renderControls());
    return runtime;
  };
  const readActivation = async (capturedGeneration = generation) => {
    const service = await resolveApi();
    const nextActivation = await service.getChallengeActivation({ expectedUserId: actorId });
    assertCurrent(capturedGeneration);
    activation = nextActivation;
    return activation;
  };
  const resolveVisibleTrigger = (control, action) => {
    const candidate = typeof beforeOpen === 'function'
      ? beforeOpen({ action, control, page })
      : control;
    if (usableFocusTrigger(candidate, windowLike)) return candidate;
    const menuButton = ownerDocument?.querySelector?.('.global-menu-button');
    if (usableFocusTrigger(menuButton, windowLike)) return menuButton;
    const activeElement = ownerDocument?.activeElement;
    return usableFocusTrigger(activeElement, windowLike) ? activeElement : null;
  };
  const currentModel = () => pageTrainingControlModel({
    activation,
    state: runtime?.state,
    available,
    busy: Boolean(operationPromise || runtime?.snapshot?.busy),
    expectedActorId: actorId,
    expectedPage: page,
  });

  const activate = (requestedAction, {
    control = controls.primary,
    prevalidatedTrigger = false,
    trigger = null,
  } = {}) => {
    if (!available || destroyed) return Promise.resolve(null);
    if (operationPromise) return operationPromise;
    const operation = (async () => {
      lastError = '';
      const capturedGeneration = generation;
      try {
        const freshActivation = await readActivation(capturedGeneration);
        if (!isVerifiedPageTrainingActivation(freshActivation)) {
          confirmationDialog?.close?.('authorization-change');
          runtime?.dismiss?.({ restoreFocus: false });
          throw new Error('Page training requires a verified scheduled or active challenge.');
        }
        const training = ensureRuntime();
        await training.hydrate();
        assertCurrent(capturedGeneration);
        const model = currentModel();
        if (requestedAction === 'restart') {
          if (!model.restartVisible) throw new Error('Only unfinished page training can be restarted.');
        } else if (!model.visible || model.action !== requestedAction) {
          throw new Error('Page training changed. Use the updated training control and try again.');
        }
        const focusTrigger = prevalidatedTrigger && preservedDialogTrigger(trigger, windowLike)
          ? trigger
          : usableFocusTrigger(trigger, windowLike)
            ? trigger
            : resolveVisibleTrigger(control, requestedAction);
        let result;
        if (requestedAction === 'start') {
          result = await training.start({ scope: 'page', trigger: focusTrigger });
        }
        if (requestedAction === 'resume') {
          if (training.state.page.status === 'stopped') {
            result = await training.resume({ scope: 'page', trigger: focusTrigger });
          } else result = training.open({ scope: 'page', trigger: focusTrigger });
        }
        if (requestedAction === 'replay') result = training.replay({ trigger: focusTrigger });
        if (requestedAction === 'restart') {
          result = await training.restart({ trigger: focusTrigger });
        }
        if (!['start', 'resume', 'replay', 'restart'].includes(requestedAction)) {
          throw new TypeError('Choose a valid page training action.');
        }
        assertCurrent(capturedGeneration);
        return result;
      } catch (error) {
        if (error?.code === 'SITE_TRAINING_ACTOR_CHANGED') {
          runtime?.dismiss?.({ restoreFocus: false });
        }
        lastError = text(error?.message).slice(0, 300) || 'Page training is temporarily unavailable.';
        throw error;
      } finally {
        operationPromise = null;
        renderControls();
      }
    })();
    operationPromise = operation;
    renderControls();
    return operationPromise;
  };

  const openRestartConfirmation = () => {
    if (!currentModel().restartVisible || destroyed) return false;
    const trigger = resolveVisibleTrigger(controls.restart, 'restart');
    confirmationDialog ||= confirmationFactory({
      id: 'page-training-restart-confirmation',
      document: ownerDocument,
      title: 'Restart page training?',
      description: `This returns only ${page.title} training to its first step. Other pages and full-site progress stay unchanged.`,
      confirmLabel: 'Restart page training',
      pendingLabel: 'Restarting page training…',
      errorMessage: 'Page training could not be restarted. Refresh and try again.',
      onConfirm: () => activate('restart', {
        control: controls.restart,
        prevalidatedTrigger: true,
        trigger,
      }),
    });
    confirmationDialog.open(trigger);
    return true;
  };

  const refresh = ({ invalidateCachedActivation = false, hideWhileLoading = false } = {}) => {
    if (!available || destroyed) return Promise.resolve(null);
    if (invalidateCachedActivation) {
      generation += 1;
      activation = null;
      lastError = '';
      confirmationDialog?.close?.('activation-change');
      runtime?.dismiss?.({ restoreFocus: false });
      renderControls();
    } else if (hideWhileLoading) {
      activation = null;
      lastError = '';
      renderControls();
    }
    if (refreshPromise) return refreshPromise.then(() => refresh({ hideWhileLoading }));
    refreshPromise = (async () => {
      const capturedGeneration = generation;
      try {
        await readActivation(capturedGeneration);
        if (!isVerifiedPageTrainingActivation(activation)) {
          confirmationDialog?.close?.('authorization-change');
          runtime?.dismiss?.({ restoreFocus: false });
          renderControls();
          return null;
        }
        const training = ensureRuntime();
        await training.hydrate();
        assertCurrent(capturedGeneration);
        lastError = '';
        renderControls();
        return training.state;
      } catch (error) {
        if (error?.code !== 'SITE_TRAINING_ACTOR_CHANGED') {
          activation = null;
          lastError = text(error?.message).slice(0, 300) || 'Page training is temporarily unavailable.';
          console.warn('Unable to prepare page training controls', error);
        }
        renderControls();
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  if (available) ensureRuntime();

  return {
    get available() { return available; },
    get actorId() { return actorId; },
    get activation() { return activation; },
    get page() { return page; },
    get runtime() { return runtime; },
    get state() { return runtime?.state || null; },
    activate,
    attachControls(nextControls = {}) {
      if (controls.primary && listeners.primary) {
        controls.primary.removeEventListener('click', listeners.primary);
      }
      if (controls.restart && listeners.restart) {
        controls.restart.removeEventListener('click', listeners.restart);
      }
      confirmationDialog?.destroy();
      confirmationDialog = null;
      controls = {
        feedback: nextControls.feedback?.setAttribute ? nextControls.feedback : null,
        group: nextControls.group?.setAttribute ? nextControls.group : null,
        primary: nextControls.primary?.addEventListener ? nextControls.primary : null,
        restart: nextControls.restart?.addEventListener ? nextControls.restart : null,
        section: nextControls.section?.setAttribute ? nextControls.section : null,
      };
      listeners = {
        primary: controls.primary
          ? () => {
            const action = controls.primary.dataset.trainingControlAction;
            void activate(action, { control: controls.primary }).catch(() => {});
          }
          : null,
        restart: controls.restart ? () => openRestartConfirmation() : null,
      };
      if (listeners.primary) controls.primary.addEventListener('click', listeners.primary);
      if (listeners.restart) controls.restart.addEventListener('click', listeners.restart);
      renderControls();
      return Boolean(controls.primary && controls.restart);
    },
    openRestartConfirmation,
    refresh,
    destroy() {
      if (destroyed) return false;
      destroyed = true;
      generation += 1;
      if (controls.primary && listeners.primary) {
        controls.primary.removeEventListener('click', listeners.primary);
      }
      if (controls.restart && listeners.restart) {
        controls.restart.removeEventListener('click', listeners.restart);
      }
      [
        controls.feedback,
        controls.group,
        controls.primary,
        controls.restart,
        controls.section,
      ].forEach((control) => {
        if (control) control.hidden = true;
      });
      controls = {
        feedback: null,
        group: null,
        primary: null,
        restart: null,
        section: null,
      };
      listeners = { primary: null, restart: null };
      confirmationDialog?.destroy();
      confirmationDialog = null;
      runtimeUnsubscribe?.();
      runtimeUnsubscribe = null;
      if (ownsRuntime) runtime?.destroy();
      runtime = null;
      return true;
    },
  };
}
