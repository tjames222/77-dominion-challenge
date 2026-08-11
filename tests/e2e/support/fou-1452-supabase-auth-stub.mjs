const AUTH_API_VERSION = '2024-01-01';
const AUTH_FIXTURE_PATH = '/__fou_1452_supabase__/auth/v1';

function uuidFor(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function bearerToken(request) {
  const header = request.headers().authorization || '';
  return header.replace(/^Bearer\s+/i, '');
}

function authError(route, status, code, message) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'x-supabase-api-version': AUTH_API_VERSION },
    body: JSON.stringify({ code, error_code: code, message }),
  });
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'x-supabase-api-version': AUTH_API_VERSION },
    body: JSON.stringify(body),
  });
}

export async function installFou1452SupabaseAuthStub(context) {
  const usersByEmail = new Map();
  const sessionsByAccessToken = new Map();
  const sessionsByRefreshToken = new Map();
  const requests = [];
  let userSequence = 1;
  let sessionSequence = 1;

  const publicUser = (user) => ({
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: user.createdAt,
    phone: '',
    confirmed_at: user.createdAt,
    last_sign_in_at: user.lastSignInAt,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { ...user.metadata },
    identities: [],
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    is_anonymous: false,
  });

  const createSession = (user) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sessionId = uuidFor(1000 + sessionSequence);
    const accessToken = [
      base64UrlJson({ alg: 'HS256', typ: 'JWT' }),
      base64UrlJson({
        aud: 'authenticated',
        email: user.email,
        exp: nowSeconds + 3600,
        iat: nowSeconds,
        role: 'authenticated',
        session_id: sessionId,
        sub: user.id,
      }),
      `fixture-signature-${sessionSequence}`,
    ].join('.');
    const refreshToken = `fixture-refresh-${sessionSequence}`;
    sessionSequence += 1;
    user.lastSignInAt = new Date().toISOString();
    user.updatedAt = user.lastSignInAt;

    const stored = {
      accessToken,
      refreshToken,
      user,
      active: true,
    };
    sessionsByAccessToken.set(accessToken, stored);
    sessionsByRefreshToken.set(refreshToken, stored);
    return stored;
  };

  const sessionResponse = (stored) => ({
    access_token: stored.accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: stored.refreshToken,
    user: publicUser(stored.user),
  });

  await context.route(`**${AUTH_FIXTURE_PATH}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.slice(AUTH_FIXTURE_PATH.length) || '/';
    requests.push({
      endpoint,
      method: request.method(),
      url: request.url(),
    });

    if (request.method() === 'POST' && endpoint === '/signup') {
      const body = request.postDataJSON();
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !body.password) {
        await authError(route, 400, 'validation_failed', 'Email and password are required.');
        return;
      }
      if (usersByEmail.has(email)) {
        await authError(route, 422, 'user_already_exists', 'User already registered');
        return;
      }

      const timestamp = new Date().toISOString();
      const user = {
        id: uuidFor(userSequence),
        email,
        password: String(body.password),
        metadata: body.data || {},
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSignInAt: timestamp,
      };
      userSequence += 1;
      usersByEmail.set(email, user);
      const stored = createSession(user);
      await json(route, sessionResponse(stored));
      return;
    }

    if (request.method() === 'POST'
      && endpoint === '/token'
      && url.searchParams.get('grant_type') === 'password') {
      const body = request.postDataJSON();
      const email = String(body.email || '').trim().toLowerCase();
      const user = usersByEmail.get(email);
      if (!user || user.password !== String(body.password || '')) {
        await authError(route, 400, 'invalid_credentials', 'Invalid login credentials');
        return;
      }
      const stored = createSession(user);
      await json(route, sessionResponse(stored));
      return;
    }

    if (request.method() === 'POST'
      && endpoint === '/token'
      && url.searchParams.get('grant_type') === 'refresh_token') {
      const body = request.postDataJSON();
      const prior = sessionsByRefreshToken.get(String(body.refresh_token || ''));
      if (!prior?.active) {
        await authError(route, 401, 'refresh_token_not_found', 'Invalid Refresh Token');
        return;
      }
      prior.active = false;
      const stored = createSession(prior.user);
      await json(route, sessionResponse(stored));
      return;
    }

    if (request.method() === 'GET' && endpoint === '/user') {
      const stored = sessionsByAccessToken.get(bearerToken(request));
      if (!stored?.active) {
        await authError(route, 403, 'session_not_found', 'Session not found');
        return;
      }
      await json(route, publicUser(stored.user));
      return;
    }

    if (request.method() === 'POST' && endpoint === '/logout') {
      const stored = sessionsByAccessToken.get(bearerToken(request));
      if (stored) {
        for (const session of sessionsByAccessToken.values()) {
          if (session.user.id === stored.user.id) session.active = false;
        }
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    await authError(route, 404, 'fixture_route_missing', `No Auth fixture for ${request.method()} ${endpoint}`);
  });

  return {
    requests,
    user(email) {
      return usersByEmail.get(String(email || '').trim().toLowerCase()) || null;
    },
    invalidateUser(email) {
      const user = usersByEmail.get(String(email || '').trim().toLowerCase());
      if (!user) throw new Error(`Unknown Auth fixture user: ${email}`);
      for (const session of sessionsByAccessToken.values()) {
        if (session.user.id === user.id) session.active = false;
      }
    },
    count(endpoint, method = '') {
      return requests.filter((request) => (
        request.endpoint === endpoint
        && (!method || request.method === method)
      )).length;
    },
  };
}
