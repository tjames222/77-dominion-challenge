import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
const entries = new Set(Object.values(PRODUCTION_ENTRYPOINTS));
const authRoutes = new Set(['login.html', 'register.html', 'forgot-password.html', 'reset-password.html', 'account-security.html']);

export function mfaReturnTo(candidate, origin) {
  try {
    const url = new URL(candidate || './dashboard.html', origin);
    if (url.origin !== origin || url.username || url.password) return './dashboard.html';
    const file = url.pathname.split('/').filter(Boolean).pop() || 'dashboard.html';
    const html = file.includes('.') ? file : `${file}.html`;
    if (!entries.has(html) || authRoutes.has(html)) return './dashboard.html';
    const sensitiveKeys = /^(?:code|invite|token|access_token|refresh_token|secret)$/i;
    const containsSecret = (value) => [...new URLSearchParams(value).keys()].some((key) => sensitiveKeys.test(key));
    if (containsSecret(url.search) || containsSecret(url.hash.replace(/^#\??/, ''))) {
      return html === 'invite.html' ? './invite.html' : './dashboard.html';
    }
    return `./${html}${url.search}${url.hash}`;
  } catch { return './dashboard.html'; }
}

export function mfaChallengeHref(returnTo, origin, { stepUp = false } = {}) {
  return `./account-security.html?mode=${stepUp ? 'step-up' : 'challenge'}&returnTo=${encodeURIComponent(mfaReturnTo(returnTo, origin))}`;
}
