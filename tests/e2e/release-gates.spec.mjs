import { expect, test } from '@playwright/test';

test.use({ javaScriptEnabled: false });

test('customer actions stay safely closed before JavaScript can hydrate release gates', async ({ page }) => {
  await page.goto('/register.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#authForm')).toBeHidden();
  await expect(page.locator('#signupUnavailable')).toContainText('Already invited?');

  await page.goto('/billing.html', { waitUntil: 'domcontentloaded' });
  for (const id of [
    'subscriptionCheckoutButton',
    'manageBillingButton',
    'paymentMethodButton',
    'cancelMembershipButton',
  ]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(page.locator('#billingPolicyCopy')).toContainText('No payment is needed');

  await page.goto('/membership.html', { waitUntil: 'domcontentloaded' });
  const membershipCtas = page.locator('[data-membership-cta]');
  await expect(membershipCtas).toHaveCount(2);
  await expect(membershipCtas.nth(0)).toBeHidden();
  await expect(membershipCtas.nth(1)).toBeHidden();
  await expect(page.locator('#membershipEarlyAccessLogin')).toHaveAttribute('href', './login.html');

  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('a[href="./register.html"], a[href="./billing.html"]')).toHaveCount(0);
  await expect(page.locator('#landingOfferLabel')).toContainText('Invite-only early access');

  await page.goto('/invite.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#registerInviteLink')).toBeHidden();
  await expect(page.locator('#billingInviteLink')).toBeHidden();

  await page.goto('/profile.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#profileBillingLink')).toBeHidden();
  await expect(page.locator('#profileCancellationPolicyLink')).toBeHidden();

  await page.goto('/support.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#supportBillingCopy')).toContainText('no payment is required');
  await expect(page.locator('#supportBillingLink')).toBeHidden();

  await page.goto('/terms.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#termsBillingCopy')).toContainText('Billing is not open during early access');

  await page.goto('/cancellation-refunds.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cancellationHeroLead')).toContainText('no payment is required');
  await expect(page.locator('a[href="./billing.html"]')).toHaveCount(0);
});
