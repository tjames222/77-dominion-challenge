import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFulfillmentDialogModel,
  isFulfillmentReward,
  normalizeRewardFulfillment,
  safeHttpsUrl,
} from './reward-fulfillment.mjs';

describe('reward fulfillment client contract', () => {
  it('recognizes only secure fulfillment reward kinds', () => {
    assert.equal(isFulfillmentReward({ rewardType: 'partner_discount' }), true);
    assert.equal(isFulfillmentReward({ rewardType: 'merch_discount' }), true);
    assert.equal(isFulfillmentReward({ rewardType: 'digital_download' }), true);
    assert.equal(isFulfillmentReward({ rewardType: 'cosmetic' }), false);
  });

  it('accepts HTTPS destinations and rejects unsafe schemes', () => {
    assert.equal(safeHttpsUrl('https://gym.example/path'), 'https://gym.example/path');
    assert.equal(safeHttpsUrl('http://gym.example'), null);
    assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
  });

  it('redacts codes unless the trusted response is already claimed', () => {
    assert.equal(normalizeRewardFulfillment({ status: 'unclaimed', code: 'LEAK' }).code, '');
    assert.equal(normalizeRewardFulfillment({ status: 'claimed', code: 'SAFE-OWNER' }).code, 'SAFE-OWNER');
  });

  it('defaults format only for digital downloads', () => {
    assert.equal(normalizeRewardFulfillment({ rewardType: 'digital_download' }).format, 'PDF');
    assert.equal(normalizeRewardFulfillment({ rewardType: 'partner_discount' }).format, '');
    assert.equal(normalizeRewardFulfillment({ rewardType: 'merch_discount' }).format, '');
  });

  it('keeps unavailable earned rewards permanent and actionable only when configured', () => {
    const unavailable = buildFulfillmentDialogModel({
      key: 'gym_training_discount', rewardType: 'partner_discount', status: 'owned', title: 'Gym',
    }, { availability: 'unavailable' });
    const configured = buildFulfillmentDialogModel({
      key: 'shirt', rewardType: 'merch_discount', status: 'owned', title: 'Shirt',
    }, { availability: 'available', status: 'unclaimed', destinationUrl: 'https://shop.example' });
    assert.equal(unavailable.owned, true);
    assert.equal(unavailable.canClaim, false);
    assert.match(unavailable.message, /permanently own/i);
    assert.equal(configured.canClaim, true);
    assert.equal(configured.destinationUrl, 'https://shop.example/');
  });

  it('shows an active gym website while locked without exposing redemption', () => {
    const model = buildFulfillmentDialogModel({
      key: 'gym_training_discount',
      rewardType: 'partner_discount',
      status: 'locked',
      title: 'Gym Training Discount',
      pointsRemaining: 3,
    }, {
      availability: 'available',
      status: 'locked',
      websiteUrl: 'https://gym.example',
      destinationUrl: 'https://gym.example/redeem',
    });

    assert.equal(model.canVisitWebsite, true);
    assert.equal(model.websiteUrl, 'https://gym.example/');
    assert.equal(model.canVisitDestination, false);
    assert.equal(model.canClaim, false);
  });

  it('reveals an existing claim only through the trusted claim RPC', () => {
    const claimedWithoutCode = buildFulfillmentDialogModel({
      key: 'shirt', rewardType: 'merch_discount', status: 'owned', title: 'Shirt',
    }, { availability: 'available', status: 'claimed', destinationUrl: 'https://shop.example/redeem' });
    const claimedWithCode = buildFulfillmentDialogModel({
      key: 'shirt', rewardType: 'merch_discount', status: 'owned', title: 'Shirt',
    }, { availability: 'available', status: 'claimed', code: 'OWNER-CODE', destinationUrl: 'https://shop.example/redeem' });

    assert.equal(claimedWithoutCode.canReveal, true);
    assert.equal(claimedWithoutCode.canVisitDestination, true);
    assert.equal(claimedWithCode.canReveal, false);
    assert.equal(claimedWithCode.canCopy, true);
  });
});
