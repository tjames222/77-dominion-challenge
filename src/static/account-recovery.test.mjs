import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PASSWORD_MINIMUM_LENGTH,
  cleanPasswordRecoveryUrl,
  passwordRecoveryErrorFromLocation,
  passwordRecoveryRedirectUrl,
  validateNewPassword,
} from './account-recovery.mjs';

describe('password recovery route contract', () => {
  test('always returns to the fixed same-origin sibling route', () => {
    assert.equal(passwordRecoveryRedirectUrl({
      href: 'https://example.test/app/forgot-password.html?returnTo=https://evil.test',
      origin: 'https://example.test',
    }), 'https://example.test/app/reset-password.html');
    assert.throws(() => passwordRecoveryRedirectUrl({
      href: 'https://evil.test/forgot-password.html',
      origin: 'https://example.test',
    }), /same site/);
  });

  test('removes one-time recovery material from browser history', () => {
    assert.equal(cleanPasswordRecoveryUrl({
      href: 'https://example.test/reset-password.html?code=secret#access_token=secret',
      origin: 'https://example.test',
    }), 'https://example.test/reset-password.html');
  });

  test('normalizes provider errors without reading tokens', () => {
    assert.equal(passwordRecoveryErrorFromLocation({
      search: '?error_description=Recovery+link+expired',
      hash: '#access_token=secret',
    }), 'Recovery link expired');
  });

  test('requires a long matching replacement password', () => {
    assert.match(validateNewPassword('short', 'short'), new RegExp(String(PASSWORD_MINIMUM_LENGTH)));
    assert.equal(validateNewPassword('a-secure-passphrase', 'different-passphrase'), 'The passwords do not match.');
    assert.equal(validateNewPassword('a-secure-passphrase', 'a-secure-passphrase'), '');
  });
});
