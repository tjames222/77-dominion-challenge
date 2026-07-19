import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { DAILY_STANDARD_ROUTE_LIST } from './daily-standard-routes.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('dedicated Daily Standard page framework', () => {
  it('maps seven stable action IDs to seven distinct pages and titles', async () => {
    assert.equal(DAILY_STANDARD_ROUTE_LIST.length, 7);
    assert.equal(new Set(DAILY_STANDARD_ROUTE_LIST.map((action) => action.id)).size, 7);
    assert.equal(new Set(DAILY_STANDARD_ROUTE_LIST.map((action) => action.route)).size, 7);

    const pages = await Promise.all(DAILY_STANDARD_ROUTE_LIST.map(async (action) => ({
      action,
      html: await read(`../..${action.route.slice(1)}`),
    })));
    pages.forEach(({ action, html }) => {
      assert.match(html, new RegExp(`data-action-id="${action.id}"`));
      assert.match(html, new RegExp(`<title>${action.title.replace('#', '\\#')} \\| Dominion</title>`));
      assert.match(html, /daily-standard-page\.js/);
      assert.match(html, /href="\.\/dashboard\.html#daily-standards"/);
      assert.match(html, /aria-label="1 point">\+1/);
    });
  });

  it('keeps completion and details as independent Dashboard controls', async () => {
    const dashboard = await read('./dashboard.js');
    assert.match(dashboard, /<article class="check-row" data-standard-card/);
    assert.match(dashboard, /<button class="check-row-toggle" data-standard/);
    assert.match(dashboard, /<a class="check-row-details" href=/);
    assert.doesNotMatch(dashboard, /<button class="check-row"/);
  });

  it('shares the atomic draft API and never submits a Check-In', async () => {
    const controller = await read('./daily-standard-page.js');
    assert.match(controller, /getDailyStandardDraft/);
    assert.match(controller, /mutateDailyStandardDraft/);
    assert.match(controller, /visibilitychange/);
    assert.doesNotMatch(controller, /postCheckIn|submit_daily_check_in/);
    assert.match(controller, /draft\.completed\.length !== 7/);
  });

  it('registers every dedicated page with the MPA build', async () => {
    const viteConfig = await read('../../vite.config.ts');
    DAILY_STANDARD_ROUTE_LIST.forEach((action) => {
      assert.match(viteConfig, new RegExp(action.route.slice(2).replace('.', '\\.')));
    });
  });
});
