import { getAdminSessionOwner, getSiteAdminContext, getSiteAdminUser } from './api.js';
import { readAdminUserLookup } from './admin-user-lookup.mjs';

const node = (tag, text, id) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (id) value.id = id; return value; };

// Deliberately separate from the ordinary Users detail composition. An exact
// lookup must never mount role, name, invitation, or other mutation controls.
export function mountAdminUserLookup({ container, owner, userId, isCurrent, renderFacts, onError }) {
  const section = node('section', undefined, 'adminLookupDetail');
  section.append(node('p', 'Read-only account snapshot. This lookup does not change the account.', 'adminLookupScope'));
  const status = node('p', '', 'adminLookupStatus'); status.setAttribute('role', 'status');
  const facts = node('div', undefined, 'adminLookupFacts');
  const retry = node('button', 'Refresh account', 'adminLookupRefresh'); retry.type = 'button';
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
    section.setAttribute('aria-busy', 'true'); retry.setAttribute('aria-disabled', 'true'); status.textContent = 'Loading account…';
    try {
      const result = await readAdminUserLookup({ getOwner: getAdminSessionOwner, getContext: getSiteAdminContext, readUser: getSiteAdminUser,
        owner, userId, signal: controller.signal });
      if (!current(captured)) return;
      const fragment = document.createDocumentFragment(); renderFacts(result.item, fragment); facts.replaceChildren(fragment);
      status.textContent = `Observed ${new Date(result.observedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC. Refresh to check for changes.`;
    } catch (error) {
      if (!current(captured)) return;
      facts.replaceChildren();
      if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onError(error);
      else status.textContent = error?.code === 'ADMIN_NOT_FOUND'
        ? 'Account unavailable. No account facts are inferred from this user ID.'
        : 'Account lookup unavailable. Refresh to try again.';
    } finally {
      if (current(captured)) {
        loading = false; controller = null; section.removeAttribute('aria-busy'); retry.removeAttribute('aria-disabled');
        // Fresh facts can push the focused control below the dialog viewport.
        // Preserve its visibility without taking focus from another control.
        if (document.activeElement === retry) retry.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }
  retry.addEventListener('click', () => { if (!loading) void load(); });
  void load();
  return () => { disposed = true; clear(); section.remove(); };
}
