import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPublicShareWorker } from '../cloudflare/public-share-worker.mjs';
import { productionShareRouteEnabled, productionShareRoutePlugin } from '../../vite.config.mjs';

const token = 'a'.repeat(64); // Synthetic fixture, never a live bearer link.
const upstream = `https://mimolwojppbtsbvtqwpo.supabase.co/functions/v1/share-snapshot/${token}`;
const hosts = ['77dominion.com', 'www.77dominion.com', '77-dominion-live.pages.dev'];
const syntheticHtml = (title = 'Day 14 of the 77-Day Dominion Challenge') => `<!doctype html><html lang="en"><head><title>Upstream title</title><style>body{color:red}</style></head><body><main class="share"><p class="eyebrow">Challenge progress</p><p class="metric">14/77</p><p class="metric-label">challenge days</p><h1>${title}</h1><p class="copy">A Dominion challenger is 18% through 77 days.</p><a href="http://internal-function.example">Upstream link</a></main></body></html>`;
const response = (html = syntheticHtml(), init = {}) => new Response(html, {
  status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': 'sandbox', 'Set-Cookie': 'upstream-cookie=private',
    'Access-Control-Allow-Origin': '*', 'X-Upstream-Private': 'must-not-copy' }, ...init,
});
const request = (path = `/share/${token}`, host = hosts[0], init = {}) => new Request(`https://${host}${path}`, init);

function assertSafeHeaders(result, status) {
  assert.equal(result.status, status);
  assert.equal(result.headers.get('X-Dominion-Share-Route'), '1');
  assert.equal(result.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  assert.equal(result.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(result.headers.get('Content-Security-Policy'), /default-src 'none'.*script-src 'none'.*frame-ancestors 'none'/);
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(result.headers.get('X-Upstream-Private'), null);
}

test('public share text/plain is rendered as hardened HTML on only the three production hosts', async () => {
  for (const host of hosts) {
    const worker = createPublicShareWorker(async (url, options) => {
      assert.equal(url, upstream);
      assert.equal(options.method, 'GET');
      assert.deepEqual(options.headers, { Accept: 'text/html' });
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return response();
    });
    const result = await worker.fetch(request(`/share/${token}`, host), {});
    assertSafeHeaders(result, 200);
    const html = await result.text();
    assert.match(html, /<title>Day 14 of the 77-Day Dominion Challenge \| Dominion<\/title>/);
    assert.ok(html.includes(`href="https://77dominion.com/share/${token}"`));
    assert.ok(html.includes(`property="og:url" content="https://77dominion.com/share/${token}"`));
    assert.match(html, /href="https:\/\/77dominion.com"/);
    assert.doesNotMatch(html, /internal-function|body\{color:red\}|Upstream title|Upstream link/);
  }
});

test('current deployed template text fields remain compatible without executing backend code', async () => {
  const source = await readFile(new URL('../../supabase/functions/share-snapshot/index.ts', import.meta.url), 'utf8');
  const template = source.match(/return `(<\!doctype html>[\s\S]*?<\/html>)`;/)?.[1];
  assert.ok(template);
  const values = { title: 'A safe public title', description: 'A safe public summary',
    canonical: `http://internal.example/${token}`, image: 'https://old.example/image.jpg', destination: 'https://old.example',
    'escapeHtml(presentation.eyebrow)': 'Challenge progress', 'escapeHtml(presentation.metric)': '14/77',
    'escapeHtml(presentation.metricLabel)': 'challenge days' };
  const html = template.replace(/\$\{([^}]+)\}/g, (_, name) => {
    assert.ok(Object.hasOwn(values, name), 'backend template changed: review public presentation compatibility');
    return values[name];
  });
  const result = await createPublicShareWorker(async () => response(html)).fetch(request(), {});
  assertSafeHeaders(result, 200);
  assert.match(await result.text(), /A safe public title/);
});

test('tokenless and malformed share paths return the exact public verifier contract without upstream', async () => {
  let calls = 0;
  const worker = createPublicShareWorker(async () => { calls += 1; });
  for (const path of ['/share', '/share/', '/share/not-a-token', `/share/${token}/`,
    `/share/${'A'.repeat(64)}`, `/share/${'a'.repeat(63)}`, `/share/${token}a`, `/share/%61${token.slice(1)}`,
    `/share/${token}/extra`, '/share/?token=private', '/share//not-a-token']) {
    const result = await worker.fetch(request(path), {});
    assertSafeHeaders(result, 404);
    const html = await result.text();
    assert.match(html, /<title>Share unavailable \| Dominion<\/title>/);
    assert.match(html, /href="https:\/\/77dominion.com"/);
    assert.ok(!html.includes(token));
  }
  assert.equal(calls, 0);
});

test('previews, old project hosts, foreign hosts, ports, HTTP, and non-GET methods cannot query production', async () => {
  let calls = 0;
  const worker = createPublicShareWorker(async () => { calls += 1; });
  for (const host of ['develop.77-dominion-live.pages.dev', 'abcd1234.77-dominion-live.pages.dev',
    '77-dominion-challenge.pages.dev', '77dominion.com.attacker.example', 'localhost', '77dominion.com:8443']) {
    assertSafeHeaders(await worker.fetch(request(`/share/${token}`, host), {}), 404);
  }
  assertSafeHeaders(await worker.fetch(new Request(`http://77dominion.com/share/${token}`), {}), 404);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assertSafeHeaders(await worker.fetch(request(`/share/${token}`, hosts[0], { method }), {}), 404);
  }
  assert.equal(calls, 0);
});

test('never forwards incoming credentials, headers, query strings, or caller-selected upstream values', async () => {
  const incoming = request(`/share/${token}?authorization=private-query&upstream=https://attacker.example`, hosts[0], {
    headers: { Authorization: 'Bearer private-session', Cookie: 'session=private-cookie', Origin: 'https://private-origin.example',
      Referer: 'https://private-referrer.example', Forwarded: 'host=private-forwarded.example',
      'X-Forwarded-Host': 'private-host.example', 'X-Forwarded-For': '192.0.2.1', apikey: 'private-key' },
  });
  let captured;
  const result = await createPublicShareWorker(async (url, options) => {
    captured = { url, options };
    return response();
  }).fetch(incoming, { UPSTREAM: 'https://attacker.example', API_KEY: 'private-env-key' });
  assertSafeHeaders(result, 200);
  assert.equal(captured.url, upstream);
  assert.deepEqual(captured.options.headers, { Accept: 'text/html' });
  assert.doesNotMatch(JSON.stringify(captured), /private-|attacker|192\.0\.2/);
});

test('nonshare routes delegate the original request to static ASSETS without an upstream call', async () => {
  const worker = createPublicShareWorker(async () => assert.fail('public upstream must not be called'));
  for (const path of ['/', '/login', '/dashboard.html', '/shareholders', '/assets/app.js', '/SHARE']) {
    const original = request(path);
    const asset = new Response('static unchanged', { status: 200 });
    assert.equal(await worker.fetch(original, { ASSETS: { fetch: async (seen) => {
      assert.equal(seen, original); return asset;
    } } }), asset);
  }
});

test('404, redirects, unexpected statuses, transport failures, and invalid bodies disclose no upstream content', async () => {
  for (const makeResponse of [
    () => response('private upstream error', { status: 404 }),
    () => response('private upstream error', { status: 301, headers: { Location: 'https://attacker.example' } }),
    () => response('private upstream error', { status: 500 }),
    () => response('private upstream error', { status: 401 }),
    () => response('private upstream error', { headers: { 'Content-Type': 'application/json' } }),
    () => response('private upstream error'),
    () => { throw new Error('private upstream error'); },
    () => { throw new DOMException('private upstream timeout', 'AbortError'); },
  ]) {
    let calls = 0;
    let upstreamStatus;
    const worker = createPublicShareWorker(async () => { calls += 1; const result = makeResponse(); upstreamStatus = result.status; return result; });
    const result = await worker.fetch(request(), {});
    assertSafeHeaders(result, upstreamStatus === 404 ? 404 : 502);
    assert.doesNotMatch(await result.text(), /private upstream|attacker/);
    assert.equal(calls, 1, 'no retries or redirect follow-up');
  }
});

test('rejects oversized, invalid UTF-8, active, duplicate, or malformed presentation content', async () => {
  for (const makeResponse of [
    () => response('x'.repeat(32_769)),
    () => response(syntheticHtml(), { headers: { 'Content-Type': 'text/plain', 'Content-Length': '1000000' } }),
    () => response(new Uint8Array([0xff, 0xfe])),
    () => response(syntheticHtml() + '<script>privateScript()</script>'),
    () => response(syntheticHtml().replace('<h1>', '<h1 onclick="privateHandler()">')),
    () => response(syntheticHtml() + '<h1>duplicate</h1>'),
    () => response(syntheticHtml('x'.repeat(181))),
    () => response(syntheticHtml().replace('14/77', '<img src="https://attacker.example">')),
  ]) {
    const result = await createPublicShareWorker(async () => makeResponse()).fetch(request(), {});
    assertSafeHeaders(result, 502);
    assert.doesNotMatch(await result.text(), /privateScript|privateHandler|attacker|duplicate/);
  }
});

test('the bounded deadline aborts both a stalled fetch and an asynchronous stalled body', async (context) => {
  const originalTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 10_000, 'the shipped deadline remains ten seconds');
    return originalTimeout(callback, 5);
  });
  let bodyCancelled = false;
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => response(new ReadableStream({ cancel() { bodyCancelled = true; } })),
  ]) {
    const result = await createPublicShareWorker(fetchImpl).fetch(request(), {});
    assertSafeHeaders(result, 502);
    assert.ok(!(await result.text()).includes(token));
  }
  assert.equal(bodyCancelled, true);
});

test('public text is escaped and upstream URLs or styles never become active output', async () => {
  const result = await createPublicShareWorker(async () => response(syntheticHtml('&lt;unsafe&gt; &amp; &quot;quote&quot;'))).fetch(request(), {});
  assertSafeHeaders(result, 200);
  const html = await result.text();
  assert.match(html, /<h1>&lt;unsafe&gt; &amp; &quot;quote&quot;<\/h1>/);
  assert.doesNotMatch(html, /<unsafe>|internal-function|color:red/);
});

const productionEnv = { VITE_ENABLE_MOCKS: 'false', VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
  VITE_SUPABASE_URL: 'https://mimolwojppbtsbvtqwpo.supabase.co' };
const mainBuild = { CF_PAGES: '1', CF_PAGES_BRANCH: 'main' };

test('only explicit production-connected main builds enable the share worker', () => {
  assert.equal(productionShareRouteEnabled(productionEnv, mainBuild), true);
  for (const env of [{ ...productionEnv, VITE_ENABLE_MOCKS: 'true' },
    { ...productionEnv, VITE_ENABLE_PRODUCTION_CONNECTIONS: 'false' },
    { ...productionEnv, VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'true' },
    { ...productionEnv, VITE_ENABLE_E2E_FIXTURES: 'true' },
    { ...productionEnv, VITE_SUPABASE_URL: 'https://other.supabase.co' }, {}]) {
    assert.equal(productionShareRouteEnabled(env, mainBuild), false);
  }
  for (const build of [{}, { CF_PAGES: '1' }, { CF_PAGES: '1', CF_PAGES_BRANCH: 'develop' },
    { CF_PAGES: '1', CF_PAGES_BRANCH: 'epic/review' }, { CF_PAGES: 'false', CF_PAGES_BRANCH: 'main' }]) {
    assert.equal(productionShareRouteEnabled(productionEnv, build), false);
  }
});

test('build plugin packages a standalone module and only share invocation routes; mocks emit neither', async () => {
  const outputs = [];
  const plugin = productionShareRoutePlugin(productionEnv, mainBuild);
  assert.equal(plugin.apply, 'build');
  await plugin.generateBundle.call({ emitFile: (file) => outputs.push(file) });
  assert.deepEqual(outputs.map((file) => file.fileName), ['_worker.js', '_routes.json']);
  assert.deepEqual(JSON.parse(outputs[1].source), { version: 1, include: ['/share', '/share/*'], exclude: [] });
  assert.match(outputs[0].source, /export default createPublicShareWorker\(\)/);
  assert.match(outputs[0].source, /const TIMEOUT_MS = 10_000/);
  assert.match(outputs[0].source, /const MAX_BODY_BYTES = 32_768/);
  assert.doesNotMatch(outputs[0].source, /\bimport\b|console\.|caches\.|waitUntil|service_role|SUPABASE_SERVICE_ROLE/);
  const mockOutputs = [];
  await productionShareRoutePlugin({ ...productionEnv, VITE_ENABLE_MOCKS: 'true' }, mainBuild)
    .generateBundle.call({ emitFile: (file) => mockOutputs.push(file) });
  await productionShareRoutePlugin(productionEnv, { CF_PAGES: '1', CF_PAGES_BRANCH: 'develop' })
    .generateBundle.call({ emitFile: (file) => mockOutputs.push(file) });
  assert.deepEqual(mockOutputs, []);
});
