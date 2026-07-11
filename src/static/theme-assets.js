const THEME_ATTRIBUTE = 'data-theme';
const THEME_ASSET_SELECTOR = '[data-theme-src-dark][data-theme-src-light]';

function getActiveTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function preloadSource(source) {
  if (!source) return;
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
}

function updateImage(image, theme) {
  const source = theme === 'light'
    ? image.dataset.themeSrcLight
    : image.dataset.themeSrcDark;

  if (!source || image.getAttribute('src') === source) return;
  image.src = source;
}

export function syncThemeAssets() {
  const theme = getActiveTheme();
  document.querySelectorAll(THEME_ASSET_SELECTOR).forEach((image) => {
    updateImage(image, theme);
    const alternateSource = theme === 'light'
      ? image.dataset.themeSrcDark
      : image.dataset.themeSrcLight;
    preloadSource(alternateSource);
  });
}

export function initThemeAssets() {
  syncThemeAssets();

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.attributeName === THEME_ATTRIBUTE)) {
      syncThemeAssets();
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });

  window.addEventListener('storage', (event) => {
    if (event.key === 'dominion:theme') syncThemeAssets();
  });

  window.addEventListener('dominion:themechange', syncThemeAssets);
}
