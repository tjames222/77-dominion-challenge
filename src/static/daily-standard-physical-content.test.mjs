import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKOUT_PLANS, workoutPlanForDate } from './daily-standard-physical-content.mjs';

test('workout recommendations are stable by date and difficulty', () => {
  const first = workoutPlanForDate('2026-07-19', 'hard', 'one');
  assert.equal(workoutPlanForDate('2026-07-19', 'hard', 'one'), first);
  assert.ok(WORKOUT_PLANS.hard.includes(first));
});

test('the two workouts use independent daily recommendations', () => {
  assert.notEqual(
    workoutPlanForDate('2026-07-19', 'medium', 'one'),
    workoutPlanForDate('2026-07-19', 'medium', 'two'),
  );
});

test('unknown difficulty safely falls back to medium guidance', () => {
  assert.equal(
    workoutPlanForDate('2026-07-19', 'not-a-level', 'one'),
    workoutPlanForDate('2026-07-19', 'medium', 'one'),
  );
});
