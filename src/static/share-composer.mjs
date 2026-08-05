export const SHARE_FLOWS = Object.freeze({
  streak: Object.freeze({
    kind: 'streak',
    label: 'App streak',
    description: 'Share your current app and full-standard streaks.',
  }),
  progress: Object.freeze({
    kind: 'progress',
    label: 'Challenge progress',
    description: 'Share your current day in the 77-day challenge.',
  }),
  general: Object.freeze({
    kind: 'general',
    label: 'The Dominion challenge',
    description: 'Invite someone to learn about the seven daily standards.',
  }),
});

export const SNAPSHOT_SHARE_KINDS = Object.freeze(['streak', 'progress', 'general']);
export const SHARE_METHODS = Object.freeze(['native_share', 'copy_link']);

export function normalizeShareKind(value, fallback = 'progress') {
  const kind = String(value || '').trim().toLowerCase();
  return SHARE_FLOWS[kind] ? kind : fallback;
}

export function normalizeShareMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (!SHARE_METHODS.includes(method)) {
    throw new TypeError('Choose a supported share method.');
  }
  return method;
}

export function shareCopy({ presentation = {}, url = '', kind = 'general', groupName = '' } = {}) {
  const normalizedKind = normalizeShareKind(kind, 'general');
  if (normalizedKind === 'invite') {
    const name = String(groupName || 'my private Dominion group').trim();
    return {
      title: `Join ${name}`,
      text: `Join ${name} and take the 77-Day Dominion Challenge with me.`,
      url: String(url || ''),
    };
  }

  const fallbackTitle = normalizedKind === 'streak'
    ? 'My Dominion streak'
    : normalizedKind === 'progress'
      ? 'My 77-Day Dominion Challenge progress'
      : 'Take the 77-Day Dominion Challenge';
  return {
    title: String(presentation.title || fallbackTitle),
    text: String(
      presentation.description
      || 'Build a disciplined rhythm of faith, fitness, and follow-through.',
    ),
    url: String(url || ''),
  };
}

export function inviteUrlFromToken(token, baseUrl) {
  const secret = String(token || '').trim();
  if (!secret) throw new Error('The invitation did not return a usable link.');
  const url = new URL('./invite.html', baseUrl);
  url.search = '';
  url.hash = `invite=${encodeURIComponent(secret)}`;
  return url.href;
}

async function deliverShare({ method, payload, nativeShare, copyText }) {
  if (method === 'native_share') {
    if (typeof nativeShare !== 'function') {
      throw new Error('Sharing is not available on this device. Copy the link instead.');
    }
    await nativeShare(payload);
    return;
  }

  if (typeof copyText !== 'function') {
    throw new Error('Copying is not available in this browser.');
  }
  await copyText(payload.url);
}

function assertShareContinuation(shouldContinue) {
  if (typeof shouldContinue !== 'function' || shouldContinue()) return;
  const error = new Error('The signed-in account changed before sharing finished.');
  error.name = 'AbortError';
  throw error;
}

export async function executeSnapshotShare({
  kind,
  method,
  createSnapshot,
  createRewardIntent,
  completeReward,
  nativeShare,
  copyText,
  shouldContinue,
} = {}) {
  const normalizedKind = normalizeShareKind(kind);
  const normalizedMethod = normalizeShareMethod(method);
  if (!SNAPSHOT_SHARE_KINDS.includes(normalizedKind)) {
    throw new TypeError('Private-group invitations use the invitation flow.');
  }
  if (typeof createSnapshot !== 'function') {
    throw new TypeError('A snapshot creator is required.');
  }

  const snapshot = await createSnapshot(normalizedKind);
  assertShareContinuation(shouldContinue);
  if (!snapshot?.url) throw new Error('The share link could not be created.');

  // The short-lived intent is issued only after the user chose a concrete
  // native/copy action. It is completed only after that platform promise resolves.
  const intent = typeof createRewardIntent === 'function'
    ? await createRewardIntent(normalizedMethod)
    : null;
  assertShareContinuation(shouldContinue);
  const payload = shareCopy({
    presentation: snapshot.presentation,
    url: snapshot.url,
    kind: normalizedKind,
  });

  await deliverShare({
    method: normalizedMethod,
    payload,
    nativeShare,
    copyText,
  });
  assertShareContinuation(shouldContinue);

  const reward = intent?.completionToken && typeof completeReward === 'function'
    ? await completeReward(intent.completionToken)
    : intent?.alreadyGranted
      ? { granted: false, alreadyGranted: true }
      : null;
  assertShareContinuation(shouldContinue);
  return { snapshot, payload, reward, method: normalizedMethod };
}

export async function executeInviteShare({
  crew,
  method,
  createInvite,
  baseUrl,
  nativeShare,
  copyText,
  shouldContinue,
} = {}) {
  const normalizedMethod = normalizeShareMethod(method);
  if (!crew?.id || typeof createInvite !== 'function') {
    throw new Error('Choose a private group you manage.');
  }

  const invite = await createInvite(crew.id);
  assertShareContinuation(shouldContinue);
  const url = inviteUrlFromToken(invite?.token, baseUrl);
  const payload = shareCopy({
    kind: 'invite',
    groupName: crew.name,
    url,
  });
  await deliverShare({
    method: normalizedMethod,
    payload,
    nativeShare,
    copyText,
  });
  assertShareContinuation(shouldContinue);

  return {
    invite: { id: invite?.id || '', expiresAt: invite?.expires_at || invite?.expiresAt || null },
    payload,
    method: normalizedMethod,
    rewardPendingRedemption: true,
  };
}
