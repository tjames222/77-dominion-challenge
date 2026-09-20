import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';
const permissions = ['users.read', 'audit.read', 'operations.read', 'operations.manage'];
const requestId = '88000000-0000-4000-8000-000000000026';
async function ready(page) { await page.goto('/admin.html#early-access'); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25); }
async function detail(page) { await page.locator(`[data-early-request="${requestId}"] button`).click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending'); }
async function review(page) { await detail(page); await page.locator('#earlyAccessReviewDeny').click(); await expect(page.locator('#earlyAccessDenyConfirmation')).toBeVisible(); }
async function confirm(page) { await page.locator('#earlyAccessDenyReason').selectOption('early_access_review'); await page.locator('#earlyAccessDenyAcknowledgement').check(); await page.locator('#earlyAccessConfirmDeny').click(); }
async function noStoredPayload(page) {
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toMatch(/Preview Applicant|applicant\d+@example.invalid|early_access_review|target_operation_id|target_correlation_id/);
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
