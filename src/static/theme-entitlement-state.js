import { getLocalOrSessionUser, getRewardCatalog } from './api';
import { deriveAuthorizedThemeIds } from './theme-entitlements.mjs';
import { getThemeRegistry, setThemeEntitlements } from './theme-state';

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

      const catalog = await getRewardCatalog({ limit: 100 });
      setThemeEntitlements(deriveAuthorizedThemeIds(catalog, getThemeRegistry()));
      return { authenticated: true, catalog, error: null };
    } catch (error) {
      setThemeEntitlements([]);
      return { authenticated: false, catalog: null, error };
    }
  })();

  return hydrationPromise;
}
