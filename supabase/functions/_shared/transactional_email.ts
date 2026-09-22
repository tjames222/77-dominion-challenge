// Server-only Resend transport for an immutable, already-persisted outbox job.
// This module does not authenticate callers, render content, or authorize email.
const ENDPOINT = "https://api.resend.com/emails";
const encoder = new TextEncoder();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const TRANSACTIONAL_EMAIL_MAX_BODY_BYTES = 131072;
const MAX_RESPONSE_BYTES = 16384;

export type TransactionalEmailMessage = Readonly<{
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}>;

export type TransactionalEmailContent = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  message: TransactionalEmailMessage;
}>;

export type TransactionalEmailJob =
  & TransactionalEmailContent
  & Readonly<{
    bindingFingerprint: string;
    // Canonical database timestamp. Never replace it after an uncertain attempt.
    firstDispatchedAt: string | null;
  }>;

export type TransactionalEmailDispatchBinding = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  bindingFingerprint: string;
  firstDispatchedAt: string | null;
}>;

export type TransactionalEmailDispatchReceipt = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  bindingFingerprint: string;
  firstDispatchedAt: string;
}>;

export type TransactionalEmailOutcome =
  | { state: "accepted"; emailId: string }
  | {
    state: "retryable";
    code: "dispatch_not_owned" | "rate_limited" | "concurrent_request";
  }
  | {
    state: "uncertain";
    code: "dispatch_unconfirmed" | "request_unconfirmed";
  }
  | {
    state: "needs_review";
    code:
      | "binding_mismatch"
      | "retry_window_expired"
      | "clock_invalid"
      | "dispatch_receipt_mismatch"
      | "provider_rejected"
      | "idempotency_conflict"
      | "receipt_invalid"
      | "daily_quota_exceeded"
      | "monthly_quota_exceeded";
  };

export type TransactionalEmailOptions = Readonly<{
  apiKey: string;
  // Atomically verify the lease, immutable binding and free quota, and persist
  // the FIRST dispatch time before resolving. Return null only for a confirmed
  // ownership/quota denial; throw/timeout is an uncertain database operation.
  // Retries must return the original timestamp, never a fresh timestamp.
  markDispatched: (
    binding: TransactionalEmailDispatchBinding,
    signal: AbortSignal,
  ) => Promise<TransactionalEmailDispatchReceipt | null>;
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return record(value) && Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function mailbox(value: string) {
  return value.length <= 254 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
      .test(value);
}

function sender(value: string) {
  if (mailbox(value)) return true;
  const named = /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}) <([^<>]+)>$/.exec(value);
  return named !== null && mailbox(named[2]);
}

function snapshotContent(content: TransactionalEmailContent) {
  const message = content?.message;
  if (
    !content || typeof content.deliveryId !== "string" ||
    !UUID.test(content.deliveryId) ||
    typeof content.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,255}$/.test(content.idempotencyKey) ||
    !exact(message, ["from", "to", "subject", "text", "html"]) ||
    typeof message.from !== "string" || !sender(message.from) ||
    typeof message.to !== "string" || !mailbox(message.to) ||
    typeof message.subject !== "string" || !message.subject.trim() ||
    message.subject.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(message.subject) ||
    typeof message.text !== "string" || !message.text.trim() ||
    message.text.length > 60000 || message.text.includes("\u0000") ||
    typeof message.html !== "string" || !message.html.trim() ||
    message.html.length > 100000 || message.html.includes("\u0000")
  ) throw new TypeError("Invalid transactional email configuration.");
  // Fixed field order and one recipient: preserve the exact rendered strings,
  // without adding headers, reply-to, dynamic timestamps or provider templates.
  const frozenMessage = Object.freeze({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  const body = JSON.stringify(frozenMessage);
  if (encoder.encode(body).byteLength > TRANSACTIONAL_EMAIL_MAX_BODY_BYTES) {
    throw new TypeError("Invalid transactional email configuration.");
  }
  return Object.freeze({
    deliveryId: content.deliveryId,
    idempotencyKey: content.idempotencyKey,
    message: frozenMessage,
    body,
  });
}

async function fingerprint(snapshot: ReturnType<typeof snapshotContent>) {
  const bytes = encoder.encode(JSON.stringify([
    "dominion-transactional-email-v1",
    ENDPOINT,
    snapshot.deliveryId,
    snapshot.idempotencyKey,
    snapshot.body,
  ]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compute once when persisting the immutable rendered outbox payload. */
export function transactionalEmailFingerprint(
  content: TransactionalEmailContent,
) {
  return fingerprint(snapshotContent(content));
}

function timestamp(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/
      .test(value)
  ) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  const normalized = value.replace(/\+00:00$/, "Z").replace(
    /(?:\.(\d{1,6}))?Z$/,
    (_match, fraction: string | undefined) =>
      `.${(fraction || "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  return new Date(parsed).toISOString() === normalized ? parsed : null;
}

function windowFailure(
  first: number,
  now: number,
  timeoutMs: number,
): TransactionalEmailOutcome | null {
  if (!Number.isSafeInteger(now) || now <= 0 || first > now) {
    return { state: "needs_review", code: "clock_invalid" };
  }
  // Reserve the complete request deadline inside our conservative 23h window.
  if (now - first + timeoutMs >= TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS) {
    return { state: "needs_review", code: "retry_window_expired" };
  }
  return null;
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  let stop: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error("Email operation unconfirmed."));
    controller.signal.addEventListener("abort", stop, { once: true });
  });
  const timer = setTimeout(abort, timeoutMs);
  try {
    if (controller.signal.aborted) return { completed: false };
    // Promise.race also handles late rejection from an ignored-abort adapter.
    const value = await Promise.race([operation(controller.signal), cancelled]);
    return { completed: true, value };
  } catch {
    return { completed: false };
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
    controller.abort();
  }
}

async function responsePayload(response: Response, signal: AbortSignal) {
  if (!response.body) return null;
  const length = response.headers.get("content-length");
  if (
    length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  ) {
    void response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    if (signal.aborted) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function classify(status: number, payload: unknown): TransactionalEmailOutcome {
  if (status >= 200 && status < 300) {
    if (
      !exact(payload, ["id"]) || typeof payload.id !== "string" ||
      !UUID.test(payload.id)
    ) return { state: "needs_review", code: "receipt_invalid" };
    return { state: "accepted", emailId: payload.id };
  }
  const name = record(payload) ? payload.name : undefined;
  if (status === 409 && name === "invalid_idempotent_request") {
    return { state: "needs_review", code: "idempotency_conflict" };
  }
  if (status === 409 && name === "concurrent_idempotent_requests") {
    return { state: "retryable", code: "concurrent_request" };
  }
  if (
    status === 429 &&
    (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded")
  ) return { state: "needs_review", code: name };
  if (status === 429 && name === "rate_limit_exceeded") {
    return { state: "retryable", code: "rate_limited" };
  }
  if ([400, 401, 403, 404, 405, 422].includes(status)) {
    return { state: "needs_review", code: "provider_rejected" };
  }
  return { state: "uncertain", code: "request_unconfirmed" };
}

/** One bounded attempt only. The durable worker owns scheduling and outcomes. */
export async function deliverTransactionalEmail(
  job: TransactionalEmailJob,
  options: TransactionalEmailOptions,
): Promise<TransactionalEmailOutcome> {
  const snapshot = snapshotContent(job);
  const bindingFingerprint = job.bindingFingerprint;
  const firstDispatchedAt = job.firstDispatchedAt;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (
    typeof bindingFingerprint !== "string" || !HASH.test(bindingFingerprint) ||
    (firstDispatchedAt !== null && timestamp(firstDispatchedAt) === null) ||
    typeof options.apiKey !== "string" ||
    !/^re_[A-Za-z0-9_-]{1,250}$/.test(options.apiKey) ||
    typeof options.markDispatched !== "function" ||
    (options.fetcher !== undefined && typeof options.fetcher !== "function") ||
    (options.now !== undefined && typeof options.now !== "function") ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
  ) throw new TypeError("Invalid transactional email configuration.");
  const apiKey = options.apiKey;
  const markDispatched = options.markDispatched;
  const fetcher = options.fetcher || fetch;
  const clock = options.now || Date.now;
  const now = () => {
    try {
      return clock();
    } catch {
      return NaN;
    }
  };
  const parent = options.signal;
  if (await fingerprint(snapshot) !== bindingFingerprint) {
    return { state: "needs_review", code: "binding_mismatch" };
  }
  const initialNow = now();
  if (!Number.isSafeInteger(initialNow) || initialNow <= 0) {
    return { state: "needs_review", code: "clock_invalid" };
  }
  const priorTime = firstDispatchedAt === null
    ? null
    : timestamp(firstDispatchedAt)!;
  if (priorTime !== null) {
    const failure = windowFailure(priorTime, initialNow, timeoutMs);
    if (failure) return failure;
  }
  const binding = Object.freeze({
    deliveryId: snapshot.deliveryId,
    idempotencyKey: snapshot.idempotencyKey,
    bindingFingerprint,
    firstDispatchedAt,
  });
  const fenced = await bounded(
    (signal) => markDispatched(binding, signal),
    timeoutMs,
    parent,
  );
  if (!fenced.completed) {
    return { state: "uncertain", code: "dispatch_unconfirmed" };
  }
  if (fenced.value === null) {
    return { state: "retryable", code: "dispatch_not_owned" };
  }
  const receipt = fenced.value;
  const first = timestamp(receipt?.firstDispatchedAt);
  if (
    !exact(receipt, [
      "deliveryId",
      "idempotencyKey",
      "bindingFingerprint",
      "firstDispatchedAt",
    ]) ||
    receipt.deliveryId !== binding.deliveryId ||
    receipt.idempotencyKey !== binding.idempotencyKey ||
    receipt.bindingFingerprint !== binding.bindingFingerprint ||
    first === null ||
    (priorTime !== null && first !== priorTime)
  ) return { state: "needs_review", code: "dispatch_receipt_mismatch" };
  const failure = windowFailure(first, now(), timeoutMs);
  if (failure) return failure;
  const response = await bounded(
    async (signal) => {
      // Recheck after the durable fence and immediately before the network effect.
      const lateFailure = windowFailure(first, now(), timeoutMs);
      if (lateFailure) return lateFailure;
      const result = await fetcher(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": snapshot.idempotencyKey,
        },
        body: snapshot.body,
      });
      // Do not trust a manually supplied redirect response as a provider receipt.
      if (result.redirected || (result.url && result.url !== ENDPOINT)) {
        void result.body?.cancel().catch(() => {});
        return { state: "uncertain", code: "request_unconfirmed" } as const;
      }
      return classify(result.status, await responsePayload(result, signal));
    },
    timeoutMs,
    parent,
  );
  return response.completed
    ? response.value
    : { state: "uncertain", code: "request_unconfirmed" };
}
