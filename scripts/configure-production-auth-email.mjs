import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { productionAuthCanaryErrors, PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';

export const AUTH_EMAIL_SETTINGS = Object.freeze({
  smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend',
  smtp_admin_email: 'noreply@mail.77dominion.com', smtp_sender_name: 'Dominion',
});
const endpoint = `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/config/auth`;
const failure = () => new Error('Production Auth email configuration could not be verified.');

// Authenticate over certificate-verified TLS. Deliberately never issue MAIL,
// RCPT or DATA: checking the stored key does not send mail or consume send quota.
export function verifyResendSmtpCredential({ apiKey, connect = tls.connect, timeoutMs = 10000 } = {}) {
  if (typeof apiKey !== 'string' || !/^re_[A-Za-z0-9_-]{1,250}$/.test(apiKey)
    || typeof connect !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    return Promise.reject(failure());
  }
  return new Promise((resolve, reject) => {
    let socket; let timer; let settled = false; let secure = false; let buffer = ''; let stage = 'greeting'; let code = null; let lines = [];
    const finish = ok => {
      if (settled) return; settled = true; clearTimeout(timer);
      // Do not retain or surface provider lines, credentials, causes or socket errors.
      buffer = ''; lines = []; socket?.destroy();
      if (ok) resolve(true); else reject(failure());
    };
    const received = (responseCode, responseLines) => {
      if (!secure) return finish(false);
      if (stage === 'greeting' && responseCode === 220) {
        stage = 'ehlo'; socket.write('EHLO 77dominion.com\r\n');
      } else if (stage === 'ehlo' && responseCode === 250 && responseLines.some(line => /^250[- ]AUTH(?:=| )(?:(?:[A-Z0-9_-]+) )*PLAIN(?: |$)/.test(line))) {
        stage = 'auth';
        socket.write(`AUTH PLAIN ${Buffer.from(`\0resend\0${apiKey}`).toString('base64')}\r\n`);
      } else if (stage === 'auth' && responseCode === 235) {
        // A verified SMTP AUTH result, not delivery evidence.
        stage = 'done'; socket.write('QUIT\r\n'); finish(true);
      } else finish(false);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = connect({ host: AUTH_EMAIL_SETTINGS.smtp_host, port: 465, servername: AUTH_EMAIL_SETTINGS.smtp_host,
        rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      socket.once('secureConnect', () => { if (socket.authorized !== true) finish(false); else secure = true; });
      socket.once('error', () => finish(false)); socket.once('end', () => finish(false)); socket.once('close', () => finish(false));
      socket.on('data', chunk => {
        if (settled) return;
        try {
          buffer += Buffer.from(chunk).toString('ascii');
          if (buffer.length > 16384) return finish(false);
          while (buffer.includes('\r\n') && !settled) {
            const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const match = /^(\d{3})([- ])[^\r\n]*$/.exec(line);
            if (!match || line.length > 1024 || lines.length >= 32 || (code !== null && code !== Number(match[1]))) return finish(false);
            code = Number(match[1]); lines.push(line);
            if (match[2] === ' ') { const completeCode = code; const completeLines = lines; code = null; lines = []; received(completeCode, completeLines); }
          }
        } catch { finish(false); }
      });
    } catch { finish(false); }
  });
}

async function authConfigRequest(fetchImpl, accessToken, method, patch, timeoutMs) {
  const controller = new AbortController(); let timer; let reader;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => {}); reject(failure());
    }, timeoutMs);
  });
  const work = async () => {
  try {
    const response = await fetchImpl(endpoint, {
      method, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(patch ? { 'Content-Type': 'application/json' } : {}) },
      ...(patch ? { body: JSON.stringify(patch) } : {}),
      cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (controller.signal.aborted || response.status !== 200 || response.redirected || !response.body) throw failure();
    reader = response.body.getReader(); const chunks = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (controller.signal.aborted) throw failure(); if (done) break;
        length += value.byteLength; if (length > 262144) throw failure(); chunks.push(value);
      }
      const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure();
      return config;
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch { throw failure(); }
  };
  try { return await Promise.race([work(), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function configureProductionAuthEmail({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN, projectRef = process.env.SUPABASE_PROJECT_REF,
  apiKey = process.env.RESEND_API_KEY, fetchImpl = globalThis.fetch, verifyCredential = verifyResendSmtpCredential,
  requestTimeoutMs = 10000,
} = {}) {
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF || typeof accessToken !== 'string' || !accessToken || /[\u0000-\u0020\u007f]/.test(accessToken)
    || typeof apiKey !== 'string' || !/^re_[A-Za-z0-9_-]{1,250}$/.test(apiKey) || typeof fetchImpl !== 'function' || typeof verifyCredential !== 'function'
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000) throw failure();
  const before = await authConfigRequest(fetchImpl, accessToken, 'GET', undefined, requestTimeoutMs);
  if (productionAuthCanaryErrors(before).length || (before.smtp_host && before.smtp_host !== AUTH_EMAIL_SETTINGS.smtp_host)) throw failure();
  // Leave an existing different SMTP provider alone; never silently switch it.
  try { if (await verifyCredential({ apiKey }) !== true) throw failure(); } catch { throw failure(); }
  await authConfigRequest(fetchImpl, accessToken, 'PATCH', { ...AUTH_EMAIL_SETTINGS, smtp_pass: apiKey }, requestTimeoutMs);
  const after = await authConfigRequest(fetchImpl, accessToken, 'GET', undefined, requestTimeoutMs);
  if (productionAuthCanaryErrors(after).length || Object.entries(AUTH_EMAIL_SETTINGS).some(([name, value]) => after[name] !== value)) throw failure();
  return Object.freeze({ configured: true, credentialVerified: true, emailSent: false });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await configureProductionAuthEmail();
    console.log('Production Auth email configured; Resend SMTP credential verified without sending email.');
  } catch {
    console.error('Production Auth email configuration could not be verified. No delivery is claimed.');
    process.exitCode = 1;
  }
}
