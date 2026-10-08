import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BASE, SECRET, healthBody } from './test-fixtures.mjs';
import { HEALTH_URL, SELF_TEST_ID } from './constants.mjs';

const require = createRequire(import.meta.url);
const wranglerRoot = dirname(require.resolve('wrangler/package.json'));
const { Miniflare, Log, LogLevel } = require(require.resolve('miniflare', { paths: [wranglerRoot] }));
const root = dirname(fileURLToPath(import.meta.url));
const harness = `
import production, { CleanupMonitor } from './production-index.mjs';
import { SELF_TEST_KEY, STATE_KEY } from './constants.mjs';
export class TestMonitor extends CleanupMonitor {
  async inspect() {
    return { state: await this.ctx.storage.get(STATE_KEY), selfTest: await this.ctx.storage.get(SELF_TEST_KEY), sends: (await this.ctx.storage.get('fixture-sends')) || 0,
      sqlite: this.ctx.storage.sql.exec('select 1 as native_sql').one().native_sql };
  }
}
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return production.fetch(request, env);
    const value = await request.json();
    const stub = env.MONITOR.get(env.MONITOR.idFromName('single-monitor'));
    try {
      return Response.json(value.op === 'inspect' ? await stub.inspect() : await stub.tick(value.at));
    } catch (error) { return new Response(String(error?.stack || error), { status: 500 }); }
  }
};
`;
const injected = `
import { runTick as actualRunTick } from './runner.mjs';
import { parseHealth } from './core.mjs';
import { healthBody } from './test-fixtures.mjs';
export function runTick(storage, env, scheduledTime) {
  return actualRunTick(storage, env, scheduledTime, {
    now: () => scheduledTime,
    healthReader: async () => {
      await env.TEST_BOUNDARY.fetch('https://fixture.invalid/health');
      return parseHealth(healthBody(scheduledTime, env.TEST_READY), scheduledTime);
    },
    sender: async (_, intent, options) => {
      const persisted = options?.testRun ? (await storage.get('owner-acceptance-v1')).state : await storage.get('monitor-v1');
      if (persisted.notification?.id !== intent.id || persisted.notification.status !== 'sending') throw new Error('Intent not persisted');
      await storage.put('fixture-sends', ((await storage.get('fixture-sends')) || 0) + 1);
      await storage.sync();
      if (env.TEST_CRASH) throw new Error('Synthetic post-send interruption');
      return { status: 'accepted', messageId: 'native-fixture-message' };
    },
  });
}
`;
async function options(persist, bindings = {}) {
  const production = await readFile(join(root, 'index.mjs'), 'utf8');
  const modules = [
    { type: 'ESModule', path: join(root, 'native-harness.mjs'), contents: harness },
    { type: 'ESModule', path: join(root, 'production-index.mjs'),
      contents: production.replace("from './runner.mjs'", "from './injected-runner.mjs'") },
    { type: 'ESModule', path: join(root, 'injected-runner.mjs'), contents: injected },
    ...['constants.mjs','core.mjs','runner.mjs','transport.mjs','self-test.mjs','test-fixtures.mjs'].map(path => ({ type: 'ESModule', path: join(root, path) })),
  ];
  return { name: 'cleanup-monitor-native-fixture', modules, modulesRoot: root,
    compatibilityDate: '2026-07-01', durableObjectsPersist: persist,
    durableObjects: { MONITOR: { className: 'TestMonitor', useSQLite: true, unsafeUniqueKey: 'cleanup-monitor-native-fixture' } },
    bindings: { ALERTS_ENABLED: 'true', TEST_READY: 101, TEST_CRASH: false, ...bindings },
    serviceBindings: { TEST_BOUNDARY: async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return new Response('local fixture only');
    } },
    outboundService: () => { throw new Error('All external network is forbidden in this fixture'); },
    log: new Log(LogLevel.NONE),
  };
}
async function stub(mf) {
  const call = async body => {
    const response = await mf.dispatchFetch('https://fixture.invalid/', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  return { tick: at => call({ op: 'tick', at }), inspect: () => call({ op: 'inspect' }) };
}
async function sqliteFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await sqliteFiles(path));
    else if (entry.name.endsWith('.sqlite')) output.push(path);
  }
  return output;
}

test('native health fetch accepts the pinned 200 response and never follows redirect credentials to another hop', async () => {
  const entry = `
import { readHealth } from './transport.mjs';
import { BASE, SECRET } from './test-fixtures.mjs';
export default {
  async fetch() {
    const health = await readHealth(SECRET, null, { now: () => BASE });
    return Response.json({ accepted: health !== null, health });
  }
};
`;
  const cases = [{ status: 200 }, ...[301,302,303,307,308].flatMap(status =>
    [HEALTH_URL, 'https://untrusted-redirect.invalid/health'].map(location => ({ status, location })))];
  for (const { status, location } of cases) {
    const requests = [];
    const mf = new Miniflare({ modulesRoot: root,
      modules: [
        { type: 'ESModule', path: join(root, 'native-transport-harness.mjs'), contents: entry },
        ...['constants.mjs','core.mjs','transport.mjs','test-fixtures.mjs'].map(path => ({ type: 'ESModule', path: join(root, path) })),
      ], compatibilityDate: '2026-07-01',
      outboundService: async request => {
        requests.push({ url: request.url, method: request.method,
          healthKey: request.headers.get('x-dominion-health-key'), body: await request.text() });
        // Every outbound call is handled locally. A followed Location can never
        // escape to the network, and its presence still fails the assertion.
        if (request.url !== HEALTH_URL) return new Response('Unexpected second hop', { status: 418 });
        return new Response(JSON.stringify(healthBody()), { status, headers: {
          'content-type': 'application/json',
          ...(location ? { location } : {}),
        } });
      }, log: new Log(LogLevel.NONE),
    });
    try {
      const result = await (await mf.dispatchFetch('https://fixture.invalid/')).json();
      assert.equal(result.accepted, status === 200, `Native HTTP ${status}`);
      if (status === 200) assert.equal(result.health.cleanup.ready, 0);
      else assert.equal(result.health, null);
      assert.deepEqual(requests, [{ url: HEALTH_URL, method: 'POST', healthKey: SECRET,
        body: '{"mode":"monitor-health"}' }], `HTTP ${status} must make exactly one fixed-origin request`);
    } finally { await mf.dispose(); }
  }
});

test('actual SQLite DO survives full runtime restart, serializes duplicate schedules, and sends one recovery', async () => {
  const persist = await mkdtemp(join(tmpdir(), '77dc-monitor-native-'));
  let mf;
  try {
    mf = new Miniflare(await options(persist));
    let object = await stub(mf);
    const results = await Promise.all([35_000,55_000,59_999].map(offset => object.tick(BASE + offset)));
    assert.equal(results.filter(r => r.ignored).length, 2);
    let inspected = await object.inspect();
    assert.equal(inspected.sends, 1); assert.equal(inspected.sqlite, 1);
    assert.equal(inspected.state.daily.count, 1);
    assert.equal(inspected.state.notification.status, 'accepted');
    assert.equal((await mf.dispatchFetch('https://fixture.invalid/')).status, 404);
    await mf.dispose(); mf = null;
    const files = await sqliteFiles(persist);
    assert.ok(files.length > 0, 'A physical SQLite file exists outside the destroyed isolate');
    for (const file of files) assert.equal((await readFile(file)).subarray(0, 15).toString(), 'SQLite format 3');
    mf = new Miniflare(await options(persist, { TEST_READY: 0 }));
    object = await stub(mf);
    assert.equal((await object.tick(BASE + 59_999)).ignored, true);
    assert.equal((await object.inspect()).sends, 1);
    await object.tick(BASE + 300000 + 35_000);
    assert.equal((await object.inspect()).sends, 1);
    const recovered = await object.tick(BASE + 600000 + 55_000);
    assert.equal(recovered.notificationId, 'cleanup-1-recovery');
    inspected = await object.inspect();
    assert.equal(inspected.sends, 2); assert.equal(inspected.state.daily.count, 2);
    assert.equal(inspected.state.incident, null);
    await object.tick(BASE + 900000);
    assert.equal((await object.inspect()).sends, 2);
  } finally {
    if (mf) await mf.dispose();
    assert.ok(persist.startsWith(join(tmpdir(), '77dc-monitor-native-')));
    await rm(persist, { recursive: true, force: true });
  }
});

test('post-send interruption persists uncertainty across physical restart; operator acknowledgment cannot replay it', async () => {
  const persist = await mkdtemp(join(tmpdir(), '77dc-monitor-native-'));
  let mf;
  try {
    mf = new Miniflare(await options(persist, { TEST_CRASH: true }));
    await assert.rejects((await stub(mf)).tick(BASE));
    await mf.dispose(); mf = null;
    mf = new Miniflare(await options(persist));
    let object = await stub(mf);
    const result = await object.tick(BASE + 300000);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.notificationStatus, 'delivery_unknown');
    assert.equal(result.notificationCode, 'interrupted');
    assert.equal((await object.inspect()).sends, 1);
    await mf.dispose(); mf = null;
    mf = new Miniflare(await options(persist, { MONITOR_RECONCILE_NOTIFICATION: 'cleanup-1-open' }));
    object = await stub(mf);
    const resumed = await object.tick(BASE + 600000);
    assert.equal(resumed.status, 'observed'); assert.equal(resumed.notificationStatus, 'delivery_unknown');
    assert.equal(resumed.reconciliation.action, 'resume_without_retry');
    assert.equal(resumed.dailyCount, 1); assert.equal((await object.inspect()).sends, 1);
  } finally {
    if (mf) await mf.dispose();
    assert.ok(persist.startsWith(join(tmpdir(), '77dc-monitor-native-')));
    await rm(persist, { recursive: true, force: true });
  }
});

test('one-shot test completion and duplicate suppression survive successive complete SQLite runtime restarts', async () => {
  const persist = await mkdtemp(join(tmpdir(), '77dc-monitor-native-'));
  let mf;
  try {
    const config = { MONITOR_SELF_TEST: SELF_TEST_ID, ALERTS_ENABLED: 'false', TEST_READY: 0 };
    for (const [tick, offset] of [[0,35_000],[0,55_000],[1,59_999],[2,35_000],[2,55_000],[3,1],[288,0]]) {
      mf = new Miniflare(await options(persist, config));
      const object = await stub(mf);
      await object.tick(BASE + tick * 300000 + offset);
      const observed = await object.inspect();
      assert.equal(observed.sends, tick < 2 ? 1 : 2);
      assert.equal(observed.state.incident, null);
      assert.deepEqual(observed.state.lastCodes, []);
      if (tick >= 2) assert.equal(observed.selfTest.complete, true);
      await mf.dispose(); mf = null;
    }
  } finally {
    if (mf) await mf.dispose();
    assert.ok(persist.startsWith(join(tmpdir(), '77dc-monitor-native-')));
    await rm(persist, { recursive: true, force: true });
  }
});
