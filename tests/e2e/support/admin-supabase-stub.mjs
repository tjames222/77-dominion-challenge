import { createAdminPreview } from '../../../src/static/admin-preview.mjs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
// Local synthetic HTTP authorization fixture around the real installed SDK.
// Database authority and privacy are tested separately against exact SQL.
export async function installAdminStub(context, { role = 'site_admin', aal = 'aal2', permissions: initialPermissions = ['users.read', 'audit.read'], stepUpRequired = false } = {}) {
  const tokens = new Map(); const requests = []; let sequence = 0; let canonicalRole = role;
  let hold = null; let holdNames = null; let fail = false; let corrupt = false; let denialMode = ''; let roleMode = '';
  const roleTargets = new Map(); const roleOperations = new Map(); const roleEvents = [];
  let permissions = [...initialPermissions]; let recentMfaRequired = stepUpRequired;
  const provider = createAdminPreview({ mode: 'ready', getUser: async () => ({ authenticated: true, userId: A }) });
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
      if (name === 'get_site_admin_context') {
        const value = { schemaVersion: 1, actorId: auth.id, role: canonicalRole === 'site_admin' && auth.id === A ? 'site_admin' : 'member', adminReady: ready, reason: canonicalRole === 'site_admin' && auth.id === A && auth.aal !== 'aal2' ? 'mfa_required' : null, permissions: ready ? permissions : [], stepUpRequired: recentMfaRequired };
        if (holdNames?.includes(name) && hold) await hold;
        return json(route, value);
      }
      const denial = name === 'site_admin_deny_early_access_request';
      const assignment = name === 'site_admin_assign_role';
      const capability = assignment ? 'roles.manage' : denial ? 'operations.manage' : name.includes('early_access') ? 'operations.read' : name.includes('audit') ? 'audit.read' : 'users.read';
      if (!ready || !permissions.includes(capability) || ((denial || assignment) && recentMfaRequired)) return json(route, { message: 'admin_permission_or_step_up_required' }, 403);
      const held = !holdNames || holdNames.includes(name) ? hold : null;
      if (held) await held;
      if (fail) return json(route, { message: 'PRIVATE RAW ERROR SENTINEL' }, 500);
      if (assignment) {
        const mode = roleMode; roleMode = '';
        if (mode === 'recovery') return json(route, { message: 'admin_final_recovery_path' }, 403);
        if (mode === 'idempotency') return json(route, { message: 'admin_idempotency_conflict' }, 400);
        if (mode === 'limit') return json(route, { ok: false, errorCode: 'rate_limited' });
        const signature = JSON.stringify(body); const previous = roleOperations.get(body.target_request_id);
        if (previous) return previous.signature === signature ? json(route, previous.result) : json(route, { message: 'admin_idempotency_conflict' }, 400);
        const found = await provider.read('site_admin_get_user', { target_user_id: body.target_user_id }, { expectedUserId: auth.id });
        const target = { ...found.item, ...roleTargets.get(body.target_user_id) };
        const errorCode = ['invalid_input', 'self_action_forbidden', 'target_unavailable', 'revision_conflict', 'target_mfa_required'].includes(mode) ? mode
          : body.target_expected_revision !== target.roleRevision ? 'revision_conflict' : null;
        const result = errorCode ? { ok: false, errorCode } : { ok: true, role: body.target_role, revision: target.roleRevision + 1, reauthenticationRequired: true };
        if (result.ok) roleTargets.set(target.id, { ...roleTargets.get(target.id), role: result.role, roleRevision: result.revision });
        roleOperations.set(body.target_request_id, { signature, result });
        roleEvents.unshift({ id: String(1000 + roleEvents.length), actorId: auth.id, targetUserId: target.id, action: 'roles.assign', permission: 'roles.manage', reasonCode: body.target_reason_code,
          beforeRole: target.role, afterRole: result.ok ? result.role : target.role, requestId: body.target_request_id, correlationId: body.target_correlation_id,
          environment: 'synthetic', occurredAt: new Date().toISOString(), outcome: result.ok ? 'success' : 'failure', errorCode });
        if (mode === 'lost') return json(route, { message: 'PRIVATE RAW ERROR SENTINEL' }, 502);
        if (mode === 'wrong-revision') return json(route, { ...result, revision: result.revision + 1 });
        return json(route, result);
      }
      if (denial) {
        const mode = denialMode; denialMode = '';
        if (mode === 'conflict') return json(route, { ok: false, errorCode: 'revision_conflict' });
        if (mode === 'limit') return json(route, { ok: false, errorCode: 'rate_limited' });
        if (mode === 'idempotency') return json(route, { message: 'admin_idempotency_conflict' }, 400);
        const result = await provider.denyEarlyAccess({ actorId: auth.id, sessionIdentity: `preview:${auth.id}`,
          requestId: body.target_request_id, revision: String(body.target_expected_revision), operationId: body.target_operation_id,
          correlationId: body.target_correlation_id, reasonCode: 'early_access_review' });
        if (mode === 'lost') return json(route, { message: 'PRIVATE RAW ERROR SENTINEL' }, 502);
        if (mode === 'wrong-id') return json(route, { ...result, requestId: B });
        return json(route, result);
      }
      const result = structuredClone(await provider.read(name, body, { expectedUserId: auth.id })); delete result.preview;
      if (name === 'site_admin_get_user') Object.assign(result.item, roleTargets.get(result.item.id));
      if (name === 'site_admin_list_users') for (const item of result.items) Object.assign(item, roleTargets.get(item.id));
      if (name === 'site_admin_list_audit' && roleEvents.length) result.items = [...roleEvents.filter((item) => !body.target_user_id || item.targetUserId === body.target_user_id), ...result.items].slice(0, body.target_limit);
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
    hold(names = null) { let release; holdNames = names; hold = new Promise((resolve) => { release = resolve; }); return () => { release(); hold = null; holdNames = null; }; },
    stepUp(value) { recentMfaRequired = value; }, denialMode(value) { denialMode = value; },
    roleMode(value) { roleMode = value; }, roleTarget(id, value) { roleTargets.set(id, value); },
    assignments() { return requests.filter((item) => item.path.endsWith('/site_admin_assign_role')); }, roleEvents,
    denials() { return requests.filter((item) => item.path.endsWith('/site_admin_deny_early_access_request')); },
    async seedEarlyHistory(id, count) { for (let n = 0; n < count; n += 1) await provider.denyEarlyAccess({ actorId: A, sessionIdentity: `preview:${A}`, requestId: id,
      revision: '999', operationId: crypto.randomUUID(), correlationId: crypto.randomUUID(), reasonCode: 'early_access_review' }); },
    reads() { return requests.filter((item) => /site_admin_(list|get_user|get_audit)/.test(item.path)); },
  };
}
