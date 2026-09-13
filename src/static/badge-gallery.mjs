import { createDialog } from './dialog.mjs';
import { iconClass, normalizeEarnedBadges, validBadgeTimestamp } from './badges-rewards.mjs';

const sentence = (value, limit = 1200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const positiveInteger = (value, maximum = 10000) => Number.isInteger(value) && value > 0 && value <= maximum ? value : null;
const dateLabel = (value) => {
  const timestamp = validBadgeTimestamp(value);
  return timestamp === null ? '' : new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(timestamp));
};

// Only this documented, versioned allowlist becomes customer-facing evidence.
// Never render arbitrary metadata, source IDs, user IDs, or free-form payloads.
export function badgeEvidenceSummary(evidence) {
  if (!evidence || evidence.schemaVersion !== 1) return '';
  const value = positiveInteger(evidence.qualifyingValue);
  switch (evidence.kind) {
    case 'check_in': return value ? `Posting ${value === 1 ? 'your first check-in' : `${value} check-ins`}.` : '';
    case 'perfect_streak': return value ? `Reaching a ${value}-day perfect streak.` : '';
    case 'app_streak': return value ? `Returning to the app for ${value} consecutive days.` : '';
    case 'app_visit': return value ? `Visiting the app on ${value} ${value === 1 ? 'day' : 'days'}.` : '';
    case 'daily_standards': return positiveInteger(evidence.completedCount, 7)
      ? `Completing ${evidence.completedCount} of the seven Daily Actions in your qualifying check-in.` : '';
    case 'workout': {
      const workout = new Map([['one', 'Workout One'], ['two', 'Workout Two']]).get(evidence.workout);
      const difficulty = new Map([['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['extreme', 'Extreme']]).get(evidence.difficulty);
      return workout && difficulty ? `Completing ${workout} at ${difficulty} difficulty.` : '';
    }
    case 'share': return value ? `Sharing your progress ${value === 1 ? 'once' : `${value} times`}.` : '';
    case 'challenge_completion': return value ? `Completing ${value} ${value === 1 ? 'challenge' : 'challenges'}.` : '';
    default: return '';
  }
}

export function badgeGalleryModel(records = []) {
  return normalizeEarnedBadges(records).map((badge) => {
    const name = sentence(badge.name, 200) || 'Badge';
    const tierLabel = `${badge.tier[0].toUpperCase()}${badge.tier.slice(1)} badge`;
    const earnedLabel = dateLabel(badge.earnedAt);
    return {
      key: badge.key,
      name,
      description: sentence(badge.description),
      requirement: sentence(badge.requirement) || 'The original requirement is unavailable for this legacy badge.',
      tier: badge.tier,
      tierLabel,
      iconClass: iconClass(badge.icon, 'shield'),
      earnedLabel,
      evidenceSummary: badge.legacy ? '' : badgeEvidenceSummary(badge.earningEvidence),
      retired: badge.retired,
      accessibleName: `View ${name} badge details — ${tierLabel}${earnedLabel ? `, earned ${earnedLabel}` : ''}`,
    };
  });
}

function element(document, tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function createBadgeGallery(container) {
  const document = container.ownerDocument;
  const buttons = new Map();
  let records = new Map();
  let selectedKey = '';
  let dialog = null;

  function clearDialog() {
    const previous = dialog;
    dialog = null;
    selectedKey = '';
    previous?.destroy();
    for (const button of buttons.values()) button.setAttribute('aria-expanded', 'false');
  }

  function open(key, trigger) {
    const badge = records.get(key);
    if (!badge) return;
    clearDialog();
    selectedKey = key;
    trigger.setAttribute('aria-expanded', 'true');
    dialog = createDialog({
      document,
      title: badge.name,
      eyebrow: badge.tierLabel,
      description: badge.description || 'Your earned badge details.',
      closeLabel: 'Close badge details',
      initialFocus: '.app-dialog-close',
      pattern: 'badge-detail',
      content: ({ container: body }) => {
        const medallion = element(document, 'div', 'badge-medallion badge-detail-medallion');
        medallion.dataset.badgeTier = badge.tier;
        medallion.setAttribute('aria-hidden', 'true');
        medallion.append(element(document, 'span', `app-icon ${badge.iconClass}`));
        body.append(medallion, element(document, 'h3', '', 'How you earned it'));
        const requirement = element(document, 'p', 'badge-detail-requirement');
        requirement.append(element(document, 'strong', '', 'Requirement: '), document.createTextNode(badge.requirement));
        body.append(requirement);
        const evidence = element(document, 'p', 'badge-detail-evidence');
        if (badge.evidenceSummary) {
          evidence.append(element(document, 'strong', '', 'You earned it by: '), document.createTextNode(badge.evidenceSummary));
        } else {
          evidence.textContent = 'Detailed earning history is unavailable for this legacy badge.';
        }
        body.append(evidence);
        if (badge.earnedLabel) body.append(element(document, 'p', 'badge-detail-date', `Earned ${badge.earnedLabel}`));
        if (badge.retired) body.append(element(document, 'p', 'badge-detail-legacy', 'Retired badge — part of your earned collection.'));
      },
      onClose: () => {
        selectedKey = '';
        trigger.setAttribute('aria-expanded', 'false');
      },
    });
    dialog.elements.panel.classList.add('badge-detail-panel');
    dialog.open(trigger);
  }

  const onClick = (event) => {
    const button = event.target.closest('[data-badge-key]');
    if (button && container.contains(button)) open(button.dataset.badgeKey, button);
  };
  container.addEventListener('click', onClick);

  return {
    render(rawRecords) {
      const model = badgeGalleryModel(rawRecords);
      records = new Map(model.map((badge) => [badge.key, badge]));
      if (selectedKey && !records.has(selectedKey)) clearDialog();
      for (const [key, button] of buttons) {
        if (!records.has(key)) { button.remove(); buttons.delete(key); }
      }
      container.querySelectorAll('[data-badge-placeholder]').forEach((node) => node.remove());
      model.forEach((badge, index) => {
        let button = buttons.get(badge.key);
        if (!button) {
          button = element(document, 'button', 'badge-gallery-tile');
          button.type = 'button';
          button.dataset.badgeKey = badge.key;
          button.setAttribute('aria-haspopup', 'dialog');
          buttons.set(badge.key, button);
        }
        button.dataset.badgeTier = badge.tier;
        button.setAttribute('aria-label', badge.accessibleName);
        button.setAttribute('aria-expanded', String(selectedKey === badge.key));
        const medallion = element(document, 'span', 'badge-medallion');
        medallion.setAttribute('aria-hidden', 'true');
        medallion.append(element(document, 'span', `app-icon ${badge.iconClass}`));
        button.replaceChildren(medallion);
        // Reconcile keyed nodes so a remote insertion preserves the exact dialog
        // trigger and focus target; do not rebuild or change an open dialog.
        if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
      });
      if (!model.length) {
        const empty = element(document, 'div', 'badges-rewards-empty');
        empty.dataset.badgePlaceholder = '';
        empty.append(element(document, 'strong', '', 'Your first badge is waiting.'),
          element(document, 'span', '', 'Complete an honest check-in to add proof of the work here.'));
        container.append(empty);
      }
      container.setAttribute('aria-busy', 'false');
      return model.length;
    },
    clear() {
      clearDialog();
      records.clear();
      buttons.clear();
      container.replaceChildren();
    },
    destroy() { this.clear(); container.removeEventListener('click', onClick); },
  };
}
