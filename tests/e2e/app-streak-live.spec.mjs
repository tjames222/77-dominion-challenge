import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';
import { installFeedbackStub } from './support/feedback-supabase-stub.mjs';
import { dailyBootstrapV2Fixture, DAILY_INSTANCE_ID } from '../fixtures/daily-action-bootstrap-v2.mjs';

const optional = /\/app-streak-dialog-[\w-]+\.js(?:\?|$)/;
const headerOptional = /\/shared-header-actions-[\w-]+\.js(?:\?|$)/;
const trigger = page => page.locator('.shared-header-streak');
const dialog = page => page.getByRole('dialog', { name: 'App Streak', exact: true });
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function fixture(context, { locked = false, badgesUnavailable = false } = {}) {
  const auth = await installAdminStub(context, { role: 'member' });
  const tokens = new Map([[auth.firstSession.access_token, auth.A]]);
  const calls = []; let holding = null; let lost = false; let statsUnavailable = false; let nextStats = null;
  const activations = new Map([auth.A, auth.B].map(actorId => {
    const activation = dailyBootstrapV2Fixture({ actorId, entryDate: '2026-09-28',
      instanceId: actorId === auth.A ? DAILY_INSTANCE_ID : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).activation;
    activation.currentInstance.scopeKey = `original77:${activation.startDate}`;
    activation.currentInstance.provenance = 'legacy_bound';
    activation.canEditStartDate = !locked;
    return [actorId, activation];
  }));
  await context.route(/\/__admin_fixture__\/rest\/v1\/(?:user_game_stats|user_badges|rpc\/(?:get_challenge_activation_v2|record_app_visit|set_challenge_start_date_v2))(?:\?|$)/, async route => {
    const request = route.request(); const name = new URL(request.url()).pathname.split('/').at(-1);
    const actor = tokens.get(request.headers().authorization?.replace(/^Bearer /, ''));
    const body = request.postData() ? request.postDataJSON() : null;
    calls.push({ name, actor, body });
    if (!actor) return json(route, {}, 401);
    if (name === 'user_game_stats') {
      const held = nextStats; nextStats = null;
      if (held) await held.promise;
      return statsUnavailable ? json(route, { message: 'Statistics temporarily unavailable.' }, 503)
        : json(route, { current_app_streak: held?.streak ?? 6, best_app_streak: 8 });
    }
    if (name === 'user_badges') return badgesUnavailable ? json(route, { message: 'Badges unavailable.' }, 503) : json(route, []);
    if (name === 'record_app_visit') return json(route, { current_app_streak: 6, best_app_streak: 8 });
    const activation = activations.get(actor);
    if (body.target_expected_actor_id !== actor) return json(route, { message: 'The signed-in account changed.' }, 403);
    if (name === 'get_challenge_activation_v2') return json(route, activation);
    if (locked) return json(route, { message: 'Start date is locked.' }, 403);
    if (body.target_expected_instance_id !== activation.currentInstance.id
      || body.target_expected_revision !== activation.revision) return json(route, { message: 'The challenge changed.' }, 409);
    activation.startDate = body.target_start_date;
    activation.timeZone = body.target_time_zone;
    activation.status = activation.startDate > activation.serverDate ? 'scheduled' : 'active';
    activation.canParticipate = activation.canMutateDailyStandards = activation.status === 'active';
    Object.assign(activation.currentInstance, { startDate: activation.startDate, timeZone: activation.timeZone,
      status: activation.status, scopeKey: `original77:${activation.startDate}`,
      calendarDay: activation.status === 'active'
        ? Math.floor((Date.parse(activation.serverDate) - Date.parse(activation.startDate)) / 86400000) + 1 : null });
    activation.revision++;
    if (holding) await holding;
    return lost ? json(route, { message: 'Could not confirm the save.' }, 503) : json(route, activation);
  });
  return { ...auth, calls, writes: () => calls.filter(call => call.name === 'set_challenge_start_date_v2'),
    failStats(value) { statsUnavailable = value; },
    holdNextStats(streak = 99) { let release; const promise = new Promise(resolve => { release = resolve; }); nextStats = { promise, streak }; return release; },
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

test('compiled header issues one statistics SELECT and no badge SELECT per refresh, after the existing visit', async ({ context, page }) => {
  const auth = await fixture(context, { badgesUnavailable: true }); await ready(page);
  const count = name => auth.calls.filter(call => call.name === name).length;
  expect(count('user_game_stats')).toBe(1); expect(count('user_badges')).toBe(0);
  expect(count('record_app_visit')).toBe(1);
  expect(auth.calls.findIndex(call => call.name === 'record_app_visit')).toBeLessThan(auth.calls.findIndex(call => call.name === 'user_game_stats'));
  await trigger(page).click(); await expect(dialog(page)).toHaveAttribute('aria-busy', 'false');
  expect(count('user_game_stats')).toBe(2); expect(count('user_badges')).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('dominion:challenge-activation-updated')));
  await expect.poll(() => count('user_game_stats')).toBe(3);
  await expect(dialog(page)).toHaveAttribute('aria-busy', 'false');
  expect(count('user_badges')).toBe(0); expect(count('record_app_visit')).toBe(1);
  await expect(dialog(page).locator('[data-global-streak-value="currentAppStreak"]')).toHaveText('6');
  expect(auth.writes()).toHaveLength(0);
});

test('compiled statistics errors remain visible and recover on the existing refresh without badge reads', async ({ context, page }) => {
  const auth = await fixture(context); await ready(page); auth.failStats(true);
  await trigger(page).click();
  await expect(dialog(page).locator('[data-global-streak-load-status]')).toHaveText('Streak details could not be refreshed.');
  await expect(dialog(page)).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
  auth.failStats(false);
  await page.evaluate(() => window.dispatchEvent(new Event('dominion:challenge-activation-updated')));
  await expect(dialog(page).locator('[data-global-streak-load-status]')).toBeHidden();
  await expect(dialog(page)).toHaveAttribute('aria-busy', 'false');
  expect(auth.calls.filter(call => call.name === 'user_badges')).toHaveLength(0);
  expect(auth.calls.filter(call => call.name === 'record_app_visit')).toHaveLength(1);
});

for (const cause of ['same-user SID', 'A-B-A', 'logout', 'pagehide']) {
  test(`compiled held statistics cannot render stale header state after ${cause}`, async ({ context, page }) => {
    const auth = await fixture(context); const release = auth.holdNextStats();
    await page.goto('/science.html');
    await expect.poll(() => auth.calls.filter(call => call.name === 'user_game_stats').length).toBe(1);
    if (cause === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    else if (cause === 'logout') await broadcast(page, null, 'SIGNED_OUT');
    else {
      await broadcast(page, auth.replacement(cause === 'A-B-A' ? auth.B : auth.A));
      await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
      if (cause === 'A-B-A') {
        await broadcast(page, auth.replacement(auth.A));
        await expect.poll(() => auth.calls.filter(call => call.name === 'user_game_stats').length).toBe(3);
        await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
      }
    }
    if (cause === 'logout' || cause === 'pagehide') await expect(trigger(page)).toHaveCount(0);
    release(); await page.waitForLoadState('networkidle');
    if (cause === 'logout' || cause === 'pagehide') await expect(trigger(page)).toHaveCount(0);
    else await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
    if (cause === 'pagehide') {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
      await expect(page.locator('.authenticated-header-actions')).toHaveCount(1);
    }
    expect(auth.calls.filter(call => call.name === 'user_badges')).toHaveLength(0);
    expect(auth.writes()).toHaveLength(0);
  });
}

test('compiled slow header reserves geometry, leaves navigation/Admin independent, and survives an open drawer', async ({ context, page }) => {
  const auth = await fixture(context); auth.role('site_admin');
  let release; const held = new Promise(resolve => { release = resolve; }); let attempts = 0;
  await page.route(headerOptional, async route => { attempts++; await held; await route.continue(); });
  await page.goto('/science.html');
  await expect(trigger(page)).toBeDisabled();
  await expect(page.locator('.authenticated-header-actions')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const boxes = () => page.locator('.topbar').evaluate(topbar => ({ height: topbar.getBoundingClientRect().height,
    controls: ['.shared-header-share', '.shared-header-streak', '.global-menu-button'].map(selector => {
      const { x, y, width, height } = topbar.querySelector(selector).getBoundingClientRect(); return { x, y, width, height };
    }) }));
  const before = await boxes();
  expect(auth.calls).toEqual([]);
  await page.locator('.global-menu-button').click();
  await expect(page.locator('[data-admin-menu-item]')).toBeVisible();
  await expect(page.locator('.global-menu-links a').first()).toBeVisible();
  await expect(page.locator('.global-menu-training-load-status')).toHaveText('Loading training…');
  await expect(page.getByRole('button', { name: 'Start page training', exact: true })).toBeHidden();
  release(); await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
  await expect(page.locator('.authenticated-header-actions')).toHaveCount(1);
  await expect(page.locator('.topbar .global-menu-button-placeholder')).toHaveCount(1);
  await expect(page.locator('html')).toHaveClass(/menu-scroll-locked/);
  await expect(page.locator('.topbar').locator('xpath=ancestor-or-self::*[@inert]').first()).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.topbar-trailing-actions > .global-menu-button')).toBeFocused();
  const after = await boxes(); expect(after.height).toBe(before.height);
  for (let index = 0; index < before.controls.length; index++) {
    for (const key of ['x', 'y', 'width', 'height']) {
      // The original dash-to-number badge has subpixel font differences.
      expect(Math.abs(after.controls[index][key] - before.controls[index][key])).toBeLessThanOrEqual(1);
    }
  }
  for (const box of before.controls) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
  await page.locator('.global-menu-button').click(); await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/menu-scroll-locked/);
  await expect(page.locator('.topbar').locator('xpath=ancestor-or-self::*[@inert]')).toHaveCount(0);
  expect(attempts).toBe(1); expect(auth.writes()).toHaveLength(0);
});

test('compiled feedback remains usable while the member header is delayed', async ({ context, page }) => {
  const auth = await installFeedbackStub(context, { memberPages: true });
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route(headerOptional, async route => { await held; await route.continue(); });
  await page.goto('/profile.html'); await expect(trigger(page)).toBeDisabled();
  await page.locator('[data-feedback-widget]').click();
  await expect(page.getByRole('dialog', { name: 'Send Feedback', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(auth.writes()).toEqual([]); release();
});

for (const cause of ['same-user SID', 'A-B-A', 'focus', 'logout', 'logout intent', 'pagehide']) {
  test(`compiled pending header is fenced before controller work after ${cause}`, async ({ context, page }) => {
    const auth = await fixture(context); let release; const held = new Promise(resolve => { release = resolve; });
    await page.route(headerOptional, async route => { await held; await route.continue(); });
    await page.goto('/science.html'); await expect(trigger(page)).toBeDisabled(); expect(auth.calls).toEqual([]);
    const before = auth.requests.filter(item => item.path === '/auth/v1/user').length;
    let releaseLogout;
    if (cause === 'pagehide') {
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } else if (cause === 'logout intent') {
      const logout = new Promise(resolve => { releaseLogout = resolve; });
      await page.route('**/__admin_fixture__/auth/v1/logout**', async route => { await logout; await json(route, {}); });
      await page.locator('.global-menu-button').click(); await page.getByRole('button', { name: 'Log Out', exact: true }).click();
    } else if (cause === 'logout') await broadcast(page, null, 'SIGNED_OUT');
    else if (cause === 'focus') {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => auth.requests.filter(item => item.path === '/auth/v1/user').length).toBeGreaterThan(before);
    }
    else {
      await broadcast(page, auth.replacement(cause === 'A-B-A' ? auth.B : auth.A));
      await expect.poll(() => auth.requests.filter(item => item.path === '/auth/v1/user').length).toBeGreaterThan(before);
      if (cause === 'A-B-A') {
        const next = auth.requests.filter(item => item.path === '/auth/v1/user').length;
        await broadcast(page, auth.replacement(auth.A));
        await expect.poll(() => auth.requests.filter(item => item.path === '/auth/v1/user').length).toBeGreaterThan(next);
      }
    }
    if (['logout', 'logout intent', 'pagehide'].includes(cause)) await expect(trigger(page)).toHaveCount(0);
    release();
    if (['same-user SID', 'A-B-A', 'focus'].includes(cause)) {
      await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
      await expect(page.locator('.authenticated-header-actions')).toHaveCount(1);
      expect(auth.calls.every(call => call.actor === auth.A)).toBe(true);
      expect(auth.calls.filter(call => call.name === 'record_app_visit')).toHaveLength(1);
    } else {
      await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /shared-header-actions-/.test(entry.name)).length)).toBeGreaterThan(0);
      expect(auth.calls).toEqual([]); await expect(trigger(page)).toHaveCount(0);
      if (cause === 'pagehide') {
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
        await expect(page.locator('.authenticated-header-actions')).toHaveCount(1);
      }
      releaseLogout?.();
    }
    expect(auth.writes()).toHaveLength(0);
  });
}

test('compiled header failure keeps navigation available, stops training, and offers explicit reload only', async ({ context, page }) => {
  const auth = await fixture(context); let fail = true; let attempts = 0;
  await page.route(headerOptional, route => { attempts++; return fail
    ? route.fulfill({ status: 503, contentType: 'text/javascript', headers: { 'Cache-Control': 'no-store' }, body: '/* unavailable */' }) : route.continue(); });
  await page.goto('/science.html');
  await expect(trigger(page)).toHaveAccessibleName(/Reload to load member controls.*Save any unfinished work/);
  await expect(page.locator('link[rel="modulepreload"][href*="shared-header-actions-"]')).toHaveCount(0);
  await page.locator('.global-menu-button').click();
  await expect(page.locator('.global-menu-training-load-status')).toContainText('Member controls could not load');
  await expect(page.getByRole('button', { name: 'Start page training', exact: true })).toBeHidden();
  await expect(page.locator('.global-menu-links a').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(trigger(page)).toHaveAccessibleName(/Reload to load member controls/);
  page.once('dialog', async confirmation => { expect(confirmation.message()).toContain('Save any unfinished work'); await confirmation.dismiss(); });
  await trigger(page).click(); expect(attempts).toBe(1); expect(auth.calls).toEqual([]);
  fail = false;
  page.once('dialog', async confirmation => { await confirmation.accept(); });
  await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }), trigger(page).click()]);
  await expect(page.locator('.shared-header-streak-count')).toHaveText('6'); expect(attempts).toBe(2);
  expect(auth.writes()).toHaveLength(0);
});

test('compiled header deadline remains failed even if the timed-out code later arrives', async ({ context, page }) => {
  const auth = await fixture(context); await page.clock.install();
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route(headerOptional, async route => { await held; await route.continue(); });
  await page.goto('/science.html'); await expect(trigger(page)).toBeDisabled();
  await page.clock.fastForward(30_001);
  await expect(trigger(page)).toHaveAccessibleName(/Reload to load member controls/);
  release(); await page.waitForLoadState('networkidle');
  await expect(trigger(page)).toHaveAccessibleName(/Reload to load member controls/);
  expect(auth.calls).toEqual([]); expect(auth.writes()).toEqual([]);
});

test('compiled guest/public and menu-free entrypoints never request member header code', async ({ page }) => {
  const requests = []; page.on('request', request => { if (headerOptional.test(request.url())) requests.push(request.url()); });
  for (const path of ['/index.html', '/login.html', '/science.html', '/support.html', '/account-security.html']) {
    await page.goto(path); await page.waitForLoadState('networkidle');
    await expect(page.locator('.authenticated-header-actions')).toHaveCount(0);
  }
  expect(requests).toEqual([]);
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
  await dialog(page).evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
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
      target_expected_instance_id: DAILY_INSTANCE_ID,
      target_time_zone: 'America/Los_Angeles', target_start_date: '2026-09-27' });
    expect(write.body.target_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
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
