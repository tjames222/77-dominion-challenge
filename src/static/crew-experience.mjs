const ADMIN_ROLES = new Set(['owner', 'admin']);

export function isCrewAdmin(role = '') {
  return ADMIN_ROLES.has(String(role));
}

export function crewLifecycleAction(role = '') {
  return isCrewAdmin(role) ? 'delete' : 'leave';
}

export function assertSingleCrew(crews = []) {
  const items = Array.isArray(crews) ? crews.filter(Boolean) : [];
  if (items.length > 1) {
    throw new Error('This account has more than one active crew. Contact support before continuing so no membership is discarded.');
  }
  return items;
}

export function crewViewState({ loaded = false, crew = null, createFormOpen = false } = {}) {
  return {
    showCreateCard: Boolean(loaded && !crew),
    showCreateButton: Boolean(loaded && !crew && !createFormOpen),
    showCreateForm: Boolean(loaded && !crew && createFormOpen),
    showActiveCrew: Boolean(loaded && crew),
  };
}

export function newCrewLifecycleRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `crew-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
