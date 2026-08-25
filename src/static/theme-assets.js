import { getActiveTheme, getThemeDefinition } from './theme-state';

const THEME_ASSET_SELECTOR = '[data-theme-asset]';

function preloadSource(source) {
  if (!source) return;
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
}

function sourceForVariant(image, variant) {
  return image.getAttribute(`data-theme-src-${variant}`);
}

function resolveImageSource(image, theme) {
  const variants = window.DominionThemeRuntime.getAssetVariants(theme.id);
  for (const variant of variants) {
    const source = sourceForVariant(image, variant);
    if (source) return source;
  }
  return image.getAttribute('src');
}

function updateImage(image, theme) {
  const source = resolveImageSource(image, theme);
  if (!source || image.getAttribute('src') === source) return;
  image.setAttribute('src', source);
}

export function syncThemeAssets() {
  const theme = getThemeDefinition(getActiveTheme());
  if (!theme) return;

  document.querySelectorAll(THEME_ASSET_SELECTOR).forEach((image) => {
    updateImage(image, theme);
    const sources = new Set();
    window.DominionThemeRuntime.themes
      .filter((candidate) => candidate.availability.enabled)
      .flatMap((candidate) => window.DominionThemeRuntime.getAssetVariants(candidate.id))
      .forEach((variant) => sources.add(sourceForVariant(image, variant)));
    sources.delete(image.getAttribute('src'));
    sources.forEach(preloadSource);
  });
}

export function initThemeAssets() {
  syncThemeAssets();
  window.addEventListener(window.DominionThemeRuntime.changeEvent, syncThemeAssets);
}
