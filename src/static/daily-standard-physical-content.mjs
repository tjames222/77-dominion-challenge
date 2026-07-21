import { pickDailyForDate } from './daily-standard-content.mjs';

export const WORKOUT_PLANS = Object.freeze({
  easy: Object.freeze([
    '3 rounds: 10 pushups, 20 squats, 20-second plank, 10 glute bridges.',
    '3 rounds: 8 incline pushups, 12 reverse lunges per leg, 20 mountain climbers, 30-second wall sit.',
    '3 rounds: 10 chair dips, 15 air squats, 10 dead bugs per side, 45-second easy walk.',
    '3 rounds: 12 knee pushups, 20 step-ups, 20 jumping jacks, 20-second hollow hold.',
  ]),
  medium: Object.freeze([
    '4 rounds: 12 pushups, 20 squats, 12 alternating lunges per leg, 30-second plank.',
    '4 rounds: 15 pushups, 15 jump squats, 20 bicycle crunches, 40-second side plank each side.',
    '4 rounds: 10 burpees, 20 walking lunges, 15 pike pushups, 30-second squat hold.',
    '4 rounds: 12 dips, 20 air squats, 12 mountain climbers per side, 1-minute brisk walk.',
  ]),
  hard: Object.freeze([
    '5 rounds: 15 pushups, 25 squats, 20 walking lunges, 45-second plank.',
    '5 rounds: 12 burpees, 20 jump squats, 15 decline pushups, 30 bicycle crunches.',
    '5 rounds: 20 alternating lunges per leg, 15 diamond pushups, 20 mountain climbers per side, 1-minute wall sit.',
    '5 rounds: 15 pushups, 20 squat jumps, 20 sit-ups, 400-meter fast walk or jog.',
  ]),
  extreme: Object.freeze([
    '6 rounds: 20 pushups, 30 squats, 20 burpees, 60-second plank.',
    '6 rounds: 15 hand-release pushups, 25 jump squats, 20 lunges per leg, 40 mountain climbers per side.',
    '6 rounds: 20 dips, 20 pistol-squat progressions per side, 15 burpees, 90-second plank.',
    '6 rounds: 25 pushups, 30 squats, 20 tuck jumps, 1-minute sprint or fast stair climb.',
  ]),
});

export function workoutPlanForDate(dateKey, difficulty, workoutId) {
  const plans = WORKOUT_PLANS[difficulty] || WORKOUT_PLANS.medium;
  return pickDailyForDate(plans, dateKey, workoutId === 'two' ? 1 : 0);
}
