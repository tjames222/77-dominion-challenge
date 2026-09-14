import { canonicalHtmlRouteFileName } from './route-path.mjs';

const AUTH_ENTRY_ROUTES = new Set([
  'login.html',
  'register.html',
  'forgot-password.html',
  'reset-password.html',
  'account-security.html',
]);

// Authentication pages own their session transition and continuation. An
// optional menu readiness read must not race that document's navigation.
// This is route admission only; allowed routes still require server readiness.
export function isAdminMenuReadRoute(pathname = '') {
  return !AUTH_ENTRY_ROUTES.has(canonicalHtmlRouteFileName(pathname));
}
