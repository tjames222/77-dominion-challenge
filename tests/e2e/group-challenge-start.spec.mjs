import { expect, test } from './support/app-test.mjs';
import { FIXED_USER_ID } from './support/fixtures.mjs';
import { injectApiFunctionFailure } from './support/network-states.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

const INTENT_KEY = 'dominion:challengeStartIntent';

function intentFixture() {
  return {
    version: 1,
    kind: 'group',
    stage: 'choose_group',
    actorId: null,
    crewId: null,
    activationRequestId: null,
    timeZone: null,
    createdAt: '2026-02-14T17:30:00.000Z',
    expiresAt: '2026-02-14T19:30:00.000Z',
  };
}

async function installStartIntent(page) {
  await page.addInitScript(({ key, intent }) => {
    sessionStorage.setItem(key, JSON.stringify(intent));
  }, { key: INTENT_KEY, intent: intentFixture() });
}

async function openStartCommunity(page, app, state, theme = 'dark') {
  await app.seed(state, theme);
  await installStartIntent(page);
  await page.goto('/community.html?intent=challenge-start', { waitUntil: 'networkidle' });
  await app.stable();
}

for (const theme of ['light', 'dark']) {
  test(`existing-member Group confirmation is explicit, cancelable, and accessible in ${theme}`, async ({ page, app }) => {
    await openStartCommunity(page, app, 'groupStartExisting', theme);
    const dialog = page.getByRole('dialog', { name: 'Start with Steady Hands?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    assertNoBlockingAxeViolations(await analyzeAccessibility(page));

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/community\.html$/);
    const persisted = await page.evaluate((key) => ({
      intent: sessionStorage.getItem(key),
      activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}'),
    }), INTENT_KEY);
    expect(persisted.intent).toBeNull();
    expect(persisted.activation[FIXED_USER_ID].status).toBe('not_started');
  });
}

test('existing-member confirmation activates the authoritative crew date once', async ({ page, app }) => {
  await openStartCommunity(page, app, 'groupStartExisting');
  await page.getByRole('dialog', { name: 'Start with Steady Hands?' })
    .getByRole('button', { name: 'Confirm Group Start' })
    .click();
  await expect(page.locator('#communityFeedback')).toContainText('now your Group challenge');
  await expect(page).toHaveURL(/\/community\.html$/);

  const result = await page.evaluate((key) => ({
    intent: sessionStorage.getItem(key),
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}'),
    requests: JSON.parse(localStorage.getItem('dominion:mockChallengeActivationRequests') || '{}'),
  }), INTENT_KEY);
  expect(result.intent).toBeNull();
  expect(result.activation[FIXED_USER_ID]).toMatchObject({
    status: 'active',
    mode: 'group',
    startDate: '2026-02-01',
    crewId: 'crew_e2e_alpha',
    groupMembershipActive: true,
    revision: 1,
  });
  expect(Object.keys(result.requests)).toHaveLength(1);
});

test('create path atomically creates membership and starts the Group challenge', async ({ page, app }) => {
  await openStartCommunity(page, app, 'groupStartEmpty');
  const form = page.locator('#crewForm');
  await expect(form).toBeVisible();
  await page.getByLabel('Group name').fill('New Start Group');
  await form.getByRole('button', { name: 'Create Group and Start Challenge' }).click();
  await expect(page.locator('#communityFeedback')).toContainText('Group challenge is confirmed');
  await expect(page).toHaveURL(/\/community\.html$/);

  const started = await page.evaluate((key) => ({
    intent: sessionStorage.getItem(key),
    crews: JSON.parse(localStorage.getItem('dominion:mockCrews') || '[]'),
    members: JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}'),
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}'),
  }), INTENT_KEY);
  expect(started.intent).toBeNull();
  expect(started.crews).toHaveLength(1);
  expect(started.members[started.crews[0].id]).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: FIXED_USER_ID, role: 'owner' }),
  ]));
  expect(started.activation[FIXED_USER_ID]).toMatchObject({
    mode: 'group',
    crewId: started.crews[0].id,
    revision: 1,
  });
});

test('ordinary Community crew creation remains challenge-gated', async ({ page, app }) => {
  await app.open({
    path: '/community.html',
    title: 'Dominion Private Groups',
    ready: '#crewLeaderboard',
    defaultState: 'groupStartEmpty',
  });
  await page.getByRole('button', { name: 'Create a Group' }).click();
  await page.getByLabel('Group name').fill('Ordinary Group');
  await page.locator('#crewForm').getByRole('button', { name: 'Create Group' }).click();
  const activation = await page.evaluate(() => (
    JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}')
  ));
  expect(activation[FIXED_USER_ID]).toMatchObject({ status: 'not_started', revision: 0 });
});

test('invite join activates only after membership succeeds and never launches owner training', async ({ page, app }) => {
  await app.seed('groupStartInvite');
  await installStartIntent(page);
  await page.goto('/invite.html#invite=group-invite-secret-12345', { waitUntil: 'networkidle' });
  const confirm = page.getByRole('button', { name: 'Confirm, join, and start challenge' });
  await expect(confirm).toBeVisible();

  const before = await page.evaluate(() => ({
    members: JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}'),
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}'),
  }));
  expect(before.members.crew_e2e_alpha.some((member) => member.userId === FIXED_USER_ID)).toBe(false);
  expect(before.activation[FIXED_USER_ID].status).toBe('not_started');

  await confirm.click();
  await expect(page.locator('#inviteTitle')).toHaveText('You are starting with Steady Hands.');
  const after = await page.evaluate((key) => ({
    intent: sessionStorage.getItem(key),
    members: JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}'),
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}'),
    training: JSON.parse(localStorage.getItem('dominion:mockCrewTraining') || '{}'),
  }), INTENT_KEY);
  expect(after.intent).toBeNull();
  expect(after.members.crew_e2e_alpha).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: FIXED_USER_ID, role: 'member' }),
  ]));
  expect(after.activation[FIXED_USER_ID]).toMatchObject({
    status: 'active', mode: 'group', crewId: 'crew_e2e_alpha', revision: 1,
  });
  expect(after.training).toEqual({});
});

test('post-membership activation failure preserves one retry-safe continuation', async ({ page, app }) => {
  await injectApiFunctionFailure(page, 'activateGroupChallenge', 'Temporary activation outage.');
  await app.seed('groupStartInvite');
  await installStartIntent(page);
  await page.goto('/invite.html#invite=group-invite-secret-12345', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Confirm, join, and start challenge' }).click();

  await expect(page.getByRole('button', { name: 'Continue starting challenge' })).toBeVisible();
  await expect(page.locator('#inviteMessage')).toContainText('Temporary activation outage');
  const recovery = await page.evaluate((key) => ({
    intent: JSON.parse(sessionStorage.getItem(key) || 'null'),
    members: JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}'),
    activation: JSON.parse(localStorage.getItem('dominion:mockChallengeActivation') || '{}'),
  }), INTENT_KEY);
  expect(recovery.members.crew_e2e_alpha).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: FIXED_USER_ID, role: 'member' }),
  ]));
  expect(recovery.activation[FIXED_USER_ID].status).toBe('not_started');
  expect(recovery.intent).toMatchObject({
    stage: 'activation_pending',
    actorId: FIXED_USER_ID,
    crewId: 'crew_e2e_alpha',
    timeZone: 'UTC',
  });
  expect(recovery.intent.activationRequestId).toBeTruthy();
});
