import {
  activateSoloChallenge,
  getChallengeActivation,
} from './api';
import { newChallengeActivationRequestId } from './challenge-activation.mjs';
import {
  backChallengeStartFlow,
  buildGroupChallengeStartHref,
  confirmSoloChallengeStart,
  continueChallengeStartMode,
  createChallengeStartFlowState,
  markChallengeStartSubmission,
  publishSoloTrainingLaunch,
  selectChallengeStartMode,
  setSoloChallengeStartDate,
  soloChallengeStartSummary,
  validateSoloChallengeStartDate,
} from './challenge-start-flow.mjs';
import { createDialog } from './dialog.mjs';

const text = (value) => String(value ?? '').trim();

function formatDateOnly(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function safeErrorMessage(error, fallback) {
  return text(error?.message).slice(0, 300) || fallback;
}

function verifiedSoloActivation(activation) {
  return Boolean(
    activation?.contractValid
    && activation.readState === 'ready'
    && activation.mode === 'solo'
    && ['scheduled', 'active'].includes(activation.status),
  );
}

function compatibleSoloActivation(activation, state) {
  return verifiedSoloActivation(activation)
    && activation.startDate === state.startDate
    && activation.timeZone === state.timeZone;
}

export function createChallengeStartFlow({
  document: ownerDocument = globalThis.document,
  window: windowLike = globalThis.window,
  captureOwner = () => null,
  isCurrentOwner = () => false,
  getActivationState = () => null,
  onActivation = async () => {},
  onStatus = () => {},
} = {}) {
  if (!ownerDocument?.createElement || !ownerDocument.body) {
    throw new TypeError('Challenge Start requires a browser document.');
  }

  const content = ownerDocument.createElement('div');
  content.className = 'challenge-start-flow';
  content.innerHTML = `
    <section class="challenge-start-step" data-challenge-start-step="mode">
      <h3>How will you take the challenge?</h3>
      <p>Choose the path that matches how you will stay accountable. Nothing is saved until you explicitly confirm a start.</p>
      <fieldset class="challenge-start-choices">
        <legend class="sr-only">Participation mode</legend>
        <label class="challenge-start-choice">
          <input type="radio" name="challengeParticipationMode" value="group" />
          <span><strong>With a group</strong><small>Use one shared crew start date and walk the challenge with people you know.</small></span>
        </label>
        <label class="challenge-start-choice">
          <input type="radio" name="challengeParticipationMode" value="solo" />
          <span><strong>Solo</strong><small>Choose your own start date and complete the challenge on your personal timeline.</small></span>
        </label>
      </fieldset>
      <div class="challenge-start-actions">
        <button class="secondary" type="button" data-challenge-start-cancel>Cancel</button>
        <button class="primary" type="button" data-challenge-start-mode-continue disabled>Continue</button>
      </div>
    </section>

    <section class="challenge-start-step" data-challenge-start-step="date" hidden>
      <h3>Choose your Solo start date</h3>
      <p>Your selected time zone sets the date boundary for every challenge day.</p>
      <label class="challenge-start-date-label" for="soloChallengeStartDate">
        <span>Challenge start date</span>
        <input id="soloChallengeStartDate" type="date" required data-challenge-start-date />
      </label>
      <p class="challenge-start-time-zone" data-challenge-start-time-zone></p>
      <p class="challenge-start-field-error" data-challenge-start-date-error role="alert" hidden></p>
      <div class="challenge-start-actions">
        <button class="secondary" type="button" data-challenge-start-back>Back</button>
        <button class="secondary" type="button" data-challenge-start-cancel>Cancel</button>
        <button class="primary" type="button" data-challenge-start-date-continue disabled>Review start</button>
      </div>
    </section>

    <section class="challenge-start-step" data-challenge-start-step="confirm" hidden>
      <h3>Confirm your challenge</h3>
      <p>Review this timeline before Dominion records your authoritative start.</p>
      <dl class="challenge-start-summary">
        <div><dt>Participation</dt><dd>Solo</dd></div>
        <div><dt>Start date</dt><dd data-challenge-start-summary-date></dd></div>
        <div><dt>Time zone</dt><dd data-challenge-start-summary-time-zone></dd></div>
      </dl>
      <p class="challenge-start-confirmation-copy" data-challenge-start-summary-copy></p>
      <div class="challenge-start-actions">
        <button class="secondary" type="button" data-challenge-start-back>Back</button>
        <button class="secondary" type="button" data-challenge-start-cancel>Cancel</button>
        <button class="primary" type="button" data-challenge-start-confirm>Confirm and start challenge</button>
      </div>
    </section>
  `;

  const steps = Object.fromEntries(
    [...content.querySelectorAll('[data-challenge-start-step]')]
      .map((element) => [element.dataset.challengeStartStep, element]),
  );
  const modeInputs = [...content.querySelectorAll('input[name="challengeParticipationMode"]')];
  const groupInput = modeInputs.find((input) => input.value === 'group');
  const soloInput = modeInputs.find((input) => input.value === 'solo');
  const modeContinue = content.querySelector('[data-challenge-start-mode-continue]');
  const dateInput = content.querySelector('[data-challenge-start-date]');
  const dateContinue = content.querySelector('[data-challenge-start-date-continue]');
  const dateError = content.querySelector('[data-challenge-start-date-error]');
  const timeZoneCopy = content.querySelector('[data-challenge-start-time-zone]');
  const summaryDate = content.querySelector('[data-challenge-start-summary-date]');
  const summaryTimeZone = content.querySelector('[data-challenge-start-summary-time-zone]');
  const summaryCopy = content.querySelector('[data-challenge-start-summary-copy]');
  const confirmButton = content.querySelector('[data-challenge-start-confirm]');

  let state = createChallengeStartFlowState();
  let flowOwner = null;
  let submitting = false;
  let online = windowLike.navigator?.onLine !== false;

  const dialog = createDialog({
    id: 'challengeStartDialog',
    title: 'Start Challenge',
    eyebrow: 'Your 77 days',
    description: 'Choose whether to start on your own or with a group, then confirm your start date.',
    presentation: 'responsive',
    content,
    initialFocus: () => content.querySelector('[data-challenge-start-step]:not([hidden]) input:not(:disabled), [data-challenge-start-step]:not([hidden]) button:not(:disabled)'),
    onClose: () => {
      if (!submitting) resetFlow();
    },
  });

  function resetFlow() {
    const activation = getActivationState();
    state = createChallengeStartFlowState({
      canActivateGroup: activation?.canActivateGroup,
      canActivateSolo: activation?.canActivateSolo,
    });
    flowOwner = null;
    submitting = false;
    dateInput.value = '';
    modeInputs.forEach((input) => { input.checked = false; });
    clearDateError();
    dialog.clearError();
    dialog.setBusy(false);
    render();
  }

  function clearDateError() {
    dateError.textContent = '';
    dateError.hidden = true;
    dateInput.removeAttribute('aria-invalid');
  }

  function showDateError(message) {
    dateError.textContent = message;
    dateError.hidden = false;
    dateInput.setAttribute('aria-invalid', 'true');
    dateInput.focus();
  }

  function setSubmitting(nextSubmitting, label = '') {
    submitting = Boolean(nextSubmitting);
    dialog.setBusy(submitting, label || 'Starting your challenge…');
    render();
  }

  function render() {
    Object.entries(steps).forEach(([name, element]) => {
      element.hidden = name !== state.step;
    });

    groupInput.disabled = submitting || !online || !state.canActivateGroup;
    soloInput.disabled = submitting || !online || !state.canActivateSolo;
    modeContinue.disabled = submitting || !online || !state.mode;
    dateInput.disabled = submitting || !online;
    dateContinue.disabled = submitting || !online || !validateSoloChallengeStartDate(state).valid;
    confirmButton.disabled = submitting || !online;
    content.querySelectorAll('[data-challenge-start-back], [data-challenge-start-cancel]')
      .forEach((button) => { button.disabled = submitting; });

    timeZoneCopy.textContent = `Date boundary: ${state.timeZone}`;
    if (state.step === 'confirm') {
      const validation = validateSoloChallengeStartDate(state);
      summaryDate.textContent = formatDateOnly(state.startDate);
      summaryTimeZone.textContent = state.timeZone;
      summaryCopy.textContent = soloChallengeStartSummary(validation);
    }
  }

  async function readFreshActivation(owner) {
    const activation = await getChallengeActivation({ expectedUserId: owner.userId });
    if (!isCurrentOwner(owner)) return null;
    return activation?.contractValid && activation.readState === 'ready' ? activation : null;
  }

  async function finishSoloActivation(activation, owner, message) {
    if (!isCurrentOwner(owner) || !verifiedSoloActivation(activation)) return false;
    setSubmitting(false);
    dialog.close('activated');

    // Release setup's focus trap and page isolation before the training event
    // can acquire its own modal layer. Dispatching while setup still owned the
    // page could leave a slow-loading coachmark behind an inert dashboard.
    let trainingLaunchQueued = true;
    try {
      publishSoloTrainingLaunch({
        actorId: owner.userId,
        activation,
        storage: windowLike.localStorage,
        window: windowLike,
      });
    } catch (error) {
      trainingLaunchQueued = false;
      console.warn('Unable to persist the Solo training launch handoff', error);
    }
    await onActivation(activation, owner);
    if (!isCurrentOwner(owner)) return false;
    onStatus(message || (!trainingLaunchQueued
      ? 'Your challenge is confirmed, but Solo training setup could not be saved. Refresh to try the training handoff again.'
      : activation.status === 'scheduled'
        ? `Challenge scheduled for ${formatDateOnly(activation.startDate)}. Solo training is ready to begin.`
        : 'Challenge started. Day 1 and your eligible Dashboard actions are ready.'), { focus: true });
    return true;
  }

  async function submitSoloActivation() {
    if (submitting || !flowOwner || !isCurrentOwner(flowOwner)) return;
    if (!online) {
      dialog.setError('Reconnect before confirming your challenge start. No activation change was made.');
      return;
    }
    const validation = validateSoloChallengeStartDate(state);
    if (!validation.valid || !state.requestId) {
      showDateError(validation.message || 'Review a valid challenge start date.');
      return;
    }

    const owner = flowOwner;
    state = markChallengeStartSubmission(state);
    setSubmitting(true, 'Confirming your challenge start…');
    dialog.clearError();

    try {
      await activateSoloChallenge({
        startDate: state.startDate,
        timeZone: state.timeZone,
        requestId: state.requestId,
        expectedUserId: owner.userId,
      });
      const fresh = await readFreshActivation(owner);
      if (!fresh) {
        throw new Error('Your start request was sent, but its status could not be refreshed. Reconnect and try again.');
      }
      if (!compatibleSoloActivation(fresh, state)) {
        setSubmitting(false);
        dialog.close('concurrent-activation');
        await onActivation(fresh, owner);
        if (isCurrentOwner(owner)) {
          onStatus('Your challenge was updated in another session. The Dashboard now shows the confirmed dates.', { focus: true });
        }
        return;
      }
      await finishSoloActivation(fresh, owner);
    } catch (error) {
      if (!isCurrentOwner(owner)) return;
      let fresh = null;
      try {
        fresh = await readFreshActivation(owner);
      } catch {
        // The original request ID remains available for an idempotent retry.
      }
      if (fresh && compatibleSoloActivation(fresh, state)) {
        await finishSoloActivation(fresh, owner);
        return;
      }
      if (fresh && fresh.status !== 'not_started') {
        setSubmitting(false);
        dialog.close('concurrent-activation');
        await onActivation(fresh, owner);
        if (isCurrentOwner(owner)) {
          onStatus('Your challenge was updated in another session. The Dashboard now shows the confirmed dates.', { focus: true });
        }
        return;
      }

      setSubmitting(false);
      dialog.setError(safeErrorMessage(
        error,
        'Unable to start your challenge right now. Your request is safe to retry.',
      ));
      confirmButton.textContent = 'Retry challenge start';
      confirmButton.focus();
    }
  }

  modeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      state = selectChallengeStartMode(state, input.value);
      clearDateError();
      dialog.clearError();
      render();
    });
  });

  modeContinue.addEventListener('click', () => {
    const nextState = continueChallengeStartMode(state);
    if (nextState.step === 'group_handoff') {
      const destination = buildGroupChallengeStartHref();
      dialog.close('group-handoff');
      windowLike.location.href = destination;
      return;
    }
    state = nextState;
    render();
    dateInput.focus();
  });

  dateInput.addEventListener('input', () => {
    state = setSoloChallengeStartDate(state, dateInput.value);
    clearDateError();
    dialog.clearError();
    render();
  });

  dateContinue.addEventListener('click', () => {
    const result = confirmSoloChallengeStart(state, newChallengeActivationRequestId());
    if (!result.validation.valid) {
      showDateError(result.validation.message);
      return;
    }
    state = result.state;
    confirmButton.textContent = 'Confirm and start challenge';
    render();
    content.querySelector('[data-challenge-start-step="confirm"] h3')?.focus?.();
    confirmButton.focus();
  });

  content.querySelectorAll('[data-challenge-start-back]').forEach((button) => {
    button.addEventListener('click', () => {
      state = backChallengeStartFlow(state);
      confirmButton.textContent = 'Confirm and start challenge';
      dialog.clearError();
      render();
      if (state.step === 'date') dateInput.focus();
      else {
        const focusTarget = modeInputs.find((input) => input.checked && !input.disabled)
          || modeInputs.find((input) => !input.disabled);
        focusTarget?.focus();
      }
    });
  });

  content.querySelectorAll('[data-challenge-start-cancel]').forEach((button) => {
    button.addEventListener('click', () => dialog.close('cancel'));
  });
  confirmButton.addEventListener('click', () => { void submitSoloActivation(); });

  render();

  return {
    get dialog() { return dialog; },
    get state() { return { ...state }; },
    open(trigger) {
      const activation = getActivationState();
      const owner = captureOwner();
      if (!owner || !isCurrentOwner(owner)
        || !activation?.contractValid
        || activation.readState !== 'ready'
        || activation.status !== 'not_started'
        || !online
        || (!activation.canActivateSolo && !activation.canActivateGroup)) {
        onStatus('Challenge setup is not available until your signed-in activation status is confirmed.', { focus: true });
        return false;
      }
      flowOwner = owner;
      state = createChallengeStartFlowState({
        canActivateGroup: activation.canActivateGroup,
        canActivateSolo: activation.canActivateSolo,
      });
      dateInput.value = '';
      modeInputs.forEach((input) => { input.checked = false; });
      clearDateError();
      confirmButton.textContent = 'Confirm and start challenge';
      render();
      dialog.open(trigger);
      return true;
    },
    setOnline(nextOnline) {
      online = Boolean(nextOnline);
      if (!online && dialog.isOpen && !submitting) {
        dialog.setError('You are offline. Reconnect before continuing; no activation change was made.');
      } else if (online && dialog.isOpen) {
        dialog.clearError();
      }
      render();
    },
    closeForOwnerChange() {
      submitting = false;
      dialog.setBusy(false);
      dialog.close('owner-change');
      resetFlow();
    },
    destroy() {
      submitting = false;
      dialog.setBusy(false);
      dialog.destroy();
    },
  };
}
