export function createMenuTrainingLoader({
  load = () => import('./menu-training-controllers.mjs'),
} = {}) {
  let modulePromise = null;
  return function loadMenuTrainingControllers() {
    // Browser module maps can retain a failed import. Do not advertise a retry
    // that just repeats that cached rejection; recovery is an explicit reload.
    modulePromise ||= Promise.resolve().then(load).catch(() => {
      const error = new Error('Training could not load. Save your work before reloading this page.');
      error.code = 'SITE_TRAINING_RELOAD_REQUIRED';
      throw error;
    });
    return modulePromise;
  };
}

export const loadMenuTrainingControllers = createMenuTrainingLoader();
