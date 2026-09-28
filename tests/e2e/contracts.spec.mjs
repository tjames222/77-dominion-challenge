import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
import { readFile } from 'node:fs/promises';
import { expect, test } from './support/app-test.mjs';
import {
  PRODUCTION_ROUTES,
  ROUTE_ASSERTION_EXTENSIONS,
  assertValidRouteManifest,
  expectedRouteTheme,
} from './support/routes.mjs';
import { APP_STATES } from './support/fixtures.mjs';

test('route manifest matches every Vite HTML entry', async () => {
  expect(assertValidRouteManifest()).toBe(true);

  const configuredEntries = Object.values(PRODUCTION_ENTRYPOINTS).sort();
  const manifestEntries = PRODUCTION_ROUTES.map((route) => route.htmlEntry).sort();

  expect(manifestEntries).toEqual(configuredEntries);
});

test('every route fixture and assertion extension is registered', () => {
  for (const route of PRODUCTION_ROUTES) {
    expect(APP_STATES[route.defaultState], route.id + ' fixture').toBeTruthy();
    expect(ROUTE_ASSERTION_EXTENSIONS[route.id], route.id + ' extension').toBeInstanceOf(Array);
    expect(route.surfaces.length).toBeGreaterThan(0);
  }
});

test('only the isolated invitation route uses public-only theme and guest fixtures', async () => {
  const isolated = PRODUCTION_ROUTES.filter((route) => route.themePolicy === 'public-only');
  expect(isolated.map((route) => route.htmlEntry)).toEqual(['early-access-invite.html']);
  const [route] = isolated;
  expect(route.access).toBe('public');
  expect(route.defaultState).toBe('guest');
  expect(APP_STATES[route.defaultState]).toEqual({ json: {}, raw: {} });
  expect(route.sharedHeaderActions).toBe(false);
  expect(ROUTE_ASSERTION_EXTENSIONS[route.id]).toEqual([
    '#earlyAccessInviteStatus', '.auth-note a[href="./support.html"]',
  ]);
  const html = await readFile(new URL('../../early-access-invite.html', import.meta.url), 'utf8');
  expect(html).toContain('<script vite-ignore src="./theme-bootstrap.js" data-enable-dominion-night="false"></script>');
  for (const candidate of PRODUCTION_ROUTES) {
    for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
      const expected = candidate.id === route.id && !['light', 'dark'].includes(theme) ? 'dark' : theme;
      expect(expectedRouteTheme(candidate, theme), candidate.id + ': ' + theme).toBe(expected);
    }
  }
});
