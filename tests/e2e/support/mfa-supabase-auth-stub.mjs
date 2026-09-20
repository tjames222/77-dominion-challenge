// Synthetic local HTTP provider for the actual installed Supabase SDK. No
// credentials, requests, or mutation ever reach a hosted Supabase project.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S = '11111111-1111-4111-8111-111111111111';
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'x-supabase-api-version': '2024-01-01' }, body: JSON.stringify(data) });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function installMfaSupabaseStub(context, { enrolled = true, appAccess = false } = {}) {
  const requests = [];
  const tokens = new Map();
  let sequence = 0;
  let verificationGate = null;
  let loseVerifyResponse = false;
  let logoutOutage = false;
  let factorVerified = enrolled;
  let sessionId = S;
  const user = () => ({ id: A, aud: 'authenticated', role: 'authenticated', email: 'mfa.synthetic@example.test', user_metadata: { name: 'Synthetic Member' }, factors: factorVerified ? [{ id: F, status: 'verified', factor_type: 'totp', friendly_name: 'My authenticator' }] : [] });
  const session = (aal) => {
    const now = Math.floor(Date.now() / 1000);
    const access = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: A, exp: now + 3600, iat: now, aal, session_id: sessionId, role: 'authenticated', amr: [{ method: aal === 'aal2' ? 'totp' : 'password', timestamp: now + ++sequence }] })}.synthetic-signature`;
    tokens.set(access, { aal });
    return { access_token: access, refresh_token: `synthetic-refresh-${sequence}`, expires_in: 3600, expires_at: now + 3600, token_type: 'bearer', user: user() };
  };
  await context.route('**/__mfa_fixture__/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/__mfa_fixture__', '');
    const access = (request.headers().authorization || '').replace(/^Bearer\s+/i, '');
    const auth = tokens.get(access);
    requests.push({ path, method: request.method(), aal: auth?.aal || null });
    const body = request.postData() ? request.postDataJSON() : {};
    if (path === '/auth/v1/token') return json(route, session('aal1'));
    if (path === '/auth/v1/user') return auth ? json(route, user()) : json(route, { code: 'session_not_found', message: 'Synthetic session missing' }, 403);
    if (path === '/auth/v1/logout') {
      if (logoutOutage) return json(route, { code: 'unexpected_failure', message: 'SYNTHETIC_PRIVATE_LOGOUT_RESPONSE' }, 503);
      tokens.delete(access); return json(route, {});
    }
    if (path === '/auth/v1/factors' && request.method() === 'POST') return json(route, { id: F, type: 'totp', totp: { secret: 'JBSWY3DPEHPK3PXP', qr_code: '<svg></svg>' } });
    if (path === `/auth/v1/factors/${F}/challenge`) return json(route, { id: C, expires_at: Math.floor(Date.now() / 1000) + 120 });
    if (path === `/auth/v1/factors/${F}/verify`) {
      if (verificationGate) await verificationGate;
      if (body.code !== '654321') return json(route, { code: 'mfa_verification_failed', message: 'Synthetic rejected code' }, 422);
      factorVerified = true;
      if (loseVerifyResponse) {
        loseVerifyResponse = false;
        await route.abort('failed');
        return;
      }
      return json(route, session('aal2'));
    }
    if (path === '/rest/v1/profiles') return json(route, { user_id: A, name: 'Synthetic Member', email: user().email, avatar_url: '', time_zone: 'UTC' });
    if (path === '/rest/v1/entitlements') return json(route, appAccess ? [{ entitlement_key: 'membership_active', status: 'active', ends_at: null }] : []);
    if (path === '/rest/v1/rpc/get_theme_preference' || path === '/rest/v1/rpc/set_theme_preference') return json(route, { theme_key: 'dark' });
    if (path === '/rest/v1/rpc/get_site_admin_context') return json(route, {
      schemaVersion: 1, actorId: A, role: 'member', adminReady: false, permissions: [],
    });
    if (path.startsWith('/rest/') || path.startsWith('/functions/')) return json(route, []);
    return json(route, { code: 'unexpected_fixture_endpoint', message: 'Unhandled synthetic endpoint' }, 500);
  });
  return {
    requests,
    privateRequests: () => requests.filter((request) => request.path.startsWith('/rest/') || request.path.startsWith('/functions/')),
    loseNextVerificationResponse() { loseVerifyResponse = true; },
    setLogoutOutage(value = true) { logoutOutage = value; },
    rotateSession() { sessionId = '22222222-2222-4222-8222-222222222222'; },
    holdVerification() { let release; verificationGate = new Promise((resolve) => { release = resolve; }); return () => { release(); verificationGate = null; }; },
  };
}
