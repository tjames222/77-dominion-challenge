import { computed, watchEffect } from 'vue';
import { useLocalStorage } from './useLocalStorage';

export type ThemeMode = 'light' | 'dark';

export function useTheme() {
  const theme = useLocalStorage<ThemeMode>('dominion:theme', 'dark');

  const isDark = computed(() => theme.value === 'dark');
  const label = computed(() => isDark.value ? 'Dark' : 'Light');

  function toggleTheme() {
    theme.value = isDark.value ? 'light' : 'dark';
  }

  watchEffect(() => {
    document.documentElement.dataset.theme = theme.value;
    document.documentElement.style.colorScheme = theme.value;
  });

  return {
    theme,
    isDark,
    label,
    toggleTheme,
  };
}
