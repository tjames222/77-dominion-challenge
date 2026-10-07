export const PROFILE_PHOTO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const PROFILE_PHOTO_MAX_OUTPUT_BYTES = 150 * 1024;
export const PROFILE_PHOTO_MAX_DIMENSION = 256;

export const PREPARED_PROFILE_PHOTO_KIND = 'dominion-profile-photo-v1';
export const PROFILE_PHOTO_OUTPUT_FORMATS = [
  { contentType: 'image/webp', extension: 'webp' },
  { contentType: 'image/jpeg', extension: 'jpg' },
];
const NEW_PROFILE_PHOTO_FILENAME = /^avatar-[0-9]{13}-[a-f0-9]{32}\.(?:jpg|webp)$/;
const OWNED_PROFILE_PHOTO_FILENAME = /^avatar-[a-z0-9_-]+\.(?:jpe?g|png|webp|heic|heif)$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPreparedProfilePhoto(value) {
  return Boolean(
    value
    && value.kind === PREPARED_PROFILE_PHOTO_KIND
    && value.blob
    && Number.isFinite(value.blob.size)
    && value.blob.size > 0
    && value.blob.size <= PROFILE_PHOTO_MAX_OUTPUT_BYTES
    && Number.isInteger(value.width)
    && value.width > 0
    && value.width <= PROFILE_PHOTO_MAX_DIMENSION
    && Number.isInteger(value.height)
    && value.height > 0
    && value.height <= PROFILE_PHOTO_MAX_DIMENSION
    && value.width === value.height
    && PROFILE_PHOTO_OUTPUT_FORMATS.some((format) => (
      format.contentType === value.contentType
      && format.extension === value.extension
      && String(value.blob.type || '').toLowerCase() === format.contentType
    )),
  );
}

export function createProfilePhotoStoragePath(userId, extension, now = Date.now(), randomId = '') {
  const normalizedExtension = String(extension || '').toLowerCase();
  const normalizedRandomId = String(randomId || '').replaceAll('-', '').toLowerCase();
  if (!userId || !['jpg', 'webp'].includes(normalizedExtension) || !/^[a-f0-9]{32}$/.test(normalizedRandomId)) {
    throw new Error('Unable to create a safe profile-picture path.');
  }
  return `${userId}/avatar-${String(now).padStart(13, '0')}-${normalizedRandomId}.${normalizedExtension}`;
}

export function isNewProfilePhotoPath(storagePath, userId) {
  const pathParts = String(storagePath || '').split('/');
  return pathParts.length === 2
    && pathParts[0] === String(userId || '')
    && NEW_PROFILE_PHOTO_FILENAME.test(pathParts[1]);
}

export function normalizeTrustedProfilePhotoUploadResponse(value, userId) {
  const response = value && typeof value === 'object' ? value : {};
  const storagePath = String(response.storagePath || '');
  const registrationId = String(response.registrationId || '');
  if (
    !isNewProfilePhotoPath(storagePath, userId)
    || !storagePath.endsWith('.webp')
    || String(response.avatarUrl || '') !== storagePath
    || !UUID_PATTERN.test(registrationId)
    || response.contentType !== 'image/webp'
    || !Number.isInteger(response.sizeBytes)
    || response.sizeBytes < 1
    || response.sizeBytes > PROFILE_PHOTO_MAX_OUTPUT_BYTES
    || !Number.isInteger(response.width)
    || !Number.isInteger(response.height)
    || response.width < 1
    || response.height < 1
    || response.width > PROFILE_PHOTO_MAX_DIMENSION
    || response.height > PROFILE_PHOTO_MAX_DIMENSION
    || response.width !== response.height
    || response.width * response.height > PROFILE_PHOTO_MAX_DIMENSION ** 2
  ) {
    throw new Error('The secure profile-picture response was invalid.');
  }

  return {
    avatarUrl: storagePath,
    storagePath,
    registrationId,
  };
}

export function isOwnedProfilePhotoPath(storagePath, userId) {
  const pathParts = String(storagePath || '').split('/');
  return pathParts.length === 2
    && pathParts[0] === String(userId || '')
    && OWNED_PROFILE_PHOTO_FILENAME.test(pathParts[1]);
}

export function ownedProfilePhotoPathFromUrl(avatarUrl, userId, bucket = 'profile-photos') {
  if (!avatarUrl || !userId) return '';
  const directPath = String(avatarUrl).split('?', 1)[0];
  if (isOwnedProfilePhotoPath(directPath, userId)) return directPath;
  let url;
  try {
    url = new URL(avatarUrl, 'https://profile-photo.invalid');
  } catch {
    return '';
  }

  const prefix = `/storage/v1/object/public/${bucket}/`;
  if (!url.pathname.startsWith(prefix)) return '';
  const encodedParts = url.pathname.slice(prefix.length).split('/');
  if (encodedParts.length !== 2) return '';

  let storagePath;
  try {
    storagePath = encodedParts.map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return '';
  }
  return isOwnedProfilePhotoPath(storagePath, userId) ? storagePath : '';
}

export function canonicalProfilePhotoUrl(avatarUrl, userId, supabaseOrigin, bucket = 'profile-photos') {
  const storagePath = ownedProfilePhotoPathFromUrl(avatarUrl, userId, bucket);
  if (!storagePath || !supabaseOrigin) return '';
  return `${supabaseOrigin}/storage/v1/object/public/${bucket}/${storagePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export async function commitProfileUpdateWithCompareAndSwap({
  expectedUpdatedAt,
  avatarOnly = false,
  tryCommit,
  readCurrentProfile,
  isCommitted,
  maxAttempts = 2,
}) {
  if (!expectedUpdatedAt || typeof tryCommit !== 'function' || typeof readCurrentProfile !== 'function') {
    throw new Error('Reload your profile before saving these changes.');
  }

  let expectedVersion = expectedUpdatedAt;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const savedProfile = await tryCommit(expectedVersion);
      if (savedProfile) return savedProfile;
    } catch (commitError) {
      try {
        const currentProfile = await readCurrentProfile();
        if (isCommitted?.(currentProfile)) return currentProfile;
      } catch {
        // The durable upload/cleanup queue makes a later retry safe.
      }
      throw commitError;
    }

    const currentProfile = await readCurrentProfile();
    if (isCommitted?.(currentProfile)) return currentProfile;
    if (!avatarOnly || !currentProfile?.updatedAt || attempt + 1 >= maxAttempts) {
      const conflict = new Error('Your profile changed in another tab. Reload it, then try again.');
      conflict.profileConflict = true;
      throw conflict;
    }
    expectedVersion = currentProfile.updatedAt;
  }

  throw new Error('Your profile changed while it was saving. Reload and try again.');
}

export async function syncProfileMetadataBestEffort(syncMetadata, metadata) {
  try {
    const result = await syncMetadata(metadata);
    return result?.error || null;
  } catch (error) {
    return error || new Error('Unable to sync account display metadata.');
  }
}

export async function replaceProfilePhoto({
  preparedPhoto,
  profile,
  uploadPhoto,
  saveProfile,
  abandonUploadedPhoto,
  cleanupQueuedPhotos,
}) {
  if (!isPreparedProfilePhoto(preparedPhoto)) {
    throw new Error('Prepare the profile picture before uploading it.');
  }

  const uploadedPhoto = await uploadPhoto(preparedPhoto);
  let savedProfile;
  let saveError = null;
  try {
    savedProfile = await saveProfile({
      ...profile,
      avatarUrl: uploadedPhoto.avatarUrl,
      profilePhotoStoragePath: uploadedPhoto.storagePath,
    });
  } catch (error) {
    saveError = error;
  }

  let cleanupError = null;
  if (saveError) {
    try {
      await abandonUploadedPhoto?.(uploadedPhoto);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await cleanupQueuedPhotos?.();
  } catch (error) {
    cleanupError ||= error;
  }

  if (saveError) {
    if (cleanupError && Object.isExtensible(saveError)) saveError.profilePhotoCleanupError = cleanupError;
    throw saveError;
  }
  return { savedProfile, uploadedPhoto, cleanupError };
}
