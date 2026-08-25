import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CREW_INVITE_CODE_ALPHABET,
  CREW_INVITE_CODE_LENGTH,
  CREW_INVITE_QR_FILENAME,
  canShareCrewInviteQr,
  createCrewInviteQrFile,
  crewInviteQrOptions,
  crewInviteShareCopy,
  formatCrewInviteCode,
  inviteUrlFromCode,
  inviteUrlFromToken,
  isShareCancellation,
  nextInviteTabIndex,
  normalizeCrewInviteCode,
  readableCrewInviteCode,
  renderCrewInviteQr,
} from './crew-invite.mjs';

describe('secure crew invitation representations', () => {
  test('normalizes case, spaces, and hyphens while rejecting ambiguous characters', () => {
    assert.equal(
      normalizeCrewInviteCode('3467-9acd efgh-jkmn'),
      '34679ACDEFGHJKMN',
    );
    assert.equal(formatCrewInviteCode('34679acdefghjkmn'), '3467-9ACD-EFGH-JKMN');
    assert.equal(readableCrewInviteCode('34679acdefghjkmn'), '3467 dash 9ACD dash EFGH dash JKMN');
    assert.equal(normalizeCrewInviteCode('3467-9ACD-EFGH-JKMO'), '');
    assert.equal(normalizeCrewInviteCode('too-short'), '');
    assert.equal(formatCrewInviteCode('34679ACD?', { partial: true }), '3467-9ACD');
  });

  test('the unambiguous code space exceeds 72 bits of minimum entropy', () => {
    const maximumSymbolProbability = Math.ceil(256 / CREW_INVITE_CODE_ALPHABET.length) / 256;
    const minimumEntropy = -Math.log2(maximumSymbolProbability) * CREW_INVITE_CODE_LENGTH;
    assert.ok(minimumEntropy > 72, `expected >72 bits, found ${minimumEntropy}`);
    for (const ambiguous of '01258BILOSZ') {
      assert.equal(CREW_INVITE_CODE_ALPHABET.includes(ambiguous), false, ambiguous);
    }
  });

  test('keeps credentials out of query strings and uses the dedicated invite fragment', () => {
    const link = inviteUrlFromToken(
      'secure-link-token-12345',
      'https://dominion.example/community.html?source=menu',
    );
    const code = inviteUrlFromCode(
      '3467-9ACD-EFGH-JKMN',
      'https://dominion.example/community.html',
    );
    assert.equal(new URL(link).search, '');
    assert.equal(new URL(link).hash, '#invite=secure-link-token-12345');
    assert.equal(new URL(code).search, '');
    assert.equal(new URL(code).hash, '#code=34679ACDEFGHJKMN');
  });

  test('builds neutral share copy without adding member or roster details', () => {
    assert.deepEqual(crewInviteShareCopy({
      crewName: 'Morning Men',
      url: 'https://dominion.example/invite.html#invite=opaque',
    }), {
      title: 'Join Morning Men',
      text: 'Join Morning Men and take the 77-Day Dominion Challenge with me. This invitation is for one person and expires.',
      url: 'https://dominion.example/invite.html#invite=opaque',
    });
  });

  test('renders QR locally with a 4-module quiet zone, contrast, and M correction', async () => {
    const calls = [];
    const canvas = {};
    const url = 'https://dominion.example/invite.html#invite=opaque-secret';
    const result = await renderCrewInviteQr(
      canvas,
      url,
      async (...args) => calls.push(args),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], canvas);
    assert.equal(calls[0][1], url);
    assert.deepEqual(calls[0][2], crewInviteQrOptions(512));
    assert.equal(result.payload, url);
    assert.equal(result.options.errorCorrectionLevel, 'M');
    assert.equal(result.options.margin, 4);
    assert.equal(result.options.width, 512);
    assert.equal(result.options.color.dark, '#0e1116');
    assert.equal(result.options.color.light, '#ffffff');
  });

  test('uses a neutral QR filename and requires actual file-share support', () => {
    class FakeFile {
      constructor(parts, name, options) {
        Object.assign(this, { parts, name, type: options.type });
      }
    }
    const blob = { type: 'image/png', size: 123 };
    const file = createCrewInviteQrFile(blob, FakeFile);
    assert.equal(file.name, CREW_INVITE_QR_FILENAME);
    assert.equal(file.type, 'image/png');
    assert.equal(canShareCrewInviteQr({
      share() {},
      canShare: ({ files }) => files[0] === file,
    }, file), true);
    assert.equal(canShareCrewInviteQr({ share() {} }, file), false);
  });

  test('distinguishes platform cancellation from an operational failure', () => {
    assert.equal(isShareCancellation({ name: 'AbortError' }), true);
    assert.equal(isShareCancellation({ name: 'NotAllowedError' }), true);
    assert.equal(isShareCancellation(new Error('offline')), false);
  });

  test('supports wrapping keyboard navigation for the three representation tabs', () => {
    assert.equal(nextInviteTabIndex({ currentIndex: 0, key: 'ArrowLeft' }), 2);
    assert.equal(nextInviteTabIndex({ currentIndex: 2, key: 'ArrowRight' }), 0);
    assert.equal(nextInviteTabIndex({ currentIndex: 1, key: 'Home' }), 0);
    assert.equal(nextInviteTabIndex({ currentIndex: 1, key: 'End' }), 2);
    assert.equal(nextInviteTabIndex({ currentIndex: 1, key: 'Space' }), 1);
  });
});
