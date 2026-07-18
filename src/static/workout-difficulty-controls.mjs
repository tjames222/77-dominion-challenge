export function syncWorkoutDifficultyControls(controls, workoutDifficulty) {
  controls.forEach((control) => {
    const selectedDifficulty = workoutDifficulty[control.dataset.workout];

    if (control.type === 'radio') {
      control.checked = control.value === selectedDifficulty;
      return;
    }

    control.value = selectedDifficulty;
  });
}
