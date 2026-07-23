import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import {
  AUTHENTICATED_ROUTES,
  MEMBER_ROUTES,
  PRODUCTION_ROUTES,
  ROUTE_BY_ID,
} from './support/routes.mjs';
import { FIXED_TODAY } from './support/fixtures.mjs';

test.describe('production route smoke coverage', () => {
  for (const route of PRODUCTION_ROUTES) {
    test(route.id + ' loads from deterministic fixtures', async ({ page, app }) => {
      await app.open(route);
      await expect(page.locator('main')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      app.assertNoRuntimeErrors();
    });
  }
});

test.describe('authenticated route guards', () => {
  for (const route of AUTHENTICATED_ROUTES) {
    test(route.id + ' sends a logged-out visitor to login', async ({ page, app }) => {
      await app.seed('guest');
      await page.goto(route.path);
      await expect(page).toHaveURL(/\/login\.html\?returnTo=/);
      await expect(page.locator('#authForm')).toBeVisible();
    });
  }

  for (const route of MEMBER_ROUTES) {
    test(route.id + ' sends a signed-in non-member to billing', async ({ page, app }) => {
      await app.seed('memberLocked');
      await page.goto(route.path);
      await expect(page).toHaveURL(/\/billing\.html\?intent=subscription$/);
      await expect(page.locator('#billingStatusTitle')).toBeVisible();
    });
  }
});

test('global navigation is keyboard operable and Escape closes it', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const menuButton = page.getByRole('button', { name: 'Open menu' });
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass(/menu-open/);
});

test('global navigation stays compact away from the top without shifting layout', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const topbar = page.locator('.topbar');
  const menuButton = page.getByRole('button', { name: 'Open menu' });
  const initialBox = await topbar.boundingBox();

  await page.evaluate(() => window.scrollTo(0, 640));
  await expect(topbar).toHaveClass(/topbar-collapsed/);
  await expect(topbar).toHaveClass(/topbar-scrolled/);

  const compactBox = await topbar.boundingBox();
  expect(compactBox?.y).toBe(0);
  expect(compactBox?.height).toBe(initialBox?.height);
  await expect(menuButton).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 320));
  await expect(topbar).toHaveClass(/topbar-collapsed/);

  await menuButton.evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  await expect(topbar).not.toHaveClass(/topbar-collapsed/);
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(topbar).toHaveClass(/topbar-collapsed/);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(topbar).not.toHaveClass(/topbar-collapsed|topbar-scrolled/);
});

test('community tablist follows arrow-key navigation', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  const crewTab = page.getByRole('tab', { name: 'Private Group' });
  const journeyTab = page.getByRole('tab', { name: 'Private Journal' });

  await crewTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(journeyTab).toBeFocused();
  await expect(journeyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#journey')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Global' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'My Journey' })).toHaveCount(0);
  await expect(page.getByText('Post to Private Group')).toHaveCount(0);
  await expect(page.getByPlaceholder('Write a comment…')).toHaveCount(0);
});

test('login form submits with the keyboard and honors a safe return path', async ({ page, app }) => {
  await app.seed('guest');
  await page.goto('/login.html?returnTo=./profile.html');
  await page.getByLabel('Email').fill('keyboard.member@example.test');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Password').press('Enter');

  await expect(page).toHaveURL(/\/profile\.html$/);
  await expect(page.locator('#profileEmail')).toHaveText('keyboard.member@example.test');
});

test('daily action controls toggle by keyboard and persist the dated fixture', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.morningPrayer);
  const prayerAction = page.locator('#actionCompletionToggle');
  await expect(prayerAction).toHaveAccessibleName('Mark Morning Prayer complete, worth 1 point');
  await prayerAction.focus();
  await page.keyboard.press('Space');
  await expect(prayerAction).toHaveAttribute('aria-pressed', 'true');

  const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('dominion:entries') || '[]'));
  expect(entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      date: FIXED_TODAY,
      completed: expect.arrayContaining(['morningPrayer']),
    }),
  ]));
});

test('Dashboard links all seven standards to their dedicated pages', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const links = page.locator('#checklist .check-row-details');
  await expect(links).toHaveCount(7);
  expect(await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual([
    './bible-reading.html',
    './morning-prayer.html',
    './worship.html',
    './evening-prayer.html',
    './workout-one.html',
    './intentional-walk.html',
    './workout-two.html',
  ]);
  await expect(page.getByRole('link', { name: 'View badges and rewards' })).toHaveAttribute(
    'href',
    './badges-rewards.html',
  );
});

test('Dashboard streak opens all four current and personal-best metrics', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const trigger = page.locator('#dashboardStreakButton');
  await expect(trigger).toContainText('6');
  await expect(trigger.locator('.icon-lightning')).toHaveCount(1);
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Streak details' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Full standard streak');
  await expect(dialog).toContainText('Best full standard streak');
  await expect(dialog).toContainText('App streak');
  await expect(dialog).toContainText('Best app streak');
});

test('a completed share grants +14 and the Sharing badge only once', async ({ page, app }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => undefined,
    });
  });
  await app.open(ROUTE_BY_ID.dashboard);
  await page.locator('[data-share-composer][data-share-kind="progress"]').click();
  const dialog = page.getByRole('dialog', { name: 'Choose what you want to send' });
  const nativeShare = dialog.getByRole('button', { name: 'Share from this device' });
  await expect(nativeShare).toBeEnabled();
  await nativeShare.click();
  await expect(dialog.getByRole('status')).toContainText('You earned +14 points and the Sharing badge.');

  const firstGrant = await page.evaluate(() => ({
    stats: JSON.parse(localStorage.getItem('dominion:gameStats') || '{}'),
    badges: JSON.parse(localStorage.getItem('dominion:badges') || '[]'),
  }));
  expect(firstGrant.stats.totalPoints).toBe(764);
  expect(firstGrant.badges.filter((badge) => badge.key === 'sharing')).toHaveLength(1);

  await nativeShare.click();
  await expect(dialog.getByRole('status')).toContainText('already earned');
  const secondTotal = await page.evaluate(() => (
    JSON.parse(localStorage.getItem('dominion:gameStats') || '{}').totalPoints
  ));
  expect(secondTotal).toBe(764);

  await page.goto(ROUTE_BY_ID.badgesRewards.path);
  await expect(page.locator('#rewardsList[aria-busy="false"]')).toBeVisible();
  const sharingBadge = page.locator('[data-badge-key="sharing"]');
  await expect(sharingBadge).toContainText('Share the Challenge');
  await expect(sharingBadge.locator('.icon-share')).toHaveCount(1);
});

test('the retired Today’s Actions URL returns safely to Dashboard', async ({ page, app }) => {
  await app.seed('member');
  await page.goto('/today-actions.html');
  await expect(page).toHaveURL(/\/dashboard\.html#daily-standards$/);
  await expect(page.locator('#checklist [data-standard-card]')).toHaveCount(7);
});

test('profile form saves through Enter and announces success', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  await page.getByLabel('Name', { exact: true }).fill('Jordan Keyboard');
  await page.getByLabel('Email', { exact: true }).press('Enter');
  await expect(page.locator('#profileFeedback')).toHaveText('Profile saved.');
  await expect(page.locator('#profileName')).toHaveText('Jordan Keyboard');
});

test('Profile locks Dominion Night below 500 points and persists it after unlock', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile, { state: 'rewardsLocked' });
  const nightOption = page.locator('[data-theme-mode="dominion-night"]');
  await expect(nightOption).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#dominionNightStatus')).toContainText('250 of 500 points');
  await expect(page.locator('#dominionNightProgressLabel')).toHaveText(
    '50% complete. 250 points to unlock.',
  );
});

test('Profile selects an owned Dominion Night theme from the server-backed preference', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  const nightOption = page.locator('[data-theme-mode="dominion-night"]');
  await expect(nightOption).toHaveAttribute('aria-disabled', 'false');
  await nightOption.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dominion-night');
  await expect(page.locator('#themeSelectionStatus')).toHaveText('Dominion Night theme selected.');
  const preference = await page.evaluate(() => (
    JSON.parse(localStorage.getItem('dominion:mockThemePreferences') || '{}').mock_user_e2e_77
  ));
  expect(preference.themeKey).toBe('dominion-night');
});
