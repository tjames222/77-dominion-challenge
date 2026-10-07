import { CONDITIONS, CONDITION_TEXT, DAILY_LIMIT, INTERVAL_MS, MAX_FUTURE_MS,
  MAX_GAP_MS, MAX_SNAPSHOT_AGE_MS, RECIPIENT, SENDER, SELF_TEST_ID } from './constants.mjs';

const invalid = () => new Error('Monitor data is invalid.');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bool = value => typeof value === 'boolean';
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw invalid();
  return value;
}
function codes(value) {
  if (!Array.isArray(value) || value.length > CONDITIONS.length || new Set(value).size !== value.length ||
    value.some(code => !CONDITIONS.includes(code))) throw invalid();
  return value;
}
function time(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length !== 24 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
  return Date.parse(value);
}
const runId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

export function parseHealth(body, now, previousSnapshotAt = null) {
  record(body, ['status', 'health']);
  if (body.status !== 'ok') throw invalid();
  const h = record(body.health, ['schemaVersion', 'generatedAt', 'cleanup', 'cron']);
  if (h.schemaVersion !== 1 || !integer(now)) throw invalid();
  const generatedAt = time(h.generatedAt);
  if (generatedAt < now - MAX_SNAPSHOT_AGE_MS || generatedAt > now + MAX_FUTURE_MS ||
    (previousSnapshotAt !== null && generatedAt <= previousSnapshotAt)) throw invalid();
  const c = record(h.cleanup, ['expiredPending', 'ready', 'leased', 'staleLeases', 'backingOff',
    'failuresLastHour', 'oldestReadyAt', 'generatedAt']);
  for (const key of ['expiredPending','ready','leased','staleLeases','backingOff','failuresLastHour']) {
    if (!integer(c[key])) throw invalid();
  }
  const cleanupAt = time(c.generatedAt);
  const oldestReadyAt = time(c.oldestReadyAt, true);
  if (cleanupAt < now - MAX_SNAPSHOT_AGE_MS || cleanupAt > now + MAX_FUTURE_MS ||
    Math.abs(cleanupAt - generatedAt) > MAX_FUTURE_MS ||
    (oldestReadyAt !== null && oldestReadyAt > now + MAX_FUTURE_MS)) throw invalid();
  const cron = record(h.cron, ['extensionAvailable','catalogAvailable','jobState','active',
    'scheduleMatches','historyAvailable','stale','staleAfterSeconds','lastRuns','transportEvidence']);
  for (const key of ['extensionAvailable','catalogAvailable','historyAvailable','stale']) if (!bool(cron[key])) throw invalid();
  if (!['unavailable','missing','present','ambiguous'].includes(cron.jobState) || cron.staleAfterSeconds !== 900 ||
    cron.transportEvidence !== 'enqueue-only' || !Array.isArray(cron.lastRuns) || cron.lastRuns.length > 2 ||
    cron.historyAvailable !== (cron.lastRuns.length > 0) || cron.catalogAvailable !== (cron.jobState !== 'unavailable') ||
    (cron.catalogAvailable && !cron.extensionAvailable)) throw invalid();
  if (cron.jobState === 'present') {
    if (!bool(cron.active) || !bool(cron.scheduleMatches)) throw invalid();
  } else if (cron.active !== null || cron.scheduleMatches !== null || cron.lastRuns.length !== 0) throw invalid();
  const lastRuns = cron.lastRuns.map(value => {
    const r = record(value, ['runId','status','startedAt','endedAt']);
    if (!runId(r.runId) || !['starting','connecting','sending','running','succeeded','failed','unknown'].includes(r.status)) throw invalid();
    const startedAt = time(r.startedAt, true), endedAt = time(r.endedAt, true);
    if ((startedAt !== null && startedAt > now + MAX_FUTURE_MS) ||
      (endedAt !== null && (endedAt > now + MAX_FUTURE_MS || startedAt === null || endedAt < startedAt)) ||
      (['succeeded','failed'].includes(r.status) && (startedAt === null || endedAt === null))) throw invalid();
    return { runId: r.runId, status: r.status, startedAt, endedAt };
  });
  if (lastRuns.length === 2 && BigInt(lastRuns[0].runId) <= BigInt(lastRuns[1].runId)) throw invalid();
  const starts = lastRuns.map(r => r.startedAt).filter(t => t !== null);
  const stale = cron.stale || starts.length === 0 || Math.max(...starts) < now - 900_000;
  return { generatedAt, cleanup: { ready: c.ready, staleLeases: c.staleLeases,
    failuresLastHour: c.failuresLastHour, oldestReadyAt }, cron: { jobState: cron.jobState,
    active: cron.active, scheduleMatches: cron.scheduleMatches, stale, lastRuns } };
}

export function initialState() {
  return { version: 1, lastSlot: null, lastPollAt: null, lastSnapshotAt: null,
    failedHealth: 0, healthyPolls: 0, staleLeaseSince: null, cronFailure: false,
    incidentNumber: 0, incident: null, daily: { day: '1970-01-01', count: 0 },
    notification: null, needsReview: false, reconciliation: null, lastCodes: [], lastCronRunIds: [] };
}

export function validState(value) {
  record(value, Object.keys(initialState()));
  if (JSON.stringify(value).length > 8192 || value.version !== 1 || !integer(value.incidentNumber) ||
    ![0,1,2].includes(value.failedHealth) || ![0,1,2].includes(value.healthyPolls) ||
    !bool(value.cronFailure) || !bool(value.needsReview)) throw invalid();
  for (const key of ['lastSlot','lastPollAt','lastSnapshotAt','staleLeaseSince']) {
    if (value[key] !== null && !integer(value[key])) throw invalid();
  }
  codes(value.lastCodes);
  if (!Array.isArray(value.lastCronRunIds) || value.lastCronRunIds.length > 2 ||
    value.lastCronRunIds.some(id => !runId(id))) throw invalid();
  record(value.daily, ['day','count']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.daily.day) || !integer(value.daily.count) || value.daily.count > DAILY_LIMIT) throw invalid();
  if (value.incident !== null) {
    record(value.incident, ['number','openedAt','seenCodes','notifiedCodes','hasNotice','updated']);
    if (!integer(value.incident.number) || value.incident.number !== value.incidentNumber ||
      !integer(value.incident.openedAt) || !bool(value.incident.hasNotice) || !bool(value.incident.updated)) throw invalid();
    codes(value.incident.seenCodes); codes(value.incident.notifiedCodes);
  }
  if (value.reconciliation !== null) {
    const r = record(value.reconciliation, ['notificationId','acknowledgedAt','action']);
    if (!/^cleanup-\d+-(?:open|update|recovery)$/.test(r.notificationId) ||
      !integer(r.acknowledgedAt) || r.action !== 'resume_without_retry') throw invalid();
  }
  if (value.notification !== null) {
    const n = record(value.notification, ['id','kind','incident','createdAt','codes','status','completedAt','providerMessageId','code']);
    if (!/^cleanup-\d+-(?:open|update|recovery)$/.test(n.id) || !['open','update','recovery'].includes(n.kind) ||
      !integer(n.incident) || n.incident < 1 || n.incident > value.incidentNumber || !integer(n.createdAt) || n.id !== `cleanup-${n.incident}-${n.kind}` ||
      !['sending','accepted','rejected','delivery_unknown'].includes(n.status) ||
      (n.completedAt !== null && !integer(n.completedAt)) ||
      (n.providerMessageId !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(n.providerMessageId)) ||
      ![null,'accepted','provider_rejected','provider_unknown','interrupted'].includes(n.code)) throw invalid();
    codes(n.codes);
    if (n.codes.length === 0 ||
      (n.status === 'sending' && (n.code !== null || n.completedAt !== null || n.providerMessageId !== null)) ||
      (n.status === 'accepted' && (n.code !== 'accepted' || n.completedAt === null || n.providerMessageId === null)) ||
      (n.status === 'rejected' && (n.code !== 'provider_rejected' || n.completedAt === null || n.providerMessageId !== null)) ||
      (n.status === 'delivery_unknown' && (!['provider_unknown','interrupted'].includes(n.code) || n.completedAt === null || n.providerMessageId !== null))) throw invalid();
    if (n.status === 'delivery_unknown' && !value.needsReview &&
      value.reconciliation?.notificationId !== n.id) throw invalid();
  }
  return structuredClone(value);
}

// Protected deployment configuration is the only reconciliation input. This
// acknowledges uncertainty; it does not assert delivery or retry old mail.
export function reconcileNotification(value, notificationId, now) {
  const state = validState(value);
  if (typeof notificationId !== 'string' || notificationId.length > 80 || !integer(now)) throw invalid();
  if (state.needsReview && state.notification?.status === 'delivery_unknown' &&
    state.notification.id === notificationId) {
    state.reconciliation = { notificationId, acknowledgedAt: now, action: 'resume_without_retry' };
    state.needsReview = false;
  }
  return validState(state);
}

export function recoverInterrupted(value, now) {
  const state = validState(value);
  if (state.notification?.status === 'sending') {
    state.notification.status = 'delivery_unknown'; state.notification.code = 'interrupted';
    state.notification.completedAt = now; state.needsReview = true;
  }
  return state;
}

export function reduceObservation(value, { slot, now, health = null, alertsEnabled = false }) {
  const state = validState(value);
  if (!bool(alertsEnabled) || state.notification?.status === 'sending') throw invalid();
  if (!integer(slot) || !integer(now) || (state.lastSlot !== null && slot <= state.lastSlot)) {
    return { state, intent: null, ignored: true };
  }
  const contiguous = state.lastPollAt !== null && slot === state.lastSlot + 1 && now >= state.lastPollAt && now - state.lastPollAt <= MAX_GAP_MS;
  if (state.lastPollAt !== null && now < state.lastPollAt) throw invalid();
  state.lastSlot = slot; state.lastPollAt = now;
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== state.daily.day) state.daily = { day, count: 0 };
  let active = [];
  if (health === null) {
    state.failedHealth = Math.min(2, (contiguous ? state.failedHealth : 0) + 1);
    state.staleLeaseSince = null; state.healthyPolls = 0;
    if (state.failedHealth >= 2) active = ['health_unavailable'];
  } else {
    state.failedHealth = 0; state.lastSnapshotAt = health.generatedAt;
    state.lastCronRunIds = health.cron.lastRuns.map(r => r.runId);
    const c = health.cleanup, cron = health.cron;
    if (cron.lastRuns.length === 2 && cron.lastRuns.every(r => r.status === 'failed')) state.cronFailure = true;
    else if (cron.lastRuns.find(r => ['succeeded','failed'].includes(r.status))?.status === 'succeeded') state.cronFailure = false;
    if (cron.jobState !== 'present') active.push('cron_unavailable');
    else { if (!cron.active) active.push('cron_inactive'); if (!cron.scheduleMatches) active.push('cron_schedule'); }
    if (cron.stale) active.push('cron_stale');
    if (state.cronFailure) active.push('cron_failed');
    if (c.staleLeases > 0) {
      if (!contiguous || state.staleLeaseSince === null) state.staleLeaseSince = now;
      if (now - state.staleLeaseSince > 600_000) active.push('stale_leases');
    } else state.staleLeaseSince = null;
    if (c.ready > 100) active.push('ready_backlog');
    if (c.oldestReadyAt !== null && now - c.oldestReadyAt > 900_000) active.push('oldest_ready');
    if (c.failuresLastHour > 5) active.push('cleanup_failures');
    const clear = active.length === 0 && c.staleLeases === 0;
    state.healthyPolls = clear ? Math.min(2, (contiguous ? state.healthyPolls : 0) + 1) : 0;
  }
  active = CONDITIONS.filter(code => active.includes(code)); state.lastCodes = active;
  if (active.length > 0 && state.incident === null) {
    state.incidentNumber++;
    state.incident = { number: state.incidentNumber, openedAt: now, seenCodes: [], notifiedCodes: [], hasNotice: false, updated: false };
  }
  let kind = null, noticeCodes = active;
  if (state.incident) {
    const i = state.incident;
    i.seenCodes = CONDITIONS.filter(code => i.seenCodes.includes(code) || active.includes(code));
    if (active.length > 0 && !i.hasNotice) kind = 'open';
    else if (active.some(code => !i.notifiedCodes.includes(code)) && !i.updated) kind = 'update';
    else if (health !== null && state.healthyPolls >= 2) {
      if (i.hasNotice) { kind = 'recovery'; noticeCodes = i.seenCodes; }
      else state.incident = null;
    }
  }
  let intent = null;
  if (kind && alertsEnabled && !state.needsReview && state.daily.count < DAILY_LIMIT) {
    const i = state.incident;
    intent = { id: `cleanup-${i.number}-${kind}`, kind, incident: i.number, createdAt: now,
      codes: [...noticeCodes], status: 'sending', completedAt: null, providerMessageId: null, code: null };
    state.notification = intent; state.daily.count++;
    i.hasNotice = true;
    // Observed while disabled/quota-limited is not the same as included in a
    // reserved notice. Keep the bounded update available for an unsent condition.
    i.notifiedCodes = CONDITIONS.filter(code => i.notifiedCodes.includes(code) || noticeCodes.includes(code));
    if (kind === 'update') i.updated = true;
    if (kind === 'recovery') state.incident = null;
  } else if (kind === 'recovery' && state.needsReview) state.incident = null;
  return { state: validState(state), intent: intent ? structuredClone(intent) : null, ignored: false };
}

export function settleNotification(value, outcome, now) {
  const state = validState(value);
  if (!state.notification || state.notification.status !== 'sending' || !integer(now)) throw invalid();
  const n = state.notification;
  if (outcome.status === 'accepted' && typeof outcome.messageId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(outcome.messageId)) {
    n.status = 'accepted'; n.providerMessageId = outcome.messageId; n.code = 'accepted';
  } else if (outcome.status === 'rejected') {
    n.status = 'rejected'; n.code = 'provider_rejected';
  } else {
    n.status = 'delivery_unknown'; n.code = 'provider_unknown'; state.needsReview = true;
  }
  n.completedAt = now; return validState(state);
}

export function renderNotification(intent, testRun = null) {
  if (testRun !== null && testRun !== SELF_TEST_ID) throw invalid();
  const probe = initialState(); probe.incidentNumber = intent.incident; probe.notification = intent;
  if (intent.status === 'delivery_unknown') probe.needsReview = true;
  validState(probe);
  const title = { open: 'Alert', update: 'Alert update', recovery: 'Recovery' }[intent.kind];
  const lines = [...(testRun ? [`TEST ONLY: ${testRun}`, 'Synthetic monitor acceptance test. No production cleanup fault was created.', ''] : []),
    `Dominion profile-photo cleanup: ${title}`, `Incident: ${intent.incident}`,
    `Observed: ${new Date(intent.createdAt).toISOString()}`, '',
    ...(intent.kind === 'recovery' ? ['Two fresh healthy observations cleared the incident.', 'Previously observed conditions:'] : ['Observed conditions:']),
    ...intent.codes.map(code => `- ${CONDITION_TEXT[code]}`), '',
    'Cron success proves asynchronous SQL enqueue only, not HTTP delivery or deletion.',
    'No member records, image paths or credentials are included.',
    'Owner: Tim James. Use the profile-photo cleanup runbook; do not delete photos manually.',
  ];
  return Object.freeze({ from: SENDER, to: RECIPIENT,
    subject: `${testRun ? '[TEST ONLY] ' : ''}[Dominion cleanup] ${title} - incident ${intent.incident}`, text: lines.join('\n') });
}

export function scheduledSlot(scheduledTime, now) {
  if (!integer(scheduledTime) || !integer(now) ||
    scheduledTime > now + MAX_FUTURE_MS || now - scheduledTime > MAX_SNAPSHOT_AGE_MS) throw invalid();
  // Cloudflare may supply seconds/milliseconds within the configured minute.
  // Validate raw freshness first, then accept only that minute; normalization
  // must not widen the future/stale windows or create another durable slot.
  const scheduledMinute = Math.floor(scheduledTime / 60_000) * 60_000;
  if (scheduledMinute % INTERVAL_MS !== 120_000) throw invalid();
  return Math.floor(scheduledTime / INTERVAL_MS);
}
