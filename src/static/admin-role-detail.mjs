import { getAdminSessionOwner, getSiteAdminContext, assignSiteAdminRole, getSiteAdminUser, listSiteAdminAudit } from './api.js';
import { adminReadError } from './admin-read-client.mjs';
import { ROLE_REASONS, normalizeRoleTarget, createRoleAssignmentIntent } from './admin-role-contract.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

const node = (tag, text, id) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (id) value.id = id; return value; };
const button = (text, id) => { const value = node('button', text, id); value.type = 'button'; return value; };
const labelFor = (role) => role === 'site_admin' ? 'Site admin' : 'Member';
const privateErrors = ['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'];
const failures = {
  invalid_input: 'The server rejected this reviewed decision. Reload account details before starting a new review.',
  self_action_forbidden: 'You cannot change your own site role. This change was not applied.',
  target_unavailable: 'This account is no longer eligible for a role change. Reload its details before reviewing again.',
  revision_conflict: 'Another change updated this account role. This decision was not applied. Reload and review the new revision.',
  target_mfa_required: 'The target account needs a verified authenticator before it can become a site admin. This change was not applied.',
  rate_limited: 'The shared administration limit was reached before this change was applied. Wait, then explicitly retry this same reviewed role change. No retry runs automatically.',
};

// Entirely dialog-scoped. There is no URL/storage draft, retry loop, or MFA
// continuation. Closing or invalidating the dialog discards every decision.
export function mountRoleDetail({ container, item, owner, permissions, isCurrent, onError, reload, onCommitted, onFacts }) {
  if (!permissions.includes('users.read') || !permissions.includes('roles.manage')) return () => {};
  const section = node('section'); section.className = 'admin-review'; section.append(node('h3', 'Site role access'));
  const status = node('p', '', 'adminRoleStatus'); status.setAttribute('role', 'status'); section.append(status); container.append(section);
  let target;
  try { target = normalizeRoleTarget(item); }
  catch { status.textContent = 'This account has an unsupported role revision. Role changes are unavailable; reload details before trying again.'; return () => section.remove(); }
  if (target.id.toLowerCase() === owner.actorId.toLowerCase()) { status.textContent = 'You cannot change your own site role.'; return () => section.remove(); }
  let disposed = false; let version = 0; let sending = false; let intent = null; let committed = false; let refreshing = false;
  const pending = new Set();
  const current = (captured = version) => !disposed && captured === version && isCurrent();
  const run = async (work) => {
    const controller = new AbortController(); pending.add(controller); let timer;
    try { return await Promise.race([work(controller.signal), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(adminReadError()); }, 20_000); })]); }
    finally { clearTimeout(timer); pending.delete(controller); }
  };
  const assertOwner = async () => {
    const value = await getAdminSessionOwner();
    if (!current() || value.actorId !== owner.actorId || value.sessionIdentity !== owner.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
    return value;
  };
  const start = button('Review role change', 'adminRoleReview');
  const stepUp = node('a', 'Verify authenticator again', 'adminRoleStepUp'); stepUp.href = mfaChallengeHref('admin.html', location.origin, { stepUp: true }); stepUp.hidden = true;
  const reloadButton = button('Reload account details', 'adminRoleReload'); reloadButton.hidden = true; reloadButton.addEventListener('click', reload);
  const form = node('form', undefined, 'adminRoleConfirmation'); form.hidden = true; form.autocomplete = 'off';
  form.append(node('h4', 'Confirm site role change'), node('p', `Account: ${item.name || item.email || target.id}. User ID: ${target.id}. Reviewed role: ${labelFor(target.role)}. Revision: ${target.roleRevision}.`));
  const select = (title, id, options) => {
    const label = node('label', title); label.className = 'admin-review-reason'; const input = node('select', undefined, id); input.required = true;
    for (const [value, text] of options) { const option = node('option', text); option.value = value; input.append(option); }
    label.append(input); form.append(label); return input;
  };
  const role = select('New site role', 'adminRoleValue', [['', 'Choose a role'], ['member', 'Member'], ['site_admin', 'Site admin']]);
  role.querySelector(`option[value="${target.role}"]`).disabled = true;
  const reason = select('Reason', 'adminRoleReason', [['', 'Choose a reason'], ...Object.entries(ROLE_REASONS)]);
  const impact = node('p', 'Select the new role to review its impact.', 'adminRoleImpact'); impact.setAttribute('role', 'status');
  const acknowledgementLabel = node('label'); acknowledgementLabel.className = 'admin-review-acknowledgement';
  const acknowledgement = node('input', undefined, 'adminRoleAcknowledgement'); acknowledgement.type = 'checkbox'; acknowledgement.required = true;
  acknowledgementLabel.append(acknowledgement, node('span', 'I reviewed this account, new role, reason, and access impact. Apply this change.'));
  const confirm = button('Confirm role change', 'adminRoleConfirm'); confirm.type = 'submit'; confirm.disabled = true;
  const cancel = button('Cancel review', 'adminRoleCancel'); const actions = node('div'); actions.className = 'admin-actions'; actions.append(confirm, cancel);
  form.append(impact, acknowledgementLabel, actions);
  const audit = node('section', undefined, 'adminRoleAudit'); audit.hidden = true; audit.append(node('h4', 'Latest role audit for this account'));
  const auditRows = node('div'); audit.append(auditRows);
  const refreshStatus = node('p', '', 'adminRoleRefreshStatus'); refreshStatus.setAttribute('role', 'status');
  const refreshButton = button('Refresh account and audit', 'adminRoleRefresh'); refreshButton.hidden = true;
  section.append(start, stepUp, reloadButton, form, refreshStatus, refreshButton, audit);
  const validDecision = () => ['member', 'site_admin'].includes(role.value) && role.value !== target.role && Object.hasOwn(ROLE_REASONS, reason.value) && acknowledgement.checked;
  const toggle = () => { confirm.disabled = sending || (!intent && !validDecision()); };
  role.addEventListener('change', () => {
    acknowledgement.checked = false;
    impact.textContent = !role.value ? 'Select the new role to review its impact.' : `${role.value === 'site_admin' ? 'Grants site-wide administrative capabilities, subject to server permission and MFA checks. The target must already have a verified authenticator.' : 'Removes site-wide administrative capabilities; crew roles and membership are separate.'} Existing sessions will be blocked from administration. The target must sign out, sign in again, then verify MFA to use administration if still authorized. This does not globally sign out the account or revoke ordinary member access.`;
    toggle();
  });
  reason.addEventListener('change', () => { acknowledgement.checked = false; toggle(); }); acknowledgement.addEventListener('change', toggle);
  const discard = () => { version += 1; intent = null; sending = false; form.reset(); form.hidden = true; form.removeAttribute('aria-busy'); role.disabled = false; reason.disabled = false; acknowledgement.disabled = false; cancel.disabled = false; start.disabled = false; confirm.textContent = 'Confirm role change'; toggle(); };
  cancel.addEventListener('click', () => { discard(); start.hidden = false; status.textContent = 'Review cancelled. No new role change will be sent.'; start.focus(); });
  start.addEventListener('click', async () => {
    discard(); start.disabled = true; stepUp.hidden = true; reloadButton.hidden = true; const captured = version;
    status.textContent = 'Checking current permission and authenticator readiness…';
    try {
      const context = await run(async (signal) => { await assertOwner(); const result = await getSiteAdminContext({ expectedUserId: owner.actorId, signal }); await assertOwner(); return result; });
      if (!current(captured)) return;
      if (!context.adminReady || !context.permissions.includes('roles.manage') || !context.permissions.includes('users.read')) throw adminReadError('ADMIN_DENIED');
      if (context.stepUpRequired) { start.hidden = true; stepUp.hidden = false; reloadButton.hidden = false; status.textContent = `${adminReadError('ADMIN_STEP_UP_REQUIRED').message} Return here and start a fresh review; nothing will run automatically.`; return; }
      status.textContent = 'Choose the new role and reason, then review the impact before confirming.'; start.hidden = true; form.hidden = false; role.focus();
    } catch (error) { if (current(captured)) { status.textContent = adminReadError(error?.code).message; if (privateErrors.includes(error?.code)) onError(error); } }
    finally { if (current(captured)) start.disabled = false; }
  });
  async function refresh() {
    if (!current() || !committed || refreshing) return;
    refreshing = true; refreshButton.disabled = true; auditRows.replaceChildren(); refreshStatus.textContent = 'Refreshing read-only account details and audit…'; const captured = version;
    try {
      await run(async (signal) => {
        await assertOwner();
        const fresh = await getSiteAdminUser(target.id, { expectedUserId: owner.actorId, signal });
        await assertOwner();
        if (signal.aborted || !current(captured)) return;
        if (fresh.item?.id !== target.id) throw adminReadError(); normalizeRoleTarget(fresh.item);
        onFacts(fresh.item);
        if (permissions.includes('audit.read')) {
          const events = await listSiteAdminAudit({ target_user_id: target.id, target_action: 'roles.assign', target_outcome: 'all', target_limit: 10, target_cursor: null }, { expectedUserId: owner.actorId, signal });
          await assertOwner();
          if (signal.aborted || !current(captured)) return;
          if (!Array.isArray(events.items) || events.items.length > 10 || events.items.some((entry) => entry.targetUserId !== target.id || entry.action !== 'roles.assign' || !/^\d+$/.test(entry.id))) throw adminReadError();
          audit.hidden = false;
          for (const entry of events.items) auditRows.append(node('p', `Event ${entry.id}: ${entry.outcome} · ${entry.beforeRole} → ${entry.afterRole} · ${entry.occurredAt} · Request ${entry.requestId} · Correlation ${entry.correlationId}`));
          if (!events.items.length) auditRows.append(node('p', 'No role events were returned in this read.'));
        }
        await assertOwner();
      });
      if (current(captured)) refreshStatus.textContent = permissions.includes('audit.read') ? 'Account details and latest role audit refreshed. The receipt above describes the original operation; current details may reflect later changes.' : 'Account details refreshed. Audit access is not available for this account.';
    } catch (error) { if (current(captured)) { auditRows.replaceChildren(); refreshStatus.textContent = `The role-change receipt remains confirmed, but read-only refresh could not finish. ${adminReadError(error?.code).message}`; if (privateErrors.includes(error?.code)) onError(error); } }
    finally { if (current(captured)) { refreshing = false; refreshButton.disabled = false; } }
  }
  refreshButton.addEventListener('click', () => void refresh());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!current() || sending || committed || (!intent && !validDecision())) return;
    if (!intent) intent = createRoleAssignmentIntent(target, owner, { role: role.value, reasonCode: reason.value });
    const original = intent; const captured = version; sending = true; toggle(); cancel.disabled = true; role.disabled = true; reason.disabled = true; acknowledgement.disabled = true; form.setAttribute('aria-busy', 'true'); status.textContent = 'Submitting the reviewed role change…';
    const controller = new AbortController(); pending.add(controller);
    try {
      const result = await assignSiteAdminRole(original, { signal: controller.signal });
      if (!current(captured) || original !== intent) return;
      if (!result.ok && result.errorCode === 'rate_limited') { status.textContent = failures.rate_limited; confirm.textContent = 'Retry same role change'; return; }
      intent = null; form.hidden = true; reloadButton.hidden = false;
      if (result.ok) {
        committed = true; refreshButton.hidden = false;
        status.textContent = `Confirmed original operation: ${labelFor(result.role)} at revision ${result.revision}. Request ${original.operationId}; correlation ${original.correlationId}. Existing sessions cannot use administration; the target must sign out, sign in again, then verify MFA if still authorized. Ordinary member access was not globally signed out or revoked.`;
        onCommitted(); void refresh(); refreshButton.focus();
      } else { status.textContent = failures[result.errorCode]; reloadButton.focus(); }
    } catch (error) {
      if (!current(captured) || original !== intent) return;
      if (error?.code === 'ADMIN_ROLE_RESULT_UNCERTAIN') {
        status.textContent = 'The result could not be confirmed. The role change may already be committed. Retry this exact reviewed operation to retrieve its result, or close and reload. A retry never chooses a new role or revision, and never runs automatically.';
        confirm.textContent = 'Retry same role change';
      } else {
        intent = null; form.hidden = true; reloadButton.hidden = false;
        status.textContent = error?.code === 'ADMIN_RECOVERY_PROTECTED'
          ? 'The server protected the final usable site-admin recovery path. This role change was not applied.' : adminReadError(error?.code).message;
        if (error?.code === 'ADMIN_STEP_UP_REQUIRED') { stepUp.hidden = false; status.textContent += ' Return and start a fresh review; nothing will run automatically.'; }
        if (privateErrors.includes(error?.code)) onError(error); else (error?.code === 'ADMIN_STEP_UP_REQUIRED' ? stepUp : reloadButton).focus();
      }
    } finally { pending.delete(controller); if (current(captured)) { sending = false; cancel.disabled = false; form.removeAttribute('aria-busy'); toggle(); } }
  });
  return () => { disposed = true; version += 1; intent = null; for (const controller of pending) controller.abort(); pending.clear(); form.reset(); section.remove(); };
}
