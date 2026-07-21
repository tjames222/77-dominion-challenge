import {
  getLocalOrSessionUser,
  getRewardCatalog,
  getThemePreference,
  setThemePreference,
} from './api';
import { deriveAuthorizedThemeIds } from './theme-entitlements.mjs';
import {
  getThemeRegistry,
  readPreferredTheme,
  setTheme,
  setThemeEntitlements,
} from './theme-state';

let hydrationPromise = null;

export function clearThemeEntitlementState() {
  hydrationPromise = null;
  setThemeEntitlements([]);
}

export function hydrateThemeEntitlementState() {
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = (async () => {
    setThemeEntitlements([]);
    try {
      const user = await getLocalOrSessionUser();
      if (!user?.authenticated) {
        return { authenticated: false, catalog: null, error: null };
      }

      const [catalog, preference] = await Promise.all([
        getRewardCatalog({ limit: 100 }),
        getThemePreference(),
      ]);
      const registry = getThemeRegistry();
      setThemeEntitlements(deriveAuthorizedThemeIds(catalog, registry));

      let preferredTheme = preference.themeKey;
      if (!preferredTheme) {
        const localPreference = readPreferredTheme();
        const localDefinition = registry.find((theme) => theme.id === localPreference);
        preferredTheme = localDefinition && !localDefinition.availability.requiresEntitlement
          ? localPreference
          : 'dark';
        try {
          await setThemePreference(preferredTheme);
        } catch (preferenceError) {
          console.warn('Unable to migrate the local theme preference', preferenceError);
        }
      }
      setTheme(preferredTheme);
      return { authenticated: true, catalog, preference, error: null };
    } catch (error) {
      setThemeEntitlements([]);
      return { authenticated: false, catalog: null, error };
    }
  })();

  return hydrationPromise;
}
