const runtime = () => {
  if (!window.DominionThemeRuntime) {
    throw new Error('Dominion theme bootstrap must load before application modules.');
  }
  return window.DominionThemeRuntime;
};

let initialized = false;

export function getThemeRegistry() {
  return runtime().themes;
}

export function getThemeDefinition(themeId) {
  return runtime().getTheme(themeId);
}

export function getActiveTheme() {
  return runtime().getActiveTheme();
}

export function readStoredTheme() {
  return runtime().readStoredTheme();
}

export function readPreferredTheme() {
  return runtime().readPreferredTheme();
}

export function applyStoredTheme(theme = readStoredTheme()) {
  return runtime().applyTheme(theme);
}

export function setTheme(themeId) {
  return runtime().setTheme(themeId);
}

export function setThemeEntitlements(themeIds) {
  return runtime().setThemeEntitlements(themeIds);
}

export function toggleTheme() {
  return runtime().toggleTheme();
}

function syncLegacyThemeToggles() {
  const activeTheme = getThemeDefinition(getActiveTheme());
  document.querySelectorAll('[data-theme-toggle], #themeToggle').forEach((toggle) => {
    toggle.textContent = `${activeTheme?.label || 'Dark'} Theme`;
  });
}

function initLegacyThemeToggles() {
  document.querySelectorAll('[data-theme-toggle], #themeToggle').forEach((toggle) => {
    if (toggle.dataset.themeToggleReady === 'true') return;
    toggle.dataset.themeToggleReady = 'true';
    toggle.addEventListener('click', toggleTheme);
  });
  syncLegacyThemeToggles();
}

export function initThemeState() {
  if (initialized) return;
  initialized = true;

  runtime().applyStoredTheme();
  initLegacyThemeToggles();

  window.addEventListener('storage', (event) => {
    if (event.key !== runtime().storageKey) return;
    runtime().applyStoredTheme({ notify: true });
  });

  window.addEventListener(runtime().changeEvent, syncLegacyThemeToggles);
}
