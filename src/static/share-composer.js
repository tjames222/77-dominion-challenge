import {
  completeSharingReward,
  createShareSnapshot,
  createSharingRewardIntent,
  getCrews,
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

const triggers = [...document.querySelectorAll('[data-share-composer]')];

function element(tag, className, text = '') {
  const node = document.createElement(tag);
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

if (triggers.length) {
  let currentKind = 'progress';
  let managedCrews = [];
  let previewRequest = 0;
  let working = false;

  const content = element('div', 'share-composer');
  const choices = element('fieldset', 'share-flow-options');
  const legend = element('legend', '', 'Choose what to share');
  choices.append(legend);

  Object.values(SHARE_FLOWS).forEach((flow) => {
    const label = element('label', 'share-flow-option');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'share-flow';
    input.value = flow.kind;
    input.dataset.shareFlow = flow.kind;
    const copy = element('span', '');
    copy.append(element('strong', '', flow.label), element('small', '', flow.description));
    label.append(input, copy);
    choices.append(label);
  });

  const preview = element('article', 'share-composer-preview');
  preview.setAttribute('aria-live', 'polite');
  preview.setAttribute('aria-atomic', 'true');
  const previewEyebrow = element('p', 'eyebrow', 'Share preview');
  const previewMetric = element('strong', 'share-preview-metric', '—');
  const previewMetricLabel = element('span', 'share-preview-metric-label', '');
  const previewTitle = element('h3', '', 'Choose something to share.');
  const previewDescription = element('p', '', 'A privacy-safe preview will appear here.');
  const privacyNote = element(
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

  const crewField = element('label', 'share-crew-field');
  crewField.hidden = true;
  crewField.append(element('span', '', 'Private group'));
  const crewSelect = document.createElement('select');
  crewSelect.id = 'shareCrewSelect';
  crewField.append(crewSelect);

  const rewardNote = element('p', 'share-reward-note');
  const actionRow = element('div', 'share-composer-actions');
  const nativeButton = element('button', 'primary', 'Share from this device');
  nativeButton.type = 'button';
  nativeButton.dataset.shareMethod = 'native_share';
  nativeButton.hidden = typeof navigator.share !== 'function';
  const copyButton = element('button', 'secondary', 'Copy share link');
  copyButton.type = 'button';
  copyButton.dataset.shareMethod = 'copy_link';
  actionRow.append(nativeButton, copyButton);

  const status = element('p', 'share-composer-status');
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
      const option = document.createElement('option');
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
        managedCrews = (crews || []).filter((crew) => ['owner', 'admin'].includes(crew.role));
        if (requestId !== previewRequest) return;
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
    const method = button.dataset.shareMethod;
    working = true;
    status.textContent = '';
    dialog.clearError();
    dialog.setBusy(true, method === 'native_share' ? 'Opening your share sheet…' : 'Creating and copying your link…');
    setActionsDisabled(true);

    try {
      let result;
      if (currentKind === 'invite') {
        const crew = selectedManagedCrew(managedCrews, crewSelect);
        result = await executeInviteShare({
          crew,
          method,
          createInvite: getOrCreateCrewInvite,
          baseUrl: window.location.href,
          nativeShare: navigator.share?.bind(navigator),
          copyText: writeClipboard,
        });
        status.textContent = method === 'native_share'
          ? 'Invitation shared. Your Sharing reward unlocks after another person joins.'
          : 'Invitation copied. Your Sharing reward unlocks after another person joins.';
      } else {
        result = await executeSnapshotShare({
          kind: currentKind,
          method,
          createSnapshot: createShareSnapshot,
          createRewardIntent: createSharingRewardIntent,
          completeReward: completeSharingReward,
          nativeShare: navigator.share?.bind(navigator),
          copyText: writeClipboard,
        });
        if (result.reward?.granted) {
          status.textContent = `Shared successfully. You earned +${result.reward.points || 14} points and the Sharing badge.`;
        } else if (result.reward?.alreadyGranted) {
          status.textContent = 'Shared successfully. Your lifetime Sharing reward was already earned.';
        } else {
          status.textContent = method === 'native_share' ? 'Shared successfully.' : 'Share link copied.';
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        status.textContent = 'Share canceled. No Sharing reward was granted.';
      } else {
        dialog.setError(error?.message || 'Unable to share right now.');
      }
    } finally {
      working = false;
      dialog.setBusy(false);
      setActionsDisabled(currentKind === 'invite' && !selectedManagedCrew(managedCrews, crewSelect));
    }
  });

  triggers.forEach((trigger) => {
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', 'shareComposerDialog');
    trigger.addEventListener('click', () => {
      dialog.open(trigger);
      chooseKind(trigger.dataset.shareKind);
    });
  });

  document.documentElement.dataset.shareComposerReady = 'true';
}
