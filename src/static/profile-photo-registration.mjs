const PROFILE_PHOTO_REGISTRATION_MESSAGES = Object.freeze({
  P8001: 'Too many profile-picture uploads are still pending. Wait for one to finish or expire, then try again.',
  P8002: 'Profile-picture cleanup is temporarily catching up. Wait a few minutes, then try again.',
  P8003: 'You have reached the hourly profile-picture upload limit. Try again later.',
  P8004: 'You have reached the daily profile-picture upload limit. Try again tomorrow.',
});

const AMBIGUOUS_TRANSPORT_STATUSES = new Set([
  0,
  502,
  503,
  504,
  520,
  521,
  522,
  523,
  524,
]);

const TRANSPORT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

const TRANSPORT_ERROR_NAMES = new Set([
  'AbortError',
  'NetworkError',
  'TimeoutError',
]);

const TRANSPORT_ERROR_MESSAGE = /failed to fetch|fetch failed|load failed|network (?:error|request failed)|connection (?:closed|reset)|timed? out/i;

function isThrownTransportError(error) {
  const code = String(error?.code || error?.cause?.code || '');
  const name = String(error?.name || '');
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return TRANSPORT_ERROR_CODES.has(code)
    || TRANSPORT_ERROR_NAMES.has(name)
    || (name === 'TypeError' && TRANSPORT_ERROR_MESSAGE.test(message));
}

export function isAmbiguousProfilePhotoRegistrationFailure(result) {
  if (result?.thrown) return isThrownTransportError(result.error);
  return AMBIGUOUS_TRANSPORT_STATUSES.has(result?.status)
    && Boolean(result.error)
    && !String(result.error.code || '');
}

export function createProfilePhotoRegistrationError(error) {
  const code = String(error?.code || '');
  const mappedMessage = PROFILE_PHOTO_REGISTRATION_MESSAGES[code];
  if (!mappedMessage && error instanceof Error) return error;

  const mapped = new Error(
    mappedMessage
      || error?.message
      || 'Unable to register that profile picture. Try again.',
  );
  mapped.code = code;
  mapped.cause = error;
  if (mappedMessage) mapped.profilePhotoRegistrationLimit = true;
  return mapped;
}

async function attemptRegistration(register, storagePath) {
  try {
    return await register(storagePath);
  } catch (error) {
    return { data: null, error, status: null, thrown: true };
  }
}

export async function registerProfilePhotoUploadWithRetry({ register, storagePath }) {
  const firstAttempt = await attemptRegistration(register, storagePath);
  if (!firstAttempt?.error) return firstAttempt?.data;

  if (!isAmbiguousProfilePhotoRegistrationFailure(firstAttempt)) {
    throw createProfilePhotoRegistrationError(firstAttempt.error);
  }

  const retryAttempt = await attemptRegistration(register, storagePath);
  if (retryAttempt?.error) {
    throw createProfilePhotoRegistrationError(retryAttempt.error);
  }
  return retryAttempt?.data;
}
