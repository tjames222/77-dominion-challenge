export const PRODUCTION_ROUTES = Object.freeze([
  {
    id: 'landing',
    path: '/index.html',
    htmlEntry: 'index.html',
    title: '77-Day Dominion Challenge',
    access: 'public',
    defaultState: 'guest',
    ready: 'main.landing-shell h1',
    surfaces: ['navigation', 'marketing'],
  },
  {
    id: 'membership',
    path: '/membership.html',
    htmlEntry: 'membership.html',
    title: 'Membership | Dominion',
    access: 'public',
    defaultState: 'guest',
    ready: 'main.membership-shell h1',
    surfaces: ['navigation', 'marketing', 'actions'],
  },
  {
    id: 'login',
    path: '/login.html',
    htmlEntry: 'login.html',
    title: 'Login | Dominion',
    access: 'public',
    defaultState: 'guest',
    ready: '#authForm',
    surfaces: ['navigation', 'forms'],
  },
  {
    id: 'register',
    path: '/register.html',
    htmlEntry: 'register.html',
    title: 'Join | Dominion',
    access: 'public',
    defaultState: 'guest',
    ready: '#authForm',
    surfaces: ['navigation', 'forms'],
  },
  {
    id: 'science',
    path: '/science.html',
    htmlEntry: 'science.html',
    title: 'The Why Behind Dominion',
    access: 'public',
    defaultState: 'guest',
    ready: 'main.science-page h1',
    surfaces: ['navigation', 'marketing'],
  },
  {
    id: 'billing',
    path: '/billing.html',
    htmlEntry: 'billing.html',
    title: 'Billing | Dominion',
    access: 'authenticated',
    defaultState: 'memberLocked',
    ready: '#billingStatusTitle',
    surfaces: ['navigation', 'forms', 'actions', 'loading', 'error', 'locked'],
  },
  {
    id: 'dashboard',
    path: '/dashboard.html',
    htmlEntry: 'dashboard.html',
    title: 'Dominion Dashboard',
    access: 'member',
    defaultState: 'member',
    ready: '#dashboardTitle',
    surfaces: ['navigation', 'forms', 'actions', 'locked', 'unlocked', 'submitted'],
  },
  {
    id: 'todayActions',
    path: '/today-actions.html',
    htmlEntry: 'today-actions.html',
    title: "Today's Actions | Dominion",
    access: 'member',
    defaultState: 'member',
    ready: 'main.actions-page h1',
    surfaces: ['navigation', 'forms', 'actions', 'submitted'],
  },
  {
    id: 'community',
    path: '/community.html',
    htmlEntry: 'community.html',
    title: 'Dominion Community',
    access: 'member',
    defaultState: 'member',
    ready: 'main.community-shell h1',
    surfaces: ['navigation', 'forms', 'actions', 'empty', 'error'],
  },
  {
    id: 'profile',
    path: '/profile.html',
    htmlEntry: 'profile.html',
    title: 'Profile | Dominion',
    access: 'authenticated',
    defaultState: 'member',
    ready: '#profileForm',
    surfaces: ['navigation', 'forms', 'actions', 'error'],
  },
]);

export const AUTHENTICATED_ROUTES = Object.freeze(
  PRODUCTION_ROUTES.filter((route) => route.access !== 'public'),
);

export const ROUTE_BY_ID = Object.freeze(
  Object.fromEntries(PRODUCTION_ROUTES.map((route) => [route.id, route])),
);

// Feature tickets extend a route by adding selectors or state fixture names here.
// Keeping this declarative prevents each ticket from inventing a new runner.
export const ROUTE_ASSERTION_EXTENSIONS = Object.freeze({
  landing: [],
  membership: [],
  login: [],
  register: [],
  science: [],
  billing: [],
  dashboard: [],
  todayActions: [],
  community: [],
  profile: [],
});

export function assertValidRouteManifest() {
  const ids = new Set();
  const paths = new Set();

  for (const route of PRODUCTION_ROUTES) {
    if (!route.id || !route.path || !route.htmlEntry || !route.ready) {
      throw new Error('Every production route needs an id, path, htmlEntry, and ready selector.');
    }
    if (ids.has(route.id)) throw new Error('Duplicate route id: ' + route.id);
    if (paths.has(route.path)) throw new Error('Duplicate route path: ' + route.path);
    if (!Object.prototype.hasOwnProperty.call(ROUTE_ASSERTION_EXTENSIONS, route.id)) {
      throw new Error('Missing assertion extension point for ' + route.id);
    }
    ids.add(route.id);
    paths.add(route.path);
  }

  return true;
}
