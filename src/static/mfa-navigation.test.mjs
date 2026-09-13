import test from 'node:test';
import assert from 'node:assert/strict';
import { mfaReturnTo, mfaChallengeHref } from './mfa-navigation.mjs';
const origin = 'https://77dominion.com';

test('MFA return preserves known local challenge intent and disallows auth loops', () => {
  assert.equal(mfaReturnTo('/dashboard?start=solo#challenge', origin), './dashboard.html?start=solo#challenge');
  assert.equal(mfaReturnTo('/profile.html#appearance', origin), './profile.html#appearance');
  for (const target of ['/login?returnTo=x', '/account-security.html?mode=challenge', '/reset-password', '/register', '//evil.test/profile', 'https://evil.test', 'javascript:alert(1)', '/unknown', 'https://user@77dominion.com/dashboard']) {
    assert.equal(mfaReturnTo(target, origin), './dashboard.html');
  }
});

test('MFA return filters decoded sensitive query and fragment keys, case-insensitively', () => {
  for (const key of ['%61ccess_token', 'ACCESS_TOKEN', 'refresh_token', 'c%6fde', 'token', 'invi%74e', 'SECRET']) {
    for (const prefix of ['?', '#', '#?']) {
      assert.equal(mfaReturnTo(`/profile.html${prefix}${key}=private`, origin), './dashboard.html');
    }
  }
  assert.equal(mfaReturnTo('/invite?code=private', origin), './invite.html');
});

test('challenge and explicit fresh step-up modes use sanitized return targets', () => {
  const challenge = new URL(mfaChallengeHref('/profile#appearance', origin), origin);
  assert.equal(challenge.searchParams.get('mode'), 'challenge');
  assert.equal(challenge.searchParams.get('returnTo'), './profile.html#appearance');
  const stepUp = new URL(mfaChallengeHref('/dashboard', origin, { stepUp: true }), origin);
  assert.equal(stepUp.searchParams.get('mode'), 'step-up');
});
