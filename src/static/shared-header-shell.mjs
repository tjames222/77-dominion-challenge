// The small, inert shell reserves the existing touch-target geometry while the
// member-only controller loads. It performs no reads, writes or Auth work.
function element(document, tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createAuthenticatedHeaderShell(topbar, document = globalThis.document) {
  topbar.classList.add('has-authenticated-header-actions');
  let trailing = topbar.querySelector('.topbar-trailing-actions');
  if (!trailing) {
    trailing = element(document, 'div', 'topbar-trailing-actions');
    topbar.append(trailing);
  }
  // An open drawer lifts the button into body. Move its placeholder instead,
  // so closing the drawer restores the same slot even during a slow import.
  const slot = topbar.querySelector('.global-menu-button, .global-menu-button-placeholder');
  if (slot && slot.parentElement !== trailing) trailing.append(slot);
  const actionGroup = element(document, 'div', 'authenticated-header-actions');
  actionGroup.setAttribute('role', 'group');
  actionGroup.setAttribute('aria-label', 'Member actions');
  actionGroup.setAttribute('aria-busy', 'true');
  const shareButton = element(document, 'button', 'shared-header-action shared-header-share');
  shareButton.type = 'button';
  shareButton.disabled = true;
  shareButton.setAttribute('aria-label', 'Share progress: loading member controls.');
  shareButton.dataset.trainingTarget = 'global-share';
  shareButton.append(element(document, 'span', 'app-icon icon-share'),
    element(document, 'span', 'shared-header-action-label', 'Share'));
  shareButton.querySelector('.app-icon').setAttribute('aria-hidden', 'true');
  const streakButton = element(document, 'button', 'shared-header-action shared-header-streak');
  streakButton.type = 'button';
  streakButton.disabled = true;
  streakButton.setAttribute('aria-haspopup', 'dialog');
  streakButton.setAttribute('aria-controls', 'globalStreakDetailsDialog');
  streakButton.setAttribute('aria-expanded', 'false');
  streakButton.setAttribute('aria-label', 'App streak: loading member controls.');
  streakButton.dataset.trainingTarget = 'global-app-streak';
  const icon = element(document, 'span', 'app-icon icon-lightning');
  icon.setAttribute('aria-hidden', 'true');
  const streakCount = element(document, 'strong', 'shared-header-streak-count', '—');
  streakCount.dataset.globalAppStreakCount = '';
  const streakLabel = element(document, 'span', 'shared-header-action-label', 'App Streak');
  streakButton.append(icon, streakLabel, streakCount);
  actionGroup.append(shareButton, streakButton);
  trailing.insertBefore(actionGroup, slot || null);
  return { actionGroup, shareButton, streakButton, streakCount, streakLabel,
    destroy() { actionGroup.remove(); topbar.classList.remove('has-authenticated-header-actions'); } };
}
