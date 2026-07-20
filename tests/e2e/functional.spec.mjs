import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import {
  AUTHENTICATED_ROUTES,
  PRODUCTION_ROUTES,
  ROUTE_BY_ID,
} from './support/routes.mjs';
import { FIXED_TODAY } from './support/fixtures.mjs';

test.describe('production route smoke coverage', () => {
  for (const route of PRODUCTION_ROUTES) {
    test(route.id + ' loads from deterministic fixtures', async ({ page, app }) => {
      await app.open(route);
      await expect(page.locator('main')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      app.assertNoRuntimeErrors();
    });
  }
});

test.describe('authenticated route guards', () => {
  for (const route of AUTHENTICATED_ROUTES) {
    test(route.id + ' sends a logged-out visitor to login', async ({ page, app }) => {
      await app.seed('guest');
      await page.goto(route.path);
      await expect(page).toHaveURL(/\/login\.html\?returnTo=/);
      await expect(page.locator('#authForm')).toBeVisible();
    });
  }
});

test('global navigation is keyboard operable and Escape closes it', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  const menuButton = page.getByRole('button', { name: 'Open menu' });
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass(/menu-open/);
});

test('community tablist follows arrow-key navigation', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  const crewTab = page.getByRole('tab', { name: 'Private Group' });
  const globalTab = page.getByRole('tab', { name: 'Global' });
  const journeyTab = page.getByRole('tab', { name: 'My Journey' });

  await crewTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(globalTab).toBeFocused();
  await expect(globalTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(journeyTab).toBeFocused();
  await expect(journeyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#journey')).toBeVisible();
});

test('login form submits with the keyboard and honors a safe return path', async ({ page, app }) => {
  await app.seed('guest');
  await page.goto('/login.html?returnTo=./profile.html');
  await page.getByLabel('Email').fill('keyboard.member@example.test');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Password').press('Enter');

  await expect(page).toHaveURL(/\/profile\.html$/);
  await expect(page.locator('#profileEmail')).toHaveText('keyboard.member@example.test');
});

test('daily action controls toggle by keyboard and persist the dated fixture', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.todayActions);
  const workoutAction = page.locator('[data-action-completion="workoutOne"]');
  await expect(workoutAction).toHaveAccessibleName('Mark Workout #1 complete');
  await workoutAction.focus();
  await page.keyboard.press('Space');
  await expect(workoutAction).toHaveAttribute('aria-pressed', 'true');

  const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('dominion:entries') || '[]'));
  expect(entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      date: FIXED_TODAY,
      completed: expect.arrayContaining(['workoutOne']),
    }),
  ]));
});

test('profile form saves through Enter and announces success', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  await page.getByLabel('Name').fill('Jordan Keyboard');
  await page.getByLabel('Email').press('Enter');
  await expect(page.locator('#profileFeedback')).toHaveText('Profile saved.');
  await expect(page.locator('#profileName')).toHaveText('Jordan Keyboard');
});
