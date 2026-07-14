const THEME_STORAGE_KEY = 'dominion:theme';
const THEME_ATTRIBUTE = 'data-theme';
const DEFAULT_THEME = 'dark';
const VALID_THEMES = new Set(['dark', 'light']);
const THEME_COLORS = {
  dark: '#0e1116',
  light: '#fbfaf7',
};

function normalizeTheme(theme) {
  return VALID_THEMES.has(theme) ? theme : DEFAULT_THEME;
}

export function readStoredTheme() {
  let storedTheme;

  try {
    const rawTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    storedTheme = rawTheme ? JSON.parse(rawTheme) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }

  return normalizeTheme(storedTheme);
}

function syncThemeChrome(theme) {
  const normalizedTheme = normalizeTheme(theme);
  document.documentElement.style.colorScheme = normalizedTheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[normalizedTheme]);
}

export function applyStoredTheme(theme = readStoredTheme()) {
  const normalizedTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalizedTheme;
  syncThemeChrome(normalizedTheme);
  return normalizedTheme;
}

export function initThemeState() {
  applyStoredTheme();

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.attributeName === THEME_ATTRIBUTE)) {
      syncThemeChrome(document.documentElement.dataset.theme);
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });

  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) applyStoredTheme();
  });

  window.addEventListener('dominion:themechange', (event) => {
    applyStoredTheme(event.detail?.theme || readStoredTheme());
  });
}
