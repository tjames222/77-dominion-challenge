import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';

test.describe('Account-linked administrative history', () => {
  const historyReads = auth => auth.reads().filter(entry => entry.path.endsWith('/site_admin_list_audit'));
  const openAccount = async page => {
    await page.locator('#adminUsersRows button').first().click();
    await expect(page.locator('#adminDetailTitle')).toHaveText('Account details');
    await expect(page.locator('#adminUserFacts')).toBeVisible();
  };
  const expand = async page => { await page.locator('#adminUserHistory > summary').click(); };
  const waitRows = async (page, count = 1) => { await expect(page.locator('#adminUserHistoryRows > li')).toHaveCount(count); };
  test.beforeEach(async ({ page, baseURL }) => {
    page.__historyEvidence = { external: [], errors: [] };
    page.on('pageerror', error => page.__historyEvidence.errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== new URL(baseURL).origin) {
        page.__historyEvidence.external.push(new URL(route.request().url()).origin); return route.abort();
      }
      return route.fallback();
    });
  });
  test.afterEach(async ({ page }) => {
    expect(page.__historyEvidence.external).toEqual([]); expect(page.__historyEvidence.errors).toEqual([]);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })).catch(() => '');
    expect(stored).not.toMatch(/PRIVATE_HISTORY|reasonCode|beforeRole|afterRole/);
  });
  test('history loads only on expansion, reads the exact account and clears on collapse', async ({ context, page }) => {
    const auth = await installAdminStub(context); await page.goto('/admin.html'); await openAccount(page);
    expect(historyReads(auth)).toHaveLength(0); await expect(page.locator('#adminUserHistory')).not.toHaveAttribute('open', '');
    await expand(page); await waitRows(page);
    const first = historyReads(auth)[0];
    expect(first.body).toEqual({ target_expected_actor_id: auth.A, target_user_id: '70000000-0000-4000-8000-000000000028',
      target_action: 'all', target_outcome: 'all', target_limit: 10, target_cursor: null });
    await expect(page.locator('#adminUserHistoryScope')).toContainText('not a complete account history');
    await expect(page.locator('#adminUserHistoryStatus')).toContainText('Observed');
    await expect(page.locator('#adminUserHistoryOlder')).toBeDisabled();
    await expand(page); await waitRows(page, 0); expect(historyReads(auth)).toHaveLength(1);
    await expand(page); await waitRows(page); expect(historyReads(auth)).toHaveLength(2);
    await page.locator('#adminUserHistoryRefresh').click(); await expect.poll(() => historyReads(auth).length).toBe(3); await waitRows(page);
    expect(auth.assignments()).toHaveLength(0); expect(auth.denials()).toHaveLength(0); expect(auth.invitations()).toHaveLength(0);
  });
  for (const face of ['platform', 'wide-fallback']) test(`${face} collapsed and expanded history reflows inside a 320px dialog at settled 200% text`, async ({ context, page }, testInfo) => {
    await installAdminStub(context); await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto('/admin.html'); await openAccount(page);
    const summary = page.locator('#adminUserHistory > summary');
    const normalFont = await summary.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    // Font metrics differ across platforms even at an identical computed size.
    // Keep platform coverage and exercise a wider available fallback separately.
    if (face === 'wide-fallback') await page.locator('#adminUserHistory').evaluate(element => { element.style.fontFamily = 'Verdana, sans-serif'; });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect.poll(() => summary.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(normalFont * 2);
    for (const state of ['collapsed', 'expanded']) {
      if (state === 'expanded') { await summary.focus(); await page.keyboard.press('Enter'); await waitRows(page); }
      else await expect(page.locator('#adminUserHistory')).not.toHaveAttribute('open', '');
      for (const selector of ['#adminDetail', '#adminUserHistory', '#adminUserHistory > summary']) {
        const geometry = await page.locator(selector).evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth,
          descendants: [...element.querySelectorAll('*')].filter(node => node.getClientRects().length).map(node => {
            const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
            return { tag: node.tagName, id: node.id, width: node.clientWidth, scroll: node.scrollWidth, rectWidth: rect.width,
              right: rect.right, text: node.textContent?.slice(0, 50), font: style.font, padding: style.padding,
              minWidth: style.minWidth, maxWidth: style.maxWidth, wrap: style.overflowWrap };
          }).filter(item => item.tag === 'BUTTON' || item.scroll > item.width + 1 || item.right > element.getBoundingClientRect().right + 1),
        }));
        await testInfo.attach(`${state}-${selector}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
        expect(geometry.scroll, `${state} ${selector}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.width + 1);
      }
      await summary.screenshot({ path: testInfo.outputPath(`history-320px-200pct-${state}.png`) });
    }
    const refresh = page.locator('#adminUserHistoryRefresh');
    await refresh.focus(); await page.keyboard.press('Enter'); await waitRows(page);
    await expect(refresh).toBeFocused(); await expect(refresh).toBeInViewport();
    await refresh.click(); await waitRows(page); await expect(refresh).toBeInViewport();
    await page.locator('#adminDetail').screenshot({ path: testInfo.outputPath(`history-${face}-320px-200pct-dialog.png`) });
    expect((await new AxeBuilder({ page }).include('#adminDetail').analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape'); await expect(page.locator('#adminUsersRows button').first()).toBeFocused();
  });
  test('bounded older pages, linked acceptance, safe failure labels and private projection', async ({ context, page }) => {
    const auth = await installAdminStub(context); const requests = [];
    await page.route('**/site_admin_list_audit', route => {
      const body = route.request().postDataJSON(); requests.push(body);
      const ids = body.target_cursor ? ['20', '19'] : Array.from({ length: 10 }, (_, i) => String(30 - i));
      const items = ids.map(id => ({ id, actorId: auth.A, targetUserId: body.target_user_id, action: 'roles.assign', permission: 'roles.manage',
        reasonCode: 'staff_access_review', beforeRole: 'member', afterRole: 'site_admin', outcome: 'success', errorCode: null,
        occurredAt: '2026-10-08T00:00:00Z', privateNote: 'PRIVATE_HISTORY_NOTE', rawRequest: 'PRIVATE_HISTORY_REQUEST' }));
      if (body.target_cursor) {
        Object.assign(items[0], { actorId: body.target_user_id, action: 'early_access.accept', permission: 'early_access.accept',
          reasonCode: 'invitation_acceptance', beforeRole: null, afterRole: null });
        Object.assign(items[1], { outcome: 'failure', afterRole: 'member', errorCode: 'revision_conflict' });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, actorId: auth.A,
        observedAt: '2026-10-08T01:00:00Z', items, nextCursor: body.target_cursor ? null : { v: 1, actorId: auth.A, query: 'a'.repeat(64), id: '21' } }) });
    });
    await page.goto('/admin.html'); await openAccount(page); await expand(page); await waitRows(page, 10);
    expect(await page.content()).not.toContain('PRIVATE_HISTORY');
    await page.locator('#adminUserHistoryOlder').focus(); await page.keyboard.press('Enter'); await waitRows(page, 2);
    await expect(page.locator('#adminUserHistoryRefresh')).toBeFocused();
    await expect(page.locator('#adminUserHistoryStatus')).toContainText('Page 2: 2 recorded events');
    await expect(page.locator('#adminUserHistoryRows')).toContainText('Early Access invitation acceptance');
    await expect(page.locator('#adminUserHistoryRows')).toContainText('Account changed during review');
    await expect(page.locator('#adminUserHistoryRows')).toContainText('Not applied');
    expect(requests[1].target_cursor.id).toBe('21'); expect(requests[1].target_user_id).toBe(requests[0].target_user_id);
    await page.keyboard.press('Enter'); await waitRows(page, 10);
    await expect(page.locator('#adminUserHistoryRefresh')).toBeFocused();
    expect(requests[2].target_cursor).toBe(null); await expect(page.locator('#adminUserHistoryStatus')).toContainText('Page 1');
  });
  test('real operator-bootstrap shape renders its null actor as a recorded assignment', async ({ context, page }) => {
    const auth = await installAdminStub(context);
    await page.route('**/site_admin_list_audit', route => {
      const body = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, actorId: auth.A,
        observedAt: '2026-10-08T01:00:00Z', nextCursor: null, items: [{ id: '1', actorId: null, targetUserId: body.target_user_id,
          action: 'roles.bootstrap', permission: 'roles.manage', reasonCode: 'initial_admin_bootstrap', beforeRole: 'member', afterRole: 'site_admin',
          occurredAt: '2026-10-08T00:00:00Z', outcome: 'success', errorCode: null }] }) });
    });
    await page.goto('/admin.html'); await openAccount(page); await expand(page); await waitRows(page);
    await expect(page.locator('#adminUserHistoryRows')).toContainText('Initial site-admin assignment');
    await expect(page.locator('#adminUserHistoryRows')).toContainText('Member → Site admin');
    await expect(page.locator('#adminUserHistoryRows')).toContainText('Succeeded');
  });
  for (const failure of ['wrong target', 'malformed timestamp', 'unknown action', 'wrong cursor', 'server failure', 'empty']) {
    test(`history ${failure} is truthful and exposes no raw/private fields`, async ({ context, page }) => {
      const auth = await installAdminStub(context);
      await page.route('**/site_admin_list_audit', route => {
        if (failure === 'server failure') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"PRIVATE_HISTORY_ERROR"}' });
        const body = route.request().postDataJSON();
        const item = { id: '42', actorId: auth.A, targetUserId: failure === 'wrong target' ? auth.B : body.target_user_id,
          action: failure === 'unknown action' ? 'PRIVATE_HISTORY_ACTION' : 'roles.assign', permission: 'roles.manage', reasonCode: 'staff_access_review',
          beforeRole: 'member', afterRole: 'site_admin', outcome: 'success', errorCode: null,
          occurredAt: failure === 'malformed timestamp' ? 'not a timestamp' : '2026-10-08T00:00:00Z', privateNote: 'PRIVATE_HISTORY_NOTE' };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, actorId: auth.A,
          observedAt: '2026-10-08T01:00:00Z', items: failure === 'empty' ? [] : [item],
          nextCursor: failure === 'wrong cursor' ? { v: 1, actorId: auth.B, query: 'a'.repeat(64), id: '42' } : null }) });
      });
      await page.goto('/admin.html'); await openAccount(page); await expand(page);
      await expect(page.locator('#adminUserHistoryStatus')).toContainText(failure === 'empty' ? 'No recorded events linked' : 'Account history unavailable');
      await waitRows(page, 0); expect(await page.content()).not.toContain('PRIVATE_HISTORY');
    });
  }
  test('Users read alone never exposes or requests history', async ({ context, page }) => {
    const auth = await installAdminStub(context, { permissions: ['users.read'] });
    await page.goto('/admin.html'); await openAccount(page);
    await expect(page.locator('#adminUserHistory')).toHaveCount(0); expect(historyReads(auth)).toHaveLength(0);
  });
  test('live audit permission denial scrubs the complete account dialog', async ({ context, page }) => {
    const auth = await installAdminStub(context); await page.goto('/admin.html'); await openAccount(page); await expand(page); await waitRows(page);
    auth.permissions(['users.read']); await page.locator('#adminUserHistoryRefresh').click();
    await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
    await expect(page.locator('#adminUserHistoryRows')).toHaveCount(0);
  });
  for (const mode of ['ABA', 'replacement', 'pagehide']) test(`${mode} rejects held account history and scrubs prior rows`, async ({ context, page }) => {
    const auth = await installAdminStub(context); await page.goto('/admin.html'); await openAccount(page); await expand(page); await waitRows(page);
    const release = auth.hold(['site_admin_list_audit']);
    try {
      await page.locator('#adminUserHistoryRefresh').click(); await expect.poll(() => historyReads(auth).length).toBe(2); await waitRows(page, 0);
      if (mode === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      else {
        const replacement = auth.session(mode === 'ABA' ? auth.B : auth.A, 'aal2', '22222222-2222-4222-8222-222222222222');
        const switchSession = value => { localStorage.setItem('sb-127-auth-token', JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(value) })); };
        await page.evaluate(switchSession, replacement); if (mode === 'ABA') await page.evaluate(switchSession, auth.firstSession);
      }
      await expect(page.locator('#adminWorkspace')).toBeHidden(); release();
      await expect(page.locator('#adminUserHistory')).toHaveCount(0); await expect(page.locator('#adminDetailBody')).toBeEmpty();
    } finally { release(); }
  });
  test('closing then opening another account discards late history and preserves role-panel cleanup', async ({ context, page }) => {
    const auth = await installAdminStub(context, { permissions: ['users.read', 'audit.read', 'roles.manage'] });
    await page.goto('/admin.html'); await openAccount(page); await expect(page.locator('#adminRoleReview')).toBeVisible();
    const release = auth.hold(['site_admin_list_audit']);
    try {
      await expand(page); await expect.poll(() => historyReads(auth).length).toBe(1);
      await page.locator('#adminDetailClose').click(); await expect(page.locator('#adminUsersRows button').first()).toBeFocused();
      await expect(page.locator('#adminUserHistory')).toHaveCount(0); await expect(page.locator('#adminRoleReview')).toHaveCount(0);
      await page.locator('#adminUsersRows button').nth(1).click(); await expect(page.locator('#adminUserHistory')).toBeVisible();
      release(); await expect(page.locator('#adminUserHistoryRows')).toBeEmpty();
      await expand(page); await waitRows(page);
      expect(historyReads(auth).at(-1).body.target_user_id).not.toBe(historyReads(auth)[0].body.target_user_id);
      await expect(page.locator('#adminUserHistoryRows')).toContainText('Site role review'); expect(auth.assignments()).toHaveLength(0);
    } finally { release(); }
  });
  for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`${theme} account history supports keyboard, zoom and accessible semantics`, async ({ context, page }, testInfo) => {
    await installAdminStub(context); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/admin.html'); await openAccount(page);
    await page.locator('#adminUserHistory > summary').focus(); await page.keyboard.press('Enter'); await waitRows(page);
    // Mirror both visual properties changed by the real theme runtime, without
    // inventing an entitlement or persisting this synthetic visual override.
    // Changing only data-theme leaves the runtime's inline dark colorScheme.
    await page.evaluate(value => {
      document.documentElement.dataset.theme = value;
      document.documentElement.style.colorScheme = window.DominionThemeRuntime.getTheme(value).colorScheme;
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe(await page.evaluate(value => window.DominionThemeRuntime.getTheme(value).colorScheme, theme));
    // The existing reduced-motion rule leaves a nonzero .001ms transition on
    // every element. WebKit settles inherited colors over several frames.
    // Wait for the actual target colors, with a bounded assertion, before axe.
    // A one-value RGB-channel readiness tolerance does not waive the unchanged
    // zero-violation contrast check below or admit stale light/dark colors.
    await expect.poll(() => page.evaluate(() => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue('--text').trim().replace('#', '');
      if (!/^[a-f\d]{6}$/i.test(hex)) throw new Error('Unexpected fixture text color');
      const expected = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
      return [...document.querySelectorAll('#adminDetail, #adminUserFacts h3, #adminUserFacts dd, #adminUserFacts summary, #adminUserHistory h4, #adminUserHistory li p, #adminUserHistory summary')]
        .filter(element => element.getClientRects().length > 0)
        .flatMap(element => {
          const color = getComputedStyle(element).color;
          const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color)?.slice(1).map(Number);
          return channels?.every((value, index) => Math.abs(value - expected[index]) <= 1) ? [] : [{ tag: element.tagName, color, expected }];
        });
    })).toEqual([]);
    expect((await new AxeBuilder({ page }).include('#adminDetail').analyze()).violations).toEqual([]);
    const normalFont = await page.locator('#adminUserHistoryRefresh').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect.poll(() => page.locator('#adminUserHistoryRefresh').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(normalFont * 2);
    expect(await page.locator('#adminUserHistory').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Verify keyboard activation and a real, non-forced pointer action at 200%.
    // Mobile WebKit's native Tab preference does not traverse every button.
    if (testInfo.project.name === 'admin-live-chromium') {
      await page.locator('#adminUserHistory > summary').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    } else await page.locator('#adminUserHistoryRefresh').focus();
    await expect(page.locator('#adminUserHistoryRefresh')).toBeFocused();
    await page.keyboard.press('Enter'); await waitRows(page);
    await page.locator('#adminUserHistoryRefresh').click(); await waitRows(page);
    await expect(page.locator('#adminUserHistoryRefresh')).toBeInViewport();
    await page.locator('#adminDetail').screenshot({ path: testInfo.outputPath(`${theme}-account-history-200pct.png`) });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await expect.poll(() => page.locator('#adminUserHistoryRefresh').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(normalFont);
    await page.locator('#adminUserHistory > summary').focus();
    await page.locator('#adminDetail').screenshot({ path: testInfo.outputPath(`${theme}-account-history.png`) });
    await page.keyboard.press('Escape'); await expect(page.locator('#adminUsersRows button').first()).toBeFocused();
  });
});

test.describe('Account requests inbox', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    page.__inboxEvidence = { external: [], errors: [] };
    page.on('pageerror', error => page.__inboxEvidence.errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== new URL(baseURL).origin) {
        page.__inboxEvidence.external.push(new URL(route.request().url()).origin); return route.abort();
      }
      return route.fallback();
    });
  });
  test.afterEach(async ({ page }) => {
    expect(page.__inboxEvidence.external).toEqual([]); expect(page.__inboxEvidence.errors).toEqual([]);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })).catch(() => '');
    expect(stored).not.toMatch(/80000000-0000-4000-8000|resolvedAt|operatorNote|PRIVATE_INBOX/);
  });
  async function inbox(context, page, options = {}) {
    const auth = await installAdminStub(context, { permissions: ['operations.read'], ...options });
    await page.goto('/admin.html#account-requests'); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(25);
    return auth;
  }
  test('queue overview covers all active buckets independently of filters, with manual refresh and no writes', async ({ context, page }, testInfo) => {
    const auth = await inbox(context, page);
    const cards = page.locator('.admin-queue-bucket'); await expect(cards).toHaveCount(4);
    const counts = () => cards.locator('dl > div:first-child dd');
    await expect(counts()).toHaveText(['14', '0', '0', '14']);
    await expect(page.locator('#adminQueueHealthStatus')).toContainText('Observed');
    await expect(page.locator('#adminQueueHealthNote')).toContainText('independent of the list filters');
    const reads = () => auth.reads().filter(r => r.path.endsWith('/site_admin_get_account_request_queue_health'));
    const before = reads().length;
    await page.getByRole('combobox', { name: 'Recorded request status', exact: true }).selectOption('fulfilled');
    await page.locator('#adminRequestsFilters button').click();
    await expect(page.locator('#adminRequestsRows')).toContainText('Recorded fulfilled');
    await expect(counts()).toHaveText(['14', '0', '0', '14']); expect(reads().length).toBe(before);
    await page.getByRole('button', { name: 'Refresh queue overview', exact: true }).click();
    await expect.poll(() => reads().length).toBe(before + 1); await expect(cards).toHaveCount(4);
    expect(reads().every(r => JSON.stringify(r.body) === JSON.stringify({ target_expected_actor_id: auth.A }))).toBe(true);
    await expect(cards.locator('button,a')).toHaveCount(0);
    expect(await page.locator('#adminQueueHealth').textContent()).not.toMatch(/80000000|70000000|example.test|PRIVATE/);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.locator('#adminQueueHealth').screenshot({ path: testInfo.outputPath('active-queue-overview.png') });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.locator('#adminQueueHealth').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.locator('#adminQueueHealth').screenshot({ path: testInfo.outputPath('active-queue-overview-200-percent.png') });
  });
  test('queue caps at1000+ and malformed data becomes unknown, never a false zero', async ({ context, page }) => {
    await installAdminStub(context, { permissions: ['operations.read'] }); let malformed = false;
    await page.route('**/site_admin_get_account_request_queue_health', route => {
      const buckets = ['data_export', 'account_deletion'].flatMap(requestType => ['requested', 'in_progress'].map(status => ({
        requestType, status, count: 1000, hasMore: status === 'requested', oldestRequestedAt: '2026-01-01T00:00:00Z', privateNote: 'PRIVATE_QUEUE_NOTE' })));
      if (malformed) buckets[1].count = null;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1,
        actorId: route.request().postDataJSON().target_expected_actor_id, observedAt: '2026-02-01T00:00:00Z', buckets }) });
    });
    await page.goto('/admin.html#account-requests');
    await expect(page.locator('.admin-queue-bucket dl > div:first-child dd')).toHaveText(['1000+', '1000', '1000+', '1000']);
    expect(await page.content()).not.toContain('PRIVATE_QUEUE_NOTE');
    malformed = true; await page.locator('#adminQueueHealthRefresh').click();
    await expect(page.locator('.admin-queue-bucket')).toHaveCount(0);
    await expect(page.locator('#adminQueueHealthStatus')).toContainText('Counts are unknown');
    await expect(page.locator('#adminRequestsRows tr')).toHaveCount(25);
  });
  for (const mode of ['pagehide', 'replacement', 'ABA', 'permission revoked']) test(`queue ${mode} removes prior counts and rejects held results`, async ({ context, page }) => {
    const auth = await inbox(context, page); await expect(page.locator('.admin-queue-bucket')).toHaveCount(4);
    if (mode === 'permission revoked') {
      auth.permissions([]); await page.locator('#adminQueueHealthRefresh').click();
      await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('.admin-queue-bucket')).toHaveCount(0); return;
    }
    const release = auth.hold(['site_admin_get_account_request_queue_health']);
    try {
      const before = auth.reads().length; await page.locator('#adminQueueHealthRefresh').click();
      await expect.poll(() => auth.reads().length).toBeGreaterThan(before);
      await expect(page.locator('.admin-queue-bucket')).toHaveCount(0);
      if (mode === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      else {
        const replacement = auth.session(mode === 'ABA' ? auth.B : auth.A, 'aal2', '22222222-2222-4222-8222-222222222222');
        const switchSession = value => { localStorage.setItem('sb-127-auth-token', JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(value) })); };
        await page.evaluate(switchSession, replacement);
        if (mode === 'ABA') await page.evaluate(switchSession, auth.firstSession);
      }
      await expect(page.locator('#adminWorkspace')).toBeHidden(); release();
      await expect(page.locator('.admin-queue-bucket')).toHaveCount(0); await expect(page.locator('#adminQueueHealthStatus')).toHaveText('');
    } finally { release(); }
  });
  test('Operations-only reads are paginated, metadata-only and have no account or fulfillment actions', async ({ context, page }) => {
    const auth = await inbox(context, page);
    await expect(page.locator('#adminUsersTab')).toBeHidden(); await expect(page.locator('#adminAuditTab')).toBeHidden();
    await expect(page.locator('#adminRequestsRows')).toContainText('Data export'); await expect(page.locator('#adminRequestsRows')).toContainText('In progress');
    await expect(page.locator('#adminRequestsRows button, #adminRequestsRows a')).toHaveCount(0);
    await page.locator('#adminNextPage').click(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(3);
    await expect(page.locator('#adminNextPage')).toBeDisabled();
    await page.locator('#adminPreviousPage').click(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(25);
    await page.getByRole('combobox', { name: 'Request type', exact: true }).selectOption('data_export');
    await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0);
    await page.locator('#adminRequestsFilters button').click(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(14);
    const first = await page.locator('#adminRequestsRows tr').first().textContent();
    await page.getByRole('combobox', { name: 'Account request sort', exact: true }).selectOption('newest');
    await page.locator('#adminRequestsFilters button').click();
    await expect(page.locator('#adminRequestsRows tr').first()).not.toHaveText(first);
    expect(auth.reads().every(r => /\/(?:site_admin_list_account_requests|site_admin_get_account_request_queue_health)$/.test(r.path))).toBe(true);
    expect(auth.requests.filter(r => r.method !== 'GET' && !r.path.includes('/rpc/'))).toEqual([]);
    await expect(page.locator('#adminRequestsNote')).toContainText('not proof of export delivery or complete erasure');
  });
  test('recorded terminal states and removed requester remain distinct from processing failures', async ({ context, page }) => {
    await inbox(context, page);
    await page.getByRole('combobox', { name: 'Recorded request status', exact: true }).selectOption('all');
    await page.getByRole('combobox', { name: 'Account request sort', exact: true }).selectOption('newest');
    await page.locator('#adminRequestsFilters button').click();
    await expect(page.locator('#adminRequestsRows')).toContainText('Account reference removed');
    await expect(page.locator('#adminRequestsRows')).toContainText('Recorded fulfilled');
    await expect(page.locator('#adminRequestsRows')).toContainText('Cancelled');
    await expect(page.locator('#adminRequestsRows')).toContainText('Declined');
    await expect(page.locator('#adminRequestsRows')).not.toContainText('Failed');
    await page.getByRole('combobox', { name: 'Request type', exact: true }).selectOption('data_export');
    await page.getByRole('combobox', { name: 'Recorded request status', exact: true }).selectOption('in_progress');
    await page.locator('#adminRequestsFilters button').click();
    await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0); await expect(page.locator('#adminStatus')).toHaveText('No records match these filters.');
  });
  for (const [name, options] of [['member', { role: 'member' }], ['AAL1', { aal: 'aal1' }], ['missing permission', { permissions: ['users.read'] }]]) {
    test(`${name} cannot open or fetch Operations records`, async ({ context, page }) => {
      const auth = await installAdminStub(context, options); await page.goto('/admin.html#account-requests');
      if (name === 'missing permission') await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
      else await expect(page.locator('#adminGateTitle')).not.toHaveText('Checking access');
      await expect(page.locator('#adminRequestsTab')).toBeHidden(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0);
      expect(auth.requests.some(r => /\/(?:site_admin_list_account_requests|site_admin_get_account_request_queue_health)$/.test(r.path))).toBe(false);
    });
  }
  for (const mode of ['failure', 'wrong actor', 'permission revoked']) test(`${mode} clears all previously displayed request metadata`, async ({ context, page }) => {
    const auth = await inbox(context, page);
    if (mode === 'failure') auth.fail(); else if (mode === 'wrong actor') auth.corrupt(); else auth.permissions([]);
    await page.locator('#adminRefresh').click(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0);
    if (mode === 'permission revoked') await expect(page.locator('#adminWorkspace')).toBeHidden();
    else await expect(page.locator('#adminStatus')).toContainText('temporarily unavailable');
    expect(await page.content()).not.toContain('PRIVATE RAW ERROR');
  });
  for (const mode of ['pagehide', 'replacement', 'ABA']) test(`${mode} rejects a held response and scrubs filters and cursor history`, async ({ context, page }) => {
    const auth = await inbox(context, page); const release = auth.hold(['site_admin_list_account_requests']);
    try {
      const before = auth.reads().length; await page.locator('#adminNextPage').click();
      await expect.poll(() => auth.reads().length).toBeGreaterThan(before);
      if (mode === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      else {
        const replacement = auth.session(mode === 'ABA' ? auth.B : auth.A, 'aal2', '22222222-2222-4222-8222-222222222222');
        await page.evaluate(value => { localStorage.setItem('sb-127-auth-token', JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(value) })); }, replacement);
        if (mode === 'ABA') await page.evaluate(value => { localStorage.setItem('sb-127-auth-token', JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(value) })); }, auth.firstSession);
      }
      await expect(page.locator('#adminWorkspace')).toBeHidden(); release();
      await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0); await expect(page.locator('#adminPageLabel')).toHaveText('Page 1');
      expect(await page.locator('#adminRequestsFilters select[name="status"]').inputValue()).toBe('active');
    } finally { release(); }
  });
  test('unknown or private fields never render; malformed stored status fails closed', async ({ context, page }) => {
    await installAdminStub(context, { permissions: ['operations.read'] }); let malformed = false;
    await page.route('**/site_admin_list_account_requests', route => {
      const body = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, actorId: body.target_expected_actor_id,
        observedAt: '2026-01-01T12:00:00Z', nextCursor: null, items: [{ id: '80000000-0000-4000-8000-000000000001', userId: null,
          requestType: 'data_export', status: malformed ? 'failed' : 'requested', requestedAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-01T12:00:00Z', resolvedAt: null,
          operatorNote: 'PRIVATE_INBOX_NOTE', email: 'PRIVATE_INBOX_EMAIL', payload: '<img src=x onerror=alert(1)>' }] }) });
    });
    await page.goto('/admin.html#account-requests'); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(1);
    expect(await page.content()).not.toMatch(/PRIVATE_INBOX|onerror=alert/);
    malformed = true; await page.locator('#adminRefresh').click(); await expect(page.locator('#adminRequestsRows tr')).toHaveCount(0);
    await expect(page.locator('#adminStatus')).toContainText('temporarily unavailable');
  });
  test('filter choices stay fully readable across viewport and text sizes', async ({ context, page }, testInfo) => {
    await inbox(context, page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const width of [320, 390, 768, 1050, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const scale of ['100%', '200%']) {
        await page.evaluate(value => { document.documentElement.style.fontSize = value; }, scale);
        const choices = await page.locator('#adminRequestsFilters select').evaluateAll(selects => selects.flatMap(select => {
          const style = getComputedStyle(select);
          const measure = document.createElement('canvas').getContext('2d'); measure.font = style.font;
          const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return [...select.options].map(option => ({ label: option.text, available, required: measure.measureText(option.text).width }));
        }));
        for (const choice of choices) expect(choice.available, `${width}px / ${scale}: ${choice.label}`).toBeGreaterThanOrEqual(choice.required);
        expect(await page.locator('#adminRequestsFilters').evaluate(form => form.scrollWidth <= form.clientWidth)).toBe(true);
        if ([320, 1440].includes(width)) {
          await page.locator('#adminRequestsFilters').scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`account-request-filters-${width}-${scale}.png`) });
        }
      }
    }
  });
  for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`${theme} keyboard, table semantics and 200% text remain accessible`, async ({ context, page }, testInfo) => {
    await inbox(context, page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const table = page.getByRole('table', { name: /^Account requests/ });
    await expect(table.getByRole('columnheader')).toHaveCount(4); await expect(table.getByRole('row')).toHaveCount(26);
    await page.locator('#adminRequestsTab').focus(); await page.keyboard.press('Home'); await expect(page.locator('#adminEarlyTab')).toBeFocused();
    await page.keyboard.press('End'); await expect(page.locator('#adminRequestsTab')).toBeFocused();
    await expect(page.locator('#adminRequestsRows tr')).toHaveCount(25);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const scale of ['100%', '200%']) {
      await page.evaluate(value => { document.documentElement.style.fontSize = value; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath(`${theme}-account-requests.png`) });
  });
});

async function ready(page) { await page.goto('/admin.html'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); }
const PRESENTATION_USER = '70000000-0000-4000-8000-000000000028';
function presentationFixture(auth) {
  auth.roleTarget(PRESENTATION_USER, {
    lastSignInAt: '2026-02-03T09:08:07Z',
    crew: { id: '90000000-0000-4000-8000-000000000001', name: 'Synthetic Cedar Crew', role: 'admin' },
    statsSnapshot: { totalPoints: 0, storedAppStreak: 7, storedPerfectDayStreak: 0, lastSeenLocalDate: '2026-01-20', recordedAt: '2026-01-21T10:11:12Z' },
    subscriptionSnapshot: { status: 'active', currentPeriodEnd: '2026-02-01T00:00:00Z', cancelAtPeriodEnd: false, recordedAt: '2026-01-22T12:13:14Z' },
  });
}
async function noStoredPayload(page) {
  const value = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(value).not.toMatch(/member28@example.invalid|Preview Member 28|staff_access_review|activationSnapshot/);
}
for (const outcome of ['delayed', 'failed']) {
  test(`Admin menu readiness is independent of ${outcome} optional training`, async ({ context, page }) => {
    const auth = await installAdminStub(context);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(/\/menu-training-controllers(?:-[\w-]+)?\.(?:mjs|js)(?:\?|$)/, async route => {
      if (outcome === 'failed') return route.fulfill({ status: 503, contentType: 'text/javascript', body: '/* synthetic unavailable chunk */' });
      await gate; return route.continue();
    });
    try {
      await page.goto('/science.html', { waitUntil: 'domcontentloaded' });
      // This must arrive from buildMenu before opening the drawer: openMenu's
      // independent refresh cannot conceal a skipped post-hydration refresh.
      await expect(page.locator('[data-admin-menu-item]')).toHaveCount(1);
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await expect(page.locator('[data-admin-menu-item]')).toBeVisible();
      await expect(page.locator('.global-menu-links a[href="./private-journal.html"]')).toBeVisible();
      if (outcome === 'failed') await expect(page.getByRole('button', { name: 'Reload to load training', exact: true })).toBeVisible();
      else await expect(page.locator('.global-menu-training-load-status')).toHaveText('Loading training…');
      auth.role('member');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await expect.poll(() => auth.requests.filter(request => request.path.endsWith('/get_site_admin_context')).length).toBeGreaterThanOrEqual(3);
      await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
      await expect(page.locator('.global-menu-links a[href="./private-journal.html"]')).toBeVisible();
    } finally { release(); }
  });
}
for (const [name, options] of [['member and crew admin metadata', { role: 'member' }], ['AAL1 admin', { aal: 'aal1' }]]) {
  test(`${name} never loads private rows or accepts preview URL bypass`, async ({ context, page }) => {
    const auth = await installAdminStub(context, options);
    await page.goto('/admin.html?admin-preview=ready');
    await expect(page.locator('#adminGateTitle')).not.toHaveText('Checking access');
    await expect(page.locator('#adminWorkspace')).toBeHidden();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
    expect(auth.reads()).toHaveLength(0);
    expect(await page.content()).not.toContain('member28@example.invalid');
    if (options.aal) {
      const link = new URL(await page.locator('#adminMfa').getAttribute('href'), page.url());
      expect(link.pathname).toBe('/account-security.html'); expect(link.searchParams.get('mode')).toBe('challenge'); expect(link.searchParams.get('returnTo')).toBe('./admin.html');
    }
    await expect(page.locator('#adminPreview')).toBeHidden();
  });
}
test('anonymous direct URL has only a generic login gate', async ({ page }) => {
  await page.goto('/admin.html?admin-preview=ready');
  await expect(page.locator('#adminLogin')).toBeVisible(); await expect(page.locator('#adminWorkspace')).toBeHidden();
  expect(await page.content()).not.toContain('member28@example.invalid');
});
test('server pagination, filters, snapshots and audit detail work without membership access', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  await expect(page.locator('#adminPreview')).toBeHidden();
  await expect(page.locator('.shared-header-share, .shared-header-streak')).toHaveCount(0);
  await page.locator('#adminNextPage').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(3);
  await expect(page.locator('#adminPageLabel')).toHaveText('Page 2');
  await page.locator('#adminPreviousPage').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByLabel('Name or email prefix').fill('member28'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await page.locator('#adminUsersFilters button').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(1);
  const button = page.locator('#adminUsersRows button'); await button.click();
  await expect(page.locator('#adminDetailBody')).toContainText('member28@example.invalid');
  await expect(page.locator('#adminDetailBody')).toContainText('not current effective access');
  await page.keyboard.press('Escape'); await expect(button).toBeFocused();
  await page.getByRole('tab', { name: 'Audit', exact: true }).click(); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
  await page.locator('#adminAuditRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('staff_access_review');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('failure'); await page.locator('#adminAuditFilters button').click();
  await expect(page.locator('#adminAuditRows tr')).toHaveCount(10);
  expect(auth.reads().every((item) => item.actor === auth.A && item.aal === 'aal2' && item.method === 'POST')).toBe(true);
  await noStoredPayload(page);
});
test('Users keeps compact rows and loads stored account facts once, with read-free fact disclosures', async ({ context, page }) => {
  const auth = await installAdminStub(context); presentationFixture(auth); await ready(page);
  const row = page.locator('#adminUsersRows tr').first();
  await expect(page.locator('#adminUsersPanel [role="columnheader"]')).toHaveText(['Member', 'Site role', 'Account', 'Last sign-in', 'Details']);
  await expect(row.getByRole('cell')).toHaveCount(5);
  await expect(row.locator('[data-label="Site role"]')).toHaveText('Member');
  await expect(row.locator('[data-label="Account"]')).toHaveText('Email confirmed');
  await expect(row.locator('[data-label="Last sign-in"]')).toHaveText('2026-02-03 09:08:07 UTC');
  await expect(row.locator('details')).toHaveCount(0);
  await expect(row).not.toContainText('Stored app streak'); await expect(row).not.toContainText('Synthetic Cedar Crew');
  const count = auth.reads().length;
  const button = row.getByRole('button', { name: 'View details for Preview Member 28', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  const facts = page.locator('#adminUserFacts'); await expect(facts).toContainText('member28@example.invalid');
  expect(auth.reads()).toHaveLength(count + 1); expect(auth.reads().at(-1).path).toMatch(/\/site_admin_get_user$/);
  await expect(facts.locator('details[open]')).toHaveCount(0);
  const history = facts.locator('details').filter({ has: page.locator('summary', { hasText: 'Account history and identifiers' }) });
  await history.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(history).toHaveAttribute('open', '');
  await expect(history).toContainText('Created2026-01-28 12:00:00 UTC');
  await expect(history).toContainText('Email confirmed2026-01-01 12:00:00 UTC');
  await expect(history).toContainText('Last sign-in2026-02-03 09:08:07 UTC');
  const stored = facts.locator('details').filter({ has: page.locator('summary', { hasText: 'Crew and stored snapshots' }) });
  const summary = stored.locator('summary'); await summary.focus(); await page.keyboard.press('Enter');
  await expect(stored).toHaveAttribute('open', '');
  await expect(stored).toContainText('NameSynthetic Cedar CrewCrew-local roleAdmin');
  await expect(stored).toContainText('Stored total points0Stored app streak7Stored perfect-day streak0');
  await expect(stored).toContainText('Last seen local date2026-01-20');
  await expect(stored).toContainText('Recorded2026-01-21 10:11:12 UTC');
  await expect(stored).toContainText('Period end2026-02-01 00:00:00 UTC');
  await expect(stored).toContainText('Cancel at period endNo');
  await expect(stored).toContainText('Recorded2026-01-22 12:13:14 UTC');
  await expect(stored).toContainText('not current effective access, challenge day, or completion decisions');
  await expect(page.locator('#adminUsersSnapshotNote')).toContainText('not current streak, access, or completion');
  await page.keyboard.press('Space'); await expect(stored).not.toHaveAttribute('open'); await expect(summary).toBeFocused();
  expect(auth.reads()).toHaveLength(count + 1); expect(auth.assignments()).toHaveLength(0); expect(auth.denials()).toHaveLength(0);
  await page.keyboard.press('Escape'); await expect(button).toBeFocused(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  await noStoredPayload(page);
});
test('Users keeps missing, zero and unknown records distinct and renders only allowlisted text', async ({ context, page }) => {
  const auth = await installAdminStub(context);
  auth.roleTarget(PRESENTATION_USER, { createdAt: null, emailConfirmedAt: null, lastSignInAt: null, crew: null, statsSnapshot: null, subscriptionSnapshot: null });
  const nextId = '70000000-0000-4000-8000-000000000027';
  auth.roleTarget(nextId, { crew: { name: '<img src=x onerror=alert(1)>', role: 'owner', privatePayload: 'PRIVATE_CREW_SENTINEL' },
    statsSnapshot: { totalPoints: 0, storedAppStreak: 0, storedPerfectDayStreak: 0, lastSeenLocalDate: null, recordedAt: null, privatePayload: 'PRIVATE_PROGRESS_SENTINEL' },
    subscriptionSnapshot: { status: 'unknown', currentPeriodEnd: null, cancelAtPeriodEnd: null, recordedAt: null, privatePayload: 'PRIVATE_SUBSCRIPTION_SENTINEL' } });
  await ready(page);
  const missing = page.locator('#adminUsersRows tr').first();
  await expect(missing.locator('[data-label="Account"]')).toHaveText('Email unconfirmed');
  await expect(missing.locator('[data-label="Site role"]')).toHaveText('Member');
  await expect(missing.locator('[data-label="Last sign-in"]')).toHaveText('Not recorded');
  await missing.locator('button').click();
  const facts = page.locator('#adminUserFacts'); await expect(facts).toContainText('member28@example.invalid');
  await facts.locator('summary', { hasText: 'Account history and identifiers' }).click();
  await expect(facts).toContainText('CreatedNot recordedEmail confirmedNot recordedLast sign-inNot recorded');
  await facts.locator('summary', { hasText: 'Crew and stored snapshots' }).click();
  await expect(facts).toContainText('Crew (separate from site role)CrewNot recorded');
  await expect(facts).toContainText('Stored progress snapshotSnapshotNot recorded');
  await expect(facts).toContainText('Stored subscription snapshotSnapshotNot recorded');
  await page.keyboard.press('Escape');
  const unusual = page.locator('#adminUsersRows tr').nth(1); await unusual.locator('button').click();
  await expect(facts).toContainText('member27@example.invalid');
  await facts.locator('summary', { hasText: 'Crew and stored snapshots' }).click();
  await expect(facts).toContainText('Name<img src=x onerror=alert(1)>Crew-local roleOwner');
  await expect(facts.locator('img')).toHaveCount(0);
  await expect(facts).toContainText('Stored total points0Stored app streak0Stored perfect-day streak0');
  await expect(facts).toContainText('Stored statusUnknownPeriod endNot recordedCancel at period endNot recorded');
  expect(await page.content()).not.toMatch(/PRIVATE_(?:CREW|PROGRESS|SUBSCRIPTION)_SENTINEL/);
  await noStoredPayload(page);
});
test('denied role or network failure clears rendered private records and closes details', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  auth.fail(); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await expect(page.locator('#adminStatus')).toContainText('temporarily unavailable'); expect(await page.content()).not.toContain('PRIVATE RAW ERROR');
  auth.fail(false); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  auth.role('member'); await page.locator('#adminUsersRows button').first().click();
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  expect(await page.content()).not.toContain('member28@example.invalid'); await noStoredPayload(page);
});
test('Users filter disclosure is keyboard-operable and Reset filters restores default server results', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  await expect(page.locator('#adminFilterState')).toBeHidden();
  const more = page.locator('#adminUsersFilters summary');
  await expect(page.locator('#adminUsersFilters details')).not.toHaveAttribute('open');
  const count = auth.reads().length;
  await more.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#adminUsersFilters details')).toHaveAttribute('open');
  await page.keyboard.press('Tab'); await expect(page.getByRole('combobox', { name: 'Role', exact: true })).toBeFocused();
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('member');
  await page.getByRole('combobox', { name: 'Account status', exact: true }).selectOption('confirmed');
  await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('oldest');
  await page.getByLabel('Name or email prefix').fill('member28');
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await expect(page.locator('#adminStatus')).toHaveText('Filters changed. Apply filters to load records.');
  await expect(page.locator('#adminFilterState')).toBeVisible();
  for (const text of ['member28', 'Member', 'Email confirmed', 'Oldest']) await expect(page.locator('#adminFilterSummary')).toContainText(text);
  expect(auth.reads()).toHaveLength(count);
  await page.locator('#adminUsersFilters button').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(1);
  expect(auth.reads().at(-1).body).toMatchObject({ target_search: 'member28', target_role: 'member', target_status: 'confirmed', target_sort: 'oldest', target_cursor: null });
  await more.focus(); await page.keyboard.press('Space'); await expect(page.locator('#adminUsersFilters details')).not.toHaveAttribute('open');
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); await expect(page.locator('#adminFilterState')).toBeHidden();
  await expect(page.getByLabel('Name or email prefix')).toBeFocused(); await expect(page.getByLabel('Name or email prefix')).toHaveValue('');
  await expect(page.locator('#adminPageLabel')).toHaveText('Page 1');
  expect(auth.reads().at(-1).body).toMatchObject({ target_search: '', target_role: 'all', target_status: 'all', target_sort: 'newest', target_cursor: null });
  await noStoredPayload(page);
});
test('Users makes loading, empty and failed reads explicit without retaining private rows', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  const count = auth.reads().length; const release = auth.hold(['site_admin_list_users']);
  try {
    await page.locator('#adminRefresh').click(); await expect.poll(() => auth.reads().length).toBe(count + 1);
    await expect(page.locator('#adminWorkspace')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#adminStatus')).toHaveText('Loading records…'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
    await expect(page.locator('#adminRefresh')).toBeDisabled(); await expect(page.locator('#adminNextPage')).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); await expect(page.locator('#adminWorkspace')).not.toHaveAttribute('aria-busy');
  await page.getByLabel('Name or email prefix').fill('no-synthetic-member-matches'); await page.locator('#adminUsersFilters button').click();
  await expect(page.locator('#adminStatus')).toHaveText('No records match these filters.'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await expect(page.locator('#adminNextPage')).toBeDisabled(); await expect(page.locator('#adminFilterState')).toBeVisible();
  auth.fail(); await page.locator('#adminResetFilters').click();
  await expect(page.locator('#adminStatus')).toContainText('temporarily unavailable'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await expect(page.locator('#adminWorkspace')).not.toHaveAttribute('aria-busy'); await expect(page.locator('#adminRefresh')).toBeEnabled();
  expect(await page.content()).not.toMatch(/PRIVATE RAW ERROR|member28@example.invalid/);
  auth.fail(false); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await noStoredPayload(page);
});
test('audit-only permission never loads account summaries', async ({ context, page }) => {
  const auth = await installAdminStub(context); auth.permissions(['audit.read']);
  await page.goto('/admin.html'); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
  await expect(page.getByRole('tab', { name: 'Users', exact: true })).toBeHidden();
  expect(auth.reads().every((item) => item.path.includes('audit'))).toBe(true);
  expect(await page.content()).not.toContain('member28@example.invalid');
});
test('same-session assurance downgrade clears records before a fresh MFA decision', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  const session = auth.session(auth.A, 'aal1');
  await page.evaluate((value) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
    const channel = new BroadcastChannel('sb-127-auth-token');
    channel.postMessage({ event: 'TOKEN_REFRESHED', session: value }); channel.close();
  }, session);
  await expect(page.locator('#adminWorkspace')).toBeHidden();
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await page.locator('#adminRetryAccess').click(); await expect(page.locator('#adminMfa')).toBeVisible();
  expect(await page.content()).not.toContain('member28@example.invalid');
});
test('pagehide scrubs filters, modal and pending response; persisted pageshow revalidates', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  await page.getByLabel('Name or email prefix').fill('private-prefix');
  await page.getByLabel('Name or email prefix').fill(''); await page.locator('#adminUsersFilters button').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  const release = auth.hold(); await page.locator('#adminUsersRows button').first().click(); await expect(page.locator('#adminDetail')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  release(); await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  await expect(page.getByLabel('Name or email prefix')).toHaveValue('');
  auth.role('member'); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#adminGateMessage')).toContainText('does not have'); expect(await page.content()).not.toContain('member28@example.invalid');
});
test('wrong-actor response is rejected and explicit logout scrubs before navigation', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  auth.corrupt(); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  auth.corrupt(false); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.locator('[data-admin-menu-item]')).toBeVisible();
  await page.getByRole('button', { name: 'Log Out', exact: true }).click(); await expect(page).toHaveURL(/index\.html$/);
  await noStoredPayload(page);
});
for (const replacement of ['A→B→A', 'same actor, new immutable session']) {
  test(`${replacement} clears old records and rejects a delayed previous-session response`, async ({ context, page }) => {
    const auth = await installAdminStub(context); await ready(page);
    const opener = page.locator('#adminUsersRows button').first(); await opener.click();
    await page.locator('#adminUserFacts summary', { hasText: 'Crew and stored snapshots' }).click();
    await expect(page.locator('#adminUserFacts details[open]')).toHaveCount(1);
    await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
    const count = auth.reads().length; const release = auth.hold();
    await page.locator('#adminRefresh').click(); await expect.poll(() => auth.reads().length).toBe(count + 1);
    const finalSession = replacement === 'A→B→A' ? auth.firstSession : auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222');
    const transitions = replacement === 'A→B→A' ? [auth.session(auth.B), finalSession] : [finalSession];
    // Model the SDK's cross-tab storage write and sanitized auth notification.
    // Sessions are issued only by this local HTTP provider; production code
    // still performs getUser and the guarded expected-actor RPC on every read.
    await page.evaluate(async (sessions) => {
      const channel = new BroadcastChannel('sb-127-auth-token');
      for (const session of sessions) {
        localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
        window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
        channel.postMessage({ event: 'SIGNED_IN', session });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      channel.close();
    }, transitions);
    release(); await expect(page.locator('#adminWorkspace')).toBeHidden();
    await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
    await expect(page.locator('#adminDetail')).not.toBeVisible(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
    expect(await page.content()).not.toContain('STALE PREVIOUS SESSION SNAPSHOT');
    await page.locator('#adminRetryAccess').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
    expect(await page.content()).not.toContain('STALE PREVIOUS SESSION SNAPSHOT'); await noStoredPayload(page);
  });
}
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  test(`read-only records remain accessible in ${theme}`, async ({ context, page }, testInfo) => {
    const auth = await installAdminStub(context); presentationFixture(auth); await ready(page);
    // Visual-only theme override: no entitlement decision is inferred or stored.
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.locator('#adminUsersFilters summary').focus(); await page.keyboard.press('Enter');
    for (const select of await page.locator('#adminUsersFilters select').all()) expect((await select.boundingBox()).height).toBeGreaterThanOrEqual(48);
    const detailButton = page.locator('#adminUsersRows button').first();
    expect((await detailButton.boundingBox()).height).toBeLessThan(60);
    const axe = await new AxeBuilder({ page }).analyze(); expect(axe.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-users.png`), fullPage: false });
    await detailButton.click(); await page.locator('#adminUserFacts summary', { hasText: 'Crew and stored snapshots' }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator('#adminDetail').screenshot({ path: testInfo.outputPath(`${theme}-user-expanded.png`) });
    const configuredWidth = page.viewportSize().width;
    expect(await page.evaluate(() => document.documentElement.getBoundingClientRect().width)).toBeLessThanOrEqual(configuredWidth + 1);
    await page.keyboard.press('Escape'); await expect(detailButton).toBeFocused();
    await page.getByRole('tab', { name: 'Users', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Audit', exact: true })).toBeFocused();
    await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
    await page.locator('#adminAuditRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('staff_access_review');
    const modalAxe = await new AxeBuilder({ page }).analyze(); expect(modalAxe.violations).toEqual([]);
    await page.locator('#adminDetail').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('#adminDetailClose')).toBeInViewport();
    await page.locator('#adminDetail').evaluate((node) => { node.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`${theme}-audit-detail.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await noStoredPayload(page);
});
}
test('Users tablet cards and detail disclosures preserve fields and 200% text without viewport expansion', async ({ context, page }) => {
  const auth = await installAdminStub(context); presentationFixture(auth);
  await page.setViewportSize({ width: 768, height: 1024 }); await ready(page);
  const row = page.locator('#adminUsersRows tr').first();
  const table = page.getByRole('table', { name: /^Account records/ });
  await expect(table.getByRole('row')).toHaveCount(26); await expect(table.getByRole('columnheader')).toHaveCount(5);
  await expect(row.getByRole('cell')).toHaveCount(5);
  expect(await row.evaluate((node) => getComputedStyle(node).display)).toBe('block');
  await row.locator('button').focus(); await page.keyboard.press('Enter');
  const stored = page.locator('#adminUserFacts details').filter({ has: page.locator('summary', { hasText: 'Crew and stored snapshots' }) });
  await stored.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(stored).toHaveAttribute('open', '');
  for (const scale of ['100%', '200%']) {
    await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, scale);
    expect(await page.evaluate(() => document.documentElement.getBoundingClientRect().width)).toBeLessThanOrEqual(769);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(769);
    await expect(stored).toContainText('Stored app streak7');
    await expect(stored).toContainText('Crew-local roleAdmin');
    expect(await page.locator('#adminDetail').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await page.keyboard.press('Escape'); await expect(row.locator('button')).toBeFocused();
  await noStoredPayload(page);
});
test('Users long fields wrap across the card breakpoint without losing disclosure or table semantics', async ({ context, page }, testInfo) => {
  const auth = await installAdminStub(context); presentationFixture(auth);
  const name = 'LongSyntheticMemberName'.repeat(5); const email = `${'member'.repeat(30)}@example.invalid`;
  auth.roleTarget(PRESENTATION_USER, { name, email, crew: { id: '90000000-0000-4000-8000-000000000001', name: 'LongSyntheticCrew'.repeat(4), role: 'owner' } });
  await ready(page); const row = page.locator('#adminUsersRows tr').first(); const button = row.locator('button');
  await expect(button).toHaveAccessibleName(`View details for ${name}`);
  for (const width of [320, 390, 768, 1050, 1051, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const scale of ['100%', '200%']) {
      await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, scale);
      const geometry = await page.evaluate(() => ({ layout: document.documentElement.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth }));
      expect(geometry.layout).toBeLessThanOrEqual(width + 1); expect(geometry.scroll).toBeLessThanOrEqual(width + 1);
      await expect(row.getByRole('cell')).toHaveCount(5); await expect(page.getByRole('columnheader', { name: 'Last sign-in', exact: true })).toHaveCount(1);
      await expect(button).toBeVisible(); await expect(row).toContainText(email);
      if (scale === '100%') await row.screenshot({ path: testInfo.outputPath(`long-user-${width}.png`) });
      await button.focus(); await page.keyboard.press('Enter');
      const stored = page.locator('#adminUserFacts details').filter({ has: page.locator('summary', { hasText: 'Crew and stored snapshots' }) });
      const summary = stored.locator('summary'); await summary.focus(); await page.keyboard.press('Enter');
      await expect(stored).toHaveAttribute('open', ''); await expect(stored).toContainText('LongSyntheticCrew'.repeat(4));
      await expect(page.locator('#adminUserFacts')).toContainText(name); await expect(page.locator('#adminUserFacts')).toContainText(email);
      const detailGeometry = await page.locator('#adminDetail').evaluate(node => ({
        width: node.clientWidth, scroll: node.scrollWidth,
        historySummary: (() => { const element = document.querySelector('#adminUserHistory > summary'); return { width: element.clientWidth, scroll: element.scrollWidth, font: getComputedStyle(element).font, wrap: getComputedStyle(element).overflowWrap }; })(),
        overflowing: [...node.querySelectorAll('*')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1)
          .map(element => ({ tag: element.tagName, id: element.id, width: element.clientWidth, scroll: element.scrollWidth,
            text: element.textContent?.slice(0, 80), font: getComputedStyle(element).font, wrap: getComputedStyle(element).overflowWrap })),
      }));
      await testInfo.attach(`detail-geometry-${width}-${scale}`, { body: JSON.stringify(detailGeometry), contentType: 'application/json' });
      expect(await page.locator('#adminDetail').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${width}px / ${scale}: ${JSON.stringify(detailGeometry)}`).toBe(true);
      const title = await page.locator('#adminDetailTitle').evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
      expect(title.height, `${width}px / ${scale}: the two-word title must not collapse into a column of letters`).toBeLessThanOrEqual(title.lineHeight * 3 + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await summary.focus(); await page.keyboard.press('Space'); await expect(stored).not.toHaveAttribute('open');
      await page.keyboard.press('Escape'); await expect(button).toBeFocused();
    }
  }
  await noStoredPayload(page);
});
