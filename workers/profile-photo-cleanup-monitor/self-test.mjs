import { SELF_TEST_ID, SELF_TEST_KEY, STATE_KEY } from './constants.mjs';
import { initialState, validState, recoverInterrupted, reconcileNotification,
  reduceObservation, settleNotification } from './core.mjs';

export function validSelfTest(value) {
  if (!value || Object.keys(value).sort().join('|') !== 'complete|identity|state' ||
    value.identity !== SELF_TEST_ID || typeof value.complete !== 'boolean') throw new Error('Invalid self-test state.');
  const state = validState(value.state);
  if (state.incidentNumber > 1 || (value.complete && state.notification?.kind !== 'recovery')) {
    throw new Error('Invalid self-test state.');
  }
  return { identity: SELF_TEST_ID, complete: value.complete, state };
}

export async function loadSelfTest(storage, reconciliation, now) {
  const saved = await storage.get(SELF_TEST_KEY);
  if (saved === undefined) return null;
  const test = validSelfTest(saved);
  test.state = recoverInterrupted(test.state, now);
  const prefix = `${SELF_TEST_ID}/`;
  if (typeof reconciliation === 'string' && reconciliation.startsWith(prefix)) {
    test.state = reconcileNotification(test.state, reconciliation.slice(prefix.length), now);
  }
  await storage.put(SELF_TEST_KEY, test);
  await storage.sync();
  return test;
}

export function selfTestMetadata(test) {
  if (!test) return null;
  return { identity: SELF_TEST_ID, complete: test.complete,
    needsReview: test.state.needsReview,
    notificationId: test.state.notification ? `${SELF_TEST_ID}/${test.state.notification.id}` : null,
    notificationStatus: test.state.notification?.status ?? null,
    notificationCode: test.state.notification?.code ?? null,
    providerMessageId: test.state.notification?.providerMessageId ?? null,
    reconciliation: test.state.reconciliation };
}

// Called only inside the same serialized tick as real observation. Only the
// global daily budget is shared; synthetic conditions never enter real state.
export async function advanceSelfTest(storage, env, main, saved, slot, now, sender) {
  const test = saved ?? { identity: SELF_TEST_ID, complete: false, state: initialState() };
  // Do not consume the two synthetic recovery observations while mail is held.
  // After explicit reconciliation, two later fresh polls may send recovery;
  // the original uncertain opening notice is never replayed.
  if (test.complete || test.state.needsReview || main.needsReview) return { main, test };
  test.state.daily = structuredClone(main.daily);
  const first = test.state.notification === null;
  const synthetic = { generatedAt: now(), cleanup: { ready: first ? 101 : 0,
    staleLeases: 0, failuresLastHour: 0, oldestReadyAt: null },
    cron: { jobState: 'present', active: true, scheduleMatches: true, stale: false,
      lastRuns: [{ runId: String(slot + 1), status: 'succeeded', startedAt: now(), endedAt: now() }] } };
  const result = reduceObservation(test.state, { slot, now: now(), health: synthetic,
    alertsEnabled: !main.needsReview });
  test.state = result.state;
  main.daily = structuredClone(test.state.daily);
  if (result.intent?.kind === 'recovery') test.complete = true;
  // Multi-key put is atomic: shared quota and frozen synthetic intent survive
  // restart together before the single provider invocation.
  await storage.put({ [STATE_KEY]: main, [SELF_TEST_KEY]: validSelfTest(test) });
  await storage.sync();
  if (result.intent) {
    const outcome = await sender(env.EMAIL, result.intent, { testRun: SELF_TEST_ID });
    test.state = settleNotification(test.state, outcome, now());
    await storage.put(SELF_TEST_KEY, validSelfTest(test));
    await storage.sync();
  }
  return { main, test };
}
