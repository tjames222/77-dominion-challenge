import { expect, test } from '@playwright/test';
import { installJournalStub, replaceJournalSession } from './support/journal-supabase-stub.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';

const notes = page => page.locator('#journalTimeline .timeline-note');
const draft = page => page.locator('#journalForm').getByLabel('What did today reveal?');
const pageErrors = new WeakMap();
const externalRequests = new WeakMap();
test.beforeEach(async ({ context, page, baseURL }) => {
  const errors = []; const external = [];
  pageErrors.set(page, errors); externalRequests.set(page, external);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseURL).origin) return route.fallback();
    external.push(url.origin); return route.abort();
  });
  await context.routeWebSocket(/.*/, socket => { external.push('WebSocket'); socket.close(); });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
  expect(externalRequests.get(page)).toEqual([]);
});
async function ready(page) {
  await page.goto('/private-journal.html');
  await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
  await expect(page.locator('#journalTimeline')).toHaveAttribute('aria-busy', 'false');
}
async function noStoredJournal(page) {
  const stored = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'));
  expect(stored).not.toMatch(/PRIVATE JOURNAL|PRIVATE DRAFT|PRIVATE RAW|created_at.*entry_date/);
}
async function settleTheme(page, theme) {
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  // Let the real palette transition begin and finish. Do not disable motion or
  // sample a half-dark/half-light palette as a stable theme contrast result.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === 'running' && Number.isFinite(animation.effect?.getTiming().iterations)).length)).toBe(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('1000 rows transfer at most 26, render 25, and page exact same-date tuples with no body cache', async ({ page, context }) => {
  const api = await installJournalStub(context, { count: 1000 }); await ready(page);
  await expect(notes(page)).toHaveCount(25);
  await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0001');
  expect(api.reads).toHaveLength(1); expect(api.reads[0].count).toBe(26);
  await draft(page).fill('PRIVATE DRAFT stays while paging');
  await page.locator('#journalPageOlder').click();
  await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0026');
  await expect(notes(page)).toHaveCount(25);
  await expect(page.locator('#journalTimeline')).not.toContainText('PRIVATE JOURNAL 0001');
  await expect(page.locator('#journalHistoryTitle')).toBeFocused();
  await expect(page.locator('.journal-date-heading')).toContainText('25 entries on this page');
  expect(new Set([...api.reads[0].ids.slice(0, 25), ...api.reads[1].ids.slice(0, 25)]).size).toBe(50);
  await page.locator('#journalPageNewer').focus(); await page.keyboard.press('Enter');
  await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0001');
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT stays while paging');
  expect(api.reads).toHaveLength(3); expect(api.reads.every(read => read.count <= 26)).toBe(true);
  expect(await page.content()).not.toContain('OTHER OWNER PRIVATE JOURNAL');
  await noStoredJournal(page);
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('last page, back to newest, empty state and accessible loading/retry preserve the draft', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page);
  await draft(page).fill('PRIVATE DRAFT survives errors');
  const release = api.hold(); await page.locator('#journalPageOlder').click();
  await expect(page.locator('#journalPageStatus')).toHaveText('Loading journal entries…');
  await expect(notes(page)).toHaveCount(0); await expect(page.locator('#journalPageOlder')).toBeDisabled();
  api.failRead(); release();
  await expect(page.locator('#journalPageRetry')).toBeVisible();
  await expect(page.locator('#journalPageRetry')).toBeFocused();
  expect(await page.content()).not.toContain('PRIVATE RAW');
  api.failRead(false); await page.locator('#journalPageRetry').click();
  await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0026');
  await page.locator('#journalPageOlder').click(); await expect(notes(page)).toHaveCount(13);
  await expect(page.locator('#journalPageOlder')).toBeDisabled();
  await page.locator('#journalPageNewest').click(); await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0001');
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT survives errors');
  api.rows.splice(0); await page.locator('#journalPageOlder').click();
  await expect(page.locator('#journalTimeline')).toContainText('Your private journal is ready.');
  await expect(page.locator('#journalPageStatus')).toContainText('0 entries on this page');
  await noStoredJournal(page);
});

test('create and edit reset to newest only after verified success, without losing another draft', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page);
  await page.locator('#journalPageOlder').click(); await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0026');
  await draft(page).fill('PRIVATE DRAFT newly saved');
  await page.locator('#journalForm button[type=submit]').click();
  await expect(page.locator('#communityFeedback')).toHaveText('Private journal entry saved.');
  await expect(notes(page).first()).toContainText('PRIVATE DRAFT newly saved');
  await expect(page.locator('#journalPageNewer')).toBeDisabled();
  await expect(draft(page)).toHaveValue('');
  await draft(page).fill('PRIVATE DRAFT unrelated create');
  await page.locator('#journalPageOlder').click(); await expect(page.locator('#journalHistoryTitle')).toContainText('page 2');
  const targetId = await notes(page).first().getAttribute('data-journal-entry-id');
  await notes(page).first().getByRole('button', { name: /Edit journal/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit entry' });
  await dialog.getByLabel('What did today reveal?').fill('PRIVATE DRAFT edited by immutable id');
  await dialog.getByLabel('Date', { exact: true }).fill('2026-10-01');
  await dialog.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog).toBeHidden(); await expect(page.locator('#communityFeedback')).toHaveText('Journal entry updated.');
  await expect(page.locator('#journalPageNewer')).toBeDisabled(); await expect(page.locator('#journalHistoryTitle')).toBeFocused();
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT unrelated create');
  expect(api.writes).toHaveLength(2); expect(api.writes[1].body.target_entry_id).toBe(targetId);
  await noStoredJournal(page);
});

test('lost save response is not automatically retried or claimed rolled back', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page); api.loseWrite();
  await draft(page).fill('PRIVATE DRAFT uncertain save'); await page.locator('#journalForm button[type=submit]').click();
  await expect(page.locator('#communityFeedback')).toContainText('couldn’t confirm this save');
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT uncertain save'); expect(api.writes).toHaveLength(1);
  await expect(page.locator('#journalForm button[type=submit]')).toBeDisabled();
  await page.locator('#journalReconcile').click();
  await expect(notes(page).first()).toContainText('PRIVATE DRAFT uncertain save'); expect(api.writes).toHaveLength(1);
  await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
  await expect(page.locator('#communityFeedback')).toContainText('including an older page');
  await expect(page.locator('#communityFeedback')).toContainText('Another save can create a duplicate.');
  expect(await page.content()).not.toContain('PRIVATE RAW LOST RESPONSE');
});

test('refresh during a dispatched save preserves the draft and requires explicit read-only reconciliation', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page);
  const release = api.hold('write'); await draft(page).fill('PRIVATE DRAFT refresh during save');
  await page.locator('#journalForm button[type=submit]').click(); await expect.poll(() => api.writes.length).toBe(1);
  await replaceJournalSession(page, api.session(), 'TOKEN_REFRESHED'); release();
  await expect(page.locator('#journalReconcile')).toBeVisible();
  await expect(page.locator('#journalReconcile')).toBeEnabled();
  await expect(page.locator('#communityFeedback')).toContainText('couldn’t confirm the pending save');
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT refresh during save');
  await expect(page.locator('#journalForm button[type=submit]')).toBeDisabled();
  await page.locator('#journalReconcile').click();
  await expect(notes(page).first()).toContainText('PRIVATE DRAFT refresh during save');
  await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
  expect(api.writes).toHaveLength(1); await noStoredJournal(page);
});

for (const mode of ['different actor', 'same actor replacement', 'ABA', 'signout']) {
  test(`late page response cannot restore journal or draft after ${mode}`, async ({ page, context }) => {
    const api = await installJournalStub(context); await ready(page); await draft(page).fill('PRIVATE DRAFT old owner');
    const release = api.hold(); await page.locator('#journalPageOlder').click();
    await expect.poll(() => api.reads.length).toBe(2);
    if (mode === 'signout') await replaceJournalSession(page, null, 'SIGNED_OUT');
    else {
      await replaceJournalSession(page, api.session(mode === 'same actor replacement' ? api.A : api.B, 'aal2', '22222222-2222-4222-8222-222222222222'));
      if (mode === 'ABA') await replaceJournalSession(page, api.session(api.A, 'aal2', '33333333-3333-4333-8333-333333333333'));
    }
    release();
    if (mode === 'signout') await expect(page).toHaveURL(/login/);
    else {
      await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
      await expect(draft(page)).toHaveValue('');
      await expect(page.locator('#journalHistoryTitle')).toHaveText('Recent entries');
      await expect(notes(page).first()).toContainText(mode === 'different actor' ? 'OTHER OWNER PRIVATE JOURNAL' : 'PRIVATE JOURNAL 0001');
    }
    expect(await page.content()).not.toContain('PRIVATE DRAFT old owner');
    expect(api.writes).toHaveLength(0); await noStoredJournal(page);
  });
}

test('same-session token refresh preserves unsaved draft but invalidates pending page response', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page); await draft(page).fill('PRIVATE DRAFT same session');
  const release = api.hold(); await page.locator('#journalPageOlder').click();
  await expect.poll(() => api.reads.length).toBe(2);
  await replaceJournalSession(page, api.session(), 'TOKEN_REFRESHED'); release();
  await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
  await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0001');
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT same session');
  expect(api.writes).toHaveLength(0); await noStoredJournal(page);
});

test('late committed save after replacement never publishes an old receipt or retries the write', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page);
  const release = api.hold('write'); await draft(page).fill('PRIVATE DRAFT late write');
  await page.locator('#journalForm button[type=submit]').click(); await expect.poll(() => api.writes.length).toBe(1);
  await replaceJournalSession(page, api.session(api.B)); release();
  await expect(notes(page).first()).toContainText('OTHER OWNER PRIVATE JOURNAL');
  await expect(draft(page)).toHaveValue('');
  await expect(page.locator('#communityFeedback')).not.toContainText('saved');
  expect(await page.content()).not.toContain('PRIVATE DRAFT late write'); expect(api.writes).toHaveLength(1);
  await noStoredJournal(page);
});

test('BFCache pagehide clears private DOM and drafts before pageshow revalidates', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page); await draft(page).fill('PRIVATE DRAFT frozen');
  await notes(page).first().getByRole('button', { name: /Edit journal/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit entry' }); await expect(dialog).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(notes(page)).toHaveCount(0); await expect(dialog).toBeHidden(); await expect(draft(page)).toHaveValue('');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(notes(page)).toHaveCount(25); expect(api.writes).toHaveLength(0); await noStoredJournal(page);
});

test('silent same-user session replacement rejects the pending read and scrubs its draft', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page); await draft(page).fill('PRIVATE DRAFT silently replaced');
  const release = api.hold(); await page.locator('#journalPageOlder').click();
  await expect.poll(() => api.reads.length).toBe(2);
  const replacement = api.session(api.A, 'aal2', '44444444-4444-4444-8444-444444444444');
  await page.evaluate(value => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)), replacement);
  release();
  await expect(page.locator('#journalPageRetry')).toBeVisible();
  await expect(notes(page)).toHaveCount(0); await expect(draft(page)).toHaveValue('');
  await page.locator('#journalPageRetry').click(); await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0001');
  expect(api.writes).toHaveLength(0); await noStoredJournal(page);
});

test('MFA downgrade clears private content and requires login instead of accepting late entries', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page); await draft(page).fill('PRIVATE DRAFT needs MFA');
  const release = api.hold(); await page.locator('#journalPageOlder').click();
  await expect.poll(() => api.reads.length).toBe(2);
  await replaceJournalSession(page, api.session(api.A, 'aal1'), 'TOKEN_REFRESHED'); release();
  await expect(page).toHaveURL(/login/);
  expect(await page.content()).not.toContain('PRIVATE DRAFT needs MFA');
  expect(await page.content()).not.toContain('PRIVATE JOURNAL');
  expect(api.writes).toHaveLength(0); await noStoredJournal(page);
});

test('initial partial bootstrap failure cannot publish its delayed sibling and retries with a new owner handle', async ({ page, context }) => {
  const api = await installJournalStub(context); api.failPolicy(); const release = api.hold();
  await page.goto('/private-journal.html');
  await expect(page.locator('#journalPageRetry')).toBeVisible();
  await expect(notes(page)).toHaveCount(0); await expect(page.locator('#journalForm button[type=submit]')).toBeDisabled();
  api.failPolicy(false); release();
  await page.locator('#journalPageRetry').click();
  await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
  await expect(notes(page)).toHaveCount(25); await expect(page.locator('#journalPageRetry')).toBeHidden();
  expect(await page.content()).not.toContain('PRIVATE RAW'); expect(api.writes).toHaveLength(0);
  expect(api.reads.length).toBeGreaterThanOrEqual(2); await noStoredJournal(page);
});

test('all-theme paging, loading and reconciliation retain contrast and 320px geometry', async ({ page, context }, testInfo) => {
  const api = await installJournalStub(context); await ready(page);
  await page.locator('#journalPageOlder').click();
  await expect(page.locator('#journalHistoryTitle')).toContainText('page 2');
  for (const theme of ['dark', 'light', 'dominion-night', 'dominion-platinum']) {
    await settleTheme(page, theme);
    await page.locator('.journal-pagination').scrollIntoViewIfNeeded();
    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    await page.screenshot({ path: testInfo.outputPath(`journal-pagination-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 844 });
  for (const theme of ['dark', 'light']) {
    await settleTheme(page, theme);
    await page.locator('.journal-pagination').scrollIntoViewIfNeeded();
    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`journal-pagination-320-${theme}.png`) });
  }
  const release = api.hold(); await page.locator('#journalPageOlder').click();
  await expect(page.locator('#journalPageStatus')).toHaveText('Loading journal entries…');
  await page.locator('#journalPageStatus').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('journal-loading-320-light.png') });
  api.failRead(); release();
  await expect(page.locator('#journalPageRetry')).toBeVisible();
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('journal-retry-320-light.png') });
  api.failRead(false); await page.locator('#journalPageRetry').click(); await expect(notes(page)).toHaveCount(13);
  api.loseWrite(); await draft(page).fill('PRIVATE DRAFT visual reconciliation');
  await page.locator('#journalForm button[type=submit]').click();
  await expect(page.locator('#journalReconcile')).toBeVisible();
  await page.locator('#journalReconcile').scrollIntoViewIfNeeded();
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  await page.screenshot({ path: testInfo.outputPath('journal-reconcile-320-light.png') });
});

test('temporary owner verification failure hides history without erasing the draft or retrying in a loop', async ({ page, context }) => {
  const api = await installJournalStub(context); await ready(page); await draft(page).fill('PRIVATE DRAFT verification unavailable');
  const release = api.hold(); await page.locator('#journalPageOlder').click(); await expect.poll(() => api.reads.length).toBe(2);
  api.failVerification(); release();
  await expect(page.locator('#journalPageRetry')).toBeVisible(); await expect(notes(page)).toHaveCount(0);
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT verification unavailable');
  await expect(page.locator('#communityFeedback')).toContainText('session could not be verified');
  expect(api.reads).toHaveLength(2); expect(api.writes).toHaveLength(0); expect(await page.content()).not.toContain('PRIVATE RAW');
  api.failVerification(false); await page.locator('#journalPageRetry').click();
  await expect(notes(page).first()).toContainText('PRIVATE JOURNAL 0026');
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT verification unavailable'); await noStoredJournal(page);
});

test('failed lazy journal code requires explicit reload confirmation and then recovers without a write', async ({ page, context }) => {
  const api = await installJournalStub(context); let chunkRequests = 0; let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest() && new URL(request.url()).pathname === '/private-journal.html') documents += 1; });
  // Fail only the built Journal application chunk once. Auth/provider requests
  // remain real SDK calls to the existing synthetic loopback fixture.
  await context.route(/\/assets\/journal-api-application-[^/]+\.js(?:\?.*)?$/, route => {
    chunkRequests += 1;
    return chunkRequests === 1
      ? route.fulfill({ status: 503, contentType: 'application/javascript', headers: { 'Cache-Control': 'no-store' }, body: '// synthetic unavailable Journal code' })
      : route.fallback();
  });
  await page.goto('/private-journal.html');
  await expect(page.locator('#journalPageReload')).toBeVisible();
  await expect(page.locator('#journalPageRetry')).toBeHidden();
  await expect(page.locator('#journalPageError')).toContainText('code couldn’t load');
  await expect(page.locator('#journalForm button[type=submit]')).toBeDisabled();
  await expect(notes(page)).toHaveCount(0);
  await draft(page).fill('PRIVATE DRAFT kept until reload is confirmed');
  await page.locator('#journalPageReload').click();
  const confirmation = page.getByRole('dialog', { name: 'Reload your journal?' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Reloading will clear unsaved drafts.');
  await expect(confirmation.getByRole('button', { name: 'Keep draft' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Keep draft' }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator('#journalPageReload')).toBeFocused();
  await expect(draft(page)).toHaveValue('PRIVATE DRAFT kept until reload is confirmed');
  expect(documents).toBe(1); expect(chunkRequests).toBe(1); expect(api.reads).toHaveLength(0); expect(api.writes).toHaveLength(0);
  await page.locator('#journalPageReload').click();
  await confirmation.getByRole('button', { name: 'Reload journal', exact: true }).click();
  await expect(page.locator('#journalForm button[type=submit]')).toBeEnabled();
  await expect(notes(page)).toHaveCount(25);
  await expect(page.locator('#journalPageReload')).toBeHidden();
  await expect(draft(page)).toHaveValue('');
  expect(documents).toBe(2); expect(chunkRequests).toBe(2); expect(api.reads).toHaveLength(1); expect(api.writes).toHaveLength(0);
  await noStoredJournal(page);
});
