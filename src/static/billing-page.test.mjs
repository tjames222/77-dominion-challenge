import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const billingHtml = readFileSync(new URL('../../billing.html', import.meta.url), 'utf8');
const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');

describe('billing management page', () => {
  test('keeps the redundant membership overview removed', () => {
    const legacyMarkup = [
      'billing-roadmap',
      'Included With Membership',
      'Focused surrender with a guided structure.',
      'Stay in the Word with a paced reading path.',
      'Smaller intensive rounds when you need to tighten up.',
      'Private circles, stronger accountability, better follow-up.',
    ];

    legacyMarkup.forEach((marker) => {
      assert.equal(billingHtml.includes(marker), false, `legacy billing content returned: ${marker}`);
    });
    assert.equal(productCss.includes('.billing-roadmap'), false);
  });

  test('preserves the billing status and management controls', () => {
    const managementControls = [
      'billingStatusTitle',
      'subscriptionStatusPill',
      'manageBillingButton',
      'paymentMethodButton',
      'cancelMembershipButton',
      'billingDashboardLink',
      'subscriptionCheckoutButton',
    ];

    managementControls.forEach((id) => {
      assert.match(billingHtml, new RegExp(`id=["']${id}["']`), `missing billing control: ${id}`);
    });
    assert.ok(
      billingHtml.indexOf('billing-status-card') < billingHtml.indexOf('billing-offer-subscription'),
      'billing access status should remain the primary content',
    );
  });
});
