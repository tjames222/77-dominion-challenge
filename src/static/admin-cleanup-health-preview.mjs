// Synthetic aggregate-only preview. Never read from or mutate live Storage.
export function previewCleanupHealth(observedAt) {
  const prior = new Date(Date.parse(observedAt) - 120000).toISOString();
  return { counterLimit: 1000, counters: { expiredPending: { count: 2, hasMore: false }, ready: { count: 3, hasMore: false },
    leased: { count: 1, hasMore: false }, staleLeases: { count: 0, hasMore: false }, backingOff: { count: 1, hasMore: false }, failuresLastHour: { count: 1, hasMore: false } },
  oldestEligibleAt: prior, cron: { extensionAvailable: true, catalogAvailable: true, jobState: 'present', active: true, scheduleMatches: true,
    historyCoverage: 'complete', historyLimit: 1000, lastRunsOrder: 'run-id-desc', freshness: 'fresh', staleAfterSeconds: 900,
    lastRuns: [{ status: 'succeeded', startedAt: prior, endedAt: prior }], transportEvidence: 'enqueue-only' } };
}
