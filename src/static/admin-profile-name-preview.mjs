import { profileNameArguments, validAdminProfileName, normalizeProfileNameReceipt } from './admin-profile-name-contract.mjs';

// Synthetic records only, owned by the explicit local-demo Admin adapter.
// No fetch, browser storage, Supabase client or real account is used here.
export function createProfileNamePreview({ records, auditRows, error, now = () => new Date().toISOString() }) {
  const versions = new Map(); const operations = new Map();
  const inspect = (actorId, targetUserId) => {
    const record = records.find(item => item.id === targetUserId);
    const reason = actorId === targetUserId ? 'self_action_forbidden'
      : !record || record.deletedAt || record.isAnonymous || record.isSuspended || !record.emailConfirmedAt || record.deletionPending ? 'target_unavailable'
        : !validAdminProfileName(record.name) ? 'unsupported_legacy_name' : null;
    if (!reason && !versions.has(targetUserId)) versions.set(targetUserId, { version: crypto.randomUUID(), updatedAt: now() });
    return { schemaVersion: 1, actorId, targetUserId, observedAt: now(), profile: reason
      ? { state: 'unavailable', reason, name: null, version: null, updatedAt: null }
      : { state: 'editable', reason: null, name: record.name, ...versions.get(targetUserId) } };
  };
  return { read: inspect, correct(intent) {
    const args = profileNameArguments(intent); const key = `${intent.actorId}:${intent.operationId}`;
    // In-memory exact comparison only; production persists a server digest.
    const signature = JSON.stringify(args); const previous = operations.get(key);
    if (previous) { if (previous.signature !== signature) throw error('ADMIN_IDEMPOTENCY_CONFLICT'); return normalizeProfileNameReceipt(previous.receipt, intent); }
    if (auditRows.some(row => row.actorId === intent.actorId && row.requestId === intent.operationId)) throw error('ADMIN_IDEMPOTENCY_CONFLICT');
    const envelope = { schemaVersion: 1, actorId: intent.actorId, targetUserId: intent.targetUserId, operationId: intent.operationId, correlationId: intent.correlationId };
    const occurredAt = now(); const time = Date.parse(occurredAt);
    const count = milliseconds => auditRows.filter(row => row.actorId === intent.actorId && Date.parse(row.occurredAt) > time - milliseconds).length;
    if (count(60_000) >= 20 || count(3_600_000) >= 100) return { ...envelope, ok: false, error: 'rate_limited' };
    const snapshot = inspect(intent.actorId, intent.targetUserId); const profile = snapshot.profile;
    const failure = profile.state !== 'editable' ? profile.reason : profile.version !== intent.expectedVersion ? 'revision_conflict' : null;
    let changed = null; let version = null;
    if (!failure) {
      changed = profile.name !== intent.name; version = changed ? crypto.randomUUID() : profile.version;
      if (changed) { records.find(row => row.id === intent.targetUserId).name = intent.name; versions.set(intent.targetUserId, { version, updatedAt: occurredAt }); }
    }
    const receipt = failure ? { ...envelope, ok: false, error: failure } : { ...envelope, ok: true, changed, version };
    auditRows.push({ id: String(Math.max(0, ...auditRows.map(row => Number(row.id))) + 1), actorId: intent.actorId, targetUserId: intent.targetUserId,
      action: 'users.display_name.correct', permission: 'users.manage', reasonCode: 'profile_name_correction', beforeRole: null, afterRole: null,
      requestId: intent.operationId, correlationId: intent.correlationId, occurredAt, environment: 'preview', outcome: failure ? 'failure' : 'success', errorCode: failure,
      beforeProfileNameVersion: failure ? null : profile.version, afterProfileNameVersion: version, profileNameChanged: changed });
    operations.set(key, { signature, receipt }); return normalizeProfileNameReceipt(receipt, intent);
  } };
}
