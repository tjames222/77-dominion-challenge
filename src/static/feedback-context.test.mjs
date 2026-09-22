import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedbackRoute, FEEDBACK_ROUTES } from './feedback-route.mjs';
import { FEEDBACK_ROUTES as compatibleRoutes } from './feedback-contract.mjs';
import { coarseFeedbackEnvironment, createFeedbackContext } from './feedback-context.mjs';
import { publicBuildSha } from '../../vite.config.mjs';
test('only fourteen reviewed root paths and extensionless aliases yield canonical route names', () => {
  assert.equal(FEEDBACK_ROUTES, compatibleRoutes); assert.equal(FEEDBACK_ROUTES.length, 14);
  for (const route of FEEDBACK_ROUTES) for (const path of [`/${route}`, `/${route.slice(0, -5)}`, `/${route.slice(0, -5)}/`]) assert.equal(feedbackRoute(path), route);
  for (const path of ['/login', '/support', '/account-security', '/admin', '/invite', '/', '/private-journal?secret=x', '/profile#private', '//profile', '/a/profile', '/%70rofile', 'https://app.test/profile', null, '/Profile']) assert.equal(feedbackRoute(path), null);
});
test('coarse browser/platform detection never returns raw user agent or arbitrary values', () => {
  for (const [agent, browser, platform] of [
    ['Mozilla Chrome/123 Safari Windows', 'chromium', 'windows'], ['Mozilla Firefox/124 Linux', 'firefox', 'linux'],
    ['Mozilla iPhone Safari/600', 'safari', 'ios'], ['Mozilla CriOS/123 iPad', 'chromium', 'ios'],
    ['Mozilla Android Chrome/123', 'chromium', 'android'], ['Mozilla Macintosh Safari/600', 'safari', 'macos'],
    ['not-recognized PRIVATE SENTINEL', 'other', 'other'], ['', 'unknown', 'unknown'], ['a'.repeat(2049), 'unknown', 'unknown'],
  ]) assert.deepEqual(coarseFeedbackEnvironment(agent), { browser, platform });
});
test('context snapshots only fixed route/theme/viewport/build and coarse enums', () => {
  const input = { pathname: '/private-journal', theme: 'dark', width: 390.2, height: 844.3, buildSha: 'a'.repeat(40), userAgent: 'iPhone Safari PRIVATE SENTINEL' };
  const result = createFeedbackContext(input);
  assert.deepEqual(result, { route: 'private-journal.html', theme: 'dark', viewport: { width: 390, height: 844 }, buildSha: 'a'.repeat(40), browser: 'safari', platform: 'ios' });
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL|userAgent|pathname/);
  for (const patch of [{ width: Infinity }, { height: 0 }, { pathname: '/profile?email=private' }, { buildSha: '' }, { theme: 'unknown' }]) assert.throws(() => createFeedbackContext({ ...input, ...patch }));
});
test('public build SHA uses explicit immutable build environment, never guessed git or malformed values', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  assert.equal(publicBuildSha({}), '');
  assert.equal(publicBuildSha({ GITHUB_SHA: c }), c);
  assert.equal(publicBuildSha({ CF_PAGES_COMMIT_SHA: b, GITHUB_SHA: c }), b);
  assert.equal(publicBuildSha({ VITE_BUILD_SHA: a, CF_PAGES_COMMIT_SHA: b, GITHUB_SHA: c }), a);
  for (const value of ['A'.repeat(40), 'main', 'a'.repeat(39), 'a'.repeat(41), `${a}\n`, 123]) assert.throws(() => publicBuildSha({ VITE_BUILD_SHA: value, GITHUB_SHA: c }));
});
