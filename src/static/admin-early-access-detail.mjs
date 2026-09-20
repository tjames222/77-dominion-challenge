import { getAdminSessionOwner, getSiteAdminContext, listSiteAdminEarlyAccessHistory, denySiteAdminEarlyAccess } from './api.js';
import { adminReadError } from './admin-read-client.mjs';
import { createEarlyAccessDenialIntent, normalizeEarlyAccessHistory, EARLY_ACCESS_REASON } from './admin-early-access-contract.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

const node = (tag, text, id) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (id) value.id = id; return value; };
const button = (label, id) => { const value = node('button', label, id); value.type = 'button'; return value; };
const time = (value) => value ? `${new Date(value).toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'Not recorded';
const messages = { invalid_input: 'The reviewed request could not be used. Reload its details before starting again.',
  revision_conflict: 'This request changed after you opened it. Reload its details and review it again. No new denial will run automatically.',
  target_unavailable: 'This request is no longer available. Reload to check its current status.',
  invalid_state: 'This request is no longer pending. Reload its details before continuing.',
  rate_limited: 'The shared administration limit has been reached. Wait before explicitly retrying this same denial.' };

// Every private value and unfinished intent belongs to this one open dialog.
// Neither navigation nor returning from MFA can persist or replay a denial.
export function mountEarlyAccessDetail({ container, item, owner, permissions, isCurrent, onError, reload, onDenied }) {
  let disposed = false; let version = 0; let historyVersion = 0; let intent = null; let sending = false;
  let historyPage = 0; let historyCursors = [null]; let nextCursor = null;
  const pending = new Set();
  const current = (captured = version) => !disposed && captured === version && isCurrent();
  const run = async (work) => {
    const controller = new AbortController(); pending.add(controller);
    let timer;
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(adminReadError()); }, 20_000); });
    try { return await Promise.race([work(controller.signal), timeout]); }
    finally { clearTimeout(timer); pending.delete(controller); }
  };
  const assertOwner = async () => {
    const actor = await getAdminSessionOwner();
    if (!current() || actor.actorId !== owner.actorId || actor.sessionIdentity !== owner.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
    return actor;
  };
  const section = node('section'); section.append(node('h3', 'Request details'));
  const facts = node('dl');
  for (const [label, value, id] of [
    ['Request ID', item.id], ['Name', item.name], ['Email', item.email], ['Status', item.status, 'earlyAccessRequestStatus'],
    ['Revision', item.revision, 'earlyAccessRequestRevision'], ['Requested', time(item.requestedAt)], ['Updated', time(item.updatedAt)],
    ['Account match', item.account.status], ['Account ID', item.account.userId || 'Not recorded'],
    ['Invitation sent', time(item.invitationSentAt)], ['Invitation expires', time(item.invitationExpiresAt)], ['Accepted', time(item.acceptedAt)],
  ]) facts.append(node('dt', label), node('dd', value, id));
  section.append(facts, node('p', 'Delivery and acceptance remain “Not recorded” without actual evidence. Denial does not revoke an existing account or app access.', 'earlyAccessScope'));
  container.append(section);

  const review = node('section'); review.className = 'admin-review';
  review.append(node('h3', 'Review decision'));
  const reviewStatus = node('p', '', 'earlyAccessReviewStatus'); reviewStatus.setAttribute('role', 'status');
  const start = button('Review denial', 'earlyAccessReviewDeny');
  start.hidden = item.status !== 'pending' || !permissions.includes('operations.manage');
  const stepUp = node('a', 'Verify authenticator again', 'earlyAccessStepUp'); stepUp.hidden = true;
  stepUp.href = mfaChallengeHref('admin.html', location.origin, { stepUp: true });
  const refresh = button('Reload request details', 'earlyAccessReload'); refresh.hidden = true; refresh.addEventListener('click', reload);
  const form = node('form', undefined, 'earlyAccessDenyConfirmation'); form.hidden = true; form.autocomplete = 'off';
  form.append(node('h4', 'Confirm denial'), node('p', `Deny the pending request from ${item.name} (${item.email}) at revision ${item.revision}? This only denies this request; it does not send an email.`));
  const reasonLabel = node('label', 'Reason'); reasonLabel.className = 'admin-review-reason'; const reason = node('select', undefined, 'earlyAccessDenyReason'); reason.required = true;
  const placeholder = node('option', 'Choose a reason'); placeholder.value = ''; const supported = node('option', 'Early-access review'); supported.value = EARLY_ACCESS_REASON;
  reason.append(placeholder, supported); reasonLabel.append(reason);
  const acknowledgementLabel = node('label'); acknowledgementLabel.className = 'admin-review-acknowledgement';
  const acknowledgement = node('input', undefined, 'earlyAccessDenyAcknowledgement'); acknowledgement.type = 'checkbox'; acknowledgement.required = true;
  acknowledgementLabel.append(acknowledgement, node('span', 'I reviewed this request and want to deny it.'));
  const confirm = button('Confirm denial', 'earlyAccessConfirmDeny'); confirm.type = 'submit'; confirm.disabled = true;
  const cancel = button('Cancel review', 'earlyAccessCancelDeny');
  const actions = node('div'); actions.className = 'admin-actions'; actions.append(confirm, cancel);
  form.append(reasonLabel, acknowledgementLabel, actions);
  review.append(reviewStatus, start, stepUp, refresh, form,
    node('p', 'Approvals, invitations, email delivery, and access provisioning are not available here.', 'earlyAccessUnavailable'));
  container.append(review);
  const toggleConfirm = () => { confirm.disabled = sending || !intent || reason.value !== EARLY_ACCESS_REASON || !acknowledgement.checked; };
  reason.addEventListener('change', toggleConfirm); acknowledgement.addEventListener('change', toggleConfirm);
  const resetReview = () => { version += 1; intent = null; sending = false; form.reset(); form.hidden = true; form.removeAttribute('aria-busy'); start.disabled = false; start.hidden = item.status !== 'pending' || !permissions.includes('operations.manage'); confirm.textContent = 'Confirm denial'; toggleConfirm(); };
  cancel.addEventListener('click', () => { resetReview(); reviewStatus.textContent = 'Review cancelled. No new denial will be sent.'; start.focus(); });
  start.addEventListener('click', async () => {
    resetReview(); start.disabled = true; stepUp.hidden = true; refresh.hidden = true;
    const captured = version; reviewStatus.textContent = 'Checking current permission and authenticator readiness…';
    try {
      const { candidate, context } = await run(async (signal) => {
        const actor = await assertOwner();
        const candidate = createEarlyAccessDenialIntent(item, actor);
        const context = await getSiteAdminContext({ expectedUserId: actor.actorId, signal });
        await assertOwner(); return { candidate, context };
      });
      if (!current(captured)) return;
      if (!context.adminReady || !context.permissions.includes('operations.read') || !context.permissions.includes('operations.manage')) throw adminReadError('ADMIN_DENIED');
      if (context.stepUpRequired) { reviewStatus.textContent = adminReadError('ADMIN_STEP_UP_REQUIRED').message; stepUp.hidden = false; return; }
      intent = candidate; reviewStatus.textContent = 'Review the original request and choose the supported reason before confirming.';
      form.hidden = false; start.hidden = true; reason.focus();
    } catch (error) { if (current(captured)) { reviewStatus.textContent = adminReadError(error?.code).message; if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onError(error); } }
    finally { if (current(captured)) { start.disabled = false; toggleConfirm(); } }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current() || sending || !intent || reason.value !== EARLY_ACCESS_REASON || !acknowledgement.checked) return;
    const captured = version; const originalIntent = intent; sending = true; toggleConfirm();
    cancel.disabled = true; reason.disabled = true; acknowledgement.disabled = true; start.disabled = true;
    form.setAttribute('aria-busy', 'true'); reviewStatus.textContent = 'Submitting the reviewed denial…';
    try {
      // The adapter checks fresh context and the bound immutable session again
      // before its one write. It never updates the intent to a newer revision.
      const result = await run((signal) => denySiteAdminEarlyAccess(originalIntent, { signal }));
      if (!current(captured) || intent !== originalIntent) return;
      if (result.ok) {
        intent = null; form.hidden = true; start.hidden = true;
        container.querySelector('#earlyAccessRequestStatus').textContent = result.status;
        container.querySelector('#earlyAccessRequestRevision').textContent = result.revision;
        reviewStatus.textContent = 'Request denied. No invitation or email was sent, and existing account access was not changed.';
        onDenied(result); void loadHistory(true);
      } else {
        reviewStatus.textContent = messages[result.errorCode];
        if (result.errorCode === 'rate_limited') confirm.textContent = 'Retry same denial';
        else { intent = null; form.hidden = true; start.hidden = true; refresh.hidden = false; }
      }
    } catch (error) {
      if (!current(captured) || intent !== originalIntent) return;
      if (error?.code === 'ADMIN_STEP_UP_REQUIRED') { intent = null; form.hidden = true; stepUp.hidden = false; reviewStatus.textContent = adminReadError(error.code).message; }
      else if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) { intent = null; onError(error); }
      else if (error?.code === 'ADMIN_IDEMPOTENCY_CONFLICT') { intent = null; form.hidden = true; start.hidden = true; refresh.hidden = false; reviewStatus.textContent = adminReadError(error.code).message; }
      else { reviewStatus.textContent = 'The result could not be confirmed. The request may already be denied. Retry this same operation to retrieve its result, or close and reload the request; a new denial will never run automatically.'; confirm.textContent = 'Retry same denial'; }
    } finally {
      if (current(captured)) { sending = false; cancel.disabled = false; reason.disabled = false; acknowledgement.disabled = false; start.disabled = false; form.removeAttribute('aria-busy'); toggleConfirm(); }
    }
  });

  const history = node('section'); history.append(node('h3', 'Request history'));
  const historyStatus = node('p', '', 'earlyAccessHistoryStatus'); historyStatus.setAttribute('role', 'status');
  const events = node('div', undefined, 'earlyAccessHistoryRows');
  const previous = button('Previous history', 'earlyAccessHistoryPrevious'); const next = button('Next history', 'earlyAccessHistoryNext');
  const historyReload = button('Reload history', 'earlyAccessHistoryReload'); const label = node('span', 'History page 1', 'earlyAccessHistoryPage');
  const historyActions = node('div'); historyActions.className = 'admin-actions'; historyActions.append(previous, label, next, historyReload);
  history.append(historyStatus, events, historyActions); container.append(history);
  async function loadHistory(reset = false) {
    if (reset) { historyPage = 0; historyCursors = [null]; }
    const captured = ++historyVersion; const page = historyPage;
    events.replaceChildren(); previous.disabled = true; next.disabled = true; historyReload.disabled = true;
    historyStatus.textContent = 'Loading request history…';
    try {
      const result = await run((signal) => listSiteAdminEarlyAccessHistory({ target_request_id: item.id, target_limit: 10,
        target_cursor: historyCursors[page] }, { expectedUserId: owner.actorId, signal }));
      if (!current() || captured !== historyVersion) return;
      if (!Array.isArray(result.items) || result.items.length > 10 || (result.nextCursor !== null && (typeof result.nextCursor !== 'object' || Array.isArray(result.nextCursor)))) throw adminReadError();
      for (const raw of result.items) {
        const event = normalizeEarlyAccessHistory(raw, item.id); const entry = node('article');
        entry.append(node('h4', `${event.outcome === 'success' ? 'Denied' : 'Decision not applied'} · ${time(event.occurredAt)}`));
        const values = node('dl');
        for (const [key, value] of [['Event ID', event.id], ['Actor ID', event.actorId], ['Before', event.beforeStatus || 'Not recorded'], ['After', event.afterStatus || 'Not recorded'],
          ['Reason', 'Early-access review'], ['Outcome', event.outcome], ['Recorded result', event.errorCode || 'Success'], ['Operation ID', event.operationId], ['Correlation ID', event.correlationId], ['Environment', event.environment]]) values.append(node('dt', key), node('dd', value));
        entry.append(values); events.append(entry);
      }
      nextCursor = result.nextCursor; historyStatus.textContent = result.items.length ? `${result.items.length} recorded events. Dates shown in UTC.` : 'No administrative events are recorded for this request.';
      label.textContent = `History page ${page + 1}`;
    } catch (error) { if (current() && captured === historyVersion) { events.replaceChildren(); nextCursor = null; historyStatus.textContent = adminReadError(error?.code).message; if (['ADMIN_CHANGED', 'ADMIN_DENIED', 'ADMIN_SIGNED_OUT'].includes(error?.code)) onError(error); } }
    finally { if (current() && captured === historyVersion) { previous.disabled = page === 0; next.disabled = !nextCursor; historyReload.disabled = false; } }
  }
  previous.addEventListener('click', () => { if (historyPage > 0) { historyPage -= 1; void loadHistory(); } });
  next.addEventListener('click', () => { if (nextCursor) { historyCursors = historyCursors.slice(0, historyPage + 1); historyCursors.push(nextCursor); historyPage += 1; void loadHistory(); } });
  historyReload.addEventListener('click', () => void loadHistory(true)); void loadHistory();
  return () => { disposed = true; version += 1; historyVersion += 1; intent = null; for (const controller of pending) controller.abort(); pending.clear(); form.reset(); container.replaceChildren(); };
}
