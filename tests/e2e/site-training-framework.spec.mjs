import { expect, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

async function installFramework(page) {
  await page.evaluate(async () => {
    const [api, registryModule, runtimeModule] = await Promise.all([
      import('/src/static/api.js'),
      import('/src/static/site-training-registry.mjs'),
      import('/src/static/site-training-runtime.mjs'),
    ]);
    const target = document.querySelector('[data-standard-card]');
    target.dataset.trainingTarget = 'dashboard-progress-target';
    const trigger = document.createElement('button');
    trigger.id = 'siteTrainingE2eTrigger';
    trigger.type = 'button';
    trigger.textContent = 'Start page training test';
    document.body.append(trigger);
    const registry = registryModule.defineSiteTrainingRegistry({ pages: [{
      id: 'dashboard-framework',
      route: '/dashboard.html',
      contentVersion: 1,
      title: 'Dashboard framework',
      steps: [
        {
          id: 'progress',
          title: 'Read today’s progress',
          description: 'This lesson points to a stable product target without activating it.',
          target: 'dashboard-progress-target',
          unavailable: { description: 'Today’s progress remains available as an informational lesson.' },
        },
        {
          id: 'finish',
          title: 'Finish safely',
          description: 'Progress is saved before this lesson closes.',
        },
      ],
    }] });
    const user = await api.getLocalOrSessionUser();
    const runtime = runtimeModule.createSiteTrainingRuntime({
      registry,
      pathname: location.pathname,
      expectedUserId: user.userId,
      api,
    });
    await runtime.hydrate();
    window.__siteTrainingE2e = { runtime, target, trigger };
  });
}

test('generic page training is modal, resumable, durable, and replay-safe', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  await installFramework(page);
  await expect(page.locator('.site-training-layer')).toBeHidden();

  await page.evaluate(() => window.__siteTrainingE2e.runtime.start({
    trigger: window.__siteTrainingE2e.trigger,
  }));
  const layer = page.locator('.site-training-layer');
  await expect(layer).toBeVisible();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Step 1 of 2');
  await expect(page.locator('#siteTrainingTitle')).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-training-target="dashboard-progress-target"]')).toHaveClass(/site-training-target/);
  expect(await page.locator('[data-training-target="dashboard-progress-target"]').evaluate(
    (element) => getComputedStyle(element).pointerEvents,
  )).toBe('none');
  for (const action of ['back', 'stop', 'next']) {
    const button = page.locator(`[data-training-action="${action}"]`);
    if (await button.isVisible()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));

  await page.locator('[data-training-action="next"]').click();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Step 2 of 2');
  await page.locator('[data-training-action="back"]').click();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Step 1 of 2');
  await page.locator('[data-training-action="stop"]').click();
  await expect(layer).toBeHidden();
  await expect(page.locator('#siteTrainingE2eTrigger')).toBeFocused();
  expect(await page.evaluate(() => window.__siteTrainingE2e.runtime.state.page)).toMatchObject({
    status: 'stopped',
    currentStepId: 'progress',
    furthestStepIndex: 1,
    revision: 4,
  });

  await page.evaluate(() => window.__siteTrainingE2e.runtime.resume({
    trigger: window.__siteTrainingE2e.trigger,
  }));
  await page.locator('[data-training-action="next"]').click();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Step 2 of 2');
  await page.locator('[data-training-action="next"]').click();
  await expect(layer).toBeHidden();
  expect(await page.evaluate(() => window.__siteTrainingE2e.runtime.state.page)).toMatchObject({
    status: 'completed',
    everCompleted: true,
    completionCount: 1,
    revision: 7,
  });

  const durableBeforeReplay = await page.evaluate(() => localStorage.getItem('dominion:previewUserStateByOwner'));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => {
    window.__siteTrainingE2e.target.removeAttribute('data-training-target');
    window.__siteTrainingE2e.runtime.replay({ trigger: window.__siteTrainingE2e.trigger });
  });
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Replay · Step 1 of 2');
  await expect(page.locator('#siteTrainingFallback')).toBeVisible();
  const mobileBounds = await page.locator('.site-training-coachmark').boundingBox();
  expect(mobileBounds?.x).toBeGreaterThanOrEqual(0);
  expect((mobileBounds?.x || 0) + (mobileBounds?.width || 0)).toBeLessThanOrEqual(360);
  expect((mobileBounds?.y || 0) + (mobileBounds?.height || 0)).toBeLessThanOrEqual(800);
  for (const action of ['stop', 'next']) {
    expect((await page.locator(`[data-training-action="${action}"]`).boundingBox())?.height)
      .toBeGreaterThanOrEqual(44);
  }
  await page.locator('[data-training-action="next"]').click();
  await page.locator('[data-training-action="next"]').click();
  await expect(layer).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('dominion:previewUserStateByOwner'))).toBe(durableBeforeReplay);
  app.assertNoRuntimeErrors();
});

test('preview parity keeps page scope independent and advances an ordered overall program', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  const result = await page.evaluate(async () => {
    const [api, registryModule, stateModule] = await Promise.all([
      import('/src/static/api.js'),
      import('/src/static/site-training-registry.mjs'),
      import('/src/static/site-training-state.mjs'),
    ]);
    const registry = registryModule.defineSiteTrainingRegistry({
      pages: [
        {
          id: 'first-page', route: '/dashboard.html', contentVersion: 1, title: 'First page',
          steps: [{ id: 'first-step', title: 'First', description: 'First lesson.' }],
        },
        {
          id: 'second-page', route: '/profile.html', contentVersion: 1, title: 'Second page',
          steps: [{ id: 'second-step', title: 'Second', description: 'Second lesson.' }],
        },
      ],
      programs: [{
        id: 'ordered-site', version: 1, title: 'Ordered site',
        pages: [
          { pageId: 'first-page', contentVersion: 1 },
          { pageId: 'second-page', contentVersion: 1 },
        ],
      }],
    });
    const [firstPage, secondPage] = registry.pages;
    const [program] = registry.programs;
    const actorId = (await api.getLocalOrSessionUser()).userId;
    const request = () => stateModule.newSiteTrainingRequestId();

    const initial = await api.getSiteTrainingState({ page: firstPage, program, expectedUserId: actorId });
    const pageOnly = await api.claimSiteTraining({
      page: firstPage,
      scope: 'page',
      action: 'start',
      requestId: request(),
      expectedRevision: initial.page.revision,
      expectedUserId: actorId,
    });
    const afterPageOnly = await api.getSiteTrainingState({ page: firstPage, program, expectedUserId: actorId });
    const startRequestId = request();
    const started = await api.claimSiteTraining({
      page: firstPage,
      program,
      scope: 'overall',
      action: 'start',
      requestId: startRequestId,
      expectedRevision: afterPageOnly.overall.revision,
      expectedUserId: actorId,
    });
    const replay = await api.claimSiteTraining({
      page: firstPage,
      program,
      scope: 'overall',
      action: 'start',
      requestId: startRequestId,
      expectedRevision: afterPageOnly.overall.revision,
      expectedUserId: actorId,
    });
    let staleCode = '';
    try {
      await api.transitionSiteTraining({
        page: firstPage,
        program,
        scope: 'overall',
        action: 'finish',
        requestId: request(),
        expectedRevision: 0,
        expectedUserId: actorId,
      });
    } catch (error) {
      staleCode = `${error.code}:${error.details}`;
    }
    const advanced = await api.transitionSiteTraining({
      page: firstPage,
      program,
      scope: 'overall',
      action: 'finish',
      requestId: request(),
      expectedRevision: started.overall.revision,
      expectedUserId: actorId,
    });
    const secondStarted = await api.claimSiteTraining({
      page: secondPage,
      program,
      scope: 'overall',
      action: 'start',
      requestId: request(),
      expectedRevision: advanced.overall.revision,
      expectedUserId: actorId,
    });
    const completed = await api.transitionSiteTraining({
      page: secondPage,
      program,
      scope: 'overall',
      action: 'finish',
      requestId: request(),
      expectedRevision: secondStarted.overall.revision,
      expectedUserId: actorId,
    });
    return {
      initialOverall: initial.overall,
      pageOnlyOverall: pageOnly.overall,
      afterPageOnlyOverall: afterPageOnly.overall,
      replayRevision: replay.overall.revision,
      staleCode,
      advancedPage: advanced.page,
      advancedOverall: advanced.overall,
      advancedTransition: advanced.transition,
      completedOverall: completed.overall,
    };
  });

  expect(result.initialOverall).toMatchObject({ status: 'not_started', revision: 0 });
  expect(result.pageOnlyOverall).toBeNull();
  expect(result.afterPageOnlyOverall).toMatchObject({ status: 'not_started', revision: 0 });
  expect(result.replayRevision).toBe(1);
  expect(result.staleCode).toBe('40001:site_training_stale_revision');
  expect(result.advancedPage).toMatchObject({ pageId: 'second-page', status: 'not_started' });
  expect(result.advancedOverall).toMatchObject({ currentPageId: 'second-page', currentPageIndex: 1 });
  expect(result.advancedTransition).toMatchObject({
    completedPageId: 'first-page',
    nextRoute: '/profile.html',
  });
  expect(result.completedOverall).toMatchObject({
    status: 'completed',
    currentPageId: 'second-page',
    currentPageIndex: 1,
  });
  app.assertNoRuntimeErrors();
});
