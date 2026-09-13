// Keep the stylesheet in the deferred module graph: Vite awaits it before the
// import resolves, so the first coachmark cannot open before its CSS is ready.
import '../assets/site-training.css';
export { createSiteTrainingCoachmark } from './site-training-coachmark.mjs';
