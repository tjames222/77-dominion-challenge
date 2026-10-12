import { getAdminSessionOwner, getSiteAdminContext, getSiteAdminUser } from './api.js';
import { readRequesterAccount } from './admin-requester-account.mjs';

const node = (tag, text, id) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (id) value.id = id; return value; };

// Separate from Users details: no role, invitation or lifecycle action mounts.
export function mountRequesterDetail({ container, owner, requesterId, requestId, isCurrent, renderFacts, onError }) {
  const section = node('section', undefined, 'adminRequesterDetail');
  section.append(node('p', 'Read-only account snapshot for this request. Viewing it does not process, approve, or fulfill the request.', 'adminRequesterScope'));
  section.append(node('p', `Request ${requestId}`, 'adminRequesterReference'));
  const status = node('p', '', 'adminRequesterStatus'); status.setAttribute('role', 'status');
  const facts = node('div', undefined, 'adminRequesterFacts');
  const retry = node('button', 'Refresh requester account', 'adminRequesterRefresh'); retry.type = 'button';
  section.append(status, facts, retry); container.append(section);
  let disposed = false; let version = 0; let controller = null; let loading = false;
  const current = captured => !disposed && captured === version && isCurrent();
  const clear = () => {
    version += 1; controller?.abort(); controller = null; loading = false;
    facts.replaceChildren(); status.textContent = ''; section.removeAttribute('aria-busy'); retry.removeAttribute('aria-disabled');
  };
  async function load() {
    if (disposed || loading || !isCurrent()) return;
    clear(); const captured = version; loading = true; controller = new AbortController();
    section.setAttribute('aria-busy', 'true'); retry.setAttribute('aria-disabled', 'true'); status.textContent = 'Loading requester account…';
    try {
      const result = await readRequesterAccount({ getOwner: getAdminSessionOwner, getContext: getSiteAdminContext, readUser: getSiteAdminUser,
        owner, requesterId, signal: controller.signal });
      if (!current(captured)) return;
      const fragment = document.createDocumentFragment(); renderFacts(result.item, fragment); facts.replaceChildren(fragment);
      status.textContent = `Observed ${new Date(result.observedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC. Refresh to check for changes.`;
    } catch (error) {
      if (!current(captured)) return;
      facts.replaceChildren();
      if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onError(error);
      else status.textContent = error?.code === 'ADMIN_NOT_FOUND'
        ? 'Requester account no longer available. The recorded request remains; no identity or fulfillment outcome is inferred.'
        : 'Requester account unavailable. Refresh to try again; no account facts or request outcome are inferred.';
    } finally {
      if (current(captured)) { loading = false; controller = null; section.removeAttribute('aria-busy'); retry.removeAttribute('aria-disabled'); }
    }
  }
  retry.addEventListener('click', () => { if (!loading) void load(); });
  void load();
  return () => { disposed = true; clear(); section.remove(); };
}
