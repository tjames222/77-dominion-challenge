import { canonicalHtmlRouteFileName } from './route-path.mjs';

export const AUTHENTICATED_HEADER_ROUTES = Object.freeze([
  'dashboard.html',
  'bible-reading.html',
  'morning-prayer.html',
  'worship.html',
  'evening-prayer.html',
  'workout-one.html',
  'intentional-walk.html',
  'workout-two.html',
  'community.html',
  'private-journal.html',
  'profile.html',
  'badges-rewards.html',
  'membership.html',
  'billing.html',
  'science.html',
]);

const AUTHENTICATED_HEADER_ROUTE_SET = new Set(AUTHENTICATED_HEADER_ROUTES);
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function routeFileName(pathname = '') {
  return canonicalHtmlRouteFileName(pathname);
}

export function isAuthenticatedHeaderRoute(pathname = '') {
  return AUTHENTICATED_HEADER_ROUTE_SET.has(routeFileName(pathname));
}

export function shouldShowAuthenticatedHeaderActions({ user, pathname } = {}) {
  return Boolean(user?.authenticated) && isAuthenticatedHeaderRoute(pathname);
}

export function validDateKey(value) {
  const normalized = String(value || '');
  if (!DATE_KEY_PATTERN.test(normalized)) return false;
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function normalizeChallengeStartDate(value, fallback = '') {
  if (validDateKey(value)) return String(value);
  return validDateKey(fallback) ? String(fallback) : '';
}
