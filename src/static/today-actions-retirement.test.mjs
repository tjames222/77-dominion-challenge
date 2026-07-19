import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { DAILY_STANDARD_ROUTE_LIST } from './daily-standard-routes.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('Today’s Actions retirement', () => {
  it('keeps the legacy URL as a minimal production-safe redirect', async () => {
    const [developmentRedirect, productionRedirect, dashboardSource] = await Promise.all([
      read('../../today-actions.html'),
      read('../../public/today-actions.html'),
      read('./dashboard.js'),
    ]);

    assert.equal(developmentRedirect, productionRedirect);
    assert.match(developmentRedirect, /window\.location\.replace\('\.\/dashboard\.html#daily-standards'\)/);
    assert.doesNotMatch(developmentRedirect, /dashboard\.js|menu\.js|daily-actions|data-action-completion/);
    assert.match(dashboardSource, /getBillingState\(\)/);
    assert.match(dashboardSource, /redirectToLogin\(\)/);
    assert.match(dashboardSource, /billing\.html\?intent=subscription/);
  });

  it('removes the retired page from navigation, the Dashboard handoff, and build inputs', async () => {
    const [dashboardHtml, menuSource, viteConfig] = await Promise.all([
      read('../../dashboard.html'),
      read('./menu.js'),
      read('../../vite.config.ts'),
    ]);

    [dashboardHtml, menuSource, viteConfig].forEach((source) => {
      assert.doesNotMatch(source, /today-actions\.html|Today’s Actions|Today's Actions|todayActions/);
    });
  });

  it('preserves all seven dedicated action destinations', async () => {
    const [dashboardSource, ...pages] = await Promise.all([
      read('./dashboard.js'),
      ...DAILY_STANDARD_ROUTE_LIST.map((action) => read(`../..${action.route.slice(1)}`)),
    ]);

    assert.match(dashboardSource, /dailyStandardRoute\(id\)/);
    assert.equal(DAILY_STANDARD_ROUTE_LIST.length, 7);
    DAILY_STANDARD_ROUTE_LIST.forEach((action, index) => {
      assert.match(pages[index], new RegExp(`data-action-id="${action.id}"`));
      assert.match(pages[index], /daily-standard-page\.js/);
    });
  });
});
