import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';
const permissions = ['users.read', 'audit.read', 'operations.read', 'operations.manage'];
const requestId = '88000000-0000-4000-8000-000000000026';
async function ready(page) { await page.goto('/admin.html#early-access'); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25); }
async function detail(page) { await page.locator(`[data-early-request="${requestId}"] button`).click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending'); }
async function review(page) { await detail(page); await page.locator('#earlyAccessReviewDeny').click(); await expect(page.locator('#earlyAccessDenyConfirmation')).toBeVisible(); }
async function confirm(page) { await page.locator('#earlyAccessDenyReason').selectOption('early_access_review'); await page.locator('#earlyAccessDenyAcknowledgement').check(); await page.locator('#earlyAccessConfirmDeny').click(); }
async function reviewInvitation(page, action = 'Approve') { await page.locator(`#earlyAccessReview${action}`).click(); await expect(page.locator('#earlyAccessInvitationConfirmation')).toBeVisible(); }
async function confirmInvitation(page) { await page.locator('#earlyAccessInvitationReason').selectOption('early_access_review'); await page.locator('#earlyAccessInvitationAcknowledgement').check(); await page.locator('#earlyAccessConfirmInvitation').click(); }
async function buttonPaint(control) {
  return control.evaluate((button) => {
    const style = getComputedStyle(button);
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = (color) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const luminance = (color) => color.slice(0, 3).map((channel) => channel / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const background = rgba(style.backgroundColor); const text = rgba(style.color);
    const light = Math.max(luminance(background), luminance(text)); const dark = Math.min(luminance(background), luminance(text));
    return { background, text, contrast: (light + .05) / (dark + .05), opacity: style.opacity, cursor: style.cursor,
      outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, outlineOffset: style.outlineOffset, focusVisible: button.matches(':focus-visible') };
  });
}
async function assertDecisionPaint(page, control, action, { disabled = false, browserName } = {}) {
  await expect(control).toBeVisible(); await expect(control).toHaveAttribute('data-early-access-decision', action);
  await page.mouse.move(0, 0);
  const paint = await buttonPaint(control);
  expect(paint.opacity).toBe('1'); expect(paint.background[3]).toBe(255); expect(paint.text[3]).toBe(255);
  expect(paint.contrast).toBeGreaterThanOrEqual(4.5);
  if (disabled) {
    await expect(control).toBeDisabled(); expect(paint.cursor).toBe('not-allowed');
    await control.hover(); expect((await buttonPaint(control)).background).toEqual(paint.background);
    return;
  }
  await expect(control).toBeEnabled();
  const dominant = action === 'approve' ? 1 : 0;
  for (const channel of [0, 1, 2].filter((value) => value !== dominant)) expect(paint.background[dominant]).toBeGreaterThan(paint.background[channel]);
  if (await page.evaluate(() => matchMedia('(hover: hover)').matches)) {
    await control.hover(); const hovered = await buttonPaint(control);
    expect(hovered.background).not.toEqual(paint.background); expect(hovered.contrast).toBeGreaterThanOrEqual(4.5);
  }
  // Safari's default keyboard mode uses Option-Tab to include native buttons.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); await control.focus();
  const focused = await buttonPaint(control);
  expect(focused.focusVisible).toBe(true); expect(focused.outlineStyle).toBe('solid');
  expect(parseFloat(focused.outlineWidth)).toBeGreaterThanOrEqual(3); expect(parseFloat(focused.outlineOffset)).toBeGreaterThanOrEqual(3);
}
async function noStoredPayload(page) {
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toMatch(/Preview Applicant|applicant\d+@example.invalid|early_access_review|target_operation_id|target_correlation_id|expectedRevision|operationId|correlationId/);
}
async function replaceSessions(page, values) {
  await page.evaluate(async (sessions) => {
    const channel = new BroadcastChannel('sb-127-auth-token');
    for (const session of sessions) {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
      channel.postMessage({ event: 'SIGNED_IN', session }); await new Promise((resolve) => setTimeout(resolve, 0));
    }
    channel.close();
  }, values);
}
test('queue is capability-gated, keyset paginated, filterable and independent of read-only Users/Audit', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page);
  await page.locator('#adminNextPage').click(); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(4);
  expect(auth.requests.findLast((r) => r.path.endsWith('/site_admin_list_early_access_requests')).body.target_cursor).not.toBeNull();
  await page.locator('#adminFirstPage').click(); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25);
  await page.getByLabel('Applicant prefix (name or email)').fill('applicant26@');
  await expect(page.locator('#adminEarlyRows tr')).toHaveCount(0); await page.locator('#adminEarlyFilters button').click(); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Users', exact: true }).click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByRole('tab', { name: 'Audit', exact: true }).click(); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
  expect(auth.denials()).toHaveLength(0); await noStoredPayload(page);
});
test('operations-only reader can inspect requests but cannot see or perform denial', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions: ['operations.read'] }); await ready(page); await detail(page);
  await expect(page.locator('#adminUsersTab')).toBeHidden(); await expect(page.locator('#adminAuditTab')).toBeHidden();
  await expect(page.locator('#earlyAccessReviewDeny')).toBeHidden(); expect(auth.denials()).toHaveLength(0);
  for (const action of ['Approve', 'Resend', 'Revoke']) await expect(page.locator(`#earlyAccessReview${action}`)).toBeHidden();
  expect(auth.invitations()).toHaveLength(0);
  await expect(page.locator('#earlyAccessScope')).toContainText('does not revoke'); await expect(page.locator('#earlyAccessHistoryStatus')).toContainText('No administrative events');
});
test('a standard admin reader gets no early-access records without operations.read', async ({ page, context }) => {
  const auth = await installAdminStub(context); await page.goto('/admin.html'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await expect(page.locator('#adminEarlyTab')).toBeHidden(); expect(auth.requests.some((r) => r.path.includes('early_access'))).toBe(false);
});
test('denial needs explicit reason and acknowledgement, uses bound revision and emits only the reviewed RPC', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  expect(auth.denials()).toHaveLength(0); await expect(page.locator('#earlyAccessConfirmDeny')).toBeDisabled();
  await page.locator('#earlyAccessDenyReason').selectOption('early_access_review'); await expect(page.locator('#earlyAccessConfirmDeny')).toBeDisabled();
  await page.locator('#earlyAccessDenyAcknowledgement').check(); await page.locator('#earlyAccessConfirmDeny').click();
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('denied'); await expect(page.locator('#earlyAccessRequestRevision')).toHaveText('1');
  expect(auth.denials()).toHaveLength(1); const sent = auth.denials()[0];
  expect(sent.method).toBe('POST'); expect(sent.body.target_request_id).toBe(requestId); expect(sent.body.target_expected_revision).toBe('0'); expect(sent.body.target_expected_actor_id).toBe(auth.A);
  expect(Object.keys(sent.body).sort()).toEqual(['target_correlation_id', 'target_expected_actor_id', 'target_expected_revision', 'target_operation_id', 'target_request_id']);
  await expect(page.locator('#earlyAccessHistoryRows')).toContainText('9007199254740993');
  await expect(page.locator('#earlyAccessUnavailable')).toContainText('not available');
  expect(auth.requests.some((r) => /approve|invite|entitlement|bootstrap_site_admin/.test(r.path))).toBe(false); await noStoredPayload(page);
});
test('recent MFA step-up is required before opening confirmation and returning never auto-denies', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions, stepUpRequired: true }); await ready(page); await detail(page);
  await page.locator('#earlyAccessReviewDeny').click(); await expect(page.locator('#earlyAccessStepUp')).toBeVisible();
  await expect(page.locator('#earlyAccessDenyConfirmation')).toBeHidden();
  const href = new URL(await page.locator('#earlyAccessStepUp').getAttribute('href'), page.url()); expect(href.searchParams.get('mode')).toBe('step-up'); expect(href.searchParams.get('returnTo')).toBe('./admin.html');
  auth.stepUp(false); await page.goto(href.searchParams.get('returnTo')); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); expect(auth.denials()).toHaveLength(0);
});
test('MFA or capability loss after confirmation setup is checked again before sending', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  auth.stepUp(true); await confirm(page); await expect(page.locator('#earlyAccessStepUp')).toBeVisible(); expect(auth.denials()).toHaveLength(0);
  auth.stepUp(false); await page.locator('#adminDetailClose').click(); await review(page); auth.permissions(['operations.read']); await confirm(page);
  await expect(page.locator('#adminWorkspace')).toBeHidden(); expect(auth.denials()).toHaveLength(0);
});
for (const mode of ['lost', 'wrong-id']) test(`${mode} committed response retries exactly the same operation and correlation UUIDs`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.denialMode(mode); await confirm(page);
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('may already be denied');
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending'); expect(await page.content()).not.toContain('PRIVATE RAW ERROR');
  const original = structuredClone(auth.denials()[0].body); await page.locator('#earlyAccessConfirmDeny').click();
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('denied'); expect(auth.denials()).toHaveLength(2); expect(auth.denials()[1].body).toEqual(original);
  await expect(page.locator('#earlyAccessHistoryRows article')).toHaveCount(1); await noStoredPayload(page);
});
test('a shared rate limit preserves the reviewed revision and UUIDs for an explicit later retry', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.denialMode('limit'); await confirm(page);
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('limit has been reached');
  await expect(page.locator('#earlyAccessConfirmDeny')).toHaveText('Retry same denial');
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending');
  const original = structuredClone(auth.denials()[0].body); await page.locator('#earlyAccessConfirmDeny').click();
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('denied');
  expect(auth.denials()).toHaveLength(2); expect(auth.denials()[1].body).toEqual(original); await noStoredPayload(page);
});
test('stale revision and idempotency conflicts never refresh into an automatic denial', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.denialMode('conflict'); await confirm(page);
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('changed after'); await expect(page.locator('#earlyAccessReload')).toBeVisible();
  await expect(page.locator('#earlyAccessDenyConfirmation')).toBeHidden(); expect(auth.denials()).toHaveLength(1);
  await page.locator('#earlyAccessReload').click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending'); expect(auth.denials()).toHaveLength(1);
  await page.locator('#earlyAccessReviewDeny').click(); auth.denialMode('idempotency'); await confirm(page);
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('no longer matches'); await expect(page.locator('#earlyAccessDenyConfirmation')).toBeHidden(); expect(auth.denials()).toHaveLength(2);
});
test('history uses separate exact keyset pages and never treats missing delivery dates as sent', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await auth.seedEarlyHistory(requestId, 13); await ready(page); await detail(page);
  await expect(page.locator('#earlyAccessHistoryRows article')).toHaveCount(10); await page.locator('#earlyAccessHistoryNext').click(); await expect(page.locator('#earlyAccessHistoryRows article')).toHaveCount(3);
  await expect(page.locator('#earlyAccessHistoryRows')).toContainText('9007199254740993'); await page.locator('#earlyAccessHistoryPrevious').click(); await expect(page.locator('#earlyAccessHistoryRows article')).toHaveCount(10);
  await expect(page.locator('#adminDetailBody')).toContainText('Not recorded'); expect(auth.denials()).toHaveLength(0);
});
test('close, pagehide and changed session scrub confirmation and ignore delayed results', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  const release = auth.hold(['site_admin_deny_early_access_request']); await confirm(page); await expect.poll(() => auth.denials().length).toBe(1);
  await page.locator('#adminDetailClose').click(); release(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  await expect(page.locator('#adminDetailBody')).toBeEmpty(); await noStoredPayload(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminEarlyRows')).toBeEmpty();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25); expect(auth.denials()).toHaveLength(1);
});
for (const replacement of ['A→B→A', 'same actor, new immutable session']) test(`${replacement} cancels async review setup before any denial`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page);
  const count = auth.requests.filter((r) => r.path.endsWith('/get_site_admin_context')).length;
  const release = auth.hold(['get_site_admin_context']); await page.locator('#earlyAccessReviewDeny').click();
  await expect.poll(() => auth.requests.filter((r) => r.path.endsWith('/get_site_admin_context')).length).toBeGreaterThan(count);
  const replacementSession = replacement === 'A→B→A' ? auth.firstSession : auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222');
  await replaceSessions(page, replacement === 'A→B→A' ? [auth.session(auth.B), replacementSession] : [replacementSession]);
  release(); await expect(page.locator('#adminDetail')).not.toBeVisible(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  await expect(page.locator('#adminWorkspace')).toBeHidden(); expect(auth.denials()).toHaveLength(0);
  await page.locator('#adminRetryAccess').click(); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25); expect(auth.denials()).toHaveLength(0); await noStoredPayload(page);
});
test('same-session assurance loss cancels a prepared intent and cannot replay after verification', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  await page.evaluate((session) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    const channel = new BroadcastChannel('sb-127-auth-token'); channel.postMessage({ event: 'TOKEN_REFRESHED', session }); channel.close();
  }, auth.session(auth.A, 'aal1'));
  await expect(page.locator('#adminDetail')).not.toBeVisible(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(auth.denials()).toHaveLength(0); await page.locator('#adminRetryAccess').click(); await expect(page.locator('#adminMfa')).toBeVisible(); await noStoredPayload(page);
});
test('a stalled denial has a bounded uncertain state and explicitly retries the original operation', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await page.clock.install(); await ready(page); await review(page);
  const release = auth.hold(['site_admin_deny_early_access_request']); await confirm(page); await expect.poll(() => auth.denials().length).toBe(1);
  const original = structuredClone(auth.denials()[0].body); await page.clock.fastForward(20_001);
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('could not be confirmed'); await expect(page.locator('#earlyAccessConfirmDeny')).toBeEnabled();
  release(); await page.locator('#earlyAccessConfirmDeny').click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('denied');
  expect(auth.denials()).toHaveLength(2); expect(auth.denials()[1].body).toEqual(original); await noStoredPayload(page);
});
for (const phase of ['context', 'result']) test(`unnotified same-session assurance downgrade during ${phase} cannot use a captured bearer`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  const name = phase === 'context' ? 'get_site_admin_context' : 'site_admin_deny_early_access_request';
  const before = auth.requests.filter((value) => value.path.endsWith(`/${name}`)).length; const release = auth.hold([name]);
  await confirm(page); await expect.poll(() => auth.requests.filter((value) => value.path.endsWith(`/${name}`)).length).toBe(before + 1);
  // Deliberately omit both storage and BroadcastChannel notifications: the
  // installed SDK's next getSession must observe and fence the changed JWT.
  await page.evaluate((session) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), auth.session(auth.A, 'aal1'));
  release(); await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(auth.denials()).toHaveLength(phase === 'context' ? 0 : 1); await noStoredPayload(page);
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`approval is green and denial is red with readable states in ${theme}`, async ({ page, context, browserName }, testInfo) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page);
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await expect(page.locator('#earlyAccessReviewApprove')).toHaveText('Review approval');
  await expect(page.locator('#earlyAccessReviewDeny')).toHaveText('Review denial');
  await assertDecisionPaint(page, page.locator('#earlyAccessReviewApprove'), 'approve', { browserName });
  await assertDecisionPaint(page, page.locator('#earlyAccessReviewDeny'), 'deny', { browserName });
  await page.locator('.admin-review').screenshot({ path: testInfo.outputPath(`decision-colors-${theme}.png`) });
  for (const [action, title, prefix, confirmation] of [
    ['approve', 'Approve', 'earlyAccessInvitation', 'Approve and queue email'],
    ['deny', 'Deny', 'earlyAccessDeny', 'Confirm denial'],
  ]) {
    await page.locator(`#earlyAccessReview${title}`).click(); await expect(page.locator(`#${prefix}Confirmation`)).toBeVisible();
    const control = page.locator(action === 'deny' ? '#earlyAccessConfirmDeny' : '#earlyAccessConfirmInvitation');
    await expect(control).toHaveText(confirmation); await assertDecisionPaint(page, control, action, { disabled: true, browserName });
    await page.locator(`#${prefix}Reason`).selectOption('early_access_review'); await page.locator(`#${prefix}Acknowledgement`).check();
    await assertDecisionPaint(page, control, action, { browserName });
    await page.locator(action === 'deny' ? '#earlyAccessCancelDeny' : '#earlyAccessCancelInvitation').click();
    await expect(page.locator(`#${prefix}Confirmation`)).toBeHidden();
  }
  expect(auth.denials()).toHaveLength(0); expect(auth.invitations()).toHaveLength(0); await noStoredPayload(page);
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`queue and deliberate confirmation remain accessible in ${theme}`, async ({ page, context, browserName }, testInfo) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await page.locator('#earlyAccessDenyReason').boundingBox()).height).toBeGreaterThanOrEqual(48);
  expect(await page.locator('.admin-review-reason').evaluate((value) => getComputedStyle(value, '::after').borderRightWidth)).toBe('2px');
  const result = await new AxeBuilder({ page }).include('#adminDetail').analyze(); expect(result.violations).toEqual([]);
  await page.locator('#earlyAccessDenyReason').selectOption('early_access_review');
  await page.locator('#earlyAccessDenyAcknowledgement').check();
  await page.locator('#earlyAccessConfirmDeny').focus(); await expect(page.locator('#earlyAccessConfirmDeny')).toBeFocused();
  await page.locator('#earlyAccessConfirmDeny').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/77dc-early-access-${testInfo.project.name}-${theme}.png` });
  // Safari's default keyboard mode uses Option-Tab to include native buttons.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(page.locator('#earlyAccessCancelDeny')).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#earlyAccessConfirmDeny').scrollIntoViewIfNeeded();
  expect(await page.locator('#adminDetail').evaluate((value) => value.scrollWidth <= value.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Enter'); await expect(page.locator('#earlyAccessDenyConfirmation')).toBeHidden();
  await page.keyboard.press('Escape'); await expect(page.locator('#adminDetail')).not.toBeVisible(); expect(auth.denials()).toHaveLength(0); await noStoredPayload(page);
});
test('approval explicitly queues email without claiming delivery, acceptance or access', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page);
  await expect(page.locator('#earlyAccessReviewResend')).toBeHidden(); await expect(page.locator('#earlyAccessReviewRevoke')).toBeHidden();
  await reviewInvitation(page); await expect(page.locator('#earlyAccessConfirmInvitation')).toBeDisabled();
  expect(auth.invitations()).toHaveLength(0); await confirmInvitation(page);
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('approved');
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('email queued');
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('does not grant app access');
  await expect(page.locator('#earlyAccessHistoryRows')).toContainText('Approved · email queued');
  expect(auth.invitations()).toHaveLength(1); const sent = auth.invitations()[0];
  expect(sent.method).toBe('POST'); expect(sent.actor).toBe(auth.A); expect(sent.aal).toBe('aal2');
  expect(Object.keys(sent.body).sort()).toEqual(['action', 'correlationId', 'expectedActorId', 'expectedRevision', 'operationId', 'requestId']);
  expect(sent.body).toMatchObject({ action: 'approve', expectedActorId: auth.A, expectedRevision: '0', requestId });
  expect(auth.denials()).toHaveLength(0);
  await page.locator('#earlyAccessReload').click();
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('approved');
  await expect(page.locator('#adminDetailBody')).toContainText('Not recorded');
  await expect(page.locator('#earlyAccessReviewApprove')).toBeHidden(); await expect(page.locator('#earlyAccessReviewDeny')).toBeHidden();
  await noStoredPayload(page);
});
test('resend and revoke each need a fresh explicit review of the current revision', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page);
  await reviewInvitation(page); await confirmInvitation(page); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('approved');
  await page.locator('#earlyAccessReload').click();
  for (const action of ['Resend', 'Revoke']) {
    await expect(page.locator(`#earlyAccessReview${action}`)).toBeVisible();
    expect(await page.locator(`#earlyAccessReview${action}`).getAttribute('data-early-access-decision')).toBeNull();
  }
  await reviewInvitation(page, 'Resend');
  expect(await page.locator('#earlyAccessConfirmInvitation').getAttribute('data-early-access-decision')).toBeNull();
  expect((await buttonPaint(page.locator('#earlyAccessConfirmInvitation'))).background).toEqual((await buttonPaint(page.locator('#earlyAccessCancelInvitation'))).background);
  await expect(page.locator('#earlyAccessInvitationConfirmation')).toContainText('invalidates the previous invitation');
  await confirmInvitation(page); await expect(page.locator('#earlyAccessRequestRevision')).toHaveText('2');
  await page.locator('#earlyAccessReload').click(); await reviewInvitation(page, 'Revoke');
  expect(await page.locator('#earlyAccessConfirmInvitation').getAttribute('data-early-access-decision')).toBeNull();
  expect((await buttonPaint(page.locator('#earlyAccessConfirmInvitation'))).background).toEqual((await buttonPaint(page.locator('#earlyAccessCancelInvitation'))).background);
  await confirmInvitation(page);
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('revoked');
  await expect(page.locator('#earlyAccessReviewStatus')).toContainText('Existing account access was not changed');
  expect(auth.invitations().map((entry) => [entry.body.action, entry.body.expectedRevision])).toEqual([['approve', '0'], ['resend', '1'], ['revoke', '2']]);
  expect(new Set(auth.invitations().map((entry) => entry.body.operationId)).size).toBe(3);
  await expect(page.locator('#earlyAccessHistoryRows article')).toHaveCount(3); await noStoredPayload(page);
});
test('invitation MFA readiness is checked both before review and immediately before sending', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions, stepUpRequired: true }); await ready(page); await detail(page);
  await page.locator('#earlyAccessReviewApprove').click(); await expect(page.locator('#earlyAccessStepUp')).toBeVisible();
  await expect(page.locator('#earlyAccessInvitationConfirmation')).toBeHidden(); expect(auth.invitations()).toHaveLength(0);
  auth.stepUp(false); await reviewInvitation(page); auth.stepUp(true); await confirmInvitation(page);
  await expect(page.locator('#earlyAccessStepUp')).toBeVisible(); expect(auth.invitations()).toHaveLength(0);
  auth.stepUp(false); await page.goto('/admin.html#early-access'); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25);
  expect(auth.invitations()).toHaveLength(0); await noStoredPayload(page);
});
for (const mode of ['lost', 'wrong-id', 'rate_limited']) test(`invitation ${mode} only retries the original reviewed operation explicitly`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page); await reviewInvitation(page);
  auth.invitationMode(mode); await confirmInvitation(page);
  await expect(page.locator('#earlyAccessConfirmInvitation')).toHaveText('Retry same approval');
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending');
  expect(await page.content()).not.toContain('PRIVATE RAW ERROR');
  const original = structuredClone(auth.invitations()[0].body); await page.locator('#earlyAccessConfirmInvitation').click();
  await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('approved');
  expect(auth.invitations()).toHaveLength(2); expect(auth.invitations()[1].body).toEqual(original);
  await expect(page.locator('#earlyAccessHistoryRows article')).toHaveCount(1); await noStoredPayload(page);
});
for (const mode of ['revision_conflict', 'account_recovery_required', 'idempotency']) test(`invitation ${mode} requires reloading without replay`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page); await reviewInvitation(page);
  auth.invitationMode(mode); await confirmInvitation(page);
  await expect(page.locator('#earlyAccessInvitationConfirmation')).toBeHidden(); await expect(page.locator('#earlyAccessReload')).toBeVisible();
  expect(auth.invitations()).toHaveLength(1); expect(await page.content()).not.toContain('PRIVATE RAW ERROR');
  if (mode === 'account_recovery_required') await expect(page.locator('#earlyAccessReviewStatus')).toContainText('separate recovery review');
  await page.locator('#earlyAccessReload').click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending');
  expect(auth.invitations()).toHaveLength(1); await noStoredPayload(page);
});
for (const phase of ['context', 'result']) test(`invitation unnotified bearer replacement during ${phase} cannot publish or reuse old authority`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page); await reviewInvitation(page);
  const name = phase === 'context' ? 'get_site_admin_context' : 'admin-early-access-invitation';
  const before = auth.requests.filter((entry) => entry.path.endsWith(`/${name}`)).length; const release = auth.hold([name]);
  await confirmInvitation(page); await expect.poll(() => auth.requests.filter((entry) => entry.path.endsWith(`/${name}`)).length).toBe(before + 1);
  await page.evaluate((session) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), auth.session(auth.A, 'aal1'));
  release(); await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(auth.invitations()).toHaveLength(phase === 'context' ? 0 : 1); await noStoredPayload(page);
});
test('closing an in-flight invitation decision scrubs its intent and cannot replay on reopening', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await detail(page); await reviewInvitation(page);
  const release = auth.hold(['admin-early-access-invitation']); await confirmInvitation(page); await expect.poll(() => auth.invitations().length).toBe(1);
  await page.locator('#adminDetailClose').click(); release(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25); expect(auth.invitations()).toHaveLength(1); await noStoredPayload(page);
});
