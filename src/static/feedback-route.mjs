// Root-level app routes only. Never include query strings, hashes or user input
// from another URL in feedback context. Cloudflare's extensionless aliases map
// to the same fixed route name as the canonical HTML entry.
export const FEEDBACK_ROUTES = Object.freeze([
  'dashboard.html', 'badges-rewards.html', 'bible-reading.html', 'morning-prayer.html',
  'worship.html', 'evening-prayer.html', 'workout-one.html', 'intentional-walk.html',
  'workout-two.html', 'community.html', 'group-settings.html', 'private-journal.html',
  'billing.html', 'profile.html',
]);
export function feedbackRoute(pathname) {
  if (typeof pathname !== 'string' || !/^\/[a-z-]+(?:\.html)?\/?$/.test(pathname)) return null;
  const file = pathname.slice(1).replace(/\/$/, '');
  const canonical = file.endsWith('.html') ? file : `${file}.html`;
  return FEEDBACK_ROUTES.includes(canonical) ? canonical : null;
}
