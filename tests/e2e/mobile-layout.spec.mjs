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

    const navigationRhythm = await nav.evaluate((element) => {
      const resolveLength = (customProperty) => {
        const probe = document.createElement('span');
        probe.style.cssText = `position:fixed;visibility:hidden;width:var(${customProperty})`;
        document.body.append(probe);
        const value = Number.parseFloat(getComputedStyle(probe).width);
        probe.remove();
        return value;
      };
      const topbar = element.previousElementSibling;
      const pageStart = element.nextElementSibling;
      const stackGap = resolveLength('--navigation-stack-gap');
      const contentGap = resolveLength('--navigation-content-gap');
      return {
        expected: pageStart?.tagName === 'NAV' ? stackGap : contentGap,
        pageGap: pageStart?.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
        primaryGap: element.getBoundingClientRect().top - topbar.getBoundingClientRect().bottom,
        stackGap,
      };
    });
    expect(Math.abs(navigationRhythm.primaryGap - navigationRhythm.stackGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(navigationRhythm.pageGap - navigationRhythm.expected)).toBeLessThanOrEqual(1);

    await page.evaluate(() => window.scrollTo(0, 160));
    await expect(nav).toHaveClass(/member-tabs-collapsed/);
    const stickyTop = await nav.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;width:var(--navigation-stack-gap)';
      document.body.append(probe);
      const stackGap = Number.parseFloat(getComputedStyle(probe).width);
      probe.remove();
      return {
        actual: element.getBoundingClientRect().top,
        expected: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-sticky-height'))
          + stackGap,
      };
    });
    expect(Math.abs(stickyTop.actual - stickyTop.expected)).toBeLessThanOrEqual(1);
  }
});

test('dashboard header follows the shared rhythm at common iPhone, tablet, and desktop sizes', async ({ page, app }) => {
  const viewports = [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1440, height: 1000 },
  ];
  await app.open(ROUTE_BY_ID.dashboard);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;width:var(--navigation-content-gap)';
      document.body.append(probe);
      const expectedGap = Number.parseFloat(getComputedStyle(probe).width);
      probe.remove();
      const nav = document.querySelector('[data-member-tabs]');
      const hero = document.querySelector('.dashboard-hero');
      const eyebrow = hero?.querySelector('.eyebrow');
      return {
        expectedGap,
        heroGap: hero.getBoundingClientRect().top - nav.getBoundingClientRect().bottom,
        eyebrowGap: eyebrow.getBoundingClientRect().top - nav.getBoundingClientRect().bottom,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(Math.abs(geometry.heroGap - geometry.expectedGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.eyebrowGap - geometry.expectedGap)).toBeLessThanOrEqual(1);
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  }
  app.assertNoRuntimeErrors();
});

test('public and auth page starts use the same responsive content spacing', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.login);
  for (const viewport of [{ width: 375, height: 667 }, { width: 430, height: 932 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const geometry = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;width:var(--navigation-content-gap)';
      document.body.append(probe);
      const expected = Number.parseFloat(getComputedStyle(probe).width);
      probe.remove();
      const topbar = document.querySelector('.topbar');
      const content = topbar.nextElementSibling;
      return {
        actual: content.getBoundingClientRect().top - topbar.getBoundingClientRect().bottom,
        expected,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(Math.abs(geometry.actual - geometry.expected)).toBeLessThanOrEqual(1);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
  }
  app.assertNoRuntimeErrors();
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
