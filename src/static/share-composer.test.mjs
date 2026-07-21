import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SHARE_FLOWS,
  executeInviteShare,
  executeSnapshotShare,
  inviteUrlFromToken,
  normalizeShareKind,
  shareCopy,
} from './share-composer.mjs';

describe('sharing composer contract', () => {
  test('offers the four intended share flows', () => {
    assert.deepEqual(Object.keys(SHARE_FLOWS), ['streak', 'progress', 'general', 'invite']);
    assert.equal(normalizeShareKind('unknown'), 'progress');
  });

  test('uses privacy-safe server presentation and opaque public URL', () => {
    assert.deepEqual(shareCopy({
      kind: 'streak',
      presentation: {
        title: '12-day Dominion app streak',
        description: 'A challenger has shown up 12 days.',
      },
      url: 'https://share.example/s/opaque',
    }), {
      title: '12-day Dominion app streak',
      text: 'A challenger has shown up 12 days.',
      url: 'https://share.example/s/opaque',
    });
  });

  test('grants the reward only after a native share resolves', async () => {
    const calls = [];
    const result = await executeSnapshotShare({
      kind: 'progress',
      method: 'native_share',
      createSnapshot: async () => {
        calls.push('snapshot');
        return { url: 'https://share.example/s/opaque', presentation: { title: 'Day 21' } };
      },
      createRewardIntent: async () => {
        calls.push('intent');
        return { completionToken: 'one-time' };
      },
      nativeShare: async () => calls.push('native'),
      completeReward: async (token) => {
        calls.push(`complete:${token}`);
        return { granted: true, points: 14, badgeKey: 'sharing' };
      },
    });

    assert.deepEqual(calls, ['snapshot', 'intent', 'native', 'complete:one-time']);
    assert.equal(result.reward.points, 14);
  });

  test('does not complete the reward when platform sharing fails', async () => {
    let completions = 0;
    await assert.rejects(executeSnapshotShare({
      kind: 'general',
      method: 'copy_link',
      createSnapshot: async () => ({ url: 'https://share.example/s/opaque' }),
      createRewardIntent: async () => ({ completionToken: 'one-time' }),
      copyText: async () => {
        throw new Error('Clipboard denied');
      },
      completeReward: async () => {
        completions += 1;
      },
    }), /Clipboard denied/);
    assert.equal(completions, 0);
  });

  test('preserves an already-earned lifetime reward after a repeated share', async () => {
    const result = await executeSnapshotShare({
      kind: 'streak',
      method: 'native_share',
      createSnapshot: async () => ({ url: 'https://share.example/s/opaque' }),
      createRewardIntent: async () => ({ eligible: false, alreadyGranted: true }),
      nativeShare: async () => undefined,
      completeReward: async () => assert.fail('an earned reward must not be completed again'),
    });

    assert.deepEqual(result.reward, { granted: false, alreadyGranted: true });
  });

  test('keeps invite rewards pending until another account redeems the invite', async () => {
    let copied = '';
    const result = await executeInviteShare({
      crew: { id: 'crew-1', name: 'Iron Men' },
      method: 'copy_link',
      createInvite: async () => ({ id: 'invite-1', token: 'secret-value' }),
      baseUrl: 'https://dominion.example/community.html',
      copyText: async (value) => {
        copied = value;
      },
    });

    assert.equal(result.rewardPendingRedemption, true);
    assert.match(copied, /^https:\/\/dominion\.example\/invite\.html#invite=/);
    assert.equal(new URL(copied).search, '');
    assert.equal(inviteUrlFromToken('secret-value', 'https://dominion.example/app/').includes('?'), false);
  });
});
