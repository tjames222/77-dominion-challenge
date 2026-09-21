import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';
const permissions = ['users.read', 'roles.manage', 'audit.read'];
const target = '70000000-0000-4000-8000-000000000028';
async function ready(page) { await page.goto('/admin.html'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); }
async function detail(page) { await page.getByRole('button', { name: 'View details for Preview Member 28', exact: true }).click(); await expect(page.locator('#adminUserFacts')).toContainText(target); }
async function review(page) { await detail(page); await page.locator('#adminRoleReview').click(); await expect(page.locator('#adminRoleConfirmation')).toBeVisible(); }
async function choose(page) { await page.locator('#adminRoleValue').selectOption('site_admin'); await page.locator('#adminRoleReason').selectOption('staff_access_review'); await page.locator('#adminRoleAcknowledgement').check(); }
async function confirm(page) { await choose(page); await page.locator('#adminRoleConfirm').click(); }
async function noStoredDecision(page) { const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); expect(storage).not.toMatch(/target_request_id|target_correlation_id|staff_access_review|Preview Member 28/); }
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
  await context.routeWebSocket('**/*', (socket) => socket.close());
});

test('read-only users have no role control; role authority without users.read cannot inspect accounts', async ({ page, context }) => {
  const auth = await installAdminStub(context); await ready(page); await detail(page); await expect(page.locator('#adminRoleReview')).toHaveCount(0);
  auth.permissions(['roles.manage']); await page.reload(); await expect(page.locator('#adminWorkspace')).toBeHidden(); expect(auth.assignments()).toHaveLength(0);
});
test('explicit role/reason/impact acknowledgement makes one write and refreshes current facts, list and audit', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  await expect(page.locator('#adminRoleConfirm')).toBeDisabled(); await expect(page.locator('#adminRoleValue option[value="member"]')).toHaveJSProperty('disabled', true);
  await choose(page); await expect(page.locator('#adminRoleImpact')).toContainText('does not globally sign out');
  await page.locator('#adminRoleReason').selectOption('approved_role_change'); await expect(page.locator('#adminRoleAcknowledgement')).not.toBeChecked(); await expect(page.locator('#adminRoleConfirm')).toBeDisabled();
  await page.locator('#adminRoleAcknowledgement').check(); await page.locator('#adminRoleConfirm').click();
  await expect(page.locator('#adminRoleStatus')).toContainText('Confirmed original operation: Site admin at revision 1');
  await expect(page.locator('#adminRoleRefreshStatus')).toContainText('Account details and latest role audit refreshed');
  await expect(page.locator('#adminUserFacts')).toContainText('site_admin');
  expect(auth.assignments()).toHaveLength(1); expect(auth.roleEvents).toHaveLength(1); await expect(page.locator('#adminRoleAudit')).toContainText(auth.assignments()[0].body.target_request_id);
  await page.locator('#adminDetailClose').click(); await expect(page.getByRole('row').filter({ hasText: 'Preview Member 28' })).toContainText('Site admin'); await noStoredDecision(page);
});
test('recent MFA is required both before review and again at confirmation, without replay', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions, stepUpRequired: true }); await ready(page); await detail(page); await page.locator('#adminRoleReview').click();
  await expect(page.locator('#adminRoleStepUp')).toBeVisible(); await expect(page.locator('#adminRoleConfirmation')).toBeHidden(); expect(auth.assignments()).toHaveLength(0);
  await expect(page.locator('#adminRoleStepUp')).toHaveAttribute('href', /mode=step-up/);
  auth.stepUp(false); await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); expect(auth.assignments()).toHaveLength(0); await review(page); await choose(page);
  auth.stepUp(true); await page.locator('#adminRoleConfirm').click(); await expect(page.locator('#adminRoleStepUp')).toBeVisible(); expect(auth.assignments()).toHaveLength(0); await noStoredDecision(page);
});
test('removing site admin requires a fresh reviewed member decision and preserves the access distinction', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); auth.roleTarget(target, { role: 'site_admin', roleRevision: 3 }); await ready(page); await review(page);
  await expect(page.locator('#adminRoleValue option[value="site_admin"]')).toHaveJSProperty('disabled', true);
  await page.locator('#adminRoleValue').selectOption('member'); await page.locator('#adminRoleReason').selectOption('recovery_plan');
  await expect(page.locator('#adminRoleImpact')).toContainText('Removes site-wide administrative capabilities; crew roles and membership are separate.');
  await page.locator('#adminRoleAcknowledgement').check(); await page.locator('#adminRoleConfirm').click();
  await expect(page.locator('#adminRoleStatus')).toContainText('Member at revision 4'); await expect(page.locator('#adminRoleRefreshStatus')).toContainText('refreshed');
  expect(auth.assignments()[0].body.target_role).toBe('member'); expect(auth.assignments()[0].body.target_expected_revision).toBe(3); await noStoredDecision(page);
});
test('uncertain committed response retries exact IDs and receipt does not overwrite a newer current role', async ({ page, context }, testInfo) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.roleMode('lost'); await confirm(page);
  await expect(page.locator('#adminRoleConfirm')).toHaveText('Retry same role change'); await expect(page.locator('#adminRoleValue')).toBeDisabled(); await expect(page.locator('#adminRoleReason')).toBeDisabled();
  await page.locator('#adminRoleStatus').scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/77dc-admin-role-${testInfo.project.name}-uncertain.png` });
  await page.locator('#adminRoleConfirm').scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/77dc-admin-role-${testInfo.project.name}-uncertain-actions.png` });
  const original = structuredClone(auth.assignments()[0].body); expect(auth.assignments()).toHaveLength(1);
  auth.roleTarget(target, { role: 'member', roleRevision: 2 }); await page.locator('#adminRoleConfirm').click();
  await expect(page.locator('#adminRoleStatus')).toContainText('Site admin at revision 1'); await expect(page.locator('#adminRoleRefreshStatus')).toContainText('refreshed');
  await expect(page.locator('#adminUserFacts')).not.toContainText('site_admin');
  await page.locator('#adminRoleStatus').scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/77dc-admin-role-${testInfo.project.name}-receipt.png` });
  expect(auth.assignments()).toHaveLength(2); expect(auth.assignments()[1].body).toEqual(original); expect(auth.roleEvents).toHaveLength(1); await noStoredDecision(page);
});
for (const [mode, message] of [['revision_conflict', 'Another change'], ['target_mfa_required', 'verified authenticator'], ['target_unavailable', 'no longer eligible'], ['self_action_forbidden', 'cannot change your own'], ['invalid_input', 'server rejected'], ['recovery', 'final usable'], ['idempotency', 'no longer matches']]) test(`${mode} failure ends that review without retry/rebase`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.roleMode(mode); await confirm(page);
  await expect(page.locator('#adminRoleStatus')).toContainText(message); await expect(page.locator('#adminRoleConfirmation')).toBeHidden(); await expect(page.locator('#adminRoleReload')).toBeVisible();
  expect(auth.assignments()).toHaveLength(1); await page.locator('#adminRoleReload').click(); await expect(page.locator('#adminRoleReview')).toBeVisible(); expect(auth.assignments()).toHaveLength(1);
  await page.locator('#adminRoleReview').click(); await confirm(page); await expect.poll(() => auth.assignments().length).toBe(2); expect(auth.assignments()[1].body.target_request_id).not.toBe(auth.assignments()[0].body.target_request_id); await noStoredDecision(page);
});
test('rate limit permits only an explicit exact retry after waiting', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.roleMode('limit'); await confirm(page);
  await expect(page.locator('#adminRoleStatus')).toContainText('administration limit'); await expect(page.locator('#adminRoleConfirm')).toHaveText('Retry same role change'); expect(auth.roleEvents).toHaveLength(0);
  const original = structuredClone(auth.assignments()[0].body); await page.locator('#adminRoleConfirm').click(); await expect(page.locator('#adminRoleStatus')).toContainText('Confirmed original operation'); expect(auth.assignments()[1].body).toEqual(original); await noStoredDecision(page);
});
test('unsafe numeric revisions disable mutation rather than stringify a rounded value', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); auth.roleTarget(target, { roleRevision: Number.MAX_SAFE_INTEGER + 1 }); await ready(page); await detail(page);
  await expect(page.locator('#adminRoleStatus')).toContainText('unsupported role revision'); await expect(page.locator('#adminRoleReview')).toHaveCount(0); expect(auth.assignments()).toHaveLength(0);
});
for (const phase of ['context', 'result']) test(`silent same-session assurance loss during ${phase} scrubs the review`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  const name = phase === 'context' ? 'get_site_admin_context' : 'site_admin_assign_role'; const before = auth.requests.filter((r) => r.path.endsWith(`/${name}`)).length; const release = auth.hold([name]);
  await confirm(page); await expect.poll(() => auth.requests.filter((r) => r.path.endsWith(`/${name}`)).length).toBe(before + 1);
  await page.evaluate((session) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), auth.session(auth.A, 'aal1')); release();
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetailBody')).toBeEmpty(); expect(auth.assignments()).toHaveLength(phase === 'context' ? 0 : 1); await noStoredDecision(page);
});
test('a stalled write has a bounded uncertain result; explicit retry retains IDs', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await page.clock.install(); await ready(page); await review(page); const release = auth.hold(['site_admin_assign_role']); await confirm(page);
  await expect.poll(() => auth.assignments().length).toBe(1); const original = structuredClone(auth.assignments()[0].body); await page.clock.fastForward(20_001);
  await expect(page.locator('#adminRoleConfirm')).toHaveText('Retry same role change'); release(); await page.locator('#adminRoleConfirm').click(); await expect(page.locator('#adminRoleStatus')).toContainText('Confirmed original operation'); expect(auth.assignments()[1].body).toEqual(original);
});
test('closing an uncertain decision discards its IDs and never replays when details reopen', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); auth.roleMode('lost'); await confirm(page); await expect(page.locator('#adminRoleConfirm')).toHaveText('Retry same role change');
  await page.locator('#adminDetailClose').click(); await detail(page); await expect(page.locator('#adminRoleReview')).toBeVisible(); expect(auth.assignments()).toHaveLength(1); await noStoredDecision(page);
});
for (const change of ['actor round trip', 'replacement session', 'pagehide']) test(`${change} scrubs a prepared role decision and never replays`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); await choose(page);
  if (change === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  else await page.evaluate(async (values) => {
    const channel = new BroadcastChannel('sb-127-auth-token');
    for (const session of values) { localStorage.setItem('sb-127-auth-token', JSON.stringify(session)); window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) })); channel.postMessage({ event: 'SIGNED_IN', session }); await new Promise((resolve) => setTimeout(resolve, 0)); }
    channel.close();
  }, change === 'actor round trip' ? [auth.session(auth.B), auth.session(auth.A)] : [auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222')]);
  await expect(page.locator('#adminDetailBody')).toBeEmpty(); expect(auth.assignments()).toHaveLength(0); await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); expect(auth.assignments()).toHaveLength(0); await noStoredDecision(page);
});
test('closing during a submitted write ignores late completion and only a fresh read shows current state', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); const release = auth.hold(['site_admin_assign_role']); await confirm(page); await expect.poll(() => auth.assignments().length).toBe(1);
  await page.locator('#adminDetailClose').click(); release(); await expect(page.locator('#adminDetailBody')).toBeEmpty(); await expect.poll(() => auth.roleEvents.length).toBe(1);
  await detail(page); await expect(page.locator('#adminUserFacts')).toContainText('site_admin'); expect(auth.assignments()).toHaveLength(1); await noStoredDecision(page);
});
test('failed post-success reads retain a truthful receipt without stale account facts or automatic writes', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  await context.route('**/rpc/site_admin_get_user', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'PRIVATE RAW ERROR SENTINEL' }) }));
  await confirm(page); await expect(page.locator('#adminRoleStatus')).toContainText('Confirmed original operation'); await expect(page.locator('#adminRoleRefreshStatus')).toContainText('read-only refresh could not finish');
  await expect(page.locator('#adminUserFacts')).toBeEmpty(); await expect(page.locator('#adminDetailBody')).not.toContainText('PRIVATE RAW'); expect(auth.assignments()).toHaveLength(1);
  await context.unroute('**/rpc/site_admin_get_user'); await page.locator('#adminRoleRefresh').click(); await expect(page.locator('#adminRoleRefreshStatus')).toContainText('refreshed'); expect(auth.assignments()).toHaveLength(1);
});
test('a delayed post-success account-list refresh completes after the originating dialog closes', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page);
  const release = auth.hold(['site_admin_list_users']); await confirm(page); await expect(page.locator('#adminRoleStatus')).toContainText('Confirmed original operation');
  await expect.poll(() => auth.requests.filter((entry) => entry.path.endsWith('/site_admin_list_users')).length).toBe(2);
  await page.locator('#adminDetailClose').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0); release();
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); await expect(page.locator('#adminStatus')).toContainText('Accounts refreshed');
  expect(auth.assignments()).toHaveLength(1); await expect(page.locator('#adminDetailBody')).toBeEmpty();
});
test('silent replacement session cannot start post-success detail or audit refresh under the old dialog owner', async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); await confirm(page);
  await expect(page.locator('#adminRoleRefreshStatus')).toContainText('refreshed'); await expect(page.locator('#adminStatus')).toContainText('Accounts refreshed'); const reads = auth.reads().length;
  await page.evaluate((session) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222'));
  await page.locator('#adminRoleRefresh').click(); await expect(page.locator('#adminDetailBody')).toBeEmpty(); await expect(page.locator('#adminWorkspace')).toBeHidden();
  expect(auth.reads()).toHaveLength(reads); expect(auth.assignments()).toHaveLength(1); await noStoredDecision(page);
});
for (const phase of ['facts', 'audit']) test(`timed-out ${phase} owner verification cannot overwrite a newer successful refresh`, async ({ page, context }) => {
  const auth = await installAdminStub(context, { permissions }); await page.clock.install(); await ready(page); await review(page); await confirm(page);
  await expect(page.locator('#adminRoleRefreshStatus')).toContainText('refreshed'); await expect(page.locator('#adminStatus')).toContainText('Accounts refreshed');
  const expectedAuditRows = await page.locator('#adminRoleAudit > div > p').count() + 1;
  auth.roleTarget(target, { name: 'OLDER REFRESH SENTINEL', role: 'site_admin', roleRevision: 8 });
  let seenRead = false; let held = false; let release; const wait = new Promise((resolve) => { release = resolve; });
  const path = phase === 'facts' ? 'site_admin_get_user' : 'site_admin_list_audit';
  await context.route(`**/rpc/${path}`, async (route) => { seenRead = true; await route.fallback(); });
  await context.route('**/auth/v1/user', async (route) => { if (seenRead && !held) { held = true; await wait; } await route.fallback(); });
  await page.locator('#adminRoleRefresh').click(); await expect.poll(() => held).toBe(true); await page.clock.fastForward(20_001);
  await expect(page.locator('#adminRoleRefreshStatus')).toContainText('read-only refresh could not finish');
  auth.roleTarget(target, { name: 'NEWER REFRESH SENTINEL', role: 'member', roleRevision: 9 });
  auth.roleEvents.unshift({ ...auth.roleEvents[0], id: '2000', afterRole: 'member' });
  await page.locator('#adminRoleRefresh').click(); await expect(page.locator('#adminRoleRefreshStatus')).toContainText('refreshed'); await expect(page.locator('#adminUserFacts')).toContainText('NEWER REFRESH SENTINEL');
  await expect(page.locator('#adminRoleAudit > div > p')).toHaveCount(expectedAuditRows); await expect(page.locator('#adminRoleAudit')).toContainText('Event 2000');
  const before = auth.requests.filter((entry) => entry.path === '/auth/v1/user').length; release(); await expect.poll(() => auth.requests.filter((entry) => entry.path === '/auth/v1/user').length).toBeGreaterThan(before);
  await page.clock.fastForward(100); await expect(page.locator('#adminUserFacts')).toContainText('NEWER REFRESH SENTINEL'); await expect(page.locator('#adminUserFacts')).not.toContainText('OLDER REFRESH SENTINEL');
  await expect(page.locator('#adminRoleAudit > div > p')).toHaveCount(expectedAuditRows); expect(auth.assignments()).toHaveLength(1);
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`role review is accessible in ${theme}, mobile and keyboard`, async ({ page, context, browserName }, testInfo) => {
  const auth = await installAdminStub(context, { permissions }); await ready(page); await review(page); await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme); await choose(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await page.locator('#adminRoleValue').boundingBox()).height).toBeGreaterThanOrEqual(48); expect((await page.locator('#adminRoleReason').boundingBox()).height).toBeGreaterThanOrEqual(48);
  expect((await new AxeBuilder({ page }).include('#adminDetail').analyze()).violations).toEqual([]);
  await page.locator('#adminRoleConfirm').focus(); await expect(page.locator('#adminRoleConfirm')).toBeFocused(); await page.locator('#adminRoleConfirm').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/77dc-admin-role-${testInfo.project.name}-${theme}.png` });
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(page.locator('#adminRoleCancel')).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); await page.locator('#adminRoleCancel').scrollIntoViewIfNeeded(); expect(await page.locator('#adminDetail').evaluate((value) => value.scrollWidth <= value.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Enter'); await expect(page.locator('#adminRoleConfirmation')).toBeHidden(); await page.keyboard.press('Escape'); await expect(page.locator('#adminDetail')).not.toBeVisible(); expect(auth.assignments()).toHaveLength(0); await noStoredDecision(page);
});
