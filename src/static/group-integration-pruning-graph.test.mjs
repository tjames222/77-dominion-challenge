import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureGroupIntegrationPruning } from '../../scripts/measure-group-integration-pruning.mjs';

test('paired disabled/enabled main/mock builds prune only disabled integration UI', async () => {
  const report = await measureGroupIntegrationPruning();
  for (const [mode, { before, after }] of Object.entries(report.modes)) {
    assert.equal(Object.keys(after.routes).length, 29);
    assert.deepEqual(after.budgets.violations, [], mode);
    for (const [route, current] of Object.entries(after.routes)) {
      const previous = before.routes[route];
      assert.equal(current.css.gzip, previous.css.gzip, `${mode}/${route}: unchanged CSS`);
      assert.equal(current.requestCount, previous.requestCount, `${mode}/${route}: unchanged requests`);
      assert.equal(current.authRuntimeCount, route === 'earlyAccessInvite' ? 0 : 1, `${mode}/${route}: singleton Auth`);
      if (mode.startsWith('enabled') || ['accountSecurity', 'earlyAccessInvite'].includes(route)) {
        assert.equal(current.normalizedJsSha256, previous.normalizedJsSha256,
          `${mode}/${route}: code changes only content-hashed filenames`);
        if (mode.startsWith('enabled')) assert.deepEqual(current.js, previous.js,
          `${mode}/${route}: enabled graph bytes are identical`);
      } else if (['community', 'groupSettings'].includes(route)) {
        assert.ok(previous.js.gzip - current.js.gzip >= (route === 'community' ? 2800 : 3400),
          `${mode}/${route}: measured pruning remains meaningful`);
      } else {
        // The shared menu loses the unused flag-parser export. Other byte
        // changes are small export-alias/hash compression differences, not
        // another domain optimization or moved execution boundary.
        assert.ok(Math.abs(current.js.gzip - previous.js.gzip) < 128,
          `${mode}/${route}: only small shared-helper/hash effects`);
      }
    }
    assert.equal(after.routes.accountSecurity.hasMenu, false, 'MFA stays outside menu listeners.');
    assert.equal(after.routes.earlyAccessInvite.hasMenu, false, 'Invitation cleanup stays ahead of Auth/menu.');
  }
});
