// In-memory synthetic data only. Production selects the HTTP adapter instead.
export function createEarlyAccessPreviewStore({ error = (code) => Object.assign(new Error('Synthetic early-access records are unavailable.'), { code }) } = {}) {
  const requests = Array.from({ length: 29 }, (_, index) => ({
    id: `88000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `Preview Applicant ${index + 1}`, email: `applicant${index + 1}@example.invalid`,
    status: index < 26 ? 'pending' : ['invited', 'denied', 'accepted'][index - 26], revision: '0',
    requestedAt: '2026-01-20T12:00:00.123456Z', updatedAt: '2026-01-20T12:00:00.123456Z',
    invitationSentAt: null, invitationExpiresAt: null, acceptedAt: null,
    account: { status: index % 2 ? 'none' : 'confirmed', userId: index % 2 ? null : `89000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` },
  }));
  const history = []; const operations = new Map();
  const item = (id) => { const found = requests.find((value) => value.id === id); if (!found) throw error('ADMIN_NOT_FOUND'); return found; };
  return {
    read(name, args, actorId) {
      const base = { schemaVersion: 1, actorId, observedAt: new Date().toISOString(), preview: true };
      if (name === 'site_admin_get_early_access_request') return { ...base, item: structuredClone(item(args.target_request_id)) };
      const query = JSON.stringify({ ...args, target_cursor: null, actorId });
      if (args.target_cursor && args.target_cursor.query !== query) throw error('ADMIN_INVALID_CURSOR');
      let rows;
      if (name === 'site_admin_list_early_access_history') { item(args.target_request_id); rows = history.filter((value) => value.requestId === args.target_request_id).slice().reverse(); }
      else if (name === 'site_admin_list_early_access_requests') {
        const search = String(args.target_search || '').trim().toLowerCase();
        rows = requests.filter((value) => (!search || value.name.toLowerCase().startsWith(search) || value.email.startsWith(search))
          && (args.target_status === 'all' || value.status === args.target_status)).slice().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
        if (args.target_sort !== 'oldest') rows.reverse();
      } else throw error('ADMIN_INVALID_INPUT');
      const start = args.target_cursor ? rows.findIndex((value) => value.id === args.target_cursor.id) + 1 : 0;
      const items = rows.slice(start, start + args.target_limit);
      return { ...base, items: structuredClone(items), nextCursor: start + items.length < rows.length ? { query, id: items.at(-1).id } : null };
    },
    deny(args, actorId) {
      const key = `${actorId}:${args.target_operation_id}`; const signature = JSON.stringify(args);
      const prior = operations.get(key);
      if (prior) { if (prior.signature !== signature) throw error('ADMIN_IDEMPOTENCY_CONFLICT'); return structuredClone(prior.result); }
      const found = requests.find((value) => value.id === args.target_request_id);
      const errorCode = !found ? 'target_unavailable' : found.revision !== String(args.target_expected_revision) ? 'revision_conflict' : found.status !== 'pending' ? 'invalid_state' : null;
      const beforeStatus = found?.status || null;
      const result = errorCode ? { ok: false, errorCode } : { ok: true, requestId: found.id, status: 'denied', revision: String(BigInt(found.revision) + 1n) };
      if (!errorCode) { found.status = 'denied'; found.revision = result.revision; found.updatedAt = new Date().toISOString(); }
      history.push({ id: String(9007199254740993n + BigInt(history.length)), actorId, requestId: args.target_request_id,
        action: 'early_access.deny', permission: 'operations.manage', reasonCode: 'early_access_review', beforeStatus,
        afterStatus: found?.status || null, operationId: args.target_operation_id, correlationId: args.target_correlation_id,
        environment: 'preview', occurredAt: new Date().toISOString(), outcome: errorCode ? 'failure' : 'success', errorCode });
      operations.set(key, { signature, result }); return structuredClone(result);
    },
  };
}
