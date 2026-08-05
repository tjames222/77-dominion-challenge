import { createClient } from '@supabase/supabase-js';
import {
  DEFAULT_CHALLENGE_DEFINITIONS,
  acknowledgeChallengeRecord,
  buildChallengeProgression,
  migrateChallengeUnlockRecords,
  normalizeChallengeProgression,
  transitionChallengeRecord,
} from './challenge-progression.mjs';
import {
  createCheckInAlreadyCompleteError,
  isDuplicateCheckInError,
  migrateMockCheckInCache,
} from './check-in.mjs';
import {
  moveMockIdentity,
  normalizeMockLoginIdentity,
  resolveMockIdentity,
} from './mock-identity.mjs';
import { normalizeDailyStandardDraft } from './daily-standard-draft.mjs';
import {
  buildMockChallengeActivation,
  buildMockLegacyChallengeActivation,
  challengeActivationReadError,
  createMockNotStartedChallengeActivation,
  isSupportedChallengeActivationDate,
  newChallengeActivationRequestId,
  normalizeChallengeActivation,
  normalizeChallengeActivationMutation,
  refreshMockChallengeActivation,
} from './challenge-activation.mjs';
import {
  prepareMockCrewMembersForStorage,
} from './mock-community-storage.mjs';
import { normalizeLeaderboardRank } from './leaderboard-prestige.mjs';
import {
  claimPreviewLegacyOwner,
  peekPreviewUserValue,
  readPreviewUserValue,
  writePreviewUserValue,
} from './preview-user-state.mjs';
import { normalizeEarnedBadges } from './badges-rewards.mjs';
import { normalizeJournalEntry, sortJournalEntries } from './journal-entry.mjs';
import {
  canonicalProfilePhotoUrl,
  commitProfileUpdateWithCompareAndSwap,
  createProfilePhotoStoragePath,
  isPreparedProfilePhoto,
  replaceProfilePhoto as replacePreparedProfilePhoto,
  syncProfileMetadataBestEffort,
} from './profile-photo.mjs';
import { registerProfilePhotoUploadWithRetry } from './profile-photo-registration.mjs';
import {
  LEGACY_PROFILE_COLUMNS,
  PROFILE_COLUMNS,
  buildProfilePatch,
  ensureProfileRecord,
  isMissingProfilePhotoSchemaError,
  readProfileRecord,
} from './profile-store.mjs';
import {
  normalizeConnectedDestinations,
  normalizeOutboundConsent,
  outboundConsentSettingsEqual,
  outboundConsentWritePayload,
} from './integration-consent.mjs';
import {
  backfillMockRewardEntitlements,
  buildMockRewardCatalog,
  claimMockRewardEntitlementUnlocks,
  challengeProgressionToRewardCatalog,
  normalizeRewardCatalog,
} from './reward-catalog.mjs';
import { assertSingleCrew, newCrewLifecycleRequestId } from './crew-experience.mjs';
import {
  CREW_TRAINING_STEP_COUNT,
  CREW_TRAINING_VERSION,
  normalizeCrewTrainingProgress,
} from './crew-training.mjs';
import {
  applySiteTrainingTransition,
  createSiteTrainingPageProgress,
  newSiteTrainingRequestId,
  normalizeSiteTrainingMutation,
  normalizeSiteTrainingState,
  reconcileSiteTrainingContentVersion,
  siteTrainingReadError,
} from './site-training-state.mjs';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(SUPABASE_URL).origin;
  } catch {
    return '';
  }
})();
const SUPABASE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  '';
const ENABLE_MOCKS = String(import.meta.env.VITE_ENABLE_MOCKS || '').toLowerCase() === 'true';
const isPlaceholder = (value) => !value || value.includes('YOUR_');
const isSupabaseConfigured = () => !isPlaceholder(SUPABASE_URL) && !isPlaceholder(SUPABASE_KEY);
export const supabase = isSupabaseConfigured() && !ENABLE_MOCKS
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
export function isLocalDemoMode() {
  if (typeof window === 'undefined') return false;
  return ENABLE_MOCKS || (import.meta.env.DEV && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname));
}
const MEMBERSHIP_ACCESS_KEY = 'membership_active';
const MEMBERSHIP_PRODUCT_KEY = 'dominion_membership';
const PROFILE_PHOTO_BUCKET = 'profile-photos';
const MOCK_USER_ID_KEY = 'dominion:mockUserId';
const MOCK_USER_IDS_BY_IDENTITY_KEY = 'dominion:mockUserIdsByIdentity';
const MOCK_SUBSCRIPTION_KEY = 'dominion:mockSubscription';
const MOCK_CREWS_KEY = 'dominion:mockCrews';
const MOCK_CREW_MEMBERS_KEY = 'dominion:mockCrewMembers';
const MOCK_INVITES_KEY = 'dominion:mockCrewInvites';
const MOCK_INVITE_SESSIONS_KEY = 'dominion:mockCrewInviteSessions';
const MOCK_INVITE_ATTRIBUTIONS_KEY = 'dominion:mockCrewInviteAttributions';
const MOCK_CREW_TRAINING_KEY = 'dominion:crewTraining';
const MOCK_SITE_TRAINING_PROGRESS_KEY = 'dominion:siteTrainingProgress';
const MOCK_SITE_TRAINING_REQUESTS_KEY = 'dominion:siteTrainingRequests';
const MOCK_POSTS_KEY = 'dominion:mockCommunityPosts';
const MOCK_JOURNAL_KEY = 'dominion:mockJournalEntries';
const MOCK_CHALLENGE_STATES_KEY = 'dominion:mockChallengeStates';
const MOCK_CHALLENGE_ACTIVATION_KEY = 'dominion:mockChallengeActivation';
const MOCK_CHALLENGE_ACTIVATION_REQUESTS_KEY = 'dominion:mockChallengeActivationRequests';
const MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY = 'dominion:mockChallengeActivationLegacyOwner';
const MOCK_REWARD_ENTITLEMENTS_KEY = 'dominion:mockRewardEntitlements';
const MOCK_CHALLENGE_THRESHOLDS_VERSION_KEY = 'dominion:mockChallengeThresholdsVersion';
const MOCK_OUTBOUND_CONSENT_KEY = 'dominion:mockOutboundConsent';
const MOCK_SHARING_REWARD_KEY = 'dominion:mockSharingReward';
const MOCK_THEME_PREFERENCES_KEY = 'dominion:mockThemePreferences';
const MOCK_CHALLENGE_THRESHOLDS_VERSION = 3;
const MOCK_MEDIA_DB_NAME = 'dominion-preview-media';
const MOCK_MEDIA_STORE_NAME = 'community-post-images';
const mockCommunityImageUrls = new Map();
const dailyStandardTimeZoneBootstraps = new Map();
let mockMediaDatabasePromise;

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read preview photo.'));
    reader.readAsDataURL(file);
  });
}

const randomId = (prefix) => `${prefix}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`;

const randomSecret = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some(Boolean)) return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${randomId('invite')}${randomId('secret')}`.replace(/[^A-Za-z0-9_-]/g, '');
};

const sha256Hex = async (value) => {
  if (!globalThis.crypto?.subtle) return `preview-${String(value)}`;
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
};

const getMockUser = () => readJson('dominion:user', {
  name: 'Preview Member',
  email: 'preview@77dominion.test',
  avatarUrl: '',
  authenticated: true,
});

const mockIdentityHash = (value) => {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const createMockUserId = (identity) => `${randomId('mock_user')}_${mockIdentityHash(identity)}`;

const preserveAdoptedMockLegacyActivation = (resolution) => {
  if (!resolution?.adoptedLegacy
    || localStorage.getItem(MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY)
    || !isSupportedChallengeActivationDate(readJson('dominion:startDate', ''))) return;
  localStorage.setItem(
    MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY,
    resolution.userId,
  );
  claimPreviewLegacyOwner(localStorage, resolution.userId);
};

const getMockUserId = () => {
  const resolution = resolveMockIdentity({
    email: getMockUser().email,
    identityMap: readJson(MOCK_USER_IDS_BY_IDENTITY_KEY, {}),
    legacyUserId: localStorage.getItem(MOCK_USER_ID_KEY) || '',
    createUserId: createMockUserId,
  });
  writeJson(MOCK_USER_IDS_BY_IDENTITY_KEY, resolution.identityMap);
  localStorage.setItem(MOCK_USER_ID_KEY, resolution.userId);
  preserveAdoptedMockLegacyActivation(resolution);
  return resolution.userId;
};

const readMockUserValue = (key, fallback, userId = getMockUserId()) => (
  readPreviewUserValue(localStorage, userId, key, fallback)
);

const writeMockUserValue = (key, value, userId = getMockUserId()) => (
  writePreviewUserValue(localStorage, userId, key, value)
);

const getMockSubscription = () => readMockUserValue(MOCK_SUBSCRIPTION_KEY, null);

const getMockBillingState = () => {
  const user = readJson('dominion:user', null);
  // A logged-out preview must not create a placeholder identity and claim
  // legacy account state merely because a public page checks billing access.
  const subscription = user?.authenticated ? getMockSubscription() : null;
  const active = Boolean(subscription?.subscriptionActive);
  return {
    authenticated: Boolean(user?.authenticated),
    billingEnabled: false,
    appAccess: active,
    subscriptionActive: active,
    subscription: active ? subscription : null,
    subscriptions: active ? [subscription] : [],
    entitlements: active ? [{
      key: MEMBERSHIP_ACCESS_KEY,
      status: 'active',
      startsAt: subscription.currentPeriodStart,
      endsAt: subscription.currentPeriodEnd,
      sourceType: 'mock',
      sourceId: subscription.id,
      metadata: { preview: true },
    }] : [],
  };
};

const todayLabel = (createdAt) => {
  const created = new Date(createdAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const createdDay = new Date(created);
  createdDay.setHours(0, 0, 0, 0);
  const days = Math.floor((today - createdDay) / 86400000);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
};

const localDayBounds = (now = new Date()) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
};

const requireSupabase = () => {
  if (isLocalDemoMode()) throw new Error('Supabase is disabled in preview mock mode.');
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase;
};

const localBypassBillingState = () => getMockBillingState();

const lockedBillingState = () => ({
  authenticated: false,
  billingEnabled: true,
  appAccess: false,
  subscriptionActive: false,
  subscription: null,
  subscriptions: [],
  entitlements: [],
});

const requireUser = async (expectedUserId = '') => {
  const client = requireSupabase();
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('You need to log in again.');
  if (expectedUserId && data.user.id !== expectedUserId) {
    throw new Error('The signed-in account changed. Try again.');
  }
  return data.user;
};

export { isMissingProfilePhotoSchemaError };

export function sessionToUser(session, fallbackName = 'Member') {
  const user = session?.user || {};
  const metadata = user.user_metadata || {};
  const email = user.email || '';
  const name = metadata.name || metadata.full_name || fallbackName || email.split('@')[0] || 'Member';
  // public.profiles is the only supported avatar source. Ignoring the Auth
  // metadata mirror prevents a deleted predecessor from being resurrected.
  return { userId: user.id || '', name, email, avatarUrl: '', authenticated: Boolean(session?.access_token) };
}

export const hasSupabaseAuth = () => Boolean(supabase) && !isLocalDemoMode();

export async function getAuthSession() {
  if (!supabase || isLocalDemoMode()) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function subscribeToAuthStateChanges(listener) {
  if (!supabase || isLocalDemoMode() || typeof listener !== 'function') return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    listener({
      event,
      user: session?.user ? sessionToUser(session) : null,
    });
  });
  return () => data?.subscription?.unsubscribe?.();
}

export function getCurrentAppPath() {
  if (typeof window === 'undefined') return './dashboard.html';
  const path = window.location.pathname.split('/').pop() || 'dashboard.html';
  return `./${path}${window.location.search}${window.location.hash}`;
}

export function redirectToLogin(returnTo = getCurrentAppPath()) {
  const target = encodeURIComponent(returnTo);
  window.location.href = `./login.html?returnTo=${target}`;
}

export function sanitizeReturnTo(returnTo, fallback = './dashboard.html') {
  if (!returnTo) return fallback;
  try {
    const resolved = new URL(returnTo, window.location.origin);
    if (resolved.origin !== window.location.origin) return fallback;
    const path = resolved.pathname.split('/').pop() || 'dashboard.html';
    const fragmentParams = new URLSearchParams(resolved.hash.replace(/^#/, ''));
    if (resolved.searchParams.has('invite') || fragmentParams.has('invite')) return fallback;
    if (path === 'invite.html') return './invite.html';
    return `./${path}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

export async function clearAuthSession() {
  if (supabase) await supabase.auth.signOut();
  if (isLocalDemoMode() && readJson('dominion:user', null)?.email) {
    // Adopt a legacy install's active ID before clearing the account pointer.
    claimPreviewLegacyOwner(localStorage, getMockUserId());
  }
  localStorage.removeItem('dominion:user');
  localStorage.removeItem(MOCK_USER_ID_KEY);
  localStorage.removeItem('dominion:theme');
}

export function saveLocalMockUser(user) {
  if (!isLocalDemoMode()) throw new Error('Preview login is unavailable outside local demo mode.');
  const nextUser = {
    name: String(user?.name || '').trim() || 'Member',
    email: String(user?.email || '').trim(),
    avatarUrl: String(user?.avatarUrl || ''),
    authenticated: true,
  };
  if (!nextUser.email) throw new TypeError('An email is required to log in.');
  const existingUser = readJson('dominion:user', null);
  if (existingUser?.email
    && normalizeMockLoginIdentity(existingUser.email) !== normalizeMockLoginIdentity(nextUser.email)) {
    claimPreviewLegacyOwner(localStorage, getMockUserId());
  }
  const resolution = resolveMockIdentity({
    email: nextUser.email,
    identityMap: readJson(MOCK_USER_IDS_BY_IDENTITY_KEY, {}),
    legacyUserId: normalizeMockLoginIdentity(existingUser?.email)
      === normalizeMockLoginIdentity(nextUser.email)
      ? localStorage.getItem(MOCK_USER_ID_KEY) || ''
      : '',
    createUserId: createMockUserId,
  });
  writeJson(MOCK_USER_IDS_BY_IDENTITY_KEY, resolution.identityMap);
  localStorage.setItem(MOCK_USER_ID_KEY, resolution.userId);
  preserveAdoptedMockLegacyActivation(resolution);
  writeJson('dominion:user', nextUser);
  if (nextUser.name) writeJson('dominion:memberName', nextUser.name);
  return { ...nextUser, userId: resolution.userId };
}

export function saveLocalUserFromSession(session, fallbackName) {
  const user = sessionToUser(session, fallbackName);
  localStorage.setItem('dominion:user', JSON.stringify(user));
  if (user.name) localStorage.setItem('dominion:memberName', JSON.stringify(user.name));
  return user;
}

export async function getLocalOrSessionUser() {
  if (isLocalDemoMode()) {
    const user = readJson('dominion:user', null);
    return user ? { ...user, userId: getMockUserId() } : null;
  }
  const session = await getAuthSession();
  if (session?.user) return sessionToUser(session);
  return null;
}

const normalizeThemePreference = (preference = {}) => ({
  themeKey: typeof (preference.themeKey ?? preference.theme_key) === 'string'
    ? (preference.themeKey ?? preference.theme_key)
    : null,
  updatedAt: preference.updatedAt ?? preference.updated_at ?? null,
});

export async function getThemePreference() {
  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    return normalizeThemePreference(readJson(MOCK_THEME_PREFERENCES_KEY, {})[userId]);
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('get_theme_preference');
  if (error) throw error;
  return normalizeThemePreference(data);
}

export async function setThemePreference(themeKey) {
  const normalizedThemeKey = String(themeKey || '').trim().toLowerCase();
  if (!['dark', 'light', 'dominion-night'].includes(normalizedThemeKey)) {
    throw new Error('The requested theme is unavailable.');
  }

  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    const preferences = readJson(MOCK_THEME_PREFERENCES_KEY, {});
    const preference = {
      themeKey: normalizedThemeKey,
      updatedAt: new Date().toISOString(),
    };
    preferences[userId] = preference;
    writeJson(MOCK_THEME_PREFERENCES_KEY, preferences);
    return preference;
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('set_theme_preference', {
    target_theme_key: normalizedThemeKey,
  });
  if (error) throw error;
  return normalizeThemePreference(data);
}

export async function ensureProfile({ name, email, expectedUserId = '' } = {}) {
  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  const metadata = user.user_metadata || {};
  const displayName = name || metadata.name || metadata.full_name || user.email?.split('@')[0] || 'Member';
  const result = await ensureProfileRecord(client, {
    user_id: user.id,
    name: displayName,
    email: email || user.email || '',
  });
  return mapProfile(result.data);
}

export async function signUpWithPassword({ name, email, password }) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw error;
  if (data.session?.access_token) await ensureProfile({ name, expectedUserId: data.user?.id });

  return { session: data.session, user: data.user };
}

export async function signInWithPassword({ email, password }) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  if (data.session?.access_token) await ensureProfile();

  return { session: data.session, user: data.user };
}

const mapProfile = (profile) => profile ? ({
  userId: profile.user_id,
  name: profile.name,
  email: profile.email,
  avatarUrl: canonicalProfilePhotoUrl(
    profile.avatar_url,
    profile.user_id,
    SUPABASE_ORIGIN,
    PROFILE_PHOTO_BUCKET,
  ),
  challengeStartDate: profile.challenge_start_date,
  timeZone: profile.time_zone || '',
  createdAt: profile.created_at,
  updatedAt: profile.updated_at,
  profilePhotoAvailable: profile.profile_photo_available !== false,
}) : null;

const mapEntry = (entry) => normalizeDailyStandardDraft(entry);

const mapFeedItem = (item) => ({
  id: item.id,
  date: item.entry_date || item.date,
  name: item.display_name || item.name || 'Member',
  day: item.day || item.challenge_day,
  status: item.status,
  completedCount: item.completed_count || 0,
  pointsAwarded: item.points_awarded || 0,
  timestamp: item.created_at ? todayLabel(item.created_at) : item.timestamp || 'Today',
  createdAt: item.created_at,
});

const mapCrew = (item) => {
  const crew = item.crews || item;
  return crew ? {
    id: crew.id || item.crew_id,
    name: crew.name || 'Crew',
    description: crew.description || '',
    challengeStartDate: crew.challenge_start_date,
    createdBy: crew.created_by,
    createdAt: crew.created_at,
    role: item.role || crew.role || 'member',
    joinedAt: item.joined_at,
  } : null;
};

const mapBadge = (badge) => {
  const definition = badge.badge_definitions || badge;
  return badge ? {
    key: badge.badge_key || badge.key,
    name: definition?.name || badge.name || 'Badge',
    description: definition?.description || badge.description || '',
    category: definition?.category || badge.category || 'challenge',
    tier: definition?.tier || badge.tier || 'bronze',
    icon: definition?.icon || badge.icon || 'shield',
    earnedAt: badge.earned_at || badge.earnedAt || null,
    entryDate: badge.entry_date || badge.entryDate || badge.metadata?.entryDate || null,
    metadata: badge.metadata || {},
  } : null;
};

const mapGameStats = (stats) => stats ? ({
  totalPoints: stats.total_points || stats.totalPoints || 0,
  challengePoints: stats.challenge_points || stats.challengePoints || 0,
  currentAppStreak: stats.current_app_streak || stats.currentAppStreak || 0,
  bestAppStreak: stats.best_app_streak || stats.bestAppStreak || 0,
  currentFullDayStreak: stats.current_full_day_streak || stats.currentFullDayStreak || 0,
  bestFullDayStreak: stats.best_full_day_streak || stats.bestFullDayStreak || 0,
  lastSeenDate: stats.last_seen_date || stats.lastSeenDate || null,
  lastFullDayDate: stats.last_full_day_date || stats.lastFullDayDate || null,
}) : {
  totalPoints: 0,
  challengePoints: 0,
  currentAppStreak: 0,
  bestAppStreak: 0,
  currentFullDayStreak: 0,
  bestFullDayStreak: 0,
  lastSeenDate: null,
  lastFullDayDate: null,
};

const mapLeaderboardRow = (row) => ({
  rank: row.rank_position || row.rank || 0,
  userId: row.user_id || row.userId,
  name: row.display_name || row.name || 'Member',
  avatarUrl: canonicalProfilePhotoUrl(
    row.avatar_url || row.avatarUrl,
    row.user_id || row.userId,
    SUPABASE_ORIGIN,
    PROFILE_PHOTO_BUCKET,
  ),
  points: row.points || 0,
  currentAppStreak: row.current_app_streak || row.currentAppStreak || 0,
  latestChallengeDay: row.latest_challenge_day || row.latestChallengeDay || 0,
  badges: Array.isArray(row.badges) ? row.badges.map(mapBadge).filter(Boolean) : [],
});

const mapSubscription = (subscription) => subscription ? ({
  id: subscription.id,
  productKey: subscription.product_key,
  status: subscription.status,
  cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  currentPeriodStart: subscription.current_period_start,
  currentPeriodEnd: subscription.current_period_end,
  canceledAt: subscription.canceled_at,
  createdAt: subscription.created_at,
}) : null;

const mapEntitlement = (entitlement) => entitlement ? ({
  key: entitlement.entitlement_key,
  status: entitlement.status,
  startsAt: entitlement.starts_at,
  endsAt: entitlement.ends_at,
  sourceType: entitlement.source_type,
  sourceId: entitlement.source_id,
  metadata: entitlement.metadata || {},
}) : null;

export function hasActiveEntitlement(entitlements, entitlementKey) {
  const now = Date.now();
  return entitlements.some((item) => {
    if (item.key !== entitlementKey || item.status !== 'active') return false;
    if (!item.endsAt) return true;
    return new Date(item.endsAt).getTime() > now;
  });
}

export function formatCurrency(amount, currency = 'usd') {
  if (amount === null || amount === undefined) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(amount / 100);
}

export function formatDateLabel(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

export async function getProfile({ expectedUserId = '' } = {}) {
  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  const result = await readProfileRecord(client, user.id);
  const profile = result.data
    ? mapProfile(result.data)
    : await ensureProfile({ expectedUserId: user.id });
  if (profile.userId !== user.id) throw new Error('Unable to verify the profile account.');
  if (profile.profilePhotoAvailable) {
    void drainProfilePhotoCleanupQueue({ expectedUserId: user.id }).catch((cleanupError) => {
      console.warn('Profile-photo cleanup will retry later', cleanupError);
    });
  }
  return profile;
}

export async function updateProfile(profile, { expectedUserId = '' } = {}) {
  if (profile.challengeStartDate !== undefined) {
    throw new Error('Challenge start dates must be changed through the challenge activation service.');
  }
  if (isLocalDemoMode()) {
    const currentUserId = getMockUserId();
    if (expectedUserId && currentUserId !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    const existing = getMockUser();
    for (const checkInKey of ['dominion:checkInDates', 'dominion:previewCheckInDates']) {
      const migratedCheckIns = migrateMockCheckInCache(
        readMockUserValue(checkInKey, {}, currentUserId),
        currentUserId,
        existing.email,
      );
      writeMockUserValue(checkInKey, migratedCheckIns, currentUserId);
    }
    const nextUser = {
      ...existing,
      name: profile.name ?? existing.name ?? 'Member',
      email: profile.email ?? existing.email ?? '',
      avatarUrl: profile.avatarUrl ?? existing.avatarUrl ?? '',
      authenticated: true,
      updatedAt: new Date().toISOString(),
    };
    const nextIdentityMap = moveMockIdentity({
      identityMap: readJson(MOCK_USER_IDS_BY_IDENTITY_KEY, {}),
      fromEmail: existing.email,
      toEmail: nextUser.email,
      userId: currentUserId,
    });
    writeJson(MOCK_USER_IDS_BY_IDENTITY_KEY, nextIdentityMap);
    localStorage.setItem(MOCK_USER_ID_KEY, currentUserId);
    writeJson('dominion:user', nextUser);
    if (nextUser.name) writeJson('dominion:memberName', nextUser.name);
    return nextUser;
  }

  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  const metadata = user.user_metadata || {};
  const nextName = profile.name || metadata.name || metadata.full_name || user.email?.split('@')[0] || 'Member';
  const nextEmail = profile.email || user.email || '';
  const avatarOnly = Boolean(profile.avatarOnly);
  const profilePhotoStoragePath = String(profile.profilePhotoStoragePath || '');
  let currentResult = await readProfileRecord(client, user.id);
  if (!currentResult.data) {
    await ensureProfile({ expectedUserId });
    currentResult = await readProfileRecord(client, user.id);
  }
  const initialProfile = currentResult.data ? mapProfile(currentResult.data) : null;
  if (!initialProfile) throw new Error('Unable to load your profile.');

  const patch = buildProfilePatch(profile, { nextName, nextEmail });
  if (profile.avatarUrl !== undefined && !profilePhotoStoragePath) {
    throw new Error('Profile pictures must be committed from a registered upload.');
  }

  const selectColumns = currentResult.profilePhotoAvailable
    ? PROFILE_COLUMNS
    : LEGACY_PROFILE_COLUMNS;
  const readCurrentProfile = async () => {
    const result = await readProfileRecord(client, user.id);
    return result.data ? mapProfile(result.data) : null;
  };
  const isCommitted = (current) => Boolean(current) && Object.entries(patch).every(
    ([key, value]) => current[key] === value,
  );

  let savedProfile;
  if (profilePhotoStoragePath) {
    if (!currentResult.profilePhotoAvailable) {
      throw new Error('Profile pictures are temporarily unavailable while storage is upgraded.');
    }
    const updateText = !avatarOnly
      && (profile.name !== undefined || profile.email !== undefined);
    const expectedAvatarUrl = canonicalProfilePhotoUrl(
      profilePhotoStoragePath,
      user.id,
      SUPABASE_ORIGIN,
      PROFILE_PHOTO_BUCKET,
    );
    savedProfile = await commitProfileUpdateWithCompareAndSwap({
      expectedUpdatedAt: profile.expectedUpdatedAt,
      avatarOnly,
      tryCommit: async (expectedUpdatedAt) => {
        const { data, error } = await client.rpc('commit_profile_photo_upload', {
          target_storage_path: profilePhotoStoragePath,
          target_expected_updated_at: expectedUpdatedAt,
          target_update_text: updateText,
          target_name: updateText ? (profile.name ?? initialProfile.name) : null,
          target_email: updateText ? (profile.email ?? initialProfile.email) : null,
        });
        if (error) throw error;
        return data?.committed && data.profile
          ? mapProfile({ ...data.profile, profile_photo_available: true })
          : null;
      },
      readCurrentProfile,
      isCommitted: (current) => current?.avatarUrl === expectedAvatarUrl
        && isCommitted(current),
    });
  } else if (profile.expectedUpdatedAt) {
    savedProfile = await commitProfileUpdateWithCompareAndSwap({
      expectedUpdatedAt: profile.expectedUpdatedAt,
      avatarOnly: false,
      tryCommit: async (expectedUpdatedAt) => {
        const { data, error } = await client
          .from('profiles')
          .update(patch)
          .eq('user_id', user.id)
          .eq('updated_at', expectedUpdatedAt)
          .select(selectColumns)
          .maybeSingle();
        if (error) throw error;
        return data
          ? mapProfile({
              ...data,
              avatar_url: data.avatar_url || '',
              profile_photo_available: currentResult.profilePhotoAvailable,
            })
          : null;
      },
      readCurrentProfile,
      isCommitted,
    });
  } else {
    if (!Object.keys(patch).length) {
      savedProfile = initialProfile;
    } else {
      const { data, error } = await client
        .from('profiles')
        .update(patch)
        .eq('user_id', user.id)
        .select(selectColumns)
        .maybeSingle();
      if (error) throw error;
      savedProfile = data
        ? mapProfile({
            ...data,
            avatar_url: data.avatar_url || '',
            profile_photo_available: currentResult.profilePhotoAvailable,
          })
        : await readCurrentProfile();
    }
  }

  const metadataUpdates = {};
  if (!avatarOnly && profile.name !== undefined) {
    metadataUpdates.name = savedProfile.name;
    metadataUpdates.full_name = savedProfile.name;
  }
  if (profilePhotoStoragePath) {
    metadataUpdates.avatar_url = null;
    metadataUpdates.picture = null;
  }
  const metadataSyncError = Object.keys(metadataUpdates).length
    ? await syncProfileMetadataBestEffort(
        (data) => client.auth.updateUser({ data }),
        metadataUpdates,
      )
    : null;

  let emailChangeRequested = false;
  let emailChangeError = null;
  if (!avatarOnly && profile.email && profile.email !== user.email) {
    try {
      const { data, error } = await client.auth.updateUser({ email: profile.email });
      if (error) throw error;
      emailChangeRequested = data?.user?.email !== profile.email;
    } catch (error) {
      emailChangeError = error;
    }
  }

  return { ...savedProfile, emailChangeRequested, emailChangeError, metadataSyncError };
}

function profilePhotoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '');
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some(Boolean)) return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${Math.random().toString(16).slice(2).padEnd(16, '0')}${Math.random().toString(16).slice(2).padEnd(16, '0')}`.slice(0, 32);
}

function isUnavailableProfilePhotoCleanupRpc(error) {
  const message = `${error?.code || ''} ${error?.message || ''}`;
  return /PGRST202|register_profile_photo_upload|commit_profile_photo_upload|abandon_profile_photo_upload|claim_profile_photo_cleanup/.test(message)
    && /not find|not found|schema cache|PGRST202/i.test(message);
}

export async function drainProfilePhotoCleanupQueue({ maxBatches = 8, expectedUserId = '' } = {}) {
  if (isLocalDemoMode()) return { removed: 0 };
  const client = requireSupabase();
  await requireUser(expectedUserId);
  let removed = 0;
  const failures = [];

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { data: jobs, error: claimError } = await client.rpc('claim_profile_photo_cleanup', {
      target_limit: 20,
    });
    if (claimError) {
      // The frontend-only rollout intentionally precedes the hardening migration.
      if (isUnavailableProfilePhotoCleanupRpc(claimError)) return { removed, available: false };
      throw claimError;
    }
    if (!jobs?.length) break;

    for (const job of jobs) {
      const { error: removeError } = await client.storage
        .from(PROFILE_PHOTO_BUCKET)
        .remove([job.storage_path]);
      if (removeError) {
        failures.push(removeError);
        continue;
      }
      const { data: confirmed, error: confirmError } = await client.rpc('confirm_profile_photo_cleanup', {
        target_job_id: job.job_id,
        target_claim_token: job.claim_token,
      });
      if (confirmError) failures.push(confirmError);
      else if (confirmed !== true) {
        failures.push(new Error('The profile-photo cleanup claim expired before confirmation.'));
      } else removed += 1;
    }
    if (failures.length) break;
  }

  if (failures.length) {
    const error = new Error('The profile saved, but old picture cleanup will retry on your next profile visit.');
    error.cause = failures[0];
    throw error;
  }
  return { removed, available: true };
}

export async function uploadProfilePhoto(preparedPhoto, { expectedUserId = '' } = {}) {
  if (!isPreparedProfilePhoto(preparedPhoto)) {
    throw new Error('Prepare the profile picture before uploading it.');
  }
  if (isLocalDemoMode()) {
    if (expectedUserId && getMockUserId() !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    return { avatarUrl: await fileToDataUrl(preparedPhoto.blob), storagePath: '' };
  }

  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  const storagePath = createProfilePhotoStoragePath(
    user.id,
    preparedPhoto.extension,
    Date.now(),
    profilePhotoRandomId(),
  );
  let registrationId;
  try {
    registrationId = await registerProfilePhotoUploadWithRetry({
      storagePath,
      register: (targetStoragePath) => client.rpc('register_profile_photo_upload', {
        target_storage_path: targetStoragePath,
      }),
    });
  } catch (registerError) {
    if (isUnavailableProfilePhotoCleanupRpc(registerError)) {
      throw new Error('Profile pictures are temporarily unavailable while storage is upgraded.');
    }
    throw registerError;
  }

  const abandonUpload = async () => {
    const { error } = await client.rpc('abandon_profile_photo_upload', {
      target_storage_path: storagePath,
    });
    if (error) throw error;
  };

  const { error: uploadError } = await client.storage
    .from(PROFILE_PHOTO_BUCKET)
    .upload(storagePath, preparedPhoto.blob, {
      cacheControl: '31536000',
      contentType: preparedPhoto.contentType,
      upsert: false,
    });
  if (uploadError) {
    try {
      await abandonUpload();
      await drainProfilePhotoCleanupQueue({ expectedUserId });
    } catch (cleanupError) {
      uploadError.profilePhotoCleanupError = cleanupError;
    }
    throw uploadError;
  }

  return {
    avatarUrl: storagePath,
    storagePath,
    registrationId,
  };
}

export async function replaceProfilePhoto({ preparedPhoto, profile }, { expectedUserId = '' } = {}) {
  return replacePreparedProfilePhoto({
    preparedPhoto,
    profile,
    uploadPhoto: (photo) => uploadProfilePhoto(photo, { expectedUserId }),
    saveProfile: (nextProfile) => updateProfile(nextProfile, { expectedUserId }),
    abandonUploadedPhoto: async (uploadedPhoto) => {
      const client = requireSupabase();
      await requireUser(expectedUserId);
      const { data, error } = await client.rpc('abandon_profile_photo_upload', {
        target_storage_path: uploadedPhoto.storagePath,
      });
      if (error) throw error;
      return data === true;
    },
    cleanupQueuedPhotos: () => drainProfilePhotoCleanupQueue({ expectedUserId }),
  });
}

export async function getBillingState() {
  if (isLocalDemoMode()) return localBypassBillingState();
  if (!supabase) return lockedBillingState();

  const session = await getAuthSession();
  if (!session?.user) {
    return {
      authenticated: false,
      billingEnabled: true,
      appAccess: false,
      subscriptionActive: false,
      subscription: null,
      subscriptions: [],
      entitlements: [],
    };
  }

  const client = requireSupabase();
  const userId = session.user.id;
  const [entitlementsResult, subscriptionsResult] = await Promise.all([
    client
      .from('entitlements')
      .select('entitlement_key, status, starts_at, ends_at, source_type, source_id, metadata')
      .eq('user_id', userId),
    client
      .from('subscriptions')
      .select('id, product_key, status, cancel_at_period_end, current_period_start, current_period_end, canceled_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  ]);

  if (entitlementsResult.error) throw entitlementsResult.error;
  if (subscriptionsResult.error) throw subscriptionsResult.error;

  const entitlements = (entitlementsResult.data || []).map(mapEntitlement);
  const subscriptions = (subscriptionsResult.data || []).map(mapSubscription);
  const subscriptionActive = hasActiveEntitlement(entitlements, MEMBERSHIP_ACCESS_KEY);
  const subscription = subscriptions.find((item) => item.productKey === MEMBERSHIP_PRODUCT_KEY) || null;

  return {
    authenticated: true,
    billingEnabled: true,
    appAccess: subscriptionActive,
    subscriptionActive,
    subscription,
    subscriptions,
    entitlements,
  };
}

async function invokeSupabaseAction(name, body = {}) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data || {};
}

async function invokeSupabaseFunction(name, body = {}) {
  const data = await invokeSupabaseAction(name, body);
  if (!data?.url) throw new Error('Billing session did not return a destination URL.');
  return data;
}

export async function createCheckoutSession(productKey) {
  if (isLocalDemoMode()) {
    if (productKey !== MEMBERSHIP_PRODUCT_KEY) throw new Error('Unsupported preview product selection.');
    const now = new Date();
    const currentPeriodEnd = new Date(now);
    currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
    const subscription = {
      id: 'preview_subscription',
      productKey,
      status: 'active',
      subscriptionActive: true,
      cancelAtPeriodEnd: false,
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: currentPeriodEnd.toISOString(),
      canceledAt: null,
      createdAt: now.toISOString(),
      preview: true,
    };
    writeMockUserValue(MOCK_SUBSCRIPTION_KEY, subscription);
    return { url: './billing.html?checkout=success&preview=1', preview: true };
  }
  return invokeSupabaseFunction('create-checkout-session', { productKey });
}

export async function createCustomerPortalSession(options = {}) {
  const flow = options?.flow || '';
  const returnPath = options?.returnPath || '';
  if (isLocalDemoMode()) {
    const url = flow === 'payment_method_update'
      ? './billing.html?payment=updated&preview=1'
      : './profile.html#billing';
    return { url, preview: true };
  }
  return invokeSupabaseFunction('create-customer-portal-session', { flow, returnPath });
}

export async function cancelMembership() {
  if (isLocalDemoMode()) {
    writeMockUserValue(MOCK_SUBSCRIPTION_KEY, null);
    return { canceled: true, accessRemoved: true, preview: true };
  }
  return invokeSupabaseAction('cancel-membership');
}

export async function manageGroupIntegration(action, values = {}) {
  if (isLocalDemoMode()) {
    if (action === 'list') return { destinations: [], preview: true };
    throw new Error('Connect Slack or Discord from a signed-in staging or production account.');
  }
  return invokeSupabaseAction('group-integrations', { action, ...values });
}

const mockSharePresentation = (kind) => {
  const stats = mapGameStats(readMockUserValue('dominion:gameStats', {}));
  const currentDay = Math.min(Math.max(Number(
    readMockUserValue('dominion:previewChallengeSimulation', {})?.day,
  ) || 1, 1), 77);
  if (kind === 'streak') {
    return {
      schemaVersion: 1,
      kind,
      payload: {
        schemaVersion: 1,
        kind,
        appStreak: stats.currentAppStreak,
        fullStandardStreak: stats.currentFullDayStreak,
      },
      presentation: {
        eyebrow: 'Consistency in motion',
        title: `${stats.currentAppStreak}-day Dominion app streak`,
        description: `A Dominion challenger has shown up ${stats.currentAppStreak} days in a row.`,
        metric: String(stats.currentAppStreak),
        metricLabel: 'day app streak',
      },
    };
  }
  if (kind === 'progress') {
    return {
      schemaVersion: 1,
      kind,
      payload: {
        schemaVersion: 1,
        kind,
        currentChallengeDay: currentDay,
        challengeLength: 77,
        progressPercent: Math.round(currentDay / 77 * 100),
      },
      presentation: {
        eyebrow: 'Challenge progress',
        title: `Day ${currentDay} of the 77-Day Dominion Challenge`,
        description: `A Dominion challenger is ${Math.round(currentDay / 77 * 100)}% through a disciplined rhythm of faith, fitness, and follow-through.`,
        metric: `${currentDay}/77`,
        metricLabel: 'challenge days',
      },
    };
  }
  return {
    schemaVersion: 1,
    kind: 'general',
    payload: { schemaVersion: 1, kind: 'general', challengeLength: 77, dailyStandards: 7 },
    presentation: {
      eyebrow: 'Build the standard',
      title: 'Take the 77-Day Dominion Challenge',
      description: 'Commit to seven daily standards for 77 days and build a disciplined rhythm of faith, fitness, and follow-through.',
      metric: '77',
      metricLabel: 'days of dominion',
    },
  };
};

export async function previewShareSnapshot(kind) {
  if (isLocalDemoMode()) return mockSharePresentation(kind);
  return invokeSupabaseAction('share-snapshot', { action: 'preview', kind });
}

export async function createShareSnapshot(kind, { expectedUserId = '' } = {}) {
  if (isLocalDemoMode()) {
    if (expectedUserId && getMockUserId() !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    const preview = mockSharePresentation(kind);
    const destination = new URL('./index.html', window.location.href);
    destination.searchParams.set('shared', kind);
    return {
      ...preview,
      snapshotId: randomId('preview_snapshot'),
      url: destination.href,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      preview: true,
    };
  }
  await requireUser(expectedUserId);
  return invokeSupabaseAction('share-snapshot', { action: 'create', kind });
}

export async function createSharingRewardIntent(shareKind, { expectedUserId = '' } = {}) {
  if (isLocalDemoMode()) {
    if (expectedUserId && getMockUserId() !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    const grant = readMockUserValue(MOCK_SHARING_REWARD_KEY, null);
    return grant
      ? { eligible: false, alreadyGranted: true, shareKind }
      : {
          eligible: true,
          alreadyGranted: false,
          shareKind,
          completionToken: randomSecret(),
          expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
        };
  }

  const client = requireSupabase();
  await requireUser(expectedUserId);
  const { data, error } = await client.rpc('create_sharing_reward_intent', {
    target_share_kind: shareKind,
  });
  if (error) throw error;
  return data || {};
}

export async function completeSharingReward(completionToken, { expectedUserId = '' } = {}) {
  if (isLocalDemoMode()) {
    if (expectedUserId && getMockUserId() !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    const existing = readMockUserValue(MOCK_SHARING_REWARD_KEY, null);
    if (existing) return { granted: false, alreadyGranted: true, ...existing };

    const grantedAt = new Date().toISOString();
    const stats = readMockUserValue('dominion:gameStats', {});
    writeMockUserValue('dominion:gameStats', {
      ...stats,
      totalPoints: Number(stats.totalPoints ?? stats.challengePoints ?? 0) + 14,
      challengePoints: Number(stats.challengePoints ?? stats.totalPoints ?? 0) + 14,
    });
    const badges = readMockUserValue('dominion:badges', []);
    if (!badges.some((badge) => (badge.badge_key || badge.key) === 'sharing')) {
      badges.unshift({
        key: 'sharing',
        name: 'Share the Challenge',
        description: 'Shared the challenge or brought another person into a private group.',
        category: 'community',
        tier: 'bronze',
        icon: 'share',
        earnedAt: grantedAt,
      });
      writeMockUserValue('dominion:badges', badges);
    }
    const grant = { points: 14, badgeKey: 'sharing', grantedAt };
    writeMockUserValue(MOCK_SHARING_REWARD_KEY, grant);
    return { granted: true, alreadyGranted: false, ...grant };
  }

  const client = requireSupabase();
  await requireUser(expectedUserId);
  const { data, error } = await client.rpc('complete_sharing_reward', {
    target_completion_token: completionToken,
  });
  if (error) throw error;
  return data || {};
}

function getMockChallengeProgression() {
  const gameStats = readMockUserValue('dominion:gameStats', {});
  let records = readMockUserValue(MOCK_CHALLENGE_STATES_KEY, []);
  const thresholdVersion = Number(readMockUserValue(MOCK_CHALLENGE_THRESHOLDS_VERSION_KEY, 0));
  if (!Number.isFinite(thresholdVersion) || thresholdVersion < MOCK_CHALLENGE_THRESHOLDS_VERSION) {
    const migratedAt = new Date().toISOString();
    const totalPoints = gameStats.totalPoints ?? gameStats.challengePoints ?? 0;
    records = migrateChallengeUnlockRecords({
      previousDefinitions: DEFAULT_CHALLENGE_DEFINITIONS,
      records: Array.isArray(records) ? records : [],
      totalPoints,
      now: migratedAt,
    });
    const migratedProgression = buildChallengeProgression({
      definitions: DEFAULT_CHALLENGE_DEFINITIONS,
      records,
      totalPoints,
      now: migratedAt,
    });
    const ownershipRecords = backfillMockRewardEntitlements({
      progression: migratedProgression,
      ownershipRecords: readMockUserValue(MOCK_REWARD_ENTITLEMENTS_KEY, []),
      now: migratedAt,
    });
    writeMockUserValue(MOCK_CHALLENGE_STATES_KEY, records);
    writeMockUserValue(MOCK_REWARD_ENTITLEMENTS_KEY, ownershipRecords);
    writeMockUserValue(MOCK_CHALLENGE_THRESHOLDS_VERSION_KEY, MOCK_CHALLENGE_THRESHOLDS_VERSION);
  }
  const progression = buildChallengeProgression({
    definitions: DEFAULT_CHALLENGE_DEFINITIONS,
    records: Array.isArray(records) ? records : [],
    totalPoints: gameStats.totalPoints ?? gameStats.challengePoints ?? 0,
  });
  writeMockUserValue(MOCK_CHALLENGE_STATES_KEY, progression.records);
  return progression;
}

function getMockRewardCatalog() {
  const result = buildMockRewardCatalog({
    progression: getMockChallengeProgression(),
    ownershipRecords: readMockUserValue(MOCK_REWARD_ENTITLEMENTS_KEY, []),
  });
  writeMockUserValue(MOCK_REWARD_ENTITLEMENTS_KEY, result.ownershipRecords);
  return result.catalog;
}

export async function getChallengeProgression() {
  if (isLocalDemoMode()) return getMockChallengeProgression();

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('get_challenge_progression');
  if (error) throw error;
  return normalizeChallengeProgression(data || {});
}

export async function getRewardCatalog({ limit = 50, cursor = null } = {}) {
  if (isLocalDemoMode()) {
    return getMockRewardCatalog();
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('get_reward_catalog', {
    target_page_size: limit,
    target_after_sort_order: cursor?.sortOrder ?? null,
    target_after_reward_key: cursor?.key || null,
  });
  if (error) throw error;
  return normalizeRewardCatalog(data || {});
}

export async function getAllRewardCatalog({ pageSize = 100 } = {}) {
  const normalizedPageSize = Math.floor(Math.min(Math.max(Number(pageSize) || 100, 1), 100));
  const itemsByKey = new Map();
  const visitedCursors = new Set();
  let cursor = null;
  let firstPage = null;
  let totalItems = 0;

  while (true) {
    const page = await getRewardCatalog({ limit: normalizedPageSize, cursor });
    firstPage ||= page;
    totalItems = Math.max(totalItems, page.page.totalItems);
    for (const reward of page.items) itemsByKey.set(reward.key, reward);

    if (!page.page.hasMore) break;
    const nextCursor = page.page.nextCursor;
    const cursorKey = nextCursor ? `${nextCursor.sortOrder}:${nextCursor.key}` : '';
    if (!nextCursor?.key || visitedCursors.has(cursorKey)) {
      throw new Error('Reward catalog pagination did not advance.');
    }
    visitedCursors.add(cursorKey);
    cursor = nextCursor;
  }

  const items = [...itemsByKey.values()];
  return normalizeRewardCatalog({
    ...(firstPage || {}),
    items,
    page: {
      limit: items.length,
      totalItems: Math.max(totalItems, items.length),
      hasMore: false,
      nextCursor: null,
    },
  });
}

export async function claimRewardEntitlementUnlocks() {
  if (isLocalDemoMode()) {
    const result = claimMockRewardEntitlementUnlocks({
      progression: getMockChallengeProgression(),
      ownershipRecords: readMockUserValue(MOCK_REWARD_ENTITLEMENTS_KEY, []),
    });
    writeMockUserValue(MOCK_REWARD_ENTITLEMENTS_KEY, result.ownershipRecords);
    return {
      claimedUnlocks: result.claimedUnlocks,
      catalog: result.catalog,
    };
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('claim_reward_entitlement_unlocks');
  if (error) throw error;
  const catalog = normalizeRewardCatalog(data?.catalog || {});
  const claimedKeys = new Set(data?.claimedKeys || data?.claimed_keys || []);
  return {
    claimedUnlocks: catalog.items.filter((reward) => claimedKeys.has(reward.key)),
    catalog,
  };
}

export async function claimChallengeUnlocks({ expectedUserId = '' } = {}) {
  if (isLocalDemoMode()) {
    if (expectedUserId && getMockUserId() !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    const progression = getMockChallengeProgression();
    const claimedKeys = progression.unseenUnlocks.map((challenge) => challenge.key);
    const claimedKeySet = new Set(claimedKeys);
    const records = progression.records.map((item) => (
      claimedKeySet.has(item.key) ? acknowledgeChallengeRecord(item) : item
    ));
    writeMockUserValue(MOCK_CHALLENGE_STATES_KEY, records);
    const nextProgression = buildChallengeProgression({
      definitions: DEFAULT_CHALLENGE_DEFINITIONS,
      records,
      totalPoints: progression.totalPoints,
    });
    return {
      claimedUnlocks: progression.challenges.filter((challenge) => claimedKeySet.has(challenge.key)),
      progression: nextProgression,
    };
  }

  const client = requireSupabase();
  await requireUser(expectedUserId);
  const { data, error } = await client.rpc('claim_challenge_unlocks');
  if (error) throw error;
  const progression = normalizeChallengeProgression(data?.progression || {});
  const claimedKeySet = new Set(data?.claimedKeys || data?.claimed_keys || []);
  return {
    claimedUnlocks: progression.challenges.filter((challenge) => claimedKeySet.has(challenge.key)),
    progression,
  };
}

export async function startChallenge(challengeKey) {
  if (isLocalDemoMode()) {
    const progression = getMockChallengeProgression();
    const record = progression.records.find((item) => item.key === challengeKey);
    const nextRecord = transitionChallengeRecord(record, 'active');
    const records = progression.records.map((item) => item.key === challengeKey ? nextRecord : item);
    writeMockUserValue(MOCK_CHALLENGE_STATES_KEY, records);
    return buildChallengeProgression({
      definitions: DEFAULT_CHALLENGE_DEFINITIONS,
      records,
      totalPoints: progression.totalPoints,
    });
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('start_challenge', {
    target_challenge_key: challengeKey,
  });
  if (error) throw error;
  return normalizeChallengeProgression(data || {});
}

export async function getDashboard() {
  const client = requireSupabase();
  const user = await requireUser();
  const todayBounds = localDayBounds();
  const [profile, activation, entriesResult, checkInsResult, feedResult, completedTodayResult, statsResult, badgesResult] = await Promise.all([
    getProfile({ expectedUserId: user.id }),
    getChallengeActivation({ expectedUserId: user.id }),
    client
      .from('challenge_entries')
      .select('entry_date, completed, workout_difficulty, version, updated_at')
      .eq('user_id', user.id)
      .order('entry_date', { ascending: false })
      .limit(90),
    client
      .from('check_ins')
      .select('entry_date, challenge_day')
      .eq('user_id', user.id)
      .order('entry_date', { ascending: false })
      .limit(90),
    client
      .from('community_feed_items')
      .select('id, display_name, challenge_day, status, completed_count, points_awarded, created_at')
      .neq('status', 'scheduled')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(3),
    client
      .from('community_feed_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'complete')
      .gte('created_at', todayBounds.start)
      .lt('created_at', todayBounds.end),
    client
      .from('user_game_stats')
      .select('total_points, challenge_points, current_app_streak, best_app_streak, current_full_day_streak, best_full_day_streak, last_seen_date, last_full_day_date')
      .eq('user_id', user.id)
      .maybeSingle(),
    client
      .from('user_badges')
      .select('badge_key, earned_at, entry_date, metadata, badge_definitions(name, description, category, tier, icon)')
      .eq('user_id', user.id)
      .order('earned_at', { ascending: false })
      .limit(12),
  ]);

  if (entriesResult.error) throw entriesResult.error;
  if (checkInsResult.error) throw checkInsResult.error;
  if (feedResult.error) throw feedResult.error;
  if (completedTodayResult.error) throw completedTodayResult.error;
  if (statsResult.error) throw statsResult.error;
  if (badgesResult.error) throw badgesResult.error;

  return {
    profile,
    activation,
    entries: entriesResult.data.map(mapEntry),
    checkIns: (checkInsResult.data || []).map((checkIn) => ({
      date: checkIn.entry_date,
      challengeDay: checkIn.challenge_day,
    })),
    feed: (feedResult.data || []).map(mapFeedItem),
    completedTodayCount: Math.max(0, Number(completedTodayResult.count) || 0),
    gameStats: mapGameStats(statsResult.data),
    badges: (badgesResult.data || []).map(mapBadge).filter(Boolean),
  };
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

function mockOwnedCheckInCache(stored, userId = getMockUserId()) {
  const migrated = migrateMockCheckInCache(stored, userId, getMockUser().email);
  return migrated.dates.length || migrated.challengeDays.length ? migrated : null;
}

function mockCheckInHistoryExists(userId = getMockUserId()) {
  const cache = mockOwnedCheckInCache(
    readMockUserValue('dominion:checkInDates', {}, userId),
    userId,
  );
  return Boolean(cache && (
    (cache.dates?.length || 0) > 0 || (cache.challengeDays?.length || 0) > 0
  ));
}

function mockPersistedCrewMembershipExists(userId) {
  const storedMembers = readJson(MOCK_CREW_MEMBERS_KEY, {});
  if (!storedMembers || typeof storedMembers !== 'object' || Array.isArray(storedMembers)) {
    return false;
  }
  return Object.values(storedMembers).some((members) => (
    Array.isArray(members) && members.some((member) => member?.userId === userId)
  ));
}

function claimMockLegacyChallengeActivation({ userId, hasEntitlement }) {
  const previewLegacyOwner = claimPreviewLegacyOwner(localStorage, userId);
  if (!previewLegacyOwner || previewLegacyOwner !== userId) return null;
  const legacyStartDate = readMockUserValue('dominion:startDate', '', userId);
  if (!isSupportedChallengeActivationDate(legacyStartDate)) return null;

  const claimedOwnerId = localStorage.getItem(MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY) || '';
  if (claimedOwnerId && claimedOwnerId !== userId) return null;

  const checkIns = readMockUserValue('dominion:checkInDates', {}, userId);
  const migratedCheckIns = migrateMockCheckInCache(checkIns, userId, getMockUser().email);
  const hasCheckInOwnerEvidence = Boolean(mockOwnedCheckInCache(migratedCheckIns, userId));
  const hasCrewOwnerEvidence = mockPersistedCrewMembershipExists(userId);
  if (!claimedOwnerId && !hasCheckInOwnerEvidence && !hasCrewOwnerEvidence) return null;

  if (hasCheckInOwnerEvidence || claimedOwnerId === userId || hasCrewOwnerEvidence) {
    writeMockUserValue('dominion:checkInDates', migratedCheckIns, userId);
  }

  const activation = buildMockLegacyChallengeActivation({
    startDate: legacyStartDate,
    timeZone: browserTimeZone(),
    actorId: userId,
    hasCheckIns: mockCheckInHistoryExists(userId),
    hasEntitlement,
  });
  localStorage.setItem(MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY, userId);
  return activation;
}

function mockGroupMembershipIsActive(activation) {
  if (activation?.mode !== 'group' || !activation.crewId) return false;
  const { members } = ensureMockCrews();
  return Boolean(members[activation.crewId]?.some((member) => member.userId === getMockUserId()));
}

function mockActivationRequestSignature(action, parameters) {
  return JSON.stringify([action, parameters]);
}

function runMockActivationRequest({ requestId, action, parameters, mutate }) {
  if (typeof requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new TypeError('A valid challenge activation request ID is required.');
  }

  const actorId = getMockUserId();
  const signature = mockActivationRequestSignature(action, parameters);
  const storedRequests = readJson(MOCK_CHALLENGE_ACTIVATION_REQUESTS_KEY, {});
  const requests = storedRequests && typeof storedRequests === 'object' && !Array.isArray(storedRequests)
    ? storedRequests
    : {};
  const prior = requests[requestId];
  if (prior) {
    if (prior.actorId !== actorId || prior.action !== action || prior.signature !== signature) {
      throw new Error('This request ID was already used for another operation.');
    }
    return normalizeChallengeActivationMutation(prior.result);
  }

  const result = normalizeChallengeActivationMutation(mutate());
  requests[requestId] = { actorId, action, signature, result };
  writeJson(MOCK_CHALLENGE_ACTIVATION_REQUESTS_KEY, requests);
  return result;
}

function readMockChallengeActivation() {
  const storedStates = readJson(MOCK_CHALLENGE_ACTIVATION_KEY, {});
  const states = storedStates && typeof storedStates === 'object' && !Array.isArray(storedStates)
    ? storedStates
    : {};
  const userId = getMockUserId();
  const hasEntitlement = getMockBillingState().appAccess;
  if (states[userId]) {
    const stored = normalizeChallengeActivation(states[userId]);
    if (!stored.contractValid) return stored;
    const refreshed = refreshMockChallengeActivation(stored, {
      hasCheckIns: mockCheckInHistoryExists(),
      hasEntitlement,
      groupMembershipActive: mockGroupMembershipIsActive(stored),
    });
    if (JSON.stringify(refreshed) !== JSON.stringify(stored)) {
      states[userId] = refreshed;
      writeJson(MOCK_CHALLENGE_ACTIVATION_KEY, states);
    }
    return refreshed;
  }

  const initial = claimMockLegacyChallengeActivation({ userId, hasEntitlement })
    || createMockNotStartedChallengeActivation();
  states[userId] = initial;
  writeJson(MOCK_CHALLENGE_ACTIVATION_KEY, states);
  return initial;
}

function writeMockChallengeActivation(activation) {
  const normalized = normalizeChallengeActivationMutation(activation);
  const storedStates = readJson(MOCK_CHALLENGE_ACTIVATION_KEY, {});
  const states = storedStates && typeof storedStates === 'object' && !Array.isArray(storedStates)
    ? storedStates
    : {};
  const userId = getMockUserId();
  states[userId] = normalized;
  writeJson(MOCK_CHALLENGE_ACTIVATION_KEY, states);
  if (normalized.startDate) {
    const legacyOwnerId = localStorage.getItem(MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY) || '';
    if (legacyOwnerId === userId) {
      writeJson('dominion:startDate', normalized.startDate);
    }
  }
  return normalized;
}

const requireCapturedActivationActor = (expectedUserId) => {
  const actorId = String(expectedUserId || '').trim();
  if (!actorId) {
    throw new TypeError('A captured signed-in account is required for challenge activation operations.');
  }
  return actorId;
};

export async function getChallengeActivation({ expectedUserId } = {}) {
  const capturedActorId = requireCapturedActivationActor(expectedUserId);
  if (isLocalDemoMode()) {
    if (getMockUserId() !== capturedActorId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    return readMockChallengeActivation();
  }

  const client = requireSupabase();
  const user = await requireUser(capturedActorId);
  const { data, error } = await client.rpc('get_challenge_activation', {
    target_expected_actor_id: user.id,
  });
  if (error) return challengeActivationReadError(error);
  return normalizeChallengeActivation(data);
}

export async function activateSoloChallenge({
  startDate,
  timeZone = browserTimeZone(),
  requestId = newChallengeActivationRequestId(),
  expectedUserId,
} = {}) {
  const capturedActorId = requireCapturedActivationActor(expectedUserId);
  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    if (userId !== capturedActorId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    return runMockActivationRequest({
      requestId,
      action: 'solo_activate',
      parameters: { startDate, timeZone: String(timeZone || '').trim() },
      mutate: () => writeMockChallengeActivation(buildMockChallengeActivation({
        current: readMockChallengeActivation(),
        action: 'solo_activate',
        startDate,
        timeZone,
        actorId: userId,
        hasEntitlement: getMockBillingState().appAccess,
      })),
    });
  }

  const client = requireSupabase();
  const user = await requireUser(capturedActorId);
  const { data, error } = await client.rpc('activate_solo_challenge', {
    target_start_date: startDate,
    target_time_zone: timeZone,
    target_request_id: requestId,
    target_expected_actor_id: user.id,
  });
  if (error) throw error;
  return normalizeChallengeActivationMutation(data);
}

export async function activateGroupChallenge({
  crewId,
  timeZone = browserTimeZone(),
  requestId = newChallengeActivationRequestId(),
  expectedUserId,
} = {}) {
  const capturedActorId = requireCapturedActivationActor(expectedUserId);
  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    if (userId !== capturedActorId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    return runMockActivationRequest({
      requestId,
      action: 'group_activate',
      parameters: { crewId, timeZone: String(timeZone || '').trim() },
      mutate: () => {
        const { crews, members } = ensureMockCrews();
        const crew = crews.find((item) => item.id === crewId);
        if (!crew) throw new Error('Current crew membership is required for Group activation.');
        const membershipActive = Boolean(
          members[crewId]?.some((member) => member.userId === userId),
        );
        if (!membershipActive) {
          throw new Error('Current crew membership is required for Group activation.');
        }
        return writeMockChallengeActivation(buildMockChallengeActivation({
          current: readMockChallengeActivation(),
          action: 'group_activate',
          startDate: crew.challengeStartDate,
          timeZone,
          actorId: userId,
          crewId,
          groupMembershipActive: membershipActive,
          hasEntitlement: getMockBillingState().appAccess,
        }));
      },
    });
  }

  const client = requireSupabase();
  const user = await requireUser(capturedActorId);
  const { data, error } = await client.rpc('activate_group_challenge', {
    target_crew_id: crewId,
    target_time_zone: timeZone,
    target_request_id: requestId,
    target_expected_actor_id: user.id,
  });
  if (error) throw error;
  return normalizeChallengeActivationMutation(data);
}

export async function updateChallengeStartDate({
  startDate,
  timeZone = browserTimeZone(),
  requestId = newChallengeActivationRequestId(),
  expectedRevision = null,
  expectedUserId,
} = {}) {
  const capturedActorId = requireCapturedActivationActor(expectedUserId);
  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    if (userId !== capturedActorId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    return runMockActivationRequest({
      requestId,
      action: 'date_update',
      parameters: {
        startDate,
        timeZone: String(timeZone || '').trim(),
        expectedRevision,
      },
      mutate: () => writeMockChallengeActivation(buildMockChallengeActivation({
        current: readMockChallengeActivation(),
        action: 'date_update',
        startDate,
        timeZone,
        actorId: userId,
        expectedRevision,
        hasEntitlement: getMockBillingState().appAccess,
      })),
    });
  }

  const client = requireSupabase();
  const user = await requireUser(capturedActorId);
  const { data, error } = await client.rpc('set_challenge_start_date', {
    target_start_date: startDate,
    target_time_zone: timeZone,
    target_request_id: requestId,
    target_expected_revision: expectedRevision,
    target_expected_actor_id: user.id,
  });
  if (error) throw error;
  return normalizeChallengeActivationMutation(data);
}

const bootstrapDailyStandardTimeZone = async (client, userId) => {
  if (!dailyStandardTimeZoneBootstraps.has(userId)) {
    const bootstrap = (async () => {
      const { error } = await client.rpc('bootstrap_daily_standard_time_zone', {
        target_time_zone: browserTimeZone(),
        target_expected_actor_id: userId,
      });
      if (error) throw error;
    })();
    dailyStandardTimeZoneBootstraps.set(userId, bootstrap);
  }

  try {
    await dailyStandardTimeZoneBootstraps.get(userId);
  } catch (error) {
    dailyStandardTimeZoneBootstraps.delete(userId);
    throw error;
  }
};

const SITE_TRAINING_SCOPE_SET = new Set(['page', 'overall']);
const SITE_TRAINING_CLAIM_ACTION_SET = new Set(['start', 'resume']);
const SITE_TRAINING_TRANSITION_ACTION_SET = new Set(['back', 'next', 'stop', 'finish']);
const SITE_TRAINING_REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireCapturedSiteTrainingActor = (expectedUserId) => {
  const actorId = String(expectedUserId || '').trim();
  if (!actorId) {
    throw new TypeError('A captured signed-in account is required for page training operations.');
  }
  return actorId;
};

function requireSiteTrainingPage(page) {
  if (!page?.id
    || !page?.route
    || !Number.isInteger(page.contentVersion)
    || page.contentVersion < 1
    || !Array.isArray(page.steps)
    || !page.steps.length
    || page.steps.some((step) => !step?.id)) {
    throw new TypeError('A published page training contract is required.');
  }
  return page;
}

function requireSiteTrainingProgram(program, scope) {
  if (scope === 'page' && !program) return null;
  if (!program?.id
    || !Number.isInteger(program.version)
    || program.version < 1
    || !Array.isArray(program.pages)
    || !program.pages.length) {
    throw new TypeError('A published site training program is required for overall progress.');
  }
  return program;
}

function requireSiteTrainingOperation({ page, program = null, scope = 'page', action, requestId, expectedRevision }) {
  const normalizedScope = String(scope || '').trim().toLowerCase();
  if (!SITE_TRAINING_SCOPE_SET.has(normalizedScope)) throw new TypeError('Choose page or overall training progress.');
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!SITE_TRAINING_REQUEST_PATTERN.test(String(requestId || ''))) {
    throw new TypeError('A fresh page training request ID is required.');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('A current page training revision is required.');
  }
  return {
    page: requireSiteTrainingPage(page),
    program: requireSiteTrainingProgram(program, normalizedScope),
    scope: normalizedScope,
    action: normalizedAction,
    requestId,
    expectedRevision,
  };
}

const mockSiteTrainingPageKey = (page) => `${page.id}:${page.contentVersion}`;
const mockSiteTrainingProgramKey = (program) => `${program.id}:${program.version}`;

function readMockSiteTrainingStore(actorId, { readOnly = false } = {}) {
  const stored = readOnly
    ? peekPreviewUserValue(localStorage, actorId, MOCK_SITE_TRAINING_PROGRESS_KEY, {})
    : readMockUserValue(MOCK_SITE_TRAINING_PROGRESS_KEY, {}, actorId);
  return {
    pages: stored?.pages && typeof stored.pages === 'object' && !Array.isArray(stored.pages)
      ? { ...stored.pages }
      : {},
    programs: stored?.programs && typeof stored.programs === 'object' && !Array.isArray(stored.programs)
      ? { ...stored.programs }
      : {},
  };
}

function createMockSiteTrainingOverall(program) {
  const firstPage = program.pages[0];
  return {
    programId: program.id,
    programVersion: program.version,
    status: 'not_started',
    currentPageId: firstPage.pageId,
    currentPageContentVersion: firstPage.contentVersion,
    currentPageIndex: 0,
    revision: 0,
    startedAt: null,
    stoppedAt: null,
    completedAt: null,
    updatedAt: null,
  };
}

function mockSiteTrainingSnapshot(page, program, actorId, store) {
  const pageKey = mockSiteTrainingPageKey(page);
  const storedPage = store.pages[pageKey];
  let pageState;
  if (storedPage) {
    pageState = {
      ...createSiteTrainingPageProgress(page, actorId),
      page: storedPage,
    };
  } else {
    const priorStates = Object.values(store.pages)
      .map((candidate) => normalizeSiteTrainingState({
        schemaVersion: 1,
        actorId,
        page: candidate,
        overall: null,
        claimedNow: false,
        transition: null,
      }))
      .filter((candidate) => candidate.contractValid
        && candidate.page.pageId === page.id
        && candidate.page.contentVersion !== page.contentVersion);
    const completionCount = priorStates.reduce(
      (count, candidate) => Math.max(count, candidate.page.completionCount),
      0,
    );
    const previous = priorStates
      .filter((candidate) => ['in_progress', 'stopped'].includes(candidate.page.status))
      .sort((left, right) => (
        Date.parse(right.page.updatedAt) - Date.parse(left.page.updatedAt)
        || right.page.contentVersion - left.page.contentVersion
      ))[0];
    pageState = previous
      ? reconcileSiteTrainingContentVersion(previous, page, actorId)
      : createSiteTrainingPageProgress(page, actorId);
    pageState.page.completionCount = completionCount;
    pageState.page.everCompleted = completionCount > 0;
  }

  return normalizeSiteTrainingState({
    ...pageState,
    actorId,
    overall: program
      ? store.programs[mockSiteTrainingProgramKey(program)] || createMockSiteTrainingOverall(program)
      : null,
    claimedNow: false,
    transition: null,
  }, { expectedPage: page, expectedProgram: program });
}

function siteTrainingStaleRevisionError() {
  const error = new Error('Page training changed in another tab. Refresh and try again.');
  error.code = '40001';
  error.details = 'site_training_stale_revision';
  return error;
}

function siteTrainingRequestReuseError() {
  const error = new Error('This request ID was already used for another page training operation.');
  error.code = '23505';
  error.details = 'site_training_request_collision';
  return error;
}

function siteTrainingTargetStep(state, action) {
  const offset = action === 'back' ? -1 : action === 'next' ? 1 : 0;
  return state.page.stepIds[state.page.currentStepIndex + offset] || null;
}

function siteTrainingPageFromProgramReference(reference) {
  if (!reference?.pageId || !reference?.route || !reference?.stepIds?.length) return null;
  return {
    id: reference.pageId,
    route: reference.route,
    contentVersion: reference.contentVersion,
    steps: reference.stepIds.map((id) => ({ id })),
  };
}

function siteTrainingExpectedResponsePage(page, program, payload) {
  const responsePage = payload?.page;
  if (!program
    || (responsePage?.pageId === page.id && responsePage?.contentVersion === page.contentVersion)) {
    return page;
  }
  const reference = program.pages.find((candidate) => (
    candidate.pageId === responsePage?.pageId
    && candidate.contentVersion === responsePage?.contentVersion
  ));
  return siteTrainingPageFromProgramReference(reference) || page;
}

function normalizeSiteTrainingResult(payload, page, program, operation = null) {
  const result = normalizeSiteTrainingMutation(payload, {
    expectedPage: siteTrainingExpectedResponsePage(page, program, payload),
    expectedProgram: program,
  });
  if (operation && (
    result.transition.action !== operation.action
    || result.transition.scope !== operation.scope
  )) {
    const error = new Error('The page training response did not match the requested operation.');
    error.code = 'SITE_TRAINING_CONTRACT_INVALID';
    throw error;
  }
  return result;
}

function applyMockOverallSiteTrainingTransition(state, program, action, actorId, store) {
  const now = new Date().toISOString();
  const overall = structuredClone(state.overall);
  const pageReference = program.pages.find((candidate) => (
    candidate.pageId === state.page.pageId
    && candidate.contentVersion === state.page.contentVersion
  ));
  if (!pageReference
    || overall.currentPageId !== state.page.pageId
    || overall.currentPageContentVersion !== state.page.contentVersion) {
    throw new Error('Open the current page in this site training program before continuing.');
  }
  let next = structuredClone(state);
  let pageApplied = false;
  let overallApplied = false;
  let completedPage = null;

  if (action === 'start') {
    if (overall.status === 'not_started') overallApplied = true;
    else if (overall.status !== 'in_progress') {
      throw new Error('Use Resume for stopped training; completed training replays locally.');
    }
    if (state.page.status === 'not_started') {
      next = applySiteTrainingTransition(next, 'start', { now });
      pageApplied = next.transition.applied;
    } else if (state.page.status === 'stopped') {
      next = applySiteTrainingTransition(next, 'resume', { now });
      pageApplied = next.transition.applied;
    }
    if (overallApplied) {
      overall.status = 'in_progress';
      overall.startedAt ||= now;
      overall.stoppedAt = null;
    }
  } else if (action === 'resume') {
    if (overall.status === 'stopped') overallApplied = true;
    else if (overall.status !== 'in_progress') {
      throw new Error('Start overall training before resuming it.');
    }
    if (state.page.status === 'stopped') {
      next = applySiteTrainingTransition(next, 'resume', { now });
      pageApplied = next.transition.applied;
    }
    if (overallApplied) {
      overall.status = 'in_progress';
      overall.stoppedAt = null;
    }
  } else if (action === 'back' || action === 'next') {
    if (overall.status !== 'in_progress' || state.page.status !== 'in_progress') {
      throw new Error('Start or resume overall training before navigating it.');
    }
    next = applySiteTrainingTransition(next, action, {
      targetStepId: siteTrainingTargetStep(state, action),
      now,
    });
    pageApplied = next.transition.applied;
    overallApplied = pageApplied;
  } else if (action === 'stop') {
    if (overall.status === 'not_started') throw new Error('Start overall training before stopping it.');
    if (overall.status === 'completed') throw new Error('Completed training cannot be stopped.');
    if (overall.status === 'in_progress') overallApplied = true;
    if (state.page.status === 'in_progress') {
      next = applySiteTrainingTransition(next, 'stop', { now });
      pageApplied = next.transition.applied;
    }
    if (overallApplied) {
      overall.status = 'stopped';
      overall.stoppedAt = now;
    }
  } else if (action === 'finish') {
    if (overall.status !== 'in_progress'
      || !['in_progress', 'completed'].includes(state.page.status)) {
      throw new Error('Reach the final page training step before finishing.');
    }
    if (state.page.status === 'in_progress') {
      next = applySiteTrainingTransition(next, 'finish', { now });
      pageApplied = next.transition.applied;
    }
    overallApplied = true;
    const pageIndex = program.pages.indexOf(pageReference);
    const followingPage = program.pages[pageIndex + 1] || null;
    if (followingPage) {
      overall.status = 'in_progress';
      overall.currentPageId = followingPage.pageId;
      overall.currentPageContentVersion = followingPage.contentVersion;
      overall.currentPageIndex = pageIndex + 1;
      completedPage = next.page;
      const nextPage = siteTrainingPageFromProgramReference(followingPage);
      const nextSnapshot = nextPage
        ? mockSiteTrainingSnapshot(nextPage, null, actorId, store)
        : null;
      if (!nextSnapshot?.contractValid) {
        throw new Error('The next published site training page could not be verified.');
      }
      next.page = nextSnapshot.page;
    } else {
      overall.status = 'completed';
      overall.completedAt = now;
    }
    next.transition = {
      action,
      applied: true,
      completedPageId: state.page.pageId,
      nextRoute: followingPage?.route || null,
    };
  }

  const applied = overallApplied || pageApplied;
  if (applied) {
    overall.revision += 1;
    overall.updatedAt = now;
  }
  next.overall = overall;
  next.claimedNow = action === 'start' && applied;
  next.transition = {
    ...(next.transition || {}),
    action,
    applied,
  };
  return { state: next, completedPage };
}

function runMockSiteTrainingOperation(operation, actorId) {
  if (getMockUserId() !== actorId) throw new Error('The signed-in account changed. Try again.');
  const signature = JSON.stringify({
    scope: operation.scope,
    action: operation.action,
    pageId: operation.page.id,
    contentVersion: operation.page.contentVersion,
    programId: operation.program?.id || null,
    programVersion: operation.program?.version || null,
    expectedRevision: operation.expectedRevision,
  });
  const storedRequests = readJson(MOCK_SITE_TRAINING_REQUESTS_KEY, {});
  const requests = storedRequests && typeof storedRequests === 'object' && !Array.isArray(storedRequests)
    ? { ...storedRequests }
    : {};
  const prior = requests[operation.requestId];
  if (prior) {
    if (prior.actorId !== actorId || prior.signature !== signature) throw siteTrainingRequestReuseError();
    return normalizeSiteTrainingResult(
      prior.result,
      operation.page,
      operation.program,
      operation,
    );
  }

  const store = readMockSiteTrainingStore(actorId);
  const current = mockSiteTrainingSnapshot(operation.page, operation.program, actorId, store);
  if (!current.contractValid) {
    const error = new Error('The saved page training state could not be verified. Refresh and try again.');
    error.code = 'SITE_TRAINING_CONTRACT_INVALID';
    throw error;
  }
  const revision = operation.scope === 'overall' ? current.overall.revision : current.page.revision;
  if (revision !== operation.expectedRevision) throw siteTrainingStaleRevisionError();

  const transition = operation.scope === 'overall'
    ? applyMockOverallSiteTrainingTransition(
        current,
        operation.program,
        operation.action,
        actorId,
        store,
      )
    : {
        state: applySiteTrainingTransition(current, operation.action, {
          targetStepId: siteTrainingTargetStep(current, operation.action),
        }),
        completedPage: null,
      };
  transition.state.transition.scope = operation.scope;
  const result = normalizeSiteTrainingResult(
    transition.state,
    operation.page,
    operation.program,
    operation,
  );
  store.pages[mockSiteTrainingPageKey(operation.page)] = transition.completedPage || result.page;
  if (result.page.pageId !== operation.page.id
    || result.page.contentVersion !== operation.page.contentVersion) {
    store.pages[`${result.page.pageId}:${result.page.contentVersion}`] = result.page;
  }
  if (operation.scope === 'overall') {
    store.programs[mockSiteTrainingProgramKey(operation.program)] = result.overall;
  }
  writeMockUserValue(MOCK_SITE_TRAINING_PROGRESS_KEY, store, actorId);
  requests[operation.requestId] = { actorId, signature, result };
  writeJson(MOCK_SITE_TRAINING_REQUESTS_KEY, requests);
  return result;
}

function siteTrainingRpcParameters({ page, program = null, scope = 'page', action, requestId, expectedRevision }, actorId) {
  return {
    target_scope: scope,
    target_page_id: page.id,
    target_page_content_version: page.contentVersion,
    target_program_id: program?.id || null,
    target_program_version: program?.version || null,
    target_action: action,
    target_request_id: requestId,
    target_expected_revision: expectedRevision,
    target_expected_actor_id: actorId,
  };
}

export async function getSiteTrainingState({ page, program = null, expectedUserId } = {}) {
  const actorId = requireCapturedSiteTrainingActor(expectedUserId);
  requireSiteTrainingPage(page);
  if (program) requireSiteTrainingProgram(program, 'overall');
  if (isLocalDemoMode()) {
    if (getMockUserId() !== actorId) throw new Error('The signed-in account changed. Try again.');
    return mockSiteTrainingSnapshot(
      page,
      program,
      actorId,
      readMockSiteTrainingStore(actorId, { readOnly: true }),
    );
  }

  const client = requireSupabase();
  const user = await requireUser(actorId);
  const { data, error } = await client.rpc('get_site_training_state', {
    target_page_id: page.id,
    target_page_content_version: page.contentVersion,
    target_program_id: program?.id || null,
    target_program_version: program?.version || null,
    target_expected_actor_id: user.id,
  });
  if (error) return siteTrainingReadError(error);
  return normalizeSiteTrainingState(data, { expectedPage: page, expectedProgram: program });
}

export async function claimSiteTraining({
  page,
  program = null,
  scope = 'page',
  action = 'start',
  requestId = newSiteTrainingRequestId(),
  expectedRevision = 0,
  expectedUserId,
} = {}) {
  const actorId = requireCapturedSiteTrainingActor(expectedUserId);
  const operation = requireSiteTrainingOperation({
    page, program, scope, action, requestId, expectedRevision,
  });
  if (!SITE_TRAINING_CLAIM_ACTION_SET.has(operation.action)) {
    throw new TypeError('Start or resume page training through the claim operation.');
  }
  if (isLocalDemoMode()) return runMockSiteTrainingOperation(operation, actorId);
  const client = requireSupabase();
  const user = await requireUser(actorId);
  const { data, error } = await client.rpc(
    'claim_site_training',
    siteTrainingRpcParameters(operation, user.id),
  );
  if (error) throw error;
  return normalizeSiteTrainingResult(data, page, operation.program, operation);
}

export async function transitionSiteTraining({
  page,
  program = null,
  scope = 'page',
  action,
  requestId = newSiteTrainingRequestId(),
  expectedRevision,
  expectedUserId,
} = {}) {
  const actorId = requireCapturedSiteTrainingActor(expectedUserId);
  const operation = requireSiteTrainingOperation({
    page, program, scope, action, requestId, expectedRevision,
  });
  if (!SITE_TRAINING_TRANSITION_ACTION_SET.has(operation.action)) {
    throw new TypeError('Choose Back, Next, Stop, or Finish for active page training.');
  }
  if (isLocalDemoMode()) return runMockSiteTrainingOperation(operation, actorId);
  const client = requireSupabase();
  const user = await requireUser(actorId);
  const { data, error } = await client.rpc(
    'transition_site_training',
    siteTrainingRpcParameters(operation, user.id),
  );
  if (error) throw error;
  return normalizeSiteTrainingResult(data, page, operation.program, operation);
}

const rpcDraft = async (name, parameters, { expectedUserId = '', mutation = false } = {}) => {
  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  await bootstrapDailyStandardTimeZone(client, user.id);
  const rpcParameters = mutation
    ? { ...parameters, target_expected_actor_id: user.id }
    : parameters;
  const { data, error } = await client.rpc(name, rpcParameters);
  if (error) throw error;
  return normalizeDailyStandardDraft(data, parameters.target_entry_date);
};

export async function getDailyStandardDraft(entryDate, { expectedUserId = '' } = {}) {
  return rpcDraft(
    'get_daily_standard_draft',
    { target_entry_date: entryDate },
    { expectedUserId },
  );
}

export async function mutateDailyStandardDraft({
  date,
  actionId,
  completed,
  expectedVersion = null,
  expectedUserId = '',
}) {
  if (typeof completed !== 'boolean') {
    throw new TypeError('Daily Standard completion must be true or false.');
  }
  return rpcDraft(
    'mutate_daily_standard_draft',
    {
      target_entry_date: date,
      target_action_id: actionId,
      target_completed: completed,
      target_expected_version: expectedVersion,
    },
    { expectedUserId, mutation: true },
  );
}

export async function setDailyStandardWorkoutDifficulty({
  date,
  workoutId,
  difficulty,
  expectedVersion = null,
  expectedUserId = '',
}) {
  return rpcDraft(
    'set_daily_standard_workout_difficulty',
    {
      target_entry_date: date,
      target_workout_id: workoutId,
      target_difficulty: difficulty,
      target_expected_version: expectedVersion,
    },
    { expectedUserId, mutation: true },
  );
}

// Compatibility bridge for older completion-only callers. Legacy snapshots may
// add actions, but cannot remove an action they may simply be too stale to see.
export async function saveChallengeEntry(entry, { expectedUserId = '' } = {}) {
  const desired = new Set(normalizeDailyStandardDraft(entry).completed);
  let current = await getDailyStandardDraft(entry.date, { expectedUserId });
  for (const actionId of desired) {
    if (current.completed.includes(actionId)) continue;
    current = await mutateDailyStandardDraft({
      date: entry.date,
      actionId,
      completed: true,
      expectedVersion: current.version,
      expectedUserId,
    });
  }
  return current;
}

export async function postCheckIn(checkIn, { expectedUserId = '' } = {}) {
  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  const { data, error } = await client
    .rpc('submit_daily_check_in', {
      target_status: checkIn.status,
      target_completed: checkIn.completed || [],
      target_workout_difficulty: checkIn.workoutDifficulty || {},
      target_time_zone: checkIn.timeZone || 'UTC',
      target_expected_date: checkIn.date,
      target_expected_actor_id: user.id,
    });

  if (error) {
    if (isDuplicateCheckInError(error)) throw createCheckInAlreadyCompleteError(error);
    throw error;
  }
  const profile = readJson('dominion:user', { name: 'You' });
  return mapFeedItem({
    id: data?.id || globalThis.crypto?.randomUUID?.() || `${checkIn.date}-${Date.now()}`,
    entry_date: data?.entry_date || checkIn.date,
    display_name: profile?.name || 'You',
    challenge_day: data?.challenge_day || checkIn.day,
    status: data?.status || checkIn.status,
    completed_count: data?.completed_count || checkIn.completedCount,
    points_awarded: data?.points_awarded || 0,
    created_at: data?.created_at || new Date().toISOString(),
  });
}

export async function getCommunityFeed() {
  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client
    .from('community_feed_items')
    .select('id, display_name, challenge_day, status, completed_count, points_awarded, created_at')
    .neq('status', 'scheduled')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;
  return data.map(mapFeedItem);
}

export async function recordAppVisit({ expectedUserId = '' } = {}) {
  const client = requireSupabase();
  const user = await requireUser(expectedUserId);
  const { data, error } = await client.rpc('record_app_visit', {
    target_expected_actor_id: user.id,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return result ? {
    totalPoints: result.total_points || 0,
    currentAppStreak: result.current_app_streak || 0,
    bestAppStreak: result.best_app_streak || 0,
    newBadges: result.new_badges || [],
  } : null;
}

export async function getGameSummary() {
  const client = requireSupabase();
  const user = await requireUser();
  const [statsResult, badgesResult] = await Promise.all([
    client
      .from('user_game_stats')
      .select('total_points, challenge_points, current_app_streak, best_app_streak, current_full_day_streak, best_full_day_streak, last_seen_date, last_full_day_date')
      .eq('user_id', user.id)
      .maybeSingle(),
    client
      .from('user_badges')
      .select('badge_key, earned_at, entry_date, metadata, badge_definitions(name, description, category, tier, icon)')
      .eq('user_id', user.id)
      .order('earned_at', { ascending: false })
      .limit(12),
  ]);

  if (statsResult.error) throw statsResult.error;
  if (badgesResult.error) throw badgesResult.error;

  return {
    gameStats: mapGameStats(statsResult.data),
    badges: (badgesResult.data || []).map(mapBadge).filter(Boolean),
  };
}

export async function getEarnedBadges({ pageSize = 100 } = {}) {
  if (isLocalDemoMode()) {
    return normalizeEarnedBadges(readMockUserValue('dominion:badges', []).map(mapBadge).filter(Boolean));
  }

  const client = requireSupabase();
  const user = await requireUser();
  const normalizedPageSize = Math.floor(Math.min(Math.max(Number(pageSize) || 100, 25), 500));
  const badges = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client
      .from('user_badges')
      .select('badge_key, earned_at, entry_date, metadata, badge_definitions(name, description, category, tier, icon)')
      .eq('user_id', user.id)
      .order('earned_at', { ascending: false })
      .order('badge_key', { ascending: true })
      .range(offset, offset + normalizedPageSize - 1);
    if (error) throw error;

    const rows = data || [];
    const page = rows.map(mapBadge).filter(Boolean);
    badges.push(...page);
    if (rows.length < normalizedPageSize) break;
    offset += normalizedPageSize;
  }

  return normalizeEarnedBadges(badges);
}

async function queryLeaderboard(client, { crewId, window = 'week' } = {}) {
  if (!crewId) return [];
  const { data, error } = await client.rpc('get_crew_leaderboard', {
    target_crew_id: crewId,
    target_window: window,
  });
  if (error) throw error;
  return (data || []).map(mapLeaderboardRow);
}

export async function getLeaderboard({ crewId = null, window = 'week' } = {}) {
  if (isLocalDemoMode()) return getMockLeaderboard({ crewId, window });
  const client = requireSupabase();
  await requireUser();
  return queryLeaderboard(client, { crewId, window });
}

export async function getLeaderboardPrestige({ crewId = null, window = 'week' } = {}) {
  const rankingWindow = window === 'challenge' ? 'challenge' : 'week';
  let currentUserId;
  let crews;

  if (isLocalDemoMode()) {
    currentUserId = getMockUserId();
    crews = await getCrews();
  } else {
    const client = requireSupabase();
    const user = await requireUser();
    currentUserId = user.id;
    crews = await queryCrewsForUser(client, user.id);
  }

  const selectedCrew = crews.find((crew) => crew.id === crewId) || crews[0] || null;
  let privateRows = [];
  if (selectedCrew) {
    privateRows = isLocalDemoMode()
      ? getMockLeaderboard({ crewId: selectedCrew.id, window: rankingWindow })
      : await queryLeaderboard(requireSupabase(), {
          crewId: selectedCrew.id,
          window: rankingWindow,
        });
  }
  const rankForCurrentUser = (rows) => normalizeLeaderboardRank(
    rows.find((row) => row.userId === currentUserId)?.rank,
  );

  return {
    privateRank: rankForCurrentUser(privateRows),
    crewId: selectedCrew?.id || null,
    window: rankingWindow,
  };
}

function createMockAvatar(name, background = '#66513a') {
  const initials = String(name || 'Member')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('')
    .replace(/[^A-Z0-9]/g, '') || 'M';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${background}"/><text x="48" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#fffaf0">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function ensureMockCrews() {
  const user = getMockUser();
  const userId = getMockUserId();
  let crews = readJson(MOCK_CREWS_KEY, null);
  let members = readJson(MOCK_CREW_MEMBERS_KEY, null);

  if (!Array.isArray(crews)) {
    crews = [];
    writeJson(MOCK_CREWS_KEY, crews);
  } else {
    const retiredPreviewDescription = 'A private mock crew for testing invites, posts, comments, and leaderboards.';
    const nextCrews = crews.map((crew) => (
      crew.id === 'preview_crew_alpha' && crew.description === retiredPreviewDescription
        ? { ...crew, description: 'A private mock crew for testing invites, members, and leaderboards.' }
        : crew
    ));
    if (nextCrews.some((crew, index) => crew !== crews[index])) {
      crews = nextCrews;
      writeJson(MOCK_CREWS_KEY, crews);
    }
  }

  if (!members || typeof members !== 'object') {
    members = {};
  }

  crews.forEach((crew) => {
    if (!members[crew.id]) {
      members[crew.id] = [
        { crewId: crew.id, userId, name: user.name || 'Preview Member', avatarUrl: user.avatarUrl || '', role: 'owner', joinedAt: crew.createdAt || new Date().toISOString() },
        { crewId: crew.id, userId: 'preview_member_josh', name: 'Josh', avatarUrl: createMockAvatar('Josh', '#45634d'), role: 'member', joinedAt: crew.createdAt || new Date().toISOString() },
        { crewId: crew.id, userId: 'preview_member_sarah', name: 'Sarah', avatarUrl: createMockAvatar('Sarah', '#7a4652'), role: 'member', joinedAt: crew.createdAt || new Date().toISOString() },
      ];
    }
    members[crew.id] = members[crew.id].map((member) => ({
      ...member,
      ...(member.userId === userId
        ? { name: user.name || 'Preview Member', avatarUrl: user.avatarUrl || '' }
        : { avatarUrl: member.avatarUrl || createMockAvatar(member.name) }),
    }));
  });

  saveMockCrewMembers(members);
  return { crews: assertSingleCrew(crews), members };
}

function saveMockCrewMembers(members) {
  writeJson(
    MOCK_CREW_MEMBERS_KEY,
    prepareMockCrewMembersForStorage(members, getMockUserId()),
  );
}

function requireMockCrewTrainingAccess(crewId) {
  const userId = getMockUserId();
  const { crews } = ensureMockCrews();
  const crew = crews.find((item) => item.id === crewId);
  if (!crew
    || crew.createdBy !== userId
    || !['owner', 'admin'].includes(crew.role)) {
    throw new Error('Crew training is available only to the active crew creator.');
  }
  return { crew, userId };
}

function requireMockCrewTrainingVersion(contentVersion) {
  const version = Number(contentVersion);
  if (!Number.isInteger(version) || version !== CREW_TRAINING_VERSION) {
    throw new Error('A valid crew and training version are required.');
  }
  return version;
}

function mockCrewTrainingKey(crewId, userId, contentVersion) {
  return `${userId}:${crewId}:${contentVersion}`;
}

function clearMockCrewTraining(crewId, userId = getMockUserId()) {
  const rows = readJson(MOCK_CREW_TRAINING_KEY, {});
  const prefix = `${userId}:${crewId}:`;
  const next = Object.fromEntries(
    Object.entries(rows).filter(([key]) => !key.startsWith(prefix)),
  );
  writeJson(MOCK_CREW_TRAINING_KEY, next);
}

function getMockLeaderboard({ crewId = null } = {}) {
  const user = getMockUser();
  const stats = readMockUserValue('dominion:gameStats', {});
  const badges = readMockUserValue('dominion:badges', []);
  const rows = [
    {
      userId: getMockUserId(),
      name: user.name || 'You',
      avatarUrl: user.avatarUrl || '',
      points: stats.totalPoints || stats.challengePoints || 777,
      currentAppStreak: stats.currentAppStreak || 3,
      latestChallengeDay: 12,
      badges,
    },
    {
      userId: 'preview_member_josh',
      name: 'Josh',
      avatarUrl: createMockAvatar('Josh', '#45634d'),
      points: 690,
      currentAppStreak: 5,
      latestChallengeDay: 12,
      badges: [{ key: 'iron_standard', name: 'Iron Standard', tier: 'silver', icon: 'dumbbell' }],
    },
    {
      userId: 'preview_member_sarah',
      name: 'Sarah',
      avatarUrl: createMockAvatar('Sarah', '#7a4652'),
      points: 620,
      currentAppStreak: 4,
      latestChallengeDay: 12,
      badges: [{ key: 'faithful_start', name: 'Faithful Start', tier: 'bronze', icon: 'shield' }],
    },
  ];

  if (!crewId) return [];
  return rows
    .sort((left, right) => right.points - left.points)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function getCurrentCommunityIdentity() {
  if (isLocalDemoMode()) {
    const user = getMockUser();
    return {
      name: user.name || 'Preview Member',
      avatarUrl: user.avatarUrl || '',
    };
  }
  const user = await requireUser();
  const profile = await getProfile({ expectedUserId: user.id });
  return {
    name: profile?.name || 'Member',
    avatarUrl: profile?.avatarUrl || '',
  };
}

async function queryCrewsForUser(client, userId) {
  const { data, error } = await client
    .from('crew_members')
    .select('crew_id, role, display_name, joined_at, crews(id, name, description, challenge_start_date, created_by, created_at)')
    .eq('user_id', userId)
    .order('joined_at', { ascending: false });

  if (error) throw error;
  return assertSingleCrew((data || []).map(mapCrew).filter(Boolean));
}

export async function getCrews() {
  if (isLocalDemoMode()) return ensureMockCrews().crews;
  const client = requireSupabase();
  const user = await requireUser();
  return queryCrewsForUser(client, user.id);
}

export async function getOutboundUpdateConsent(crewId) {
  if (!crewId) throw new Error('Choose a group to review update privacy.');

  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    const user = getMockUser();
    const { members } = ensureMockCrews();
    const membershipActive = Boolean(members[crewId]?.some((member) => member.userId === userId));
    const storedByCrew = readJson(MOCK_OUTBOUND_CONSENT_KEY, {});
    const stored = storedByCrew[crewId]?.userId === userId ? storedByCrew[crewId] : {};
    return normalizeOutboundConsent(stored, {
      userId,
      crewId,
      accountActive: Boolean(user.authenticated),
      membershipActive,
    });
  }

  const client = requireSupabase();
  const user = await requireUser();
  const { data, error } = await client.rpc('get_current_outbound_consent', {
    target_user_id: user.id,
    target_crew_id: crewId,
    target_event_type: null,
  });
  if (error) throw error;
  return normalizeOutboundConsent(data, { userId: user.id, crewId });
}

export async function updateOutboundUpdateConsent(crewId, preferences) {
  if (!crewId) throw new Error('Choose a group before saving update privacy.');
  const settings = outboundConsentWritePayload(preferences);

  if (isLocalDemoMode()) {
    const userId = getMockUserId();
    const user = getMockUser();
    const { members } = ensureMockCrews();
    const membershipActive = Boolean(members[crewId]?.some((member) => member.userId === userId));
    if (!membershipActive) throw new Error('You can only change consent for a group you belong to.');

    const storedByCrew = readJson(MOCK_OUTBOUND_CONSENT_KEY, {});
    const prior = normalizeOutboundConsent(
      storedByCrew[crewId]?.userId === userId ? storedByCrew[crewId] : {},
      { userId, crewId, accountActive: Boolean(user.authenticated), membershipActive },
    );
    if (prior.consentRecorded && outboundConsentSettingsEqual(prior, settings)) return prior;

    const next = normalizeOutboundConsent({
      ...prior,
      ...settings,
      userId,
      crewId,
      accountActive: Boolean(user.authenticated),
      membershipActive,
      consentId: prior.consentId || randomId('preview_consent'),
      consentRecorded: true,
      revision: prior.revision + 1,
      changedAt: new Date().toISOString(),
      evaluatedAt: new Date().toISOString(),
    });
    storedByCrew[crewId] = next;
    writeJson(MOCK_OUTBOUND_CONSENT_KEY, storedByCrew);
    return next;
  }

  const client = requireSupabase();
  const user = await requireUser();
  const { data, error } = await client.rpc('set_outbound_update_consent', {
    target_crew_id: crewId,
    target_outbound_updates_enabled: settings.outboundUpdatesEnabled,
    target_presentation_mode: settings.presentationMode,
    target_share_check_ins: settings.events.checkIns,
    target_share_streak_milestones: settings.events.streakMilestones,
    target_share_badges_rewards: settings.events.badgesRewards,
    target_share_membership_events: settings.events.membership,
  });
  if (error) throw error;
  return normalizeOutboundConsent(data, { userId: user.id, crewId });
}

export async function getOutboundIntegrationDestinations(crewId) {
  // FOU-541 owns destination connection storage; FOU-553 owns the provider
  // apps and delivery runtime. Keeping this adapter table-free lets those
  // branches plug in without coupling consent to an unavailable schema.
  if (!crewId) return [];
  return normalizeConnectedDestinations([]);
}

export async function createCrew({
  name,
  description = '',
  challengeStartDate = null,
  requestId = newCrewLifecycleRequestId(),
}) {
  if (isLocalDemoMode()) {
    const { crews, members } = ensureMockCrews();
    if (crews.length) {
      throw new Error('Leave or delete your current crew before creating another.');
    }
    const now = new Date().toISOString();
    const crew = {
      id: randomId('preview_crew'),
      name,
      description,
      challengeStartDate: challengeStartDate || null,
      createdBy: getMockUserId(),
      createdAt: now,
      role: 'owner',
      joinedAt: now,
    };
    crews.unshift(crew);
    members[crew.id] = [{
      crewId: crew.id,
      userId: getMockUserId(),
      name: getMockUser().name || 'Preview Member',
      avatarUrl: getMockUser().avatarUrl || '',
      role: 'owner',
      joinedAt: now,
    }];
    writeJson(MOCK_CREWS_KEY, crews);
    saveMockCrewMembers(members);
    return { ...crew, createdNew: true };
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('create_crew', {
    target_request_id: requestId,
    target_name: name,
    target_description: description,
    target_challenge_start_date: challengeStartDate || null,
  }).single();
  if (error) throw error;
  return {
    ...mapCrew({ ...data, id: data?.crew_id }),
    createdNew: Boolean(data?.created_new),
  };
}

function defaultCrewTrainingProgress(crewId, userId, contentVersion) {
  return normalizeCrewTrainingProgress({
    crewId,
    userId,
    contentVersion,
    status: 'not_started',
    currentStep: 0,
    furthestStep: 0,
    stepCount: CREW_TRAINING_STEP_COUNT,
  });
}

function normalizeCrewTrainingResponse(value) {
  const progress = normalizeCrewTrainingProgress(value);
  return {
    ...progress,
    ...(value && ('claimedNow' in value || 'claimed_now' in value)
      ? { claimedNow: Boolean(value.claimedNow ?? value.claimed_now) }
      : {}),
  };
}

export async function getCrewTrainingProgress(
  crewId,
  contentVersion = CREW_TRAINING_VERSION,
) {
  if (isLocalDemoMode()) {
    contentVersion = requireMockCrewTrainingVersion(contentVersion);
    const { userId } = requireMockCrewTrainingAccess(crewId);
    const rows = readJson(MOCK_CREW_TRAINING_KEY, {});
    return normalizeCrewTrainingResponse(
      rows[mockCrewTrainingKey(crewId, userId, contentVersion)]
        || defaultCrewTrainingProgress(crewId, userId, contentVersion),
    );
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('get_crew_training_progress', {
    target_crew_id: crewId,
    target_content_version: contentVersion,
  });
  if (error) throw error;
  return data ? normalizeCrewTrainingResponse(data) : null;
}

export async function claimCrewTraining(
  crewId,
  contentVersion = CREW_TRAINING_VERSION,
) {
  if (isLocalDemoMode()) {
    contentVersion = requireMockCrewTrainingVersion(contentVersion);
    const { userId } = requireMockCrewTrainingAccess(crewId);
    const rows = readJson(MOCK_CREW_TRAINING_KEY, {});
    const key = mockCrewTrainingKey(crewId, userId, contentVersion);
    const existing = normalizeCrewTrainingResponse(
      rows[key] || defaultCrewTrainingProgress(crewId, userId, contentVersion),
    );
    const claimedNow = existing.status === 'not_started';
    if (claimedNow) {
      const now = new Date().toISOString();
      rows[key] = {
        ...existing,
        status: 'in_progress',
        startedAt: existing.startedAt || now,
        updatedAt: now,
      };
      writeJson(MOCK_CREW_TRAINING_KEY, rows);
    }
    return { ...normalizeCrewTrainingResponse(rows[key] || existing), claimedNow };
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('claim_crew_training', {
    target_crew_id: crewId,
    target_content_version: contentVersion,
  });
  if (error) throw error;
  return normalizeCrewTrainingResponse(data);
}

export async function advanceCrewTraining({
  crewId,
  contentVersion = CREW_TRAINING_VERSION,
  action,
  targetStep = 0,
}) {
  if (isLocalDemoMode()) {
    contentVersion = requireMockCrewTrainingVersion(contentVersion);
    const { userId } = requireMockCrewTrainingAccess(crewId);
    const rows = readJson(MOCK_CREW_TRAINING_KEY, {});
    const key = mockCrewTrainingKey(crewId, userId, contentVersion);
    if (!rows[key]) throw new Error('Start crew training before updating its progress.');
    const existing = normalizeCrewTrainingResponse(rows[key]);
    if (existing.status === 'completed') return existing;

    const normalizedAction = String(action || '').trim().toLowerCase();
    const step = Number(targetStep);
    if (!Number.isInteger(step) || step < 0 || step >= CREW_TRAINING_STEP_COUNT) {
      throw new Error('A valid crew, training version, and step are required.');
    }
    const now = new Date().toISOString();
    const next = { ...existing };

    if (normalizedAction === 'advance') {
      if (existing.status !== 'in_progress') throw new Error('Resume crew training before advancing.');
      if (step > existing.furthestStep + 1) {
        throw new Error('Crew training steps must be completed in order.');
      }
      if (step <= existing.furthestStep) return existing;
      next.currentStep = step;
      next.furthestStep = step;
    } else if (normalizedAction === 'skip') {
      if (existing.status !== 'in_progress' && existing.status !== 'skipped') {
        throw new Error('Start crew training before skipping it.');
      }
      if (step > existing.furthestStep) {
        throw new Error('Only the current crew training step can be skipped.');
      }
      if (step < existing.currentStep || existing.status === 'skipped') return existing;
      next.status = 'skipped';
      next.skippedAt ||= now;
    } else if (normalizedAction === 'resume') {
      if (!['skipped', 'in_progress'].includes(existing.status)) {
        throw new Error('This crew training cannot be resumed.');
      }
      if (step > existing.furthestStep) {
        throw new Error('Crew training cannot resume beyond saved progress.');
      }
      if (existing.status === 'in_progress') return existing;
      next.status = 'in_progress';
      next.currentStep = existing.furthestStep;
    } else if (normalizedAction === 'complete') {
      if (!['in_progress', 'skipped'].includes(existing.status)
        || step !== CREW_TRAINING_STEP_COUNT - 1
        || existing.currentStep !== CREW_TRAINING_STEP_COUNT - 1
        || existing.furthestStep !== CREW_TRAINING_STEP_COUNT - 1) {
        throw new Error('Finish the final crew training step before completing it.');
      }
      next.status = 'completed';
      next.currentStep = step;
      next.furthestStep = step;
      next.completedAt = existing.completedAt || now;
    } else {
      throw new Error('Unsupported crew training action.');
    }

    next.updatedAt = now;
    rows[key] = next;
    writeJson(MOCK_CREW_TRAINING_KEY, rows);
    return normalizeCrewTrainingResponse(next);
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('advance_crew_training', {
    target_crew_id: crewId,
    target_content_version: contentVersion,
    target_action: action,
    target_step: targetStep,
  });
  if (error) throw error;
  return normalizeCrewTrainingResponse(data);
}

export async function deleteCrew({ crewId, requestId = newCrewLifecycleRequestId() }) {
  if (isLocalDemoMode()) {
    const { crews, members } = ensureMockCrews();
    const crew = crews.find((item) => item.id === crewId);
    if (!crew || !['owner', 'admin'].includes(crew.role)) {
      throw new Error('Only a crew owner or admin can delete this crew.');
    }
    writeJson(MOCK_CREWS_KEY, crews.filter((item) => item.id !== crewId));
    delete members[crewId];
    saveMockCrewMembers(members);
    const invites = readJson(MOCK_INVITES_KEY, {});
    Object.values(invites).forEach((invite) => {
      if (invite.crew_id === crewId && !invite.revoked_at) invite.revoked_at = new Date().toISOString();
    });
    writeJson(MOCK_INVITES_KEY, invites);
    clearMockCrewTraining(crewId);
    return { status: 'deleted', crewId, requestId };
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('delete_crew', {
    target_crew_id: crewId,
    target_request_id: requestId,
  });
  if (error) throw error;
  return data;
}

export async function leaveCrew({ crewId, requestId = newCrewLifecycleRequestId() }) {
  if (isLocalDemoMode()) {
    const { crews, members } = ensureMockCrews();
    const crew = crews.find((item) => item.id === crewId);
    if (!crew || ['owner', 'admin'].includes(crew.role)) {
      throw new Error('Crew owners and admins must delete the crew instead of leaving it.');
    }
    writeJson(MOCK_CREWS_KEY, crews.filter((item) => item.id !== crewId));
    members[crewId] = (members[crewId] || []).filter((item) => item.userId !== getMockUserId());
    saveMockCrewMembers(members);
    clearMockCrewTraining(crewId);
    return { status: 'left', crewId, requestId };
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('leave_crew', {
    target_crew_id: crewId,
    target_request_id: requestId,
  });
  if (error) throw error;
  return data;
}

export async function getCrewMembers(crewId) {
  if (isLocalDemoMode()) {
    const { members } = ensureMockCrews();
    return members[crewId] || [];
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('get_crew_members_with_profiles', {
    target_crew_id: crewId,
  });

  if (error) throw error;
  return (data || []).map((member) => ({
    crewId: member.crew_id,
    userId: member.user_id,
    name: member.display_name || 'Member',
    avatarUrl: canonicalProfilePhotoUrl(
      member.avatar_url,
      member.user_id,
      SUPABASE_ORIGIN,
      PROFILE_PHOTO_BUCKET,
    ),
    role: member.role,
    joinedAt: member.joined_at,
  }));
}

export async function getOrCreateCrewInvite(crewId, { expectedUserId = '' } = {}) {
  if (isLocalDemoMode()) {
    const { crews, members } = ensureMockCrews();
    const crew = crews.find((item) => item.id === crewId);
    const currentUserId = getMockUserId();
    if (expectedUserId && currentUserId !== expectedUserId) {
      throw new Error('The signed-in account changed. Try again.');
    }
    const canManage = crew && (crew.createdBy === currentUserId || (members[crewId] || []).some((member) => member.userId === currentUserId && ['owner', 'admin'].includes(member.role)));
    if (!canManage) throw new Error('Only a private-group admin can create an invitation.');

    const invites = readJson(MOCK_INVITES_KEY, {});
    const previous = invites[crewId];
    if (previous && Date.now() - new Date(previous.created_at).getTime() < 5000) {
      throw new Error('Wait a few seconds before rotating this invitation.');
    }
    if (previous && !previous.revoked_at) previous.revoked_at = new Date().toISOString();

    const token = randomSecret();
    const invite = {
      id: randomId('preview_invite'),
      crew_id: crewId,
      token_hash: await sha256Hex(token),
      token_hint: token.slice(-6),
      created_by: currentUserId,
      expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
      revoked_at: null,
      redeemed_by: null,
      redeemed_at: null,
      created_at: new Date().toISOString(),
    };
    invites[crewId] = invite;
    writeJson(MOCK_INVITES_KEY, invites);
    return { ...invite, token };
  }

  const client = requireSupabase();
  await requireUser(expectedUserId);
  const { data, error } = await client.rpc('issue_crew_invite', { target_crew_id: crewId });
  if (error) throw error;
  if (data?.status !== 'issued' || !data?.token) {
    throw new Error(data?.status === 'rate_limited'
      ? 'Wait a few minutes before rotating another invitation.'
      : 'Unable to create an invitation right now.');
  }
  return {
    id: data.inviteId,
    crew_id: crewId,
    token: data.token,
    token_hint: data.tokenHint,
    expires_at: data.expiresAt,
  };
}

function mockInvitePreview(invite, crew, members) {
  const inviter = (members[crew.id] || []).find((member) => member.userId === invite.created_by);
  return {
    groupName: crew.name || 'Private group',
    inviterName: String(inviter?.name || 'Dominion member').trim().split(/\s+/)[0],
    expiresAt: invite.expires_at,
  };
}

function mockInviteStatus(invite, crew, members, currentUserId = '') {
  if (!invite || !crew) return 'invalid';
  if (invite.revoked_at) return 'revoked';
  if (new Date(invite.expires_at).getTime() <= Date.now()) return 'expired';
  const crewMembers = members[crew.id] || [];
  if (currentUserId && crewMembers.some((member) => member.userId === currentUserId)) return 'already_member';
  if (invite.redeemed_by) return 'already_used';
  if (crewMembers.length >= Number(crew.memberLimit || 50)) return 'full';
  if (currentUserId && Object.entries(members).some(([crewId, crewRoster]) => (
    crewId !== crew.id && crewRoster.some((member) => member.userId === currentUserId)
  ))) return 'current_crew_conflict';
  return 'ready';
}

export async function previewCrewInvite({ token = '', continuationToken = '' } = {}) {
  if (isLocalDemoMode()) {
    const crews = readJson(MOCK_CREWS_KEY, []);
    const members = readJson(MOCK_CREW_MEMBERS_KEY, {});
    const invites = readJson(MOCK_INVITES_KEY, {});
    const sessions = readJson(MOCK_INVITE_SESSIONS_KEY, {});
    const mockUser = readJson('dominion:user', null);
    const currentUserId = mockUser?.authenticated ? getMockUserId() : '';
    let continuation = continuationToken;
    let session = null;
    let invite = null;

    if (token) {
      const tokenHash = await sha256Hex(token);
      invite = Object.values(invites).find((item) => item.token_hash === tokenHash || item.token === token) || null;
      if (invite) {
        continuation = randomSecret();
        session = {
          id: randomId('preview_invite_session'),
          invite_id: invite.id,
          continuation_hash: await sha256Hex(continuation),
          bound_user_id: currentUserId || null,
          expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          confirmation_attempts: 0,
          confirmed_at: null,
        };
        sessions[session.id] = session;
        writeJson(MOCK_INVITE_SESSIONS_KEY, sessions);
      }
    } else if (continuation) {
      const continuationHash = await sha256Hex(continuation);
      session = Object.values(sessions).find((item) => item.continuation_hash === continuationHash) || null;
      if (!session) return { status: 'invalid' };
      if (new Date(session.expires_at).getTime() <= Date.now()) return { status: 'session_expired' };
      if (currentUserId && session.bound_user_id && session.bound_user_id !== currentUserId) return { status: 'wrong_account' };
      if (currentUserId && !session.bound_user_id) {
        session.bound_user_id = currentUserId;
        writeJson(MOCK_INVITE_SESSIONS_KEY, sessions);
      }
      invite = Object.values(invites).find((item) => item.id === session.invite_id) || null;
    }

    const crew = crews.find((item) => item.id === invite?.crew_id);
    const status = mockInviteStatus(invite, crew, members, currentUserId);
    const response = { status };
    if (['ready', 'already_member', 'current_crew_conflict'].includes(status)) {
      response.preview = mockInvitePreview(invite, crew, members);
    }
    if (token && continuation && ['ready', 'full'].includes(status)) response.continuationToken = continuation;
    return response;
  }

  const client = requireSupabase();
  const { data, error } = await client.rpc('preview_crew_invite', {
    invite_token: token || null,
    continuation_token: continuationToken || null,
  });
  if (error) throw error;
  return data || { status: 'invalid' };
}

export async function confirmCrewInvite(continuationToken) {
  if (isLocalDemoMode()) {
    const mockUser = readJson('dominion:user', null);
    if (!mockUser?.authenticated) return { status: 'authentication_required' };
    const billing = getMockBillingState();
    if (!billing.appAccess) return { status: 'subscription_required' };

    const sessions = readJson(MOCK_INVITE_SESSIONS_KEY, {});
    const sessionHash = await sha256Hex(continuationToken);
    const session = Object.values(sessions).find((item) => item.continuation_hash === sessionHash) || null;
    if (!session) return { status: 'invalid' };
    if (new Date(session.expires_at).getTime() <= Date.now()) return { status: 'session_expired' };
    const currentUserId = getMockUserId();
    if (session.bound_user_id && session.bound_user_id !== currentUserId) return { status: 'wrong_account' };
    session.bound_user_id = currentUserId;
    session.confirmation_attempts = Number(session.confirmation_attempts || 0) + 1;
    if (session.confirmation_attempts > 5) return { status: 'rate_limited' };

    const invites = readJson(MOCK_INVITES_KEY, {});
    const invite = Object.values(invites).find((item) => item.id === session.invite_id) || null;
    const { crews, members } = ensureMockCrews();
    const crew = crews.find((item) => item.id === invite?.crew_id);
    const status = mockInviteStatus(invite, crew, members, currentUserId);
    if (status !== 'ready') {
      writeJson(MOCK_INVITE_SESSIONS_KEY, sessions);
      return {
        status,
        ...(['already_member', 'current_crew_conflict'].includes(status)
          ? { preview: mockInvitePreview(invite, crew, members) }
          : {}),
      };
    }

    const crewMembers = members[crew.id] || [];
    crewMembers.push({
      crewId: crew.id,
      userId: currentUserId,
      name: mockUser.name || 'Preview Member',
      avatarUrl: mockUser.avatarUrl || '',
      role: 'member',
      joinedAt: new Date().toISOString(),
    });
    members[crew.id] = crewMembers;
    saveMockCrewMembers(members);

    const attributions = readJson(MOCK_INVITE_ATTRIBUTIONS_KEY, {});
    const redemptionId = randomId('preview_invite_redemption');
    attributions[redemptionId] = {
      id: redemptionId,
      invite_id: invite.id,
      crew_id: crew.id,
      inviter_user_id: invite.created_by,
      recipient_user_id: currentUserId,
      created_at: new Date().toISOString(),
    };
    writeJson(MOCK_INVITE_ATTRIBUTIONS_KEY, attributions);

    invite.redeemed_by = currentUserId;
    invite.redeemed_at = new Date().toISOString();
    session.confirmed_at = new Date().toISOString();
    writeJson(MOCK_INVITES_KEY, invites);
    writeJson(MOCK_INVITE_SESSIONS_KEY, sessions);
    return {
      status: 'joined',
      crewId: crew.id,
      redemptionId,
      preview: mockInvitePreview(invite, crew, members),
    };
  }

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('confirm_crew_invite', {
    continuation_token: continuationToken,
  });
  if (error) throw error;
  return data || { status: 'invalid' };
}

export async function getJournalEntries() {
  if (isLocalDemoMode()) {
    const entries = sortJournalEntries(readJson(MOCK_JOURNAL_KEY, []).map(normalizeJournalEntry));
    writeJson(MOCK_JOURNAL_KEY, entries);
    return entries;
  }

  const client = requireSupabase();
  await requireUser();
  const { data: entries, error } = await client
    .from('journal_entries')
    .select('id, user_id, entry_date, challenge_day, note, win, prayer, mood, energy, created_at, updated_at')
    .order('entry_date', { ascending: false })
    .limit(30);

  if (error) throw error;
  return (entries || []).map(normalizeJournalEntry);
}

export async function saveJournalEntry(entry) {
  if (isLocalDemoMode()) {
    const entries = readJson(MOCK_JOURNAL_KEY, []).map(normalizeJournalEntry);
    const existingIndex = entries.findIndex((item) => item.date === entry.date);
    const existing = existingIndex >= 0 ? entries[existingIndex] : {};
    const now = new Date().toISOString();
    const nextEntry = {
      id: existing.id || randomId('preview_journal'),
      date: entry.date,
      day: entry.day || null,
      note: entry.note || '',
      win: entry.win || '',
      prayer: entry.prayer || '',
      mood: entry.mood || '',
      energy: entry.energy || '',
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    if (existingIndex >= 0) entries[existingIndex] = nextEntry;
    else entries.unshift(nextEntry);
    writeJson(MOCK_JOURNAL_KEY, sortJournalEntries(entries));
    return nextEntry;
  }

  const client = requireSupabase();
  const user = await requireUser();
  const { data, error } = await client
    .from('journal_entries')
    .upsert({
      user_id: user.id,
      entry_date: entry.date,
      challenge_day: entry.day || null,
      note: entry.note || '',
      win: entry.win || '',
      prayer: entry.prayer || '',
      mood: entry.mood || '',
      energy: entry.energy || '',
    }, { onConflict: 'user_id,entry_date' })
    .select('id, user_id, entry_date, challenge_day, note, win, prayer, mood, energy, created_at, updated_at')
    .single();

  if (error) throw error;
  return normalizeJournalEntry(data);
}
