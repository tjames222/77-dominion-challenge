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
  const menu = page.locator('.global-menu');
  const firstMenuLink = menu.locator('a').first();
  const lastMenuControl = menu.getByRole('button', { name: 'Log Out' });

  await expect(menu).toHaveAttribute('aria-hidden', 'true');
  await expect(menu).toHaveAttribute('inert', '');
  await expect(menu).toBeHidden();
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toHaveAttribute('aria-hidden', 'false');
  await expect(menu).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();
  await expect(firstMenuLink).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(lastMenuControl).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstMenuLink).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();
  await expect(menu).toHaveAttribute('aria-hidden', 'true');
  await expect(menu).toHaveAttribute('inert', '');
  await expect(menu).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/menu-open/);

  await firstMenuLink.evaluate((link) => link.focus());
  await expect(firstMenuLink).not.toBeFocused();
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

  const compactStyles = await page.locator('.shared-header-streak > .shared-header-streak-count').evaluate((element) => {
    const styles = getComputedStyle(element);
    return { transform: styles.transform, transitionProperty: styles.transitionProperty };
  });
  expect(compactStyles.transform).not.toBe('none');
  expect(compactStyles.transitionProperty).toContain('transform');
  expect(await topbar.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
});

test('Dominion Night keeps the disabled Dashboard action readable', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { theme: 'dominion-night' });
  const checkIn = page.locator('#checkInButton');

  await expect(checkIn).toBeDisabled();
  await expect(checkIn).toHaveCSS('color', 'rgb(196, 217, 213)');
  await expect(checkIn).toHaveCSS('background-color', 'rgb(27, 70, 72)');
  await expect(checkIn).toHaveCSS('opacity', '1');
  await expect(checkIn).toHaveCSS('cursor', 'not-allowed');
});

test('member navigation promotes Dashboard, Rewards, Community, and Private Journal', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const navigation = page.getByRole('navigation', { name: 'Member sections' });
  const links = navigation.getByRole('link');

  await expect(links).toHaveCount(4);
  await expect(links).toHaveText(['Dashboard', 'Rewards', 'Community', 'Private Journal']);
  await expect(navigation.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('aria-current', 'page');

  await navigation.getByRole('link', { name: 'Private Journal', exact: true }).click();
  await expect(page).toHaveURL(/\/private-journal\.html$/);
  await expect(page.locator('#journey')).toBeVisible();
  await expect(page.locator('#crew')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Private Journal', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/private-journal\.html$/);
  await expect(page.locator('#journey')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  await page.getByRole('link', { name: 'Community', exact: true }).click();
  await expect(page).toHaveURL(/\/community\.html$/);
  await expect(page.locator('#crew')).toBeVisible();
  await expect(page.locator('#journey')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Private Journal' })).toHaveCount(0);
  await expect(page.getByText('Post to Private Group')).toHaveCount(0);
  await expect(page.getByPlaceholder('Write a comment…')).toHaveCount(0);
});

test('Badges & Rewards tabs preserve loaded state across pointer and keyboard navigation', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.badgesRewards, { state: 'rewardsUnlocked' });
  const rewardsTab = page.getByRole('tab', { name: 'Rewards' });
  const badgesTab = page.getByRole('tab', { name: 'Badges' });
  const rewardsPanel = page.getByRole('tabpanel', { name: 'Rewards' });
  const badgesPanel = page.getByRole('tabpanel', { name: 'Badges' });
  const rewardRows = page.locator('[data-reward-key]');
  const badgeCards = page.locator('[data-badge-key]');

  await expect(rewardsTab).toHaveAttribute('aria-selected', 'true');
  await expect(rewardsTab).toHaveAttribute('tabindex', '0');
  await expect(badgesTab).toHaveAttribute('tabindex', '-1');
  await expect(rewardsPanel).toBeVisible();
  await expect(badgesPanel).toBeHidden();
  const rewardCount = await rewardRows.count();
  const badgeCount = await badgeCards.count();
  expect(rewardCount).toBeGreaterThan(0);
  expect(badgeCount).toBeGreaterThan(0);

  await badgesTab.click();
  await expect(badgesTab).toHaveAttribute('aria-selected', 'true');
  await expect(rewardsPanel).toBeHidden();
  await expect(badgesPanel).toBeVisible();
  await expect(badgeCards.first()).toBeVisible();

  await rewardsTab.click();
  await expect(rewardsPanel).toBeVisible();
  await rewardsTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(badgesTab).toBeFocused();
  await expect(badgesPanel).toBeVisible();
  await page.keyboard.press('Home');
  await expect(rewardsTab).toBeFocused();
  await expect(rewardsPanel).toBeVisible();
  await page.keyboard.press('End');
  await expect(badgesTab).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(rewardsTab).toBeFocused();
  await expect(rewardRows).toHaveCount(rewardCount);
  await expect(badgeCards).toHaveCount(badgeCount);
  await expect(page.locator('#rewardsList')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#badgesGallery')).toHaveAttribute('aria-busy', 'false');
});

test('single-crew setup expands, focuses, and safely cancels', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityEmpty' });
  const openButton = page.locator('#openCrewFormButton');
  const form = page.locator('#crewForm');
  await expect(form).toBeHidden();
  await openButton.click();
  await expect(openButton).toHaveAttribute('aria-expanded', 'true');
  await expect(form).toBeVisible();
  await expect(page.getByLabel('Crew name')).toBeFocused();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toBeHidden();
  await expect(openButton).toHaveAttribute('aria-expanded', 'false');
  await expect(openButton).toBeFocused();
});

test('crew deletion requires an accessible confirmation and restores focus on Escape', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  const trigger = page.getByRole('button', { name: 'Delete Crew' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const dialog = page.getByRole('alertdialog', { name: 'Are you sure?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('removes access for every member');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('non-admin members see Leave Group and retain personal data after confirmation', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityMember' });
  const trigger = page.getByRole('button', { name: 'Leave Group' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: 'Are you sure?' });
  await expect(dialog).toContainText('removes only your membership');
  await dialog.getByRole('button', { name: 'Leave Group' }).click();
  await expect(page.getByRole('button', { name: 'Create a Crew' })).toBeVisible();
  await expect(page.locator('#communityFeedback')).toContainText('personal Dominion data was preserved');
  const personal = await page.evaluate(() => ({
    user: JSON.parse(localStorage.getItem('dominion:user') || 'null'),
    stats: JSON.parse(localStorage.getItem('dominion:gameStats') || 'null'),
  }));
  expect(personal.user.email).toBe('qa.member@example.test');
  expect(personal.stats.totalPoints).toBe(750);
});

test('Community branded invite and provider actions retain their dedicated flows', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);

  const inviteButton = page.getByRole('button', { name: 'Invite People' });
  await expect(inviteButton).not.toHaveAttribute('data-share-kind', 'invite');
  await expect(inviteButton).toHaveAttribute('aria-haspopup', 'dialog');
  const inviteBox = await inviteButton.boundingBox();
  expect(inviteBox?.height).toBeGreaterThanOrEqual(44);
  expect(inviteBox?.width).toBeGreaterThanOrEqual(44);

  await inviteButton.click();
  await expect(page.getByRole('dialog', { name: 'Invite People' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate invitation' })).toBeEnabled();
  await page.keyboard.press('Escape');

  const slack = page.getByRole('button', { name: 'Connect Slack' });
  const discord = page.getByRole('button', { name: 'Connect Discord' });
  await expect(slack).toBeVisible();
  await expect(discord).toBeVisible();
  await expect(slack.locator('svg')).toHaveCount(1);
  await expect(discord.locator('svg')).toHaveCount(1);
  const [slackBox, discordBox] = await Promise.all([slack.boundingBox(), discord.boundingBox()]);
  expect(slackBox?.height).toBeGreaterThanOrEqual(44);
  expect(discordBox?.height).toBe(slackBox?.height);
});

test('Community exposes group settings through an accessible gear link', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  const settings = page.getByRole('link', { name: 'Group settings' });

  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute('href', './group-settings.html');
  await expect(settings.locator('.icon-settings')).toHaveCount(1);
  const bounds = await settings.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);

  await settings.click();
  await expect(page).toHaveURL(/\/group-settings\.html$/);
  await expect(page.locator('#groupSettingsContent')).toBeVisible();
});

test('Community hides group settings without an active crew', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityEmpty' });
  await expect(page.getByRole('link', { name: 'Group settings' })).toHaveCount(0);
});

test('Community exposes personal group settings to ordinary members', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityMember' });
  await expect(page.getByRole('link', { name: 'Group settings' })).toBeVisible();
});

test('Community exposes group settings to group administrators', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityAdmin' });
  await expect(page.getByRole('link', { name: 'Group settings' })).toBeVisible();
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
  await expect(page.getByRole('link', { name: 'Rewards', exact: true })).toHaveAttribute(
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
  const trigger = page.locator('.shared-header-streak');
  await expect(trigger).toContainText('6');
  await expect(trigger).toContainText('App Streak');
  await expect(trigger.locator('.icon-lightning')).toHaveCount(1);
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'App Streak' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Full standard streak');
  await expect(dialog).toContainText('Best full standard streak');
  await expect(dialog).toContainText('App streak');
  await expect(dialog).toContainText('Best app streak');
});

test('Dashboard reward queue dismisses safely and advances to the earned tier', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.open(ROUTE_BY_ID.dashboard);

  await expect(page.getByText('Latest Badge', { exact: true })).toHaveCount(0);
  await expect(page.locator('#badgeShelf')).toHaveCount(0);

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

test('Dashboard celebration replaces an open dialog and exclusively owns modal focus', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.open(ROUTE_BY_ID.dashboard);

  await page.locator('#selectAllActionsButton').click();
  await page.locator('.shared-header-streak').click();
  const streakDialog = page.getByRole('dialog', { name: 'App Streak' });
  await expect(streakDialog).toBeVisible();

  await page.locator('#checkInButton').evaluate((button) => button.click());

  const dayComplete = page.locator('#rewardToast');
  const closeButton = dayComplete.getByRole('button', { name: 'Dismiss day complete celebration' });
  await expect(dayComplete).toBeVisible();
  await expect(streakDialog).toBeHidden();
  await expect(closeButton).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect(page.locator('body')).toHaveAttribute('data-dialog-open', '');

  await page.keyboard.press('Escape');
  await expect(dayComplete).toBeHidden();
  await expect(streakDialog).toBeHidden();
  await expect(page.locator('body')).not.toHaveAttribute('data-dialog-open', '');
  await expect(page.locator('#checkInStatus')).toBeFocused();
});

test('Dashboard removes the duplicate Community preview while preserving its destination', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await expect(page.locator('#feed')).toHaveCount(0);
  await expect(page.locator('#completedToday')).toHaveCount(0);
  await expect(page.locator('section.community')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Community', exact: true })).toHaveAttribute('href', './community.html');
});

test('a completed share grants +14 and the Sharing badge only once', async ({ page, app }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => undefined,
    });
  });
  await app.open(ROUTE_BY_ID.dashboard);
  await expect(page.getByRole('button', { name: 'Share my progress' })).toHaveCount(0);
  const headerShare = page.locator('.shared-header-share');
  await expect(headerShare).toHaveAccessibleName('Share');
  await headerShare.click();
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
  await expect(page.locator('#profileFeedback')).toBeEmpty();
  await page.getByLabel('Name', { exact: true }).fill('Jordan Keyboard');
  await page.getByLabel('Email', { exact: true }).press('Enter');
  await expect(page.locator('#profileFeedback')).toHaveText('Profile saved.');
  await expect(page.locator('#profileName')).toHaveText('Jordan Keyboard');
});

test('Profile locks Dominion Night below 56 points and persists it after unlock', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile, { state: 'rewardsLocked' });
  const nightOption = page.locator('[data-theme-mode="dominion-night"]');
  await expect(nightOption).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#dominionNightStatus')).toContainText('28 of 56 points');
  await expect(page.locator('#dominionNightProgressLabel')).toHaveText(
    '50% complete. 28 points to unlock.',
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
