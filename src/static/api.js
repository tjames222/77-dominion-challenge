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
} from './check-in.mjs';
import {
  prepareMockCrewMembersForStorage,
} from './mock-community-storage.mjs';
import { normalizeLeaderboardRank } from './leaderboard-prestige.mjs';
import {
  normalizeConnectedDestinations,
  normalizeOutboundConsent,
  outboundConsentSettingsEqual,
  outboundConsentWritePayload,
} from './integration-consent.mjs';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
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
const MOCK_SUBSCRIPTION_KEY = 'dominion:mockSubscription';
const MOCK_CREWS_KEY = 'dominion:mockCrews';
const MOCK_CREW_MEMBERS_KEY = 'dominion:mockCrewMembers';
const MOCK_INVITES_KEY = 'dominion:mockCrewInvites';
const MOCK_JOURNAL_KEY = 'dominion:mockJournalEntries';
const MOCK_CHALLENGE_STATES_KEY = 'dominion:mockChallengeStates';
const MOCK_CHALLENGE_THRESHOLDS_VERSION_KEY = 'dominion:mockChallengeThresholdsVersion';
const MOCK_OUTBOUND_CONSENT_KEY = 'dominion:mockOutboundConsent';
const MOCK_CHALLENGE_THRESHOLDS_VERSION = 2;

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const randomId = (prefix) => `${prefix}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`;

const getMockUserId = () => {
  let userId = localStorage.getItem(MOCK_USER_ID_KEY);
  if (!userId) {
    userId = randomId('mock_user');
    localStorage.setItem(MOCK_USER_ID_KEY, userId);
  }
  return userId;
};

const getMockUser = () => readJson('dominion:user', {
  name: 'Preview Member',
  email: 'preview@77dominion.test',
  avatarUrl: '',
  authenticated: true,
});

const getMockSubscription = () => readJson(MOCK_SUBSCRIPTION_KEY, null);

const getMockBillingState = () => {
  const user = readJson('dominion:user', null);
  const subscription = getMockSubscription();
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

const requireUser = async () => {
  const client = requireSupabase();
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('You need to log in again.');
  return data.user;
};

export function sessionToUser(session, fallbackName = 'Member') {
  const user = session?.user || {};
  const metadata = user.user_metadata || {};
  const email = user.email || '';
  const name = metadata.name || metadata.full_name || fallbackName || email.split('@')[0] || 'Member';
  const avatarUrl = metadata.avatar_url || metadata.picture || '';
  return { name, email, avatarUrl, authenticated: Boolean(session?.access_token) };
}

export const hasSupabaseAuth = () => Boolean(supabase) && !isLocalDemoMode();

export async function getAuthSession() {
  if (!supabase || isLocalDemoMode()) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
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
    return `./${path}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

export async function clearAuthSession() {
  if (supabase) await supabase.auth.signOut();
  localStorage.removeItem('dominion:user');
  localStorage.removeItem(MOCK_SUBSCRIPTION_KEY);
}

export function saveLocalUserFromSession(session, fallbackName) {
  const user = sessionToUser(session, fallbackName);
  localStorage.setItem('dominion:user', JSON.stringify(user));
  if (user.name) localStorage.setItem('dominion:memberName', JSON.stringify(user.name));
  return user;
}

export async function getLocalOrSessionUser() {
  if (isLocalDemoMode()) return readJson('dominion:user', null);
  const session = await getAuthSession();
  if (session?.user) return sessionToUser(session);
  return null;
}

export async function upsertProfile({ name, email, avatarUrl, challengeStartDate } = {}) {
  const client = requireSupabase();
  const user = await requireUser();
  const metadata = user.user_metadata || {};
  const displayName = name || metadata.name || metadata.full_name || user.email?.split('@')[0] || 'Member';

  const payload = {
    user_id: user.id,
    name: displayName,
    email: email || user.email || '',
  };
  if (avatarUrl !== undefined) payload.avatar_url = avatarUrl || '';
  if (challengeStartDate !== undefined) payload.challenge_start_date = challengeStartDate || null;

  const { data, error } = await client
    .from('profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select('user_id, name, email, avatar_url, challenge_start_date, time_zone, created_at, updated_at')
    .single();

  if (error) throw error;
  return mapProfile(data);
}

export async function signUpWithPassword({ name, email, password }) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw error;
  if (data.session?.access_token) await upsertProfile({ name });

  return { session: data.session, user: data.user };
}

export async function signInWithPassword({ email, password }) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  if (data.session?.access_token) await upsertProfile();

  return { session: data.session, user: data.user };
}

const mapProfile = (profile) => profile ? ({
  userId: profile.user_id,
  name: profile.name,
  email: profile.email,
  avatarUrl: profile.avatar_url || '',
  challengeStartDate: profile.challenge_start_date,
  timeZone: profile.time_zone || '',
  createdAt: profile.created_at,
  updatedAt: profile.updated_at,
}) : null;

const mapEntry = (entry) => ({
  date: entry.entry_date,
  completed: Array.isArray(entry.completed) ? entry.completed : [],
  scheduledMiss: Boolean(entry.scheduled_miss),
  updatedAt: entry.updated_at,
});

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

const queryWorkoutDifficultyPointValues = async (client) => {
  const { data, error } = await client
    .from('workout_difficulty_point_values')
    .select('difficulty, points')
    .order('points', { ascending: true });
  if (error) throw error;
  return Object.fromEntries((data || []).map((item) => [item.difficulty, item.points]));
};

const mapLeaderboardRow = (row) => ({
  rank: row.rank_position || row.rank || 0,
  userId: row.user_id || row.userId,
  name: row.display_name || row.name || 'Member',
  avatarUrl: row.avatar_url || row.avatarUrl || '',
  points: row.points || 0,
  currentAppStreak: row.current_app_streak || row.currentAppStreak || 0,
  latestChallengeDay: row.latest_challenge_day || row.latestChallengeDay || 0,
  badges: Array.isArray(row.badges) ? row.badges.map(mapBadge).filter(Boolean) : [],
});

const mapJournalEntry = (entry, photos = []) => ({
  id: entry.id,
  date: entry.entry_date,
  day: entry.challenge_day,
  note: entry.note || '',
  win: entry.win || '',
  prayer: entry.prayer || '',
  mood: entry.mood || '',
  energy: entry.energy || '',
  createdAt: entry.created_at,
  updatedAt: entry.updated_at,
  photos,
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

export async function getProfile() {
  const client = requireSupabase();
  const user = await requireUser();
  const { data, error } = await client
    .from('profiles')
    .select('user_id, name, email, avatar_url, challenge_start_date, time_zone, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;
  return data ? mapProfile(data) : upsertProfile();
}

export async function updateProfile(profile) {
  if (isLocalDemoMode()) {
    const existing = getMockUser();
    const nextUser = {
      ...existing,
      name: profile.name || existing.name || 'Member',
      email: profile.email || existing.email || '',
      avatarUrl: profile.avatarUrl ?? existing.avatarUrl ?? '',
      authenticated: true,
    };
    writeJson('dominion:user', nextUser);
    if (nextUser.name) writeJson('dominion:memberName', nextUser.name);
    return nextUser;
  }

  const client = requireSupabase();
  const user = await requireUser();
  const metadata = user.user_metadata || {};
  const authUpdates = {};
  const dataUpdates = {};
  const nextName = profile.name || metadata.name || metadata.full_name || user.email?.split('@')[0] || 'Member';
  const nextEmail = profile.email || user.email || '';

  if (profile.name !== undefined) {
    dataUpdates.name = nextName;
    dataUpdates.full_name = nextName;
  }
  if (profile.avatarUrl !== undefined) {
    dataUpdates.avatar_url = profile.avatarUrl || '';
    dataUpdates.picture = profile.avatarUrl || '';
  }
  if (Object.keys(dataUpdates).length) authUpdates.data = dataUpdates;
  if (profile.email && profile.email !== user.email) authUpdates.email = profile.email;

  let emailChangeRequested = false;
  if (Object.keys(authUpdates).length) {
    const { data, error } = await client.auth.updateUser(authUpdates);
    if (error) throw error;
    emailChangeRequested = Boolean(profile.email && profile.email !== user.email && data?.user?.email !== profile.email);
  }

  const savedProfile = await upsertProfile({
    name: nextName,
    email: nextEmail,
    avatarUrl: profile.avatarUrl,
    challengeStartDate: profile.challengeStartDate,
  });

  return {
    ...savedProfile,
    emailChangeRequested,
  };
}

export async function uploadProfilePhoto(file) {
  if (!file) throw new Error('Choose a profile picture first.');
  if (!file.type?.startsWith('image/')) throw new Error('Profile picture must be an image file.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Profile picture must be smaller than 5 MB.');

  if (isLocalDemoMode()) return fileToDataUrl(file);

  const client = requireSupabase();
  const user = await requireUser();
  const extensionFromType = file.type.split('/')[1]?.replace('jpeg', 'jpg') || '';
  const extensionFromName = file.name?.split('.').pop()?.toLowerCase() || '';
  const extension = extensionFromType || extensionFromName || 'jpg';
  const safeExtension = ['jpg', 'png', 'webp', 'heic', 'heif'].includes(extension) ? extension : 'jpg';
  const storagePath = `${user.id}/avatar-${Date.now()}.${safeExtension}`;
  const { error } = await client.storage
    .from(PROFILE_PHOTO_BUCKET)
    .upload(storagePath, file, { cacheControl: '3600', upsert: true });

  if (error) throw error;

  const { data } = client.storage
    .from(PROFILE_PHOTO_BUCKET)
    .getPublicUrl(storagePath);

  return data?.publicUrl || '';
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
    writeJson(MOCK_SUBSCRIPTION_KEY, subscription);
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
    localStorage.removeItem(MOCK_SUBSCRIPTION_KEY);
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

function getMockChallengeProgression() {
  const gameStats = readJson('dominion:gameStats', {});
  let records = readJson(MOCK_CHALLENGE_STATES_KEY, []);
  const thresholdVersion = Number(localStorage.getItem(MOCK_CHALLENGE_THRESHOLDS_VERSION_KEY) || 0);
  if (!Number.isFinite(thresholdVersion) || thresholdVersion < MOCK_CHALLENGE_THRESHOLDS_VERSION) {
    const previousDefinitions = DEFAULT_CHALLENGE_DEFINITIONS.map((definition) => ({
      ...definition,
      pointsRequired: definition.pointsRequired / 2,
    }));
    records = migrateChallengeUnlockRecords({
      previousDefinitions,
      records: Array.isArray(records) ? records : [],
      totalPoints: gameStats.totalPoints ?? gameStats.challengePoints ?? 0,
    });
    writeJson(MOCK_CHALLENGE_STATES_KEY, records);
    localStorage.setItem(MOCK_CHALLENGE_THRESHOLDS_VERSION_KEY, String(MOCK_CHALLENGE_THRESHOLDS_VERSION));
  }
  const progression = buildChallengeProgression({
    definitions: DEFAULT_CHALLENGE_DEFINITIONS,
    records: Array.isArray(records) ? records : [],
    totalPoints: gameStats.totalPoints ?? gameStats.challengePoints ?? 0,
  });
  writeJson(MOCK_CHALLENGE_STATES_KEY, progression.records);
  return progression;
}

export async function getChallengeProgression() {
  if (isLocalDemoMode()) return getMockChallengeProgression();

  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('get_challenge_progression');
  if (error) throw error;
  return normalizeChallengeProgression(data || {});
}

export async function claimChallengeUnlocks() {
  if (isLocalDemoMode()) {
    const progression = getMockChallengeProgression();
    const claimedKeys = progression.unseenUnlocks.map((challenge) => challenge.key);
    const claimedKeySet = new Set(claimedKeys);
    const records = progression.records.map((item) => (
      claimedKeySet.has(item.key) ? acknowledgeChallengeRecord(item) : item
    ));
    writeJson(MOCK_CHALLENGE_STATES_KEY, records);
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
  await requireUser();
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
    writeJson(MOCK_CHALLENGE_STATES_KEY, records);
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
  const [profile, entriesResult, checkInsResult, feedResult, statsResult, badgesResult, workoutDifficultyPointValues] = await Promise.all([
    getProfile(),
    client
      .from('challenge_entries')
      .select('entry_date, completed, scheduled_miss, updated_at')
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
      .order('created_at', { ascending: false })
      .limit(30),
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
    queryWorkoutDifficultyPointValues(client).catch((error) => {
      console.warn('Using default workout difficulty points', error);
      return null;
    }),
  ]);

  if (entriesResult.error) throw entriesResult.error;
  if (checkInsResult.error) throw checkInsResult.error;
  if (feedResult.error) throw feedResult.error;
  if (statsResult.error) throw statsResult.error;
  if (badgesResult.error) throw badgesResult.error;

  return {
    profile,
    entries: entriesResult.data.map(mapEntry),
    checkIns: (checkInsResult.data || []).map((checkIn) => ({
      date: checkIn.entry_date,
      challengeDay: checkIn.challenge_day,
    })),
    feed: feedResult.data.map(mapFeedItem),
    gameStats: mapGameStats(statsResult.data),
    badges: (badgesResult.data || []).map(mapBadge).filter(Boolean),
    workoutDifficultyPointValues,
  };
}

export async function getWorkoutDifficultyPointValues() {
  const client = requireSupabase();
  await requireUser();
  return queryWorkoutDifficultyPointValues(client);
}

export async function saveChallengeEntry(entry) {
  const client = requireSupabase();
  const user = await requireUser();
  const { data, error } = await client
    .from('challenge_entries')
    .upsert({
      user_id: user.id,
      entry_date: entry.date,
      completed: entry.completed || [],
      scheduled_miss: Boolean(entry.scheduledMiss),
    }, { onConflict: 'user_id,entry_date' })
    .select('entry_date, completed, scheduled_miss, updated_at')
    .single();

  if (error) throw error;
  return mapEntry(data);
}

export async function postCheckIn(checkIn) {
  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client
    .rpc('submit_daily_check_in', {
      target_status: checkIn.status,
      target_completed: checkIn.completed || [],
      target_workout_difficulty: checkIn.workoutDifficulty || {},
      target_time_zone: checkIn.timeZone || 'UTC',
      target_expected_date: checkIn.date,
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
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;
  return data.map(mapFeedItem);
}

export async function recordAppVisit() {
  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client.rpc('record_app_visit');
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
    const createdAt = new Date().toISOString();
    crews = [{
      id: 'preview_crew_alpha',
      name: 'Preview Crew',
      description: 'A private mock crew for testing invites, posts, comments, and leaderboards.',
      challengeStartDate: new Date().toISOString().slice(0, 10),
      createdBy: userId,
      createdAt,
      role: 'owner',
      joinedAt: createdAt,
    }];
    writeJson(MOCK_CREWS_KEY, crews);
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
  return { crews, members };
}

function saveMockCrewMembers(members) {
  writeJson(
    MOCK_CREW_MEMBERS_KEY,
    prepareMockCrewMembersForStorage(members, getMockUserId()),
  );
}

function getMockLeaderboard({ crewId = null } = {}) {
  const user = getMockUser();
  const stats = readJson('dominion:gameStats', {});
  const badges = readJson('dominion:badges', []);
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
  const profile = await getProfile();
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
  return (data || []).map(mapCrew).filter(Boolean);
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

export async function createCrew({ name, description = '', challengeStartDate = null }) {
  if (isLocalDemoMode()) {
    const { crews, members } = ensureMockCrews();
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
    return crew;
  }

  const client = requireSupabase();
  const user = await requireUser();
  const identity = await getCurrentCommunityIdentity();
  const { data: crew, error: crewError } = await client
    .from('crews')
    .insert({
      name,
      description,
      challenge_start_date: challengeStartDate || null,
      created_by: user.id,
    })
    .select('id, name, description, challenge_start_date, created_by, created_at')
    .single();

  if (crewError) throw crewError;

  const { error: memberError } = await client
    .from('crew_members')
    .insert({
      crew_id: crew.id,
      user_id: user.id,
      display_name: identity.name,
      avatar_url: identity.avatarUrl,
      role: 'owner',
    });

  if (memberError) throw memberError;
  return mapCrew({ ...crew, role: 'owner' });
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
    avatarUrl: member.avatar_url || '',
    role: member.role,
    joinedAt: member.joined_at,
  }));
}

export async function getOrCreateCrewInvite(crewId) {
  if (isLocalDemoMode()) {
    const invites = readJson(MOCK_INVITES_KEY, {});
    if (!invites[crewId]) {
      invites[crewId] = {
        id: randomId('preview_invite'),
        crew_id: crewId,
        token: `preview-${crewId}`,
        expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
        revoked_at: null,
        created_at: new Date().toISOString(),
      };
      writeJson(MOCK_INVITES_KEY, invites);
    }
    return invites[crewId];
  }

  const client = requireSupabase();
  const user = await requireUser();
  const { data: existing, error: existingError } = await client
    .from('crew_invites')
    .select('id, crew_id, token, expires_at, revoked_at, created_at')
    .eq('crew_id', crewId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  if (existingError) throw existingError;
  if (existing?.[0]) return existing[0];

  const { data, error } = await client
    .from('crew_invites')
    .insert({ crew_id: crewId, created_by: user.id })
    .select('id, crew_id, token, expires_at, revoked_at, created_at')
    .single();

  if (error) throw error;
  return data;
}

export async function joinCrewByInvite(token) {
  if (isLocalDemoMode()) {
    const { crews, members } = ensureMockCrews();
    const invites = readJson(MOCK_INVITES_KEY, {});
    const invite = Object.values(invites).find((item) => item.token === token) ||
      (String(token).startsWith('preview-') ? { crew_id: String(token).replace('preview-', '') } : null);
    const crew = crews.find((item) => item.id === invite?.crew_id);
    if (!crew) return null;

    const crewMembers = members[crew.id] || [];
    const userId = getMockUserId();
    if (!crewMembers.some((member) => member.userId === userId)) {
      crewMembers.push({
        crewId: crew.id,
        userId,
        name: getMockUser().name || 'Preview Member',
        avatarUrl: getMockUser().avatarUrl || '',
        role: 'member',
        joinedAt: new Date().toISOString(),
      });
      members[crew.id] = crewMembers;
      saveMockCrewMembers(members);
    }
    return { ...crew, role: 'member' };
  }

  const client = requireSupabase();
  const { data, error } = await client.rpc('join_crew_by_invite', { invite_token: token });
  if (error) throw error;
  const crew = data?.[0];
  return crew ? mapCrew({
    id: crew.crew_id,
    name: crew.name,
    description: crew.description,
    challenge_start_date: crew.challenge_start_date,
    role: 'member',
  }) : null;
}

async function createSignedPhoto(photo) {
  if (!photo?.storage_path) return null;
  const client = requireSupabase();
  const { data } = await client.storage
    .from('journal-progress')
    .createSignedUrl(photo.storage_path, 3600);

  return {
    id: photo.id,
    entryId: photo.journal_entry_id,
    storagePath: photo.storage_path,
    caption: photo.caption || '',
    createdAt: photo.created_at,
    url: data?.signedUrl || '',
  };
}

function sortJournalEntries(entries) {
  return [...entries].sort((left, right) => new Date(right.date || right.entry_date) - new Date(left.date || left.entry_date));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read preview photo.'));
    reader.readAsDataURL(file);
  });
}

export async function getJournalEntries() {
  if (isLocalDemoMode()) return sortJournalEntries(readJson(MOCK_JOURNAL_KEY, []));

  const client = requireSupabase();
  await requireUser();
  const { data: entries, error } = await client
    .from('journal_entries')
    .select('id, user_id, entry_date, challenge_day, note, win, prayer, mood, energy, created_at, updated_at')
    .order('entry_date', { ascending: false })
    .limit(30);

  if (error) throw error;
  if (!entries?.length) return [];

  const entryIds = entries.map((entry) => entry.id);
  const { data: photos, error: photosError } = await client
    .from('journal_photos')
    .select('id, journal_entry_id, storage_path, caption, created_at')
    .in('journal_entry_id', entryIds)
    .order('created_at', { ascending: false });

  if (photosError) throw photosError;
  const signedPhotos = (await Promise.all((photos || []).map(createSignedPhoto))).filter(Boolean);
  return entries.map((entry) => mapJournalEntry(
    entry,
    signedPhotos.filter((photo) => photo.entryId === entry.id),
  ));
}

export async function saveJournalEntry(entry) {
  if (isLocalDemoMode()) {
    const entries = readJson(MOCK_JOURNAL_KEY, []);
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
      photos: existing.photos || [],
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
  return mapJournalEntry(data, []);
}

export async function uploadJournalPhoto({ entryId, file, caption = '' }) {
  if (isLocalDemoMode()) {
    const entries = readJson(MOCK_JOURNAL_KEY, []);
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) throw new Error('Save the preview journal entry before adding a photo.');
    const now = new Date().toISOString();
    const photo = {
      id: randomId('preview_photo'),
      entryId,
      storagePath: `preview/${entryId}/${file.name || 'progress-photo'}`,
      caption,
      createdAt: now,
      url: await fileToDataUrl(file),
    };
    entry.photos = [photo, ...(entry.photos || [])];
    entry.updatedAt = now;
    writeJson(MOCK_JOURNAL_KEY, sortJournalEntries(entries));
    return photo;
  }

  const client = requireSupabase();
  const user = await requireUser();
  const extension = file.name?.split('.').pop()?.toLowerCase() || 'jpg';
  const safeName = `${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}.${extension}`;
  const storagePath = `${user.id}/${entryId}/${safeName}`;
  const { error: uploadError } = await client.storage
    .from('journal-progress')
    .upload(storagePath, file, { cacheControl: '3600', upsert: false });

  if (uploadError) throw uploadError;

  const { data, error } = await client
    .from('journal_photos')
    .insert({
      user_id: user.id,
      journal_entry_id: entryId,
      storage_path: storagePath,
      caption,
    })
    .select('id, journal_entry_id, storage_path, caption, created_at')
    .single();

  if (error) throw error;
  return createSignedPhoto(data);
}
