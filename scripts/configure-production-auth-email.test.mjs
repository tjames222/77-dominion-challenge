import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AUTH_EMAIL_SETTINGS, configureProductionAuthEmail, verifyResendSmtpCredential } from './configure-production-auth-email.mjs';
import { CLOSED_AUTH_CONFIG_PATCH, PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';
const apiKey = 're_test_private_credential';
const denied = operation => assert.rejects(operation, error => error.message === 'Production Auth email configuration could not be verified.');
function smtpFixture({ authorized = true, greeting = '220 smtp ready\r\n', ehlo = '250-smtp.resend.com\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n', auth = '235 authenticated\r\n', hang = false } = {}) {
  const writes = []; let connection;
  const socket = new EventEmitter(); socket.authorized = authorized; socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.write = value => {
    writes.push(value);
    if (hang) return;
    if (value.startsWith('EHLO')) queueMicrotask(() => socket.emit('data', Buffer.from(ehlo)));
    if (value.startsWith('AUTH')) queueMicrotask(() => socket.emit('data', Buffer.from(auth)));
  };
  const connect = options => {
    connection = options;
    queueMicrotask(() => { socket.emit('secureConnect'); if (!socket.destroyed && !hang) socket.emit('data', Buffer.from(greeting)); });
    return socket;
  };
  return { socket, writes, connect, connection: () => connection };
}
test('SMTP key probe requires verified TLS, authenticates, and never sends an email', async () => {
  const f = smtpFixture();
  assert.equal(await verifyResendSmtpCredential({ apiKey, connect: f.connect }), true);
  assert.deepEqual(f.connection(), { host: 'smtp.resend.com', port: 465, servername: 'smtp.resend.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  assert.deepEqual(f.writes, ['EHLO 77dominion.com\r\n', `AUTH PLAIN ${Buffer.from(`\0resend\0${apiKey}`).toString('base64')}\r\n`, 'QUIT\r\n']);
  assert(!f.writes.some(value => /^(MAIL|RCPT|DATA)\b/.test(value))); assert(f.socket.destroyed);
});
test('SMTP certificate, status, capability, syntax and timeout failures are fixed and credential-safe', async () => {
  for (const patch of [
    { authorized: false }, { greeting: `550 ${apiKey}\r\n` }, { ehlo: '250 AUTH LOGIN\r\n' },
    { auth: `535 ${apiKey}\r\n` }, { greeting: 'not smtp\r\n' }, { ehlo: '250-AUTH PLAIN\r\n550 mixed status\r\n' },
    { greeting: 'a'.repeat(17000) }, { hang: true },
  ]) {
    const f = smtpFixture(patch);
    await denied(() => verifyResendSmtpCredential({ apiKey, connect: f.connect, timeoutMs: 5 }));
    assert(f.socket.destroyed);
    if (patch.authorized === false) assert.deepEqual(f.writes, []);
  }
});
test('SMTP malformed credential and timeout options fail before network', async () => {
  for (const patch of [{ apiKey: '' }, { apiKey: `${apiKey}\r\nMAIL FROM:bad` }, { timeoutMs: 0 }, { timeoutMs: 10001 }]) {
    await denied(() => verifyResendSmtpCredential({ apiKey, ...patch, connect: () => assert.fail('No network expected') }));
  }
});
function fixture() {
  const state = { calls: [], probes: 0, config: { ...CLOSED_AUTH_CONFIG_PATCH, smtp_host: '' }, status: 200, redirected: false, verified: true };
  const options = { apiKey, accessToken: 'test-management-token', projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
    verifyCredential: async input => { assert.deepEqual(input, { apiKey }); state.probes++; return state.verified; },
    fetchImpl: async (url, init) => {
      state.calls.push({ url, init });
      if (init.method === 'PATCH') Object.assign(state.config, JSON.parse(init.body));
      const response = new Response(JSON.stringify(state.config), { status: state.status });
      Object.defineProperty(response, 'redirected', { value: state.redirected });
      return response;
    },
  };
  return { state, options };
}
test('Auth SMTP setup verifies closed policy/key before exact PATCH and read-back', async () => {
  const f = fixture();
  assert.deepEqual(await configureProductionAuthEmail(f.options), { configured: true, credentialVerified: true, emailSent: false });
  assert.equal(f.state.probes, 1);
  assert.deepEqual(f.state.calls.map(call => call.init.method), ['GET', 'PATCH', 'GET']);
  const patch = f.state.calls[1];
  assert.equal(patch.url, `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/config/auth`);
  assert.deepEqual(JSON.parse(patch.init.body), { ...AUTH_EMAIL_SETTINGS, smtp_pass: apiKey });
  for (const { init } of f.state.calls) {
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert(init.signal instanceof AbortSignal);
  }
});
test('Auth SMTP setup preserves existing different providers and closed-signup invariants', async () => {
  for (const patch of [{ smtp_host: 'another.provider.example' }, { disable_signup: false }, { mailer_autoconfirm: true }, { mailer_allow_unverified_email_sign_ins: true }, { mailer_otp_exp: 60 }]) {
    const f = fixture(); Object.assign(f.state.config, patch);
    await denied(() => configureProductionAuthEmail(f.options));
    assert.equal(f.state.probes, 0); assert.equal(f.state.calls.length, 1);
  }
});
test('Auth SMTP invalid key, project, transport and provider rejection never perform PATCH', async () => {
  for (const patch of [{ apiKey: '' }, { projectRef: 'other-project' }, { accessToken: 'invalid\ntoken' }]) {
    const f = fixture(); await denied(() => configureProductionAuthEmail({ ...f.options, ...patch })); assert.equal(f.state.calls.length, 0);
  }
  for (const change of ['status', 'redirect', 'credential', 'throw']) {
    const f = fixture();
    if (change === 'status') f.state.status = 403;
    if (change === 'redirect') f.state.redirected = true;
    if (change === 'credential') f.state.verified = false;
    if (change === 'throw') f.options.fetchImpl = () => Promise.reject(new Error(apiKey));
    await denied(() => configureProductionAuthEmail(f.options));
    assert(!f.state.calls.some(call => call.init.method === 'PATCH'));
  }
});
test('Auth SMTP post-write drift and oversize response fail without exposing secrets', async () => {
  const f = fixture(); const fetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    if (f.state.calls.length === 2) f.state.config.smtp_host = 'other';
    return fetch(url, init);
  };
  await denied(() => configureProductionAuthEmail(f.options));
  const g = fixture(); g.options.fetchImpl = async () => new Response(JSON.stringify({ ...CLOSED_AUTH_CONFIG_PATCH, smtp_pass: apiKey, body: 'x'.repeat(262144) }));
  await denied(() => configureProductionAuthEmail(g.options));
});

test('Auth SMTP preflight bounds stalled fetch and response body without a write', async () => {
  for (const body of [false, true]) {
    const f = fixture(); let cancelled = false;
    f.options.fetchImpl = async () => body ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : new Promise(() => {});
    await denied(() => configureProductionAuthEmail({ ...f.options, requestTimeoutMs: 5 }));
    assert.equal(f.state.probes, 0);
    if (body) assert(cancelled);
  }
});
