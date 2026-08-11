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
  await page.getByRole('tab', { name: 'Private Journal' }).click();
  await expect(page.locator('#journalTimeline')).toContainText(ACCOUNT_A_JOURNAL);
}

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
  await expect(page.locator('#crewTitle')).toHaveText('Create or join a crew.');
  await expect(page.locator('#activeCrewName')).not.toContainText(ACCOUNT_A_CREW);
  await page.getByRole('tab', { name: 'Private Journal' }).click();
  await expect(page.locator('#journalTimeline')).not.toContainText(ACCOUNT_A_JOURNAL);
  await expect(page.locator('#journalTimeline')).toContainText('Your private journal is ready.');

  await logOutFromMenu(page);
  expect(auth.count('/logout', 'POST')).toBe(2);
  await login(page, ACCOUNT_A);
  expect(auth.count('/token', 'POST')).toBeGreaterThanOrEqual(1);
  await expectAccountACommunityState(page);

  auth.invalidateUser(ACCOUNT_A.email);
  const staleWrite = await page.evaluate(async (journalNote) => {
    const api = await import('/src/static/api.js');
    try {
      await api.saveJournalEntry({
        date: '2026-08-11',
        note: journalNote,
        win: '',
        prayer: '',
        mood: 'Tested',
        energy: 'Low',
      });
      return { accepted: true, message: '' };
    } catch (error) {
      return { accepted: false, message: error?.message || '' };
    }
  }, STALE_JOURNAL);
  expect(staleWrite.accepted).toBe(false);
  expect(staleWrite.message).toMatch(/log in again|session|signed-in/i);
  await expect(page).toHaveURL(/\/login\.html\?returnTo=/);
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
