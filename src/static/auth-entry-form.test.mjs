import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createAuthEntryTransition } from './auth-entry-transition.mjs';
import { finishAuthLanding } from './auth-landing.mjs';

const source = readFileSync(new URL('./auth.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '');

for (const register of [false, true]) {
  test((register ? 'Register' : 'Login') + ' owns optional hydration through failure, no-session response, retry, and continuation', async () => {
    const entry = createAuthEntryTransition(); let submit; let attempt = 0;
    const button = { textContent: 'Continue', disabled: false };
    const fields = { email: { value: 'synthetic@example.test' }, password: { value: 'Synthetic password' } };
    if (register) fields.name = { value: 'Synthetic member' };
    const form = { querySelector: () => button, addEventListener: (event, callback) => { if (event === 'submit') submit = callback; } };
    const location = { search: '', origin: 'https://synthetic.example.test', href: '/login.html' };
    const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const session = { user: { id: actorId }, access_token: `synthetic.${Buffer.from(JSON.stringify({ sub: actorId, session_id: '11111111-1111-4111-8111-111111111111' })).toString('base64url')}.signature` };
    let currentSession = null;
    const authenticate = async () => {
      assert.equal(entry.capture(), null, 'Pause precedes the SDK call and synchronous Auth notification.');
      attempt += 1;
      if (attempt === 1) throw new Error('Synthetic retryable failure');
      if (attempt === 2) return { session: null };
      currentSession = session;
      return { session, mfaRequired: false };
    };
    runInNewContext(source, {
      authEntryTransition: entry, finishAuthLanding, URLSearchParams,
      document: { getElementById: id => id === 'authForm' ? form : fields[id] || null, querySelector: () => null },
      window: { location, alert() {}, addEventListener() {}, removeEventListener() {} },
      RELEASE_GATES: { publicSignupEnabled: true }, initReveal() {},
      hasSupabaseAuthentication: () => true, getAuthSession: async () => currentSession,
      getSiteAdminContext: async () => { throw new Error('Explicit destination must not read admin context.'); },
      getBillingState: async () => { throw new Error('Explicit destination must not read billing.'); },
      subscribeToAuthStateChanges: () => () => {},
      sanitizeReturnTo: () => './support.html', isInviteReturnPath: () => false, isChallengeStartReturnPath: () => false,
      signInWithPassword: register ? () => { throw new Error('Unexpected login'); } : authenticate,
      signUpWithPassword: register ? authenticate : () => { throw new Error('Unexpected signup'); },
      saveLocalUserFromSession() {},
    });
    for (let i = 0; i < 2; i += 1) {
      const previous = entry.capture();
      await submit({ preventDefault() {} });
      assert.ok(entry.isCurrent(entry.capture()));
      assert.equal(entry.isCurrent(previous), false, 'Resume uses a fresh generation.');
      assert.equal(button.disabled, false);
      assert.equal(location.href, '/login.html');
    }
    await submit({ preventDefault() {} });
    assert.equal(location.href, './support.html');
    assert.equal(entry.capture(), null, 'Committed navigation never resumes the departing document.');
    assert.equal(attempt, 3);
  });
}
