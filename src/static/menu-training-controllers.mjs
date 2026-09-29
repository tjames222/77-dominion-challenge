// One asynchronous graph boundary, with both controllers sharing one runtime.
export { createPageTrainingControls } from './page-training-controls.mjs';
export { createSoloFirstRunTraining } from './solo-first-run-training.mjs';
// The API facade delegates into this same optional boundary; no extra training
// service request is needed after the controllers have loaded.
export { createSiteTrainingApi } from './site-training-api.mjs';
