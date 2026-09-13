import {
  getAdminSessionOwner, getSiteAdminContext, listSiteAdminUsers, getSiteAdminUser,
  listSiteAdminAudit, getSiteAdminAuditEvent, subscribeToAdminInvalidation,
  cancelAdminReads, clearAuthSession,
} from './api.js';
import { adminReadError } from './admin-read-client.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

const byId = (id) => document.getElementById(id);
const workspace = byId('adminWorkspace');
const dialog = byId('adminDetail');
let epoch = 0; let queryEpoch = 0; let detailEpoch = 0;
let owner = null; let permissions = []; let tab = 'users'; let loading = false;
let cursors = [null]; let page = 0; let nextCursor = null; let detailOpener = null;
let suspended = false; let checking = false;
const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 2000) : 'Not recorded';
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'Not recorded';
  const stamp = new Date(value);
  return Number.isFinite(stamp.getTime()) ? `${stamp.toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'Not recorded';
};
function element(tag, value, className) {
  const node = document.createElement(tag); if (value !== undefined) node.textContent = text(value);
  if (className) node.className = className; return node;
}
function closeDetail({ restore = true } = {}) {
  detailEpoch += 1;
  if (dialog.open) dialog.close();
  byId('adminDetailBody').replaceChildren(); byId('adminDetailTitle').textContent = 'Record details';
  if (restore && detailOpener) (detailOpener.isConnected ? detailOpener : byId(tab === 'users' ? 'adminUsersTab' : 'adminAuditTab')).focus();
  detailOpener = null;
}
function clearRows() {
  queryEpoch += 1; loading = false; nextCursor = null;
  byId('adminUsersRows').replaceChildren(); byId('adminAuditRows').replaceChildren();
  byId('adminStatus').textContent = ''; workspace.removeAttribute('aria-busy');
  closeDetail({ restore: false }); updatePagination();
}
function gate(title, message, action = '') {
  workspace.hidden = true; workspace.inert = true;
  byId('adminGate').hidden = false; byId('adminGateTitle').textContent = title;
  byId('adminGateMessage').textContent = message;
  for (const id of ['adminLogin', 'adminMfa', 'adminReauthenticate', 'adminRetryAccess']) byId(id).hidden = id !== action;
}
function scrub(reason = '') {
  epoch += 1; checking = false; owner = null; permissions = []; cursors = [null]; page = 0;
  clearRows(); byId('adminUsersFilters').reset(); byId('adminAuditFilters').reset();
  byId('adminPreview').hidden = true;
  gate('Access needs verification', reason === 'ADMIN_SIGNED_OUT' ? 'Log in to continue. Private records have been cleared.' : 'Private records have been cleared. Check access again to continue.', reason === 'ADMIN_SIGNED_OUT' ? 'adminLogin' : 'adminRetryAccess');
}
function showError(error) {
  clearRows();
  if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) {
    scrub(); gate('Access not verified', adminReadError(error.code).message, error.code === 'ADMIN_SIGNED_OUT' ? 'adminLogin' : 'adminRetryAccess');
  } else byId('adminStatus').textContent = adminReadError(error?.code).message;
}
function updatePagination() {
  byId('adminFirstPage').disabled = loading || page === 0;
  byId('adminPreviousPage').disabled = loading || page === 0;
  byId('adminNextPage').disabled = loading || !nextCursor;
  byId('adminRefresh').disabled = loading;
  byId('adminPageLabel').textContent = `Page ${page + 1}`;
}
function userStatus(item) {
  const values = [];
  if (item.deletedAt) values.push('Deleted Auth record');
  if (item.isSuspended) values.push('Suspended');
  if (item.deletionPending) values.push('Deletion pending');
  values.push(item.emailConfirmedAt ? 'Email confirmed' : 'Email unconfirmed');
  return values.join(' · ');
}
function cell(row, label, value) { const node = element('td'); node.dataset.label = label; node.append(value instanceof Node ? value : element('span', value)); row.append(node); }
function renderRows(items) {
  if (!Array.isArray(items) || items.length > 50 || items.some((item) => !item || typeof item.id !== 'string')) throw adminReadError();
  const body = byId(tab === 'users' ? 'adminUsersRows' : 'adminAuditRows');
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = element('tr');
    if (tab === 'users') {
      const person = element('div'); person.append(element('strong', item.name || 'Unnamed member'), element('span', item.email, 'admin-secondary'));
      cell(row, 'Member', person); cell(row, 'Role', item.role === 'site_admin' ? 'Site admin' : 'Member');
      cell(row, 'Status', userStatus(item)); cell(row, 'Created', date(item.createdAt));
    } else {
      cell(row, 'Recorded', date(item.occurredAt)); cell(row, 'Action', item.action); cell(row, 'Outcome', item.outcome); cell(row, 'Target user', item.targetUserId);
    }
    const button = element('button', 'View details'); button.type = 'button';
    button.setAttribute('aria-label', tab === 'users' ? `View details for ${text(item.name || item.email)}` : `View audit event ${text(item.id)}`);
    const kind = tab; button.addEventListener('click', () => void openDetail(kind, item.id, button));
    cell(row, 'Details', button); fragment.append(row);
  }
  body.replaceChildren(fragment);
}
function listArgs() {
  const data = new FormData(byId(tab === 'users' ? 'adminUsersFilters' : 'adminAuditFilters'));
  return tab === 'users' ? { target_limit: 25, target_cursor: cursors[page], target_search: data.get('search').trim(), target_role: data.get('role'), target_status: data.get('status'), target_sort: data.get('sort') }
    : { target_limit: 25, target_cursor: cursors[page], target_user_id: data.get('target').trim() || null, target_action: data.get('action'), target_outcome: data.get('outcome') };
}
async function loadPage() {
  if (!owner || suspended) return;
  clearRows(); loading = true; workspace.setAttribute('aria-busy', 'true'); updatePagination();
  byId('adminStatus').textContent = 'Loading records…';
  const captured = epoch; const query = queryEpoch; const actorId = owner.actorId;
  try {
    const result = await (tab === 'users' ? listSiteAdminUsers : listSiteAdminAudit)(listArgs(), { expectedUserId: actorId });
    if (captured !== epoch || query !== queryEpoch || suspended) return;
    renderRows(result.items);
    if (result.nextCursor !== null && (typeof result.nextCursor !== 'object' || Array.isArray(result.nextCursor))) throw adminReadError();
    nextCursor = result.nextCursor;
    byId('adminStatus').textContent = result.items.length ? `${result.items.length} records on this page. Observed ${date(result.observedAt)}.` : 'No records match these filters.';
  } catch (error) { if (captured === epoch && query === queryEpoch) showError(error); }
  finally { if (captured === epoch && query === queryEpoch) { loading = false; workspace.removeAttribute('aria-busy'); updatePagination(); } }
}
function addSection(title, pairs) {
  const section = element('section'); section.append(element('h3', title)); const list = element('dl');
  for (const [label, value] of pairs) list.append(element('dt', label), element('dd', value));
  section.append(list); byId('adminDetailBody').append(section);
}
function renderUser(item) {
  addSection('Account', [['User ID', item.id], ['Name', item.name], ['Email', item.email], ['Role', item.role], ['Status', userStatus(item)], ['Created', date(item.createdAt)], ['Email confirmed', date(item.emailConfirmedAt)], ['Last sign-in', date(item.lastSignInAt)], ['Suspended until', date(item.suspendedUntil)], ['Deleted', date(item.deletedAt)], ['Deletion request state', item.deletionRequestStatus]]);
  if (item.crew) addSection('Crew (separate from site role)', [['ID', item.crew.id], ['Name', item.crew.name], ['Crew role', item.crew.role]]);
  if (item.activationSnapshot) { const s = item.activationSnapshot; addSection('Stored activation snapshot', [['Stored status', s.storedStatus], ['Mode', s.mode], ['Start date', s.startDate], ['Review required', s.reviewRequired ? 'Yes' : 'No'], ['Recorded', date(s.recordedAt)]]); }
  if (item.statsSnapshot) { const s = item.statsSnapshot; addSection('Stored progress snapshot', [['Total points', s.totalPoints], ['Stored app streak', s.storedAppStreak], ['Stored perfect-day streak', s.storedPerfectDayStreak], ['Last seen local date', s.lastSeenLocalDate], ['Recorded', date(s.recordedAt)]]); }
  if (item.subscriptionSnapshot) { const s = item.subscriptionSnapshot; addSection('Stored subscription snapshot', [['Stored status', s.status], ['Current period end', date(s.currentPeriodEnd)], ['Cancel at period end', s.cancelAtPeriodEnd ? 'Yes' : 'No'], ['Recorded', date(s.recordedAt)]]); }
  byId('adminDetailBody').append(element('p', 'Snapshots are historical stored values, not current effective access, challenge day, or completion decisions.', 'admin-footnote'));
}
function renderAudit(item) {
  addSection('Administrative event', [['Event ID', item.id], ['Recorded', date(item.occurredAt)], ['Actor ID', item.actorId], ['Target user ID', item.targetUserId], ['Action', item.action], ['Permission', item.permission], ['Outcome', item.outcome], ['Reason code', item.reasonCode], ['Before role', item.beforeRole], ['After role', item.afterRole], ['Request ID', item.requestId], ['Correlation ID', item.correlationId], ['Environment', item.environment], ['Error code', item.errorCode]]);
}
async function openDetail(kind, id, button) {
  if (!owner || suspended) return;
  closeDetail({ restore: false }); detailOpener = button;
  const captured = epoch; const detail = detailEpoch;
  byId('adminDetailTitle').textContent = kind === 'users' ? 'Account details' : 'Audit event';
  byId('adminDetailBody').append(element('p', 'Loading record…')); dialog.showModal(); byId('adminDetailClose').focus();
  try {
    const result = await (kind === 'users' ? getSiteAdminUser : getSiteAdminAuditEvent)(id, { expectedUserId: owner.actorId });
    if (captured !== epoch || detail !== detailEpoch || suspended) return;
    if (!result.item || result.item.id !== id) throw adminReadError();
    byId('adminDetailBody').replaceChildren(); (kind === 'users' ? renderUser : renderAudit)(result.item);
  } catch (error) {
    if (captured !== epoch || detail !== detailEpoch) return;
    closeDetail(); showError(error);
  }
}
function selectTab(next, { focus = false } = {}) {
  if (!permissions.includes(next === 'users' ? 'users.read' : 'audit.read')) return;
  tab = next; cursors = [null]; page = 0;
  for (const node of document.querySelectorAll('[data-admin-tab]')) { const active = node.dataset.adminTab === tab; node.setAttribute('aria-selected', String(active)); node.tabIndex = active ? 0 : -1; if (active && focus) node.focus(); }
  for (const node of document.querySelectorAll('[data-admin-panel]')) node.hidden = node.dataset.adminPanel !== tab;
  void loadPage();
}
async function verifyAccess() {
  if (suspended || checking) return;
  scrub(); checking = true; const captured = epoch;
  gate('Checking access', 'Verifying your account and session…');
  try {
    const actor = await getAdminSessionOwner();
    if (captured !== epoch || suspended) return;
    const context = await getSiteAdminContext({ expectedUserId: actor.actorId });
    if (captured !== epoch || suspended) return;
    byId('adminPreview').hidden = context.preview !== true;
    if (!context.adminReady) {
      const mfa = context.reason === 'mfa_required'; const reauthenticate = context.reason === 'reauthentication_required';
      gate(mfa ? 'Authenticator verification required' : 'Administration unavailable', mfa ? 'Verify your authenticator to continue. No private records have been loaded.' : reauthenticate ? 'This session must be renewed before administration can be used.' : 'This account does not have verified administration access.', mfa ? 'adminMfa' : reauthenticate ? 'adminReauthenticate' : 'adminRetryAccess');
      return;
    }
    permissions = context.permissions;
    if (!permissions.some((permission) => ['users.read', 'audit.read'].includes(permission))) throw adminReadError('ADMIN_DENIED');
    owner = actor;
    byId('adminUsersTab').hidden = !permissions.includes('users.read'); byId('adminAuditTab').hidden = !permissions.includes('audit.read');
    byId('adminGate').hidden = true; workspace.hidden = false; workspace.inert = false;
    selectTab(permissions.includes(tab === 'users' ? 'users.read' : 'audit.read') ? tab : permissions.includes('users.read') ? 'users' : 'audit');
  } catch (error) {
    if (captured !== epoch || suspended) return;
    scrub(); gate('Access not verified', adminReadError(error?.code).message, error?.code === 'ADMIN_SIGNED_OUT' ? 'adminLogin' : 'adminRetryAccess');
  } finally { if (captured === epoch) checking = false; }
}

byId('adminMfa').href = mfaChallengeHref('admin.html', location.origin);
byId('adminRetryAccess').addEventListener('click', () => void verifyAccess());
byId('adminReauthenticate').addEventListener('click', async () => { scrub(); try { await clearAuthSession(); location.assign('./login.html?returnTo=admin.html'); } catch { gate('Sign-out unavailable', 'Try signing out again before continuing.', 'adminReauthenticate'); } });
byId('adminDetailClose').addEventListener('click', () => closeDetail());
dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDetail(); });
for (const node of document.querySelectorAll('[data-admin-tab]')) {
  node.addEventListener('click', () => selectTab(node.dataset.adminTab));
  node.addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); selectTab(event.key === 'Home' ? 'users' : event.key === 'End' ? 'audit' : tab === 'users' ? 'audit' : 'users', { focus: true }); });
}
for (const id of ['adminUsersFilters', 'adminAuditFilters']) {
  byId(id).addEventListener('submit', (event) => { event.preventDefault(); cursors = [null]; page = 0; void loadPage(); });
  byId(id).addEventListener('input', () => { clearRows(); cursors = [null]; page = 0; updatePagination(); byId('adminStatus').textContent = 'Filters changed. Apply filters to load records.'; });
}
byId('adminNextPage').addEventListener('click', () => { if (loading || !nextCursor) return; cursors = cursors.slice(0, page + 1); cursors.push(nextCursor); page += 1; void loadPage(); });
byId('adminPreviousPage').addEventListener('click', () => { if (!loading && page > 0) { page -= 1; void loadPage(); } });
byId('adminFirstPage').addEventListener('click', () => { cursors = [null]; page = 0; void loadPage(); });
byId('adminRefresh').addEventListener('click', () => void loadPage());
subscribeToAdminInvalidation(scrub);
window.addEventListener('pagehide', () => { suspended = true; scrub(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) { suspended = false; void verifyAccess(); } });
document.addEventListener('visibilitychange', () => { suspended = document.visibilityState === 'hidden'; if (suspended) cancelAdminReads(); else void verifyAccess(); });
window.addEventListener('focus', () => { if (!suspended) void verifyAccess(); });
window.addEventListener('online', () => { if (!suspended) void verifyAccess(); });
void verifyAccess();
