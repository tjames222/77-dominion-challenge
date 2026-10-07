export const PHOTO_PREPARATION_RELOAD_MESSAGE = 'Photo preparation could not load. Save any other changes, then reload this page and choose your photo again.';

// Cache code only, never a selected file, prepared image, or account state.
export function createProfilePhotoPreparationLoader({
  loadModule = () => import('./profile-photo-preparation.mjs'),
  timeoutMs = 30000,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  let pending = null;
  return () => {
    pending ||= new Promise((resolve, reject) => {
      const timer = setTimer(() => reject(new Error(PHOTO_PREPARATION_RELOAD_MESSAGE)), timeoutMs);
      Promise.resolve().then(loadModule).then((module) => {
        if (typeof module?.prepareProfilePhoto !== 'function') throw new Error('Invalid photo preparation module.');
        resolve(module);
      }).catch(() => reject(new Error(PHOTO_PREPARATION_RELOAD_MESSAGE))).finally(() => clearTimer(timer));
    });
    // Failed imports remain sticky for this document: browsers cache failures.
    // Never automatically retry preparation or any upload on import recovery.
    return pending;
  };
}

export const loadProfilePhotoPreparation = createProfilePhotoPreparationLoader();
