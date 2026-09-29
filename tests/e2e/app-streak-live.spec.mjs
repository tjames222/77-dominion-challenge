import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';
import { dailyBootstrapFixture } from '../fixtures/daily-action-bootstrap.mjs';

const optional = /\/app-streak-dialog-[\w-]+\.js(?:\?|$)/;
const trigger = page => page.locator('.shared-header-streak');
const dialog = page => page.getByRole('dialog', { name: 'App Streak', exact: true });
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function fixture(context, { locked = false } = {}) {
  const auth = await installAdminStub(context, { role: 'member' });
  const tokens = new Map([[auth.firstSession.access_token, auth.A]]);
  const calls = []; let holding = null; let lost = false;
  const activation = dailyBootstrapFixture({ actorId: auth.A, entryDate: '2026-09-28' }).activation;
  activation.canEditStartDate = !locked;
  await context.route(/\/__admin_fixture__\/rest\/v1\/(?:user_game_stats|user_badges|rpc\/(?:get_challenge_activation|record_app_visit|set_challenge_start_date))(?:\?|$)/, async route => {
    const request = route.request(); const name = new URL(request.url()).pathname.split('/').at(-1);
    const actor = tokens.get(request.headers().authorization?.replace(/^Bearer /, ''));
    const body = request.postData() ? request.postDataJSON() : null;
    calls.push({ name, actor, body });
    if (!actor) return json(route, {}, 401);
    if (name === 'user_game_stats') return json(route, { current_app_streak: 6, best_app_streak: 8 });
    if (name === 'user_badges') return json(route, []);
    if (name === 'record_app_visit') return json(route, { current_app_streak: 6, best_app_streak: 8 });
    if (name === 'get_challenge_activation') return json(route, activation);
    if (body.target_expected_actor_id !== actor || locked) return json(route, { message: 'Start date is locked.' }, 403);
    activation.startDate = body.target_start_date; activation.revision++;
    if (holding) await holding;
    return lost ? json(route, { message: 'Could not confirm the save.' }, 503) : json(route, activation);
  });
  return { ...auth, calls, writes: () => calls.filter(call => call.name === 'set_challenge_start_date'),
    replacement(actor = auth.A) { const session = auth.session(actor, 'aal2', '22222222-2222-4222-8222-222222222222'); tokens.set(session.access_token, actor); return session; },
    hold() { let release; holding = new Promise(resolve => { release = resolve; }); return () => { release(); holding = null; }; },
    loseResponse() { lost = true; } };
}
async function ready(page) {
  await page.goto('/science.html');
  await expect(trigger(page)).toBeVisible();
  await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
async function broadcast(page, session, event = 'SIGNED_IN') {
  await page.evaluate(({ session, event }) => {
    if (session) localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    else localStorage.removeItem('sb-127-auth-token');
    const channel = new BroadcastChannel('sb-127-auth-token'); channel.postMessage({ event, session }); channel.close();
  }, { session, event });
}
test.beforeEach(async ({ context, page, baseURL }) => {
  const external = []; const errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
    return route.fallback();
  });
  await context.routeWebSocket(/.*/, socket => { external.push('websocket'); socket.close(); });
  page.on('pageerror', error => errors.push(error.message));
  page.__streakExternal = external; page.__streakErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect(page.__streakExternal).toEqual([]); expect(page.__streakErrors).toEqual([]);
});

test('compiled dialog is click-only, coalesces repeated clicks, and restores keyboard focus', async ({ context, page }) => {
  const auth = await fixture(context); const requests = [];
  page.on('request', request => { if (optional.test(request.url())) requests.push(request.url()); });
  await ready(page); expect(requests).toHaveLength(0); await expect(dialog(page)).toHaveCount(0);
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route(optional, async route => { await held; await route.continue(); });
  await trigger(page).focus(); await page.keyboard.press('Enter');
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  await trigger(page).dispatchEvent('click'); release();
  await expect(dialog(page)).toBeVisible(); await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  expect(requests).toHaveLength(1);
  expect((await new AxeBuilder({ page }).include('#globalStreakDetailsDialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
  await trigger(page).click(); await expect(dialog(page)).toBeVisible(); expect(requests).toHaveLength(1);
  expect(auth.writes()).toHaveLength(0);
});

for (const cause of ['same-user SID', 'A-B-A', 'logout', 'pagehide']) {
  test(`compiled delayed dialog cannot mount after ${cause}`, async ({ context, page }) => {
    const auth = await fixture(context); let release; const held = new Promise(resolve => { release = resolve; });
    await page.route(optional, async route => { await held; await route.continue(); });
    await ready(page); await trigger(page).click(); await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
    const before = auth.requests.filter(item => item.path === '/auth/v1/user').length;
    if (cause === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    else if (cause === 'logout') { await broadcast(page, null, 'SIGNED_OUT'); await expect(trigger(page)).toHaveCount(0); }
    else {
      await broadcast(page, auth.replacement(cause === 'A-B-A' ? auth.B : auth.A));
      await expect.poll(() => auth.requests.filter(item => item.path === '/auth/v1/user').length).toBeGreaterThan(before);
      if (cause === 'A-B-A') {
        const next = auth.requests.filter(item => item.path === '/auth/v1/user').length;
        await broadcast(page, auth.replacement(auth.A));
        await expect.poll(() => auth.requests.filter(item => item.path === '/auth/v1/user').length).toBeGreaterThan(next);
      }
    }
    release(); await page.waitForLoadState('networkidle');
    await expect(dialog(page)).toHaveCount(0); expect(auth.writes()).toHaveLength(0);
  });
}

test('compiled import failure stays labelled after refresh and reload is explicit and recoverable', async ({ context, page }) => {
  const auth = await fixture(context); let fail = true; let attempts = 0;
  await page.route(optional, route => { attempts++; return fail
    ? route.fulfill({ status: 503, contentType: 'text/javascript', body: '/* unavailable */' }) : route.continue(); });
  await ready(page); await trigger(page).click();
  await expect(trigger(page)).toHaveAccessibleName(/Reload this page.*Save unfinished work/);
  await page.evaluate(() => window.dispatchEvent(new Event('dominion:challenge-activation-updated')));
  await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
  await expect(trigger(page)).toHaveAccessibleName(/Reload this page.*Save unfinished work/);
  page.once('dialog', async confirmation => { expect(confirmation.message()).toContain('Save any unfinished work'); await confirmation.dismiss(); });
  await trigger(page).click(); expect(attempts).toBe(1); await expect(dialog(page)).toHaveCount(0);
  fail = false;
  page.once('dialog', async confirmation => { expect(confirmation.message()).toContain('Save any unfinished work'); await confirmation.accept(); });
  await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }), trigger(page).click()]);
  await expect(trigger(page)).toBeVisible(); await trigger(page).click(); await expect(dialog(page)).toBeVisible();
  expect(attempts).toBe(2); expect(auth.writes()).toHaveLength(0);
});

for (const lost of [false, true]) {
  test(`date save preserves original actor/revision/timezone and never replays ${lost ? 'an unknown' : 'a pending'} response`, async ({ context, page }) => {
    const auth = await fixture(context); await ready(page); await trigger(page).click();
    await expect(dialog(page)).toHaveAttribute('aria-busy', 'false');
    const input = dialog(page).getByLabel('Start date'); await expect(input).toBeEnabled();
    await input.fill('2026-09-27'); const release = auth.hold(); if (lost) auth.loseResponse();
    const save = dialog(page).getByRole('button', { name: 'Save start date', exact: true });
    await save.click(); await expect.poll(() => auth.writes().length).toBe(1);
    await save.dispatchEvent('click'); await page.keyboard.press('Enter');
    const write = auth.writes()[0]; expect(write.actor).toBe(auth.A);
    expect(write.body).toMatchObject({ target_expected_actor_id: auth.A, target_expected_revision: 1,
      target_time_zone: 'America/Los_Angeles', target_start_date: '2026-09-27' });
    release();
    await expect(dialog(page).locator('[data-global-streak-start-date-feedback]')).toContainText(lost ? 'Could not confirm' : 'Challenge start date saved.');
    await expect(dialog(page)).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.press('Escape'); await expect(dialog(page)).toBeHidden();
    await trigger(page).click(); await expect(dialog(page)).toBeVisible();
    expect(auth.writes()).toHaveLength(1);
  });
}
test('locked date remains disabled after deferred rendering and cannot submit', async ({ context, page }) => {
  const auth = await fixture(context, { locked: true }); await ready(page); await trigger(page).click();
  await expect(dialog(page).getByLabel('Start date')).toBeDisabled();
  await dialog(page).locator('form').dispatchEvent('submit'); expect(auth.writes()).toHaveLength(0);
});
