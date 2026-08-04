function cleanIdentityMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([identity, userId]) => (
    normalizeMockLoginIdentity(identity) === identity
      && typeof userId === 'string'
      && userId.trim()
  )));
}

export function normalizeMockLoginIdentity(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

export function resolveMockIdentity({
  email,
  identityMap,
  legacyUserId = '',
  createUserId,
} = {}) {
  const identity = normalizeMockLoginIdentity(email);
  if (!identity) throw new TypeError('A login email is required for the preview account.');

  const normalizedMap = cleanIdentityMap(identityMap);
  const existingUserId = normalizedMap[identity];
  if (existingUserId) {
    return { identity, userId: existingUserId, identityMap: normalizedMap, adoptedLegacy: false };
  }

  const normalizedLegacyUserId = String(legacyUserId || '').trim();
  const adoptedLegacy = Boolean(normalizedLegacyUserId && Object.keys(normalizedMap).length === 0);
  const userId = adoptedLegacy
    ? normalizedLegacyUserId
    : String(createUserId?.(identity, normalizedMap) || '').trim();
  if (!userId) throw new TypeError('Unable to create a preview account identity.');

  return {
    identity,
    userId,
    identityMap: { ...normalizedMap, [identity]: userId },
    adoptedLegacy,
  };
}

export function moveMockIdentity({ identityMap, fromEmail, toEmail, userId } = {}) {
  const fromIdentity = normalizeMockLoginIdentity(fromEmail);
  const toIdentity = normalizeMockLoginIdentity(toEmail);
  const normalizedUserId = String(userId || '').trim();
  if (!toIdentity || !normalizedUserId) {
    throw new TypeError('A login email and preview account identity are required.');
  }

  const nextMap = cleanIdentityMap(identityMap);
  const destinationUserId = nextMap[toIdentity];
  if (destinationUserId && destinationUserId !== normalizedUserId) {
    throw new Error('That preview login email already belongs to another account.');
  }
  if (fromIdentity !== toIdentity && nextMap[fromIdentity] === normalizedUserId) {
    delete nextMap[fromIdentity];
  }
  nextMap[toIdentity] = normalizedUserId;
  return nextMap;
}
