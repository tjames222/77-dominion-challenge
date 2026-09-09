import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  PRODUCTION_CUSTOM_DOMAIN, PRODUCTION_DOMAIN_ACCOUNT, PRODUCTION_DOMAIN_PROJECT,
  PRODUCTION_PAGES_HOST, configureProductionCustomDomain, productionCustomDomainOptions,
} from './configure-production-custom-domain.mjs';

const token = 'private-token-never-output-1234567890';
const zoneId = 'a'.repeat(32);
const projectPath = `/client/v4/accounts/${PRODUCTION_DOMAIN_ACCOUNT}/pages/projects/${PRODUCTION_DOMAIN_PROJECT}`;
const www = 'www.77dominion.com';
const options = { accountId: PRODUCTION_DOMAIN_ACCOUNT, apiToken: token };
const binding = (name, status = 'active') => ({ name, status, zone_tag: zoneId });
const cname = () => ({ id: 'b'.repeat(32), type: 'CNAME', name: PRODUCTION_CUSTOM_DOMAIN,
  content: PRODUCTION_PAGES_HOST, proxied: true, ttl: 1 });
const json = (result, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
const list = (rows, info = {}) => json(rows, { result_info: { page: 1,
  total_count: rows.length, total_pages: rows.length ? 1 : 0, ...info } });

function fakeCloudflare({ apex = true, records = [cname()], autoDns = false, intercept } = {}) {
  const calls = [];
  const state = { apex, records: structuredClone(records), status: apex ? 'active' : 'pending' };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    const intercepted = await intercept?.(url, init, state, calls);
    if (intercepted !== undefined) return intercepted;
    if (url.pathname === projectPath && init.method === 'GET') {
      return json({ name: PRODUCTION_DOMAIN_PROJECT, production_branch: 'main',
        subdomain: PRODUCTION_PAGES_HOST, domains: [www, ...(state.apex ? [PRODUCTION_CUSTOM_DOMAIN] : [])] });
    }
    if (url.pathname === '/client/v4/zones' && init.method === 'GET') {
      assert.deepEqual(Object.fromEntries(url.searchParams), { name: PRODUCTION_CUSTOM_DOMAIN,
        'account.id': PRODUCTION_DOMAIN_ACCOUNT, match: 'all', page: '1', per_page: '50' });
      return list([{ id: zoneId, name: PRODUCTION_CUSTOM_DOMAIN, account: { id: PRODUCTION_DOMAIN_ACCOUNT }, status: 'active' }]);
    }
    if (url.pathname === `${projectPath}/domains/${www}` && init.method === 'GET') return json(binding(www));
    if (url.pathname === `${projectPath}/domains/${PRODUCTION_CUSTOM_DOMAIN}` && init.method === 'GET') {
      return state.apex ? json(binding(PRODUCTION_CUSTOM_DOMAIN, state.status)) : new Response('', { status: 404 });
    }
    if (url.pathname === `${projectPath}/domains` && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { name: PRODUCTION_CUSTOM_DOMAIN });
      assert.equal(state.apex, false);
      state.apex = true;
      if (autoDns) state.records.push(cname());
      return json(binding(PRODUCTION_CUSTOM_DOMAIN, state.status));
    }
    if (url.pathname === `/client/v4/zones/${zoneId}/dns_records`) {
      if (init.method === 'GET') {
        assert.deepEqual(Object.fromEntries(url.searchParams), { 'name.exact': PRODUCTION_CUSTOM_DOMAIN,
          match: 'all', page: '1', per_page: '100' });
        return list(state.records);
      }
      if (init.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), { type: 'CNAME', name: PRODUCTION_CUSTOM_DOMAIN,
          content: PRODUCTION_PAGES_HOST, proxied: true, ttl: 1 });
        assert.equal(state.records.some((record) => ['A', 'AAAA', 'CNAME', 'NS'].includes(record.type)), false);
        state.records.push(cname());
        return json(cname());
      }
    }
    assert.fail('Unexpected endpoint or write method.');
  };
  return { fetchImpl, calls, state, writes: () => calls.filter(({ init }) => init.method !== 'GET') };
}

test('exact account, project, domain, credentials, and options are validated before network', async () => {
  for (const invalid of [
    { accountId: 'b'.repeat(32) }, { accountId: ` ${PRODUCTION_DOMAIN_ACCOUNT}` },
    { projectName: '77-dominion-challenge' }, { projectName: '' }, { projectName: '../77-dominion-live' },
    { domain: www }, { domain: '*.77dominion.com' }, { domain: '77dominion.com.' },
    { domain: 'https://77dominion.com' }, { domain: '77DOMINION.COM' },
    { apiToken: '' }, { apiToken: `${token}\n` }, { apiToken: `${token} private` },
    { apiOrigin: 'https://attacker.example' }, { zoneId }, { allowProjectCreate: true },
  ]) {
    let called = false;
    await assert.rejects(configureProductionCustomDomain({ ...options, ...invalid,
      fetchImpl: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('CLI environment cannot override the API host or derived zone', () => {
  assert.deepEqual(productionCustomDomainOptions({ CLOUDFLARE_ACCOUNT_ID: PRODUCTION_DOMAIN_ACCOUNT,
    CLOUDFLARE_API_TOKEN: token }), { ...options, projectName: PRODUCTION_DOMAIN_PROJECT, domain: PRODUCTION_CUSTOM_DOMAIN });
  for (const name of ['CLOUDFLARE_API_ORIGIN', 'CLOUDFLARE_API_BASE_URL', 'CLOUDFLARE_API_HOST', 'CLOUDFLARE_ZONE_ID']) {
    assert.throws(() => productionCustomDomainOptions({ [name]: token }), /overrides are forbidden/);
  }
});

test('fully configured apex is an idempotent read-only no-op', async () => {
  const api = fakeCloudflare();
  const result = await configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl });
  assert.deepEqual(result, { domain: PRODUCTION_CUSTOM_DOMAIN, project: PRODUCTION_DOMAIN_PROJECT,
    domainCreated: false, dnsCreated: false, domainStatus: 'active', dnsVerified: true,
    existingWwwVerified: true, activationPending: false });
  assert.equal(api.writes().length, 0);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('creates only absent apex binding and exact proxied CNAME, then verifies both and www', async () => {
  const api = fakeCloudflare({ apex: false, records: [] });
  const result = await configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl });
  assert.equal(result.domainCreated, true);
  assert.equal(result.dnsCreated, true);
  assert.equal(result.activationPending, true, 'pending certificate activation is not reported as live');
  assert.deepEqual(api.writes().map(({ url, init }) => [url.pathname, init.method]), [
    [`${projectPath}/domains`, 'POST'], [`/client/v4/zones/${zoneId}/dns_records`, 'POST'],
  ]);
  const again = await configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl });
  assert.equal(again.domainCreated, false);
  assert.equal(again.dnsCreated, false);
  assert.equal(api.writes().length, 2);
});

test('does not duplicate a CNAME created by Pages domain association', async () => {
  const api = fakeCloudflare({ apex: false, records: [], autoDns: true });
  const result = await configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl });
  assert.equal(result.domainCreated, true);
  assert.equal(result.dnsCreated, false);
  assert.equal(api.writes().length, 1);
});

test('existing binding can receive an absent DNS record without touching www or mail records', async () => {
  const mail = { type: 'MX', name: PRODUCTION_CUSTOM_DOMAIN, content: 'mail.example', priority: 10 };
  const txt = { type: 'TXT', name: PRODUCTION_CUSTOM_DOMAIN, content: 'private verification' };
  const api = fakeCloudflare({ records: [mail, txt] });
  const result = await configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl });
  assert.equal(result.domainCreated, false);
  assert.equal(result.dnsCreated, true);
  assert.deepEqual(api.state.records.slice(0, 2), [mail, txt]);
  assert.equal(api.writes().length, 1);
});

test('conflicting A, AAAA, NS, CNAME, proxy settings, duplicates, and TTL fail before any write', async () => {
  for (const records of [
    [{ ...cname(), type: 'A', content: '192.0.2.1' }],
    [{ ...cname(), type: 'AAAA', content: '2001:db8::1' }],
    [{ ...cname(), type: 'NS', content: 'ns.other.example' }],
    [{ ...cname(), content: 'other.pages.dev' }],
    [{ ...cname(), proxied: false }], [{ ...cname(), ttl: 300 }], [cname(), cname()],
  ]) {
    const api = fakeCloudflare({ apex: false, records });
    await assert.rejects(configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl }), /Conflicting apex DNS/);
    assert.equal(api.writes().length, 0);
  }
});

test('preflight rejects a wrong project, inactive www, foreign/inactive zone, and incomplete lists', async () => {
  const cases = [
    (url) => url.pathname === projectPath ? json({ name: 'other', domains: [www] }) : undefined,
    (url) => url.pathname.endsWith(`/domains/${www}`) ? json(binding(www, 'pending')) : undefined,
    (url) => url.pathname === '/client/v4/zones' ? list([{ id: zoneId, name: PRODUCTION_CUSTOM_DOMAIN, account: { id: 'b'.repeat(32) }, status: 'active' }]) : undefined,
    (url) => url.pathname === '/client/v4/zones' ? list([{ id: zoneId, name: PRODUCTION_CUSTOM_DOMAIN, account: { id: PRODUCTION_DOMAIN_ACCOUNT }, status: 'pending' }]) : undefined,
    (url) => url.pathname === '/client/v4/zones' ? list([]) : undefined,
    (url) => url.pathname.endsWith('/dns_records') ? list([], { total_pages: 2, total_count: 101 }) : undefined,
    (url) => url.pathname.endsWith('/dns_records') ? list([{ ...cname(), name: www }]) : undefined,
  ];
  for (const intercept of cases) {
    const api = fakeCloudflare({ apex: false, records: [], intercept });
    await assert.rejects(configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl }));
    assert.equal(api.writes().length, 0);
  }
});

test('permission errors are actionable but never expose provider response text or token', async () => {
  for (const status of [401, 403]) {
    const api = fakeCloudflare({ intercept: () => new Response(`secret ${token}`, { status }) });
    await assert.rejects(configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl }), (error) => {
      assert.match(error.message, /Pages Write, Zone Read, and DNS Read\/Write/);
      assert.ok(!error.message.includes(token));
      return true;
    });
    assert.equal(api.writes().length, 0);
  }
});

test('redirects, malformed bodies, oversized responses, API errors and transport errors are sanitized', async () => {
  for (const intercept of [
    () => new Response(token, { status: 302, headers: { Location: `https://attacker.example/${token}` } }),
    () => new Response(token, { status: 500 }),
    () => new Response(token, { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(token, { headers: { 'Content-Type': 'text/html' } }),
    () => json(null, { success: false, errors: [{ message: token }] }),
    () => json({ token, padding: 'x'.repeat(1_048_576) }),
    () => { throw new Error(`network ${token}`); },
    () => { throw new DOMException(token, 'AbortError'); },
  ]) {
    const api = fakeCloudflare({ intercept });
    await assert.rejects(configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl }), (error) => {
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes('attacker.example'));
      return true;
    });
    assert.equal(api.calls.length, 1, 'no redirects or retries');
  }
});

test('concurrent DNS change after association is refused without an overwrite or retry', async () => {
  let reads = 0;
  const api = fakeCloudflare({ apex: false, records: [], intercept: (url, init, state) => {
    if (url.pathname.endsWith('/dns_records') && init.method === 'GET' && ++reads === 2) {
      state.records = [{ ...cname(), type: 'A', content: '192.0.2.9' }];
    }
  } });
  await assert.rejects(configureProductionCustomDomain({ ...options, fetchImpl: api.fetchImpl }), /Conflicting apex DNS/);
  assert.equal(api.writes().length, 1);
  assert.equal(api.writes()[0].url.pathname, `${projectPath}/domains`);
});

test('script has fixed transport and writes no files, settings, credentials or destructive methods', async () => {
  const source = await readFile(new URL('./configure-production-custom-domain.mjs', import.meta.url), 'utf8');
  assert.match(source, /REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(source, /MAX_RESPONSE_BYTES = 1_048_576/);
  assert.doesNotMatch(source, /method: ['"](?:PATCH|PUT|DELETE)['"]|writeFile|appendFile|execSync|spawnSync/);
  const run = spawnSync(process.execPath, [new URL('./configure-production-custom-domain.mjs', import.meta.url).pathname], {
    env: { CLOUDFLARE_ACCOUNT_ID: 'wrong', CLOUDFLARE_API_TOKEN: token }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(run.status, 1);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(token));
  assert.match(run.stderr, /reviewed production account/);
});

test('the existing protected workflow isolates domain setup from project creation and policy writes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-pages-policy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: production-release/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /configure_custom_domain:[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(workflow, /CLOUDFLARE_CONFIGURE_CUSTOM_DOMAIN: \$\{\{ inputs.configure_custom_domain \}\}/);
  assert.match(workflow, /CLOUDFLARE_CONFIGURE_CUSTOM_DOMAIN.*true.*&&.*CLOUDFLARE_ALLOW_PROJECT_CREATE.*true/);
  assert.match(workflow, /if: \$\{\{ !inputs.configure_custom_domain \}\}\s+run: node scripts\/configure-cloudflare-pages-policy.mjs/);
  assert.match(workflow, /if: \$\{\{ inputs.configure_custom_domain \}\}\s+run: node scripts\/configure-production-custom-domain.mjs/);
});
