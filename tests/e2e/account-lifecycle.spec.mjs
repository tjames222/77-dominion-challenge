import { expect, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

test('password recovery request keeps account existence private', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.forgotPassword);
  await page.getByLabel('Email').fill('member@example.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.locator('#passwordRecoveryRequestFeedback')).toContainText(
    'If an account uses that email',
  );
  await expect(page.getByLabel('Email')).toHaveValue('');
  app.assertNoRuntimeErrors();
});

test('reset completion fails closed without a verified recovery session', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.resetPassword);
  await expect(page.locator('#passwordResetFeedback')).toContainText('unavailable in this local preview');
  await expect(page.getByLabel('New password', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save new password' })).toBeDisabled();
  app.assertNoRuntimeErrors();
});

test('Profile creates one tracked request per active account action', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  const exportButton = page.getByRole('button', { name: 'Request data export' });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(page.locator('#dataExportRequestStatus')).toContainText('Request received');
  await expect(page.getByRole('button', { name: 'Export request active' })).toBeDisabled();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Request account deletion' }).click();
  await expect(page.locator('#accountDeletionRequestStatus')).toContainText('Request received');
  await expect(page.getByRole('button', { name: 'Deletion request active' })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Export request active' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Deletion request active' })).toBeDisabled();
  app.assertNoRuntimeErrors();
});

test('policy and support routes stay linked from account decisions', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.terms);
  await expect(page.getByRole('link', { name: 'Cancellation and Refund Policy' })).toHaveAttribute(
    'href',
    './cancellation-refunds.html',
  );
  await page.getByRole('button', { name: 'Open menu' }).click();
  const policies = page.getByRole('navigation', { name: 'Policies and support' });
  await expect(policies.getByRole('link')).toHaveCount(4);
  await expect(policies.getByRole('link', { name: 'Support' })).toHaveAttribute('href', './support.html');
  app.assertNoRuntimeErrors();
});
