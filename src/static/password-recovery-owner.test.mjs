import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createPasswordRecoveryOwnerBridge } from './password-recovery-owner.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = (actor = id, extra = '') => ({ user: { id: actor }, access_token: `${encode({})}.${encode({ sub: actor, session_id: sid, extra })}.${encode('synthetic')}` });
function fixture() {
  let observer; let nativeCalls = 0; let unsubscribed = false;
  const events = new Map();
  const bridge = createPasswordRecoveryOwnerBridge({ auth: {
    onAuthStateChange(callback) { observer = callback; return { data: { subscription: { unsubscribe() { unsubscribed = true; } } } }; },
    getUser() { nativeCalls++; }, getSession() { nativeCalls++; },
  }, sessionIdentity: authSessionIdentity, authStorageKey: 'sb-test-auth-token',
  eventTarget: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) } });
  return { bridge, emit: (event, value = session()) => observer(event, value), events,
    nativeCalls: () => nativeCalls, unsubscribed: () => unsubscribed };
}
test('eager bridge keeps exactly the latest immutable recovery evidence for delayed reset-only controller', () => {
  const f = fixture(); const original = session(); const token = original.access_token;
  f.emit('PASSWORD_RECOVERY', original); original.user.id = other; original.access_token = 'mutated';
  const events = []; f.bridge.connect((...args) => events.push(args));
  assert.equal(events.length, 1); assert.equal(events[0][0], 'PASSWORD_RECOVERY');
  assert.equal(events[0][1].user.id, id); assert.equal(events[0][1].access_token, token);
  assert.equal(f.nativeCalls(), 0); f.bridge.destroy();
});
for (const mode of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'replacement', 'ABA', 'silent-token', 'storage']) {
  test(`eager ${mode} invalidation cannot be resurrected by lazy controller loading`, () => {
    const f = fixture(); f.emit('PASSWORD_RECOVERY');
    if (mode === 'replacement' || mode === 'ABA') { f.emit('SIGNED_IN', session(other)); if (mode === 'ABA') f.emit('SIGNED_IN'); }
    else if (mode === 'silent-token') f.emit('SIGNED_IN', session(id, 'new token'));
    else if (mode === 'storage') f.events.get('storage')({ key: 'sb-test-auth-token' });
    else f.emit(mode);
    const events = []; f.bridge.connect((...args) => events.push(args)); assert.equal(events.length, 0); f.bridge.destroy();
  });
}
test('pagehide clears evidence and disallows a late lazy subscription', () => {
  const f = fixture(); f.emit('PASSWORD_RECOVERY'); f.events.get('pagehide')();
  assert.throws(() => f.bridge.connect(() => {})); assert.equal(f.unsubscribed(), true);
});
test('ordinary same-session focus retains evidence but never creates it; getters are rejected without invocation', () => {
  const f = fixture(); f.emit('SIGNED_IN'); const initial = []; const sub = f.bridge.connect((...args) => initial.push(args));
  assert.equal(initial.length, 0); sub.data.subscription.unsubscribe();
  f.emit('PASSWORD_RECOVERY'); f.emit('SIGNED_IN'); f.emit('INITIAL_SESSION');
  const later = []; f.bridge.connect((...args) => later.push(args)); assert.equal(later[0][0], 'PASSWORD_RECOVERY');
  let read = false; f.emit('PASSWORD_RECOVERY', { user: { id }, get access_token() { read = true; throw new Error('PRIVATE'); } });
  assert.equal(read, false); const invalid = []; f.bridge.connect((...args) => invalid.push(args)); assert.equal(invalid.length, 0); f.bridge.destroy();
});
test('API captures lifecycle eagerly but loads the mutation controller only for the reset UI', () => {
  const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  assert.match(api, /import \{ createPasswordRecoveryOwnerBridge \} from '\.\/password-recovery-owner\.mjs'/);
  assert.match(api, /import\('\.\/account-recovery-session\.mjs'\)/);
  assert.doesNotMatch(api, /import \{ createPasswordRecoveryController \}/);
  assert.match(readFileSync(new URL('./password-recovery.js', import.meta.url), 'utf8'), /await loadPasswordRecoveryController\(\)/);
});
