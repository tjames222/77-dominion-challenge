import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ACCOUNT_ID, RECIPIENT, SENDER } from './constants.mjs';

test('checked-in deployment is inert and authority is restricted to one existing-account monitor', async () => {
  const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.account_id, ACCOUNT_ID);
  assert.equal(config.name, 'dominion-profile-photo-cleanup-monitor');
  assert.equal(config.main, 'index.mjs');
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []); assert.deepEqual(config.triggers.crons, []);
  assert.deepEqual(config.vars, { ALERTS_ENABLED: 'false', MONITOR_RECONCILE_NOTIFICATION: '', MONITOR_SELF_TEST: '' });
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'MONITOR', class_name: 'CleanupMonitor' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['CleanupMonitor'] }]);
  assert.deepEqual(config.send_email, [{ name: 'EMAIL', allowed_destination_addresses: [RECIPIENT], allowed_sender_addresses: [SENDER] }]);
  for (const name of ['services','kv_namespaces','r2_buckets','d1_databases','queues','secrets_store_secrets']) {
    assert.equal(config[name], undefined);
  }
});

test('production entry has no test HTTP, inspector, storage reset or manual send route', async () => {
  const entry = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(entry, /fetch\(\) \{ return new Response\('Not found', \{ status: 404 \}\); \}/);
  assert.doesNotMatch(entry, /native-harness|test-fixtures|inspect\(|deleteAll|reset\(|seed\(/);
});

test('existing read-only Frontend CI runs all local monitor tests after pinned dependency installation', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const frontend = workflow.split('  frontend:')[1].split('\n  database:')[0];
  assert.match(frontend, /run: pnpm install --frozen-lockfile\n      - name: Test private cleanup monitor with local SQLite and synthetic email\n        timeout-minutes: 3\n        run: node --test workers\/profile-photo-cleanup-monitor\/\*\.test\.mjs/);
  assert.doesNotMatch(frontend, /secrets\.|environment:|id-token:|contents: write/);
});
