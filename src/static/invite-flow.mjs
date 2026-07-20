export const INVITE_CONTINUATION_STORAGE_KEY = 'dominion:crewInviteContinuation';
export const INVITE_PAGE_PATH = './invite.html';

const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export function normalizeInviteSecret(value) {
  const secret = String(value || '').trim();
  return INVITE_SECRET_PATTERN.test(secret) ? secret : '';
}

export function readInviteSecret(locationLike = {}) {
  const hash = String(locationLike.hash || '').replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);
  const fragmentSecret = normalizeInviteSecret(hashParams.get('invite'));
  if (fragmentSecret) return { secret: fragmentSecret, source: 'fragment' };

  const searchParams = new URLSearchParams(String(locationLike.search || '').replace(/^\?/, ''));
  const legacySecret = normalizeInviteSecret(searchParams.get('invite'));
  return legacySecret ? { secret: legacySecret, source: 'legacy-query' } : { secret: '', source: '' };
}

export function cleanInviteLocation(locationLike = {}) {
  const pathname = String(locationLike.pathname || '/invite.html');
  const searchParams = new URLSearchParams(String(locationLike.search || '').replace(/^\?/, ''));
  searchParams.delete('invite');
  searchParams.delete('inviteFlow');

  const safeSearch = searchParams.toString();
  return `${pathname}${safeSearch ? `?${safeSearch}` : ''}`;
}

export function captureInviteSecret(windowLike) {
  const result = readInviteSecret(windowLike?.location);
  if (!result.secret) return result;

  // Strip both query and fragment forms before any network request, redirect,
  // analytics callback, or referrer-bearing navigation can observe the secret.
  windowLike?.history?.replaceState?.({}, '', cleanInviteLocation(windowLike.location));
  return result;
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
  return ['ready', 'full', 'subscription_required'].includes(status);
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
    invalid: {
      eyebrow: 'Invitation unavailable',
      title: 'This invitation is not valid.',
      message: 'Check the link or ask the inviter for a new one. Private group details were not revealed.',
      recoverable: false,
    },
  };
  return content[status] || content.invalid;
}
