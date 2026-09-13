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
    const sensitiveKeys = /^(?:code|invite|token|token_hash|access_token|refresh_token|provider_token|provider_refresh_token|secret|returnto|redirect|redirectto|next)$/i;
    const containsSecret = (value) => [...new URLSearchParams(value).keys()].some((key) => sensitiveKeys.test(key));
    if (containsSecret(url.search) || containsSecret(url.hash.replace(/^#\??/, ''))) {
      return html === 'invite.html' ? './invite.html' : './dashboard.html';
    }
    // Keep only known application navigation intent, never arbitrary query or
    // fragment content (including nested redirects and future provider keys).
    const safeSearch = new URLSearchParams();
    if (html === 'community.html' && url.searchParams.get('intent') === 'challenge-start') safeSearch.set('intent', 'challenge-start');
    if (html === 'dashboard.html' && ['solo', 'group'].includes(url.searchParams.get('start'))) safeSearch.set('start', url.searchParams.get('start'));
    const allowedAnchors = { 'profile.html': ['appearance', 'billing'], 'dashboard.html': ['challenge'], 'badges-rewards.html': ['rewards', 'badges'] };
    const safeHash = (allowedAnchors[html] || []).includes(url.hash.slice(1)) ? url.hash : '';
    const search = safeSearch.toString();
    return `./${html}${search ? `?${search}` : ''}${safeHash}`;
  } catch { return './dashboard.html'; }
}

export function mfaChallengeHref(returnTo, origin, { stepUp = false } = {}) {
  return `./account-security.html?mode=${stepUp ? 'step-up' : 'challenge'}&returnTo=${encodeURIComponent(mfaReturnTo(returnTo, origin))}`;
}
