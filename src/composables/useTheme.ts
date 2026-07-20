import { computed, onScopeDispose, ref } from 'vue';

export type ThemeMode = 'dark' | 'light' | 'dominion-night';

export function useTheme() {
  const runtime = window.DominionThemeRuntime;
  const theme = ref<ThemeMode>(runtime.getActiveTheme() as ThemeMode);

  const definition = computed(() => runtime.getTheme(theme.value));
  const isDark = computed(() => definition.value?.colorScheme === 'dark');
  const label = computed(() => definition.value?.label || 'Dark');

  function syncTheme(event: Event) {
    const selectedTheme = (event as CustomEvent<{ theme?: string }>).detail?.theme;
    theme.value = runtime.resolveTheme(selectedTheme || runtime.getActiveTheme()) as ThemeMode;
  }

  function toggleTheme() {
    theme.value = runtime.toggleTheme() as ThemeMode;
  }

  function setTheme(themeId: ThemeMode) {
    theme.value = runtime.setTheme(themeId) as ThemeMode;
  }

  window.addEventListener(runtime.changeEvent, syncTheme);
  onScopeDispose(() => window.removeEventListener(runtime.changeEvent, syncTheme));

  return {
    theme,
    definition,
    isDark,
    label,
    toggleTheme,
    setTheme,
  };
}
