export const PREVIEW_USER_STATE_STORAGE_KEY = 'dominion:previewUserStateByOwner';
export const PREVIEW_USER_STATE_LEGACY_OWNER_KEY = 'dominion:previewUserStateLegacyOwner';

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage?.getItem?.(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function cleanOwnerRecords(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([ownerId, record]) => (
    ownerId.trim()
      && record
      && typeof record === 'object'
      && !Array.isArray(record)
  )));
}

export function claimPreviewLegacyOwner(storage, ownerId) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId || !storage?.getItem || !storage?.setItem) return '';
  const existingOwner = String(storage.getItem(PREVIEW_USER_STATE_LEGACY_OWNER_KEY) || '').trim();
  if (existingOwner) return existingOwner;

  const legacyUserId = String(storage.getItem('dominion:mockUserId') || '').trim();
  const identityMap = readJson(storage, 'dominion:mockUserIdsByIdentity', {});
  const mappedUserIds = identityMap && typeof identityMap === 'object' && !Array.isArray(identityMap)
    ? [...new Set(Object.values(identityMap).map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  const legacyOwnerIsUnambiguous = legacyUserId === normalizedOwnerId && mappedUserIds.length <= 1;
  if (!legacyOwnerIsUnambiguous) return '';
  storage.setItem(PREVIEW_USER_STATE_LEGACY_OWNER_KEY, normalizedOwnerId);
  return normalizedOwnerId;
}

export function readPreviewUserValue(storage, ownerId, key, fallback) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId || !String(key || '').trim()) return fallback;

  const legacyOwner = claimPreviewLegacyOwner(storage, normalizedOwnerId);
  const records = cleanOwnerRecords(readJson(storage, PREVIEW_USER_STATE_STORAGE_KEY, {}));
  const ownerRecord = records[normalizedOwnerId] || {};
  const hasStoredValue = Object.hasOwn(ownerRecord, key);
  let value = hasStoredValue ? ownerRecord[key] : fallback;

  if (legacyOwner === normalizedOwnerId) {
    const legacyValue = readJson(storage, key, fallback);
    if (!hasStoredValue || JSON.stringify(legacyValue) !== JSON.stringify(value)) value = legacyValue;
  }

  if (!hasStoredValue || ownerRecord[key] !== value) {
    records[normalizedOwnerId] = { ...ownerRecord, [key]: value };
    storage.setItem(PREVIEW_USER_STATE_STORAGE_KEY, JSON.stringify(records));
  }
  return value;
}

export function writePreviewUserValue(storage, ownerId, key, value) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId || !String(key || '').trim()) {
    throw new TypeError('A preview account and storage key are required.');
  }

  const legacyOwner = claimPreviewLegacyOwner(storage, normalizedOwnerId);
  const records = cleanOwnerRecords(readJson(storage, PREVIEW_USER_STATE_STORAGE_KEY, {}));
  records[normalizedOwnerId] = { ...(records[normalizedOwnerId] || {}), [key]: value };
  storage.setItem(PREVIEW_USER_STATE_STORAGE_KEY, JSON.stringify(records));
  if (legacyOwner === normalizedOwnerId) storage.setItem(key, JSON.stringify(value));
  return value;
}
