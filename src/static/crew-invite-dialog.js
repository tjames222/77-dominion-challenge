import QRCode from 'qrcode';

import {
  getActiveCrewInvite,
  getLocalOrSessionUser,
  issueCrewInviteBundle,
  revokeCrewInvite,
} from './api';
import { createDialog } from './dialog.mjs';
import {
  CREW_INVITE_QR_FILENAME,
  canShareCrewInviteQr,
  canvasToPngBlob,
  createCrewInviteQrFile,
  crewInviteShareCopy,
  formatCrewInviteCode,
  invitationLifecycleCopy,
  inviteExpiryLabel,
  inviteUrlFromToken,
  isShareCancellation,
  nextInviteTabIndex,
  readableCrewInviteCode,
  renderCrewInviteQr,
} from './crew-invite.mjs';

const boundTriggers = new WeakSet();
let inviteDialogInstance = null;

function element(ownerDocument, tag, className = '', text = '') {
  const node = ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function writeClipboard(navigatorLike, value) {
  if (!navigatorLike?.clipboard?.writeText) {
    throw new Error('Copying is unavailable. Use your device share controls instead.');
  }
  await navigatorLike.clipboard.writeText(value);
}

function appendOfflineCopy(message, navigatorLike) {
  return navigatorLike?.onLine === false
    ? `${message} The recipient will need an internet connection to open it.`
    : message;
}

function setButtonBusyState(buttons, busy) {
  buttons.forEach((button) => {
    button.disabled = Boolean(busy);
    button.setAttribute('aria-disabled', String(Boolean(busy)));
  });
}

export function initCrewInviteDialog({
  document: ownerDocument = globalThis.document,
  window: windowLike = globalThis.window,
  trigger = ownerDocument?.getElementById?.('copyInviteButton'),
  getCrew = () => null,
} = {}) {
  if (!ownerDocument?.body || !trigger) return null;
  if (inviteDialogInstance) {
    if (!boundTriggers.has(trigger)) inviteDialogInstance.bindTrigger(trigger);
    return inviteDialogInstance;
  }

  const navigatorLike = windowLike?.navigator || globalThis.navigator;
  const content = element(ownerDocument, 'div', 'crew-invite-composer');

  const lifecycle = element(ownerDocument, 'section', 'crew-invite-lifecycle');
  lifecycle.setAttribute('aria-live', 'polite');
  lifecycle.setAttribute('aria-atomic', 'true');
  const lifecycleEyebrow = element(ownerDocument, 'p', 'eyebrow', 'Invitation status');
  const lifecycleTitle = element(ownerDocument, 'h3', '', 'No active invitation');
  const lifecycleMessage = element(ownerDocument, 'p', '', 'Generate one private invitation for one person.');
  const lifecycleFacts = element(ownerDocument, 'dl', 'crew-invite-facts');
  lifecycleFacts.innerHTML = `
    <div><dt>Invited by</dt><dd data-invite-fact="inviter">You</dd></div>
    <div><dt>Use</dt><dd>One person</dd></div>
    <div><dt>Expires</dt><dd data-invite-fact="expiry">After generation</dd></div>
  `;
  lifecycle.append(lifecycleEyebrow, lifecycleTitle, lifecycleMessage, lifecycleFacts);

  const generation = element(ownerDocument, 'div', 'crew-invite-generation');
  const generateButton = element(ownerDocument, 'button', 'primary', 'Generate invitation');
  generateButton.type = 'button';
  generateButton.dataset.inviteGenerate = '';
  generation.append(
    element(ownerDocument, 'p', '', 'One action creates a Link, Code, and QR for the same expiring invitation.'),
    generateButton,
  );

  const representationShell = element(ownerDocument, 'section', 'crew-invite-representations');
  representationShell.hidden = true;
  const tabs = element(ownerDocument, 'div', 'crew-invite-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Invitation format');
  const panels = element(ownerDocument, 'div', 'crew-invite-panels');
  const tabDefinitions = [
    ['link', 'Link'],
    ['code', 'Code'],
    ['qr', 'QR'],
  ];
  const tabButtons = [];
  const tabPanels = [];

  tabDefinitions.forEach(([key, label], index) => {
    const tab = element(ownerDocument, 'button', 'crew-invite-tab', label);
    tab.id = `crewInvite${label}Tab`;
    tab.type = 'button';
    tab.role = 'tab';
    tab.dataset.inviteTab = key;
    tab.setAttribute('aria-selected', String(index === 0));
    tab.setAttribute('aria-controls', `crewInvite${label}Panel`);
    tab.tabIndex = index === 0 ? 0 : -1;
    const panel = element(ownerDocument, 'section', 'crew-invite-panel');
    panel.id = `crewInvite${label}Panel`;
    panel.role = 'tabpanel';
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = index !== 0;
    tabs.append(tab);
    panels.append(panel);
    tabButtons.push(tab);
    tabPanels.push(panel);
  });

  const linkInput = ownerDocument.createElement('input');
  linkInput.className = 'crew-invite-link-value';
  linkInput.type = 'url';
  linkInput.readOnly = true;
  linkInput.autocomplete = 'off';
  linkInput.setAttribute('aria-label', 'Private crew join link');
  const linkActions = element(ownerDocument, 'div', 'crew-invite-panel-actions');
  const copyLinkButton = element(ownerDocument, 'button', 'secondary', 'Copy link');
  copyLinkButton.type = 'button';
  copyLinkButton.dataset.inviteAction = 'copy-link';
  const shareLinkButton = element(ownerDocument, 'button', 'primary', 'Share link');
  shareLinkButton.type = 'button';
  shareLinkButton.dataset.inviteAction = 'share-link';
  shareLinkButton.hidden = typeof navigatorLike?.share !== 'function';
  linkActions.append(shareLinkButton, copyLinkButton);
  tabPanels[0].append(
    element(ownerDocument, 'p', 'crew-invite-instructions', 'Send this private link to one person. Opening it shows a preview and never joins automatically.'),
    linkInput,
    linkActions,
  );

  const codeOutput = element(ownerDocument, 'output', 'crew-invite-code-value');
  codeOutput.id = 'crewInviteCodeValue';
  codeOutput.tabIndex = 0;
  const codeInstructions = element(
    ownerDocument,
    'p',
    'crew-invite-instructions',
    'The recipient enters this under Private Groups → Join a Crew. Case, spaces, and hyphens do not matter.',
  );
  const copyCodeButton = element(ownerDocument, 'button', 'primary', 'Copy code');
  copyCodeButton.type = 'button';
  copyCodeButton.dataset.inviteAction = 'copy-code';
  const codeActions = element(ownerDocument, 'div', 'crew-invite-panel-actions');
  codeActions.append(copyCodeButton);
  tabPanels[1].append(codeInstructions, codeOutput, codeActions);

  const qrFigure = element(ownerDocument, 'figure', 'crew-invite-qr-figure');
  const qrCanvas = ownerDocument.createElement('canvas');
  qrCanvas.id = 'crewInviteQrCanvas';
  qrCanvas.setAttribute('role', 'img');
  qrCanvas.setAttribute(
    'aria-label',
    'Scannable QR code for this one-person Dominion crew invitation. Copy link is the nonvisual alternative.',
  );
  const qrCaption = element(
    ownerDocument,
    'figcaption',
    '',
    'Scan with the phone’s normal camera. No Dominion camera permission is needed.',
  );
  qrFigure.append(qrCanvas, qrCaption);
  const qrActions = element(ownerDocument, 'div', 'crew-invite-panel-actions');
  const shareQrButton = element(ownerDocument, 'button', 'primary', 'Share QR code');
  shareQrButton.type = 'button';
  shareQrButton.dataset.inviteAction = 'share-qr';
  shareQrButton.hidden = true;
  const downloadQrButton = element(ownerDocument, 'button', 'secondary', 'Download QR code');
  downloadQrButton.type = 'button';
  downloadQrButton.dataset.inviteAction = 'download-qr';
  const qrCopyLinkButton = element(ownerDocument, 'button', 'secondary', 'Copy link');
  qrCopyLinkButton.type = 'button';
  qrCopyLinkButton.dataset.inviteAction = 'copy-link';
  qrActions.append(shareQrButton, downloadQrButton, qrCopyLinkButton);
  tabPanels[2].append(qrFigure, qrActions);
  representationShell.append(tabs, panels);

  const safety = element(
    ownerDocument,
    'p',
    'crew-invite-safety',
    'All three formats are one invitation. Using, revoking, replacing, or expiring one invalidates every format. No crew roster or member details are encoded in the QR.',
  );

  const lifecycleActions = element(ownerDocument, 'div', 'crew-invite-lifecycle-actions');
  lifecycleActions.hidden = true;
  const replaceButton = element(ownerDocument, 'button', 'secondary', 'Replace invitation');
  replaceButton.type = 'button';
  replaceButton.dataset.inviteLifecycle = 'replace';
  const revokeButton = element(ownerDocument, 'button', 'secondary destructive', 'Revoke invitation');
  revokeButton.type = 'button';
  revokeButton.dataset.inviteLifecycle = 'revoke';
  lifecycleActions.append(replaceButton, revokeButton);

  const confirmation = element(ownerDocument, 'div', 'crew-invite-inline-confirmation');
  confirmation.hidden = true;
  confirmation.setAttribute('role', 'group');
  const confirmationMessage = element(ownerDocument, 'p', '');
  const confirmationButtons = element(ownerDocument, 'div', 'crew-invite-confirmation-actions');
  const cancelConfirmationButton = element(ownerDocument, 'button', 'secondary', 'Cancel');
  cancelConfirmationButton.type = 'button';
  cancelConfirmationButton.dataset.inviteConfirmation = 'cancel';
  const confirmLifecycleButton = element(ownerDocument, 'button', 'primary', 'Confirm');
  confirmLifecycleButton.type = 'button';
  confirmLifecycleButton.dataset.inviteConfirmation = 'confirm';
  confirmationButtons.append(cancelConfirmationButton, confirmLifecycleButton);
  confirmation.append(confirmationMessage, confirmationButtons);

  const status = element(ownerDocument, 'p', 'crew-invite-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');

  content.append(
    lifecycle,
    generation,
    representationShell,
    safety,
    lifecycleActions,
    confirmation,
    status,
  );

  let currentCrew = null;
  let actorId = '';
  let metadata = { status: 'none' };
  let bundle = null;
  let qrBlob = null;
  let qrFile = null;
  let pendingLifecycleAction = '';
  let requestVersion = 0;

  const allActionButtons = [
    generateButton,
    copyLinkButton,
    shareLinkButton,
    copyCodeButton,
    shareQrButton,
    downloadQrButton,
    qrCopyLinkButton,
    replaceButton,
    revokeButton,
    cancelConfirmationButton,
    confirmLifecycleButton,
  ];

  const dialog = createDialog({
    document: ownerDocument,
    id: 'crewInviteDialog',
    eyebrow: 'Private Group',
    title: 'Invite People',
    description: 'Create one secure invitation, then choose Link, Code, or QR.',
    presentation: 'responsive',
    content,
    initialFocus: () => generation.hidden ? tabButtons[0] : generateButton,
    onOpen: () => { void loadMetadata(); },
    onClose: () => clearAccountScopedState(),
  });

  function setStatus(message = '') {
    status.textContent = String(message || '');
  }

  function selectTab(nextIndex, { focus = false } = {}) {
    tabButtons.forEach((tab, index) => {
      const selected = index === nextIndex;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tabPanels[index].hidden = !selected;
    });
    if (focus) tabButtons[nextIndex]?.focus();
  }

  function clearSecrets() {
    bundle = null;
    qrBlob = null;
    qrFile = null;
    linkInput.value = '';
    codeOutput.textContent = '';
    codeOutput.removeAttribute('aria-label');
    qrCanvas.width = 0;
    qrCanvas.height = 0;
    shareQrButton.hidden = true;
    representationShell.hidden = true;
  }

  function clearAccountScopedState() {
    requestVersion += 1;
    clearSecrets();
    actorId = '';
    currentCrew = null;
    metadata = { status: 'none' };
    pendingLifecycleAction = '';
    confirmation.hidden = true;
    lifecycleActions.hidden = true;
    generation.hidden = false;
    setStatus('');
    dialog.setBusy(false);
    dialog.clearError();
    setButtonBusyState(allActionButtons, false);
  }

  function renderLifecycle() {
    const copy = invitationLifecycleCopy(metadata);
    lifecycle.dataset.status = copy.tone;
    lifecycleTitle.textContent = copy.title;
    lifecycleMessage.textContent = copy.message;
    lifecycleFacts.querySelector('[data-invite-fact="inviter"]').textContent = 'You';
    lifecycleFacts.querySelector('[data-invite-fact="expiry"]').textContent = metadata.expiresAt
      ? inviteExpiryLabel(metadata.expiresAt)
      : 'After generation';
    generation.hidden = metadata.status === 'active';
    lifecycleActions.hidden = metadata.status !== 'active' || !confirmation.hidden;
    representationShell.hidden = !bundle;
  }

  async function currentActor() {
    const actor = await getLocalOrSessionUser();
    if (!actor?.authenticated || !actor.userId || actor.userId !== actorId) {
      clearAccountScopedState();
      const error = new Error('The signed-in account changed. Reopen Invite People to continue.');
      error.name = 'AbortError';
      throw error;
    }
    const crew = getCrew();
    if (!crew?.id || crew.id !== currentCrew?.id || !['owner', 'admin'].includes(crew.role)) {
      clearAccountScopedState();
      throw new Error('You no longer have permission to manage this invitation.');
    }
    return actor;
  }

  async function loadMetadata() {
    const version = ++requestVersion;
    clearSecrets();
    pendingLifecycleAction = '';
    confirmation.hidden = true;
    setStatus('');
    dialog.clearError();
    dialog.setBusy(true, 'Checking invitation status…');
    setButtonBusyState(allActionButtons, true);
    try {
      currentCrew = getCrew();
      const actor = await getLocalOrSessionUser();
      if (!currentCrew?.id || !['owner', 'admin'].includes(currentCrew.role)) {
        throw new Error('Only a private-group owner or admin can invite people.');
      }
      if (!actor?.authenticated || !actor.userId) {
        throw new Error('Log in again before creating an invitation.');
      }
      actorId = actor.userId;
      const nextMetadata = await getActiveCrewInvite(currentCrew.id, {
        expectedUserId: actorId,
      });
      if (version !== requestVersion || !dialog.isOpen) return;
      metadata = nextMetadata;
      renderLifecycle();
    } catch (error) {
      if (version !== requestVersion) return;
      dialog.setError(error?.message || 'Unable to load invitation status.');
      generation.hidden = true;
      lifecycleActions.hidden = true;
    } finally {
      if (version === requestVersion) {
        dialog.setBusy(false);
        setButtonBusyState(allActionButtons, false);
      }
    }
  }

  async function generateInvitation() {
    const version = ++requestVersion;
    let issuedInvite = null;
    dialog.clearError();
    setStatus('');
    dialog.setBusy(true, 'Generating one secure invitation…');
    setButtonBusyState(allActionButtons, true);
    try {
      await currentActor();
      const invite = await issueCrewInviteBundle(currentCrew.id, { expectedUserId: actorId });
      issuedInvite = invite;
      if (version !== requestVersion) return;
      const url = inviteUrlFromToken(invite.token, windowLike.location.href);
      const canvasResult = await renderCrewInviteQr(
        qrCanvas,
        url,
        QRCode.toCanvas.bind(QRCode),
        512,
      );
      if (version !== requestVersion || canvasResult.payload !== url) return;
      qrBlob = await canvasToPngBlob(qrCanvas);
      qrFile = createCrewInviteQrFile(qrBlob, windowLike.File || globalThis.File);
      bundle = {
        id: invite.id,
        token: invite.token,
        code: invite.code,
        url,
        expiresAt: invite.expires_at,
      };
      metadata = {
        status: 'active',
        inviteId: invite.id,
        codeHint: invite.code_hint,
        expiresAt: invite.expires_at,
        createdAt: new Date().toISOString(),
      };
      linkInput.value = url;
      codeOutput.textContent = formatCrewInviteCode(invite.code);
      codeOutput.setAttribute('aria-label', `Join code ${readableCrewInviteCode(invite.code)}`);
      shareQrButton.hidden = !canShareCrewInviteQr(navigatorLike, qrFile);
      selectTab(0);
      renderLifecycle();
      setStatus(appendOfflineCopy(
        'Invitation ready. Link, Code, and QR now expire and revoke together.',
        navigatorLike,
      ));
      tabButtons[0].focus();
    } catch (error) {
      clearSecrets();
      if (issuedInvite?.id && version === requestVersion) {
        metadata = {
          status: 'active',
          inviteId: issuedInvite.id,
          codeHint: issuedInvite.code_hint,
          expiresAt: issuedInvite.expires_at,
          createdAt: new Date().toISOString(),
        };
        renderLifecycle();
      }
      if (error?.name !== 'AbortError') {
        dialog.setError(issuedInvite?.id
          ? 'The invitation was created, but its share formats could not be prepared. Revoke it or replace it after a few seconds.'
          : error?.message || 'Unable to generate an invitation right now.');
      }
    } finally {
      if (version === requestVersion) {
        dialog.setBusy(false);
        setButtonBusyState(allActionButtons, false);
      }
    }
  }

  function beginLifecycleConfirmation(action) {
    pendingLifecycleAction = action;
    confirmation.hidden = false;
    lifecycleActions.hidden = true;
    confirmation.setAttribute(
      'aria-label',
      action === 'replace' ? 'Confirm invitation replacement' : 'Confirm invitation revocation',
    );
    confirmationMessage.textContent = action === 'replace'
      ? 'Replace this invitation? Its current link, code, and QR stop working immediately.'
      : 'Revoke this invitation? Its link, code, and QR stop working immediately.';
    confirmLifecycleButton.textContent = action === 'replace' ? 'Replace invitation' : 'Revoke invitation';
    confirmLifecycleButton.className = action === 'replace' ? 'primary' : 'primary destructive';
    cancelConfirmationButton.focus();
  }

  function cancelLifecycleConfirmation() {
    pendingLifecycleAction = '';
    confirmation.hidden = true;
    renderLifecycle();
    (metadata.status === 'active' ? replaceButton : generateButton).focus();
  }

  async function confirmLifecycleAction() {
    const action = pendingLifecycleAction;
    if (!['replace', 'revoke'].includes(action)) return;
    if (action === 'replace') {
      confirmation.hidden = true;
      pendingLifecycleAction = '';
      await generateInvitation();
      return;
    }

    const version = ++requestVersion;
    dialog.clearError();
    setStatus('');
    dialog.setBusy(true, 'Revoking every invitation format…');
    setButtonBusyState(allActionButtons, true);
    try {
      await currentActor();
      await revokeCrewInvite(metadata.inviteId, { expectedUserId: actorId });
      if (version !== requestVersion) return;
      clearSecrets();
      metadata = { status: 'revoked' };
      pendingLifecycleAction = '';
      confirmation.hidden = true;
      renderLifecycle();
      setStatus('Invitation revoked. Its Link, Code, and QR no longer work.');
      generateButton.focus();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        dialog.setError(error?.message || 'Unable to revoke this invitation.');
      }
    } finally {
      if (version === requestVersion) {
        dialog.setBusy(false);
        setButtonBusyState(allActionButtons, false);
      }
    }
  }

  async function runRepresentationAction(action) {
    if (!bundle) return;
    dialog.clearError();
    setStatus('');
    setButtonBusyState(allActionButtons, true);
    try {
      await currentActor();
      if (action === 'copy-link') {
        await writeClipboard(navigatorLike, bundle.url);
        setStatus(appendOfflineCopy('Private invitation link copied.', navigatorLike));
        return;
      }
      if (action === 'copy-code') {
        await writeClipboard(navigatorLike, formatCrewInviteCode(bundle.code));
        setStatus(appendOfflineCopy('One-person join code copied.', navigatorLike));
        return;
      }
      if (action === 'share-link') {
        await navigatorLike.share(crewInviteShareCopy({ crewName: currentCrew.name, url: bundle.url }));
        setStatus('Invitation shared. It remains active until one person joins or it expires.');
        return;
      }
      if (action === 'share-qr') {
        if (!canShareCrewInviteQr(navigatorLike, qrFile)) {
          throw new Error('Image sharing is unavailable. Download the QR code or copy the link.');
        }
        await navigatorLike.share({
          title: 'Dominion crew invitation',
          text: 'Scan this private one-person Dominion crew invitation.',
          files: [qrFile],
        });
        setStatus('QR code shared. It carries the same one-person invitation as the link and code.');
        return;
      }
      if (action === 'download-qr') {
        const objectUrl = windowLike.URL.createObjectURL(qrBlob);
        const download = ownerDocument.createElement('a');
        download.href = objectUrl;
        download.download = CREW_INVITE_QR_FILENAME;
        download.rel = 'noopener';
        download.click();
        windowLike.setTimeout(() => windowLike.URL.revokeObjectURL(objectUrl), 0);
        setStatus(appendOfflineCopy('QR code downloaded as dominion-crew-invite.png.', navigatorLike));
      }
    } catch (error) {
      if (isShareCancellation(error)) {
        setStatus('Share canceled. The invitation is still active and unchanged.');
      } else if (error?.name !== 'AbortError') {
        dialog.setError(error?.message || 'That invitation action could not be completed.');
      }
    } finally {
      setButtonBusyState(allActionButtons, false);
    }
  }

  tabButtons.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      selectTab(nextInviteTabIndex({
        currentIndex: index,
        key: event.key,
        count: tabButtons.length,
      }), { focus: true });
    });
  });

  generateButton.addEventListener('click', () => { void generateInvitation(); });
  representationShell.addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-invite-action]');
    if (actionButton) void runRepresentationAction(actionButton.dataset.inviteAction);
  });
  replaceButton.addEventListener('click', () => beginLifecycleConfirmation('replace'));
  revokeButton.addEventListener('click', () => beginLifecycleConfirmation('revoke'));
  cancelConfirmationButton.addEventListener('click', cancelLifecycleConfirmation);
  confirmLifecycleButton.addEventListener('click', () => { void confirmLifecycleAction(); });

  const bindTrigger = (nextTrigger) => {
    if (!nextTrigger || boundTriggers.has(nextTrigger)) return;
    boundTriggers.add(nextTrigger);
    nextTrigger.setAttribute('aria-haspopup', 'dialog');
    nextTrigger.setAttribute('aria-controls', 'crewInviteDialog');
    nextTrigger.addEventListener('click', () => dialog.open(nextTrigger));
  };

  inviteDialogInstance = {
    bindTrigger,
    dialog,
    reset: clearAccountScopedState,
  };
  bindTrigger(trigger);
  return inviteDialogInstance;
}
