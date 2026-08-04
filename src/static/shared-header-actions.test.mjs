import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  AUTHENTICATED_HEADER_ROUTES,
  isAuthenticatedHeaderRoute,
  normalizeChallengeStartDate,
  routeFileName,
  shouldShowAuthenticatedHeaderActions,
  validDateKey,
} from './shared-header-state.mjs';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('authenticated shared header actions', () => {
  test('limits Share and App Streak to signed-in app routes', () => {
    const authenticatedUser = { authenticated: true, userId: 'member-1' };
    for (const route of AUTHENTICATED_HEADER_ROUTES) {
      assert.equal(isAuthenticatedHeaderRoute(`/${route}`), true, route);
      assert.equal(shouldShowAuthenticatedHeaderActions({
        user: authenticatedUser,
        pathname: `/nested/${route}`,
      }), true, route);
    }

    for (const route of ['index.html', 'login.html', 'register.html', 'science.html', 'invite.html']) {
      assert.equal(shouldShowAuthenticatedHeaderActions({
        user: authenticatedUser,
        pathname: `/${route}`,
      }), false, route);
    }
    assert.equal(shouldShowAuthenticatedHeaderActions({
      user: { authenticated: false },
      pathname: '/dashboard.html',
    }), false);
    assert.equal(routeFileName('/nested/profile.html?from=menu#account'), 'profile.html');
  });

  test('loads the shared menu entrypoint on every supported route', async () => {
    for (const route of AUTHENTICATED_HEADER_ROUTES) {
      const html = await read(`../../${route}`);
      assert.match(html, /src\/static\/menu\.js/, `${route} must load the shared header`);
      assert.match(html, /src\/assets\/menu\.css/, `${route} must load shared header styles`);
    }
  });

  test('injects labeled, accessible actions and clears stale account state', async () => {
    const [menu, actions, composer, css] = await Promise.all([
      read('./menu.js'),
      read('./shared-header-actions.js'),
      read('./share-composer.js'),
      read('../assets/menu.css'),
    ]);

    assert.match(actions, /shared-header-action-label', 'Share'/);
    assert.match(actions, /shared-header-action-label', 'App Streak'/);
    assert.match(actions, /aria-controls', 'globalStreakDetailsDialog'/);
    assert.match(actions, /streakButton\.setAttribute\('aria-expanded', 'true'\)/);
    assert.match(actions, /onClose: \(\) => streakButton\.setAttribute\('aria-expanded', 'false'\)/);
    assert.match(actions, /dialog\.destroy\(\)/);
    assert.match(menu, /currentMenuOwner !== nextOwner/);
    assert.match(menu, /closeShareComposer\('account-change'\)/);
    assert.match(menu, /sharedHeaderActions\?\.destroy\(\)/);
    assert.match(menu, /subscribeToAuthStateChanges/);
    assert.match(menu, /closeShareComposer\('auth-state-change'\)/);
    assert.match(menu, /event === 'SIGNED_OUT' \|\| nextOwner !== currentMenuOwner/);
    assert.match(menu, /menuHydrationRequest \+= 1/);
    assert.match(menu, /window\.setTimeout\(\(\) => \{/);
    assert.match(menu, /window\.addEventListener\('focus', \(\) => \{\s*void buildMenu\(\)/);
    assert.match(menu, /visibilitychange[\s\S]*void buildMenu\(\)/);
    assert.match(composer, /boundShareTriggers = new WeakSet/);
    assert.match(composer, /if \(boundShareTriggers\.has\(trigger\)\) return/);
    assert.match(css, /\.authenticated-header-actions/);
    assert.match(css, /@media \(max-width: 460px\)[\s\S]*\.topbar\.has-authenticated-header-actions\s*\{[^}]*flex-wrap:\s*nowrap/);
    assert.doesNotMatch(css, /\.topbar\.has-authenticated-header-actions \.topbar-trailing-actions\s*\{[^}]*flex:\s*1 0 100%/);
    assert.match(css, /\.topbar\.has-authenticated-header-actions > \.back-link\s*\{[^}]*min-width:\s*44px/);
    assert.match(css, /@media \(max-width: 460px\)[\s\S]*\.shared-header-action\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/);
    assert.match(css, /@media \(max-width: 340px\)[\s\S]*\.shared-header-action \.app-icon\s*\{[^}]*display:\s*none/);
    assert.doesNotMatch(css, /\.shared-header-action-label\s*\{[^}]*display:\s*none/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.shared-header-action/);
    assert.match(actions, /dialog\.elements\.body\.scrollTop = 0/);
    assert.match(actions, /dialog\.close\('replaced'\)/);
    assert.match(actions, /submitOwnerVersion !== ownerVersion/);
    assert.match(composer, /shareComposerInstance\?\.reset\?\.\(reason\)/);
    assert.match(composer, /dialog\.close\('replaced'\)/);
    assert.match(composer, /managedCrews = \[\]/);
    assert.match(composer, /requestId !== actionRequest/);
  });

  test('relocates challenge start-date persistence and lock behavior into App Streak', async () => {
    const actions = await read('./shared-header-actions.js');
    assert.match(actions, /getChallengeActivation\(\{ expectedUserId/);
    assert.match(actions, /updateChallengeStartDate\(\{/);
    assert.match(actions, /recordVisitPromise = recordAppVisit\(\{ expectedUserId \}\)\.catch/);
    assert.match(actions, /await recordVisitPromise/);
    assert.match(actions, /recordedVisitOwner !== expectedUserId/);
    assert.match(actions, /let startDateLocked = true/);
    assert.match(actions, /startDateLocked: !activation\.canEditStartDate/);
    assert.match(actions, /expectedRevision/);
    assert.match(actions, /const submitTimeZone = currentActivation\?\.timeZone \|\| ''/);
    assert.match(actions, /timeZone: submitTimeZone/);
    assert.match(actions, /expectedUserId: submitOwnerKey/);
    assert.match(actions, /submitOwnerKey !== \(currentUser\?\.userId/);
    assert.doesNotMatch(actions, /updateProfile\(/);
    assert.doesNotMatch(actions, /storage\?\.setItem\?\.\(START_DATE_STORAGE_KEY/);
    assert.match(actions, /dominion:challenge-start-date-updated/);
    assert.match(actions, /activation: savedActivation/);
    assert.match(actions, /controls stay locked until your activation status can be refreshed/i);
    assert.match(actions, /role', 'status'/);
    assert.match(actions, /aria-live', 'polite'/);
  });

  test('validates calendar dates without timezone rollover', () => {
    assert.equal(validDateKey('2026-02-28'), true);
    assert.equal(validDateKey('2026-02-29'), false);
    assert.equal(validDateKey('not-a-date'), false);
    assert.equal(normalizeChallengeStartDate('2026-07-30'), '2026-07-30');
    assert.equal(normalizeChallengeStartDate('', '2026-07-30'), '2026-07-30');
    assert.equal(normalizeChallengeStartDate('2026-02-29', 'bad'), '');
  });
});
