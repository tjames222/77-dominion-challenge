import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import AxeBuilder from '@axe-core/playwright';

// Observe the real in-memory adapter without adding a production test hook or
// replacing its authorization, UUID mapping, data, or mutation behavior.
async function observeRequesterPreview(page) {
  await page.route('**/src/static/admin-preview.mjs*', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('requester-preview-source')) return route.fallback();
    const original = `${url.pathname}?requester-preview-source=actual`;
    return route.fulfill({ contentType: 'text/javascript', body: `
      import { createAdminPreview as createActual } from ${JSON.stringify(original)};
      export function createAdminPreview(options) {
        const client = createActual(options);
        const probe = window.__requesterPreviewProbe = { reads: [], mutations: [] };
        const wrapped = { ...client, async read(name, args = {}, options = {}) {
          const call = { name, targetUserId: args.target_user_id ?? null, expectedActorId: options.expectedUserId ?? null };
          probe.reads.push(call);
          const result = await client.read(name, args, options);
          call.actorId = result.actorId;
          return result;
        } };
        for (const name of ['assignRole', 'denyEarlyAccess', 'manageEarlyAccessInvitation', 'correctProfileName']) {
          wrapped[name] = (...args) => { probe.mutations.push(name); return client[name](...args); };
        }
        return wrapped;
      }
    ` });
  });
}

test('display-name correction preview is explicit, in-memory, reset on reload and never calls a provider', async ({ page, app }) => {
  await observeRequesterPreview(page); const providerRequests = [];
  page.on('request', request => { const url = new URL(request.url());
    if (/\/(?:auth|rest|functions)\/v1\//.test(url.pathname) || /supabase\.(?:co|com)$/.test(url.hostname)) providerRequests.push(request.url()); });
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' });
  await expect(page.locator('#adminPreview')).toBeVisible(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'View details for Preview Member 28', exact: true }).click();
  await page.locator('#adminProfileNameReview').click(); await expect(page.locator('#adminProfileNameForm')).toBeVisible();
  await expect(page.locator('#adminProfileNameCurrent')).toHaveText('Current name at review: Preview Member 28');
  await page.locator('#adminProfileNameInput').fill('SYNTHETIC NAME CORRECTION');
  await expect(page.locator('#adminProfileNameConfirm')).toBeDisabled(); await page.locator('#adminProfileNameAcknowledgement').check();
  await page.locator('#adminProfileNameConfirm').click(); await expect(page.locator('#adminProfileNameStatus')).toContainText('Confirmed original operation');
  await expect(page.locator('#adminProfileNameStatus')).not.toContainText('SYNTHETIC NAME CORRECTION');
  await page.locator('#adminProfileNameRefresh').click(); await expect(page.locator('#adminProfileNameRefreshStatus')).toContainText('SYNTHETIC NAME CORRECTION');
  const proof = await page.evaluate(() => structuredClone(window.__requesterPreviewProbe));
  expect(proof.mutations).toEqual(['correctProfileName']);
  const reads = proof.reads.filter(call => call.name === 'site_admin_get_profile_name'); expect(reads).toHaveLength(2);
  for (const read of reads) { expect(read.targetUserId).toBe('70000000-0000-4000-8000-000000000028'); expect(read.actorId).toBe(read.expectedActorId); }
  expect(providerRequests).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/SYNTHETIC NAME CORRECTION|target_expected_version|target_operation_id/);
  await page.locator('#adminDetailClose').click(); await page.locator('#adminAuditTab').click();
  await page.locator('#adminAuditFilters select[name="action"]').selectOption('users.display_name.correct');
  await page.locator('#adminAuditFilters button[type="submit"]').click(); await expect(page.locator('#adminAuditRows tr')).toHaveCount(1);
  await page.locator('#adminAuditRows button').click(); await expect(page.locator('#adminDetailBody')).toContainText('Display-name correction metadata');
  await expect(page.locator('#adminDetailBody')).not.toContainText('SYNTHETIC NAME CORRECTION');
  await expect(page.locator('#adminDetailBody')).not.toContainText('Preview Member 28');
  await page.locator('#adminDetailClose').click(); await page.locator('#adminUsersTab').click();
  await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'View details for Preview Member 28', exact: true }).click(); await page.locator('#adminProfileNameReview').click();
  await expect(page.locator('#adminProfileNameInput')).toHaveValue('Preview Member 28');
  expect(await page.evaluate(() => window.__requesterPreviewProbe.mutations)).toEqual([]); expect(providerRequests).toEqual([]);
  await page.evaluate(() => { localStorage.removeItem('dominion:user'); window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null })); });
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(providerRequests).toEqual([]); app.assertNoRuntimeErrors();
});

test('Account requests preview is explicitly synthetic, read-only and scrubbed on account change', async ({ page, app }) => {
  await observeRequesterPreview(page);
  const providerRequests = [];
  page.on('request', request => { const path = new URL(request.url()).pathname;
    if (/\/(?:auth|rest|functions)\/v1\//.test(path)) providerRequests.push(path); });
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready#account-requests' });
  await expect(page.locator('#adminPreview')).toBeVisible(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(25);
  await expect(page.locator('#adminRequestsRows button')).toHaveCount(25); await expect(page.locator('#adminRequestsRows a')).toHaveCount(0);
  expect(await page.locator('#adminRequestsRows').textContent()).not.toMatch(/Preview Member|example\.invalid/);
  expect(await page.evaluate(() => window.__requesterPreviewProbe.reads.filter(call => call.name === 'site_admin_get_user'))).toEqual([]);
  await page.locator('#adminNextPage').click(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(3);
  const list = await page.locator('#adminRequestsRows').textContent();
  const queue = await page.locator('#adminQueueHealthBuckets').textContent();
  const snapshot = await page.evaluate(() => structuredClone(window.__requesterPreviewProbe));
  const contextReads = snapshot.reads.filter(call => call.name === 'get_site_admin_context').length;
  expect(snapshot.reads.filter(call => call.name === 'site_admin_get_user')).toEqual([]);
  const open = page.locator('#adminRequestsRows button').first();
  await open.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#adminDetailTitle')).toHaveText('Requester account');
  await expect(page.locator('#adminRequesterStatus')).toContainText('Observed');
  await expect(page.locator('#adminRequesterFacts')).toContainText('Preview Member 26');
  await expect(page.locator('#adminRequesterFacts')).toContainText('member26@example.invalid');
  await expect(page.locator('#adminRequesterScope')).toContainText('does not process, approve, or fulfill');
  await expect(page.locator('#adminDetail .admin-review, #adminUserHistory, #earlyAccessDenyConfirmation')).toHaveCount(0);
  const afterOpen = await page.evaluate(() => structuredClone(window.__requesterPreviewProbe));
  const details = afterOpen.reads.filter(call => call.name === 'site_admin_get_user');
  expect(details).toHaveLength(1); expect(details[0].targetUserId).toBe('70000000-0000-4000-8000-000000000026');
  expect(details[0].actorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(details[0].expectedActorId).toBe(details[0].actorId);
  expect(afterOpen.reads.filter(call => call.name === 'get_site_admin_context')).toHaveLength(contextReads + 2);
  expect(afterOpen.reads.filter(call => ['site_admin_list_account_requests', 'site_admin_get_account_request_queue_health'].includes(call.name)))
    .toEqual(snapshot.reads.filter(call => ['site_admin_list_account_requests', 'site_admin_get_account_request_queue_health'].includes(call.name)));
  await page.keyboard.press('Escape'); await expect(open).toBeFocused(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  await expect(page.locator('#adminRequestsRows')).toHaveText(list); await expect(page.locator('#adminPageLabel')).toHaveText('Page 2');
  await expect(page.locator('#adminRequestsFilters select[name="status"]')).toHaveValue('active');
  await expect(page.locator('#adminQueueHealthBuckets')).toHaveText(queue);
  await open.click(); await expect(page.locator('#adminRequesterStatus')).toContainText('Observed');
  await expect(page.locator('#adminRequesterFacts')).toContainText('member26@example.invalid');
  await expectNoHorizontalOverflow(page);
  await page.evaluate(() => { localStorage.removeItem('dominion:user'); window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null })); });
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0);
  await expect(page.locator('#adminDetail')).not.toBeVisible(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(await page.content()).not.toContain('member26@example.invalid');
  const final = await page.evaluate(() => ({ probe: window.__requesterPreviewProbe, stored: JSON.stringify({ ...localStorage, ...sessionStorage }) }));
  expect(final.probe.reads.filter(call => call.name === 'site_admin_get_user')).toHaveLength(2);
  expect(final.probe.mutations).toEqual([]); expect(providerRequests).toEqual([]);
  expect(final.stored).not.toMatch(/Preview Member 26|member26@example\.invalid|80000000-0000-4000-8000|70000000-0000-4000-8000/);
  app.assertNoRuntimeErrors();
});

test('cleanup preview is explicitly synthetic, manual-only and cleared when its actor changes', async ({ page, app }) => {
  await observeRequesterPreview(page); const providerRequests = [];
  page.on('request', request => { const path = new URL(request.url()).pathname;
    if (/\/(?:auth|rest|functions)\/v1\//.test(path)) providerRequests.push(path); });
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready#operations' });
  await expect(page.locator('#adminPreview')).toBeVisible(); await expect(page.locator('#adminOperationsPanel')).toBeVisible();
  const reads = () => page.evaluate(() => window.__requesterPreviewProbe.reads.filter(call => call.name === 'site_admin_get_cleanup_health'));
  expect(await reads()).toHaveLength(0); await expect(page.locator('#adminCleanupStatus')).toContainText('Not checked');
  await page.locator('#adminCleanupRefresh').click(); await expect(page.locator('.admin-cleanup-counter')).toHaveCount(6);
  const calls = await reads(); expect(calls).toHaveLength(1); expect(calls[0].actorId).toBe(calls[0].expectedActorId);
  expect(calls[0].actorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await expect(page.locator('#adminCleanupScheduler')).toContainText('does not prove an HTTP response');
  await page.evaluate(() => { localStorage.removeItem('dominion:user'); window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null })); });
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminCleanupData')).toBeEmpty();
  expect(await page.evaluate(() => window.__requesterPreviewProbe.mutations)).toEqual([]); expect(providerRequests).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/failuresLastHour|oldestEligibleAt|lastRunsOrder/);
  app.assertNoRuntimeErrors();
});

test('admin direct load and refresh never hydrate member Share or Streak controls', async ({ page, app }) => {
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' });
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await expect(page.locator('.shared-header-share, .shared-header-streak')).toHaveCount(0);
  await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await expect(page.locator('.shared-header-share, .shared-header-streak')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1440]) {
    test(`synthetic admin preview is labeled and usable: ${theme} ${width}`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' }, { theme });
      await expect(page.locator('#adminPreview')).toBeVisible(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
      await expectNoHorizontalOverflow(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`admin-${theme}-${width}.png`), fullPage: false });
      await page.locator('#adminNextPage').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(3);
      await page.getByRole('tab', { name: 'Audit', exact: true }).click(); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
      await page.locator('#adminAuditRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('preview');
      await page.locator('#adminDetailClose').click();
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); await expectNoHorizontalOverflow(page);
      app.assertNoRuntimeErrors();
    });
  }
}
test('default preview member has no Admin link and cannot read records', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.admin); await expect(page.locator('#adminGateMessage')).toContainText('does not have');
  await page.getByRole('button', { name: 'Open menu', exact: true }).click(); await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(0); app.assertNoRuntimeErrors();
});
test('early-access preview denial is deliberate, simulated and reset on reload', async ({ page, app }) => {
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready#early-access' });
  await expect(page.locator('#adminPreview')).toBeVisible(); await expect(page.locator('#adminEarlyRows tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.locator('[data-admin-menu-item]')).toHaveText('Admin (preview)');
  await page.keyboard.press('Escape');
  const request = page.locator('[data-early-request="88000000-0000-4000-8000-000000000026"] button');
  await request.click(); await page.locator('#earlyAccessReviewDeny').click();
  await expect(page.locator('#earlyAccessDenyConfirmation')).toBeVisible(); await expect(page.locator('#earlyAccessConfirmDeny')).toBeDisabled();
  await page.locator('#earlyAccessDenyReason').selectOption('early_access_review'); await page.locator('#earlyAccessDenyAcknowledgement').check();
  await page.locator('#earlyAccessConfirmDeny').click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('denied');
  await expect(page.locator('#earlyAccessHistoryRows')).toContainText('9007199254740993');
  await page.reload(); await request.click(); await expect(page.locator('#earlyAccessRequestStatus')).toHaveText('pending');
  await expect(page.locator('#earlyAccessDenyConfirmation')).toBeHidden(); app.assertNoRuntimeErrors();
});
test('preview account storage changes clear filters, rows, detail and Admin link', async ({ page, app }) => {
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' }); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.locator('#adminUsersRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('member28@example.invalid');
  await page.evaluate(() => { localStorage.removeItem('dominion:user'); window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null })); });
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0); expect(await page.content()).not.toContain('member28@example.invalid');
});
