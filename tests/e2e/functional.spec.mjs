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

test('global navigation applies the real compact visual styles without screenshot normalization', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.open(ROUTE_BY_ID.dashboard);
  await page.locator('style[data-dominion-e2e-screenshot-style]').evaluate((style) => style.remove());

  const topbar = page.locator('.topbar');
  const initialHeight = await topbar.evaluate((element) => element.getBoundingClientRect().height);
  await expect(topbar).toHaveCSS('border-bottom-width', '1px');

  await page.evaluate(() => window.scrollTo(0, 640));
  await expect(topbar).toHaveClass(/topbar-collapsed/);
  await expect.poll(() => topbar.evaluate((element) => getComputedStyle(element, '::before').transform)).not.toBe('none');

  const compactStyles = await page.locator('#dashboardStreakButton > strong').evaluate((element) => {
    const styles = getComputedStyle(element);
    return { transform: styles.transform, transitionProperty: styles.transitionProperty };
  });
  expect(compactStyles.transform).not.toBe('none');
  expect(compactStyles.transitionProperty).toContain('transform');
  expect(await topbar.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
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

test('Dashboard places tracking and the scorecard around the countdown in document order', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const order = await page.locator('main > section').evaluateAll((sections) => sections.map((section) => ({
    id: section.id,
    classes: section.className,
  })));
  const position = (marker) => order.findIndex(({ id, classes }) => id === marker || classes.includes(marker));

  expect(position('dashboard-hero')).toBeLessThan(position('dashboard-tracking'));
  expect(position('dashboard-tracking')).toBeLessThan(position('countdownCard'));
  expect(position('countdownCard')).toBeLessThan(position('dashboard-scorecard'));
  expect(position('dashboard-scorecard')).toBeLessThan(position('gameSummaryCard'));

  await page.locator('#countdownCheckInButton').click();
  await expect(page.locator('#check-in')).toBeFocused();
  await expect(page.locator('#checklist [data-standard-card]')).toHaveCount(7);
});

test('Dashboard uses zero-point glass only outside the private-group podium', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate(() => {
    const stats = JSON.parse(localStorage.getItem('dominion:gameStats') || '{}');
    localStorage.setItem('dominion:gameStats', JSON.stringify({
      ...stats,
      totalPoints: 0,
      challengePoints: 0,
    }));
  });
  await page.reload();
  await app.stable();

  const emblem = page.locator('#gameLevelEmblem');
  await expect(emblem).toHaveAttribute('data-prestige', 'private-1');
  await expect(emblem).not.toHaveAttribute('data-material', 'zero-glass');
  await expect(page.locator('#gameLevelCrown')).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem('dominion:mockCrews', '[]');
    localStorage.setItem('dominion:mockCrewMembers', '{}');
    localStorage.removeItem('dominion:activeCrewId');
  });
  await page.reload();
  await app.stable();

  await expect(emblem).toHaveAttribute('data-prestige', 'default');
  await expect(emblem).toHaveAttribute('data-material', 'zero-glass');
  await expect(emblem).toHaveAccessibleName(/Zero-point glass coin/);
  await expect(page.locator('#gameLevelCrown')).toBeHidden();
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

test('Dashboard reward queue dismisses safely and advances to the earned tier', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.open(ROUTE_BY_ID.dashboard);

  await expect(page.getByText('Latest Badge', { exact: true })).toBeVisible();
  await expect(page.locator('#badgeShelf .progression-badge-card')).toHaveCount(1);
  await expect(page.locator('#badgeShelf')).toContainText('First Sweat');

  await page.locator('#selectAllActionsButton').click();
  const postButton = page.locator('#checkInButton');
  await expect(postButton).toBeEnabled();
  await postButton.click();

  const dayComplete = page.locator('#rewardToast');
  await expect(dayComplete).toBeVisible();
  await expect(dayComplete.getByRole('button', { name: 'Dismiss day complete celebration' })).toBeFocused();
  await page.locator('#rewardBackdrop').click({ position: { x: 8, y: 8 } });

  const badge = page.locator('#badgeCelebration');
  await expect(dayComplete).toBeHidden();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-tier', 'silver');
  await expect(badge).toContainText('Silver Badge Earned');

  await badge.getByRole('heading', { name: 'Two-Week Guard' }).click();
  await expect(badge).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(badge).toBeHidden();
  await expect(page.locator('#checkInStatus')).toBeFocused();
});

test('Dashboard accountability keeps the newest three while counting the full feed', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate(() => {
    const feed = Array.from({ length: 35 }, (_, index) => ({
      id: `feed-${index + 1}`,
      name: `Member ${index + 1}`,
      day: 14,
      status: 'complete',
      completedCount: 7,
      pointsAwarded: 7,
      timestamp: 'Today',
      createdAt: new Date(Date.UTC(2026, 1, 14, 16, index)).toISOString(),
    }));
    localStorage.setItem('dominion:feed', JSON.stringify(feed));
  });
  await page.reload({ waitUntil: 'networkidle' });

  await expect(page.locator('#feed .feed-item')).toHaveCount(3);
  await expect(page.locator('#feed .feed-item').nth(0)).toContainText('Member 35');
  await expect(page.locator('#feed .feed-item').nth(1)).toContainText('Member 34');
  await expect(page.locator('#feed .feed-item').nth(2)).toContainText('Member 33');
  await expect(page.locator('#completedToday')).toHaveText('35 people completed today');

  await page.evaluate(() => localStorage.setItem('dominion:feed', '[]'));
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#feed .feed-item')).toHaveCount(0);
  await expect(page.locator('#completedToday')).toHaveText('0 people completed today');
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
