import { expect, test } from './support/app-test.mjs';
import { FIXED_USER_ID } from './support/fixtures.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

const TRAINING_ROUTES = Object.freeze([
  ROUTE_BY_ID.dashboard,
  ROUTE_BY_ID.bibleReading,
  ROUTE_BY_ID.morningPrayer,
  ROUTE_BY_ID.worship,
  ROUTE_BY_ID.eveningPrayer,
  ROUTE_BY_ID.workoutOne,
  ROUTE_BY_ID.intentionalWalk,
  ROUTE_BY_ID.workoutTwo,
  ROUTE_BY_ID.badgesRewards,
  ROUTE_BY_ID.community,
  ROUTE_BY_ID.privateJournal,
  ROUTE_BY_ID.profile,
  ROUTE_BY_ID.billing,
  ROUTE_BY_ID.science,
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

async function trainingStorageSnapshot(page) {
  return page.evaluate(() => ({
    progress: localStorage.getItem('dominion:siteTrainingProgress'),
    requests: localStorage.getItem('dominion:siteTrainingRequests'),
  }));
}

async function durableTrainingState(page) {
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

async function storedProgramProgress(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('dominion:siteTrainingProgress') || '{}').programs || {};
    } catch {
      return null;
    }
  });
}

async function installRequestSequence(page) {
  const install = () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        const key = 'dominion:e2e-page-training-request-sequence';
        const sequence = Number(sessionStorage.getItem(key) || 0) + 1;
        sessionStorage.setItem(key, String(sequence));
        return `00000000-0000-4000-8001-${sequence.toString(16).padStart(12, '0')}`;
      },
    });
  };
  await page.addInitScript(install);
  await page.evaluate(install);
}

async function openExistingStateRoute(page, app, route) {
  await page.goto(route.path, { waitUntil: 'networkidle' });
  await app.stable();
  await expect(page.locator(route.ready).first()).toBeVisible();
  await expect(page).toHaveTitle(route.title);
}

async function openMenu(page) {
  const trigger = page.getByRole('button', { name: 'Open menu' });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(page.locator('.global-menu')).toBeVisible();
  return trigger;
}

function durablePageSummary(state) {
  return {
    status: state.page.status,
    currentStepId: state.page.currentStepId,
    currentStepIndex: state.page.currentStepIndex,
    furthestStepIndex: state.page.furthestStepIndex,
    attemptNumber: state.page.attemptNumber,
    revision: state.page.revision,
    completionCount: state.page.completionCount,
    everCompleted: state.page.everCompleted,
    overall: state.overall && {
      status: state.overall.status,
      currentPageId: state.overall.currentPageId,
      currentPageIndex: state.overall.currentPageIndex,
      revision: state.overall.revision,
    },
  };
}

test('every registered page exposes the real Group page-training action without a Solo action', async ({ page, app }) => {
  test.setTimeout(120_000);
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member', theme: 'dark' });

  for (const route of TRAINING_ROUTES) {
    if (route !== ROUTE_BY_ID.dashboard) await openExistingStateRoute(page, app, route);
    await openMenu(page);

    const section = page.locator('.global-menu-training-section');
    const pageAction = page.getByRole('button', { name: 'Start page training', exact: true });
    await expect(section).toBeVisible();
    await expect(pageAction).toBeVisible();
    await expect(page.locator('.global-menu-page-training-restart')).toBeHidden();
    await expect(page.locator('.global-menu-training')).toBeHidden();
    expect((await pageAction.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await page.keyboard.press('Escape');
    await expect(page.locator('.global-menu')).toBeHidden();
  }

  expect(await storedProgramProgress(page)).toEqual({});
  app.assertNoRuntimeErrors();
});

test('Group page training resumes exactly, confirms page-only restart, and replays without writes', async ({ page, app }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member', theme: 'dominion-night' });
  await installRequestSequence(page);
  const productBefore = await productStorageSnapshot(page);

  await openMenu(page);
  const menu = page.locator('.global-menu');
  const start = page.getByRole('button', { name: 'Start page training', exact: true });
  await expect(start).toBeVisible();
  await expect(page.locator('.global-menu-training')).toBeHidden();
  expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await menu.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await menu.evaluate((element) => getComputedStyle(element).transitionDuration))
    .toMatch(/^(?:0s(?:,\s*)?)+$/);
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  await start.click();

  const layer = page.locator('.site-training-layer');
  const progress = page.locator('#siteTrainingProgress');
  const next = page.locator('[data-training-action="next"]');
  const stop = page.locator('[data-training-action="stop"]');
  await expect(layer).toBeVisible();
  await expect(progress).toHaveText('Step 1 of 9');
  await next.click();
  await next.click();
  await expect(progress).toHaveText('Step 3 of 9');
  await stop.click();
  await expect(layer).toBeHidden();
  await expect(page.locator('.global-menu-button')).toBeFocused();

  let durable = await durableTrainingState(page);
  expect(durablePageSummary(durable)).toMatchObject({
    status: 'stopped',
    currentStepIndex: 2,
    furthestStepIndex: 2,
    attemptNumber: 1,
    overall: { status: 'not_started', revision: 0 },
  });
  expect(await storedProgramProgress(page)).toEqual({});

  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();
  await openMenu(page);
  await expect(page.getByRole('button', { name: 'Resume page training', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart page training', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume page training', exact: true }).click();
  await expect(layer).toBeVisible();
  await expect(progress).toHaveText('Step 3 of 9');
  await stop.click();

  const beforeCancellation = durablePageSummary(await durableTrainingState(page));
  await openMenu(page);
  await page.getByRole('button', { name: 'Restart page training', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Restart page training?' });
  const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(cancel).toBeFocused();
  expect((await cancel.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(page.locator('.global-menu-button')).toBeFocused();
  expect(durablePageSummary(await durableTrainingState(page))).toEqual(beforeCancellation);

  await openMenu(page);
  await page.getByRole('button', { name: 'Restart page training', exact: true }).click();
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator('.global-menu-button')).toBeFocused();
  expect(durablePageSummary(await durableTrainingState(page))).toEqual(beforeCancellation);

  await openMenu(page);
  await page.getByRole('button', { name: 'Restart page training', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Restart page training', exact: true }).click();
  await expect(layer).toBeVisible();
  await expect(progress).toHaveText('Step 1 of 9');
  await expect(page.locator('#siteTrainingTitle')).toBeFocused();
  durable = await durableTrainingState(page);
  expect(durablePageSummary(durable)).toMatchObject({
    status: 'in_progress',
    currentStepIndex: 0,
    furthestStepIndex: 0,
    attemptNumber: 2,
    completionCount: 0,
    everCompleted: false,
    overall: { status: 'not_started', revision: 0 },
  });

  const coachmarkBounds = await page.locator('.site-training-coachmark').boundingBox();
  expect(coachmarkBounds?.x).toBeGreaterThanOrEqual(0);
  expect(coachmarkBounds?.y).toBeGreaterThanOrEqual(0);
  expect((coachmarkBounds?.x || 0) + (coachmarkBounds?.width || 0)).toBeLessThanOrEqual(360);
  expect((coachmarkBounds?.y || 0) + (coachmarkBounds?.height || 0)).toBeLessThanOrEqual(800);
  for (let stepIndex = 0; stepIndex < 9; stepIndex += 1) {
    await expect(progress).toHaveText(`Step ${stepIndex + 1} of 9`);
    expect((await next.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await next.click();
  }
  await expect(layer).toBeHidden();
  await expect(page.locator('.global-menu-button')).toBeFocused();

  durable = await durableTrainingState(page);
  expect(durablePageSummary(durable)).toMatchObject({
    status: 'completed',
    currentStepIndex: 8,
    furthestStepIndex: 8,
    attemptNumber: 2,
    completionCount: 1,
    everCompleted: true,
    overall: { status: 'not_started', revision: 0 },
  });
  expect(await storedProgramProgress(page)).toEqual({});

  const trainingBeforeReplay = await trainingStorageSnapshot(page);
  await openMenu(page);
  await expect(page.getByRole('button', { name: 'Replay page training', exact: true })).toBeVisible();
  await expect(page.locator('.global-menu-page-training-restart')).toBeHidden();
  await page.getByRole('button', { name: 'Replay page training', exact: true }).click();
  await expect(layer).toBeVisible();
  await expect(progress).toHaveText('Replay · Step 1 of 9');
  expect(await trainingStorageSnapshot(page)).toEqual(trainingBeforeReplay);
  await stop.click();
  await expect(layer).toBeHidden();
  expect(await trainingStorageSnapshot(page)).toEqual(trainingBeforeReplay);
  expect(await productStorageSnapshot(page)).toEqual(productBefore);
  app.assertNoRuntimeErrors();
});

for (const theme of ['light', 'dark', 'dominion-night']) {
  test(`Solo sees one Training section with separate full-site and page actions in ${theme}`, async ({ page, app }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo', theme });
    await openMenu(page);

    const section = page.locator('.global-menu-training-section');
    const fullSite = page.getByRole('button', { name: 'Start Training', exact: true });
    const pageAction = page.getByRole('button', { name: 'Start page training', exact: true });
    await expect(section).toBeVisible();
    await expect(fullSite).toBeVisible();
    await expect(pageAction).toBeVisible();
    expect(await section.locator('.global-menu-training-section').count()).toBe(0);
    expect(await page.locator('.global-menu-training-section').count()).toBe(1);
    expect(await fullSite.evaluate((element, parent) => parent.contains(element), await section.elementHandle()))
      .toBe(true);
    expect(await pageAction.evaluate((element, parent) => parent.contains(element), await section.elementHandle()))
      .toBe(true);
    expect((await fullSite.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await pageAction.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    app.assertNoRuntimeErrors();
  });
}

test('unactivated users never see page or full-site training controls', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted', theme: 'dark' });
  await openMenu(page);
  await expect(page.locator('.global-menu-training-section')).toBeHidden();
  await expect(page.locator('.global-menu-page-training-primary')).toBeHidden();
  await expect(page.locator('.global-menu-page-training-restart')).toBeHidden();
  await expect(page.locator('.global-menu-training')).toBeHidden();
  app.assertNoRuntimeErrors();
});
