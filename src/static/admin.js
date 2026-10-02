import {
  getAdminSessionOwner, getSiteAdminContext, listSiteAdminUsers, getSiteAdminUser,
  listSiteAdminAudit, getSiteAdminAuditEvent, subscribeToAdminInvalidation,
  cancelAdminReads, clearAuthSession,
  listSiteAdminEarlyAccess, getSiteAdminEarlyAccess,
  listSiteAdminAccountRequests,
} from './api.js';
import { adminReadError } from './admin-read-client.mjs';
import { normalizeEarlyAccessRequest } from './admin-early-access-contract.mjs';
import { mountEarlyAccessDetail } from './admin-early-access-detail.mjs';
import { mountRoleDetail } from './admin-role-detail.mjs';
import { adminUserListFacts, adminUserSummary } from './admin-user-presentation.mjs';
import { normalizeAdminAccountRequestPage, accountRequestTypeLabel, accountRequestRecordedStatus } from './admin-account-requests.mjs';
import { readAdminAccountRequests } from './admin-account-request-transport.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

const byId = (id) => document.getElementById(id);
const workspace = byId('adminWorkspace');
const dialog = byId('adminDetail');
let epoch = 0; let queryEpoch = 0; let detailEpoch = 0;
let owner = null; let permissions = []; let tab = location.hash === '#account-requests' ? 'requests' : location.hash === '#early-access' ? 'early' : 'users'; let loading = false;
let cursors = [null]; let page = 0; let nextCursor = null; let detailOpener = null;
let suspended = false; let checking = false;
let listController = null; let detailController = null; let detailCleanup = null;
const tabs = { users: { permission: 'users.read', prefix: 'adminUsers', list: listSiteAdminUsers, get: getSiteAdminUser },
  audit: { permission: 'audit.read', prefix: 'adminAudit', list: listSiteAdminAudit, get: getSiteAdminAuditEvent },
  early: { permission: 'operations.read', prefix: 'adminEarly', list: listSiteAdminEarlyAccess, get: getSiteAdminEarlyAccess },
  requests: { permission: 'operations.read', prefix: 'adminRequests', list: (args, options) => readAdminAccountRequests(listSiteAdminAccountRequests, args, options) } };
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
  detailController?.abort(); detailController = null; detailCleanup?.(); detailCleanup = null;
  if (dialog.open) dialog.close();
  byId('adminDetailBody').replaceChildren(); byId('adminDetailTitle').textContent = 'Record details';
  if (restore && detailOpener) (detailOpener.isConnected ? detailOpener : byId(`${tabs[tab].prefix}Tab`)).focus();
  detailOpener = null;
}
function clearRows() {
  listController?.abort(); listController = null;
  queryEpoch += 1; loading = false; nextCursor = null;
  for (const value of Object.values(tabs)) byId(`${value.prefix}Rows`).replaceChildren();
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
  clearRows(); for (const value of Object.values(tabs)) byId(`${value.prefix}Filters`).reset();
  updateFilterState();
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
function userFacts(pairs, className = 'admin-user-facts') {
  const list = element('dl', undefined, className);
  for (const [label, value] of pairs) { const pair = element('div'); pair.append(element('dt', label), element('dd', value)); list.append(pair); }
  return list;
}
function badge(value, attention = false) {
  const node = element('span', value, 'admin-badge');
  if (attention) node.dataset.attention = 'true';
  return node;
}
function disclosure(title, container) {
  const node = element('details', undefined, 'admin-disclosure');
  node.append(element('summary', title)); container.append(node); return node;
}
function renderRows(items) {
  if (!Array.isArray(items) || items.length > 50 || items.some((item) => !item || typeof item.id !== 'string')) throw adminReadError();
  const body = byId(`${tabs[tab].prefix}Rows`);
  const fragment = document.createDocumentFragment();
  for (const raw of items) {
    const item = tab === 'early' ? normalizeEarlyAccessRequest(raw) : raw;
    const row = element('tr');
    if (tab === 'requests') {
      row.setAttribute('role', 'row');
      cell(row, 'Request and requester IDs', userFacts([['Request ID', item.id], ['Requester ID', item.userId ?? 'Account reference removed']], 'admin-request-facts'));
      cell(row, 'Type', accountRequestTypeLabel(item.requestType));
      cell(row, 'Recorded status', badge(accountRequestRecordedStatus(item.status)));
      cell(row, 'Timeline', userFacts([['Requested', date(item.requestedAt)], ['Updated', date(item.updatedAt)], ['Resolved', item.resolvedAt === null ? 'Not resolved' : date(item.resolvedAt)]], 'admin-request-facts'));
      for (const node of row.children) node.setAttribute('role', 'cell');
      fragment.append(row); continue;
    }
    if (tab === 'users') {
      // Explicit roles retain table relationships when Users becomes cards.
      row.setAttribute('role', 'row');
      const summary = adminUserSummary(item);
      const person = element('div'); person.append(element('strong', item.name || 'Unnamed member'), element('span', item.email, 'admin-secondary'));
      const account = element('div'); account.append(badge(summary.status, summary.attention));
      if (summary.confirmation) account.append(element('span', summary.confirmation, 'admin-secondary'));
      cell(row, 'Member', person); cell(row, 'Site role', summary.role); cell(row, 'Account', account);
      cell(row, 'Last sign-in', summary.lastSignIn);
    } else if (tab === 'early') {
      row.dataset.earlyRequest = item.id;
      const person = element('div'); person.append(element('strong', item.name), element('span', item.email, 'admin-secondary'));
      cell(row, 'Applicant', person); cell(row, 'Status', badge(item.status)); row.lastElementChild.querySelector('.admin-badge').dataset.earlyStatus = '';
      cell(row, 'Account match', item.account.status); cell(row, 'Requested', date(item.requestedAt));
    } else {
      cell(row, 'Recorded', date(item.occurredAt)); cell(row, 'Action', item.action); cell(row, 'Outcome', badge(item.outcome, item.outcome === 'failure')); cell(row, 'Target user', item.targetUserId);
    }
    const button = element('button', tab === 'early' ? 'Review request' : 'View details'); button.type = 'button';
    button.setAttribute('aria-label', tab === 'audit' ? `View audit event ${text(item.id)}` : `${tab === 'early' ? 'Review request' : 'View details'} for ${text(item.name || item.email)}`);
    const kind = tab; button.addEventListener('click', () => void openDetail(kind, item.id, button));
    cell(row, 'Details', button);
    if (tab === 'users') for (const node of row.children) node.setAttribute('role', 'cell');
    fragment.append(row);
  }
  body.replaceChildren(fragment);
}
function listArgs() {
  const data = new FormData(byId(`${tabs[tab].prefix}Filters`));
  if (tab === 'requests') return { target_limit: 25, target_cursor: cursors[page], target_request_type: data.get('type'), target_status: data.get('status'), target_sort: data.get('sort') };
  if (tab === 'early') return { target_limit: 25, target_cursor: cursors[page], target_search: data.get('search').trim(), target_status: data.get('status'), target_sort: data.get('sort') };
  return tab === 'users' ? { target_limit: 25, target_cursor: cursors[page], target_search: data.get('search').trim(), target_role: data.get('role'), target_status: data.get('status'), target_sort: data.get('sort') }
    : { target_limit: 25, target_cursor: cursors[page], target_user_id: data.get('target').trim() || null, target_action: data.get('action'), target_outcome: data.get('outcome') };
}
function updateFilterState() {
  const form = byId(`${tabs[tab].prefix}Filters`);
  const choices = [...form.elements].flatMap((control) => {
    if (control.tagName === 'SELECT') {
      const original = [...control.options].find(option => option.defaultSelected) || control.options[0];
      return control.value !== original.value ? [control.selectedOptions[0].textContent] : [];
    }
    return control.tagName === 'INPUT' && control.value.trim() ? [`Search: ${control.value.trim()}`] : [];
  });
  byId('adminFilterSummary').textContent = choices.join(' · ');
  byId('adminFilterState').hidden = !choices.length;
}
async function loadPage() {
  if (!owner || suspended) return;
  clearRows(); updateFilterState(); loading = true; workspace.setAttribute('aria-busy', 'true'); updatePagination();
  byId('adminStatus').textContent = 'Loading records…';
  const captured = epoch; const query = queryEpoch; const actorId = owner.actorId;
  listController = new AbortController(); const signal = listController.signal;
  try {
    let result = await tabs[tab].list(listArgs(), { expectedUserId: actorId, signal });
    if (captured !== epoch || query !== queryEpoch || suspended) return;
    if (tab === 'requests') result = normalizeAdminAccountRequestPage(result);
    renderRows(result.items);
    if (result.nextCursor !== null && (typeof result.nextCursor !== 'object' || Array.isArray(result.nextCursor))) throw adminReadError();
    nextCursor = result.nextCursor;
    byId('adminStatus').textContent = result.items.length ? `${result.items.length} records on this page. Observed ${date(result.observedAt)}.` : 'No records match these filters.';
  } catch (error) { if (captured === epoch && query === queryEpoch) showError(error); }
  finally { if (captured === epoch && query === queryEpoch) { loading = false; workspace.removeAttribute('aria-busy'); updatePagination(); } }
}
function addSection(title, pairs, container = byId('adminDetailBody')) {
  const section = element('section'); section.append(element('h3', title)); const list = element('dl');
  for (const [label, value] of pairs) list.append(element('dt', label), element('dd', value));
  section.append(list); container.append(section);
}
function renderUser(item, container = byId('adminDetailBody')) {
  const facts = adminUserListFacts(item);
  addSection('Account', [['Name', item.name], ['Email', item.email], ['Site role', adminUserSummary(item).role], ['Status', userStatus(item)]], container);
  const history = disclosure('Account history and identifiers', container);
  addSection('Recorded account details', [['User ID', item.id], ['Role revision', item.roleRevision], ...facts.account.slice(1), ['Suspended until', date(item.suspendedUntil)], ['Deleted', date(item.deletedAt)], ['Deletion request state', item.deletionRequestStatus]], history);
  const stored = disclosure('Crew and stored snapshots', container);
  stored.append(element('p', 'Snapshots are historical stored values, not current effective access, challenge day, or completion decisions. Crew-local roles are separate from site roles.', 'admin-footnote'));
  addSection('Crew (separate from site role)', item.crew ? [['ID', item.crew.id], ...facts.crew] : [['Crew', 'Not recorded']], stored);
  if (item.activationSnapshot) { const s = item.activationSnapshot; addSection('Stored activation snapshot', [['Stored status', s.storedStatus], ['Mode', s.mode], ['Start date', s.startDate], ['Review required', s.reviewRequired ? 'Yes' : 'No'], ['Recorded', date(s.recordedAt)]], stored); }
  for (const snapshot of facts.snapshots) addSection(snapshot.title, snapshot.fields || [['Snapshot', 'Not recorded']], stored);
}
function renderAudit(item) {
  addSection('Administrative event', [['Recorded', date(item.occurredAt)], ['Action', item.action], ['Outcome', item.outcome], ['Reason code', item.reasonCode], ['Before role', item.beforeRole], ['After role', item.afterRole], ['Error code', item.errorCode]]);
  const identifiers = disclosure('Event identifiers and permission', byId('adminDetailBody'));
  addSection('Audit reference', [['Event ID', item.id], ['Actor ID', item.actorId], ['Target user ID', item.targetUserId], ['Permission', item.permission], ['Request ID', item.requestId], ['Correlation ID', item.correlationId], ['Environment', item.environment]], identifiers);
}
async function openDetail(kind, id, button) {
  if (!owner || suspended) return;
  closeDetail({ restore: false }); detailOpener = button;
  const captured = epoch; const detail = detailEpoch;
  byId('adminDetailTitle').textContent = kind === 'users' ? 'Account details' : kind === 'early' ? 'Early-access request' : 'Audit event';
  byId('adminDetailBody').append(element('p', 'Loading record…')); dialog.showModal(); byId('adminDetailClose').focus();
  detailController = new AbortController(); const signal = detailController.signal; const detailOwner = { ...owner };
  try {
    const result = await tabs[kind].get(id, { expectedUserId: owner.actorId, signal });
    if (captured !== epoch || detail !== detailEpoch || suspended) return;
    if (!result.item || result.item.id !== id) throw adminReadError();
    byId('adminDetailBody').replaceChildren();
    if (kind === 'early') detailCleanup = mountEarlyAccessDetail({ container: byId('adminDetailBody'), item: normalizeEarlyAccessRequest(result.item),
      owner: detailOwner, permissions: [...permissions], isCurrent: () => captured === epoch && detail === detailEpoch && !suspended,
      onError: showError, reload: () => void openDetail(kind, id, button), onDenied: (value) => {
        for (const row of byId('adminEarlyRows').children) if (row.dataset.earlyRequest === value.requestId) row.querySelector('[data-early-status]').textContent = value.status;
      } });
    else if (kind === 'users') {
      const facts = element('div'); facts.id = 'adminUserFacts'; byId('adminDetailBody').append(facts); renderUser(result.item, facts);
      detailCleanup = mountRoleDetail({ container: byId('adminDetailBody'), item: result.item, owner: detailOwner, permissions: [...permissions],
        isCurrent: () => captured === epoch && detail === detailEpoch && !suspended,
        onError: showError, reload: () => void openDetail(kind, id, button),
        onFacts: (item) => { facts.replaceChildren(); renderUser(item, facts); },
        onCommitted: () => {
          // Drop old facts/list immediately. An idempotent receipt can describe
          // an older successful operation; only new reads establish current role.
          facts.replaceChildren(); byId('adminUsersRows').replaceChildren();
          cursors = [null]; page = 0; nextCursor = null; updatePagination();
          const query = ++queryEpoch; const controller = new AbortController(); listController?.abort(); listController = controller;
          byId('adminStatus').textContent = 'Refreshing accounts after the confirmed role operation…';
          const queryArgs = listArgs();
          const assertListOwner = async () => {
            const current = await getAdminSessionOwner();
            if (current.actorId !== detailOwner.actorId || current.sessionIdentity !== detailOwner.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
          };
          void (async () => {
            await assertListOwner();
            if (captured !== epoch || query !== queryEpoch || tab !== 'users' || suspended || controller.signal.aborted) return;
            const value = await listSiteAdminUsers(queryArgs, { expectedUserId: detailOwner.actorId, signal: controller.signal });
            await assertListOwner();
            // This refresh belongs to the list query, not the originating
            // dialog. Closing that dialog must not strand an empty busy list.
            if (captured !== epoch || query !== queryEpoch || tab !== 'users' || suspended) return;
            if (value.nextCursor !== null && (typeof value.nextCursor !== 'object' || Array.isArray(value.nextCursor))) throw adminReadError();
            renderRows(value.items); nextCursor = value.nextCursor; updatePagination();
            byId('adminStatus').textContent = 'Accounts refreshed after the role operation. Current filter membership may have changed.';
          })().catch((error) => { if (captured === epoch && query === queryEpoch && !suspended) {
            if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) showError(error);
            else byId('adminStatus').textContent = 'Role operation confirmed; the account list could not refresh. Use Refresh records to read it again.';
          } });
        },
      });
    } else renderAudit(result.item);
  } catch (error) {
    if (captured !== epoch || detail !== detailEpoch) return;
    closeDetail(); showError(error);
  }
}
function selectTab(next, { focus = false } = {}) {
  if (!tabs[next] || !permissions.includes(tabs[next].permission)) return;
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
    if (!Object.values(tabs).some((value) => permissions.includes(value.permission))) throw adminReadError('ADMIN_DENIED');
    owner = actor;
    for (const value of Object.values(tabs)) byId(`${value.prefix}Tab`).hidden = !permissions.includes(value.permission);
    byId('adminGate').hidden = true; workspace.hidden = false; workspace.inert = false;
    selectTab(permissions.includes(tabs[tab].permission) ? tab : Object.keys(tabs).find((name) => permissions.includes(tabs[name].permission)));
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
  node.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
    const allowed = Object.keys(tabs).filter((name) => permissions.includes(tabs[name].permission)); const index = allowed.indexOf(tab);
    selectTab(event.key === 'Home' ? allowed[0] : event.key === 'End' ? allowed.at(-1)
      : allowed[(index + (event.key === 'ArrowLeft' ? -1 : 1) + allowed.length) % allowed.length], { focus: true });
  });
}
for (const id of ['adminUsersFilters', 'adminAuditFilters', 'adminEarlyFilters', 'adminRequestsFilters']) {
  byId(id).addEventListener('submit', (event) => { event.preventDefault(); cursors = [null]; page = 0; void loadPage(); });
  byId(id).addEventListener('input', () => { clearRows(); cursors = [null]; page = 0; updatePagination(); updateFilterState(); byId('adminStatus').textContent = 'Filters changed. Apply filters to load records.'; });
}
byId('adminResetFilters').addEventListener('click', () => {
  const form = byId(`${tabs[tab].prefix}Filters`); form.reset();
  cursors = [null]; page = 0; updateFilterState();
  form.querySelector('input, select, button').focus(); void loadPage();
});
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
