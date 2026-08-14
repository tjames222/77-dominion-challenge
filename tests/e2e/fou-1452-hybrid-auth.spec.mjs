import { expect, test } from '@playwright/test';
import { installFou1452SupabaseAuthStub } from './support/fou-1452-supabase-auth-stub.mjs';

const ACCOUNT_A = {
  name: 'Alpha Member',
  email: 'alpha.fou1452@example.test',
  password: 'Alpha-Password-1452!',
};
const ACCOUNT_B = {
  name: 'Bravo Member',
  email: 'bravo.fou1452@example.test',
  password: 'Bravo-Password-1452!',
};
const ACCOUNT_A_CREW = 'Alpha Accountability';
const ACCOUNT_A_JOURNAL = 'Alpha private journal marker';
const STALE_JOURNAL = 'This stale-session write must never persist';

async function register(page, account) {
  await page.goto('/register.html');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create account and continue' }).click();
  await expect(page).toHaveURL(/\/billing\.html$/);
  await expect(page.locator('#billingStatusTitle')).toHaveText('Preview membership checkout.');
}

async function activatePreviewMembership(page) {
  await page.getByRole('button', { name: 'Activate preview membership' }).click();
  await expect(page).toHaveURL(/\/billing\.html\?checkout=success&preview=1$/);
  await expect(page.locator('#billingStatusTitle')).toHaveText('Preview membership is active.');
}

async function logOutFromMenu(page) {
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Log Out' }).click();
  await expect(page).toHaveURL(/\/index\.html$/);
}

async function login(page, account) {
  await page.goto('/login.html');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Go to Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
}

async function seedAccountACommunityState(page) {
  return page.evaluate(async ({ crewName, journalNote }) => {
    const api = await import('/src/static/api.js');
    const crew = await api.createCrew({
      name: crewName,
      description: 'Only Alpha should see this crew.',
      challengeStartDate: '2026-08-10',
    });
    const journal = await api.saveJournalEntry({
      date: '2026-08-10',
      note: journalNote,
      win: 'Scoped state stays private',
      prayer: '',
      mood: 'Focused',
      energy: 'High',
    });
    return { crewId: crew.id, journalId: journal.id };
  }, { crewName: ACCOUNT_A_CREW, journalNote: ACCOUNT_A_JOURNAL });
}

async function expectAccountACommunityState(page) {
  await page.goto('/community.html');
  await expect(page.locator('#crewTitle')).toHaveText(ACCOUNT_A_CREW);
  await page.goto('/private-journal.html');
  await expect(page.locator('#journalTimeline')).toContainText(ACCOUNT_A_JOURNAL);
}

test('hybrid dev Auth preserves clean-URL header actions and first-challenge training', async ({
  context,
  page,
}) => {
  await installFou1452SupabaseAuthStub(context);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await register(page, ACCOUNT_A);
  await activatePreviewMembership(page);
  await page.addInitScript(() => {
    if (window.location.pathname.endsWith('.html')) {
      window.history.replaceState(null, '', window.location.pathname.replace(/\.html$/, ''));
    }
  });
  await page.goto('/dashboard.html');

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('.shared-header-share')).toHaveCount(1);
  await expect(page.locator('.shared-header-streak')).toHaveCount(1);
  await expect(page.locator('#challengeStartGate')).toBeVisible();

  await page.getByRole('button', { name: 'Start Challenge' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Challenge' });
  await dialog.getByRole('radio', { name: /^Solo/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await dialog.getByLabel('Challenge start date').fill(today);
  await dialog.getByRole('button', { name: 'Review start' }).click();
  await dialog.getByRole('button', { name: 'Confirm and start challenge' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Welcome to your Solo walkthrough' })).toBeVisible();
  await expect(page.locator('#siteTrainingProgress')).toHaveText('Page 1 of 14 · Step 1 of 9');
  expect(pageErrors).toEqual([]);
});

test('hybrid dev Auth registers, persists, logs in, isolates UUID-owned state, and fails closed', async ({
  context,
  page,
}) => {
  const auth = await installFou1452SupabaseAuthStub(context);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await register(page, ACCOUNT_A);
  expect(auth.count('/signup', 'POST')).toBe(1);
  expect(auth.user(ACCOUNT_A.email)?.id).toBe('00000000-0000-4000-8000-000000000001');
  expect(auth.requests.find((request) => request.endpoint === '/signup')?.url)
    .toContain('redirect_to=');

  const firstOwner = await page.evaluate(() => ({
    ownerId: localStorage.getItem('dominion:previewAuthOwnerId'),
    sessionKey: Object.keys(localStorage).find((key) => /^sb-.*-auth-token$/.test(key)) || '',
  }));
  expect(firstOwner).toEqual({
    ownerId: auth.user(ACCOUNT_A.email).id,
    sessionKey: 'sb-127-auth-token',
  });

  const getUserBeforeReload = auth.count('/user', 'GET');
  await page.reload();
  await expect(page.locator('#billingStatusTitle')).toHaveText('Preview membership checkout.');
  expect(auth.count('/user', 'GET')).toBeGreaterThan(getUserBeforeReload);
  await activatePreviewMembership(page);
  const accountAState = await seedAccountACommunityState(page);
  expect(accountAState.crewId).toBeTruthy();
  expect(accountAState.journalId).toBeTruthy();
  await expectAccountACommunityState(page);

  await logOutFromMenu(page);
  expect(auth.count('/logout', 'POST')).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('dominion:previewAuthOwnerId'))).toBeNull();

  await register(page, ACCOUNT_B);
  await activatePreviewMembership(page);
  await page.goto('/community.html');
  await expect(page.locator('#crewTitle')).toHaveText('Create or join a private group.');
  await expect(page.locator('#activeCrewName')).not.toContainText(ACCOUNT_A_CREW);
  await page.goto('/private-journal.html');
  await expect(page.locator('#journalTimeline')).not.toContainText(ACCOUNT_A_JOURNAL);
  await expect(page.locator('#journalTimeline')).toContainText('Your private journal is ready.');

  await logOutFromMenu(page);
  expect(auth.count('/logout', 'POST')).toBe(2);
  await login(page, ACCOUNT_A);
  expect(auth.count('/token', 'POST')).toBeGreaterThanOrEqual(1);
  await expectAccountACommunityState(page);

  const getUserBeforeInvalidation = auth.count('/user', 'GET');
  auth.invalidateUser(ACCOUNT_A.email);
  const invalidSessionResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
    && new URL(response.url()).pathname.endsWith('/auth/v1/user')
    && response.status() === 403
  ));
  const loginRedirect = page.waitForURL(/\/login\.html\?returnTo=/);

  // Arm the stale write behind a Node-controlled gate. Releasing it only after
  // evaluate has returned proves that a successful Auth redirect cannot destroy
  // the command used to start the assertion.
  let releaseStaleWrite;
  const staleWriteRelease = new Promise((resolve) => {
    releaseStaleWrite = resolve;
  });
  await page.exposeFunction('waitForFou1452StaleWriteRelease', () => staleWriteRelease);
  const staleWriteArmed = await page.evaluate((journalNote) => {
    void window.waitForFou1452StaleWriteRelease()
      .then(async () => {
        const api = await import('/src/static/api.js');
        await api.saveJournalEntry({
          date: '2026-08-11',
          note: journalNote,
          win: '',
          prayer: '',
          mood: 'Tested',
          energy: 'Low',
        });
      })
      .catch(() => {});
    return true;
  }, STALE_JOURNAL);
  expect(staleWriteArmed).toBe(true);
  releaseStaleWrite();

  const [failedUserCheck] = await Promise.all([invalidSessionResponse, loginRedirect]);
  expect(await failedUserCheck.json()).toMatchObject({ error_code: 'session_not_found' });
  expect(auth.count('/user', 'GET')).toBeGreaterThan(getUserBeforeInvalidation);
  await page.waitForLoadState('domcontentloaded');
  expect(await page.evaluate((marker) => (
    Object.values(localStorage).some((value) => String(value).includes(marker))
  ), STALE_JOURNAL)).toBe(false);
  expect(await page.evaluate(() => ({
    owner: localStorage.getItem('dominion:previewAuthOwnerId'),
    user: localStorage.getItem('dominion:user'),
  }))).toEqual({ owner: null, user: null });
  expect(pageErrors).toEqual([]);
});
