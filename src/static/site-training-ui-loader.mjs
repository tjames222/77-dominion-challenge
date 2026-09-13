let modulePromise = null;

export function loadSiteTrainingUi() {
  modulePromise ||= import('./site-training-ui.js').catch((error) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}
