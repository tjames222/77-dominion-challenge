export const CREW_INVITE_CODE_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';
export const CREW_INVITE_CODE_LENGTH = 16;
export const CREW_INVITE_CODE_GROUP_SIZE = 4;
export const CREW_INVITE_QR_FILENAME = 'dominion-crew-invite.png';

const codeCharacters = new Set(CREW_INVITE_CODE_ALPHABET);

function compactCode(value = '') {
  return String(value)
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

export function normalizeCrewInviteCode(value = '', { partial = false } = {}) {
  const compact = compactCode(value);
  if (partial) {
    return [...compact]
      .filter((character) => codeCharacters.has(character))
      .join('')
      .slice(0, CREW_INVITE_CODE_LENGTH);
  }
  if (compact.length !== CREW_INVITE_CODE_LENGTH) return '';
  return [...compact].every((character) => codeCharacters.has(character)) ? compact : '';
}

export function formatCrewInviteCode(value = '', { partial = false } = {}) {
  const normalized = normalizeCrewInviteCode(value, { partial });
  if (!normalized) return '';
  return normalized.match(new RegExp(`.{1,${CREW_INVITE_CODE_GROUP_SIZE}}`, 'g'))?.join('-') || '';
}

export function readableCrewInviteCode(value = '') {
  return formatCrewInviteCode(value).replaceAll('-', ' dash ');
}

export function inviteUrlFromToken(token, baseUrl) {
  const secret = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    throw new Error('The invitation did not return a usable link.');
  }
  const url = new URL('./invite.html', baseUrl);
  url.search = '';
  url.hash = `invite=${encodeURIComponent(secret)}`;
  return url.href;
}

export function inviteUrlFromCode(code, baseUrl) {
  const normalized = normalizeCrewInviteCode(code);
  if (!normalized) throw new Error('Enter the complete 16-character join code.');
  const url = new URL('./invite.html', baseUrl);
  url.search = '';
  url.hash = `code=${encodeURIComponent(normalized)}`;
  return url.href;
}

export function crewInviteShareCopy({ crewName = '', url = '' } = {}) {
  const name = String(crewName || 'my private Dominion group').trim();
  return {
    title: `Join ${name}`,
    text: `Join ${name} and take the 77-Day Dominion Challenge with me. This invitation is for one person and expires.`,
    url: String(url || ''),
  };
}

export function crewInviteQrOptions(width = 512) {
  return {
    errorCorrectionLevel: 'M',
    margin: 4,
    width: Math.max(256, Number(width) || 512),
    color: {
      dark: '#0e1116',
      light: '#ffffff',
    },
  };
}

export async function renderCrewInviteQr(canvas, url, renderToCanvas, width = 512) {
  if (!canvas || typeof renderToCanvas !== 'function') {
    throw new TypeError('A QR canvas and local renderer are required.');
  }
  const payload = String(url || '');
  if (!payload.startsWith('http://') && !payload.startsWith('https://')) {
    throw new Error('The invitation URL is unavailable.');
  }
  const options = crewInviteQrOptions(width);
  await renderToCanvas(canvas, payload, options);
  return { payload, options };
}

export function canvasToPngBlob(canvas) {
  if (!canvas?.toBlob) return Promise.reject(new Error('QR image export is unavailable.'));
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === 'image/png' && blob.size > 0) resolve(blob);
      else reject(new Error('The QR image could not be prepared.'));
    }, 'image/png');
  });
}

export function createCrewInviteQrFile(blob, FileConstructor = globalThis.File) {
  if (!blob || typeof FileConstructor !== 'function') {
    throw new Error('QR image sharing is unavailable.');
  }
  return new FileConstructor([blob], CREW_INVITE_QR_FILENAME, { type: 'image/png' });
}

export function canShareCrewInviteQr(navigatorLike, file) {
  if (typeof navigatorLike?.share !== 'function' || typeof navigatorLike?.canShare !== 'function') {
    return false;
  }
  try {
    return navigatorLike.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function isShareCancellation(error) {
  return ['AbortError', 'NotAllowedError'].includes(String(error?.name || ''));
}

export function inviteExpiryLabel(value, locale = undefined) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Expiry unavailable';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function nextInviteTabIndex({ currentIndex = 0, key = '', count = 3 } = {}) {
  const boundedCount = Math.max(1, Number(count) || 1);
  const current = Math.max(0, Math.min(boundedCount - 1, Number(currentIndex) || 0));
  if (key === 'ArrowRight') return (current + 1) % boundedCount;
  if (key === 'ArrowLeft') return (current - 1 + boundedCount) % boundedCount;
  if (key === 'Home') return 0;
  if (key === 'End') return boundedCount - 1;
  return current;
}

export function invitationLifecycleCopy(metadata = {}) {
  const status = String(metadata.status || 'none');
  if (status === 'active') {
    return {
      tone: 'active',
      title: 'One invitation is active',
      message: `It expires ${inviteExpiryLabel(metadata.expiresAt)}. Replace it to create new Link, Code, and QR representations.`,
    };
  }
  if (status === 'revoked') {
    return {
      tone: 'inactive',
      title: 'Invitation revoked',
      message: 'Its link, code, and QR no longer work.',
    };
  }
  return {
    tone: 'inactive',
    title: 'No active invitation',
    message: 'Generate one private, expiring invitation for a single recipient.',
  };
}
