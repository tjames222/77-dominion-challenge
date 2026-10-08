import { getAdminSessionOwner, listSiteAdminAudit } from './api.js';
import { readAdminUserHistory } from './admin-user-history.mjs';

const node = (tag, text, id) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (id) value.id = id; return value; };
const button = (label, id) => { const value = node('button', label, id); value.type = 'button'; return value; };
const date = value => `${new Date(value).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
const role = value => value === null ? 'Not recorded' : value === 'site_admin' ? 'Site admin' : 'Member';

export function mountAdminUserHistory({ container, targetUserId, owner, permissions, isCurrent, onError }) {
  if (!permissions.includes('users.read') || !permissions.includes('audit.read')) return () => {};
  const section = node('details', undefined, 'adminUserHistory'); section.className = 'admin-disclosure admin-user-history';
  section.append(node('summary', 'Administrative history'));
  section.append(node('p', 'Recorded events linked to this account, not a complete account history. Invitation approval, resend and revocation history remains in Early Access.', 'adminUserHistoryScope'));
  const status = node('p', '', 'adminUserHistoryStatus'); status.setAttribute('role', 'status');
  const rows = node('ol', undefined, 'adminUserHistoryRows');
  const actions = node('div'); actions.className = 'admin-actions';
  const refresh = button('Refresh account history', 'adminUserHistoryRefresh');
  const older = button('Older account events', 'adminUserHistoryOlder'); older.disabled = true;
  actions.append(refresh, older); section.append(status, rows, actions); container.append(section);
  let disposed = false; let version = 0; let controller = null; let nextCursor = null; let page = 1; let loading = false;
  const current = captured => !disposed && captured === version && section.open && isCurrent();
  const clear = () => {
    version += 1; controller?.abort(); controller = null; nextCursor = null; loading = false;
    rows.replaceChildren(); status.textContent = ''; section.removeAttribute('aria-busy'); refresh.disabled = false; older.disabled = true;
    refresh.removeAttribute('aria-disabled'); older.removeAttribute('aria-disabled');
  };
  async function load(cursor = null, nextPage = 1) {
    if (disposed || !section.open || !isCurrent() || loading) return;
    const focusedControl = [refresh, older].includes(document.activeElement) ? document.activeElement : null;
    clear(); const captured = version; page = nextPage; loading = true; controller = new AbortController();
    // Keep an initiating keyboard control focusable while loading. The loading
    // guard prevents repeat dispatch; do not blur it by disabling it mid-read.
    refresh.setAttribute('aria-disabled', 'true'); older.setAttribute('aria-disabled', 'true');
    if (focusedControl) { focusedControl.disabled = false; focusedControl.focus(); }
    section.setAttribute('aria-busy', 'true'); status.textContent = 'Loading account history…';
    try {
      const result = await readAdminUserHistory({ read: listSiteAdminAudit, getOwner: getAdminSessionOwner,
        owner, targetUserId, cursor, signal: controller.signal });
      if (!current(captured)) return;
      const fragment = document.createDocumentFragment();
      for (const item of result.items) {
        const entry = node('li'); entry.append(node('h4', item.actionLabel));
        entry.append(node('p', `${date(item.occurredAt)} · ${item.outcome === 'success' ? 'Succeeded' : 'Not applied'}`));
        if (item.action.startsWith('roles.')) entry.append(node('p', `Recorded site role: ${role(item.beforeRole)} → ${role(item.afterRole)}`));
        entry.append(node('p', `Reason: ${item.reasonLabel}${item.errorLabel ? ` · ${item.errorLabel}` : ''}`));
        const reference = node('details'); reference.className = 'admin-disclosure'; reference.append(node('summary', 'Event reference'), node('p', `Event ${item.id}`));
        entry.append(reference); fragment.append(entry);
      }
      rows.replaceChildren(fragment); nextCursor = result.nextCursor;
      status.textContent = result.items.length ? `Page ${page}: ${result.items.length} recorded ${result.items.length === 1 ? 'event' : 'events'}. Observed ${date(result.observedAt)}.`
        : `No recorded events linked to this account${page > 1 ? ' on this page' : ''}. Observed ${date(result.observedAt)}.`;
    } catch (error) {
      if (!current(captured)) return;
      if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onError(error);
      else status.textContent = 'Account history unavailable. Refresh to try again; no history is inferred from this error.';
    } finally {
      if (current(captured)) {
        loading = false; controller = null; section.removeAttribute('aria-busy');
        refresh.removeAttribute('aria-disabled'); older.removeAttribute('aria-disabled');
        // Move only if focus is still on Older; never steal focus after the
        // operator has moved elsewhere while the page was loading.
        if (!nextCursor && document.activeElement === older) refresh.focus();
        older.disabled = !nextCursor;
        // Clearing/replacing rows can resize the scrolling dialog underneath
        // its focused action. Keep that action visible after the new layout,
        // but do not move the viewport if focus has left these controls.
        if ([refresh, older].includes(document.activeElement)) document.activeElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  const toggle = () => { if (section.open) void load(); else clear(); };
  section.addEventListener('toggle', toggle);
  refresh.addEventListener('click', () => { if (!loading) { refresh.focus(); void load(); } });
  older.addEventListener('click', () => { if (nextCursor && !loading) { older.focus(); void load(nextCursor, page + 1); } });
  return () => { disposed = true; clear(); section.removeEventListener('toggle', toggle); section.remove(); };
}
