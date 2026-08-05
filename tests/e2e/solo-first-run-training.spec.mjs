import { expect, test } from './support/app-test.mjs';
import { FIXED_USER_ID } from './support/fixtures.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const SOLO_PAGES = Object.freeze([
  { path: '/dashboard.html', steps: 9 },
  { path: '/bible-reading.html', steps: 4 },
  { path: '/morning-prayer.html', steps: 4 },
  { path: '/worship.html', steps: 4 },
  { path: '/evening-prayer.html', steps: 4 },
  { path: '/workout-one.html', steps: 5 },
  { path: '/intentional-walk.html', steps: 4 },
  { path: '/workout-two.html', steps: 5 },
  { path: '/badges-rewards.html', steps: 6 },
  { path: '/community.html', steps: 7 },
  { path: '/profile.html', steps: 6 },
  { path: '/billing.html', steps: 4 },
  { path: '/science.html', steps: 6 },
]);

const PRODUCT_STORAGE_KEYS = Object.freeze([
  'dominion:user',
  'dominion:startDate',
  'dominion:entries',
  'dominion:checkInDates',
  'dominion:workoutDifficulty',
  'dominion:gameStats',
  'dominion:badges',
  'dominion:mockChallengeStates',
  'dominion:mockChallengeThresholdsVersion',
  'dominion:mockRewardEntitlements',
  'dominion:feed',
  'dominion:mockCrews',
  'dominion:mockCrewMembers',
  'dominion:mockCrewInvites',
  'dominion:mockJournalEntries',
  'dominion:activeCrewId',
  'dominion:mockSubscription',
  'dominion:mockChallengeActivation',
  'dominion:mockOutboundConsent',
  'dominion:mockSharingReward',
  'dominion:theme',
  'dominion:mockThemePreferences',
]);

async function productStorageSnapshot(page) {
  return page.evaluate((keys) => Object.fromEntries(
    keys.map((key) => [key, localStorage.getItem(key)]),
  ), PRODUCT_STORAGE_KEYS);
}

async function durableSoloTrainingState(page) {
  return page.evaluate(async (expectedUserId) => {
    const [api, registryModule] = await Promise.all([
      import('/src/static/api.js'),
      import('/src/static/site-training-registry.mjs'),
    ]);
    const trainingPage = registryModule.siteTrainingPageForRoute(
      registryModule.SITE_TRAINING_REGISTRY,
      location.pathname,
    );
    const program = registryModule.siteTrainingProgramForPage(
      registryModule.SITE_TRAINING_REGISTRY,
      trainingPage,
    );
    return api.getSiteTrainingState({ page: trainingPage, program, expectedUserId });
  }, FIXED_USER_ID);
}

async function installCrossRouteRequestIds(page) {
  const install = () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        const key = 'dominion:e2e-site-training-request-sequence';
        const sequence = Number(sessionStorage.getItem(key) || 0) + 1;
        sessionStorage.setItem(key, String(sequence));
        return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
      },
    });
  };
  await page.addInitScript(install);
  await page.evaluate(install);
}

test('Solo first-run training completes all 13 routes without performing product actions', async ({ page, app }) => {
  test.setTimeout(120_000);
  await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo', theme: 'dominion-night' });
  await installCrossRouteRequestIds(page);
  const productBefore = await productStorageSnapshot(page);

  await page.getByRole('button', { name: 'Open menu' }).click();
  const startTraining = page.getByRole('button', { name: 'Start Training' });
  await expect(startTraining).toBeVisible();
  await startTraining.click();

  const layer = page.locator('.site-training-layer');
  const progress = page.locator('#siteTrainingProgress');
  const advance = page.locator('[data-training-action="next"]');
  await expect(layer).toBeVisible();

  for (let pageIndex = 0; pageIndex < SOLO_PAGES.length; pageIndex += 1) {
    const lesson = SOLO_PAGES[pageIndex];
    await expect(page).toHaveURL(new RegExp(`${lesson.path.replace('.', '\\.')}$`));
    await expect(layer).toBeVisible();
    await expect(progress).toHaveText(
      `Page ${pageIndex + 1} of ${SOLO_PAGES.length} · Step 1 of ${lesson.steps}`,
    );

    if (pageIndex === 1) {
      await page.locator('[data-training-action="stop"]').click();
      await expect(layer).toBeHidden();
      await expect(page.locator('.global-menu-button')).toBeFocused();

      await page.reload({ waitUntil: 'networkidle' });
      await expect(layer).toBeHidden();
      await page.getByRole('button', { name: 'Open menu' }).click();
      const resumeTraining = page.getByRole('button', { name: 'Resume Training' });
      await expect(resumeTraining).toBeVisible();
      await resumeTraining.click();
      await expect(layer).toBeVisible();
      await expect(progress).toHaveText(
        `Page ${pageIndex + 1} of ${SOLO_PAGES.length} · Step 1 of ${lesson.steps}`,
      );
    }

    for (let stepIndex = 0; stepIndex < lesson.steps; stepIndex += 1) {
      await expect(advance).toHaveText(stepIndex === lesson.steps - 1 ? 'Finish' : 'Next');
      await advance.click();

      if (stepIndex < lesson.steps - 1) {
        await expect(progress).toHaveText(
          `Page ${pageIndex + 1} of ${SOLO_PAGES.length} · Step ${stepIndex + 2} of ${lesson.steps}`,
        );
        if (pageIndex === 9 && stepIndex === 2) {
          await expect(page.locator('#siteTrainingTitle')).toHaveText('Roster controls appear with a crew');
          await expect(page.locator('#siteTrainingFallback')).toBeVisible();
        }
        if (pageIndex === 9 && stepIndex === 4) {
          await expect(page.locator('#siteTrainingTitle')).toHaveText('Group integrations are informational here');
          await expect(page.locator('#siteTrainingFallback')).toBeVisible();
        }
        continue;
      }

      const nextLesson = SOLO_PAGES[pageIndex + 1];
      if (nextLesson) {
        await expect(page).toHaveURL(new RegExp(`${nextLesson.path.replace('.', '\\.')}$`));
        await expect(layer).toBeVisible();
        await expect(progress).toHaveText(
          `Page ${pageIndex + 2} of ${SOLO_PAGES.length} · Step 1 of ${nextLesson.steps}`,
        );
      }
    }
  }

  await expect(page).toHaveURL(/\/science\.html$/);
  await expect(layer).toBeHidden();
  await expect(page.locator('.global-menu-button')).toBeFocused();
  await expect(page.locator('.shared-header-action')).toHaveCount(0);

  const completed = await durableSoloTrainingState(page);
  expect(completed).toMatchObject({
    contractValid: true,
    actorId: FIXED_USER_ID,
    page: {
      pageId: 'science',
      status: 'completed',
      currentStepId: 'training-complete',
      everCompleted: true,
      completionCount: 1,
    },
    overall: {
      programId: 'solo-first-run',
      programVersion: 1,
      status: 'completed',
      currentPageId: 'science',
      currentPageIndex: 12,
    },
  });
  await expect(page).toHaveURL(/\/science\.html$/);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('.global-menu-training')).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('dominion:soloTrainingControlRequests')))
    .toBeNull();
  expect(await productStorageSnapshot(page)).toEqual(productBefore);
  app.assertNoRuntimeErrors();
});
