import { normalizeAdminCleanupHealth, CLEANUP_COUNTERS, cleanupTimestamp, cleanupCronSummary } from './admin-cleanup-health.mjs';

const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
};
const facts = pairs => {
  const list = element('dl');
  for (const [label, value] of pairs) {
    const pair = element('div'); pair.append(element('dt', label), element('dd', value)); list.append(pair);
  }
  return list;
};

// This view owns no account/session cache. The canonical Admin read client
// verifies the bearer and actor and aborts on invalidation. The local generation
// also fences navigation, tab changes and late callback completion.
export function mountCleanupHealth({ root, read, getOwner, isCurrent, onAuthorityError }) {
  const refresh = root.querySelector('#adminCleanupRefresh');
  const status = root.querySelector('#adminCleanupStatus');
  const data = root.querySelector('#adminCleanupData');
  let generation = 0; let controller = null;
  const clear = ({ ready = false } = {}) => {
    generation += 1; controller?.abort(); controller = null;
    data.replaceChildren(); root.removeAttribute('aria-busy'); refresh.removeAttribute('aria-disabled');
    status.textContent = ready ? 'Not checked. Refresh to read current cleanup health.' : '';
  };
  async function load() {
    const owner = getOwner(); if (controller || !owner || !isCurrent(owner)) return;
    clear(); const captured = generation; controller = new AbortController(); const signal = controller.signal;
    // Keep keyboard focus on this stable control; the guard above makes the
    // aria-disabled state non-interactive without native disabled focus loss.
    root.setAttribute('aria-busy', 'true'); refresh.setAttribute('aria-disabled', 'true'); status.textContent = 'Checking cleanup health…';
    try {
      const raw = await read({ expectedUserId: owner.actorId, signal });
      if (captured !== generation || signal.aborted || !isCurrent(owner)) return;
      const value = normalizeAdminCleanupHealth(raw, owner.actorId);
      const fragment = document.createDocumentFragment();
      const grid = element('div', undefined, 'admin-cleanup-counters');
      for (const [key, [label, note]] of Object.entries(CLEANUP_COUNTERS)) {
        const counter = value.counters[key]; const card = element('section', undefined, 'admin-cleanup-counter');
        card.dataset.cleanupCounter = key;
        card.append(element('h4', label), element('p', `${counter.count}${counter.hasMore ? '+' : ''}`, 'admin-cleanup-count'), element('p', note));
        grid.append(card);
      }
      fragment.append(grid);
      fragment.append(facts([['Oldest ready for cleanup', value.oldestEligibleAt === null ? 'No ready records at the observation time' : cleanupTimestamp(value.oldestEligibleAt)]]));
      const scheduler = element('section', undefined, 'admin-cleanup-scheduler'); scheduler.id = 'adminCleanupScheduler';
      const summary = cleanupCronSummary(value.cron);
      scheduler.append(element('h4', 'Cleanup scheduler'), facts([['Schedule', summary.job], ['Schedule configuration', summary.schedule], ['Newest allocated dispatch freshness', summary.freshness]]), element('p', summary.coverage));
      scheduler.append(element('p', 'Scheduler success means a request was enqueued. It does not prove an HTTP response, cleanup completion, or deletion.', 'admin-footnote'));
      if (value.cron.lastRuns.length) {
        scheduler.append(element('h5', 'Recent recorded dispatch runs'), element('p', 'Up to two matching runs, newest run identifier first. This is not guaranteed to be latest wall-clock order.', 'admin-footnote'));
        const runs = element('ol', undefined, 'admin-cleanup-runs');
        for (const run of value.cron.lastRuns) {
          const item = element('li');
          const label = { starting: 'Starting', connecting: 'Connecting', sending: 'Sending', running: 'Running', succeeded: 'Enqueued', failed: 'Failed', unknown: 'Unknown' }[run.status];
          item.append(facts([['Recorded status', label], ['Started', cleanupTimestamp(run.startedAt)], ['Ended', cleanupTimestamp(run.endedAt)]])); runs.append(item);
        }
        scheduler.append(runs);
      } else scheduler.append(element('p', value.cron.historyCoverage === 'complete' ? 'No recorded dispatch runs.' : 'No matching dispatch runs available in this view.'));
      fragment.append(scheduler); data.replaceChildren(fragment);
      status.textContent = `Observed ${cleanupTimestamp(value.observedAt)}. Refresh to check for changes.`;
    } catch (error) {
      if (captured !== generation || signal.aborted || !isCurrent(owner)) return;
      data.replaceChildren();
      if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onAuthorityError(error);
      else status.textContent = 'Cleanup health unavailable. Counts and scheduler health are unknown. Refresh to try again.';
    } finally {
      if (captured === generation) { controller = null; root.removeAttribute('aria-busy'); refresh.removeAttribute('aria-disabled'); }
    }
  }
  refresh.addEventListener('click', load);
  return { clear, destroy() { clear(); refresh.removeEventListener('click', load); } };
}
