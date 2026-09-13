let modulePromise = null;

export const TRAINING_RELOAD_REQUIRED = 'SITE_TRAINING_RELOAD_REQUIRED';
export const TRAINING_RELOAD_MESSAGE = 'Training could not load. Save any unfinished work, then reload this page to try again.';

export function loadSiteTrainingUi() {
  modulePromise ||= import('./site-training-ui.js').catch(() => {
    // Browsers cache failed module requests for this document. Keep the failure
    // sticky; resetting this promise cannot repair the module map (or Vite's
    // failed CSS preload). Recovery requires a new document, with user consent.
    const error = new Error(TRAINING_RELOAD_MESSAGE);
    error.code = TRAINING_RELOAD_REQUIRED;
    throw error;
  });
  return modulePromise;
}
