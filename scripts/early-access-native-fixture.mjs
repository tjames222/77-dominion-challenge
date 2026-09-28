// Test-only scope checks. Never accepts an existing project/container as input.
export const NATIVE_FIXTURE_IMAGES = Object.freeze({
  postgres: 'public.ecr.aws/supabase/postgres:17.6.1.141',
  auth: 'public.ecr.aws/supabase/gotrue:v2.196.0',
  rest: 'public.ecr.aws/supabase/postgrest:v16.1',
});
export const NATIVE_FIXTURE_AUTH_ORIGIN = 'https://mimolwojppbtsbvtqwpo.supabase.co';
export function fixtureName(uuid) {
  if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid)) throw new Error('Invalid fixture identity.');
  return `77dc-native-invite-${uuid}`;
}
export function assertOwnedNativeResource(record, { id, fixture, kind, imageId }) {
  if (!/^[a-f0-9]{64}$/.test(id || '') || !/^77dc-native-invite-[a-f0-9-]{36}$/.test(fixture || '')
    || !['network', 'postgres', 'auth', 'rest'].includes(kind) || record?.Id !== id
    || String(record?.Name || '').replace(/^\//, '') !== `${fixture}-${kind}`) throw new Error('Unowned fixture resource.');
  const labels = kind === 'network' ? record.Labels : record.Config?.Labels;
  if (labels?.['77dc.fixture'] !== fixture || labels?.['77dc.kind'] !== kind) throw new Error('Unowned fixture labels.');
  if (kind === 'network') {
    if (record.Internal !== true) throw new Error('Fixture network must be internal.');
  } else if (!/^sha256:[a-f0-9]{64}$/.test(imageId || '') || record.Config?.Image !== imageId
    || record.HostConfig?.NetworkMode !== `${fixture}-network`
    || record.HostConfig?.Privileged === true || Object.keys(record.HostConfig?.PortBindings || {}).length > 0
    || (record.HostConfig?.CapAdd || []).length > 0
    || (record.Mounts || []).some(mount => mount.Type !== 'tmpfs')) throw new Error('Unsafe fixture container.');
  return id;
}
export function nativeLoopbackPort(record, containerPort) {
  const mappings = record?.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  if (!Array.isArray(mappings) || mappings.length !== 1 || mappings[0].HostIp !== '127.0.0.1'
    || !/^\d{1,5}$/.test(mappings[0].HostPort) || +mappings[0].HostPort < 1 || +mappings[0].HostPort > 65535) throw new Error('Fixture port is not loopback-only.');
  return `http://127.0.0.1:${mappings[0].HostPort}`;
}
export function createNativeFixtureFetch({ authUrl, restUrl, fetcher = globalThis.fetch }) {
  const internal = authUrl === 'http://auth:9999' && restUrl === 'http://rest:3000';
  if (internal && fetcher === globalThis.fetch) throw new Error('Internal fixture transport must be explicitly injected.');
  for (const value of internal ? [] : [authUrl, restUrl]) {
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) throw new Error('Only explicit loopback fixture origins are allowed.');
  }
  return (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== NATIVE_FIXTURE_AUTH_ORIGIN || url.username || url.password || url.hash) throw new Error('Blocked non-fixture transport.');
    const target = url.pathname.startsWith('/auth/v1/') ? `${authUrl}${url.pathname.slice(8)}${url.search}`
      : url.pathname.startsWith('/rest/v1/') ? `${restUrl}${url.pathname.slice(8)}${url.search}` : null;
    if (!target) throw new Error('Blocked fixture endpoint.');
    // Never follow an Auth redirect to its pinned public URL over the network.
    return fetcher(target, { ...options, redirect: 'manual', signal: options.signal || AbortSignal.timeout(10000) });
  };
}
export function nativeCurlConfig(input, options = {}) {
  const url = new URL(input);
  if (!['http://auth:9999', 'http://rest:3000'].includes(url.origin) || url.username || url.password || url.hash) throw new Error('Blocked internal fixture endpoint.');
  const method = options.method || 'GET';
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || (options.body !== undefined && typeof options.body !== 'string')) throw new Error('Invalid fixture request.');
  // Native MFA enrollment includes a large QR SVG; the test transport permits
  // at most 1 MiB. Production invitation/recovery readers retain their own
  // substantially smaller response caps unchanged.
  const lines = ['silent', 'show-error', 'include', 'no-location', 'globoff', 'max-time = 10', 'connect-timeout = 2', 'max-filesize = 1048576', 'noproxy = "*"', 'proto = "=http"',
    `url = ${JSON.stringify(url.href)}`, `request = ${JSON.stringify(method)}`];
  for (const [name, value] of new Headers(options.headers)) {
    if (!/^[a-z0-9-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error('Invalid fixture header.');
    lines.push(`header = ${JSON.stringify(`${name}: ${value}`)}`);
  }
  if (options.body !== undefined) lines.push(`data-raw = ${JSON.stringify(options.body)}`);
  return lines.join('\n');
}
export function nativeCurlResponse(output) {
  if (Buffer.byteLength(output) > 1064960) throw new Error('Native fixture response too large.');
  const boundary = output.indexOf('\r\n\r\n');
  if (boundary < 0 || boundary > 16384) throw new Error('Invalid native fixture response.');
  const lines = output.slice(0, boundary).split('\r\n'); const status = Number(lines.shift()?.match(/^HTTP\/\S+ (\d{3})(?: |$)/)?.[1]);
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('Invalid native fixture status.');
  const headers = new Headers();
  for (const line of lines) { const colon = line.indexOf(':'); if (colon < 1) throw new Error('Invalid native fixture header.'); headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
  const body = output.slice(boundary + 4); if (Buffer.byteLength(body) > 1048576) throw new Error('Native fixture body too large.');
  return new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
}
