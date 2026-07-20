(function bootstrapDominionTheme(global) {
  'use strict';

  if (global.DominionThemeRuntime) {
    global.DominionThemeRuntime.applyStoredTheme();
    return;
  }

  var STORAGE_KEY = 'dominion:theme';
  var ROOT_ATTRIBUTE = 'data-theme';
  var DEFAULT_THEME_ID = 'dark';
  var CHANGE_EVENT = 'dominion:themechange';
  var NIGHT_FEATURE_FLAG = 'VITE_ENABLE_DOMINION_NIGHT_THEME';
  var featureScript = global.document && global.document.currentScript;
  var dominionNightEnabled = Boolean(
    featureScript &&
      featureScript.dataset &&
      featureScript.dataset.enableDominionNight === 'true',
  );

  function freezeTheme(definition) {
    Object.freeze(definition.assets);
    Object.freeze(definition.availability);
    return Object.freeze(definition);
  }

  var themes = Object.freeze([
    freezeTheme({
      id: 'dark',
      label: 'Dark',
      colorScheme: 'dark',
      themeColor: '#0e1116',
      assets: { variant: 'dark', fallback: 'dark' },
      availability: {
        kind: 'public',
        enabled: true,
        featureFlag: null,
        requiresEntitlement: false,
      },
    }),
    freezeTheme({
      id: 'light',
      label: 'Light',
      colorScheme: 'light',
      themeColor: '#fbfaf7',
      assets: { variant: 'light', fallback: 'light' },
      availability: {
        kind: 'public',
        enabled: true,
        featureFlag: null,
        requiresEntitlement: false,
      },
    }),
    freezeTheme({
      id: 'dominion-night',
      label: 'Dominion Night',
      colorScheme: 'dark',
      themeColor: '#071317',
      assets: { variant: 'dominion-night', fallback: 'dark' },
      availability: {
        kind: 'feature-flag',
        enabled: dominionNightEnabled,
        featureFlag: NIGHT_FEATURE_FLAG,
        requiresEntitlement: true,
      },
    }),
  ]);
  var themeById = Object.freeze(
    themes.reduce(function indexTheme(index, theme) {
      index[theme.id] = theme;
      return index;
    }, Object.create(null)),
  );

  function getTheme(themeId) {
    return typeof themeId === 'string' ? themeById[themeId] || null : null;
  }

  function isThemeAvailable(themeId) {
    var theme = getTheme(themeId);
    return Boolean(theme && theme.availability.enabled);
  }

  function resolveTheme(themeId) {
    return isThemeAvailable(themeId) ? themeId : DEFAULT_THEME_ID;
  }

  function parseStoredTheme(rawTheme) {
    if (!rawTheme) return DEFAULT_THEME_ID;
    try {
      var parsed = JSON.parse(rawTheme);
      return typeof parsed === 'string' ? parsed : DEFAULT_THEME_ID;
    } catch (_error) {
      return rawTheme;
    }
  }

  function readStoredTheme() {
    try {
      return resolveTheme(parseStoredTheme(global.localStorage.getItem(STORAGE_KEY)));
    } catch (_error) {
      return DEFAULT_THEME_ID;
    }
  }

  function syncBrowserChrome(theme) {
    if (!global.document) return;
    global.document.documentElement.style.colorScheme = theme.colorScheme;
    var themeColor = global.document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', theme.themeColor);
  }

  function dispatchThemeChange(theme) {
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
    global.dispatchEvent(new global.CustomEvent(CHANGE_EVENT, {
      detail: { theme: theme.id, definition: theme },
    }));
  }

  function applyTheme(themeId, options) {
    var resolvedId = resolveTheme(themeId);
    var theme = getTheme(resolvedId);
    if (!global.document || !theme) return DEFAULT_THEME_ID;

    global.document.documentElement.setAttribute(ROOT_ATTRIBUTE, resolvedId);
    syncBrowserChrome(theme);
    if (options && options.notify) dispatchThemeChange(theme);
    return resolvedId;
  }

  function applyStoredTheme(options) {
    return applyTheme(readStoredTheme(), options);
  }

  function setTheme(themeId) {
    var resolvedId = resolveTheme(themeId);
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(resolvedId));
    } catch (_error) {
      // Storage can be unavailable in privacy modes; the active page still updates.
    }
    return applyTheme(resolvedId, { notify: true });
  }

  function getActiveTheme() {
    if (!global.document) return DEFAULT_THEME_ID;
    return resolveTheme(global.document.documentElement.getAttribute(ROOT_ATTRIBUTE));
  }

  function getAssetVariants(themeId) {
    var theme = getTheme(resolveTheme(themeId));
    if (!theme) return ['dark'];
    return theme.assets.variant === theme.assets.fallback
      ? [theme.assets.variant]
      : [theme.assets.variant, theme.assets.fallback];
  }

  function toggleTheme() {
    return setTheme(getActiveTheme() === 'light' ? 'dark' : 'light');
  }

  var runtime = Object.freeze({
    version: 1,
    storageKey: STORAGE_KEY,
    rootAttribute: ROOT_ATTRIBUTE,
    changeEvent: CHANGE_EVENT,
    defaultThemeId: DEFAULT_THEME_ID,
    themes: themes,
    getTheme: getTheme,
    isThemeAvailable: isThemeAvailable,
    resolveTheme: resolveTheme,
    readStoredTheme: readStoredTheme,
    applyTheme: applyTheme,
    applyStoredTheme: applyStoredTheme,
    setTheme: setTheme,
    getActiveTheme: getActiveTheme,
    getAssetVariants: getAssetVariants,
    toggleTheme: toggleTheme,
  });

  Object.defineProperty(global, 'DominionThemeRuntime', {
    value: runtime,
    configurable: false,
    enumerable: true,
    writable: false,
  });

  runtime.applyStoredTheme();
})(globalThis);
