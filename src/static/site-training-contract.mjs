import { canonicalHtmlRoutePath } from './route-path.mjs';

// State normalization and the menu's admission check must not import the full
// catalog/runtime. A contract test keeps this small index equal to the catalog.
export const SITE_TRAINING_SCHEMA_VERSION = 1;
export const SITE_TRAINING_ROUTES = Object.freeze([
  '/dashboard.html',
  '/bible-reading.html',
  '/morning-prayer.html',
  '/worship.html',
  '/evening-prayer.html',
  '/workout-one.html',
  '/workout-two.html',
  '/intentional-walk.html',
  '/badges-rewards.html',
  '/community.html',
  '/private-journal.html',
  '/profile.html',
  '/billing.html',
  '/science.html',
]);

export function hasSiteTrainingRoute(pathname) {
  return SITE_TRAINING_ROUTES.includes(canonicalHtmlRoutePath(pathname));
}
