import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureProductionPreviewPruning } from '../../scripts/measure-production-preview-pruning.mjs';

test('paired real-main/mock-develop builds prune production previews without moving execution boundaries', async () => {
  const report = await measureProductionPreviewPruning();
  for (const [mode, { before, after }] of Object.entries(report.modes)) {
    assert.equal(Object.keys(after.routes).length, 29);
    assert.deepEqual(after.budgets.violations, [], mode);
    assert.equal(after.budgets.targetsMet, false, 'This slice does not complete the broad performance ticket.');
    for (const [route, current] of Object.entries(after.routes)) {
      const previous = before.routes[route];
      assert.equal(current.css.gzip, previous.css.gzip, `${mode}/${route} CSS`);
      assert.equal(current.requestCount, previous.requestCount, `${mode}/${route} static requests`);
      assert.equal(current.authRuntimeCount, route === 'earlyAccessInvite' ? 0 : 1, `${mode}/${route} singleton`);
      if (mode === 'mockDevelop') assert.equal(current.js.gzip, previous.js.gzip, `${route} preview remains unchanged`);
      else if (route !== 'earlyAccessInvite') {
        assert.ok(previous.js.gzip - current.js.gzip >= 15000, `${route} removes at least 15 KB of unreachable preview code`);
      }
    }
    assert.equal(after.routes.accountSecurity.hasMenu, false, 'MFA does not execute menu or training listeners.');
    assert.equal(after.routes.earlyAccessInvite.hasMenu, false, 'Capability cleanup remains ahead of Auth and menu.');
    assert.equal(after.routes.earlyAccessInvite.normalizedJsSha256, before.routes.earlyAccessInvite.normalizedJsSha256,
      'The pre-Auth invitation code changes only content-hashed asset filenames.');
  }
});
