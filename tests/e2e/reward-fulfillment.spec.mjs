import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import {
  deferApiFunction,
  injectApiFunctionFailure,
} from './support/network-states.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

const FULFILLMENT_STORAGE_KEY = 'dominion:mockRewardFulfillments';

async function openRewardsWithFulfillment(page, app, fulfillments, { points = 1_200 } = {}) {
  await app.seed('rewardsUnlocked');
  await page.addInitScript(({ fixtureKey, fixtureValue, totalPoints }) => {
    localStorage.setItem(fixtureKey, JSON.stringify(fixtureValue));
    const stats = JSON.parse(localStorage.getItem('dominion:gameStats') || '{}');
    localStorage.setItem('dominion:gameStats', JSON.stringify({
      ...stats,
      totalPoints,
      challengePoints: totalPoints,
      dailyStandardsPoints: totalPoints,
    }));
    if (totalPoints < 21) {
      localStorage.setItem('dominion:mockRewardEntitlements', '[]');
      localStorage.setItem('dominion:mockChallengeThresholdsVersion', '4');
    }
  }, {
    fixtureKey: FULFILLMENT_STORAGE_KEY,
    fixtureValue: fulfillments,
    totalPoints: points,
  });
  await page.goto(ROUTE_BY_ID.badgesRewards.path, { waitUntil: 'networkidle' });
  await app.stable();
  await expect(page.locator(ROUTE_BY_ID.badgesRewards.ready).first()).toBeVisible();
}

const gymOffer = {
  read: {
    availability: 'available',
    status: 'unclaimed',
    partnerName: 'Test Training Club',
    offerTitle: 'One month of training for less',
    description: 'A deterministic browser-only offer.',
    terms: 'One use per member.',
    expiration: 'December 31, 2026',
    websiteUrl: 'https://gym.example.test/',
  },
  claim: {
    availability: 'available',
    status: 'claimed',
    partnerName: 'Test Training Club',
    offerTitle: 'One month of training for less',
    description: 'A deterministic browser-only offer.',
    terms: 'One use per member.',
    expiration: 'December 31, 2026',
    websiteUrl: 'https://gym.example.test/',
    destinationUrl: 'https://gym.example.test/redeem',
    code: 'DOMINION-TEST-21',
  },
};

test('locked gym reward shows exact progress and a safe configured partner link', async ({ page, app }) => {
  await openRewardsWithFulfillment(page, app, {
    gym_training_discount: gymOffer,
  }, { points: 20 });

  const card = page.locator('[data-reward-key="gym_training_discount"]');
  await expect(card).toContainText('Locked');
  await card.click();

  const dialog = page.getByRole('dialog', { name: 'Gym Training Discount' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  await expect(dialog).toContainText('1 point remaining');
  await expect(dialog).toContainText('Test Training Club');
  await expect(dialog.getByRole('link', { name: 'Visit gym website' })).toHaveAttribute(
    'href',
    'https://gym.example.test/',
  );
  await expect(dialog.getByRole('button', { name: 'Claim discount' })).toHaveCount(0);

  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  app.assertNoRuntimeErrors();
});

test('eligible gym reward claims once, reveals a code, copies it, and exposes only safe links', async ({
  context,
  page,
  app,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openRewardsWithFulfillment(page, app, {
    gym_training_discount: gymOffer,
  });

  await page.locator('[data-reward-key="gym_training_discount"]').click();
  const dialog = page.getByRole('dialog', { name: 'Gym Training Discount' });
  const claim = dialog.getByRole('button', { name: 'Claim discount' });
  await expect(claim).toBeVisible();
  await claim.click();

  await expect(dialog.locator('#rewardDetailCode')).toHaveText('DOMINION-TEST-21');
  await expect(dialog.getByRole('link', { name: 'Redeem offer' })).toHaveAttribute(
    'href',
    'https://gym.example.test/redeem',
  );
  await dialog.getByRole('button', { name: 'Copy code' }).click();
  await expect(dialog.locator('#rewardDetailFeedback')).toHaveText('Discount code copied.');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('DOMINION-TEST-21');
  app.assertNoRuntimeErrors();
});

test('expired, exhausted, and unavailable fulfillment states fail closed without an action', async ({ page, app }) => {
  const cases = [
    ['gym_training_discount', 'expired', 'This gym offer has expired.'],
    ['big_god_energy_tshirt_discount', 'exhausted', 'The current shirt offer has no codes left.'],
    ['nehemiah_leadership_handbook', 'unavailable', 'The approved handbook edition is being finalized.'],
  ];
  const fixtures = Object.fromEntries(cases.map(([key, availability, message]) => [key, {
    read: { availability, status: 'unavailable', message },
  }]));
  await openRewardsWithFulfillment(page, app, fixtures);

  for (const [key, , message] of cases) {
    const card = page.locator(`[data-reward-key="${key}"]`);
    await card.click();
    const dialog = page.locator('#rewardDetailDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(message);
    await expect(dialog.locator('[data-claim-reward-offer], [data-download-reward]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close reward details' }).click();
  }

  app.assertNoRuntimeErrors();
});

test('reward details expose an explicit loading state before secure data resolves', async ({ page, app }) => {
  const deferred = deferApiFunction(page, 'getRewardFulfillment');
  await openRewardsWithFulfillment(page, app, {
    gym_training_discount: gymOffer,
  });

  await page.locator('[data-reward-key="gym_training_discount"]').click({ noWaitAfter: true });
  await deferred.intercepted;
  const dialog = page.getByRole('dialog', { name: 'Gym Training Discount' });
  await expect(dialog.locator('#rewardDetailContent')).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.locator('#rewardDetailFeedback')).toHaveText('Loading secure reward details…');

  await deferred.release();
  await expect(dialog.locator('#rewardDetailContent')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog).toContainText('Test Training Club');
  app.assertNoRuntimeErrors();
});

test('a reward-detail failure is announced and leaves fulfillment actions unavailable', async ({ page, app }) => {
  await injectApiFunctionFailure(page, 'getRewardFulfillment', 'The secure reward service is temporarily unavailable.');
  await openRewardsWithFulfillment(page, app, {
    gym_training_discount: gymOffer,
  });

  await page.locator('[data-reward-key="gym_training_discount"]').click();
  const dialog = page.getByRole('dialog', { name: 'Gym Training Discount' });
  await expect(dialog.locator('#rewardDetailFeedback')).toHaveText(
    'The secure reward service is temporarily unavailable.',
  );
  await expect(dialog.locator('[data-claim-reward-offer], [data-copy-reward-code]')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

test('an approved handbook response downloads verified PDF fixture bytes', async ({ page, app }) => {
  await openRewardsWithFulfillment(page, app, {
    nehemiah_leadership_handbook: {
      read: {
        availability: 'available',
        status: 'claimed',
        edition: 'Release candidate',
        format: 'PDF',
        downloadFilename: 'Nehemiah-Leadership-Handbook-RC.pdf',
      },
      download: {
        availability: 'available',
        status: 'claimed',
        downloadFilename: 'Nehemiah-Leadership-Handbook-RC.pdf',
        pdfFixture: '%PDF-1.7\n% deterministic browser fixture\n%%EOF',
      },
    },
  });

  await page.locator('[data-reward-key="nehemiah_leadership_handbook"]').click();
  const dialog = page.getByRole('dialog', { name: 'Nehemiah Leadership Handbook' });
  await expect(dialog).toContainText('Release candidate');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download handbook' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Nehemiah-Leadership-Handbook-RC.pdf');
  await expect(dialog.locator('#rewardDetailFeedback')).toHaveText('Your download is ready.');
  app.assertNoRuntimeErrors();
});

