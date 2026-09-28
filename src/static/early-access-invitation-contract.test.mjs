import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  invitationCapabilityFromFragment, normalizeInvitationCapability, createInvitationAcceptanceIntent,
  normalizeInvitationAcceptanceIntent, normalizeInvitationAcceptanceReceipt, createInvitationContinuation,
} from './early-access-invitation-contract.mjs';
const generationId = '10000000-0000-4000-8000-000000000001';
const operationId = '20000000-0000-4000-8000-000000000002';
const correlationId = '30000000-0000-4000-8000-000000000003';
const actorId = '40000000-0000-4000-8000-000000000004';
const token = 'A'.repeat(43); const capability = { generationId, token };
const fragment = `#token=${token}&generation=${generationId}`;
test('only exact fragment capabilities and canonical 32-byte base64url tokens are accepted', () => {
  assert.deepEqual(invitationCapabilityFromFragment(fragment), capability);
  assert.ok(Object.isFrozen(normalizeInvitationCapability(capability)));
  for (const bad of ['', fragment.slice(1), fragment + '&token=another', fragment + '&x=1',
    fragment.replace(token, token.slice(0, 42) + 'B'), fragment.replace('token=', 'access_token='),
    fragment.replace(token, '%41' + token.slice(1)), fragment.replace(generationId, 'bad'),
    `#generation=${generationId}&token=${token}`, fragment + '#']) {
    assert.throws(() => invitationCapabilityFromFragment(bad), { code: 'INVITATION_INVALID' });
  }
  for (const bad of [{ ...capability, email: 'private@example.com' }, { token }, [], null,
    { generationId, get token() { throw new Error('should not read'); } }]) assert.throws(() => normalizeInvitationCapability(bad));
});
test('acceptance intent is frozen, explicit, and rejects native auth or mailbox additions', () => {
  const intent = createInvitationAcceptanceIntent(capability, operationId, correlationId);
  assert.deepEqual(normalizeInvitationAcceptanceIntent(intent), { ...capability, operationId, correlationId });
  assert.ok(Object.isFrozen(intent));
  for (const changed of [{ access_token: 'native' }, { recipient: 'a@example.com' }, { operationId: '' }, { correlationId: null },
    { operationId: undefined }, { correlationId: undefined }]) {
    assert.throws(() => normalizeInvitationAcceptanceIntent({ ...intent, ...changed }));
  }
});
test('only the exact self receipt or a fixed failure is publishable', () => {
  const receipt = { ok: true, status: 'accepted', actorId, program: 'early_access_v1' };
  assert.deepEqual(normalizeInvitationAcceptanceReceipt(receipt, actorId), receipt);
  for (const changed of [{ actorId: generationId }, { program: 'paid' }, { status: 'approved' }, { nativeToken: 'private' }]) {
    assert.throws(() => normalizeInvitationAcceptanceReceipt({ ...receipt, ...changed }, actorId), { code: 'INVITATION_UNCONFIRMED' });
  }
  assert.deepEqual(normalizeInvitationAcceptanceReceipt({ ok: false, errorCode: 'account_setup_required' }, actorId), { ok: false, errorCode: 'account_setup_required' });
  assert.throws(() => normalizeInvitationAcceptanceReceipt({ ok: false, errorCode: 'private SQL' }, actorId));
});
function fixture() {
  let clock = 1000000; let saved = null; const events = [];
  const storage = { getItem: () => saved, setItem(key, value) { events.push('save'); saved = value; }, removeItem() { events.push('clear'); saved = null; } };
  const history = { replaceState(state, title, url) { events.push(['strip', state, title, url]); } };
  const continuation = createInvitationContinuation({ storage, now: () => clock });
  return { continuation, history, events, saved: () => saved, setRaw(value) { saved = value; }, time(value) { clock = value; } };
}
test('capture strips the entire fragment/query first and persists only a tab-local bounded continuation', () => {
  const f = fixture();
  assert.deepEqual(f.continuation.capture({ hash: fragment, search: '?returnTo=private' }, f.history), capability);
  assert.deepEqual(f.events[0], ['strip', null, '', './early-access-invite.html']);
  assert.deepEqual(JSON.parse(f.saved()), { ...capability, capturedAt: 1000000 });
  assert.deepEqual(f.continuation.capture({ hash: '' }, f.history), capability);
  f.time(1000000 + 15 * 60 * 1000); assert.equal(f.continuation.read(), null); assert.equal(f.saved(), null);
});
test('malformed fragments replace no older capability; stripping failure prevents processing', () => {
  const f = fixture(); f.continuation.capture({ hash: fragment }, f.history);
  assert.throws(() => f.continuation.capture({ hash: '#access_token=native' }, f.history));
  assert.equal(f.saved(), null);
  assert.throws(() => f.continuation.capture({ hash: fragment }, { replaceState() { throw new Error('blocked'); } }));
  assert.equal(f.saved(), null);
});
test('invalid, future, oversized, or extended stored continuations are cleared', () => {
  for (const value of ['invalid', 'x'.repeat(257), JSON.stringify({ ...capability, capturedAt: 1000001 }),
    JSON.stringify({ ...capability, capturedAt: 1000000, session: 'native' }), JSON.stringify({ ...capability, capturedAt: 0 })]) {
    const f = fixture(); f.setRaw(value); assert.equal(f.continuation.read(), null); assert.equal(f.saved(), null);
  }
});
test('blocked storage never prevents immediate in-memory capture or safe cleanup', () => {
  const store = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const c = createInvitationContinuation({ storage: store, now: () => 1000000 });
  assert.deepEqual(c.capture({ hash: fragment }, { replaceState() {} }), capability); assert.equal(c.read(), null); c.clear();
});
test('invalid continuation clocks clear saved tokens instead of extending their lifetime', () => {
  for (const clock of [NaN, Infinity, -1, 1.5]) {
    const f = fixture(); f.continuation.capture({ hash: fragment }, f.history); f.time(clock);
    assert.equal(f.continuation.read(), null); assert.equal(f.saved(), null);
  }
});
