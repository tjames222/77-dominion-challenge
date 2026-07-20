import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHECK_IN_ALREADY_COMPLETE_CODE,
  CHECK_IN_ALREADY_COMPLETE_MESSAGE,
  CHECK_IN_SUBMISSION_COOLDOWN_MS,
  addCheckInDate,
  calendarDayDifference,
  canStartCheckInSubmission,
  checkInCacheForOwner,
  createCheckInCache,
  createCheckInAlreadyCompleteError,
  currentFullDayStreakForDate,
  dateKeyForTimeZone,
  isDuplicateCheckInError,
  normalizeChallengeDays,
  normalizeCheckInDates,
} from './check-in.mjs';

describe('daily check-in safeguards', () => {
  it('uses the user calendar day instead of the UTC date near midnight', () => {
    assert.equal(dateKeyForTimeZone('2026-07-17T06:30:00.000Z', 'America/Los_Angeles'), '2026-07-16');
    assert.equal(dateKeyForTimeZone('2026-07-16T15:30:00.000Z', 'Asia/Tokyo'), '2026-07-17');
  });

  it('calculates challenge days without daylight-saving drift', () => {
    assert.equal(calendarDayDifference('2026-11-02', '2026-10-31'), 2);
    assert.equal(calendarDayDifference('2026-03-09', '2026-03-07'), 2);
  });

  it('resets the visible full-day streak after an unsubmitted day passes', () => {
    const stats = { currentFullDayStreak: 6, lastFullDayDate: '2026-07-17' };
    assert.equal(currentFullDayStreakForDate(stats, '2026-07-17'), 6);
    assert.equal(currentFullDayStreakForDate(stats, '2026-07-18'), 6);
    assert.equal(currentFullDayStreakForDate(stats, '2026-07-19'), 0);
    assert.equal(currentFullDayStreakForDate({ currentFullDayStreak: 6 }, '2026-07-19'), 0);
  });

  it('normalizes and records a submitted date only once', () => {
    assert.deepEqual(normalizeCheckInDates(['2026-07-15', 'bad', '2026-07-16', '2026-07-16']), [
      '2026-07-16',
      '2026-07-15',
    ]);
    assert.deepEqual(addCheckInDate(['2026-07-15'], '2026-07-16'), {
      dates: ['2026-07-16', '2026-07-15'],
      added: true,
    });
    assert.deepEqual(addCheckInDate(['2026-07-16'], '2026-07-16'), {
      dates: ['2026-07-16'],
      added: false,
    });
  });

  it('scopes cached submissions to the signed-in account', () => {
    const cache = createCheckInCache('user-a', ['2026-07-16'], [4, 4, 0, 78]);
    assert.deepEqual(cache, {
      owner: 'user-a',
      dates: ['2026-07-16'],
      challengeDays: [4],
    });
    assert.deepEqual(checkInCacheForOwner(cache, 'user-a'), cache);
    assert.deepEqual(checkInCacheForOwner(cache, 'user-b'), {
      owner: 'user-b',
      dates: [],
      challengeDays: [],
    });
    assert.deepEqual(normalizeChallengeDays([2, '2', 1, 0, 78, 'bad']), [2, 1]);
  });

  it('recognizes only the daily check-in uniqueness failure', () => {
    assert.equal(isDuplicateCheckInError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "check_ins_user_entry_date_unique_idx"',
    }), true);
    assert.equal(isDuplicateCheckInError({
      code: '23505',
      details: 'Key (user_id, challenge_day) already exists.',
    }), true);
    assert.equal(isDuplicateCheckInError({ code: '23505', message: 'duplicate primary key' }), false);
    assert.equal(isDuplicateCheckInError({ code: '42501', message: 'permission denied' }), false);
  });

  it('maps duplicate attempts to clear non-destructive feedback', () => {
    const error = createCheckInAlreadyCompleteError(new Error('duplicate'));
    assert.equal(error.code, CHECK_IN_ALREADY_COMPLETE_CODE);
    assert.equal(error.message, CHECK_IN_ALREADY_COMPLETE_MESSAGE);
    assert.equal(error.cause.message, 'duplicate');
  });

  it('rejects rapid repeat submissions without blocking the next intentional post', () => {
    assert.equal(canStartCheckInSubmission(1_000, 1_100), false);
    assert.equal(canStartCheckInSubmission(1_000, 1_000 + CHECK_IN_SUBMISSION_COOLDOWN_MS), true);
    assert.equal(canStartCheckInSubmission(0, 1), true);
  });
});
