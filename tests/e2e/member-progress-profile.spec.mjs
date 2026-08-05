import {
  expect,
  expectNoHorizontalOverflow,
  expectStableScreenshot,
  test,
} from './support/app-test.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const MICAH_LABEL = 'View Micah Reed’s level and badges';

function rosterProfileButton(page, label = MICAH_LABEL) {
  return page.locator(`.member-progress-trigger[aria-label="${label}"]`);
}

test('crew roster and leaderboard open the same private level and complete badge profile', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);

  const rosterTrigger = rosterProfileButton(page);
  const leaderboardTrigger = page.locator(
    `.leaderboard-member-trigger[aria-label="${MICAH_LABEL}"]`,
  );
  await expect(rosterTrigger).toHaveAccessibleName(MICAH_LABEL);
  await expect(leaderboardTrigger).toHaveAccessibleName(MICAH_LABEL);
  await expect(rosterTrigger).toBeVisible();
  await expect(leaderboardTrigger).toBeVisible();

  await rosterTrigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close member progress' })).toBeFocused();
  await expect(dialog).toContainText('Read-only lifetime level and earned badges');
  await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();
  await expect(dialog.getByText('Level 31', { exact: true })).toBeVisible();
  await expect(dialog.getByText('14', { exact: true })).toHaveCount(2);
  await expect(dialog).not.toContainText('420');
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(12);
  await expect(dialog.locator('.member-progress-badge').first()).toContainText('Day 77 Finisher');
  await expect(dialog.locator('.member-progress-badge').first()).toContainText('gold badge');

  const loadMore = dialog.getByRole('button', { name: 'Load more badges' });
  await loadMore.click();
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(14);
  await expect(dialog.locator('.member-progress-badge').last()).toContainText('Faithful Start');
  await expect(dialog.getByText('14 of 14 badges loaded')).toBeFocused();
  await expect(loadMore).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(rosterTrigger).toBeFocused();

  const micahRow = page.locator('.leaderboard-row').filter({ has: leaderboardTrigger });
  await expect(micahRow.locator('.leaderboard-points')).toContainText('41');
  await page.getByRole('button', { name: 'Challenge', exact: true }).click();
  await expect(micahRow.locator('.leaderboard-points')).toContainText('402');
  await leaderboardTrigger.click();
  await expect(dialog.getByText('Level 31', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(leaderboardTrigger).toBeFocused();

  app.assertNoRuntimeErrors();
});

test('member progress fails closed after membership loss and renders zero and one badge states', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  const rosterTrigger = rosterProfileButton(page);
  const originalMembers = await page.evaluate(() => localStorage.getItem('dominion:mockCrewMembers'));

  await page.evaluate(() => {
    const allMembers = JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}');
    allMembers.crew_e2e_alpha = (allMembers.crew_e2e_alpha || [])
      .filter((member) => member.userId !== 'member_e2e_micah');
    localStorage.setItem('dominion:mockCrewMembers', JSON.stringify(allMembers));
  });
  await rosterTrigger.click();
  let dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog).toContainText('Member progress is no longer available.');
  await expect(dialog).not.toContainText('Micah Reed');

  await page.evaluate((members) => {
    localStorage.setItem('dominion:mockCrewMembers', members);
  }, originalMembers);
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const allMembers = JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}');
    allMembers.crew_e2e_alpha.push(
      {
        crewId: 'crew_e2e_alpha',
        userId: 'preview_member_zero',
        name: 'New Member',
        avatarUrl: '',
        role: 'member',
        joinedAt: '2026-02-13T12:00:00.000Z',
      },
      {
        crewId: 'crew_e2e_alpha',
        userId: 'preview_member_one',
        name: 'One Badge Member',
        avatarUrl: '',
        role: 'member',
        joinedAt: '2026-02-12T12:00:00.000Z',
      },
    );
    localStorage.setItem('dominion:mockCrewMembers', JSON.stringify(allMembers));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();

  await rosterProfileButton(page, 'View New Member’s level and badges').click();
  dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog.getByText('Level 1', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('No badges earned yet');
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await rosterProfileButton(page, 'View One Badge Member’s level and badges').click();
  await expect(dialog.getByText('Level 1', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Earned badge', { exact: true })).toBeVisible();
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(1);
  await expect(dialog.locator('.member-progress-badge')).toContainText('Faithful Start');
  app.assertNoRuntimeErrors();
});

test('foreground revalidation removes a successfully rendered profile after target membership loss', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  await rosterProfileButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(12);

  await page.evaluate(() => {
    const allMembers = JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}');
    allMembers.crew_e2e_alpha = (allMembers.crew_e2e_alpha || [])
      .filter((member) => member.userId !== 'member_e2e_micah');
    localStorage.setItem('dominion:mockCrewMembers', JSON.stringify(allMembers));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(dialog).toContainText('Member progress is no longer available.');
  await expect(dialog).not.toContainText('Micah Reed');
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

test('reconnect denial clears a loaded profile even when the roster refresh fails', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  await rosterProfileButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();

  await page.evaluate(() => {
    const allMembers = JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}');
    allMembers.crew_e2e_alpha = (allMembers.crew_e2e_alpha || [])
      .filter((member) => member.userId !== 'mock_user_e2e_77');
    localStorage.setItem('dominion:mockCrewMembers', JSON.stringify(allMembers));
    window.dispatchEvent(new Event('online'));
  });

  await expect(page.locator('#crewMemberList .inline-error')).toContainText(
    'Crew membership is required to view these members.',
  );
  await expect(dialog).toContainText('Member progress is no longer available.');
  await expect(dialog).not.toContainText('Micah Reed');
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

test('pagehide scrubs private profile DOM before a bfcache restore', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  await rosterProfileButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect(dialog).toBeHidden();
  await expect(page.locator('#member-progress-dialog')).not.toContainText('Micah Reed');

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await rosterProfileButton(page).click();
  await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();
  app.assertNoRuntimeErrors();
});

for (const theme of ['light', 'dark', 'dominion-night']) {
  test(`member progress remains accessible and on-brand at 360px in ${theme}`, async ({ page, app }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await app.open(ROUTE_BY_ID.community, { theme });
    await rosterProfileButton(page).click();

    const dialog = page.getByRole('dialog', { name: 'Member progress' });
    const panelBox = await dialog.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(361);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(801);
    await expectNoHorizontalOverflow(page);

    const closeBox = await dialog.getByRole('button', { name: 'Close member progress' }).boundingBox();
    const loadMoreBox = await dialog.getByRole('button', { name: 'Load more badges' }).boundingBox();
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(loadMoreBox?.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s');

    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    await expectStableScreenshot(page, app, `member-progress-${theme}-mobile.png`, {
      fullPage: false,
    });
    app.assertNoRuntimeErrors();
  });

  test(`member progress dialog remains on-brand on desktop in ${theme}`, async ({ page, app }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await app.open(ROUTE_BY_ID.community, { theme });
    await rosterProfileButton(page).click();

    const dialog = page.getByRole('dialog', { name: 'Member progress' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Micah Reed' })).toBeVisible();
    await expect(dialog.locator('.member-progress-badge')).toHaveCount(12);
    await expectNoHorizontalOverflow(page);

    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    await expectStableScreenshot(page, app, `member-progress-${theme}-desktop.png`, {
      fullPage: false,
    });
    app.assertNoRuntimeErrors();
  });
}
