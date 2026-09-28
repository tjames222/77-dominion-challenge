// Synthetic HTTP boundary for the installed production SDK. No hosted services.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S = '11111111-1111-4111-8111-111111111111';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', headers: { 'x-supabase-api-version': '2024-01-01' }, body: JSON.stringify(body),
});

export async function installRecoveryStub(context, { enrolled = true, wrongActor = false } = {}) {
  const requests = [];
  const tokens = new Map();
  let sequence = 0;
  let gate = null;
  const user = (id = A) => ({ id, aud: 'authenticated', role: 'authenticated',
    email: 'recovery.synthetic@example.test', user_metadata: {},
    factors: enrolled ? [{ id: F, status: 'verified', factor_type: 'totp', friendly_name: 'My authenticator' }] : [] });
  function session(aal = 'aal1', id = A) {
    const now = Math.floor(Date.now() / 1000);
    const access_token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      sub: id, session_id: S, aal, exp: now + 3600, iat: now, role: 'authenticated',
      amr: [{ method: aal === 'aal2' ? 'totp' : 'recovery', timestamp: now + ++sequence }],
    })}.synthetic-signature`;
    tokens.set(access_token, { aal, id });
    return { access_token, refresh_token: `synthetic-refresh-${sequence}`, token_type: 'bearer',
      expires_in: 3600, expires_at: now + 3600, user: user(id) };
  }
  const anchor = session();
  const replacement = session('aal1', B);
  await context.route(url => /^\/(auth\/v1|rest\/v1|functions\/v1)\//.test(url.pathname), async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const bearer = (req.headers().authorization || '').replace(/^Bearer\s+/i, '');
    const auth = tokens.get(bearer);
    const body = req.postData() ? req.postDataJSON() : {};
    requests.push({ path, method: req.method(), aal: auth?.aal || null, actor: auth?.id || null,
      owner: bearer === anchor.access_token ? 'anchor' : bearer === replacement.access_token ? 'replacement' : 'derived' });
    if (path === '/auth/v1/user') return auth
      ? json(route, user(auth.id))
      : json(route, { code: 'session_not_found' }, 403);
    if (path === `/auth/v1/factors/${F}/challenge`) return json(route, { id: C, type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 120 });
    if (path === `/auth/v1/factors/${F}/verify`) {
      if (gate) await gate;
      if (body.code !== '654321') return json(route, { code: 'mfa_verification_failed', message: 'Synthetic rejected code' }, 422);
      return json(route, session('aal2', wrongActor ? B : A));
    }
    if (path === '/auth/v1/logout') return json(route, {});
    if (path === '/rest/v1/profiles') return json(route, { user_id: auth?.id || A, name: 'Synthetic Member', time_zone: 'UTC', avatar_url: '' });
    if (path === '/rest/v1/rpc/get_theme_preference') return json(route, { theme_key: 'dark' });
    if (path.startsWith('/rest/') || path.startsWith('/functions/')) return json(route, []);
    return json(route, { code: 'unexpected_fixture_endpoint' }, 500);
  });
  return {
    requests,
    recoveryUrl: () => `/reset-password.html#${new URLSearchParams({
      access_token: anchor.access_token, refresh_token: anchor.refresh_token,
      expires_in: '3600', token_type: 'bearer', type: 'recovery',
    })}`,
    holdVerification() { let release; gate = new Promise(resolve => { release = resolve; }); return () => { release(); gate = null; }; },
    async assertAnchorUnchanged(page, expect) {
      expect(await page.evaluate(original => {
        const stored = JSON.parse(localStorage.getItem('sb-127-auth-token') || 'null');
        return stored?.access_token === original.access_token && stored?.refresh_token === original.refresh_token;
      }, anchor)).toBe(true);
    },
    async replaceAccount(page) {
      await page.evaluate(value => {
        const key = 'sb-127-auth-token'; const oldValue = localStorage.getItem(key);
        const newValue = JSON.stringify(value); localStorage.setItem(key, newValue);
        window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
      }, replacement);
    },
  };
}
