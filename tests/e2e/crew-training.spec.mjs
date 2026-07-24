import { expect, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

async function createCrew(page, app, name = 'North Star Crew') {
  await app.open(ROUTE_BY_ID.community, { state: 'communityEmpty' });
  await page.getByRole('button', { name: 'Create a Crew', exact: true }).click();
  await page.getByLabel('Crew name').fill(name);
  await page.getByLabel('Challenge start date').fill('2026-02-14');
  await page.getByLabel('Description').fill('A deterministic crew training fixture.');
  await page.getByRole('button', { name: 'Create Crew', exact: true }).click();
  await expect(page.locator('#crewTrainingLayer')).toBeVisible();
  await expect(page.locator('#crewTrainingTitle')).toHaveText(`${name} is ready`);
}

async function trainingRows(page) {
  return page.evaluate(() => Object.values(
    JSON.parse(localStorage.getItem('dominion:crewTraining') || '{}'),
  ));
}

async function sensitiveCrewState(page) {
  return page.evaluate(() => ({
    invites: localStorage.getItem('dominion:mockCrewInvites'),
    consent: localStorage.getItem('dominion:mockOutboundConsent'),
    crews: localStorage.getItem('dominion:mockCrews'),
    members: localStorage.getItem('dominion:mockCrewMembers'),
  }));
}

test('creator training claims once after create and never auto-opens on refresh', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityEmpty' });
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  expect(await trainingRows(page)).toEqual([]);

  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  expect(await trainingRows(page)).toEqual([]);

  await page.getByRole('button', { name: 'Create a Crew', exact: true }).click();
  await page.getByLabel('Crew name').fill('Once Only Crew');
  await page.getByLabel('Challenge start date').fill('2026-02-14');
  await page.getByRole('button', { name: 'Create Crew', exact: true }).click();

  const layer = page.locator('#crewTrainingLayer');
  await expect(layer).toBeVisible();
  await expect(page.locator('#crewTrainingProgress')).toHaveText('Step 1 of 7');
  await expect(page.locator('#crewTrainingTitle')).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  expect(await trainingRows(page)).toMatchObject([{
    status: 'in_progress',
    currentStep: 0,
    furthestStep: 0,
    contentVersion: 1,
  }]);

  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);

  await page.keyboard.press('Escape');
  await expect(layer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Resume Crew Training' })).toBeFocused();

  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();
  await expect(layer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Resume Crew Training' })).toBeVisible();
  expect((await trainingRows(page)).length).toBe(1);
});

test('back, close, skip, resume, finish, and replay preserve non-training state', async ({ page, app }) => {
  await createCrew(page, app);
  const sensitiveBefore = await sensitiveCrewState(page);

  await page.locator('#crewTrainingNext').click();
  await expect(page.locator('#crewTrainingProgress')).toHaveText('Step 2 of 7');
  await expect(page.locator('#crewTrainingTitle')).toBeFocused();
  await expect(page.locator('#copyInviteButton')).toHaveClass(/crew-training-target/);
  await expect(page.locator('#crewTrainingCoachmark')).not.toHaveAttribute('aria-modal');
  const placement = await page.evaluate(() => {
    const target = document.querySelector('#copyInviteButton').getBoundingClientRect();
    const coachmark = document.querySelector('#crewTrainingCoachmark').getBoundingClientRect();
    return {
      separated: coachmark.bottom <= target.top || coachmark.top >= target.bottom,
      onscreen: coachmark.left >= 0
        && coachmark.top >= 0
        && coachmark.right <= innerWidth
        && coachmark.bottom <= innerHeight,
    };
  });
  expect(placement).toEqual({ separated: true, onscreen: true });
  assertNoBlockingAxeViolations(await analyzeAccessibility(page));
  expect(await trainingRows(page)).toMatchObject([{ currentStep: 1, furthestStep: 1 }]);

  await page.locator('#crewTrainingBack').click();
  await expect(page.locator('#crewTrainingProgress')).toHaveText('Step 1 of 7');
  expect(await trainingRows(page)).toMatchObject([{ currentStep: 1, furthestStep: 1 }]);
  await page.locator('#crewTrainingNext').click();
  await page.locator('#crewTrainingClose').click();
  await expect(page.getByRole('button', { name: 'Resume Crew Training' })).toBeVisible();

  await page.getByRole('button', { name: 'Resume Crew Training' }).click();
  await expect(page.locator('#crewTrainingProgress')).toHaveText('Step 2 of 7');
  await page.locator('#crewTrainingSkip').click();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Resume Crew Training' })).toBeFocused();
  expect(await trainingRows(page)).toMatchObject([{ status: 'skipped', currentStep: 1 }]);

  await page.getByRole('button', { name: 'Resume Crew Training' }).click();
  expect(await trainingRows(page)).toMatchObject([{ status: 'in_progress', currentStep: 1 }]);
  for (let expectedStep = 3; expectedStep <= 7; expectedStep += 1) {
    await page.locator('#crewTrainingNext').click();
    await expect(page.locator('#crewTrainingProgress')).toHaveText(`Step ${expectedStep} of 7`);
  }
  await expect(page.locator('#crewLifecycleCard')).toHaveClass(/crew-training-target/);
  await expect(page.locator('#crewTrainingTitle')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Delete Crew' })).not.toBeFocused();
  await page.locator('#crewTrainingNext').click();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Replay Crew Training' })).toBeVisible();
  expect(await trainingRows(page)).toMatchObject([{
    status: 'completed',
    currentStep: 6,
    furthestStep: 6,
  }]);
  expect(await sensitiveCrewState(page)).toEqual(sensitiveBefore);

  const completedProgress = await page.evaluate(() => localStorage.getItem('dominion:crewTraining'));
  await page.getByRole('button', { name: 'Replay Crew Training' }).click();
  await expect(page.locator('#crewTrainingProgress')).toHaveText('Replay · Step 1 of 7');
  await expect(page.locator('#crewTrainingSkip')).toBeHidden();
  for (let expectedStep = 2; expectedStep <= 7; expectedStep += 1) {
    await page.locator('#crewTrainingNext').click();
    await expect(page.locator('#crewTrainingProgress')).toHaveText(`Replay · Step ${expectedStep} of 7`);
  }
  await page.locator('#crewTrainingNext').click();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('dominion:crewTraining'))).toBe(completedProgress);
  expect(await sensitiveCrewState(page)).toEqual(sensitiveBefore);

  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Replay Crew Training' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('dominion:crewTraining'))).toBe(completedProgress);
});

test('joined non-admin members never receive creator training', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community, { state: 'communityMember' });
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  await expect(page.locator('#crewTrainingButton')).toBeHidden();
  expect(await trainingRows(page)).toEqual([]);
});

test('activating a highlighted control closes training before its action continues', async ({ page, app }) => {
  await createCrew(page, app, 'Actionable Target Crew');
  await page.locator('#crewTrainingNext').click();
  await expect(page.locator('#copyInviteButton')).toHaveClass(/crew-training-target/);
  await page.locator('#copyInviteButton').click();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
});

test('contextual coachmarks remain onscreen on mobile', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createCrew(page, app, 'Mobile Crew');
  await page.locator('#crewTrainingNext').click();
  await expect(page.locator('#crewTrainingProgress')).toHaveText('Step 2 of 7');
  const bounds = await page.locator('#crewTrainingCoachmark').boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(390);
  expect((bounds?.y || 0) + (bounds?.height || 0)).toBeLessThanOrEqual(844);
  for (const id of ['crewTrainingClose', 'crewTrainingBack', 'crewTrainingSkip', 'crewTrainingNext']) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('tab', { name: 'Private Journal' }).click();
  await expect(page.locator('#crewTrainingLayer')).toBeHidden();
  await expect(page.locator('#journey')).toBeVisible();
});
