import { SELF_TEST_ID, STATE_KEY } from './constants.mjs';
import { initialState, recoverInterrupted, reconcileNotification, reduceObservation,
  scheduledSlot, settleNotification, validState } from './core.mjs';
import { readHealth, sendNotification } from './transport.mjs';
import { advanceSelfTest, loadSelfTest, selfTestMetadata } from './self-test.mjs';

export function safeMetadata(state, ignored = false) {
  return { status: state.needsReview ? 'needs_review' : 'observed', ignored,
    lastPollAt: state.lastPollAt, conditionCodes: state.lastCodes,
    incident: state.incident?.number ?? null, dailyCount: state.daily.count,
    notificationId: state.notification?.id ?? null,
    notificationStatus: state.notification?.status ?? null,
    notificationCode: state.notification?.code ?? null,
    providerMessageId: state.notification?.providerMessageId ?? null,
    reconciliation: state.reconciliation };
}

// The caller serializes full ticks. State is read from physical storage for
// every tick; process memory never authorizes deduplication or quota reset.
export async function runTick(storage, env, scheduledTime, {
  now = Date.now, healthReader = readHealth, sender = sendNotification,
} = {}) {
  const selfTestEnabled = env.MONITOR_SELF_TEST === SELF_TEST_ID;
  if ((env.MONITOR_SELF_TEST && !selfTestEnabled) || (selfTestEnabled && env.ALERTS_ENABLED === 'true')) {
    throw new Error('Invalid self-test configuration.');
  }
  const slot = scheduledSlot(scheduledTime, now());
  const saved = await storage.get(STATE_KEY);
  let state = saved === undefined ? initialState() : validState(saved);
  state = recoverInterrupted(state, now());
  if (env.MONITOR_RECONCILE_NOTIFICATION && !env.MONITOR_RECONCILE_NOTIFICATION.startsWith(`${SELF_TEST_ID}/`)) {
    state = reconcileNotification(state, env.MONITOR_RECONCILE_NOTIFICATION, now());
  }
  await storage.put(STATE_KEY, state);
  await storage.sync();
  let selfTest = await loadSelfTest(storage, env.MONITOR_RECONCILE_NOTIFICATION, now());
  const metadata = ignored => {
    const data = { ...safeMetadata(state, ignored), selfTest: selfTestMetadata(selfTest) };
    if (selfTest?.state.needsReview) data.status = 'needs_review';
    return data;
  };
  if (state.lastSlot !== null && slot <= state.lastSlot) return metadata(true);
  const health = await healthReader(env.PROFILE_PHOTO_HEALTH_SECRET, state.lastSnapshotAt, { now });
  const result = reduceObservation(state, { slot, now: now(), health,
    alertsEnabled: env.ALERTS_ENABLED === 'true' && !selfTest?.state.needsReview });
  state = result.state;
  // Commit the transition, immutable intent and charged quota BEFORE invoking
  // the mail binding. A crash after this point must never retry the intent.
  await storage.put(STATE_KEY, state);
  await storage.sync();
  if (result.intent) {
    const outcome = await sender(env.EMAIL, result.intent);
    state = settleNotification(state, outcome, now());
    await storage.put(STATE_KEY, state);
    await storage.sync();
  }
  if (selfTestEnabled) {
    const advanced = await advanceSelfTest(storage, env, state, selfTest, slot, now, sender);
    state = advanced.main; selfTest = advanced.test;
  }
  return metadata(result.ignored);
}
