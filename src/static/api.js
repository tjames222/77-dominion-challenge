import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  '';
const isPlaceholder = (value) => !value || value.includes('YOUR_');
const isSupabaseConfigured = () => !isPlaceholder(SUPABASE_URL) && !isPlaceholder(SUPABASE_KEY);
export const supabase = isSupabaseConfigured()
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
  return import.meta.env.DEV && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}
const MEMBERSHIP_ACCESS_KEY = 'membership_active';
const MEMBERSHIP_PRODUCT_KEY = 'dominion_membership';

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
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
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase;
};

const localBypassBillingState = () => ({
  authenticated: Boolean(readJson('dominion:user', null)?.authenticated),
  billingEnabled: false,
  appAccess: true,
  subscriptionActive: true,
  subscription: null,
  subscriptions: [],
  entitlements: [],
});

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
  return { name, email, authenticated: Boolean(session?.access_token) };
}

export const hasSupabaseAuth = () => Boolean(supabase);

export async function getAuthSession() {
  if (!supabase) return null;
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
}

export function saveLocalUserFromSession(session, fallbackName) {
  const user = sessionToUser(session, fallbackName);
  localStorage.setItem('dominion:user', JSON.stringify(user));
  if (user.name) localStorage.setItem('dominion:memberName', JSON.stringify(user.name));
  return user;
}

export async function getLocalOrSessionUser() {
  const session = await getAuthSession();
  if (session?.user) return sessionToUser(session);
  if (isLocalDemoMode()) return readJson('dominion:user', null);
  return null;
}

export async function upsertProfile({ name, challengeStartDate } = {}) {
  const client = requireSupabase();
  const user = await requireUser();
  const metadata = user.user_metadata || {};
  const displayName = name || metadata.name || metadata.full_name || user.email?.split('@')[0] || 'Member';

  const payload = {
    user_id: user.id,
    name: displayName,
    email: user.email || '',
  };
  if (challengeStartDate !== undefined) payload.challenge_start_date = challengeStartDate || null;

  const { data, error } = await client
    .from('profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select('user_id, name, email, challenge_start_date, created_at, updated_at')
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
  challengeStartDate: profile.challenge_start_date,
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

const mapPost = (post, likes = [], comments = [], currentUserId = '') => ({
  id: post.id,
  authorId: post.author_id,
  name: post.display_name || 'Member',
  crewId: post.crew_id,
  scope: post.scope,
  body: post.body,
  postType: post.post_type || 'message',
  day: post.challenge_day,
  status: post.status,
  completedCount: post.completed_count || 0,
  createdAt: post.created_at,
  timestamp: post.created_at ? todayLabel(post.created_at) : 'Today',
  likeCount: likes.length,
  likedByMe: likes.some((item) => item.user_id === currentUserId),
  comments: comments.map((comment) => ({
    id: comment.id,
    postId: comment.post_id,
    userId: comment.user_id,
    name: comment.display_name || 'Member',
    body: comment.body,
    createdAt: comment.created_at,
    timestamp: comment.created_at ? todayLabel(comment.created_at) : 'Today',
  })),
});

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
    .select('user_id, name, email, challenge_start_date, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;
  return data ? mapProfile(data) : upsertProfile();
}

export async function updateProfile(profile) {
  return upsertProfile({
    name: profile.name,
    challengeStartDate: profile.challengeStartDate,
  });
}

export async function getBillingState() {
  if (!supabase) return isLocalDemoMode() ? localBypassBillingState() : lockedBillingState();

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

async function invokeSupabaseFunction(name, body = {}) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) throw error;
  if (!data?.url) throw new Error('Billing session did not return a destination URL.');
  return data;
}

export async function createCheckoutSession(productKey) {
  return invokeSupabaseFunction('create-checkout-session', { productKey });
}

export async function createCustomerPortalSession() {
  return invokeSupabaseFunction('create-customer-portal-session');
}

export async function getDashboard() {
  const client = requireSupabase();
  const user = await requireUser();
  const [profile, entriesResult, feedResult, statsResult, badgesResult] = await Promise.all([
    getProfile(),
    client
      .from('challenge_entries')
      .select('entry_date, completed, scheduled_miss, updated_at')
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
      .select('badge_key, earned_at, metadata, badge_definitions(name, description, category, tier, icon)')
      .eq('user_id', user.id)
      .order('earned_at', { ascending: false })
      .limit(12),
  ]);

  if (entriesResult.error) throw entriesResult.error;
  if (feedResult.error) throw feedResult.error;
  if (statsResult.error) throw statsResult.error;
  if (badgesResult.error) throw badgesResult.error;

  return {
    profile,
    entries: entriesResult.data.map(mapEntry),
    feed: feedResult.data.map(mapFeedItem),
    gameStats: mapGameStats(statsResult.data),
    badges: (badgesResult.data || []).map(mapBadge).filter(Boolean),
  };
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
  const user = await requireUser();
  const { data, error } = await client
    .from('check_ins')
    .insert({
      user_id: user.id,
      entry_date: checkIn.date,
      challenge_day: checkIn.day,
      status: checkIn.status,
      completed_count: checkIn.completedCount,
      completed: checkIn.completed || [],
      workout_difficulty: checkIn.workoutDifficulty || {},
    })
    .select('id, challenge_day, status, completed_count, points_awarded, created_at')
    .single();

  if (error) throw error;
  const profile = readJson('dominion:user', { name: 'You' });
  return mapFeedItem({
    id: data?.id || globalThis.crypto?.randomUUID?.() || `${checkIn.date}-${Date.now()}`,
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
      .select('badge_key, earned_at, metadata, badge_definitions(name, description, category, tier, icon)')
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

export async function getLeaderboard({ scope = 'global', crewId = null, window = 'week' } = {}) {
  const client = requireSupabase();
  await requireUser();
  const rpcName = scope === 'crew' ? 'get_crew_leaderboard' : 'get_global_leaderboard';
  const payload = scope === 'crew'
    ? { target_crew_id: crewId, target_window: window }
    : { target_window: window };
  const { data, error } = await client.rpc(rpcName, payload);
  if (error) throw error;
  return (data || []).map(mapLeaderboardRow);
}

async function getCurrentDisplayName() {
  const profile = await getProfile();
  return profile?.name || 'Member';
}

export async function getCrews() {
  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client
    .from('crew_members')
    .select('crew_id, role, display_name, joined_at, crews(id, name, description, challenge_start_date, created_by, created_at)')
    .order('joined_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(mapCrew).filter(Boolean);
}

export async function createCrew({ name, description = '', challengeStartDate = null }) {
  const client = requireSupabase();
  const user = await requireUser();
  const displayName = await getCurrentDisplayName();
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
      display_name: displayName,
      role: 'owner',
    });

  if (memberError) throw memberError;
  return mapCrew({ ...crew, role: 'owner' });
}

export async function getCrewMembers(crewId) {
  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client
    .from('crew_members')
    .select('crew_id, user_id, display_name, role, joined_at')
    .eq('crew_id', crewId)
    .order('joined_at', { ascending: true });

  if (error) throw error;
  return (data || []).map((member) => ({
    crewId: member.crew_id,
    userId: member.user_id,
    name: member.display_name || 'Member',
    role: member.role,
    joinedAt: member.joined_at,
  }));
}

export async function getOrCreateCrewInvite(crewId) {
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

export async function getCommunityPosts({ scope = 'global', crewId = null, limit = 25 } = {}) {
  const client = requireSupabase();
  const user = await requireUser();
  let query = client
    .from('community_posts')
    .select('id, author_id, display_name, crew_id, scope, body, post_type, challenge_day, status, completed_count, created_at')
    .eq('scope', scope)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (scope === 'crew') query = query.eq('crew_id', crewId);
  const { data: posts, error } = await query;
  if (error) throw error;
  if (!posts?.length) return [];

  const postIds = posts.map((post) => post.id);
  const [likesResult, commentsResult] = await Promise.all([
    client
      .from('post_likes')
      .select('post_id, user_id')
      .in('post_id', postIds),
    client
      .from('post_comments')
      .select('id, post_id, user_id, display_name, body, created_at')
      .in('post_id', postIds)
      .order('created_at', { ascending: true }),
  ]);

  if (likesResult.error) throw likesResult.error;
  if (commentsResult.error) throw commentsResult.error;

  return posts.map((post) => mapPost(
    post,
    (likesResult.data || []).filter((like) => like.post_id === post.id),
    (commentsResult.data || []).filter((comment) => comment.post_id === post.id),
    user.id,
  ));
}

export async function createCommunityPost({ scope, crewId = null, body, postType = 'message' }) {
  const client = requireSupabase();
  const user = await requireUser();
  const displayName = await getCurrentDisplayName();
  const { data, error } = await client
    .from('community_posts')
    .insert({
      author_id: user.id,
      display_name: displayName,
      crew_id: scope === 'crew' ? crewId : null,
      scope,
      body,
      post_type: postType,
    })
    .select('id, author_id, display_name, crew_id, scope, body, post_type, challenge_day, status, completed_count, created_at')
    .single();

  if (error) throw error;
  return mapPost(data, [], [], user.id);
}

export async function setPostLiked(postId, shouldLike) {
  const client = requireSupabase();
  const user = await requireUser();
  if (shouldLike) {
    const { error } = await client
      .from('post_likes')
      .insert({ post_id: postId, user_id: user.id });
    if (error && error.code !== '23505') throw error;
    return;
  }

  const { error } = await client
    .from('post_likes')
    .delete()
    .eq('post_id', postId)
    .eq('user_id', user.id);
  if (error) throw error;
}

export async function addPostComment(postId, body) {
  const client = requireSupabase();
  const user = await requireUser();
  const displayName = await getCurrentDisplayName();
  const { data, error } = await client
    .from('post_comments')
    .insert({
      post_id: postId,
      user_id: user.id,
      display_name: displayName,
      body,
    })
    .select('id, post_id, user_id, display_name, body, created_at')
    .single();

  if (error) throw error;
  return {
    id: data.id,
    postId: data.post_id,
    userId: data.user_id,
    name: data.display_name || 'Member',
    body: data.body,
    createdAt: data.created_at,
    timestamp: data.created_at ? todayLabel(data.created_at) : 'Today',
  };
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

export async function getJournalEntries() {
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
