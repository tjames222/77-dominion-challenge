import { normalizeAdminActivationReviewHealth, activationReviewTimestamp } from './admin-activation-review-health.mjs';

const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
};

// Manual-only, with no response/identity cache. Existing Admin owner/session
// invalidation is supplemented by a local generation fence for tab changes and
// callbacks whose transport ignored abort. Errors never become zero counts.
export function mountActivationReviewHealth({ root, read, getOwner, isCurrent, onAuthorityError }) {
  const refresh = root.querySelector('#adminActivationReviewRefresh');
  const status = root.querySelector('#adminActivationReviewStatus');
  const data = root.querySelector('#adminActivationReviewData');
  let generation = 0; let controller = null;
  const clear = ({ ready = false } = {}) => {
    generation += 1; controller?.abort(); controller = null;
    data.replaceChildren(); root.removeAttribute('aria-busy'); refresh.removeAttribute('aria-disabled');
    status.textContent = ready ? 'Not checked. Refresh to read unresolved legacy activation reviews.' : '';
  };
  async function load() {
    const owner = getOwner(); if (controller || !owner || !isCurrent(owner)) return;
    clear(); const captured = generation; controller = new AbortController(); const signal = controller.signal;
    // A stable aria-disabled control retains keyboard focus; the guard above
    // suppresses duplicate clicks without starting a second read.
    root.setAttribute('aria-busy', 'true'); refresh.setAttribute('aria-disabled', 'true');
    status.textContent = 'Checking unresolved legacy activation reviews…';
    try {
      const raw = await read({ expectedUserId: owner.actorId, signal });
      if (captured !== generation || signal.aborted || !isCurrent(owner)) return;
      const value = normalizeAdminActivationReviewHealth(raw, owner.actorId);
      const fragment = document.createDocumentFragment();
      const card = element('section', undefined, 'admin-cleanup-counter'); card.dataset.activationReviewCounter = 'unresolved';
      card.append(element('h4', 'Unresolved legacy review records'),
        element('p', `${value.unresolved.count}${value.unresolved.hasMore ? '+' : ''}`, 'admin-cleanup-count'),
        element('p', value.unresolved.count === 0 ? 'No unresolved legacy review records at the observation time.'
          : 'Recorded legacy reviews without a recorded resolution. This is not a count of current activation blockers.'));
      fragment.append(card);
      const list = element('dl'); const pair = element('div');
      const oldest = value.oldestRecordedState === 'none' ? 'No unresolved legacy review records'
        : value.oldestRecordedState === 'unknown' ? 'Unknown' : activationReviewTimestamp(value.oldestRecordedAt);
      pair.append(element('dt', 'Oldest recorded queue creation time'), element('dd', oldest)); list.append(pair); fragment.append(list);
      fragment.append(element('p', 'Queue creation time is not challenge start time, source evidence age, or current block age. A recorded resolution does not prove the underlying account was repaired.', 'admin-footnote'));
      data.replaceChildren(fragment);
      status.textContent = `Observed ${activationReviewTimestamp(value.observedAt)}. Refresh to check for changes.`;
    } catch (error) {
      if (captured !== generation || signal.aborted || !isCurrent(owner)) return;
      data.replaceChildren();
      if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onAuthorityError(error);
      else status.textContent = 'Legacy activation reviews unavailable. Review counts and oldest recorded time are unknown. Refresh to try again.';
    } finally {
      if (captured === generation) { controller = null; root.removeAttribute('aria-busy'); refresh.removeAttribute('aria-disabled'); }
    }
  }
  refresh.addEventListener('click', load);
  return { clear, destroy() { clear(); refresh.removeEventListener('click', load); } };
}
