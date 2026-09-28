import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOwnedNativeResource, createNativeFixtureFetch, fixtureName, nativeLoopbackPort, nativeCurlConfig, nativeCurlResponse, NATIVE_FIXTURE_AUTH_ORIGIN } from './early-access-native-fixture.mjs';
const fixture = fixtureName('10000000-0000-4000-8000-000000000001');
const id = 'a'.repeat(64); const imageId = `sha256:${'b'.repeat(64)}`;
const record = { Id: id, Name: `/${fixture}-auth`, Config: { Image: imageId, Labels: { '77dc.fixture': fixture, '77dc.kind': 'auth' } },
  HostConfig: { NetworkMode: `${fixture}-network` }, Mounts: [] };
test('cleanup accepts only the exact newly created labelled image/network identity', () => {
  const scope = { id, imageId, fixture, kind: 'auth' }; assert.equal(assertOwnedNativeResource(record, scope), id);
  for (const altered of [{ ...record, Id: 'c'.repeat(64) }, { ...record, Name: '/supabase_auth_local' },
    { ...record, Config: { ...record.Config, Labels: {} } }, { ...record, Config: { ...record.Config, Image: 'latest' } },
    { ...record, HostConfig: { NetworkMode: 'bridge' } }, { ...record, Mounts: [{ Type: 'volume' }] },
    ...[{ Privileged: true }, { CapAdd: ['NET_ADMIN'] }, { PortBindings: { '9999/tcp': [] } }].map(value => ({ ...record, HostConfig: { ...record.HostConfig, ...value } }))]) assert.throws(() => assertOwnedNativeResource(altered, scope));
  assert.throws(() => fixtureName('../existing'));
});
test('internal transport requires explicit injection and only fixed private service aliases', async () => {
  assert.throws(() => createNativeFixtureFetch({ authUrl: 'http://auth:9999', restUrl: 'http://rest:3000' }));
  const calls = []; const request = createNativeFixtureFetch({ authUrl: 'http://auth:9999', restUrl: 'http://rest:3000', fetcher: async (...args) => { calls.push(args); return new Response('{}'); } });
  await request(`${NATIVE_FIXTURE_AUTH_ORIGIN}/auth/v1/user`, { method: 'PUT' });
  assert.equal(calls[0][0], 'http://auth:9999/user'); assert.equal(calls[0][1].redirect, 'manual');
  const config = nativeCurlConfig('http://auth:9999/user', { method: 'PUT', headers: { Authorization: 'Bearer fixture-token' }, body: '{"password":"fixture-password"}' });
  assert.match(config, /no-location/); assert.match(config, /max-time = 10/); assert.match(config, /max-filesize = 1048576/);
  assert.match(config, /header = "authorization: Bearer fixture-token"/);
  for (const url of ['https://example.com/', 'http://127.0.0.1:9999/', 'http://auth:9999/user#secret', 'http://u:p@auth:9999/user']) assert.throws(() => nativeCurlConfig(url));
  assert.throws(() => nativeCurlConfig('http://auth:9999/user', { method: 'CONNECT' }));
});
test('native HTTP parsing preserves failure/redirect status with strict byte bounds', async () => {
  const response = nativeCurlResponse('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":"invalid"}');
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid' });
  assert.equal(nativeCurlResponse('HTTP/1.1 303 See Other\r\nLocation: https://77dominion.com/reset-password.html#private\r\n\r\n').status, 303);
  assert.throws(() => nativeCurlResponse('not-http\r\n\r\n{}'));
  assert.throws(() => nativeCurlResponse(`HTTP/1.1 200 OK\r\n\r\n${'x'.repeat(1048577)}`));
});
test('published fixture ports must bind only IPv4 loopback', () => {
  const item = ip => ({ NetworkSettings: { Ports: { '9999/tcp': [{ HostIp: ip, HostPort: '45678' }] } } });
  assert.equal(nativeLoopbackPort(item('127.0.0.1'), 9999), 'http://127.0.0.1:45678');
  for (const ip of ['0.0.0.0', '::', 'localhost', '']) assert.throws(() => nativeLoopbackPort(item(ip), 9999));
});
test('fixed production-shaped URLs map only to loopback native endpoints with redirects disabled', async () => {
  const calls = []; const request = createNativeFixtureFetch({ authUrl: 'http://127.0.0.1:4001', restUrl: 'http://127.0.0.1:4002',
    fetcher: async (...args) => { calls.push(args); return new Response('{}'); } });
  await request(`${NATIVE_FIXTURE_AUTH_ORIGIN}/auth/v1/verify`, { method: 'POST' });
  await request(`${NATIVE_FIXTURE_AUTH_ORIGIN}/rest/v1/rpc/get_member_access_context`);
  assert.equal(calls[0][0], 'http://127.0.0.1:4001/verify'); assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls[1][0], 'http://127.0.0.1:4002/rpc/get_member_access_context');
  for (const url of ['https://77dominion.com/reset-password.html', 'http://127.0.0.1:9999/admin/users', `${NATIVE_FIXTURE_AUTH_ORIGIN}/storage/v1/object`, `${NATIVE_FIXTURE_AUTH_ORIGIN}/auth/v1/user#secret`]) assert.throws(() => request(url));
  assert.throws(() => createNativeFixtureFetch({ authUrl: NATIVE_FIXTURE_AUTH_ORIGIN, restUrl: 'http://127.0.0.1:4002' }));
});
