import { createAdminPreview } from '../../../src/static/admin-preview.mjs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
// Local synthetic HTTP authorization fixture around the real installed SDK.
// Database authority and privacy are tested separately against exact SQL.
export async function installAdminStub(context, { role = 'site_admin', aal = 'aal2' } = {}) {
  const tokens = new Map(); const requests = []; let sequence = 0; let canonicalRole = role;
  let hold = null; let fail = false; let corrupt = false;
  let permissions = ['users.read', 'audit.read'];
  const user = (id) => ({ id, aud: 'authenticated', role: 'authenticated', email: `${id === A ? 'admin' : 'member'}@example.test`, email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { name: 'Synthetic Operator', site_admin: true, role: 'site_admin', crew_role: 'admin' }, factors: [{ id: F, factor_type: 'totp', status: 'verified', friendly_name: 'Authenticator' }] });
  function session(id = A, level = aal, sid = '11111111-1111-4111-8111-111111111111') {
    const now = Math.floor(Date.now() / 1000);
    const access = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, exp: now + 3600, iat: now, aal: level, session_id: sid, role: 'authenticated', amr: [{ method: level === 'aal2' ? 'totp' : 'password', timestamp: now }] })}.synthetic-${++sequence}`;
    tokens.set(access, { id, aal: level });
    return { access_token: access, refresh_token: `synthetic-${sequence}`, expires_in: 3600, expires_at: now + 3600, token_type: 'bearer', user: user(id) };
  }
  const firstSession = session();
  await context.addInitScript((value) => {
    if (!localStorage.getItem('sb-127-auth-token')) localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
  }, firstSession);
  await context.route('**/__admin_fixture__/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.replace('/__admin_fixture__', '');
    const auth = tokens.get((request.headers().authorization || '').replace(/^Bearer\s+/i, ''));
    const body = request.postData() ? request.postDataJSON() : {};
    requests.push({ path, body, actor: auth?.id, aal: auth?.aal, method: request.method() });
    if (path === '/auth/v1/user') return auth ? json(route, user(auth.id)) : json(route, { message: 'Session missing' }, 401);
    if (path === '/auth/v1/token') return json(route, session(body.email?.startsWith('member') ? B : A, 'aal1'));
    if (path === '/auth/v1/logout') { tokens.delete((request.headers().authorization || '').replace(/^Bearer\s+/i, '')); return json(route, {}); }
    if (path.endsWith('/challenge')) return json(route, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expires_at: Math.floor(Date.now() / 1000) + 120 });
    if (path.endsWith('/verify')) return json(route, session(auth.id, 'aal2'));
    if (path.includes('/rpc/') && path.includes('admin')) {
      const name = path.split('/').at(-1);
      if (!auth || body.target_expected_actor_id !== auth.id) return json(route, { message: 'admin_authentication_required' }, 401);
      const ready = canonicalRole === 'site_admin' && auth.id === A && auth.aal === 'aal2';
      if (name === 'get_site_admin_context') return json(route, { schemaVersion: 1, actorId: auth.id, role: canonicalRole === 'site_admin' && auth.id === A ? 'site_admin' : 'member', adminReady: ready, reason: canonicalRole === 'site_admin' && auth.id === A && auth.aal !== 'aal2' ? 'mfa_required' : null, permissions: ready ? permissions : [] });
      if (!ready || !permissions.includes(name.includes('audit') ? 'audit.read' : 'users.read')) return json(route, { message: 'admin_permission_or_step_up_required' }, 403);
      const held = hold;
      if (held) await held;
      if (fail) return json(route, { message: 'PRIVATE RAW ERROR SENTINEL' }, 500);
      const provider = createAdminPreview({ mode: 'ready', getUser: async () => ({ authenticated: true, userId: auth.id }) });
      const result = await provider.read(name, body, { expectedUserId: auth.id }); delete result.preview;
      if (held && result.items?.length) result.items[0].name = 'STALE PREVIOUS SESSION SNAPSHOT';
      if (corrupt) result.actorId = B;
      return json(route, result);
    }
    if (path === '/rest/v1/profiles') return json(route, { user_id: auth?.id, name: 'Synthetic Operator', time_zone: 'UTC' });
    if (path === '/rest/v1/rpc/get_theme_preference') return json(route, { theme_key: 'dark' });
    if (path.startsWith('/rest/') || path.startsWith('/functions/')) return json(route, []);
    return json(route, {}, 404);
  });
  return { A, B, requests, firstSession, session,
    role(value) { canonicalRole = value; }, permissions(value) { permissions = value; }, fail(value = true) { fail = value; }, corrupt(value = true) { corrupt = value; },
    hold() { let release; hold = new Promise((resolve) => { release = resolve; }); return () => { release(); hold = null; }; },
    reads() { return requests.filter((item) => /site_admin_(list|get_user|get_audit)/.test(item.path)); },
  };
}
