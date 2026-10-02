import {
  MOCK_JOURNAL_KEY,
  createJournalEntry,
  getAuthSession,
  getJournalDatePolicy,
  getLocalOrSessionUser,
  getMockUserId,
  mockIdentityHash,
  persistHybridAuthUser,
  readPreviewAggregate,
  updateJournalEntry,
} from './api.js';
import {
  SUPABASE_KEY,
  SUPABASE_URL,
  isHybridAuthPreview,
  isLocalDemoMode,
  previewBadgeEpoch,
  supabase,
  usesSupabaseAuthentication,
} from './auth-runtime-core.mjs';
import { createJournalApiClientFromShared } from './journal-api-adapter.mjs';
import { authSessionIdentity, sessionRequiresMfa } from './mfa-auth.mjs';
import { normalizeMockLoginIdentity } from './mock-identity.mjs';
import { peekPreviewUserValue } from './preview-user-state.mjs';

export function createJournalApiClientFromApplication() {
  return createJournalApiClientFromShared({
    baseUrl: SUPABASE_URL,
    apiKey: SUPABASE_KEY,
    fetcher: globalThis.fetch,
    getEpoch: () => previewBadgeEpoch,
    auth: usesSupabaseAuthentication() ? {
      getSession: getAuthSession,
      getAuth: () => supabase.auth,
      requiresMfa: sessionRequiresMfa,
      sessionIdentity: authSessionIdentity,
      onVerifiedUser: isHybridAuthPreview() ? persistHybridAuthUser : undefined,
    } : null,
    preview: isLocalDemoMode() ? {
      getUser: getLocalOrSessionUser,
      getActorId: getMockUserId,
      identityHash: mockIdentityHash,
      normalizeIdentity: normalizeMockLoginIdentity,
      readAggregate: readPreviewAggregate,
      peekValue: peekPreviewUserValue,
      storage: globalThis.localStorage,
      journalKey: MOCK_JOURNAL_KEY,
      readDatePolicy: getJournalDatePolicy,
      createEntry: createJournalEntry,
      updateEntry: updateJournalEntry,
    } : null,
  });
}
