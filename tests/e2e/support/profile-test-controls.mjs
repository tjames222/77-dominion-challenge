import { expect } from '@playwright/test';

export async function expectNoProfileTestControls(page) {
  await expect(page.locator('#profileForm')).toBeVisible();
  await expect(page.locator('#profilePreviewTools, #profilePreviewChallengeSwitch, #resetPreviewChallengeButton, .profile-preview-tools')).toHaveCount(0);
  await expect(page.getByText(/77-day test mode|Advance after every preview check-in/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Account security', exact: true })).toBeVisible();
  await expect(page.locator('#profileNameInput')).toBeEnabled();
}
