import assert from 'node:assert/strict';
import test from 'node:test';
import { validProviderMessageId } from './provider-message-id.mjs';
import { initialState, parseHealth, reduceObservation, scheduledSlot, settleNotification, validState } from './core.mjs';
import { sendNotification } from './transport.mjs';
import { BASE, healthBody } from './test-fixtures.mjs';

function pending() {
  return reduceObservation(initialState(), { slot: scheduledSlot(BASE, BASE), now: BASE,
    health: parseHealth(healthBody(BASE, 101), BASE), alertsEnabled: true });
}
const nativeId = '<ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@77dominion.com>';
const accepted = ['provider-message-123', 'a'.repeat(8), 'A'.repeat(128), nativeId,
  '<a@b.c>', '<a.b-c_d+e@sub.mail.example>', `<${'a'.repeat(64)}@${'b'.repeat(57)}.com>`];
for (const [index, messageId] of accepted.entries()) {
  test(`provider receipt ${index} survives transport, settlement and serialized state unchanged`, async () => {
    assert.equal(validProviderMessageId(messageId), true);
    const result = pending(); let calls = 0;
    const outcome = await sendNotification({ send: async () => { calls++; return { messageId }; } }, result.intent);
    assert.deepEqual(outcome, { status: 'accepted', messageId });
    const state = validState(JSON.parse(JSON.stringify(settleNotification(result.state, outcome, BASE + 1))));
    assert.equal(state.notification.providerMessageId, messageId);
    assert.equal(state.notification.status, 'accepted'); assert.equal(state.needsReview, false);
    assert.equal(state.daily.count, 1); assert.equal(calls, 1);
  });
}
const rejected = [undefined,null,7,{},'', 'short', 'A'.repeat(129), `${nativeId}\n`, `${nativeId}\r\nBcc:bad@example.com`,
  `${nativeId}\0`, `${nativeId}\t`, ` ${nativeId}`, '<a b@example.com>', '<a\tb@example.com>',
  '<unicodé@example.com>', '<a@examplé.com>', '<@example.com>', '<a@@example.com>', '<a@example.com',
  'a@example.com>', '<<a@example.com>>', '<a..b@example.com>', '<.a@example.com>', '<a.@example.com>',
  '<a@example..com>', '<a@-example.com>', '<a@example-.com>', '<a@example.com.>', '<a@localhost>',
  `<${'a'.repeat(65)}@example.com>`, `<a@${'b'.repeat(64)}.com>`, '<a@example.com> arbitrary text'];
for (const [index, messageId] of rejected.entries()) {
  test(`invalid provider receipt ${index} remains unknown without retry and cannot enter accepted state`, async () => {
    assert.equal(validProviderMessageId(messageId), false);
    const result = pending(); let calls = 0;
    const outcome = await sendNotification({ send: async () => { calls++; return { messageId }; } }, result.intent);
    assert.deepEqual(outcome, { status: 'delivery_unknown' }); assert.equal(calls, 1);
    for (const candidate of [outcome, { status: 'accepted', messageId }]) {
      const state = validState(JSON.parse(JSON.stringify(settleNotification(result.state, candidate, BASE + 1))));
      assert.equal(state.notification.status, 'delivery_unknown'); assert.equal(state.needsReview, true);
      assert.equal(state.notification.providerMessageId, null); assert.equal(state.daily.count, 1);
    }
    const invalidState = settleNotification(result.state, { status: 'accepted', messageId: nativeId }, BASE + 1);
    invalidState.notification.providerMessageId = messageId;
    assert.throws(() => validState(invalidState));
  });
}
