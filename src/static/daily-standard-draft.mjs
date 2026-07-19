export const DAILY_STANDARD_ACTION_IDS = Object.freeze([
  'bible',
  'morningPrayer',
  'worshipOnly',
  'eveningPrayer',
  'workoutOne',
  'walk',
  'workoutTwo',
]);

export const WORKOUT_IDS = Object.freeze(['one', 'two']);
export const WORKOUT_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'extreme']);

const validActionIds = new Set(DAILY_STANDARD_ACTION_IDS);
const validWorkoutIds = new Set(WORKOUT_IDS);
const validDifficulties = new Set(WORKOUT_DIFFICULTIES);

export function isDailyStandardActionId(actionId) {
  return validActionIds.has(actionId);
}

export function normalizeDailyStandardDraft(draft = {}, fallbackDate = '') {
  const completed = [...new Set(Array.isArray(draft.completed) ? draft.completed : [])]
    .filter(isDailyStandardActionId);
  const workoutDifficulty = draft.workoutDifficulty || draft.workout_difficulty || {};

  return {
    date: draft.date || draft.entry_date || fallbackDate,
    completed,
    workoutDifficulty: {
      one: validDifficulties.has(workoutDifficulty.one) ? workoutDifficulty.one : 'medium',
      two: validDifficulties.has(workoutDifficulty.two) ? workoutDifficulty.two : 'medium',
    },
    version: Math.max(Number.parseInt(draft.version, 10) || 0, 0),
    updatedAt: draft.updatedAt || draft.updated_at || null,
    locked: Boolean(draft.locked),
    submitted: Boolean(draft.submitted),
    staleWriteReconciled: Boolean(draft.staleWriteReconciled || draft.stale_write_reconciled),
  };
}

export function applyActionMutation(draft, actionId, completed) {
  if (!isDailyStandardActionId(actionId)) throw new TypeError('Choose a valid Daily Standard.');
  const normalized = normalizeDailyStandardDraft(draft);
  if (normalized.locked || normalized.submitted) throw new Error('This Daily Standards draft is locked.');
  const nextCompleted = new Set(normalized.completed);
  if (completed) nextCompleted.add(actionId);
  else nextCompleted.delete(actionId);
  return normalizeDailyStandardDraft({
    ...normalized,
    completed: [...nextCompleted],
    version: normalized.version + 1,
  });
}

export function applyWorkoutDifficultyMutation(draft, workoutId, difficulty) {
  if (!validWorkoutIds.has(workoutId)) throw new TypeError('Choose a valid workout.');
  if (!validDifficulties.has(difficulty)) throw new TypeError('Choose a valid workout difficulty.');
  const normalized = normalizeDailyStandardDraft(draft);
  if (normalized.locked || normalized.submitted) throw new Error('This Daily Standards draft is locked.');
  return normalizeDailyStandardDraft({
    ...normalized,
    workoutDifficulty: { ...normalized.workoutDifficulty, [workoutId]: difficulty },
    version: normalized.version + 1,
  });
}
