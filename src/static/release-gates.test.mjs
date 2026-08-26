import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
  BILLING_CLOSED_MESSAGE,
  PUBLIC_SIGNUP_CLOSED_MESSAGE,
  RELEASE_GATES,
  RELEASE_MODES,
  resolveReleaseGates,
  resolveReleaseMode,
  runReleaseGatedAction,
  runOptionalReleaseQuery,
} from './release-gates.mjs';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('invite-only production release gates', () => {
  test('defaults both real customer actions closed and requires literal true', () => {
    assert.deepEqual(resolveReleaseGates({}), {
      mocksEnabled: false,
      billingEnabled: false,
      publicSignupEnabled: false,
    });
    assert.deepEqual(RELEASE_GATES, {
      mocksEnabled: false,
      billingEnabled: false,
      publicSignupEnabled: false,
    });

    for (const value of ['1', 'yes', 'on', 'enabled', 'TRUE', ' true ', true]) {
      assert.equal(resolveReleaseGates({ VITE_ENABLE_BILLING: value }).billingEnabled, false);
      assert.equal(
        resolveReleaseGates({ VITE_ENABLE_PUBLIC_SIGNUP: value }).publicSignupEnabled,
        false,
      );
    }
    assert.deepEqual(resolveReleaseGates({
      VITE_ENABLE_BILLING: 'true',
      VITE_ENABLE_PUBLIC_SIGNUP: 'true',
    }), {
      mocksEnabled: false,
      billingEnabled: true,
      publicSignupEnabled: true,
    });
  });

  test('keeps mock signup and billing previews available with safe flag defaults', () => {
    assert.deepEqual(resolveReleaseGates({
      VITE_ENABLE_MOCKS: 'true',
      VITE_ENABLE_BILLING: 'false',
      VITE_ENABLE_PUBLIC_SIGNUP: 'false',
    }), {
      mocksEnabled: true,
      billingEnabled: true,
      publicSignupEnabled: true,
    });
  });

  test('keeps independently toggled signup and billing modes coherent', () => {
    assert.equal(resolveReleaseMode({}), RELEASE_MODES.INVITE_ONLY);
    assert.equal(
      resolveReleaseMode({ publicSignupEnabled: true }),
      RELEASE_MODES.SIGNUP_EARLY_ACCESS,
    );
    assert.equal(
      resolveReleaseMode({ billingEnabled: true }),
      RELEASE_MODES.INVITED_MEMBERSHIP,
    );
    assert.equal(
      resolveReleaseMode({ billingEnabled: true, publicSignupEnabled: true }),
      RELEASE_MODES.PUBLIC_MEMBERSHIP,
    );
  });

  test('rejects a disabled action before its network callback can run', async () => {
    let calls = 0;
    const action = () => {
      calls += 1;
      return Promise.resolve('called');
    };

    assert.throws(
      () => runReleaseGatedAction({
        enabled: false,
        message: PUBLIC_SIGNUP_CLOSED_MESSAGE,
        action,
      }),
      new RegExp(PUBLIC_SIGNUP_CLOSED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.throws(
      () => runReleaseGatedAction({
        enabled: false,
        message: BILLING_CLOSED_MESSAGE,
        action,
      }),
      new RegExp(BILLING_CLOSED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(calls, 0);
    assert.equal(await runReleaseGatedAction({ enabled: true, message: '', action }), 'called');
    assert.equal(calls, 1);
  });

  test('does not start a billing-data query while billing is closed', async () => {
    let calls = 0;
    const query = () => {
      calls += 1;
      return Promise.resolve({ data: [{ id: 'subscription-1' }], error: null });
    };

    assert.deepEqual(
      await runOptionalReleaseQuery({ enabled: false, query }),
      { data: [], error: null },
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await runOptionalReleaseQuery({ enabled: true, query }),
      { data: [{ id: 'subscription-1' }], error: null },
    );
    assert.equal(calls, 1);
  });

  test('wraps signup and every billing mutation while preserving entitlement-only access', async () => {
    const api = await read('./api.js');
    assert.match(
      api,
      /signUpWithPassword[\s\S]*?runReleaseGatedAction\(\{[\s\S]*?enabled: RELEASE_GATES\.publicSignupEnabled[\s\S]*?client\.auth\.signUp/,
    );
    for (const functionName of [
      'createCheckoutSession',
      'createCustomerPortalSession',
      'cancelMembership',
    ]) {
      assert.match(
        api,
        new RegExp(`${functionName}\\([^)]*\\) \\{[\\s\\S]*?runReleaseGatedAction\\(\\{[\\s\\S]*?enabled: RELEASE_GATES\\.billingEnabled`),
      );
    }
    assert.match(api, /const subscriptionActive = hasActiveEntitlement\(entitlements, MEMBERSHIP_ACCESS_KEY\)/);
    assert.match(
      api,
      /runOptionalReleaseQuery\(\{\s*enabled: RELEASE_GATES\.billingEnabled,\s*query: \(\) => client\s*\.from\('subscriptions'\)/,
    );
    assert.match(
      api,
      /billingEnabled: RELEASE_GATES\.billingEnabled,\s*appAccess: subscriptionActive,/,
    );
  });

  test('ships safe-first HTML when JavaScript cannot hydrate the gates', async () => {
    const [
      register,
      billing,
      membership,
      landing,
      invite,
      profile,
      support,
      terms,
      cancellation,
      productCss,
      envExample,
    ] =
      await Promise.all([
        read('../../register.html'),
        read('../../billing.html'),
        read('../../membership.html'),
        read('../../index.html'),
        read('../../invite.html'),
        read('../../profile.html'),
        read('../../support.html'),
        read('../../terms.html'),
        read('../../cancellation-refunds.html'),
        read('../assets/product.css'),
        read('../../.env.example'),
      ]);

    assert.match(register, /<form[^>]*id="authForm"[^>]*hidden/);
    assert.match(register, /id="signupUnavailable"[\s\S]*invite/i);
    for (const id of [
      'subscriptionCheckoutButton',
      'manageBillingButton',
      'paymentMethodButton',
      'cancelMembershipButton',
    ]) {
      assert.match(billing, new RegExp(`<[^>]+id="${id}"[^>]*hidden`));
    }
    const membershipCtas = [...membership.matchAll(/<a[^>]+data-membership-cta[^>]*>/g)];
    assert.ok(membershipCtas.length > 0);
    membershipCtas.forEach(([tag]) => assert.match(tag, /\shidden(?:\s|>)/));
    assert.doesNotMatch(landing, /href="\.\/register\.html|href="\.\/billing\.html/);
    assert.match(landing, /invite-only early access/i);
    assert.match(invite, /id="registerInviteLink"[^>]*hidden/);
    assert.match(invite, /id="billingInviteLink"[^>]*hidden/);
    assert.match(profile, /id="profileBillingLink"[^>]*hidden/);
    assert.match(profile, /id="profileCancellationPolicyLink"[^>]*hidden/);
    assert.match(support, /id="supportBillingCopy"[^>]*>Billing is not open yet, and no payment is required/i);
    assert.match(support, /id="supportBillingLink"[^>]*hidden/);
    assert.match(terms, /id="termsBillingCopy"[^>]*>Billing is not open during early access, and no payment is required/i);
    assert.doesNotMatch(terms, /currently offered for \$7/i);
    assert.match(cancellation, /Billing is not open during early access, and no payment is required/i);
    assert.doesNotMatch(cancellation, /href="\.\/billing\.html"|sending the cancellation to Stripe/i);
    for (const page of [
      register,
      billing,
      membership,
      landing,
      invite,
      profile,
      support,
      terms,
      cancellation,
    ]) {
      assert.doesNotMatch(page, /canary/i);
    }
    assert.match(productCss, /\.auth-card form\[hidden\][\s\S]*?display: none !important/);
    assert.match(productCss, /\.billing-purchase-button\[hidden\][\s\S]*?display: none !important/);
    assert.match(productCss, /\.policy-link-row a\[hidden\][\s\S]*?display: none !important/);
    assert.match(envExample, /^VITE_ENABLE_BILLING=false$/m);
    assert.match(envExample, /^VITE_ENABLE_PUBLIC_SIGNUP=false$/m);
  });

  test('applies early-access presentation gates to every customer surface', async () => {
    const sources = await Promise.all([
      './auth.js',
      './billing.js',
      './landing.js',
      './membership.js',
      './invite.js',
      './profile.js',
      './menu.js',
      './legal.js',
    ].map(read));
    sources.forEach((source) => assert.match(source, /RELEASE_GATES/));
    assert.match(sources[4], /status === 'authentication_required' && !RELEASE_GATES\.publicSignupEnabled/);
    assert.match(sources[4], /status === 'subscription_required' && !RELEASE_GATES\.billingEnabled/);
    assert.match(sources[6], /RELEASE_GATES\.billingEnabled \? 'Billing' : 'Early Access'/);
    assert.match(sources[6], /RELEASE_GATES\.billingEnabled \? 'Membership' : 'Early Access'/);
    assert.match(sources[7], /if \(!RELEASE_GATES\.billingEnabled\) return/);
    assert.match(sources[5], /RELEASE_GATES\.billingEnabled[\s\S]*?This does not cancel billing by itself/);

    const training = await read('./site-training-registry.mjs');
    assert.match(training, /This page shows your access status\. When billing is open/);
    assert.match(training, /When billing is open, these buttons can open Stripe/);
    assert.doesNotMatch(training, /check challenge status, open billing/);
  });
});
