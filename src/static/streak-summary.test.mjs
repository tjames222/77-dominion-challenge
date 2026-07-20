import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  STREAK_METRIC_DEFINITIONS,
  buildStreakSummary,
  dayUnit,
  normalizeStreakValue,
  preserveBestStreaks,
  streakIndicatorLabel,
  streakMetrics,
} from './streak-summary.mjs';

describe('Dashboard streak summary', () => {
  test('normalizes invalid streak values without changing streak rules', () => {
    [undefined, null, '', true, [4], -4, Number.NaN, Number.POSITIVE_INFINITY].forEach((value) => {
      assert.equal(normalizeStreakValue(value), 0);
    });
    assert.equal(normalizeStreakValue(4.9), 4);
    assert.equal(normalizeStreakValue('12'), 12);
  });

  test('never lets a personal best decrease across a stale refresh', () => {
    const previous = {
      currentAppStreak: 12,
      bestAppStreak: 20,
      currentFullDayStreak: 8,
      bestFullDayStreak: 14,
    };
    const next = preserveBestStreaks({
      currentAppStreak: 0,
      bestAppStreak: 3,
      currentFullDayStreak: 0,
      bestFullDayStreak: 2,
      totalPoints: 77,
    }, previous);

    assert.deepEqual(next, {
      currentAppStreak: 0,
      bestAppStreak: 20,
      currentFullDayStreak: 0,
      bestFullDayStreak: 14,
      totalPoints: 77,
    });
  });

  test('keeps each best at least as high as its current streak', () => {
    assert.deepEqual(preserveBestStreaks({
      currentAppStreak: 9,
      bestAppStreak: 4,
      currentFullDayStreak: 6,
      bestFullDayStreak: 1,
    }), {
      currentAppStreak: 9,
      bestAppStreak: 9,
      currentFullDayStreak: 6,
      bestFullDayStreak: 6,
    });
  });

  test('maps the existing full-day source to Full standard terminology', () => {
    const active = buildStreakSummary({
      currentAppStreak: 5,
      bestAppStreak: 7,
      currentFullDayStreak: 3,
      bestFullDayStreak: 9,
      lastFullDayDate: '2026-07-18',
    }, '2026-07-19');
    const expired = buildStreakSummary({
      currentAppStreak: 0,
      bestAppStreak: 7,
      currentFullDayStreak: 3,
      bestFullDayStreak: 9,
      lastFullDayDate: '2026-07-17',
    }, '2026-07-19');

    assert.deepEqual(active, {
      currentFullStandardStreak: 3,
      bestFullStandardStreak: 9,
      currentAppStreak: 5,
      bestAppStreak: 7,
      hasHistory: true,
    });
    assert.equal(expired.currentFullStandardStreak, 0);
    assert.equal(expired.bestFullStandardStreak, 9);
  });

  test('provides a clear zero state and consistent accessible units', () => {
    const summary = buildStreakSummary({}, '2026-07-19');
    assert.equal(summary.hasHistory, false);
    assert.equal(streakIndicatorLabel(summary), 'App streak: 0 days. View streak details.');
    assert.equal(dayUnit(1), 'day');
    assert.equal(dayUnit(2), 'days');
  });

  test('keeps all four modal metrics in the required order', () => {
    assert.deepEqual(STREAK_METRIC_DEFINITIONS.map(({ label, kind }) => [label, kind]), [
      ['Full standard streak', 'Current'],
      ['Best full standard streak', 'Personal best'],
      ['App streak', 'Current'],
      ['Best app streak', 'Personal best'],
    ]);
    assert.deepEqual(streakMetrics({
      currentFullStandardStreak: 1,
      bestFullStandardStreak: 4,
      currentAppStreak: 2,
      bestAppStreak: 8,
    }).map(({ value, unit }) => [value, unit]), [
      [1, 'day'],
      [4, 'days'],
      [2, 'days'],
      [8, 'days'],
    ]);
  });
});
