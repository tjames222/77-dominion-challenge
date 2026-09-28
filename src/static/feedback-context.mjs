import { feedbackRoute } from './feedback-route.mjs';
import { normalizeFeedbackContext } from './feedback-contract.mjs';

// Only coarse enums leave this function. No raw user agent, full URL, DOM,
// storage, referrer or user identity is accepted by the resulting contract.
export function coarseFeedbackEnvironment(userAgent) {
  const agent = typeof userAgent === 'string' && userAgent.length <= 2048 ? userAgent : '';
  const browser = !agent ? 'unknown' : /Firefox|FxiOS/i.test(agent) ? 'firefox'
    : /Chrome|Chromium|CriOS|Edg\//i.test(agent) ? 'chromium'
      : /Safari/i.test(agent) ? 'safari' : 'other';
  const platform = !agent ? 'unknown' : /Android/i.test(agent) ? 'android'
    : /iPhone|iPad|iPod/i.test(agent) ? 'ios' : /Windows/i.test(agent) ? 'windows'
      : /Macintosh|Mac OS X/i.test(agent) ? 'macos' : /Linux/i.test(agent) ? 'linux' : 'other';
  return Object.freeze({ browser, platform });
}
export function createFeedbackContext({ pathname, theme, width, height, buildSha, userAgent } = {}) {
  return normalizeFeedbackContext({ route: feedbackRoute(pathname), theme,
    viewport: { width: Math.round(width), height: Math.round(height) }, buildSha,
    ...coarseFeedbackEnvironment(userAgent) });
}
