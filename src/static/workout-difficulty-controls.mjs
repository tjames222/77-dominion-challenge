export function syncWorkoutDifficultyControls(controls, workoutDifficulty) {
  controls.forEach((control) => {
    control.value = workoutDifficulty[control.dataset.workout];
  });
}
