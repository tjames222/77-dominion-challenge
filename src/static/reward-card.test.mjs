import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderRewardCard } from './reward-card.mjs';

const baseReward = {
  key: 'prayer_track',
  title: 'Prayer Track',
  description: 'A focused challenge.',
  rewardType: 'challenge',
  stateModel: 'challenge_lifecycle',
  status: 'locked',
  statusLabel: 'Locked',
  detail: '10 points remaining',
  pointsRequired: 20,
  currentPoints: 10,
  progressPercent: 50,
  iconClass: 'icon-spark',
  active: true,
  metadata: { challengeType: 'spiritual' },
};

describe('shared reward-card renderer', () => {
  it('gives every state the same explicit View Progress dialog action', () => {
    for (const [status, statusLabel, detail] of [
      ['locked', 'Locked', '10 points remaining'],
      ['active', 'In progress', 'Challenge in progress'],
      ['completed', 'Completed', 'Challenge completed'],
      ['owned', 'Owned', 'Permanently owned'],
    ]) {
      const markup = renderRewardCard({
        ...baseReward,
        status,
        statusLabel,
        detail,
      });

      assert.match(markup, /<article class="reward-row/);
      assert.match(markup, /<button class="reward-action-link reward-progress-action"/);
      assert.match(markup, /data-view-reward="prayer_track"/);
      assert.match(markup, /aria-controls="rewardDetailDialog"/);
      assert.match(markup, />View Progress<\/button>/);
      assert.match(markup, new RegExp(statusLabel, 'i'));
      assert.match(markup, new RegExp(detail, 'i'));
      assert.doesNotMatch(markup, /<article[^>]+role="button"/);
    }
  });

  it('keeps contextual Start and Select actions alongside View Progress', () => {
    const startMarkup = renderRewardCard({
      ...baseReward,
      status: 'available',
      statusLabel: 'Available',
      detail: 'Ready to start',
      canStart: true,
    });
    const selectionMarkup = renderRewardCard({
      ...baseReward,
      status: 'owned',
      statusLabel: 'Owned',
      detail: 'Permanently owned',
      canStart: false,
      selectionHref: './profile.html#appearance',
      selectionLabel: 'Select in Profile',
    });

    assert.match(startMarkup, /data-start-reward="prayer_track"/);
    assert.match(startMarkup, />Start challenge<\/button>/);
    assert.match(startMarkup, />View Progress<\/button>/);
    assert.match(selectionMarkup, /href="\.\/profile\.html#appearance"/);
    assert.match(selectionMarkup, />Select in Profile<\/a>/);
    assert.match(selectionMarkup, />View Progress<\/button>/);
  });

  it('escapes reward content and exposes exact locked progress semantics', () => {
    const markup = renderRewardCard({
      ...baseReward,
      title: '<Unsafe & reward>',
    });

    assert.doesNotMatch(markup, /<Unsafe/);
    assert.match(markup, /&lt;Unsafe &amp; reward&gt;/);
    assert.match(markup, /role="progressbar"/);
    assert.match(markup, /aria-valuenow="10"/);
    assert.match(markup, /aria-valuetext="10 of 20 points"/);
  });
});
