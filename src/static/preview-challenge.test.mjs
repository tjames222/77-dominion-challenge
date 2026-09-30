import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addCheckInDate, createCheckInCache, normalizeChallengeDays } from './check-in.mjs';
import {
  advancePreviewChallenge,
  advancePreviewStreaks,
  addPreviewCalendarDays,
  isPreviewChallengeActive,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDate,
  previewChallengeDay,
  setPreviewChallengeEnabled,
} from './preview-challenge.mjs';

describe('preview 77-day challenge simulator', () => {
  it('normalizes invalid persisted state and cannot activate outside local preview', () => {
    const state = normalizePreviewChallengeState({ enabled: true, anchorDate: 'bad', day: 200 }, '2026-07-18');
    assert.deepEqual(state, { enabled: true, anchorDate: '2026-07-18', day: 200 });
    assert.equal(isPreviewChallengeComplete(state), false, 'an old day counter is not completion evidence');
    assert.equal(isPreviewChallengeActive(false, state), false);
    assert.equal(isPreviewChallengeActive(true, state), true);
  });

  it('crosses month, leap-day, year, and daylight-saving boundaries with calendar dates', () => {
    assert.equal(addPreviewCalendarDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addPreviewCalendarDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addPreviewCalendarDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addPreviewCalendarDays('2026-03-07', 2), '2026-03-09');
  });

  it('produces 77 unique protected date and challenge-day pairs', () => {
    let state = setPreviewChallengeEnabled({}, true, '2026-07-18');
    let cache = createCheckInCache('preview-simulator');
    const dates = [];

    for (let day = 1; day <= 77; day += 1) {
      const date = previewChallengeDate(state);
      const dateResult = addCheckInDate(cache.dates, date);
      assert.equal(dateResult.added, true, `Day ${day} should use a new date`);
      cache = createCheckInCache('preview-simulator', dateResult.dates, [
        ...cache.challengeDays,
        previewChallengeDay(state),
      ]);
      dates.push(date);
      state = advancePreviewChallenge(state, { submittedCount: day, completionState: day === 77 ? 'live_completed' : 'in_progress' });
    }

    assert.equal(new Set(dates).size, 77);
    assert.deepEqual(normalizeChallengeDays(cache.challengeDays), Array.from({ length: 77 }, (_, index) => 77 - index));
    assert.equal(isPreviewChallengeComplete(state, { submittedCount: 77, completionState: 'live_completed' }), true);
    assert.equal(previewChallengeDay(state), 77);
    assert.equal(previewChallengeDate(state), dates[76]);
    assert.equal(addCheckInDate(cache.dates, dates[76]).added, false);
  });

  it('pauses without losing the current simulated day', () => {
    const dayTwo = advancePreviewChallenge(setPreviewChallengeEnabled({}, true, '2026-07-18'));
    const paused = setPreviewChallengeEnabled(dayTwo, false, '2026-07-18');
    assert.equal(advancePreviewChallenge(paused).day, 2);
    assert.equal(setPreviewChallengeEnabled(paused, true, '2026-07-18').day, 2);
  });

  it('continues after calendar day77 until the canonical submitted count reaches77', () => {
    const state = normalizePreviewChallengeState({ enabled: true, anchorDate: '2026-01-01', day: 91 });
    assert.equal(previewChallengeDay(state), 91);
    assert.equal(previewChallengeDate(state), '2026-04-01');
    const partial = { submittedCount: 76, completionState: 'in_progress' };
    assert.equal(isPreviewChallengeComplete(state, partial), false);
    assert.equal(advancePreviewChallenge(state, partial).day, 92);
    for (const completionState of ['live_completed', 'historical_provenance_pending']) {
      const complete = { submittedCount: 77, completionState };
      assert.equal(isPreviewChallengeComplete(state, complete), true);
      assert.equal(advancePreviewChallenge(state, complete).day, 91);
    }
    assert.equal(isPreviewChallengeComplete(state, { submittedCount: '77', completionState: 'live_completed' }), false);
  });

  it('advances the app streak on every post and keeps production full-streak continuity', () => {
    const partial = advancePreviewStreaks({
      currentAppStreak: 2,
      bestAppStreak: 2,
      currentFullDayStreak: 1,
      bestFullDayStreak: 1,
      lastFullDayDate: '2026-07-17',
    }, 'partial', '2026-07-18');
    assert.deepEqual(partial, {
      currentAppStreak: 3,
      bestAppStreak: 3,
      currentFullDayStreak: 1,
      bestFullDayStreak: 1,
      lastFullDayDate: '2026-07-17',
    });
    const secondPartial = advancePreviewStreaks(partial, 'partial', '2026-07-19');
    assert.equal(secondPartial.currentAppStreak, 4);
    assert.equal(secondPartial.currentFullDayStreak, 1);
    assert.equal(secondPartial.lastFullDayDate, '2026-07-17');

    const complete = advancePreviewStreaks(secondPartial, 'complete', '2026-07-20');
    assert.equal(complete.currentAppStreak, 5);
    assert.equal(complete.currentFullDayStreak, 1);
    assert.equal(complete.bestFullDayStreak, 1);
    assert.equal(complete.lastFullDayDate, '2026-07-20');

    const consecutive = advancePreviewStreaks(complete, 'complete', '2026-07-21');
    assert.equal(consecutive.currentFullDayStreak, 2);
    assert.equal(consecutive.bestFullDayStreak, 2);

    let fullRun = {};
    for (let day = 1; day <= 77; day += 1) {
      fullRun = advancePreviewStreaks(fullRun, 'complete', addPreviewCalendarDays('2026-07-18', day - 1));
    }
    assert.equal(fullRun.currentAppStreak, 77);
    assert.equal(fullRun.currentFullDayStreak, 77);
  });
});
