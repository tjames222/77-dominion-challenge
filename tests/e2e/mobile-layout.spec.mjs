import {
  expect,
  expectNoHorizontalOverflow,
  test,
} from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const memberRoutes = [
  ROUTE_BY_ID.dashboard,
  ROUTE_BY_ID.badgesRewards,
  ROUTE_BY_ID.community,
  ROUTE_BY_ID.privateJournal,
];

test('phone member navigation stays on one sticky icon row without overflow', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 720 });

  for (const route of memberRoutes) {
    await app.open(route);
    const nav = page.locator('[data-member-tabs]');
    const links = nav.locator('.member-tab');
    await expect(links).toHaveCount(4);
    const geometry = await links.evaluateAll((items) => ({
      rows: new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size,
      minHeight: Math.min(...items.map((item) => item.getBoundingClientRect().height)),
      labelsVisible: items.some((item) => {
        const label = item.querySelector('.member-tab-label');
        return label && label.getBoundingClientRect().width > 1;
      }),
    }));
    expect(geometry.rows).toBe(1);
    expect(geometry.minHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.labelsVisible).toBe(false);
    await expectNoHorizontalOverflow(page);

    await page.evaluate(() => window.scrollTo(0, 160));
    await expect(nav).toHaveClass(/member-tabs-collapsed/);
    const stickyTop = await nav.evaluate((element) => ({
      actual: element.getBoundingClientRect().top,
      expected: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-sticky-height')) + 6,
    }));
    expect(Math.abs(stickyTop.actual - stickyTop.expected)).toBeLessThanOrEqual(1);
  }
});

test('Rewards intro, sticky tabs, share action, and progress follow the intended mobile order', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open(ROUTE_BY_ID.badgesRewards);
  const memberNav = page.locator('[data-member-tabs]');
  const rewardTabs = page.locator('.badges-rewards-tabs');
  const progress = page.locator('#gameSummaryCard');

  await expect(progress).toHaveAttribute('aria-busy', 'false');
  const order = await page.locator('main > *').evaluateAll((elements) => ({
    hero: elements.findIndex((element) => element.classList.contains('badges-rewards-hero')),
    tabs: elements.findIndex((element) => element.classList.contains('badges-rewards-tabs')),
    share: elements.findIndex((element) => element.classList.contains('badges-rewards-share-action')),
    progress: elements.findIndex((element) => element.id === 'gameSummaryCard'),
  }));
  expect(order.hero).toBeGreaterThan(-1);
  expect(order.tabs).toBe(order.hero + 1);
  expect(order.share).toBe(order.tabs + 1);
  expect(order.progress).toBe(order.share + 1);

  await page.evaluate(() => window.scrollTo(0, 500));
  const positions = await Promise.all([
    memberNav.evaluate((element) => element.getBoundingClientRect()),
    rewardTabs.evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(positions[1].top).toBeGreaterThanOrEqual(positions[0].bottom + 7);
  await expect.poll(() => rewardTabs.evaluate((element) => Math.abs(
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--secondary-tabs-sticky-height'))
      - element.getBoundingClientRect().height,
  ))).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
  app.assertNoRuntimeErrors();
});
