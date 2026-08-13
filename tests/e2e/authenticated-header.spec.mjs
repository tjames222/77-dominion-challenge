import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { FIXED_USER, FIXED_USER_ID } from './support/fixtures.mjs';
import { AUTHENTICATED_HEADER_ROUTES } from '../../src/static/shared-header-state.mjs';
import { PRODUCTION_ROUTES, ROUTE_BY_ID } from './support/routes.mjs';

const authenticatedHeaderRoutes = PRODUCTION_ROUTES.filter((route) => (
  route.access !== 'public' || ['membership', 'science'].includes(route.id)
));

async function logInAsPreviewAccount(page, user, { logOutFirst = true } = {}) {
  return page.evaluate(async ({ nextUser, shouldLogOut }) => {
    const api = await import('/src/static/api.js');
    if (shouldLogOut) await api.clearAuthSession();
    const sessionUser = api.saveLocalMockUser(nextUser);
    // Give this test account its own preview entitlement so the account-switch
    // regression remains on an authenticated app page without borrowing the
    // previous account's subscription.
    await api.createCheckoutSession('dominion_membership');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user' }));
    return sessionUser.userId;
  }, { nextUser: user, shouldLogOut: logOutFirst });
}

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
  { name: '390px Dominion Platinum rewards', width: 390, route: ROUTE_BY_ID.badgesRewards, state: 'rewardsUnlocked', theme: 'dominion-platinum', expectFullBackLabel: true },
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

test('App Streak date-only edits preserve the activation timezone', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate((userId) => {
    const states = JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}');
    states[userId] = {
      ...states[userId],
      mode: 'solo',
      crewId: null,
      groupAttributionCrewId: null,
      groupMembershipActive: false,
      timeZone: 'America/Los_Angeles',
      canEditStartDate: true,
      capabilities: {
        ...states[userId].capabilities,
        canEditStartDate: true,
      },
    };
    localStorage.setItem('dominion:mockChallengeActivation', JSON.stringify(states));
  }, FIXED_USER_ID);
  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();

  await page.locator('.shared-header-streak').click();
  const dialog = page.getByRole('dialog', { name: 'App Streak' });
  const startDate = dialog.getByLabel('Start date');
  await expect(startDate).toBeEnabled();
  await startDate.fill('2026-02-02');
  await dialog.getByRole('button', { name: 'Save start date' }).click();
  await expect(dialog.locator('[data-global-streak-start-date-feedback]'))
    .toContainText('Challenge start date saved.');

  const saved = await page.evaluate((userId) => (
    JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}')[userId]
  ), FIXED_USER_ID);
  expect(saved.startDate).toBe('2026-02-02');
  expect(saved.timeZone).toBe('America/Los_Angeles');
});

test('legacy mock start dates wait for their evidenced owner and never leak to another account', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate(() => {
    localStorage.removeItem('dominion:mockChallengeActivation');
    localStorage.removeItem('dominion:mockChallengeActivationLegacyOwner');
    localStorage.setItem('dominion:startDate', JSON.stringify('2026-02-03'));
    localStorage.setItem('dominion:checkInDates', JSON.stringify(['2026-02-10']));
  });
  const secondUser = {
    name: 'Second Member',
    email: 'second.member@example.test',
    avatarUrl: '',
  };
  const secondUserId = await logInAsPreviewAccount(page, secondUser);

  const wrongAccountState = await page.evaluate((userId) => ({
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}')
      [userId],
    legacyOwner: localStorage.getItem('dominion:mockChallengeActivationLegacyOwner'),
    checkIns: JSON.parse(localStorage.getItem('dominion:checkInDates') || 'null'),
  }), secondUserId);
  expect(wrongAccountState.activation.status).toBe('not_started');
  expect(wrongAccountState.activation.startDate).toBeNull();
  expect(wrongAccountState.legacyOwner).toBeNull();
  expect(wrongAccountState.checkIns).toEqual(['2026-02-10']);

  await page.locator('.shared-header-streak').click();
  await expect(page.getByRole('dialog', { name: 'App Streak' }).getByLabel('Start date'))
    .toBeDisabled();

  expect(await logInAsPreviewAccount(page, FIXED_USER)).toBe(FIXED_USER_ID);

  await expect.poll(() => page.evaluate(() => {
    const states = JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}');
    return states.mock_user_e2e_77?.startDate || 'missing';
  })).toBe('2026-02-03');

  const rightfulOwnerState = await page.evaluate((userId) => ({
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}')[userId],
    legacyOwner: localStorage.getItem('dominion:mockChallengeActivationLegacyOwner'),
    checkIns: JSON.parse(localStorage.getItem('dominion:checkInDates') || 'null'),
  }), FIXED_USER_ID);
  expect(rightfulOwnerState.legacyOwner).toBe(FIXED_USER_ID);
  expect(rightfulOwnerState.activation.mode).toBe('solo');
  expect(rightfulOwnerState.activation.canEditStartDate).toBe(false);
  expect(rightfulOwnerState.checkIns).toEqual({
    owner: `mock:${FIXED_USER_ID}`,
    dates: ['2026-02-10'],
    challengeDays: [],
  });

  await page.locator('.shared-header-streak').click();
  await expect(page.getByRole('dialog', { name: 'App Streak' }).getByLabel('Start date'))
    .toBeDisabled();

  await page.evaluate((userId) => {
    const states = JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}');
    delete states[userId];
    localStorage.setItem('dominion:mockChallengeActivation', JSON.stringify(states));
  }, secondUserId);
  expect(await logInAsPreviewAccount(page, secondUser)).toBe(secondUserId);

  await expect.poll(() => page.evaluate((userId) => {
    const states = JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}');
    return states[userId]?.status || 'missing';
  }, secondUserId)).toBe('not_started');
  expect(await page.evaluate(() => (
    localStorage.getItem('dominion:mockChallengeActivationLegacyOwner')
  ))).toBe(FIXED_USER_ID);
});

test('profile hydration clears loading feedback independently for each preview account', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  await expect(page.locator('#profileName')).toHaveText(FIXED_USER.name);
  await expect(page.locator('#profileFeedback')).toBeEmpty();

  const secondUser = {
    name: 'Second Member',
    email: 'second.member@example.test',
    avatarUrl: '',
  };
  const secondUserId = await logInAsPreviewAccount(page, secondUser);
  expect(secondUserId).not.toBe(FIXED_USER_ID);
  await expect(page.locator('#profileName')).toHaveText(secondUser.name);
  await expect(page.locator('#profileFeedback')).toBeEmpty();

  expect(await logInAsPreviewAccount(page, FIXED_USER)).toBe(FIXED_USER_ID);
  await expect(page.locator('#profileName')).toHaveText(FIXED_USER.name);
  await expect(page.locator('#profileFeedback')).toBeEmpty();
});

test('adopting a legacy preview ID preserves its Solo date and owned check-in lock', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate(() => {
    localStorage.removeItem('dominion:mockUserIdsByIdentity');
    localStorage.removeItem('dominion:mockChallengeActivation');
    localStorage.removeItem('dominion:mockChallengeActivationLegacyOwner');
    localStorage.setItem('dominion:mockCrewMembers', JSON.stringify({}));
    localStorage.setItem('dominion:startDate', JSON.stringify('2026-02-03'));
    localStorage.setItem('dominion:checkInDates', JSON.stringify(['2026-02-10']));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();

  const continuity = await page.evaluate(({ userId, email }) => ({
    mappedUserId: JSON.parse(localStorage.getItem('dominion:mockUserIdsByIdentity') || '{}')[email],
    legacyOwner: localStorage.getItem('dominion:mockChallengeActivationLegacyOwner'),
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}')[userId],
    checkIns: JSON.parse(localStorage.getItem('dominion:checkInDates') || 'null'),
  }), { userId: FIXED_USER_ID, email: FIXED_USER.email });

  expect(continuity.mappedUserId).toBe(FIXED_USER_ID);
  expect(continuity.legacyOwner).toBe(FIXED_USER_ID);
  expect(continuity.activation).toMatchObject({
    mode: 'solo',
    startDate: '2026-02-03',
    canEditStartDate: false,
  });
  expect(continuity.checkIns).toEqual({
    owner: `mock:${FIXED_USER_ID}`,
    dates: ['2026-02-10'],
    challengeDays: [],
  });
});

test('a fresh activation cannot claim another account’s ambiguous legacy preview state', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const secondUser = {
    name: 'Second Member',
    email: 'second.member@example.test',
    avatarUrl: '',
  };
  const secondUserId = 'mock_user_second_fou_1438';
  const result = await page.evaluate(async ({ firstUserEmail, firstUserId, nextUser, nextUserId }) => {
    const api = await import('/src/static/api.js');
    const { readPreviewUserValue } = await import('/src/static/preview-user-state.mjs');
    const readStats = () => readPreviewUserValue(
      localStorage,
      nextUserId,
      'dominion:gameStats',
      { totalPoints: 0, currentAppStreak: 0 },
    );
    localStorage.removeItem('dominion:user');
    localStorage.removeItem('dominion:mockUserId');
    localStorage.removeItem('dominion:previewUserStateLegacyOwner');
    localStorage.removeItem('dominion:mockChallengeActivationLegacyOwner');
    localStorage.setItem('dominion:mockUserIdsByIdentity', JSON.stringify({
      [firstUserEmail]: firstUserId,
      [nextUser.email]: nextUserId,
    }));
    localStorage.setItem('dominion:previewUserStateByOwner', JSON.stringify({}));
    localStorage.setItem('dominion:mockChallengeActivation', JSON.stringify({}));
    localStorage.setItem('dominion:mockChallengeActivationRequests', JSON.stringify({}));
    localStorage.setItem('dominion:gameStats', JSON.stringify({
      totalPoints: 77,
      currentAppStreak: 9,
    }));

    const sessionUser = api.saveLocalMockUser(nextUser);
    await api.createCheckoutSession('dominion_membership');
    const before = readStats();
    const activation = await api.activateSoloChallenge({
      startDate: new Date().toISOString().slice(0, 10),
      timeZone: 'UTC',
      expectedUserId: sessionUser.userId,
    });
    const after = readStats();
    return {
      userId: sessionUser.userId,
      before,
      after,
      activationStatus: activation.status,
      activationLegacyOwner: localStorage.getItem('dominion:mockChallengeActivationLegacyOwner'),
      previewLegacyOwner: localStorage.getItem('dominion:previewUserStateLegacyOwner'),
      legacyPoints: JSON.parse(localStorage.getItem('dominion:gameStats') || '{}').totalPoints,
    };
  }, {
    firstUserEmail: FIXED_USER.email,
    firstUserId: FIXED_USER_ID,
    nextUser: secondUser,
    nextUserId: secondUserId,
  });

  expect(result).toMatchObject({
    userId: secondUserId,
    before: { totalPoints: 0, currentAppStreak: 0 },
    after: { totalPoints: 0, currentAppStreak: 0 },
    activationStatus: 'active',
    activationLegacyOwner: null,
    previewLegacyOwner: null,
    legacyPoints: 77,
  });

  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();
  const reloaded = await page.evaluate(async () => {
    const { readPreviewUserValue } = await import('/src/static/preview-user-state.mjs');
    const user = JSON.parse(localStorage.getItem('dominion:user') || '{}');
    const identityMap = JSON.parse(localStorage.getItem('dominion:mockUserIdsByIdentity') || '{}');
    const userId = identityMap[String(user.email || '').trim().toLowerCase()] || '';
    return {
      stats: readPreviewUserValue(
        localStorage,
        userId,
        'dominion:gameStats',
        { totalPoints: 0, currentAppStreak: 0 },
      ),
      activationLegacyOwner: localStorage.getItem('dominion:mockChallengeActivationLegacyOwner'),
      previewLegacyOwner: localStorage.getItem('dominion:previewUserStateLegacyOwner'),
    };
  });
  expect(reloaded).toMatchObject({
    stats: { totalPoints: 0, currentAppStreak: 0 },
    activationLegacyOwner: null,
    previewLegacyOwner: null,
  });
});

test('authenticated header clears stale controls and composer state across account changes and actual logout', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const share = page.locator('.shared-header-share');
  await share.click();
  const composer = page.getByRole('dialog', { name: 'Choose what you want to send' });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
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
  });
  const secondUser = {
    name: 'Second Member',
    email: 'second.member@example.test',
    avatarUrl: '',
  };
  const secondUserId = await logInAsPreviewAccount(page, secondUser);
  expect(secondUserId).not.toBe(FIXED_USER_ID);

  await expect(composer).toBeHidden();
  await expect(page.locator('.shared-header-streak-count')).toHaveText('0');
  await expect(page.locator('.shared-header-share')).toHaveCount(1);

  expect(await logInAsPreviewAccount(page, FIXED_USER)).toBe(FIXED_USER_ID);
  await expect(page.locator('.shared-header-streak-count')).toHaveText('2');
  expect(await logInAsPreviewAccount(page, secondUser)).toBe(secondUserId);
  await expect(page.locator('.shared-header-streak-count')).toHaveText('0');

  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Log Out' }).click();
  await expect(page).toHaveURL(/\/index\.html$/);
  await expect(page.locator('.shared-header-share')).toHaveCount(0);
  await expect(page.locator('.shared-header-streak')).toHaveCount(0);
});

test('cross-tab preview account switch clears an owned Dominion Night theme for an unentitled account', async ({ page, context, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'rewardsUnlocked', theme: 'dominion-night' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dominion-night');
  expect(await page.evaluate(() => window.DominionThemeRuntime.isThemeAvailable('dominion-night'))).toBe(true);

  const accountTab = await context.newPage();
  await accountTab.goto('/index.html', { waitUntil: 'domcontentloaded' });
  const secondUserId = await accountTab.evaluate(async () => {
    const api = await import('/src/static/api.js');
    const user = api.saveLocalMockUser({
      name: 'Unentitled Member',
      email: 'unentitled.theme@example.test',
      avatarUrl: '',
      authenticated: true,
    });
    await api.createCheckoutSession('dominion_membership');
    return user.userId;
  });
  expect(secondUserId).not.toBe(FIXED_USER_ID);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => (
    window.DominionThemeRuntime.isThemeAvailable('dominion-night')
  ))).toBe(false);
  await expect(page.locator('.global-menu-member')).toContainText('Unentitled Member');
  await accountTab.close();
  app.assertNoRuntimeErrors();
});

test('preview account switches preserve stable identities and lock stale Dashboard mutations', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const staleControl = page.locator('#checklist [data-standard="bible"]');
  await expect(staleControl).toBeEnabled();
  const entriesBeforeSwitch = await page.evaluate(() => localStorage.getItem('dominion:entries'));

  const secondUser = {
    name: 'Second Member',
    email: 'second.member@example.test',
    avatarUrl: '',
  };
  const secondUserId = await logInAsPreviewAccount(page, secondUser);
  expect(secondUserId).not.toBe(FIXED_USER_ID);
  await expect(staleControl).toBeDisabled();

  await staleControl.evaluate((control) => control.click());
  expect(await page.evaluate(() => localStorage.getItem('dominion:entries'))).toBe(entriesBeforeSwitch);
  expect(await page.evaluate((userId) => {
    const states = JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}');
    return states[userId]?.status;
  }, secondUserId)).toBe('not_started');

  expect(await logInAsPreviewAccount(page, FIXED_USER)).toBe(FIXED_USER_ID);
  await expect(staleControl).toBeEnabled();
  expect(await logInAsPreviewAccount(page, secondUser)).toBe(secondUserId);
});
