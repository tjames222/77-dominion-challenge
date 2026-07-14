export const ACTION_POINTS_PER_COMPLETION = 10;

export const STATUS_BONUS_POINTS = Object.freeze({
  complete: 30,
  partial: 10,
  scheduled: 15,
});

export const DEFAULT_DIFFICULTY_POINT_VALUES = Object.freeze({
  easy: 2,
  medium: 5,
  hard: 10,
  extreme: 15,
});

export const DIFFICULTY_OPTIONS = Object.freeze(
  Object.keys(DEFAULT_DIFFICULTY_POINT_VALUES),
);

export const DEFAULT_WORKOUT_DIFFICULTY = Object.freeze({
  one: 'medium',
  two: 'medium',
});

const workoutStandards = Object.freeze({
  one: 'workoutOne',
  two: 'workoutTwo',
});

const validPointValue = (value) => Number.isInteger(value) && value >= 0;

export function normalizeDifficultyPointValues(difficultyPointValues = {}) {
  return Object.freeze(Object.fromEntries(
    Object.entries(DEFAULT_DIFFICULTY_POINT_VALUES).map(([difficulty, defaultPoints]) => [
      difficulty,
      validPointValue(difficultyPointValues?.[difficulty])
        ? difficultyPointValues[difficulty]
        : defaultPoints,
    ]),
  ));
}

export function normalizeWorkoutDifficulty(workoutDifficulty = {}) {
  const normalizeSelection = (selection, fallback) => (
    DIFFICULTY_OPTIONS.includes(selection) ? selection : fallback
  );

  return {
    one: normalizeSelection(workoutDifficulty?.one, DEFAULT_WORKOUT_DIFFICULTY.one),
    two: normalizeSelection(workoutDifficulty?.two, DEFAULT_WORKOUT_DIFFICULTY.two),
  };
}

function calculateWorkoutPoints({
  completed = [],
  workoutDifficulty = DEFAULT_WORKOUT_DIFFICULTY,
  difficultyPointValues = DEFAULT_DIFFICULTY_POINT_VALUES,
} = {}) {
  const completedStandards = Array.isArray(completed) ? completed : [];
  const pointValues = normalizeDifficultyPointValues(difficultyPointValues);
  const normalizedDifficulty = normalizeWorkoutDifficulty(workoutDifficulty);

  return Object.entries(workoutStandards).reduce((total, [workout, standard]) => (
    completedStandards.includes(standard)
      ? total + pointValues[normalizedDifficulty[workout]]
      : total
  ), 0);
}

export function calculateCheckInScore({
  completed = [],
  status,
  workoutDifficulty = DEFAULT_WORKOUT_DIFFICULTY,
  difficultyPointValues = DEFAULT_DIFFICULTY_POINT_VALUES,
} = {}) {
  const completedStandards = Array.isArray(completed) ? completed : [];
  const actionPoints = completedStandards.length * ACTION_POINTS_PER_COMPLETION;
  const bonusPoints = STATUS_BONUS_POINTS[status] || 0;
  const workoutPoints = calculateWorkoutPoints({
    completed: completedStandards,
    workoutDifficulty,
    difficultyPointValues,
  });

  return {
    totalPoints: actionPoints + bonusPoints + workoutPoints,
    workoutPoints,
    actionPoints,
    bonusPoints,
  };
}
