import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  moveMockIdentity,
  normalizeMockLoginIdentity,
  resolveMockIdentity,
} from './mock-identity.mjs';

describe('stable preview login identities', () => {
  test('normalizes case, whitespace, and compatible Unicode forms', () => {
    assert.equal(normalizeMockLoginIdentity('  Member@Example.TEST '), 'member@example.test');
    assert.equal(normalizeMockLoginIdentity('ＴＥＳＴ@example.test'), 'test@example.test');
  });

  test('adopts one legacy ID, separates another login, and restores the first', () => {
    const first = resolveMockIdentity({
      email: 'A@example.test',
      identityMap: {},
      legacyUserId: 'legacy-a',
      createUserId: () => 'new-a',
    });
    assert.equal(first.userId, 'legacy-a');
    assert.equal(first.adoptedLegacy, true);

    const second = resolveMockIdentity({
      email: 'b@example.test',
      identityMap: first.identityMap,
      legacyUserId: 'legacy-a',
      createUserId: () => 'new-b',
    });
    assert.equal(second.userId, 'new-b');
    assert.notEqual(second.userId, first.userId);

    const repeatedSecond = resolveMockIdentity({
      email: ' B@example.test ',
      identityMap: second.identityMap,
      legacyUserId: '',
      createUserId: () => 'unexpected-b',
    });
    assert.equal(repeatedSecond.userId, second.userId);

    const returning = resolveMockIdentity({
      email: ' a@EXAMPLE.test ',
      identityMap: repeatedSecond.identityMap,
      legacyUserId: '',
      createUserId: () => 'unexpected',
    });
    assert.equal(returning.userId, first.userId);
  });

  test('moves an authenticated account when its login email changes', () => {
    assert.deepEqual(moveMockIdentity({
      identityMap: {
        'old@example.test': 'user-a',
        'other@example.test': 'user-b',
      },
      fromEmail: 'OLD@example.test',
      toEmail: 'new@example.test',
      userId: 'user-a',
    }), {
      'other@example.test': 'user-b',
      'new@example.test': 'user-a',
    });
  });

  test('refuses to overwrite another account when a login email is already mapped', () => {
    const identityMap = {
      'old@example.test': 'user-a',
      'claimed@example.test': 'user-b',
    };

    assert.throws(() => moveMockIdentity({
      identityMap,
      fromEmail: 'old@example.test',
      toEmail: 'CLAIMED@example.test',
      userId: 'user-a',
    }), /already belongs to another account/);
    assert.deepEqual(identityMap, {
      'old@example.test': 'user-a',
      'claimed@example.test': 'user-b',
    });
  });

  test('drops corrupt and non-normalized registry entries before resolving an identity', () => {
    const resolved = resolveMockIdentity({
      email: 'member@example.test',
      identityMap: {
        'MEMBER@example.test': 'wrong-case-key',
        'other@example.test': '',
        'valid@example.test': 'valid-user',
      },
      legacyUserId: 'must-not-be-reused',
      createUserId: () => 'new-member',
    });

    assert.equal(resolved.userId, 'new-member');
    assert.deepEqual(resolved.identityMap, {
      'valid@example.test': 'valid-user',
      'member@example.test': 'new-member',
    });
    assert.equal(resolved.adoptedLegacy, false);
  });
});
