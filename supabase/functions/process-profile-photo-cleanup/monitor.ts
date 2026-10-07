import type { EnvReader } from "../_shared/http.ts";

export async function validHealthSecret(req: Request, env: EnvReader) {
  const expected = env("PROFILE_PHOTO_HEALTH_SECRET") || "";
  const provided = req.headers.get("x-dominion-health-key") || "";
  // Exactly 32 bytes in canonical base64url, including zero unused pad bits.
  const format = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
  if (!format.test(expected) || !format.test(provided)) return false;
  if (expected === env("PROFILE_PHOTO_WORKER_SECRET")) return false;
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [left, right] = await Promise.all([digest(expected), digest(provided)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function readCleanupRequest(
  req: Request,
): Promise<{ mode?: string; limit?: number }> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers.get("content-type") || "",
    ) || req.headers.has("content-encoding")
  ) throw new Error("Invalid body.");
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d{1,3}$/.test(length) || Number(length) > 256)) {
    throw new Error("Invalid body.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Invalid body.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Invalid body.")), 1000);
  });
  let bytes = new Uint8Array();
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (bytes.byteLength + chunk.value.byteLength > 256) {
        throw new Error("Invalid body.");
      }
      const next = new Uint8Array(bytes.byteLength + chunk.value.byteLength);
      next.set(bytes);
      next.set(chunk.value, bytes.byteLength);
      bytes = next;
    }
  } finally {
    clearTimeout(timer);
    // A hostile stream must not hold the handler inside cancellation.
    void reader.cancel().catch(() => {});
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Tiny flat grammar: reject duplicate/escaped keys, extra fields and unknown
  // modes before parsing. Malformed health never falls through to deletion.
  if (
    !/^\s*\{\s*(?:"mode"\s*:\s*"(?:health|monitor-health)"|"limit"\s*:\s*-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)?\s*\}\s*$/
      .test(text)
  ) {
    throw new Error("Invalid body.");
  }
  const value = JSON.parse(text);
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)
  ) {
    throw new Error("Invalid body.");
  }
  return value;
}

export function monitorSnapshot(value: unknown) {
  const invalid = () => new Error("Invalid health snapshot.");
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalid();
    }
    return value as Record<string, unknown>;
  };
  const bool = (value: unknown) => {
    if (typeof value !== "boolean") throw invalid();
    return value;
  };
  const timestamp = (value: unknown, nullable = false) => {
    if (nullable && value === null) return null;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value) ||
      !Number.isFinite(Date.parse(value))
    ) throw invalid();
    return new Date(value).toISOString();
  };
  const snapshot = object(value);
  if (snapshot.schemaVersion !== 1) throw invalid();
  const cleanup = object(snapshot.cleanup);
  const counts: Record<string, number> = {};
  for (
    const key of [
      "expiredPending",
      "ready",
      "leased",
      "staleLeases",
      "backingOff",
      "failuresLastHour",
    ]
  ) {
    const count = cleanup[key];
    if (
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
    ) throw invalid();
    counts[key] = count;
  }
  const cron = object(snapshot.cron);
  if (
    typeof cron.jobState !== "string" ||
    !["unavailable", "missing", "present", "ambiguous"].includes(
      cron.jobState,
    ) ||
    !Array.isArray(cron.lastRuns) || cron.lastRuns.length > 2 ||
    cron.staleAfterSeconds !== 900 || cron.transportEvidence !== "enqueue-only"
  ) throw invalid();
  const lastRuns = cron.lastRuns.map((item: unknown) => {
    const run = object(item);
    if (
      typeof run.runId !== "string" || !/^[1-9]\d{0,18}$/.test(run.runId) ||
      BigInt(run.runId) > 9223372036854775807n ||
      typeof run.status !== "string" ||
      ![
        "starting",
        "connecting",
        "sending",
        "running",
        "succeeded",
        "failed",
        "unknown",
      ].includes(run.status)
    ) throw invalid();
    return {
      runId: run.runId,
      status: run.status,
      startedAt: timestamp(run.startedAt, true),
      endedAt: timestamp(run.endedAt, true),
    };
  });
  if (
    (lastRuns.length === 2 &&
      BigInt(lastRuns[0].runId) <= BigInt(lastRuns[1].runId)) ||
    bool(cron.historyAvailable) !== (lastRuns.length > 0) ||
    (cron.jobState !== "present" &&
      (lastRuns.length > 0 || cron.active !== null ||
        cron.scheduleMatches !== null)) ||
    (cron.jobState === "present" &&
      (typeof cron.active !== "boolean" ||
        typeof cron.scheduleMatches !== "boolean")) ||
    bool(cron.catalogAvailable) !== (cron.jobState !== "unavailable") ||
    (cron.catalogAvailable && !bool(cron.extensionAvailable))
  ) throw invalid();
  return {
    schemaVersion: 1,
    generatedAt: timestamp(snapshot.generatedAt),
    cleanup: {
      ...counts,
      oldestReadyAt: timestamp(cleanup.oldestReadyAt, true),
      generatedAt: timestamp(cleanup.generatedAt),
    },
    cron: {
      extensionAvailable: bool(cron.extensionAvailable),
      catalogAvailable: bool(cron.catalogAvailable),
      jobState: cron.jobState,
      active: cron.active === null ? null : bool(cron.active),
      scheduleMatches: cron.scheduleMatches === null
        ? null
        : bool(cron.scheduleMatches),
      historyAvailable: bool(cron.historyAvailable),
      stale: bool(cron.stale),
      staleAfterSeconds: 900,
      lastRuns,
      transportEvidence: "enqueue-only",
    },
  };
}
