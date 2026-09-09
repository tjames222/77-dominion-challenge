// A public, read-only adapter for the existing share-snapshot presentation.
// This source is emitted only by reviewed production-connected main builds.
const SITE = 'https://77dominion.com';
const UPSTREAM = 'https://mimolwojppbtsbvtqwpo.supabase.co/functions/v1/share-snapshot';
const HOSTS = new Set(['77dominion.com', 'www.77dominion.com', '77-dominion-live.pages.dev']);
const TOKEN_PATH = /^\/share\/([a-f0-9]{64})$/;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 32_768;
const STYLE = ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#070807;color:#f4f0e7;font:16px/1.6 system-ui,sans-serif}.share{width:min(100%,720px);padding:clamp(24px,7vw,64px);border:1px solid #665527;border-radius:28px;background:#11130f}.eyebrow,.metric-label{color:#d8b85b;font-weight:850}.eyebrow{text-transform:uppercase;font-size:.75rem;letter-spacing:.12em}.metric{margin:24px 0 0;font-size:clamp(4rem,18vw,8rem);font-weight:900;line-height:1}.metric-label{margin:8px 0}h1{font-size:clamp(2rem,7vw,3.6rem);line-height:1.05}.copy{color:#bbb8af}.cta{display:inline-flex;margin-top:20px;padding:14px 18px;border-radius:14px;background:#e1c46b;color:#19150a;font-weight:800;text-decoration:none}.mark{margin-top:32px;color:#aaa;font-size:.75rem}a:focus-visible{outline:3px solid #fff;outline-offset:4px}';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

function responseHtml(body, status) {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https://77dominion.com; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Dominion-Share-Route': '1',
  } });
}

function unavailable(status = 404) {
  return responseHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Share unavailable | Dominion</title><style>${STYLE}</style></head><body><main class="share"><h1>This share is no longer available.</h1><p class="copy">The link may have expired or been revoked. No account or group information has been exposed.</p><a class="cta" href="${SITE}" rel="noopener noreferrer">Visit Dominion</a></main></body></html>`, status);
}

// The upstream template exposes only public presentation text. Extract that
// bounded text, not its HTML/CSS/URLs: the browser receives our own document.
function presentation(html) {
  if (!/^<!doctype html>/i.test(html.trimStart()) || !/<html lang="en">/i.test(html)
    || /<(?:script|iframe|object|embed|base|form|input|button|svg|math|template)\b/i.test(html)
    || /<[^>]+\s(?:on[a-z]+|srcdoc|http-equiv)\s*=/i.test(html)) return null;
  const text = (pattern, limit) => {
    const matches = [...html.matchAll(pattern)];
    if (matches.length !== 1) return null;
    const value = matches[0][1];
    if (!value || value.length > limit || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) return null;
    return value.replace(/&(?:amp|lt|gt|quot|#039);/g, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'",
    })[entity]);
  };
  const fields = {
    title: text(/<h1>([^<>]*)<\/h1>/g, 180),
    description: text(/<p class="copy">([^<>]*)<\/p>/g, 500),
    eyebrow: text(/<p class="eyebrow">([^<>]*)<\/p>/g, 80),
    metric: text(/<p class="metric">([^<>]*)<\/p>/g, 24),
    metricLabel: text(/<p class="metric-label">([^<>]*)<\/p>/g, 80),
  };
  return Object.values(fields).every((value) => value !== null) ? fields : null;
}

function renderPresentation(fields, token) {
  const { title, description, eyebrow, metric, metricLabel } = Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, escapeHtml(value)]));
  const canonical = `${SITE}/share/${token}`;
  const image = `${SITE}/images/dominion-77-mark.jpg`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Dominion</title><meta name="description" content="${description}"><meta name="robots" content="noindex,nofollow,noarchive"><link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:site_name" content="77 Dominion Challenge"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${image}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${image}"><style>${STYLE}</style></head><body><main class="share"><p class="eyebrow">${eyebrow}</p><p class="metric">${metric}</p><p class="metric-label">${metricLabel}</p><h1>${title}</h1><p class="copy">${description}</p><a class="cta" href="${SITE}" rel="noopener noreferrer">Explore the challenge</a><p class="mark">77 Dominion Challenge</p></main></body></html>`;
}

async function beforeAbort(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(new Error());
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedBody(response, signal) {
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  let size = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await beforeAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error();
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createPublicShareWorker(fetchImpl = globalThis.fetch) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    const sharePath = url.pathname === '/share' || url.pathname.startsWith('/share/');
    if (!sharePath) return env.ASSETS.fetch(request);
    const token = TOKEN_PATH.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || url.port || !HOSTS.has(url.hostname)
      || request.method !== 'GET' || !token) return unavailable();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
      // No incoming credentials, headers, query parameters, or cookies enter
      // this request. There is one fixed public GET endpoint and no retries.
      upstream = await beforeAbort(fetchImpl(`${UPSTREAM}/${token}`, {
        method: 'GET', headers: { Accept: 'text/html' }, redirect: 'error',
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }), controller.signal);
      if (upstream.redirected || ![200, 404].includes(upstream.status)) return unavailable(502);
      if (upstream.status === 404) return unavailable();
      if (!/^text\/(?:plain|html)(?:\s*;|$)/i.test(upstream.headers.get('Content-Type') || '')) return unavailable(502);
      const fields = presentation(await readBoundedBody(upstream, controller.signal));
      return fields ? responseHtml(renderPresentation(fields, token), 200) : unavailable(502);
    } catch {
      return unavailable(502);
    } finally {
      clearTimeout(timer);
      void upstream?.body?.cancel().catch(() => {});
    }
  } };
}

export default createPublicShareWorker();
