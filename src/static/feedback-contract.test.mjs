import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDBACK_TYPES, FEEDBACK_IMPACTS, FEEDBACK_ROUTES, FEEDBACK_LIMITS,
  normalizeFeedbackInput, normalizeFeedbackContext, normalizeFeedbackOwner,
  createFeedbackIntent, normalizeFeedbackReceipt } from './feedback-contract.mjs';

const actorId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const feedbackId = '33333333-3333-4333-8333-333333333333';
const owner = { actorId, sessionIdentity: `${actorId}:${operationId}` };
const input = { type: 'bug', description: '  Original\nfeedback.  ', expectedBehavior: '\nDesired result\n', impact: 'minor', contactAllowed: false };
const context = { route: 'dashboard.html', theme: 'dark', viewport: { width: 390, height: 844 }, buildSha: 'a'.repeat(40), browser: 'safari', platform: 'ios' };
const receipt = { schemaVersion: 1, operationId, feedbackId, actorId, status: 'saved' };

test('feedback uses exact ticket categories and impacts, preserves verbatim text and boolean consent', () => {
  assert.deepEqual(Object.values(FEEDBACK_TYPES), ['Bug', 'Design or UI', 'UX or usability', 'Feature idea', 'Performance', 'Other']);
  assert.deepEqual(Object.values(FEEDBACK_IMPACTS), ['Blocking', 'Frustrating', 'Minor', 'Suggestion']);
  assert.deepEqual(normalizeFeedbackInput(input), input);
  assert.equal(Object.isFrozen(normalizeFeedbackInput(input)), true);
  const { expectedBehavior, ...optional } = input;
  assert.equal(normalizeFeedbackInput(optional).expectedBehavior, '');
  for (const type of Object.keys(FEEDBACK_TYPES)) for (const impact of Object.keys(FEEDBACK_IMPACTS)) {
    assert.equal(normalizeFeedbackInput({ ...input, type, impact, contactAllowed: true }).contactAllowed, true);
  }
});

test('input fails closed for unknown/private fields, attachments, malformed enums, coercion and invalid bounds', () => {
  for (const patch of [
    { attachments: [] }, { screenshot: 'data:private' }, { email: 'private' }, { actorId }, { [Symbol('extra')]: true },
    { type: 'Bug' }, { type: 'constructor' }, { type: { toString: () => 'bug' } }, { impact: 'urgent' },
    { contactAllowed: 'true' }, { contactAllowed: 0 }, { description: '\n\t ' }, { description: null },
    { description: 'x'.repeat(FEEDBACK_LIMITS.description + 1) }, { expectedBehavior: null },
    { expectedBehavior: 'x'.repeat(FEEDBACK_LIMITS.expectedBehavior + 1) },
  ]) assert.throws(() => normalizeFeedbackInput({ ...input, ...patch }), { code: 'FEEDBACK_INVALID_INPUT' });
  for (const bad of [null, [], new Map(), Object.create(input)]) assert.throws(() => normalizeFeedbackInput(bad));
  assert.equal(normalizeFeedbackInput({ ...input, description: 'x'.repeat(10000), expectedBehavior: 'y'.repeat(5000) }).description.length, 10000);
});

test('text rejects PostgreSQL NUL and ill-formed Unicode without changing valid original Unicode', () => {
  for (const value of ['a\0b', '\uD800', '\uDC00', '\uD800a', 'a\uDC00', '\uDC00\uD800']) {
    for (const field of ['description', 'expectedBehavior']) assert.throws(() => normalizeFeedbackInput({ ...input, [field]: value }), { code: 'FEEDBACK_INVALID_INPUT', field });
  }
  const text = '  Café e\u0301 🕊️\r\n祈り\t ';
  assert.equal(normalizeFeedbackInput({ ...input, description: text, expectedBehavior: text }).description, text);
  assert.equal(normalizeFeedbackInput({ ...input, description: text, expectedBehavior: text }).expectedBehavior, text);
});

test('context admits only the fourteen reviewed member/account route names and four actual themes', () => {
  assert.equal(FEEDBACK_ROUTES.length, 14);
  for (const route of FEEDBACK_ROUTES) for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
    assert.equal(normalizeFeedbackContext({ ...context, route, theme }).route, route);
  }
  for (const route of ['admin.html', 'invite.html', 'early-access.html', 'account-security.html', 'index.html', 'membership.html', 'science.html',
    'support.html', 'login.html', 'register.html', 'forgot-password.html', 'reset-password.html', 'privacy.html', 'terms.html',
    'cancellation-refunds.html', '/dashboard.html', 'dashboard', 'dashboard.html?token=secret', 'dashboard.html#secret', 'https://example.com/dashboard.html']) {
    assert.throws(() => normalizeFeedbackContext({ ...context, route }));
  }
});

test('context excludes raw URL/UA/private metadata and rejects malformed bounded values', () => {
  for (const patch of [{ query: '?private' }, { email: 'private' }, { timestamp: 'now' }, { userAgent: 'raw' }, { theme: 'dominion' },
    { browser: 'Safari/123 private' }, { platform: 'iPhone model' }, { buildSha: 'short' }, { buildSha: 'A'.repeat(40) },
    { viewport: { width: 0, height: 1 } }, { viewport: { width: NaN, height: 1 } }, { viewport: { width: 1.5, height: 1 } },
    { viewport: { width: 1, height: Infinity } }, { viewport: { width: 16385, height: 1 } }, { viewport: { width: 1, height: 1, x: 0 } }]) {
    assert.throws(() => normalizeFeedbackContext({ ...context, ...patch }));
  }
  const normalized = normalizeFeedbackContext(context);
  assert.notEqual(normalized.viewport, context.viewport);
  assert.equal(Object.isFrozen(normalized.viewport), true);
});

test('owner is exact actor and immutable session; intent is deeply frozen without trusted identity fields', () => {
  assert.deepEqual(normalizeFeedbackOwner(owner), owner);
  for (const patch of [{ actorId: 'member' }, { sessionIdentity: `${feedbackId}:${operationId}` }, { sessionIdentity: actorId }, { token: 'secret' }]) {
    assert.throws(() => normalizeFeedbackOwner({ ...owner, ...patch }));
  }
  const intent = createFeedbackIntent(input, context, operationId);
  assert.deepEqual(Object.keys(intent), ['operationId', 'input', 'context']);
  for (const object of [intent, intent.input, intent.context, intent.context.viewport]) assert.equal(Object.isFrozen(object), true);
  assert.notEqual(createFeedbackIntent(input, context).operationId, createFeedbackIntent(input, context).operationId);
  assert.throws(() => createFeedbackIntent(input, context, 'not-an-operation'));
});

test('only a fixed persisted receipt bound to exact original operation and actor confirms success', () => {
  const intent = createFeedbackIntent(input, context, operationId);
  assert.deepEqual(normalizeFeedbackReceipt(receipt, intent, owner), receipt);
  for (const patch of [{ schemaVersion: 2 }, { status: 'queued' }, { operationId: feedbackId }, { actorId: feedbackId }, { feedbackId: '' },
    { delivery: 'sent' }, { rawProviderResponse: {} }, { token: 'secret' }]) {
    assert.throws(() => normalizeFeedbackReceipt({ ...receipt, ...patch }, intent, owner), { code: 'FEEDBACK_UNCONFIRMED' });
  }
  for (const value of [null, {}, [], { status: 'saved' }]) assert.throws(() => normalizeFeedbackReceipt(value, intent, owner));
  assert.throws(() => normalizeFeedbackReceipt({ ...receipt, actorId: undefined, operationId: undefined }, {}, {}));
});
