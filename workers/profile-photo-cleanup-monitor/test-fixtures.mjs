export const BASE = Date.parse('2026-10-06T12:02:00.000Z');
export const SECRET = 'A'.repeat(43);
export const iso = value => new Date(value).toISOString();
export function healthBody(now = BASE, ready = 0) {
  return { status: 'ok', health: { schemaVersion: 1, generatedAt: iso(now),
    cleanup: { expiredPending: 0, ready, leased: 0, staleLeases: 0, backingOff: 0,
      failuresLastHour: 0, oldestReadyAt: null, generatedAt: iso(now) },
    cron: { extensionAvailable: true, catalogAvailable: true, jobState: 'present', active: true,
      scheduleMatches: true, historyAvailable: true, stale: false, staleAfterSeconds: 900,
      transportEvidence: 'enqueue-only', lastRuns: [
        { runId: String(9007199254740993n + BigInt(Math.floor(now / 300000))), status: 'succeeded',
          startedAt: iso(now - 120_000), endedAt: iso(now - 119_000) },
      ] },
  } };
}
