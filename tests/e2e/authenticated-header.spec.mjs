import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { AUTHENTICATED_HEADER_ROUTES } from '../../src/static/shared-header-state.mjs';
import { PRODUCTION_ROUTES, ROUTE_BY_ID } from './support/routes.mjs';

const authenticatedHeaderRoutes = PRODUCTION_ROUTES.filter((route) => (
  route.access !== 'public' || route.id === 'membership'
));

test('authenticated header allowlist covers every eligible production route', () => {
  const expectedEntries = authenticatedHeaderRoutes.map((route) => route.htmlEntry).sort();
  expect([...AUTHENTICATED_HEADER_ROUTES].sort()).toEqual(expectedEntries);
});

async function installHeaderHeightProbe(page) {
  await page.addInitScript(() => {
    window.__dominionHeaderHeights = [];
    document.addEventListener('DOMContentLoaded', () => {
      const topbar = document.querySelector('.topbar');
      if (!topbar || typeof ResizeObserver !== 'function') return;
      const record = () => window.__dominionHeaderHeights.push(topbar.getBoundingClientRect().height);
      record();
      new ResizeObserver(record).observe(topbar);
    }, { once: true });
  });
}

async function expectNoHeaderLayoutShift(page) {
  const heights = await page.evaluate(() => window.__dominionHeaderHeights || []);
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
}

async function readHeaderGeometry(page) {
  return page.locator('.topbar').evaluate((topbar) => {
    const selectors = [
      '.back-link',
      '.shared-header-share',
      '.shared-header-streak',
      '.global-menu-button',
    ];
    const controls = selectors.map((selector) => {
      const element = topbar.querySelector(selector);
      const bounds = element?.getBoundingClientRect();
      return {
        selector,
        x: bounds?.x ?? -1,
        y: bounds?.y ?? -1,
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        right: bounds?.right ?? -1,
        centerY: bounds ? bounds.y + (bounds.height / 2) : -1,
      };
    });
    const bounds = topbar.getBoundingClientRect();
    const backLink = topbar.querySelector('.back-link');
    const isVisible = (selector) => {
      const element = topbar.querySelector(selector);
      if (!element) return false;
      const styles = getComputedStyle(element);
      const elementBounds = element.getBoundingClientRect();
      return styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && elementBounds.width > 0
        && elementBounds.height > 0;
    };

    return {
      controls,
      height: bounds.height,
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      backTextFits: backLink ? backLink.scrollWidth <= backLink.clientWidth + 1 : false,
      shareLabelVisible: isVisible('.shared-header-share .shared-header-action-label'),
      streakLabelVisible: isVisible('.shared-header-streak .shared-header-action-label'),
      streakCountVisible: isVisible('.shared-header-streak-count'),
    };
  });
}

function expectOneTouchTargetRow(geometry) {
  expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.shareLabelVisible).toBe(true);
  expect(geometry.streakLabelVisible).toBe(true);
  expect(geometry.streakCountVisible).toBe(true);

  const centers = geometry.controls.map(({ centerY }) => centerY);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

  for (const control of geometry.controls) {
    expect(control.width, control.selector).toBeGreaterThanOrEqual(44);
    expect(control.height, control.selector).toBeGreaterThanOrEqual(44);
    expect(control.x, control.selector).toBeGreaterThanOrEqual(0);
    expect(control.right, control.selector).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  }

  for (let index = 1; index < geometry.controls.length; index += 1) {
    expect(geometry.controls[index].x).toBeGreaterThanOrEqual(geometry.controls[index - 1].right);
  }
}

const mobileHeaderCases = [
  { name: '390px dark Daily Standards', width: 390, route: ROUTE_BY_ID.bibleReading, theme: 'dark', expectFullBackLabel: true },
  { name: '390px Dominion Night community', width: 390, route: ROUTE_BY_ID.community, theme: 'dominion-night', expectFullBackLabel: true },
  { name: '360px dark Dashboard', width: 360, route: ROUTE_BY_ID.dashboard, theme: 'dark', expectFullBackLabel: true },
  { name: '320px light Daily Standards', width: 320, route: ROUTE_BY_ID.bibleReading, theme: 'light', expectFullBackLabel: true },
  { name: '390px signed-in Membership', width: 390, route: ROUTE_BY_ID.membership, state: 'member', theme: 'light', expectFullBackLabel: true, verifyReload: true },
];

for (const scenario of mobileHeaderCases) {
  test(`authenticated header stays in one compact row at ${scenario.name}`, async ({ page, app }) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await installHeaderHeightProbe(page);
    await app.open(scenario.route, { state: scenario.state, theme: scenario.theme });

    await expect(page.locator('.back-link')).toBeVisible();
    await expect(page.locator('.shared-header-share .shared-header-action-label')).toHaveText('Share');
    await expect(page.locator('.shared-header-streak .shared-header-action-label')).toHaveText('App Streak');
    await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const initial = await readHeaderGeometry(page);
    expectOneTouchTargetRow(initial);
    if (scenario.expectFullBackLabel) expect(initial.backTextFits).toBe(true);
    await expectNoHeaderLayoutShift(page);

    if (scenario.verifyReload) {
      await page.reload({ waitUntil: 'networkidle' });
      await app.stable();
      await expect(page.locator('.shared-header-share')).toHaveCount(1);
      await expect(page.locator('.shared-header-streak')).toHaveCount(1);
      expectOneTouchTargetRow(await readHeaderGeometry(page));
      await expectNoHeaderLayoutShift(page);
    }

    await page.evaluate(() => {
      document.body.style.minHeight = '1800px';
      window.scrollTo(0, 640);
    });
    await expect(page.locator('.topbar')).toHaveClass(/topbar-collapsed/);
    const collapsed = await readHeaderGeometry(page);
    expectOneTouchTargetRow(collapsed);
    expect(collapsed.height).toBe(initial.height);
  });
}

for (const route of authenticatedHeaderRoutes) {
  test(`${route.id} direct load and refresh expose exactly one authenticated Share and App Streak action`, async ({ page, app }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await app.open(route, {
      state: route.id === 'billing' ? 'memberLocked' : 'member',
      theme: 'dark',
    });

    for (const phase of ['direct load', 'refresh']) {
      await expect(page.locator('.shared-header-share'), phase).toHaveCount(1);
      await expect(page.locator('.shared-header-streak'), phase).toHaveCount(1);
      await expect(page.locator('.shared-header-action-label', { hasText: 'Share' }), phase).toBeVisible();
      await expect(page.locator('.shared-header-action-label', { hasText: 'App Streak' }), phase).toBeVisible();
      await expectNoHorizontalOverflow(page);

      if (phase === 'direct load') {
        await page.reload({ waitUntil: 'networkidle' });
        await app.stable();
      }
    }
  });
}

for (const route of PRODUCTION_ROUTES.filter((candidate) => candidate.access === 'public')) {
  test(`${route.id} guest load does not expose authenticated header actions`, async ({ page, app }) => {
    await app.open(route, { state: 'guest', theme: 'light' });
    await expect(page.locator('.shared-header-share')).toHaveCount(0);
    await expect(page.locator('.shared-header-streak')).toHaveCount(0);
  });
}

test('authenticated header dialogs restore keyboard focus to their triggers', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);

  const share = page.locator('.shared-header-share');
  await share.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose what you want to send' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(share).toBeFocused();

  const streak = page.locator('.shared-header-streak');
  await streak.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'App Streak' })).toBeVisible();
  await expect(streak).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(streak).toHaveAttribute('aria-expanded', 'false');
  await expect(streak).toBeFocused();
});

test('authenticated header clears stale controls and composer state across account changes and actual logout', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const share = page.locator('.shared-header-share');
  await share.click();
  const composer = page.getByRole('dialog', { name: 'Choose what you want to send' });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem('dominion:mockUserId', 'mock_user_e2e_second');
    localStorage.setItem('dominion:user', JSON.stringify({
      name: 'Second Member',
      email: 'second.member@example.test',
      avatarUrl: '',
      authenticated: true,
    }));
    localStorage.setItem('dominion:gameStats', JSON.stringify({
      totalPoints: 28,
      challengePoints: 28,
      currentAppStreak: 2,
      bestAppStreak: 4,
      currentFullDayStreak: 1,
      bestFullDayStreak: 2,
      lastSeenDate: '2026-02-14',
      lastFullDayDate: '2026-02-13',
    }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user' }));
  });

  await expect(composer).toBeHidden();
  await expect(page.locator('.shared-header-streak-count')).toHaveText('2');
  await expect(page.locator('.shared-header-share')).toHaveCount(1);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Log Out' }).click();
  await expect(page).toHaveURL(/\/index\.html$/);
  await expect(page.locator('.shared-header-share')).toHaveCount(0);
  await expect(page.locator('.shared-header-streak')).toHaveCount(0);
});
