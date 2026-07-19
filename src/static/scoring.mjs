import { POINTS_PER_DAILY_STANDARD, calculateDailyStandardsPoints } from './point-economy.mjs';

export const ACTION_POINTS_PER_COMPLETION = POINTS_PER_DAILY_STANDARD;

export const DAILY_STANDARD_IDS = Object.freeze([
  'bible',
  'morningPrayer',
  'worshipOnly',
  'eveningPrayer',
  'workoutOne',
  'walk',
  'workoutTwo',
]);

export const DIFFICULTY_OPTIONS = Object.freeze([
  'easy',
  'medium',
  'hard',
  'extreme',
]);

export const DEFAULT_WORKOUT_DIFFICULTY = Object.freeze({
  one: 'medium',
  two: 'medium',
});

export function normalizeWorkoutDifficulty(workoutDifficulty = {}) {
  const normalizeSelection = (selection, fallback) => (
    DIFFICULTY_OPTIONS.includes(selection) ? selection : fallback
  );

  return {
    one: normalizeSelection(workoutDifficulty?.one, DEFAULT_WORKOUT_DIFFICULTY.one),
    two: normalizeSelection(workoutDifficulty?.two, DEFAULT_WORKOUT_DIFFICULTY.two),
  };
}

export function calculateCheckInScore({ completed = [] } = {}) {
  const validStandards = new Set(DAILY_STANDARD_IDS);
  const completedStandards = [...new Set(Array.isArray(completed) ? completed : [])]
    .filter((actionId) => validStandards.has(actionId));
  const actionPoints = calculateDailyStandardsPoints(completedStandards.length);

  return {
    totalPoints: actionPoints,
    workoutPoints: 0,
    actionPoints,
    bonusPoints: 0,
  };
}
