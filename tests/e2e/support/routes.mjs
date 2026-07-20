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
    id: 'invite',
    path: '/invite.html',
    htmlEntry: 'invite.html',
    title: 'Private Group Invitation | Dominion',
    access: 'public',
    defaultState: 'guest',
    ready: '#inviteTitle',
    surfaces: ['navigation', 'actions', 'error'],
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
    ready: '#checklist [data-standard-card]',
    surfaces: ['navigation', 'forms', 'actions', 'locked', 'unlocked', 'submitted'],
  },
  {
    id: 'badgesRewards',
    path: '/badges-rewards.html',
    htmlEntry: 'badges-rewards.html',
    title: 'Badges & Rewards | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#rewardsList[aria-busy="false"]',
    surfaces: ['navigation', 'actions', 'locked', 'unlocked', 'error'],
  },
  {
    id: 'bibleReading',
    path: '/bible-reading.html',
    htmlEntry: 'bible-reading.html',
    title: 'Bible Reading | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'actions', 'loading', 'error'],
  },
  {
    id: 'morningPrayer',
    path: '/morning-prayer.html',
    htmlEntry: 'morning-prayer.html',
    title: 'Morning Prayer | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'actions', 'loading', 'error'],
  },
  {
    id: 'worship',
    path: '/worship.html',
    htmlEntry: 'worship.html',
    title: 'Worship Music Only | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'actions', 'loading', 'error'],
  },
  {
    id: 'eveningPrayer',
    path: '/evening-prayer.html',
    htmlEntry: 'evening-prayer.html',
    title: 'Evening Prayer | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'actions', 'loading', 'error'],
  },
  {
    id: 'workoutOne',
    path: '/workout-one.html',
    htmlEntry: 'workout-one.html',
    title: 'Workout #1 | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'forms', 'actions', 'loading', 'error'],
  },
  {
    id: 'intentionalWalk',
    path: '/intentional-walk.html',
    htmlEntry: 'intentional-walk.html',
    title: 'Intentional Walk | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'actions', 'loading', 'error'],
  },
  {
    id: 'workoutTwo',
    path: '/workout-two.html',
    htmlEntry: 'workout-two.html',
    title: 'Workout #2 | Dominion',
    access: 'member',
    defaultState: 'member',
    ready: '#actionCompletionToggle:not([disabled])',
    surfaces: ['navigation', 'forms', 'actions', 'loading', 'error'],
  },
  {
    id: 'community',
    path: '/community.html',
    htmlEntry: 'community.html',
    title: 'Dominion Private Groups',
    access: 'member',
    defaultState: 'member',
    ready: '#crewLeaderboard',
    surfaces: ['navigation', 'forms', 'actions', 'empty', 'error'],
  },
  {
    id: 'profile',
    path: '/profile.html',
    htmlEntry: 'profile.html',
    title: 'Profile | Dominion',
    access: 'authenticated',
    defaultState: 'member',
    ready: '[data-theme-mode="dominion-night"]:not(.is-loading)',
    surfaces: ['navigation', 'forms', 'actions', 'locked', 'unlocked', 'error'],
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
]);

export const AUTHENTICATED_ROUTES = Object.freeze(
  PRODUCTION_ROUTES.filter((route) => route.access !== 'public'),
);

export const MEMBER_ROUTES = Object.freeze(
  PRODUCTION_ROUTES.filter((route) => route.access === 'member'),
);

export const ROUTE_BY_ID = Object.freeze(
  Object.fromEntries(PRODUCTION_ROUTES.map((route) => [route.id, route])),
);

// Feature contracts add targeted assertions without fragmenting the shared runner.
export const ROUTE_ASSERTION_EXTENSIONS = Object.freeze(
  Object.fromEntries(PRODUCTION_ROUTES.map((route) => [route.id, []])),
);

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
