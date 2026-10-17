import { getAdminSessionOwner, getSiteAdminContext, getSiteAdminProfileName, correctSiteAdminProfileName } from './api.js';
import { adminReadError, withAdminReadDeadline } from './admin-read-client.mjs';
import { normalizeAdminProfileName, validAdminProfileName, createProfileNameIntent } from './admin-profile-name-contract.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

const node = (tag, text, id) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (id) value.id = id; return value; };
const button = (text, id) => { const value = node('button', text, id); value.type = 'button'; return value; };
const privateErrors = ['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'];
const unavailable = {
  self_action_forbidden: 'Use your own Profile page to change your display name.',
  target_unavailable: 'This account is not eligible for a display-name correction.',
  missing_profile: 'No profile is available. This tool does not create profiles.',
  missing_version: 'The profile version is unavailable. No correction can be submitted.',
  unsupported_legacy_name: 'The stored name is outside this tool’s supported format. It has not been truncated or changed.',
};
const failures = {
  invalid_input: 'The reviewed correction was rejected. Reload account details and start a new review.',
  revision_conflict: 'The name changed during review. This correction was not applied. Reload and review the current name.',
  self_action_forbidden: unavailable.self_action_forbidden,
  target_unavailable: unavailable.target_unavailable,
  profile_unavailable: 'The profile or its version is no longer available. Reload account details.',
  unsupported_legacy_name: unavailable.unsupported_legacy_name,
  rate_limited: 'The shared administration limit was reached. Wait, then explicitly retry this same reviewed correction. Nothing retries automatically.',
};

// Dialog lifetime only: no storage, URL draft, MFA continuation or optimistic
// replacement. Both the reviewed name and intent are scrubbed on disposal.
export function mountProfileNameDetail({ container, targetUserId, owner, permissions, isCurrent, onError, reload, onCommitted }) {
  if (!permissions.includes('users.read') || !permissions.includes('users.manage')) return () => {};
  const section = node('section'); section.className = 'admin-review admin-profile-name';
  section.append(node('h3', 'Display-name correction'), node('p', 'Changes only this account’s profile display name. Email, sign-in details, access, roles, avatar and billing stay unchanged. No notification is sent.'));
  const status = node('p', '', 'adminProfileNameStatus'); status.setAttribute('role', 'status'); status.tabIndex = -1;
  const start = button('Edit display name', 'adminProfileNameReview');
  const stepUp = node('a', 'Verify authenticator again', 'adminProfileNameStepUp'); stepUp.href = mfaChallengeHref('admin.html', location.origin, { stepUp: true }); stepUp.hidden = true;
  const reloadButton = button('Reload account details', 'adminProfileNameReload'); reloadButton.hidden = true; reloadButton.addEventListener('click', reload);
  const form = node('form', undefined, 'adminProfileNameForm'); form.hidden = true; form.autocomplete = 'off';
  form.append(node('p', `Target user ID: ${targetUserId}`));
  const before = node('p', '', 'adminProfileNameCurrent'); const proposed = node('p', '', 'adminProfileNameProposed');
  const label = node('label', 'New display name');
  const input = node('input', undefined, 'adminProfileNameInput'); input.type = 'text'; input.required = true;
  input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 240; input.setAttribute('aria-describedby', 'adminProfileNameHelp');
  label.append(input);
  const help = node('p', 'Use 1–120 characters, without leading/trailing spaces or control characters. Your reviewed spelling is saved exactly; no trimming or normalization.', 'adminProfileNameHelp');
  const acknowledgementLabel = node('label'); acknowledgementLabel.className = 'admin-review-acknowledgement';
  const acknowledgement = node('input', undefined, 'adminProfileNameAcknowledgement'); acknowledgement.type = 'checkbox'; acknowledgement.required = true;
  acknowledgementLabel.append(acknowledgement, node('span', 'I reviewed the target account and the exact current and proposed names. Apply this correction.'));
  const confirm = button('Save name', 'adminProfileNameConfirm'); confirm.type = 'submit'; confirm.disabled = true;
  const cancel = button('Cancel review', 'adminProfileNameCancel'); const actions = node('div'); actions.className = 'admin-actions'; actions.append(confirm, cancel);
  form.append(before, label, help, proposed, acknowledgementLabel, actions);
  const refresh = button('Refresh current name', 'adminProfileNameRefresh'); refresh.hidden = true;
  const freshStatus = node('p', '', 'adminProfileNameRefreshStatus'); freshStatus.setAttribute('role', 'status');
  section.append(status, start, stepUp, form, reloadButton, refresh, freshStatus); container.append(section);
  let disposed = false; let generation = 0; let busy = false; let snapshot = null; let intent = null; let committed = false;
  const pending = new Set();
  const current = (captured = generation) => !disposed && captured === generation && isCurrent();
  const assertOwner = async signal => {
    const value = await getAdminSessionOwner({ signal });
    if (!current() || signal.aborted || value.actorId !== owner.actorId || value.sessionIdentity !== owner.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
  };
  const read = async (withContext = false) => {
    const controller = new AbortController(); pending.add(controller);
    try { return await withAdminReadDeadline(async ({ signal, assertActive }) => {
      await assertOwner(signal); assertActive();
      if (withContext) {
        const context = await getSiteAdminContext({ expectedUserId: owner.actorId, signal });
        await assertOwner(signal); assertActive();
        if (!context.adminReady || !context.permissions.includes('users.read') || !context.permissions.includes('users.manage')) throw adminReadError('ADMIN_DENIED');
        if (context.stepUpRequired) throw adminReadError('ADMIN_STEP_UP_REQUIRED');
      }
      const value = await getSiteAdminProfileName(targetUserId, { expectedUserId: owner.actorId, signal });
      await assertOwner(signal); assertActive();
      return normalizeAdminProfileName(value, { actorId: owner.actorId, targetUserId });
    }, { signal: controller.signal }); } finally { pending.delete(controller); }
  };
  const toggle = () => { confirm.disabled = busy || (!intent && (!snapshot || !validAdminProfileName(input.value) || !acknowledgement.checked)); };
  const discard = () => {
    generation++; for (const controller of pending) controller.abort(); pending.clear(); snapshot = null; intent = null; busy = false;
    form.reset(); input.value = ''; before.textContent = ''; proposed.textContent = ''; form.hidden = true; form.removeAttribute('aria-busy');
    input.disabled = false; acknowledgement.disabled = false; cancel.disabled = false; start.disabled = false; confirm.textContent = 'Save name'; toggle();
  };
  const fail = cause => {
    status.textContent = adminReadError(cause?.code).message;
    if (privateErrors.includes(cause?.code)) onError(cause);
    else if (cause?.code === 'ADMIN_STEP_UP_REQUIRED') {
      stepUp.hidden = false; status.textContent += ' Return here and start a fresh review; nothing will run automatically.'; stepUp.focus();
    } else { reloadButton.hidden = false; status.focus(); }
  };
  input.addEventListener('input', () => {
    acknowledgement.checked = false; proposed.textContent = `Proposed name: ${input.value}`;
    input.setCustomValidity(validAdminProfileName(input.value) ? '' : 'Use a valid 1–120-character name without edge spaces or control characters.'); toggle();
  });
  acknowledgement.addEventListener('change', toggle);
  cancel.addEventListener('click', () => { const uncertain = !!intent; discard(); start.hidden = false;
    status.textContent = uncertain ? 'Review discarded. A previously submitted correction may already be committed. Reload account details to read the current name; nothing will be resent.' : 'Review cancelled. No correction was submitted.'; start.focus(); });
  start.addEventListener('click', async () => {
    if (busy || committed || !current()) return;
    discard(); const captured = generation; busy = true; start.disabled = true; stepUp.hidden = true; reloadButton.hidden = true;
    status.textContent = 'Checking current permission and reading the exact profile name…';
    try {
      const value = await read(true); if (!current(captured)) return;
      if (value.profile.state !== 'editable') { status.textContent = unavailable[value.profile.reason]; reloadButton.hidden = false; return; }
      snapshot = value; input.value = value.profile.name; input.setCustomValidity('');
      before.textContent = `Current name at review: ${value.profile.name}`; proposed.textContent = `Proposed name: ${value.profile.name}`;
      start.hidden = true; form.hidden = false; status.textContent = 'Review the exact name and account, then confirm. Leaving the name unchanged records a no-change review.'; input.focus();
    } catch (cause) { if (current(captured)) fail(cause); }
    finally { if (current(captured)) { busy = false; start.disabled = false; toggle(); } }
  });
  refresh.addEventListener('click', async () => {
    if (!current() || !committed || busy) return;
    const captured = generation; busy = true; refresh.disabled = true; freshStatus.textContent = 'Reading the current name…';
    try { const value = await read(); if (!current(captured)) return;
      freshStatus.textContent = value.profile.state === 'editable'
        ? `Current profile name: ${value.profile.name}. Observed ${value.observedAt}. This may reflect changes after the original operation.`
        : unavailable[value.profile.reason];
    } catch (cause) { if (current(captured)) { freshStatus.textContent = 'The original receipt remains confirmed, but the current name could not be read.'; if (privateErrors.includes(cause?.code)) onError(cause); } }
    finally { if (current(captured)) { busy = false; refresh.disabled = false; } }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!current() || busy || committed || (!intent && (!snapshot || !validAdminProfileName(input.value) || !acknowledgement.checked))) return;
    if (!intent) intent = createProfileNameIntent(snapshot, owner, input.value);
    const original = intent; const captured = generation; busy = true; input.disabled = true; acknowledgement.disabled = true; cancel.disabled = true;
    form.setAttribute('aria-busy', 'true'); toggle(); status.textContent = 'Submitting the reviewed display-name correction…';
    const controller = new AbortController(); pending.add(controller);
    try {
      const result = await correctSiteAdminProfileName(original, { signal: controller.signal });
      if (!current(captured) || original !== intent) return;
      if (!result.ok && result.error === 'rate_limited') { status.textContent = failures.rate_limited; confirm.textContent = 'Retry same correction'; return; }
      intent = null; snapshot = null; form.hidden = true; form.reset(); input.value = ''; before.textContent = ''; proposed.textContent = ''; reloadButton.hidden = false;
      if (result.ok) {
        committed = true; refresh.hidden = false;
        status.textContent = `Confirmed original operation: ${result.changed ? 'display name corrected' : 'no name change was needed'}. Request ${result.operationId}; correlation ${result.correlationId}. This receipt does not establish the current name. Use Refresh current name to read it.`;
        onCommitted(); status.focus();
      } else { status.textContent = failures[result.error]; status.focus(); }
    } catch (cause) {
      if (!current(captured) || original !== intent) return;
      if (cause?.code === 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN') {
        status.textContent = 'The result could not be confirmed. The correction may already be committed. Explicitly retry this exact reviewed operation to retrieve its original result, or discard it and reload. Nothing retries automatically.';
        confirm.textContent = 'Retry same correction'; status.focus();
      } else { intent = null; snapshot = null; form.reset(); input.value = ''; before.textContent = ''; proposed.textContent = ''; form.hidden = true; fail(cause); }
    } finally { pending.delete(controller); if (current(captured)) { busy = false; cancel.disabled = false; form.removeAttribute('aria-busy'); toggle(); } }
  });
  if (targetUserId === owner.actorId) { status.textContent = unavailable.self_action_forbidden; start.hidden = true; }
  return () => { disposed = true; discard(); freshStatus.textContent = ''; status.textContent = ''; section.remove(); };
}
