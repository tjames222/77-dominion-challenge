export const PROFILE_PHOTO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const PROFILE_PHOTO_MAX_OUTPUT_BYTES = 150 * 1024;
export const PROFILE_PHOTO_MAX_DIMENSION = 256;

const PREPARED_PROFILE_PHOTO_KIND = 'dominion-profile-photo-v1';
const PROFILE_PHOTO_INPUT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const PROFILE_PHOTO_INPUT_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);
const OUTPUT_FORMATS = [
  { contentType: 'image/webp', extension: 'webp' },
  { contentType: 'image/jpeg', extension: 'jpg' },
];
const OUTPUT_QUALITIES = [0.88, 0.82, 0.76, 0.68, 0.58, 0.48, 0.38];
const OUTPUT_SCALES = [1, 0.875, 0.75, 0.625, 0.5];

const fileExtension = (file) => {
  const name = String(file?.name || '').trim().toLowerCase();
  const match = name.match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
};

export function isHeicProfilePhoto(file) {
  return HEIC_TYPES.has(String(file?.type || '').toLowerCase())
    || HEIC_EXTENSIONS.has(fileExtension(file));
}

export function validateProfilePhotoInput(file) {
  if (!file) throw new Error('Choose a profile picture first.');

  const contentType = String(file.type || '').toLowerCase();
  const extension = fileExtension(file);
  const hasSupportedType = PROFILE_PHOTO_INPUT_TYPES.has(contentType);
  const hasSupportedExtension = PROFILE_PHOTO_INPUT_EXTENSIONS.has(extension);
  const typeCanFallBackToExtension = !contentType || contentType === 'application/octet-stream';
  if (!hasSupportedType && !(typeCanFallBackToExtension && hasSupportedExtension)) {
    throw new Error('Choose a JPG, PNG, WebP, HEIC, or HEIF image.');
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('That image is empty. Choose a different photo.');
  }
  if (file.size > PROFILE_PHOTO_MAX_INPUT_BYTES) {
    throw new Error('Choose an image smaller than 5 MB.');
  }
  return file;
}

export function calculateProfilePhotoCrop(width, height, maxDimension = PROFILE_PHOTO_MAX_DIMENSION) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('That image has invalid dimensions. Choose a different photo.');
  }

  const sourceSize = Math.min(sourceWidth, sourceHeight);
  const outputSize = Math.max(1, Math.floor(Math.min(sourceSize, maxDimension)));
  return {
    sourceX: (sourceWidth - sourceSize) / 2,
    sourceY: (sourceHeight - sourceSize) / 2,
    sourceSize,
    width: outputSize,
    height: outputSize,
  };
}

const loadHtmlImage = (file, { ImageCtor = globalThis.Image, urlApi = globalThis.URL } = {}) => {
  if (!ImageCtor || !urlApi?.createObjectURL) {
    return Promise.reject(new Error('This browser cannot decode images.'));
  }

  return new Promise((resolve, reject) => {
    const objectUrl = urlApi.createObjectURL(file);
    const image = new ImageCtor();
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      urlApi.revokeObjectURL(objectUrl);
      callback();
    };
    image.onload = () => finish(() => resolve(image));
    image.onerror = () => finish(() => reject(new Error('Unable to decode the selected image.')));
    image.decoding = 'async';
    image.src = objectUrl;
  });
};

export async function decodeProfilePhoto(file, options = {}) {
  const createImageBitmapFn = options.createImageBitmapFn || globalThis.createImageBitmap;
  if (typeof createImageBitmapFn === 'function') {
    try {
      return await createImageBitmapFn(file, { imageOrientation: 'from-image' });
    } catch {
      // Some older implementations reject the options object even when they can decode the image.
      try {
        return await createImageBitmapFn(file);
      } catch {
        // HTMLImageElement is a useful fallback, notably in browsers with partial image-bitmap support.
      }
    }
  }
  return loadHtmlImage(file, options);
}

const browserCanvasFactory = (width, height) => {
  if (!globalThis.document?.createElement) throw new Error('This browser cannot prepare profile photos.');
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const canvasToBlob = (canvas, contentType, quality) => {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: contentType, quality });
  }
  if (typeof canvas.toBlob !== 'function') {
    return Promise.reject(new Error('This browser cannot encode profile photos.'));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Unable to encode the profile photo.')),
      contentType,
      quality,
    );
  });
};

function drawProfilePhoto(canvas, source, crop, outputSize, contentType) {
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext?.('2d', { alpha: contentType !== 'image/jpeg' });
  if (!context) throw new Error('This browser cannot prepare profile photos.');

  context.clearRect(0, 0, outputSize, outputSize);
  if (contentType === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, outputSize, outputSize);
  }
  context.drawImage(
    source,
    crop.sourceX,
    crop.sourceY,
    crop.sourceSize,
    crop.sourceSize,
    0,
    0,
    outputSize,
    outputSize,
  );
}

async function encodeProfilePhoto(source, crop, options = {}) {
  const createCanvas = options.createCanvas || browserCanvasFactory;
  const encodeCanvas = options.encodeCanvas || canvasToBlob;
  let encoderProducedImage = false;

  for (const format of OUTPUT_FORMATS) {
    for (const scale of OUTPUT_SCALES) {
      const outputSize = Math.max(1, Math.floor(crop.width * scale));
      const canvas = createCanvas(outputSize, outputSize);
      drawProfilePhoto(canvas, source, crop, outputSize, format.contentType);

      for (const quality of OUTPUT_QUALITIES) {
        let blob;
        try {
          blob = await encodeCanvas(canvas, format.contentType, quality);
        } catch {
          break;
        }
        if (!blob || String(blob.type || '').toLowerCase() !== format.contentType) break;
        encoderProducedImage = true;
        if (blob.size <= PROFILE_PHOTO_MAX_OUTPUT_BYTES) {
          return {
            kind: PREPARED_PROFILE_PHOTO_KIND,
            blob,
            width: outputSize,
            height: outputSize,
            contentType: format.contentType,
            extension: format.extension,
          };
        }
      }
    }
  }

  if (!encoderProducedImage) {
    throw new Error('This browser cannot create a WebP or JPEG profile thumbnail. Try another browser.');
  }
  throw new Error('We could not compress that photo below 150 KB. Choose a simpler or smaller image.');
}

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
    && OUTPUT_FORMATS.some((format) => (
      format.contentType === value.contentType
      && format.extension === value.extension
      && String(value.blob.type || '').toLowerCase() === format.contentType
    )),
  );
}

export function isOwnedProfilePhotoPath(storagePath, userId) {
  const pathParts = String(storagePath || '').split('/');
  if (pathParts.length !== 2 || pathParts[0] !== String(userId || '')) return false;
  return /^avatar-[a-z0-9_-]+\.(?:jpe?g|png|webp|heic|heif)$/i.test(pathParts[1]);
}

export function ownedProfilePhotoPathFromUrl(
  avatarUrl,
  userId,
  bucket = 'profile-photos',
  expectedOrigin = '',
) {
  if (!avatarUrl || !userId) return '';
  let url;
  try {
    url = new URL(avatarUrl, 'https://profile-photo.invalid');
  } catch {
    return '';
  }
  if (expectedOrigin && url.origin !== expectedOrigin) return '';

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

export async function prepareProfilePhoto(file, options = {}) {
  validateProfilePhotoInput(file);
  const decodeImage = options.decodeImage || decodeProfilePhoto;
  let decoded;
  try {
    decoded = await decodeImage(file, options);
  } catch (error) {
    if (isHeicProfilePhoto(file)) {
      throw new Error('This browser cannot decode HEIC/HEIF photos. Export the photo as JPG or PNG, then try again.');
    }
    throw new Error('We could not read that image. Choose a valid JPG, PNG, or WebP photo.');
  }

  try {
    const width = Number(decoded?.width || decoded?.naturalWidth);
    const height = Number(decoded?.height || decoded?.naturalHeight);
    const crop = calculateProfilePhotoCrop(width, height);
    return await encodeProfilePhoto(decoded, crop, options);
  } catch (error) {
    if (error?.message?.includes('150 KB') || error?.message?.includes('WebP or JPEG')) throw error;
    throw new Error('We could not prepare that image. Choose a different photo and try again.');
  } finally {
    decoded?.close?.();
  }
}

export async function commitProfilePhotoWithCompareAndSwap({
  expectedAvatarUrl = '',
  newAvatarUrl,
  trySwap,
  readCurrentProfile,
  maxAttempts = 4,
}) {
  if (!newAvatarUrl || typeof trySwap !== 'function' || typeof readCurrentProfile !== 'function') {
    throw new Error('Unable to commit the prepared profile picture.');
  }

  let expectedUrl = expectedAvatarUrl || '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let savedProfile;
    try {
      savedProfile = await trySwap(expectedUrl, newAvatarUrl);
    } catch (swapError) {
      let currentProfile;
      try {
        currentProfile = await readCurrentProfile();
      } catch (verificationError) {
        const uncertainError = new Error(
          'We could not confirm whether the profile picture saved. The uploaded photo was retained; reload your profile before trying again.',
          { cause: swapError },
        );
        uncertainError.profilePhotoRollbackUnsafe = true;
        uncertainError.profilePhotoVerificationError = verificationError;
        throw uncertainError;
      }
      if ((currentProfile?.avatarUrl || '') === newAvatarUrl) {
        return { savedProfile: currentProfile, replacedAvatarUrl: expectedUrl };
      }
      throw swapError;
    }
    if (savedProfile) {
      return { savedProfile, replacedAvatarUrl: expectedUrl };
    }

    const currentProfile = await readCurrentProfile();
    if (!currentProfile) {
      throw new Error('Your profile changed while the picture was saving. Reload and try again.');
    }
    if ((currentProfile.avatarUrl || '') === newAvatarUrl) {
      return { savedProfile: currentProfile, replacedAvatarUrl: expectedUrl };
    }
    expectedUrl = currentProfile.avatarUrl || '';
  }

  throw new Error('Your profile changed in another tab while the picture was saving. Try again.');
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
  previousAvatarUrl,
  profile,
  uploadPhoto,
  saveProfile,
  removePreviousPhoto,
  removeUploadedPhoto,
}) {
  if (!isPreparedProfilePhoto(preparedPhoto)) {
    throw new Error('Prepare the profile picture before uploading it.');
  }

  const uploadedPhoto = await uploadPhoto(preparedPhoto);
  let savedProfile;
  try {
    savedProfile = await saveProfile({
      ...profile,
      avatarUrl: uploadedPhoto.avatarUrl,
      expectedAvatarUrl: previousAvatarUrl || '',
    });
  } catch (error) {
    if (!error?.profilePhotoRollbackUnsafe) {
      try {
        await removeUploadedPhoto?.(uploadedPhoto);
      } catch (rollbackError) {
        if (error && (typeof error === 'object' || typeof error === 'function') && Object.isExtensible(error)) {
          Object.defineProperty(error, 'profilePhotoRollbackError', {
            configurable: true,
            value: rollbackError,
          });
        }
      }
    }
    throw error;
  }

  let cleanupError = null;
  try {
    await removePreviousPhoto?.(
      savedProfile?.replacedAvatarUrl ?? previousAvatarUrl,
      uploadedPhoto,
    );
  } catch (error) {
    cleanupError = error;
  }

  return { savedProfile, uploadedPhoto, cleanupError };
}
