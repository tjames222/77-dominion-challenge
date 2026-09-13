import { adminReadError } from './admin-read-client.mjs';

// Synthetic, in-memory read-only preview. The API selects this adapter only
// when mocks are explicitly enabled and Supabase authentication is disabled.
export function createAdminPreview({ getUser, mode }) {
  let epoch = 0;
  const listeners = new Set();
  const records = Array.from({ length: 28 }, (_, index) => ({
    id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `Preview Member ${index + 1}`, email: `member${index + 1}@example.invalid`,
    createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T12:00:00Z`,
    emailConfirmedAt: index % 5 ? '2026-01-01T12:00:00Z' : null, lastSignInAt: null,
    isAnonymous: false, isSuspended: index === 3, suspendedUntil: null, deletedAt: null,
    role: index === 0 ? 'site_admin' : 'member', roleRevision: 0,
    deletionPending: index === 5, deletionRequestStatus: index === 5 ? 'requested' : null,
    crew: null, activationSnapshot: { storedStatus: index % 2 ? 'active' : 'not_started', mode: 'solo', startDate: '2026-01-01', reviewRequired: false, recordedAt: '2026-01-20T12:00:00Z' },
    statsSnapshot: { totalPoints: index * 7, storedAppStreak: index % 7, storedPerfectDayStreak: 0, lastSeenLocalDate: '2026-01-20', recordedAt: '2026-01-20T12:00:00Z' },
    subscriptionSnapshot: null,
  }));
  const auditRows = records.map((record, index) => ({ id: String(index + 1), actorId: records[0].id, targetUserId: record.id,
    action: 'roles.assign', permission: 'roles.manage', reasonCode: 'staff_access_review', beforeRole: 'member', afterRole: 'member',
    requestId: record.id, correlationId: record.id, environment: 'preview', occurredAt: record.createdAt,
    outcome: index % 3 ? 'success' : 'failure', errorCode: index % 3 ? null : 'revision_conflict' }));
  const owner = async () => { const captured = epoch; const user = await getUser(); if (captured !== epoch) throw adminReadError('ADMIN_CHANGED'); if (!user?.authenticated || !user.userId) throw adminReadError('ADMIN_SIGNED_OUT'); return { actorId: user.userId, sessionIdentity: `preview:${user.userId}` }; };
  return { owner, invalidate() { epoch += 1; for (const listener of listeners) { try { listener(); } catch { /* Continue clearing other views. */ } } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async read(name, args = {}, { expectedUserId = '' } = {}) {
    const actor = await owner(); if (expectedUserId && actor.actorId !== expectedUserId) throw adminReadError('ADMIN_CHANGED');
    const base = { schemaVersion: 1, actorId: actor.actorId, observedAt: new Date().toISOString(), preview: true };
    if (name === 'get_site_admin_context') return { ...base, role: mode === 'member' ? 'member' : 'site_admin',
      adminReady: mode === 'ready', reason: mode === 'mfa' ? 'mfa_required' : null,
      permissions: mode === 'ready' ? ['users.read', 'audit.read'] : [] };
    if (mode !== 'ready') throw adminReadError('ADMIN_DENIED');
    const isAudit = name.includes('audit');
    if (name === 'site_admin_get_user' || name === 'site_admin_get_audit_event') {
      const item = (isAudit ? auditRows : records).find((row) => row.id === (args.target_event_id || args.target_user_id));
      if (!item) throw adminReadError('ADMIN_NOT_FOUND'); return { ...base, item };
    }
    const filterKey = JSON.stringify({ ...args, target_cursor: null, actor: actor.actorId });
    if (args.target_cursor && args.target_cursor.query !== filterKey) throw adminReadError('ADMIN_INVALID_CURSOR');
    let rows = isAudit ? [...auditRows].reverse() : [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!isAudit && args.target_sort !== 'oldest') rows.reverse();
    rows = rows.filter((row) => isAudit
      ? (!args.target_user_id || row.targetUserId === args.target_user_id) && (args.target_action === 'all' || row.action === args.target_action) && (args.target_outcome === 'all' || row.outcome === args.target_outcome)
      : (!args.target_search || `${row.name}`.toLowerCase().startsWith(args.target_search.trim().toLowerCase()) || row.email.startsWith(args.target_search.trim().toLowerCase()))
        && (args.target_role === 'all' || row.role === args.target_role)
        && (args.target_status === 'all' || (args.target_status === 'confirmed' && row.emailConfirmedAt) || (args.target_status === 'unconfirmed' && !row.emailConfirmedAt)
          || (args.target_status === 'suspended' && row.isSuspended) || (args.target_status === 'deletion_pending' && row.deletionPending) || (args.target_status === 'deleted' && row.deletedAt)));
    const start = args.target_cursor ? rows.findIndex((row) => row.id === args.target_cursor.id) + 1 : 0;
    const items = rows.slice(start, start + args.target_limit);
    return { ...base, items, nextCursor: start + items.length < rows.length ? { query: filterKey, id: items.at(-1).id } : null };
  } };
}
