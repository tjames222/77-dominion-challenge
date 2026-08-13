import {
  expect,
  expectNoHorizontalOverflow,
  test,
} from './support/app-test.mjs';
import { FIXED_TODAY, FIXED_USER_ID } from './support/fixtures.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const TRAINING_STORAGE_KEY = 'dominion:soloTrainingLaunchRequests';
const ACTIVATION_STORAGE_KEY = 'dominion:mockChallengeActivation';
const REQUEST_STORAGE_KEY = 'dominion:mockChallengeActivationRequests';

async function openStartDialog(page) {
  await page.getByRole('button', { name: 'Start Challenge' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Challenge' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function reviewSoloStart(page, startDate) {
  const dialog = await openStartDialog(page);
  await dialog.getByRole('radio', { name: /^Solo/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByLabel('Challenge start date').fill(startDate);
  await dialog.getByRole('button', { name: 'Review start' }).click();
  await expect(dialog.getByRole('heading', { name: 'Confirm your challenge' })).toBeVisible();
  return dialog;
}

test('not-started Dashboard is a readable, zero-progress fail-closed gate', async ({ page, context, app }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted', theme: 'dominion-night' });

  const gate = page.locator('#challengeStartGate');
  const start = page.getByRole('button', { name: 'Start Challenge' });
  const toggles = page.locator('.check-row-toggle');
  const details = page.locator('.check-row-details');
  const difficulty = page.locator('[data-workout]').first();
  await expect(gate).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(page.locator('#challengePercent')).toHaveText('0%');
  await expect(page.locator('#challengeDay')).toHaveText('Not started');
  await expect(page.locator('#todayPercent')).toHaveText('0%');
  await expect(page.locator('#todayCount')).toHaveText('0 of 7 done');
  await expect(page.locator('#scorecardSelectionStatus')).toHaveText('0 of 7 complete');
  await expect(toggles).toHaveCount(7);
  await expect(toggles.first()).toBeDisabled();
  await expect(page.locator('.check-row.checked')).toHaveCount(0);
  await expect(details).toHaveCount(7);
  await expect(details.first()).not.toHaveAttribute('href');
  await expect(details.first()).toHaveAttribute('aria-disabled', 'true');
  await expect(details.first()).toHaveAttribute('tabindex', '-1');
  await expect(difficulty).toBeDisabled();
  await expect(difficulty).toHaveValue('');
  await expect(page.locator('#countdownCheckInButton')).toBeDisabled();
  await expect(page.locator('#selectAllActionsButton')).toBeDisabled();
  await expect(page.locator('#checkInButton')).toBeDisabled();

  const unavailableShare = page.getByRole('button', {
    name: 'Share progress unavailable until your challenge starts.',
  });
  await expect(unavailableShare).toBeDisabled();
  await expect(page.getByRole('button', { name: /App streak:/i })).toBeEnabled();

  await toggles.first().evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  await difficulty.evaluate((select) => {
    select.disabled = false;
    select.value = 'extreme';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await details.first().evaluate((link) => {
    link.setAttribute('href', './bible-reading.html');
    link.setAttribute('tabindex', '0');
    link.click();
  });
  const pageCountBeforeNewTabAttempts = context.pages().length;
  await details.first().dispatchEvent('auxclick', {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  await details.first().evaluate((link) => link.focus());
  await page.keyboard.press('Control+Enter');
  await page.locator('#selectAllActionsButton').evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  await page.locator('#checkInButton').evaluate((button) => {
    button.disabled = false;
    button.click();
  });

  await expect(page).toHaveURL(/\/dashboard\.html$/);
  expect(context.pages()).toHaveLength(pageCountBeforeNewTabAttempts);
  await expect(page.locator('.check-row.checked')).toHaveCount(0);
  await expect(page.locator('#todayPercent')).toHaveText('0%');
  await expect.poll(() => page.evaluate((key) => (
    Object.keys(JSON.parse(localStorage.getItem(key) || '{}')).length
  ), REQUEST_STORAGE_KEY)).toBe(0);

  const targetSizes = await Promise.all([
    start.evaluate((element) => element.getBoundingClientRect().height),
    page.locator('.challenge-start-gate-actions').evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(targetSizes[0]).toBeGreaterThanOrEqual(44);
  expect(targetSizes[1]).toBeLessThanOrEqual(328);
  await expectNoHorizontalOverflow(page);
  app.assertNoRuntimeErrors();
});

test('chooser supports Escape, Back, and Cancel without activation writes', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });
  const trigger = page.getByRole('button', { name: 'Start Challenge' });
  let dialog = await openStartDialog(page);
  await expect(dialog.getByRole('radio', { name: /With a group/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  dialog = await reviewSoloStart(page, FIXED_TODAY);
  await expect(dialog).toContainText('February 14, 2026');
  await expect(dialog).toContainText('Your challenge starts today');
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog.getByLabel('Challenge start date')).toHaveValue(FIXED_TODAY);
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog.getByRole('radio', { name: /^Solo/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  expect(await page.evaluate((key) => localStorage.getItem(key), REQUEST_STORAGE_KEY)).toBeNull();
  const activation = await page.evaluate(({ key, userId }) => (
    JSON.parse(localStorage.getItem(key) || '{}')[userId]
  ), { key: ACTIVATION_STORAGE_KEY, userId: FIXED_USER_ID });
  expect(activation.status).toBe('not_started');
  app.assertNoRuntimeErrors();
});

test('an account change closes setup and cannot submit the stale owner', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });
  const dialog = await reviewSoloStart(page, FIXED_TODAY);

  await page.evaluate(({ nextUserId }) => {
    const oldValue = localStorage.getItem('dominion:user');
    const nextUser = {
      name: 'Second Account',
      email: 'second.account@example.test',
      avatarUrl: '',
      authenticated: true,
    };
    const identities = JSON.parse(localStorage.getItem('dominion:mockUserIdsByIdentity') || '{}');
    identities[nextUser.email] = nextUserId;
    localStorage.setItem('dominion:mockUserIdsByIdentity', JSON.stringify(identities));
    localStorage.setItem('dominion:mockUserId', nextUserId);
    localStorage.setItem('dominion:user', JSON.stringify(nextUser));
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'dominion:user',
      oldValue,
      newValue: JSON.stringify(nextUser),
    }));
    document.querySelector('[data-challenge-start-confirm]')?.click();
  }, { nextUserId: 'mock_user_e2e_second' });

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/billing\.html\?intent=subscription$/);
  expect(await page.evaluate((key) => localStorage.getItem(key), REQUEST_STORAGE_KEY)).toBeNull();
  const activations = await page.evaluate((key) => (
    JSON.parse(localStorage.getItem(key) || '{}')
  ), ACTIVATION_STORAGE_KEY);
  expect(activations[FIXED_USER_ID].status).toBe('not_started');
  app.assertNoRuntimeErrors();
});

test('Group choice hands off only to canonical Community intent', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });
  const dialog = await openStartDialog(page);
  await dialog.getByRole('radio', { name: /With a group/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/community\.html\?intent=challenge-start$/);
  expect(await page.evaluate((key) => localStorage.getItem(key), REQUEST_STORAGE_KEY)).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dominion:mockCrews') || '[]'))).toEqual([]);
  const activation = await page.evaluate(({ key, userId }) => (
    JSON.parse(localStorage.getItem(key) || '{}')[userId]
  ), { key: ACTIVATION_STORAGE_KEY, userId: FIXED_USER_ID });
  expect(activation.status).toBe('not_started');
  app.assertNoRuntimeErrors();
});

test('Solo confirmation activates once, claims training, and resumes after refresh', async ({ page, app }) => {
  await page.addInitScript(() => {
    window.__soloTrainingEvents = [];
    window.addEventListener('dominion:solo-training-launch-requested', (event) => {
      window.__soloTrainingEvents.push(event.detail);
    });
  });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });
  const dialog = await reviewSoloStart(page, FIXED_TODAY);
  await dialog.getByRole('button', { name: 'Confirm and start challenge' }).evaluate((button) => {
    button.click();
    button.click();
  });

  await expect(dialog).toBeHidden();
  const trainingDialog = page.getByRole('dialog', { name: 'Welcome to your Solo walkthrough' });
  await expect(trainingDialog).toBeVisible();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Page 1 of 14 · Step 1 of 9');
  await expect(page.locator('#siteTrainingTitle')).toBeFocused();
  await expect(page.locator('#challengeStartGate')).toBeHidden();
  await expect(page.locator('#challengeDay')).toHaveText('Day 1 of 77');
  await expect(page.locator('.check-row-toggle').first()).toBeEnabled();
  await expect(page.locator('.check-row-details').first()).toHaveAttribute('href', /bible-reading\.html/);
  await expect(page.locator('.shared-header-share')).toBeEnabled();

  const persisted = await page.evaluate(({ activationKey, requestKey, trainingKey, userId }) => {
    const activation = JSON.parse(localStorage.getItem(activationKey) || '{}')[userId];
    const requests = JSON.parse(localStorage.getItem(requestKey) || '{}');
    const training = JSON.parse(localStorage.getItem(trainingKey) || '{}')[userId];
    return {
      activation,
      requestCount: Object.keys(requests).length,
      request: Object.values(requests)[0],
      training,
      events: window.__soloTrainingEvents,
    };
  }, {
    activationKey: ACTIVATION_STORAGE_KEY,
    requestKey: REQUEST_STORAGE_KEY,
    trainingKey: TRAINING_STORAGE_KEY,
    userId: FIXED_USER_ID,
  });
  expect(persisted.activation).toMatchObject({
    status: 'active',
    mode: 'solo',
    startDate: FIXED_TODAY,
    challengeDay: 1,
    confirmedBy: FIXED_USER_ID,
  });
  expect(persisted.requestCount).toBe(1);
  expect(persisted.request).toMatchObject({ actorId: FIXED_USER_ID, action: 'solo_activate' });
  expect(persisted.training).toBeUndefined();
  expect(persisted.events).toHaveLength(1);
  expect(persisted.events[0]).toMatchObject({
    schemaVersion: 1,
    actorId: FIXED_USER_ID,
    activationStatus: 'active',
    startDate: FIXED_TODAY,
    source: 'challenge_activation',
  });

  await trainingDialog.getByRole('button', { name: 'Stop for now' }).click();
  await expect(trainingDialog).toBeHidden();
  await expect(page.locator('.shared-header-share')).toHaveAccessibleName('Share');

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#challengeStartGate')).toBeHidden();
  await expect(page.locator('#challengeDay')).toHaveText('Day 1 of 77');
  await expect(page.locator('.site-training-layer')).toBeHidden();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('button', { name: 'Resume Training' })).toBeVisible();
  const afterRefresh = await page.evaluate(async ({ requestKey, trainingKey, userId }) => {
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
    const state = await api.getSiteTrainingState({ page: trainingPage, program, expectedUserId: userId });
    return {
    requestCount: Object.keys(JSON.parse(localStorage.getItem(requestKey) || '{}')).length,
    training: JSON.parse(localStorage.getItem(trainingKey) || '{}')[userId],
      state,
    };
  }, { requestKey: REQUEST_STORAGE_KEY, trainingKey: TRAINING_STORAGE_KEY, userId: FIXED_USER_ID });
  expect(afterRefresh.requestCount).toBe(1);
  expect(afterRefresh.training).toBeUndefined();
  expect(afterRefresh.state).toMatchObject({
    contractValid: true,
    actorId: FIXED_USER_ID,
    page: { status: 'stopped', currentStepId: 'orientation' },
    overall: { status: 'stopped', currentPageId: 'dashboard', currentPageIndex: 0 },
  });
  app.assertNoRuntimeErrors();
});

test('Cloudflare clean Dashboard URL keeps authenticated actions and launches first-run training', async ({ page, app }) => {
  await page.addInitScript(() => {
    if (window.location.pathname.endsWith('.html')) {
      window.history.replaceState(null, '', window.location.pathname.replace(/\.html$/, ''));
    }
  });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('.shared-header-share')).toHaveCount(1);
  await expect(page.locator('.shared-header-streak')).toHaveCount(1);

  const dialog = await reviewSoloStart(page, FIXED_TODAY);
  await dialog.getByRole('button', { name: 'Confirm and start challenge' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Welcome to your Solo walkthrough' })).toBeVisible();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Page 1 of 14 · Step 1 of 9');
  await expect(page.locator('.shared-header-share')).toBeEnabled();
  await expect(page.locator('.shared-header-streak')).toBeEnabled();
  app.assertNoRuntimeErrors();
});

test('future Solo start schedules once, keeps participation locked, and launches safe training', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });
  const dialog = await reviewSoloStart(page, '2026-02-20');
  await expect(dialog).toContainText('will be scheduled for this date');
  await dialog.getByRole('button', { name: 'Confirm and start challenge' }).click();

  await expect(dialog).toBeHidden();
  const trainingDialog = page.getByRole('dialog', { name: 'Welcome to your Solo walkthrough' });
  await expect(trainingDialog).toBeVisible();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Page 1 of 14 · Step 1 of 9');
  await expect(page.locator('#challengeStartGate')).toBeHidden();
  await expect(page.locator('#challengePercent')).toHaveText('0%');
  await expect(page.locator('#challengeDay')).toHaveText('Scheduled');
  await expect(page.locator('#todayPercent')).toHaveText('0%');
  await expect(page.locator('.check-row-toggle').first()).toBeDisabled();
  await expect(page.locator('.check-row-details').first()).not.toHaveAttribute('href');
  await expect(page.locator('#checkInStatus')).toContainText('scheduled to begin 2026-02-20');
  await expect(page.locator('.shared-header-share')).toBeDisabled();

  await page.locator('[data-training-action="next"]').click();
  await page.locator('[data-training-action="next"]').click();
  await expect(page.locator('#siteTrainingTitle')).toHaveText('Sharing stays under your control');
  await expect(page.locator('#siteTrainingFallback')).toBeVisible();

  const result = await page.evaluate(({ activationKey, requestKey, trainingKey, userId }) => ({
    activation: JSON.parse(localStorage.getItem(activationKey) || '{}')[userId],
    requestCount: Object.keys(JSON.parse(localStorage.getItem(requestKey) || '{}')).length,
    training: JSON.parse(localStorage.getItem(trainingKey) || '{}')[userId],
  }), {
    activationKey: ACTIVATION_STORAGE_KEY,
    requestKey: REQUEST_STORAGE_KEY,
    trainingKey: TRAINING_STORAGE_KEY,
    userId: FIXED_USER_ID,
  });
  expect(result.activation).toMatchObject({
    status: 'scheduled',
    mode: 'solo',
    startDate: '2026-02-20',
    challengeDay: null,
  });
  expect(result.requestCount).toBe(1);
  expect(result.training).toBeUndefined();
  await page.locator('[data-training-action="stop"]').click();
  await expect(page.getByRole('button', { name: /Share progress unavailable/i })).toBeDisabled();
  app.assertNoRuntimeErrors();
});

test('offline setup stays non-mutating and recovers when connectivity returns', async ({ page, context, app }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'notStarted' });
  const start = page.getByRole('button', { name: 'Start Challenge' });
  await start.focus();
  await context.setOffline(true);
  await expect(start).toBeDisabled();
  await expect(page.locator('#challengeStartGateDescription')).toContainText('Reconnect');
  const disabledFocus = await start.evaluate((button) => {
    const style = getComputedStyle(button);
    const buttonBounds = button.getBoundingClientRect();
    const gateBounds = button.closest('#challengeStartGate').getBoundingClientRect();
    return {
      focused: document.activeElement === button,
      outlineStyle: style.outlineStyle,
      contained: buttonBounds.left >= gateBounds.left && buttonBounds.right <= gateBounds.right,
    };
  });
  expect(disabledFocus.focused).toBe(false);
  expect(disabledFocus.outlineStyle).toBe('none');
  expect(disabledFocus.contained).toBe(true);
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), REQUEST_STORAGE_KEY)).toBeNull();

  await context.setOffline(false);
  await expect(start).toBeEnabled();
  app.assertNoRuntimeErrors();
});

test('already-active accounts retain the existing Dashboard behavior', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  await expect(page.locator('#challengeStartGate')).toBeHidden();
  await expect(page.locator('.check-row-toggle').first()).toBeEnabled();
  await expect(page.locator('.shared-header-share')).toBeEnabled();
  await expect(page.locator('.shared-header-share')).toHaveAccessibleName('Share');
  app.assertNoRuntimeErrors();
});

test('login returnTo continuation lands a new member on the not-started setup gate', async ({ page, app }) => {
  await app.seed('guest');
  await page.goto(ROUTE_BY_ID.dashboard.path);
  await expect(page).toHaveURL(/\/login\.html\?returnTo=/);
  await page.getByLabel('Email').fill('new.challenge.member@example.test');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Password').press('Enter');

  await expect(page).toHaveURL(/\/billing\.html\?intent=subscription$/);
  await page.getByRole('button', { name: 'Activate preview membership' }).click();
  await expect(page).toHaveURL(/\/dashboard\.html$/, { timeout: 12_000 });
  await expect(page.locator('#challengeStartGate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Challenge' })).toBeEnabled();
  app.assertNoRuntimeErrors();
});
