// One eager runtime per document. This module must never import the API facade
// or feature controllers: every consumer shares the same guarded client and
// synchronous identity fences, including consumers reached through api.js.
import { createClient } from '@supabase/supabase-js';
import { authSessionIdentity, createSupabaseMfaAdapter } from './mfa-auth.mjs';
import { createMfaSessionGuard } from './mfa-session-guard.mjs';
import { createInflightActorReads } from './inflight-actor-reads.mjs';
import {
  PREVIEW_AUTH_OWNER_STORAGE_KEY,
  shouldCreateSupabaseClient,
  shouldUseSupabaseAuthentication,
} from './preview-auth-runtime.mjs';

export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
export const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(SUPABASE_URL).origin;
  } catch {
    return '';
  }
})();
export const SUPABASE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  '';
const environmentFlagEnabled = (value) => (
  String(value || '').trim().toLowerCase() === 'true'
);
export const ENABLE_MOCKS = environmentFlagEnabled(import.meta.env.VITE_ENABLE_MOCKS);
const ENABLE_PRODUCTION_CONNECTIONS = environmentFlagEnabled(
  import.meta.env.VITE_ENABLE_PRODUCTION_CONNECTIONS,
);
const ENABLE_SUPABASE_AUTH_IN_MOCKS = environmentFlagEnabled(
  import.meta.env.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS,
);
export const ENABLE_E2E_FIXTURES = Boolean(
  import.meta.env.DEV
  && ENABLE_MOCKS
  && environmentFlagEnabled(import.meta.env.VITE_ENABLE_E2E_FIXTURES)
);
const ENABLE_LOCAL_HYBRID_AUTH = Boolean(
  import.meta.env.DEV && ENABLE_MOCKS && ENABLE_SUPABASE_AUTH_IN_MOCKS,
);
const isPlaceholder = (value) => !value || value.includes('YOUR_');
const isSupabaseConfigured = () => !isPlaceholder(SUPABASE_URL) && !isPlaceholder(SUPABASE_KEY);
const ALLOW_SUPABASE_CLIENT = shouldCreateSupabaseClient({
  configured: isSupabaseConfigured(),
  mocksEnabled: ENABLE_MOCKS,
  productionBuild: import.meta.env.PROD,
  productionConnectionsEnabled: ENABLE_PRODUCTION_CONNECTIONS,
  localHybridEnabled: ENABLE_LOCAL_HYBRID_AUTH,
});
export const supabaseAuthStorageKey = ALLOW_SUPABASE_CLIENT
  ? `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  : '';
const browserAuthStorage = () => {
  try { return globalThis.localStorage; } catch { return null; }
};
const mfaSessionGuard = ALLOW_SUPABASE_CLIENT ? createMfaSessionGuard({
  supabaseUrl: SUPABASE_URL,
  storageKey: supabaseAuthStorageKey,
  storage: browserAuthStorage(),
  fetch: globalThis.fetch,
  locks: globalThis.navigator?.locks,
  eventTarget: globalThis.window,
}) : null;
export const supabase = ALLOW_SUPABASE_CLIENT
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mfaSessionGuard.fetch },
      auth: {
        // Keep the existing SDK storage key and one attributable session write.
        // Do not configure a separate userStorage ahead of the guarded commit.
        storageKey: supabaseAuthStorageKey,
        storage: mfaSessionGuard.storage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
export const mfaAdapter = supabase ? createSupabaseMfaAdapter(mfaSessionGuard.protectAuth(supabase.auth)) : null;
export function cancelMfaOperations() { mfaSessionGuard?.cancelPending(); }
export function getMfaAuthAdapter() {
  if (!usesSupabaseAuthentication() || !mfaAdapter) throw new Error('Live account security is unavailable in this preview.');
  return mfaAdapter;
}
export const inflightActorReads = createInflightActorReads();
export let previewBadgeEpoch = 0;
let previewBadgeObservedSession;
export function invalidatePreviewBadgeOwner() { previewBadgeEpoch += 1; }
export async function invalidateReadsAroundMutation(operation, query = '') {
  inflightActorReads.invalidate(query);
  try {
    return await operation();
  } finally {
    inflightActorReads.invalidate(query);
  }
}
// A separate synchronous observer fences requests before any UI auth callback
// schedules rehydration. No Supabase method is called from this callback.
supabase?.auth.onAuthStateChange((event, session) => {
  inflightActorReads.observeAuth(event, session?.user?.id || '', authSessionIdentity(session));
  const identity = authSessionIdentity(session);
  if (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED'].includes(event)
    || (previewBadgeObservedSession !== undefined && identity !== previewBadgeObservedSession)) previewBadgeEpoch += 1;
  previewBadgeObservedSession = identity;
});
globalThis.window?.addEventListener('storage', (event) => {
  if (!event.key || ['dominion:user', 'dominion:mockUserId', PREVIEW_AUTH_OWNER_STORAGE_KEY].includes(event.key)
    || /^sb-.+-auth-token/.test(event.key)) previewBadgeEpoch += 1;
  if (!event.key || event.key.startsWith('dominion:') || /^sb-.+-auth-token/.test(event.key)) {
    inflightActorReads.invalidate();
  }
});
for (const event of ['online', 'offline', 'dominion:challenge-activation-updated',
  'dominion:challenge-start-date-updated']) {
  globalThis.window?.addEventListener(event, () => inflightActorReads.invalidate());
}
globalThis.document?.addEventListener('visibilitychange', () => {
  if (!document.hidden) inflightActorReads.invalidate();
});
export function isLocalDemoMode() {
  if (typeof window === 'undefined') return false;
  return ENABLE_MOCKS || (import.meta.env.DEV && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname));
}
export const usesSupabaseAuthentication = () => Boolean(supabase)
  && shouldUseSupabaseAuthentication({
    configured: true,
    localDemo: isLocalDemoMode(),
    mocksEnabled: ENABLE_MOCKS,
    productionBuild: import.meta.env.PROD,
    localHybridEnabled: ENABLE_LOCAL_HYBRID_AUTH,
  });
export const isHybridAuthPreview = () => isLocalDemoMode() && usesSupabaseAuthentication();
