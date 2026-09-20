import { getActiveTheme, getThemeDefinition } from './theme-state';

const THEME_ASSET_SELECTOR = '[data-theme-asset]';

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
  });
}

export function initThemeAssets() {
  syncThemeAssets();
  window.addEventListener(window.DominionThemeRuntime.changeEvent, syncThemeAssets);
}
