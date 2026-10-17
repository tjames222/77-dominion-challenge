import { installAdminStub } from './admin-supabase-stub.mjs';

export const PROFILE_TARGET = '70000000-0000-4000-8000-000000000028';
export const PROFILE_VERSION = '72000000-0000-4000-8000-000000000001';
export const PROFILE_PERMISSIONS = ['users.read', 'users.manage', 'audit.read'];
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json',
  headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });

// Synthetic HTTP only. This fixture models receipts/CAS for the compiled UI;
// real database authorization, concurrency and atomicity have separate SQL tests.
export async function installProfileNameStub(context, options = {}) {
  let permissions = options.permissions ?? [...PROFILE_PERMISSIONS];
  let role = options.role ?? 'site_admin'; let stepUp = options.stepUpRequired ?? false;
  const auth = await installAdminStub(context, { ...options, permissions });
  let profile = { state: 'editable', reason: null, name: 'Preview Member 28', version: PROFILE_VERSION,
    updatedAt: '2026-10-13T09:00:00.123456Z' };
  let sequence = 1; let writeMode = ''; let readMode = ''; let blocked = null;
  const receipts = new Map(); const events = []; const responses = [];
  const nextVersion = () => `72000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const canRead = claims => claims?.sub === auth.A && claims.aal === 'aal2' && role === 'site_admin'
    && permissions.includes('users.read') && permissions.includes('users.manage');
  function target(value) {
    profile = { ...profile, ...value };
    if (profile.state === 'editable') auth.roleTarget(PROFILE_TARGET, { name: profile.name });
  }
  await context.route('**/__admin_fixture__/rest/v1/rpc/site_admin_*_profile_name', async route => {
    const request = route.request(); const name = new URL(request.url()).pathname.split('/').at(-1);
    if (!['site_admin_get_profile_name', 'site_admin_correct_profile_name'].includes(name)) return route.fallback();
    const body = request.postDataJSON(); let claims;
    try { claims = JSON.parse(Buffer.from((request.headers().authorization ?? '').split('.')[1], 'base64url').toString()); } catch {}
    auth.requests.push({ path: `/rest/v1/rpc/${name}`, body, actor: claims?.sub, aal: claims?.aal, method: request.method() });
    if (blocked?.name === name) await blocked.promise;
    if (!canRead(claims) || body.target_expected_actor_id !== claims?.sub || (name === 'site_admin_correct_profile_name' && stepUp))
      return json(route, { message: 'admin_permission_or_step_up_required' }, 403);
    if (name === 'site_admin_get_profile_name') {
      if (readMode === 'failure') return json(route, { message: 'PRIVATE PROFILE READ ERROR SENTINEL' }, 503);
      const unavailable = body.target_user_id === auth.A ? 'self_action_forbidden' : null;
      const result = { schemaVersion: 1, actorId: claims.sub, targetUserId: body.target_user_id, observedAt: new Date().toISOString(),
        profile: unavailable ? { state: 'unavailable', reason: unavailable, name: null, version: null, updatedAt: null } : { ...profile } };
      if (readMode === 'wrong-actor') result.actorId = auth.B;
      if (readMode === 'raw-legacy') result.profile.name = 'x'.repeat(121);
      responses.push(structuredClone(result)); return json(route, result);
    }
    const mode = writeMode; writeMode = '';
    const envelope = { schemaVersion: 1, actorId: claims.sub, targetUserId: body.target_user_id,
      operationId: body.target_operation_id, correlationId: body.target_correlation_id };
    const signature = JSON.stringify(body); const prior = receipts.get(body.target_operation_id);
    if (prior) return prior.signature === signature ? json(route, prior.result) : json(route, { message: 'admin_idempotency_conflict' }, 409);
    if (mode === 'idempotency') return json(route, { message: 'admin_idempotency_conflict' }, 409);
    if (mode === 'rate_limited') return json(route, { ...envelope, ok: false, error: 'rate_limited' });
    const failure = ['invalid_input', 'revision_conflict', 'self_action_forbidden', 'target_unavailable', 'profile_unavailable', 'unsupported_legacy_name'].includes(mode)
      ? mode : body.target_expected_version !== profile.version ? 'revision_conflict' : null;
    const changed = body.target_name !== profile.name; const beforeVersion = profile.version;
    const result = failure ? { ...envelope, ok: false, error: failure }
      : { ...envelope, ok: true, changed, version: changed ? nextVersion() : profile.version };
    if (!failure && changed) target({ name: body.target_name, version: result.version, updatedAt: new Date().toISOString() });
    receipts.set(body.target_operation_id, { signature, result }); responses.push(structuredClone(result));
    const event = { id: String(3000 + events.length), actorId: claims.sub, targetUserId: body.target_user_id,
      action: 'users.display_name.correct', permission: 'users.manage', reasonCode: 'profile_name_correction',
      beforeRole: null, afterRole: null, requestId: body.target_operation_id, correlationId: body.target_correlation_id,
      environment: 'synthetic', occurredAt: new Date().toISOString(), outcome: failure ? 'failure' : 'success', errorCode: failure,
      beforeProfileNameVersion: failure ? null : beforeVersion, afterProfileNameVersion: failure ? null : result.version,
      profileNameChanged: failure ? null : changed };
    events.unshift(event); auth.roleEvents.unshift(event);
    if (mode === 'lost') return json(route, { message: 'PRIVATE PROFILE WRITE ERROR SENTINEL' }, 502);
    if (mode === 'wrong-operation') return json(route, { ...result, operationId: auth.B });
    if (mode === 'raw-name') return json(route, { ...result, name: 'PRIVATE RECEIPT NAME SENTINEL' });
    return json(route, result);
  });
  return { ...auth, events, responses,
    permissions(value) { permissions = [...value]; auth.permissions(value); },
    role(value) { role = value; auth.role(value); }, stepUp(value) { stepUp = value; auth.stepUp(value); },
    profile: () => structuredClone(profile), target,
    unavailable(reason) { target({ state: 'unavailable', reason, name: null, version: null, updatedAt: null }); },
    changeName(name) { target({ name, version: nextVersion(), updatedAt: new Date().toISOString() }); },
    writeMode(value) { writeMode = value; }, readMode(value) { readMode = value; },
    corrections: () => auth.requests.filter(value => value.path.endsWith('/site_admin_correct_profile_name')),
    profileReads: () => auth.requests.filter(value => value.path.endsWith('/site_admin_get_profile_name')),
    holdProfile(name = 'site_admin_correct_profile_name') {
      let release; const promise = new Promise(resolve => { release = resolve; }); blocked = { name, promise };
      return () => { blocked = null; release(); };
    },
  };
}
