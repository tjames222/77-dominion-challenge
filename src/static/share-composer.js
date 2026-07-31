import {
  completeSharingReward,
  createShareSnapshot,
  createSharingRewardIntent,
  getCrews,
  getLocalOrSessionUser,
  getOrCreateCrewInvite,
  previewShareSnapshot,
} from './api';
import { createDialog } from './dialog.mjs';
import {
  SHARE_FLOWS,
  executeInviteShare,
  executeSnapshotShare,
  normalizeShareKind,
} from './share-composer.mjs';

let shareComposerInstance = null;
const boundShareTriggers = new WeakSet();

function element(ownerDocument, tag, className, text = '') {
  const node = ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function selectedManagedCrew(crews, select) {
  const selectedId = select?.value || localStorage.getItem('dominion:activeCrewId') || '';
  return crews.find((crew) => crew.id === selectedId) || crews[0] || null;
}

async function writeClipboard(value) {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Copying is unavailable in this browser. Try the device share button.');
  }
  await navigator.clipboard.writeText(value);
}

export function closeShareComposer(reason = 'auth-change') {
  shareComposerInstance?.reset?.(reason);
}

export function initShareComposer(ownerDocument = globalThis.document) {
  if (!ownerDocument?.querySelectorAll) return null;
  const triggers = [...ownerDocument.querySelectorAll('[data-share-composer]')];
  if (!triggers.length) return shareComposerInstance;

  if (shareComposerInstance) {
    shareComposerInstance.bindTriggers(triggers);
    return shareComposerInstance;
  }

  let currentKind = 'progress';
  let managedCrews = [];
  let previewRequest = 0;
  let actionRequest = 0;
  let working = false;

  const content = element(ownerDocument, 'div', 'share-composer');
  const choices = element(ownerDocument, 'fieldset', 'share-flow-options');
  const legend = element(ownerDocument, 'legend', '', 'Choose what to share');
  choices.append(legend);

  Object.values(SHARE_FLOWS).forEach((flow) => {
    const label = element(ownerDocument, 'label', 'share-flow-option');
    const input = ownerDocument.createElement('input');
    input.type = 'radio';
    input.name = 'share-flow';
    input.value = flow.kind;
    input.dataset.shareFlow = flow.kind;
    const copy = element(ownerDocument, 'span', '');
    copy.append(
      element(ownerDocument, 'strong', '', flow.label),
      element(ownerDocument, 'small', '', flow.description),
    );
    label.append(input, copy);
    choices.append(label);
  });

  const preview = element(ownerDocument, 'article', 'share-composer-preview');
  preview.setAttribute('aria-live', 'polite');
  preview.setAttribute('aria-atomic', 'true');
  const previewEyebrow = element(ownerDocument, 'p', 'eyebrow', 'Share preview');
  const previewMetric = element(ownerDocument, 'strong', 'share-preview-metric', '—');
  const previewMetricLabel = element(ownerDocument, 'span', 'share-preview-metric-label', '');
  const previewTitle = element(ownerDocument, 'h3', '', 'Choose something to share.');
  const previewDescription = element(ownerDocument, 'p', '', 'A privacy-safe preview will appear here.');
  const privacyNote = element(
    ownerDocument,
    'p',
    'share-privacy-note',
    'Public progress links never include your name, email, group, journal, action history, or exact activity dates.',
  );
  preview.append(
    previewEyebrow,
    previewMetric,
    previewMetricLabel,
    previewTitle,
    previewDescription,
    privacyNote,
  );

  const crewField = element(ownerDocument, 'label', 'share-crew-field');
  crewField.hidden = true;
  crewField.append(element(ownerDocument, 'span', '', 'Private group'));
  const crewSelect = ownerDocument.createElement('select');
  crewSelect.id = 'shareCrewSelect';
  crewField.append(crewSelect);

  const rewardNote = element(ownerDocument, 'p', 'share-reward-note');
  const actionRow = element(ownerDocument, 'div', 'share-composer-actions');
  const nativeButton = element(ownerDocument, 'button', 'primary', 'Share from this device');
  nativeButton.type = 'button';
  nativeButton.dataset.shareMethod = 'native_share';
  nativeButton.hidden = typeof navigator.share !== 'function';
  const copyButton = element(ownerDocument, 'button', 'secondary', 'Copy share link');
  copyButton.type = 'button';
  copyButton.dataset.shareMethod = 'copy_link';
  actionRow.append(nativeButton, copyButton);

  const status = element(ownerDocument, 'p', 'share-composer-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  content.append(choices, preview, crewField, rewardNote, actionRow, status);

  const dialog = createDialog({
    id: 'shareComposerDialog',
    eyebrow: 'Share Dominion',
    title: 'Choose what you want to send',
    description: 'Preview server-verified progress, then use your device share sheet or copy a link.',
    presentation: 'responsive',
    content,
    initialFocus: (panel) => panel.querySelector('[data-share-flow]:checked'),
    onClose: () => {
      previewRequest += 1;
      status.textContent = '';
    },
  });

  const setActionsDisabled = (disabled) => {
    [nativeButton, copyButton].forEach((button) => {
      button.disabled = Boolean(disabled);
      button.setAttribute('aria-disabled', String(Boolean(disabled)));
    });
  };

  const renderManagedCrews = () => {
    const rememberedId = localStorage.getItem('dominion:activeCrewId') || '';
    crewSelect.replaceChildren();
    managedCrews.forEach((crew) => {
      const option = ownerDocument.createElement('option');
      option.value = crew.id;
      option.textContent = crew.name;
      option.selected = crew.id === rememberedId;
      crewSelect.append(option);
    });
  };

  const refreshPreview = async () => {
    const requestId = ++previewRequest;
    const flow = SHARE_FLOWS[currentKind];
    status.textContent = '';
    dialog.clearError();
    dialog.setBusy(true, 'Loading a privacy-safe preview…');
    setActionsDisabled(true);
    crewField.hidden = currentKind !== 'invite';
    rewardNote.textContent = currentKind === 'invite'
      ? 'Your one-time +14 Sharing reward and badge unlock after another account joins from your invitation.'
      : 'Your first completed native share or copied link earns a one-time +14 Sharing reward and badge.';

    try {
      if (currentKind === 'invite') {
        const crews = await getCrews();
        const nextManagedCrews = (crews || []).filter((crew) => ['owner', 'admin'].includes(crew.role));
        if (requestId !== previewRequest) return;
        managedCrews = nextManagedCrews;
        renderManagedCrews();
        const crew = selectedManagedCrew(managedCrews, crewSelect);
        previewEyebrow.textContent = 'Private invitation';
        previewMetric.textContent = crew ? '1:1' : '—';
        previewMetricLabel.textContent = crew ? 'secure invitation' : 'no managed group';
        previewTitle.textContent = crew ? `Invite someone to ${crew.name}` : 'Create or manage a private group first';
        previewDescription.textContent = crew
          ? 'The link shows the group name, your first name, and its expiration. Membership requires an explicit signed-in confirmation.'
          : 'Only group owners and admins can issue an invitation.';
        privacyNote.textContent = 'Invitation secrets stay in the URL fragment and are stored only as hashes on the server.';
        setActionsDisabled(!crew);
      } else {
        const snapshot = await previewShareSnapshot(currentKind);
        if (requestId !== previewRequest) return;
        const presentation = snapshot?.presentation || {};
        previewEyebrow.textContent = presentation.eyebrow || flow.label;
        previewMetric.textContent = presentation.metric || '77';
        previewMetricLabel.textContent = presentation.metricLabel || '';
        previewTitle.textContent = presentation.title || flow.label;
        previewDescription.textContent = presentation.description || flow.description;
        privacyNote.textContent = 'Public progress links never include your name, email, group, journal, action history, or exact activity dates.';
        setActionsDisabled(false);
      }
    } catch (error) {
      if (requestId !== previewRequest) return;
      previewMetric.textContent = '—';
      previewMetricLabel.textContent = '';
      previewTitle.textContent = 'Preview unavailable';
      previewDescription.textContent = 'Try again before sharing.';
      setActionsDisabled(true);
      dialog.setError(error?.message || 'Unable to prepare this share.');
    } finally {
      if (requestId === previewRequest) dialog.setBusy(false);
    }
  };

  const chooseKind = (kind) => {
    currentKind = normalizeShareKind(kind);
    choices.querySelectorAll('[data-share-flow]').forEach((input) => {
      input.checked = input.value === currentKind;
    });
    void refreshPreview();
  };

  choices.addEventListener('change', (event) => {
    if (event.target?.matches?.('[data-share-flow]')) chooseKind(event.target.value);
  });

  crewSelect.addEventListener('change', () => {
    const crew = selectedManagedCrew(managedCrews, crewSelect);
    if (!crew) return;
    localStorage.setItem('dominion:activeCrewId', crew.id);
    previewTitle.textContent = `Invite someone to ${crew.name}`;
  });

  actionRow.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-share-method]');
    if (!button || working) return;
    const requestId = ++actionRequest;
    const method = button.dataset.shareMethod;
    const actionKind = currentKind;
    const actionCrew = actionKind === 'invite'
      ? selectedManagedCrew(managedCrews, crewSelect)
      : null;
    working = true;
    status.textContent = '';
    dialog.clearError();
    dialog.setBusy(true, method === 'native_share' ? 'Opening your share sheet…' : 'Creating and copying your link…');
    setActionsDisabled(true);
    choices.disabled = true;
    crewSelect.disabled = true;

    try {
      const actionOwner = await getLocalOrSessionUser();
      const expectedUserId = actionOwner?.userId || '';
      if (!actionOwner?.authenticated || !expectedUserId || requestId !== actionRequest) {
        const error = new Error('The signed-in account changed before sharing started.');
        error.name = 'AbortError';
        throw error;
      }
      const shouldContinue = () => requestId === actionRequest;
      let result;
      if (actionKind === 'invite') {
        result = await executeInviteShare({
          crew: actionCrew,
          method,
          createInvite: (crewId) => getOrCreateCrewInvite(crewId, { expectedUserId }),
          baseUrl: window.location.href,
          nativeShare: navigator.share?.bind(navigator),
          copyText: writeClipboard,
          shouldContinue,
        });
        if (requestId !== actionRequest) return;
        status.textContent = method === 'native_share'
          ? 'Invitation shared. Your Sharing reward unlocks after another person joins.'
          : 'Invitation copied. Your Sharing reward unlocks after another person joins.';
      } else {
        result = await executeSnapshotShare({
          kind: actionKind,
          method,
          createSnapshot: (kind) => createShareSnapshot(kind, { expectedUserId }),
          createRewardIntent: (shareKind) => createSharingRewardIntent(shareKind, { expectedUserId }),
          completeReward: (completionToken) => completeSharingReward(completionToken, { expectedUserId }),
          nativeShare: navigator.share?.bind(navigator),
          copyText: writeClipboard,
          shouldContinue,
        });
        if (requestId !== actionRequest) return;
        if (result.reward?.granted) {
          status.textContent = `Shared successfully. You earned +${result.reward.points || 14} points and the Sharing badge.`;
        } else if (result.reward?.alreadyGranted) {
          status.textContent = 'Shared successfully. Your lifetime Sharing reward was already earned.';
        } else {
          status.textContent = method === 'native_share' ? 'Shared successfully.' : 'Share link copied.';
        }
      }
    } catch (error) {
      if (requestId !== actionRequest) return;
      if (error?.name === 'AbortError') {
        status.textContent = 'Share canceled. No Sharing reward was granted.';
      } else {
        dialog.setError(error?.message || 'Unable to share right now.');
      }
    } finally {
      if (requestId === actionRequest) {
        working = false;
        dialog.setBusy(false);
        choices.disabled = false;
        crewSelect.disabled = false;
        setActionsDisabled(currentKind === 'invite' && !selectedManagedCrew(managedCrews, crewSelect));
      }
    }
  });

  const reset = () => {
    previewRequest += 1;
    actionRequest += 1;
    working = false;
    managedCrews = [];
    currentKind = 'progress';
    dialog.close('replaced');
    dialog.setBusy(false);
    dialog.clearError();
    choices.disabled = false;
    crewSelect.disabled = false;
    choices.querySelectorAll('[data-share-flow]').forEach((input) => {
      input.checked = input.value === currentKind;
    });
    crewSelect.replaceChildren();
    crewField.hidden = true;
    previewEyebrow.textContent = 'Share preview';
    previewMetric.textContent = '—';
    previewMetricLabel.textContent = '';
    previewTitle.textContent = 'Choose something to share.';
    previewDescription.textContent = 'A privacy-safe preview will appear here.';
    privacyNote.textContent = 'Public progress links never include your name, email, group, journal, action history, or exact activity dates.';
    rewardNote.textContent = '';
    status.textContent = '';
    setActionsDisabled(true);
  };

  const bindTriggers = (nextTriggers = []) => {
    nextTriggers.forEach((trigger) => {
      if (boundShareTriggers.has(trigger)) return;
      boundShareTriggers.add(trigger);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', 'shareComposerDialog');
      trigger.addEventListener('click', () => {
        dialog.open(trigger);
        chooseKind(trigger.dataset.shareKind);
      });
    });
  };

  shareComposerInstance = { dialog, bindTriggers, reset };
  bindTriggers(triggers);
  ownerDocument.documentElement.dataset.shareComposerReady = 'true';
  return shareComposerInstance;
}

initShareComposer();
