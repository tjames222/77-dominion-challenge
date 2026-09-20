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
const ownedHydrations = new WeakMap();

const staleHydrationError = () => Object.assign(
  new Error('The signed-in account changed. Try again.'),
  { code: 'STALE_THEME_ACTOR' },
);

async function assertHydrationActor(actorId, epoch, signal) {
  signal?.throwIfAborted();
  if (!actorId || epoch !== hydrationEpoch || hydrationActorId !== actorId) {
    throw staleHydrationError();
  }
  const currentUser = await getLocalOrSessionUser();
  signal?.throwIfAborted();
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

export async function hydrateThemeEntitlementState({ expectedUserId = '', signal } = {}) {
  signal?.throwIfAborted();
  const initialUser = await getLocalOrSessionUser();
  signal?.throwIfAborted();
  const initialActorId = initialUser?.authenticated ? String(initialUser.userId || '') : '';
  if (!initialActorId || (expectedUserId && initialActorId !== expectedUserId)) {
    clearThemeEntitlementState();
    return {
      authenticated: false,
      catalog: null,
      error: expectedUserId ? staleHydrationError() : null,
    };
  }

  // A cancellable menu request must not be shared with direct Account
  // Security/Profile consumers. Unsignalled callers keep their same-actor
  // cache; cancelling an optional owner does not invalidate their epoch.
  if (!signal && hydrationPromise && hydrationActorId === initialActorId) return hydrationPromise;
  const owned = signal && ownedHydrations.get(signal);
  if (owned?.actorId === initialActorId && owned.epoch === hydrationEpoch) return owned.promise;
  if (hydrationActorId && hydrationActorId !== initialActorId) clearThemeEntitlementState();

  const epoch = hydrationEpoch;
  hydrationActorId = initialActorId;

  const hydration = (async () => {
    // Preserve a direct same-actor consumer's runtime state and pending gate.
    if (!signal || !hydrationPromise) setThemeEntitlements([], { deferPending: true });
    try {
      await assertHydrationActor(initialActorId, epoch, signal);

      const [catalog, preference] = await Promise.all([
        getRewardCatalog({ limit: 100, expectedUserId: initialActorId, signal }),
        getThemePreference({ expectedUserId: initialActorId, signal }),
      ]);
      await assertHydrationActor(initialActorId, epoch, signal);
      const registry = getThemeRegistry();
      const authorizedThemeIds = deriveAuthorizedThemeIds(catalog, registry);

      let preferredTheme = preference.themeKey;
      // A direct consumer owns publication and preference migration once it
      // starts, including while pending. Optional reads still return their
      // verified result, but must not overwrite that owner's newer state.
      if (!preferredTheme && (!signal || !hydrationPromise)) {
        const localPreference = readPreferredTheme();
        const localDefinition = registry.find((theme) => theme.id === localPreference);
        preferredTheme = localDefinition && !localDefinition.availability.requiresEntitlement
          ? localPreference
          : 'dark';
        try {
          signal?.throwIfAborted();
          await setThemePreference(preferredTheme, { expectedUserId: initialActorId, signal });
          await assertHydrationActor(initialActorId, epoch, signal);
        } catch (preferenceError) {
          signal?.throwIfAborted();
          if (preferenceError?.code === 'STALE_THEME_ACTOR') throw preferenceError;
          console.warn('Unable to migrate the local theme preference', preferenceError);
        }
      }
      await assertHydrationActor(initialActorId, epoch, signal);
      if (!signal || !hydrationPromise) {
        setThemeEntitlements(authorizedThemeIds, { deferPending: true });
        setTheme(preferredTheme);
        finishProtectedThemeHydration();
      }
      return { authenticated: true, catalog, preference, error: null };
    } catch (error) {
      if (signal && ownedHydrations.get(signal)?.epoch === epoch) ownedHydrations.delete(signal);
      if (epoch === hydrationEpoch && !signal) {
        hydrationPromise = null;
        hydrationActorId = '';
        setThemeEntitlements([]);
      }
      if (signal && !hydrationPromise && epoch === hydrationEpoch) finishProtectedThemeHydration();
      return { authenticated: false, catalog: null, error };
    }
  })();

  if (!signal) hydrationPromise = hydration;
  else ownedHydrations.set(signal, { actorId: initialActorId, epoch, promise: hydration });
  return hydration;
}
