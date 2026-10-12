import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureHeaderDeferral } from '../../scripts/measure-header-deferral.mjs';

test('history-independent real-main/mock-develop builds keep member header controller out of every initial graph', async () => {
  const report = await measureHeaderDeferral();
  for (const [mode, { before, after }] of Object.entries(report.modes)) {
    assert.equal(Object.keys(after.routes).length, 29);
    assert.deepEqual(after.budgets.violations, [], mode);
    for (const [route, current] of Object.entries(after.routes)) {
      const previous = before.routes[route];
      assert.equal(current.css.gzip, previous.css.gzip, `${mode}/${route}: CSS unchanged`);
      assert.ok(current.requestCount <= previous.requestCount, `${mode}/${route}: no new initial requests versus synthetic eager graph`);
      assert.equal(current.authRuntimeCount, route === 'earlyAccessInvite' ? 0 : 1, `${mode}/${route}: eager Auth singleton`);
      assert.equal(current.hasHeaderController, false, `${mode}/${route}: deferred controller`);
      assert.equal(current.hasMenu, previous.hasMenu, `${mode}/${route}: no new menu side effects`);
      if (current.hasMenu) {
        assert.equal(previous.hasHeaderController, true);
        assert.ok(previous.js.gzip - current.js.gzip >= 1000, `${mode}/${route}: current-tree deferral saving`);
      } else assert.ok(Math.abs(current.js.gzip - previous.js.gzip) < 32, `${mode}/${route}: only filename compression effects`);
    }
    const optional = after.assets.filter(asset => /\/shared-header-actions-[\w-]+\.js$/.test(asset.path));
    assert.equal(optional.length, 1); assert.ok(optional[0].gzip < 3000);
  }
});
