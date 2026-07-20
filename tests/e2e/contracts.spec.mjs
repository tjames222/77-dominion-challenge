import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from './support/app-test.mjs';
import {
  PRODUCTION_ROUTES,
  ROUTE_ASSERTION_EXTENSIONS,
  assertValidRouteManifest,
} from './support/routes.mjs';
import { APP_STATES } from './support/fixtures.mjs';

test('route manifest matches every Vite HTML entry', async () => {
  expect(assertValidRouteManifest()).toBe(true);

  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const viteConfig = await readFile(repositoryRoot + '/vite.config.ts', 'utf8');
  const configuredEntries = [...viteConfig.matchAll(/:\s*'([^']+\.html)'/g)]
    .map((match) => match[1])
    .sort();
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
