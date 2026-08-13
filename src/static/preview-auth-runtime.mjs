export const PREVIEW_AUTH_OWNER_STORAGE_KEY = 'dominion:previewAuthOwnerId';
export const PREVIEW_AUTH_PROFILE_STORAGE_KEY = 'dominion:previewAuthProfile';

export function shouldUseSupabaseAuthentication({
  configured = false,
  localDemo = false,
  mocksEnabled = false,
  productionBuild = false,
  localHybridEnabled = false,
} = {}) {
  if (!configured) return false;
  if (!localDemo) return true;
  return Boolean(mocksEnabled && !productionBuild && localHybridEnabled);
}

export function previewAuthUser(authUser, { fallbackName = 'Member', profile = {} } = {}) {
  const userId = String(authUser?.id || '').trim();
  if (!userId) throw new TypeError('A verified authentication user is required.');

  const metadata = authUser?.user_metadata || {};
  const email = String(authUser?.email || '').trim();
  const authName = metadata.name
    || metadata.full_name
    || fallbackName
    || email.split('@')[0]
    || 'Member';

  return {
    userId,
    name: String(profile?.name || authName).trim() || 'Member',
    email,
    avatarUrl: String(profile?.avatarUrl || ''),
    authenticated: true,
  };
}

export function bindPreviewAuthOwner(storage, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId || !storage?.setItem) {
    throw new TypeError('A verified preview account is required.');
  }
  const previousOwnerId = readPreviewAuthOwner(storage);
  if (previousOwnerId && previousOwnerId !== normalizedUserId) {
    storage.removeItem?.('dominion:activeCrewId');
  }
  storage.setItem(PREVIEW_AUTH_OWNER_STORAGE_KEY, normalizedUserId);
  // The legacy pointer is email-derived. Removing it prevents a verified Auth
  // account from accidentally adopting a prior local-only identity.
  storage.removeItem?.('dominion:mockUserId');
  return normalizedUserId;
}

export function readPreviewAuthOwner(storage) {
  return String(storage?.getItem?.(PREVIEW_AUTH_OWNER_STORAGE_KEY) || '').trim();
}

export function clearPreviewAuthOwner(storage) {
  storage?.removeItem?.(PREVIEW_AUTH_OWNER_STORAGE_KEY);
  storage?.removeItem?.('dominion:mockUserId');
  storage?.removeItem?.('dominion:user');
  storage?.removeItem?.('dominion:activeCrewId');
}

export function assertPreviewAuthEmail(authEmail, requestedEmail) {
  const current = String(authEmail || '').trim().toLowerCase();
  const requested = String(requestedEmail ?? authEmail ?? '').trim().toLowerCase();
  if (requested && requested !== current) {
    throw new Error('Change your sign-in email outside the dev preview before editing this profile.');
  }
  return String(authEmail || '').trim();
}
