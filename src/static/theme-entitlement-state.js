import {
  getLocalOrSessionUser,
  getRewardCatalog,
  getThemePreference,
  setThemePreference,
} from './api';
import { deriveAuthorizedThemeIds } from './theme-entitlements.mjs';
import {
  finishProtectedThemeHydration,
  getThemeRegistry,
  readPreferredTheme,
  setTheme,
  setThemeEntitlements,
} from './theme-state';

let hydrationPromise = null;
let hydrationActorId = '';
let hydrationEpoch = 0;

const staleHydrationError = () => Object.assign(
  new Error('The signed-in account changed. Try again.'),
  { code: 'STALE_THEME_ACTOR' },
);

async function assertHydrationActor(actorId, epoch) {
  if (!actorId || epoch !== hydrationEpoch || hydrationActorId !== actorId) {
    throw staleHydrationError();
  }
  const currentUser = await getLocalOrSessionUser();
  if (
    epoch !== hydrationEpoch
    || hydrationActorId !== actorId
    || !currentUser?.authenticated
    || currentUser.userId !== actorId
  ) throw staleHydrationError();
}

export function clearThemeEntitlementState() {
  hydrationEpoch += 1;
  hydrationPromise = null;
  hydrationActorId = '';
  setThemeEntitlements([]);
}

export async function hydrateThemeEntitlementState({ expectedUserId = '' } = {}) {
  const initialUser = await getLocalOrSessionUser();
  const initialActorId = initialUser?.authenticated ? String(initialUser.userId || '') : '';
  if (!initialActorId || (expectedUserId && initialActorId !== expectedUserId)) {
    clearThemeEntitlementState();
    return {
      authenticated: false,
      catalog: null,
      error: expectedUserId ? staleHydrationError() : null,
    };
  }

  if (hydrationPromise && hydrationActorId === initialActorId) return hydrationPromise;
  if (hydrationPromise || hydrationActorId) clearThemeEntitlementState();

  const epoch = ++hydrationEpoch;
  hydrationActorId = initialActorId;

  hydrationPromise = (async () => {
    setThemeEntitlements([], { deferPending: true });
    try {
      await assertHydrationActor(initialActorId, epoch);

      const [catalog, preference] = await Promise.all([
        getRewardCatalog({ limit: 100, expectedUserId: initialActorId }),
        getThemePreference({ expectedUserId: initialActorId }),
      ]);
      await assertHydrationActor(initialActorId, epoch);
      const registry = getThemeRegistry();
      const authorizedThemeIds = deriveAuthorizedThemeIds(catalog, registry);

      let preferredTheme = preference.themeKey;
      if (!preferredTheme) {
        const localPreference = readPreferredTheme();
        const localDefinition = registry.find((theme) => theme.id === localPreference);
        preferredTheme = localDefinition && !localDefinition.availability.requiresEntitlement
          ? localPreference
          : 'dark';
        try {
          await setThemePreference(preferredTheme, { expectedUserId: initialActorId });
          await assertHydrationActor(initialActorId, epoch);
        } catch (preferenceError) {
          if (preferenceError?.code === 'STALE_THEME_ACTOR') throw preferenceError;
          console.warn('Unable to migrate the local theme preference', preferenceError);
        }
      }
      await assertHydrationActor(initialActorId, epoch);
      setThemeEntitlements(authorizedThemeIds, { deferPending: true });
      setTheme(preferredTheme);
      finishProtectedThemeHydration();
      return { authenticated: true, catalog, preference, error: null };
    } catch (error) {
      if (epoch === hydrationEpoch) {
        hydrationPromise = null;
        hydrationActorId = '';
        setThemeEntitlements([]);
      }
      return { authenticated: false, catalog: null, error };
    }
  })();

  return hydrationPromise;
}
