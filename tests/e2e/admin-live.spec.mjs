import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';

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
test('Users presents existing account facts and historical snapshots without extra reads or writes', async ({ context, page }) => {
  const auth = await installAdminStub(context); presentationFixture(auth); await ready(page);
  const row = page.locator('#adminUsersRows tr').first();
  await expect(row.locator('[data-label="Account"]')).toContainText('Site roleMember');
  await expect(row).toContainText('2026-01-28 12:00:00 UTC');
  await expect(row).toContainText('2026-01-01 12:00:00 UTC');
  await expect(row).toContainText('2026-02-03 09:08:07 UTC');
  await expect(row.locator('[data-label="Crew"]')).toHaveText('NameSynthetic Cedar CrewCrew-local roleAdmin');
  await expect(row.locator('[data-label="Stored snapshots"]')).toContainText('Stored points0Stored subscriptionActive');
  const count = auth.reads().length;
  const summary = row.locator('summary'); await summary.focus(); await page.keyboard.press('Enter');
  await expect(summary).toHaveAccessibleName('View stored snapshots for Preview Member 28 (member28@example.invalid)');
  await expect(row.locator('details')).toHaveAttribute('open', '');
  await expect(row.locator('details')).toContainText('Stored app streak7');
  await expect(row.locator('details')).toContainText('Stored perfect-day streak0');
  await expect(row.locator('details')).toContainText('Last seen local date2026-01-20');
  await expect(row.locator('details')).toContainText('Recorded2026-01-21 10:11:12 UTC');
  await expect(row.locator('details')).toContainText('Period end2026-02-01 00:00:00 UTC');
  await expect(row.locator('details')).toContainText('Cancel at period endNo');
  await expect(row.locator('details')).toContainText('Recorded2026-01-22 12:13:14 UTC');
  await expect(page.locator('#adminUsersSnapshotNote')).toContainText('not current streak, access, or completion');
  await page.keyboard.press('Space'); await expect(row.locator('details')).not.toHaveAttribute('open');
  expect(auth.reads()).toHaveLength(count); expect(auth.assignments()).toHaveLength(0); expect(auth.denials()).toHaveLength(0);
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
  await expect(missing.locator('[data-label="Account"]')).toHaveText('Email unconfirmedSite roleMemberCreatedNot recordedEmail confirmedNot recordedLast sign-inNot recorded');
  await expect(missing.locator('[data-label="Crew"]')).toHaveText('Not recorded');
  await expect(missing.locator('[data-label="Stored snapshots"]')).toContainText('Stored pointsNot recordedStored subscriptionNot recorded');
  await missing.locator('summary').click();
  await expect(missing.locator('details section')).toHaveText(['Stored progress snapshotNot recorded', 'Stored subscription snapshotNot recorded']);
  const unusual = page.locator('#adminUsersRows tr').nth(1); await unusual.locator('summary').click();
  await expect(unusual.locator('[data-label="Crew"]')).toHaveText('Name<img src=x onerror=alert(1)>Crew-local roleOwner');
  await expect(unusual.locator('img')).toHaveCount(0);
  await expect(unusual.locator('details')).toContainText('Stored total points0Stored app streak0Stored perfect-day streak0');
  await expect(unusual.locator('details')).toContainText('Stored statusUnknownPeriod endNot recordedCancel at period endNot recorded');
  expect(await page.locator('#adminUsersRows').textContent()).not.toMatch(/PRIVATE_(?:CREW|PROGRESS|SUBSCRIPTION)_SENTINEL/);
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
    await page.locator('#adminUsersRows summary').first().click();
    await expect(page.locator('#adminUsersRows details[open]')).toHaveCount(1);
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
    await expect(page.locator('#adminUsersRows details')).toHaveCount(0);
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
    for (const select of await page.locator('#adminUsersFilters select').all()) expect((await select.boundingBox()).height).toBeGreaterThanOrEqual(48);
    const detailButton = page.locator('#adminUsersRows button').first();
    expect((await detailButton.boundingBox()).height).toBeLessThan(60);
    const axe = await new AxeBuilder({ page }).analyze(); expect(axe.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-users.png`), fullPage: false });
    await page.locator('#adminUsersRows summary').first().click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator('#adminUsersRows tr').first().screenshot({ path: testInfo.outputPath(`${theme}-user-expanded.png`) });
    const configuredWidth = page.viewportSize().width;
    expect(await page.evaluate(() => document.documentElement.getBoundingClientRect().width)).toBeLessThanOrEqual(configuredWidth + 1);
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
test('Users tablet cards preserve fields, keyboard disclosure and 200% text without viewport expansion', async ({ context, page }) => {
  const auth = await installAdminStub(context); presentationFixture(auth);
  await page.setViewportSize({ width: 768, height: 1024 }); await ready(page);
  const row = page.locator('#adminUsersRows tr').first();
  const table = page.getByRole('table', { name: /^Account records/ });
  await expect(table.getByRole('row')).toHaveCount(26); await expect(table.getByRole('columnheader')).toHaveCount(5);
  await expect(row.getByRole('cell')).toHaveCount(5);
  expect(await row.evaluate((node) => getComputedStyle(node).display)).toBe('block');
  await row.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(row.locator('details')).toHaveAttribute('open', '');
  for (const scale of ['100%', '200%']) {
    await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, scale);
    expect(await page.evaluate(() => document.documentElement.getBoundingClientRect().width)).toBeLessThanOrEqual(769);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(769);
    await expect(row.locator('details')).toContainText('Stored app streak7');
    await expect(row.locator('[data-label="Crew"]')).toContainText('Crew-local roleAdmin');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await noStoredPayload(page);
});
test('Users long fields wrap across the card breakpoint without losing disclosure or table semantics', async ({ context, page }, testInfo) => {
  const auth = await installAdminStub(context); presentationFixture(auth);
  const name = 'LongSyntheticMemberName'.repeat(5); const email = `${'member'.repeat(30)}@example.invalid`;
  auth.roleTarget(PRESENTATION_USER, { name, email, crew: { id: '90000000-0000-4000-8000-000000000001', name: 'LongSyntheticCrew'.repeat(4), role: 'owner' } });
  await ready(page); const row = page.locator('#adminUsersRows tr').first(); const summary = row.locator('summary');
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(summary).toHaveAccessibleName(`View stored snapshots for ${name} (${email})`);
  for (const width of [390, 768, 1050, 1051, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const scale of ['100%', '200%']) {
      await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, scale);
      const geometry = await page.evaluate(() => ({ layout: document.documentElement.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth }));
      expect(geometry.layout).toBeLessThanOrEqual(width + 1); expect(geometry.scroll).toBeLessThanOrEqual(width + 1);
      await expect(row.getByRole('cell')).toHaveCount(5); await expect(page.getByRole('columnheader', { name: 'Stored snapshots', exact: true })).toHaveCount(1);
      await expect(summary).toBeVisible(); await expect(row).toContainText(email);
      if (scale === '100%') await row.screenshot({ path: testInfo.outputPath(`long-user-${width}.png`) });
    }
  }
  await summary.focus(); await page.keyboard.press('Space'); await expect(row.locator('details')).not.toHaveAttribute('open');
  await noStoredPayload(page);
});
