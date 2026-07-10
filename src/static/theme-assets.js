const themedAssetSelector = 'img[data-theme-src-dark][data-theme-src-light]';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyThemeAssets(root = document) {
  const theme = currentTheme();
  const sourceAttribute = theme === 'light' ? 'data-theme-src-light' : 'data-theme-src-dark';

  root.querySelectorAll(themedAssetSelector).forEach((image) => {
    const nextSource = image.getAttribute(sourceAttribute);
    if (nextSource && image.getAttribute('src') !== nextSource) {
      image.setAttribute('src', nextSource);
    }
  });
}

export function initThemeAssets() {
  applyThemeAssets();

  const observer = new MutationObserver(() => applyThemeAssets());
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}
