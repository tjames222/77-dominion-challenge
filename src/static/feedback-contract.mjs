// Policy-neutral transport values only. Authentication, EA eligibility and
// delivery remain the responsibility of the future owner-bound server adapter.
export const FEEDBACK_TYPES = Object.freeze({
  bug: 'Bug', design_ui: 'Design or UI', ux_usability: 'UX or usability',
  feature_idea: 'Feature idea', performance: 'Performance', other: 'Other',
});
export const FEEDBACK_IMPACTS = Object.freeze({
  blocking: 'Blocking', frustrating: 'Frustrating', minor: 'Minor', suggestion: 'Suggestion',
});
export const FEEDBACK_ROUTES = Object.freeze([
  'dashboard.html', 'badges-rewards.html', 'bible-reading.html', 'morning-prayer.html',
  'worship.html', 'evening-prayer.html', 'workout-one.html', 'intentional-walk.html',
  'workout-two.html', 'community.html', 'group-settings.html', 'private-journal.html',
  'billing.html', 'profile.html',
]);
export const FEEDBACK_LIMITS = Object.freeze({ description: 10000, expectedBehavior: 5000, viewport: 16384 });
const themes = ['light', 'dark', 'dominion-night', 'dominion-platinum'];
const browsers = ['chromium', 'firefox', 'safari', 'other', 'unknown'];
const platforms = ['windows', 'macos', 'linux', 'android', 'ios', 'other', 'unknown'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const invalid = (field = '') => Object.assign(new TypeError('Check the feedback fields and try again.'), { code: 'FEEDBACK_INVALID_INPUT', field });
function exactObject(value, allowed, required = allowed) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function boundedText(value, limit, field, required = false) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (required && !value.trim())) throw invalid(field);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xDC00 && following <= 0xDFFF)) throw invalid(field);
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) throw invalid(field);
  }
  return value; // Preserve the reporter's original text, including whitespace.
}
export function normalizeFeedbackInput(value) {
  exactObject(value, ['type', 'description', 'expectedBehavior', 'impact', 'contactAllowed'], ['type', 'description', 'impact', 'contactAllowed']);
  if (typeof value.type !== 'string' || !Object.hasOwn(FEEDBACK_TYPES, value.type)) throw invalid('type');
  if (typeof value.impact !== 'string' || !Object.hasOwn(FEEDBACK_IMPACTS, value.impact)) throw invalid('impact');
  if (typeof value.contactAllowed !== 'boolean') throw invalid('contactAllowed');
  return Object.freeze({
    type: value.type,
    description: boundedText(value.description, FEEDBACK_LIMITS.description, 'description', true),
    expectedBehavior: boundedText(Object.hasOwn(value, 'expectedBehavior') ? value.expectedBehavior : '', FEEDBACK_LIMITS.expectedBehavior, 'expectedBehavior'),
    impact: value.impact,
    contactAllowed: value.contactAllowed,
  });
}
export function normalizeFeedbackContext(value) {
  exactObject(value, ['route', 'theme', 'viewport', 'buildSha', 'browser', 'platform']);
  exactObject(value.viewport, ['width', 'height']);
  if (!FEEDBACK_ROUTES.includes(value.route) || !themes.includes(value.theme)
    || !browsers.includes(value.browser) || !platforms.includes(value.platform)
    || typeof value.buildSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.buildSha)
    || ['width', 'height'].some(key => !Number.isInteger(value.viewport[key])
      || value.viewport[key] < 1 || value.viewport[key] > FEEDBACK_LIMITS.viewport)) throw invalid('context');
  return Object.freeze({ route: value.route, theme: value.theme,
    viewport: Object.freeze({ width: value.viewport.width, height: value.viewport.height }),
    buildSha: value.buildSha, browser: value.browser, platform: value.platform });
}
export function normalizeFeedbackOwner(value) {
  exactObject(value, ['actorId', 'sessionIdentity']);
  if (typeof value.actorId !== 'string' || !uuid.test(value.actorId) || typeof value.sessionIdentity !== 'string'
    || !value.sessionIdentity.startsWith(`${value.actorId}:`)
    || !uuid.test(value.sessionIdentity.slice(value.actorId.length + 1))) throw invalid('owner');
  return Object.freeze({ actorId: value.actorId, sessionIdentity: value.sessionIdentity });
}
export function createFeedbackIntent(input, context, operationId = globalThis.crypto.randomUUID()) {
  if (typeof operationId !== 'string' || !uuid.test(operationId)) throw invalid('operationId');
  return Object.freeze({ operationId, input: normalizeFeedbackInput(input), context: normalizeFeedbackContext(context) });
}
export function normalizeFeedbackReceipt(value, intent, owner) {
  const failure = () => { throw Object.assign(new Error('Feedback could not yet be confirmed as saved.'), { code: 'FEEDBACK_UNCONFIRMED' }); };
  try { exactObject(value, ['schemaVersion', 'operationId', 'feedbackId', 'actorId', 'status']); } catch { failure(); }
  if (value.schemaVersion !== 1 || value.status !== 'saved'
    || typeof value.operationId !== 'string' || !uuid.test(value.operationId)
    || typeof value.actorId !== 'string' || !uuid.test(value.actorId)
    || typeof value.feedbackId !== 'string' || !uuid.test(value.feedbackId) || value.operationId !== intent?.operationId
    || value.actorId !== owner?.actorId) failure();
  return Object.freeze({ schemaVersion: 1, operationId: value.operationId,
    feedbackId: value.feedbackId, actorId: value.actorId, status: 'saved' });
}
