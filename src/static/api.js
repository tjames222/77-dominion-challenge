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
  return import.meta.env.DEV || ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname) || window.location.protocol === 'file:';
}
const CHALLENGE_ACCESS_KEY = 'challenge_77_access';
const MEMBERSHIP_ACCESS_KEY = 'membership_active';

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
  challengeAccess: true,
  membershipActive: false,
  challengePurchase: null,
  membershipSubscription: null,
  purchases: [],
  subscriptions: [],
  entitlements: [],
});

const lockedBillingState = () => ({
  authenticated: false,
  billingEnabled: true,
  challengeAccess: false,
  membershipActive: false,
  challengePurchase: null,
  membershipSubscription: null,
  purchases: [],
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
  timestamp: item.created_at ? todayLabel(item.created_at) : item.timestamp || 'Today',
  createdAt: item.created_at,
});

const mapPurchase = (purchase) => purchase ? ({
  id: purchase.id,
  productKey: purchase.product_key,
  status: purchase.status,
  amountTotal: purchase.amount_total,
  currency: purchase.currency || 'usd',
  purchasedAt: purchase.purchased_at,
  createdAt: purchase.created_at,
}) : null;

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
      challengeAccess: false,
      membershipActive: false,
      challengePurchase: null,
      membershipSubscription: null,
      purchases: [],
      subscriptions: [],
      entitlements: [],
    };
  }

  const client = requireSupabase();
  const userId = session.user.id;
  const [entitlementsResult, purchasesResult, subscriptionsResult] = await Promise.all([
    client
      .from('entitlements')
      .select('entitlement_key, status, starts_at, ends_at, source_type, source_id, metadata')
      .eq('user_id', userId),
    client
      .from('purchases')
      .select('id, product_key, status, amount_total, currency, purchased_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    client
      .from('subscriptions')
      .select('id, product_key, status, cancel_at_period_end, current_period_start, current_period_end, canceled_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  ]);

  if (entitlementsResult.error) throw entitlementsResult.error;
  if (purchasesResult.error) throw purchasesResult.error;
  if (subscriptionsResult.error) throw subscriptionsResult.error;

  const entitlements = (entitlementsResult.data || []).map(mapEntitlement);
  const purchases = (purchasesResult.data || []).map(mapPurchase);
  const subscriptions = (subscriptionsResult.data || []).map(mapSubscription);

  return {
    authenticated: true,
    billingEnabled: true,
    challengeAccess: hasActiveEntitlement(entitlements, CHALLENGE_ACCESS_KEY),
    membershipActive: hasActiveEntitlement(entitlements, MEMBERSHIP_ACCESS_KEY),
    challengePurchase: purchases.find((item) => item.productKey === 'challenge_77' && item.status === 'paid') || null,
    membershipSubscription: subscriptions.find((item) => item.productKey === 'dominion_membership') || null,
    purchases,
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
  const [profile, entriesResult, feedResult] = await Promise.all([
    getProfile(),
    client
      .from('challenge_entries')
      .select('entry_date, completed, scheduled_miss, updated_at')
      .eq('user_id', user.id)
      .order('entry_date', { ascending: false })
      .limit(90),
    client
      .from('community_feed_items')
      .select('id, display_name, challenge_day, status, completed_count, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  if (entriesResult.error) throw entriesResult.error;
  if (feedResult.error) throw feedResult.error;

  return {
    profile,
    entries: entriesResult.data.map(mapEntry),
    feed: feedResult.data.map(mapFeedItem),
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
  const { error } = await client
    .from('check_ins')
    .insert({
      user_id: user.id,
      entry_date: checkIn.date,
      challenge_day: checkIn.day,
      status: checkIn.status,
      completed_count: checkIn.completedCount,
    });

  if (error) throw error;
  const profile = readJson('dominion:user', { name: 'You' });
  return mapFeedItem({
    id: globalThis.crypto?.randomUUID?.() || `${checkIn.date}-${Date.now()}`,
    display_name: profile?.name || 'You',
    challenge_day: checkIn.day,
    status: checkIn.status,
    completed_count: checkIn.completedCount,
    created_at: new Date().toISOString(),
  });
}

export async function getCommunityFeed() {
  const client = requireSupabase();
  await requireUser();
  const { data, error } = await client
    .from('community_feed_items')
    .select('id, display_name, challenge_day, status, completed_count, created_at')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;
  return data.map(mapFeedItem);
}
