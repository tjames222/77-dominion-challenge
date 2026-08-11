export const INVITE_CONTINUATION_STORAGE_KEY = 'dominion:crewInviteContinuation';
export const INVITE_PAGE_PATH = './invite.html';

const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const INVITE_CODE_PATTERN = /^[34679ACDEFGHJKMNPQRTUVWXY]{16}$/;

export function normalizeInviteSecret(value) {
  const secret = String(value || '').trim();
  return INVITE_SECRET_PATTERN.test(secret) ? secret : '';
}

export function normalizeInviteCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return INVITE_CODE_PATTERN.test(code) ? code : '';
}

export function readInviteCredential(locationLike = {}) {
  const hash = String(locationLike.hash || '').replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);
  const fragmentSecret = normalizeInviteSecret(hashParams.get('invite'));
  if (fragmentSecret) return { type: 'token', value: fragmentSecret, source: 'fragment' };

  const fragmentCode = normalizeInviteCode(hashParams.get('code'));
  if (fragmentCode) return { type: 'code', value: fragmentCode, source: 'fragment' };

  const searchParams = new URLSearchParams(String(locationLike.search || '').replace(/^\?/, ''));
  const legacySecret = normalizeInviteSecret(searchParams.get('invite'));
  return legacySecret
    ? { type: 'token', value: legacySecret, source: 'legacy-query' }
    : { type: '', value: '', source: '' };
}

export function readInviteSecret(locationLike = {}) {
  const credential = readInviteCredential(locationLike);
  return credential.type === 'token'
    ? { secret: credential.value, source: credential.source }
    : { secret: '', source: '' };
}

export function cleanInviteLocation(locationLike = {}) {
  const pathname = String(locationLike.pathname || '/invite.html');
  const searchParams = new URLSearchParams(String(locationLike.search || '').replace(/^\?/, ''));
  searchParams.delete('invite');
  searchParams.delete('code');
  searchParams.delete('inviteFlow');

  const hashParams = new URLSearchParams(String(locationLike.hash || '').replace(/^#/, ''));
  hashParams.delete('invite');
  hashParams.delete('code');

  const safeSearch = searchParams.toString();
  const safeHash = hashParams.toString();
  return `${pathname}${safeSearch ? `?${safeSearch}` : ''}${safeHash ? `#${safeHash}` : ''}`;
}

export function captureInviteCredential(windowLike) {
  const location = windowLike?.location || {};
  const result = readInviteCredential(location);
  const searchParams = new URLSearchParams(String(location.search || '').replace(/^\?/, ''));
  const hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const hasCredentialLocation = searchParams.has('invite')
    || searchParams.has('code')
    || hashParams.has('invite')
    || hashParams.has('code');
  if (!hasCredentialLocation) return result;

  // Strip both credential formats before an RPC, redirect, analytics callback,
  // or referrer-bearing navigation can observe them, even when normalization
  // rejects the supplied value.
  windowLike?.history?.replaceState?.({}, '', cleanInviteLocation(location));
  return result;
}

export function captureInviteSecret(windowLike) {
  const result = captureInviteCredential(windowLike);
  return result.type === 'token'
    ? { secret: result.value, source: result.source }
    : { secret: '', source: '' };
}

export function buildInviteAuthHref(page) {
  const destination = page === 'register' ? './register.html' : './login.html';
  return `${destination}?returnTo=${encodeURIComponent(INVITE_PAGE_PATH)}`;
}

export function isInviteReturnPath(value) {
  if (!value) return false;
  try {
    const resolved = new URL(value, 'https://invite.local/');
    return resolved.origin === 'https://invite.local' && resolved.pathname === '/invite.html' && !resolved.search && !resolved.hash;
  } catch {
    return false;
  }
}

export function getStoredInviteContinuation(storage) {
  return normalizeInviteSecret(storage?.getItem?.(INVITE_CONTINUATION_STORAGE_KEY));
}

export function storeInviteContinuation(storage, continuationToken) {
  const token = normalizeInviteSecret(continuationToken);
  if (!token) return false;
  storage?.setItem?.(INVITE_CONTINUATION_STORAGE_KEY, token);
  return true;
}

export function clearInviteContinuation(storage) {
  storage?.removeItem?.(INVITE_CONTINUATION_STORAGE_KEY);
}

export function inviteNeedsContinuation(status) {
  return ['ready', 'full', 'subscription_required', 'current_crew_conflict'].includes(status);
}

export const TERMINAL_INVITE_STATUSES = new Set([
  'invalid',
  'expired',
  'revoked',
  'already_used',
  'already_member',
  'joined',
]);

export function inviteStatusContent(status, preview = {}) {
  const inviter = preview.inviterName || 'A Dominion member';
  const group = preview.groupName || 'this private group';
  const content = {
    enter_code: {
      eyebrow: 'Join a private group',
      title: 'Enter your join code.',
      message: 'A valid code opens a privacy-safe preview. It never joins a group until you explicitly confirm.',
      recoverable: true,
    },
    ready: {
      eyebrow: 'Private group invitation',
      title: `Join ${group}?`,
      message: `${inviter} invited you to take the challenge together. Membership will not change until you confirm.`,
      recoverable: true,
    },
    authentication_required: {
      eyebrow: 'Invitation saved',
      title: `Join ${group}?`,
      message: `Log in or create an account to accept ${inviter}'s invitation.`,
      recoverable: true,
    },
    subscription_required: {
      eyebrow: 'Membership required',
      title: 'Activate membership to join.',
      message: 'Your invitation is saved in this browser while you finish membership setup.',
      recoverable: true,
    },
    already_member: {
      eyebrow: 'Already joined',
      title: `You are already in ${group}.`,
      message: 'Open the private group to see its leaderboard and members.',
      recoverable: true,
    },
    current_crew_conflict: {
      eyebrow: 'One active group',
      title: `You already belong to another group.`,
      message: `Leave your current group, or delete it if you are an owner or admin, before joining ${group}. No membership change was made.`,
      recoverable: true,
    },
    full: {
      eyebrow: 'Group unavailable',
      title: 'This private group is full.',
      message: 'No membership change was made. Ask the inviter to make room, then try again.',
      recoverable: true,
    },
    wrong_account: {
      eyebrow: 'Different account',
      title: 'This invitation is tied to another account.',
      message: 'Log back in with the account that opened this invitation. No membership change was made.',
      recoverable: true,
    },
    session_expired: {
      eyebrow: 'Invitation session expired',
      title: 'Open the original invitation again.',
      message: 'The short-lived sign-in continuation expired. The original inviter can also send a fresh link.',
      recoverable: true,
    },
    rate_limited: {
      eyebrow: 'Please wait',
      title: 'Too many invitation attempts.',
      message: 'No membership change was made. Wait a few minutes and try again.',
      recoverable: true,
    },
    expired: {
      eyebrow: 'Invitation unavailable',
      title: 'This invitation has expired.',
      message: 'Ask the inviter for a new link. Private group details were not revealed.',
      recoverable: false,
    },
    revoked: {
      eyebrow: 'Invitation unavailable',
      title: 'This invitation was revoked.',
      message: 'Ask the inviter for a new link. Private group details were not revealed.',
      recoverable: false,
    },
    already_used: {
      eyebrow: 'Invitation unavailable',
      title: 'This invitation was already used.',
      message: 'Each invitation can add one person. Ask the inviter for a new link.',
      recoverable: false,
    },
    joined: {
      eyebrow: 'Invitation accepted',
      title: `You joined ${group}.`,
      message: 'Your private-group membership is active.',
      recoverable: false,
    },
    activation_pending: {
      eyebrow: 'Group joined',
      title: `Finish starting with ${group}.`,
      message: 'Your private-group membership is active. Continue the same protected request to bind your challenge to the group date.',
      recoverable: true,
    },
    challenge_started: {
      eyebrow: 'Group challenge confirmed',
      title: `You are starting with ${group}.`,
      message: 'Your challenge now uses the private group’s authoritative start date.',
      recoverable: false,
    },
    invalid: {
      eyebrow: 'Invitation unavailable',
      title: 'This invitation is not valid.',
      message: 'Check the link or ask the inviter for a new one. Private group details were not revealed.',
      recoverable: false,
    },
  };
  return content[status] || content.invalid;
}
