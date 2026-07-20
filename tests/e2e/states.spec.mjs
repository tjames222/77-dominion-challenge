import {
  expect,
  expectStableScreenshot,
  test,
} from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import {
  deferApiModule,
  injectApiFunctionFailure,
} from './support/network-states.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

test('billing loading state is stable and reviewable', async ({ page, app }) => {
  await app.seed('memberLocked');
  const deferred = deferApiModule(page);
  await page.goto(ROUTE_BY_ID.billing.path, { waitUntil: 'commit' });
  await deferred.intercepted;

  try {
    await expect(page.locator('#billingStatusTitle')).toHaveText('Checking your access...');
    await expect(page).toHaveScreenshot('state-billing-loading.png', {
      fullPage: true,
      stylePath: app.screenshotStyle,
    });
  } finally {
    deferred.release();
  }

  await page.waitForLoadState('networkidle');
  await expect(page.locator('#billingStatusTitle')).toHaveText('Preview membership checkout.');
});

test('billing API error state is user-facing and accessible', async ({ page, app }) => {
  await injectApiFunctionFailure(page, 'getBillingState', 'Deterministic billing fixture failure.');
  await app.open(ROUTE_BY_ID.billing, { state: 'member' });
  await expect(page.locator('#billingStatusTitle')).toHaveText('Billing is temporarily unavailable.');
  await expectStableScreenshot(page, app, 'state-billing-error.png');

  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});

test('community empty state is stable and accessible', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityEmpty' });
  await expect(page.locator('#crewCreateCard')).toBeVisible();
  await expect(page.locator('#crewManageCard')).toBeHidden();
  await expectStableScreenshot(page, app, 'state-community-empty.png');

  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});

test('locked challenge progression has a deterministic visual contract', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'rewardsLocked' });
  await page.locator('#challengeVaultToggle').click();
  await expect(page.locator('#challengeVaultDetails')).toBeVisible();
  await expect(page.locator('#challengeCatalog')).toContainText('1,000 points');
  await expectStableScreenshot(page, app, 'state-rewards-locked.png');
});

test('unlocked challenge progression has a deterministic visual contract', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'rewardsUnlocked' });
  await page.locator('#challengeVaultToggle').click();
  await expect(page.locator('#challengeVaultDetails')).toBeVisible();
  await expect(page.locator('#challengeCatalog')).toContainText('7-Day Reset');
  await expect(page.locator('#challengeCatalog')).toContainText('Ready');
  await expectStableScreenshot(page, app, 'state-rewards-unlocked.png');
});

test('submitted check-in state locks controls and remains accessible', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'submitted' });
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await expect(page.locator('#checkInButton')).toHaveText('Check-In Posted');
  await expectStableScreenshot(page, app, 'state-check-in-submitted.png');

  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});

test('open global navigation has a deterministic visual contract', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();
  await expectStableScreenshot(page, app, 'state-global-navigation-open.png');
});

test('profile validation error is visible, announced, and stable', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  await page.locator('#profilePhotoInput').setInputFiles({
    name: 'not-an-image.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('deterministic invalid file'),
  });
  await expect(page.locator('#profileFeedback')).toHaveText('Profile picture must be an image file.');
  await expectStableScreenshot(page, app, 'state-profile-error.png');

  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});
