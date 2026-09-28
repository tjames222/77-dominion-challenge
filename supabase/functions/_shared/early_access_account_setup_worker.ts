import {
  bootstrapNewEarlyAccessAccount,
  type EarlyAccessAuthBootstrapDependencies,
} from "./early_access_auth_bootstrap.ts";
import {
  type EarlyAccessInvitationEnvelope,
  type EarlyAccessInvitationKey,
} from "./early_access_invitation.ts";
import {
  createEarlyAccessRecoveryMail,
  EARLY_ACCESS_AUTH_ORIGIN,
  EARLY_ACCESS_AUTH_REDIRECT,
  EARLY_ACCESS_AUTH_TTL_SECONDS,
  type EarlyAccessRecoveryBinding,
  openEarlyAccessRecoveryMail,
} from "./early_access_recovery_mail.ts";
import {
  deliverTransactionalEmail,
  type TransactionalEmailDispatchReceipt,
  type TransactionalEmailOutcome,
} from "./transactional_email.ts";

type Value = Record<string, unknown>;
export type AccountSetupWorkerDependencies = Readonly<{
  rpc: (name: string, args: Value, signal: AbortSignal) => Promise<unknown>;
  auth: (signal: AbortSignal) => EarlyAccessAuthBootstrapDependencies;
  fetcher: typeof fetch;
  now: () => number;
  authTimeoutMs: number;
  emailTimeoutMs: number;
}>;
export type AccountSetupSettings = Readonly<{
  apiKey: string;
  sender: string;
  invitationKey: EarlyAccessInvitationKey;
}>;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
function fail(): never {
  throw new Error("Account setup worker unavailable.");
}
function snapshot(value: unknown, keys: readonly string[]) {
  if (
    value === null || typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  ) fail();
  const result: Value = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
function claim(value: unknown, keys: readonly string[]) {
  if (!Array.isArray(value) || value.length > 1) fail();
  return value.length ? snapshot(value[0], keys) : null;
}
function clock(now: () => number) {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) fail();
  return value;
}
function timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
      value,
    )
  ) return false;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return false;
  const normalized = value.replace(/\+00:00$/, "Z").replace(
    /(?:\.(\d{1,6}))?Z$/,
    (_match, fraction: string | undefined) =>
      `.${(fraction || "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  return new Date(parsed).toISOString() === normalized;
}
async function nativeCall<T>(
  d: AccountSetupWorkerDependencies,
  signal: AbortSignal,
  operation: (auth: EarlyAccessAuthBootstrapDependencies) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let rejectAbort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () =>
      reject(new Error("Account setup native request unavailable."));
  });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(abort, d.authTimeoutMs);
  try {
    if (controller.signal.aborted) fail();
    return await Promise.race([
      operation(d.auth(controller.signal)),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}
export async function processEarlyAccessBootstrap(
  worker: string,
  settings: AccountSetupSettings,
  d: AccountSetupWorkerDependencies,
  signal: AbortSignal,
) {
  const job = claim(
    await d.rpc("claim_early_access_account_bootstraps", {
      target_worker_token: worker,
      target_batch_size: 1,
    }, signal),
    [
      "requestId",
      "generationId",
      "reservedUserId",
      "deliveryId",
      "recipient",
      "invitationExpiresAt",
    ],
  );
  if (!job) return "empty";
  if (
    [job.requestId, job.generationId, job.reservedUserId, job.deliveryId].some(
      (id) => typeof id !== "string" || !UUID.test(id),
    ) ||
    typeof job.recipient !== "string" || job.recipient.length > 254 ||
    !EMAIL.test(job.recipient) || !timestamp(job.invitationExpiresAt)
  ) fail();
  const common = {
    target_generation_id: job.generationId,
    target_worker_token: worker,
  };
  try {
    const startedAt = clock(d.now);
    if (Date.parse(job.invitationExpiresAt) <= startedAt + 30000) fail();
    const started = await d.rpc(
      "start_early_access_account_bootstrap",
      common,
      signal,
    );
    if (started === false) return "lease_lost";
    if (started !== true) fail();
    // Native side effects begin only after the one-way durable start marker.
    // Each method is bounded; the helper can reconcile create only by reserved ID.
    const material = await bootstrapNewEarlyAccessAccount({
      reservedUserId: job.reservedUserId as string,
      canonicalEmail: job.recipient,
      redirectTo: EARLY_ACCESS_AUTH_REDIRECT,
      allowedRedirects: [EARLY_ACCESS_AUTH_REDIRECT],
      authOrigin: EARLY_ACCESS_AUTH_ORIGIN,
      nowMs: startedAt,
    }, {
      createUser: (attributes) =>
        nativeCall(d, signal, (auth) => auth.createUser(attributes)),
      getUserById: (id) =>
        nativeCall(d, signal, (auth) => auth.getUserById(id)),
      generateLink: (parameters) =>
        nativeCall(d, signal, (auth) => auth.generateLink(parameters)),
    });
    const issuedAt = clock(d.now);
    const expiresAt = Math.min(
      startedAt + EARLY_ACCESS_AUTH_TTL_SECONDS * 1000 - 30000,
      Date.parse(job.invitationExpiresAt),
    );
    if (issuedAt < startedAt || expiresAt <= issuedAt) fail();
    const binding = Object.freeze({
      requestId: job.requestId as string,
      generationId: job.generationId as string,
      deliveryId: job.deliveryId as string,
      reservedUserId: material.userId,
      recipient: material.recipient,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      from: settings.sender,
    });
    const sealed = await createEarlyAccessRecoveryMail(
      binding,
      material.recoveryActionLink,
      settings.invitationKey,
    );
    const persisted = await d.rpc("persist_early_access_account_setup", {
      ...common,
      target_binding: binding,
      target_envelope: sealed.envelope,
      target_content_fingerprint: sealed.contentFingerprint,
      target_idempotency_key: sealed.idempotencyKey,
    }, signal);
    if (persisted !== true && persisted !== false) fail();
    return persisted ? "prepared" : "lease_lost";
  } catch {
    // A crash/unknown native call is terminal for this generation. Never repeat
    // generateLink or adopt another account found only by canonical email.
    const settled = await d.rpc("settle_early_access_account_bootstrap", {
      ...common,
      target_code: "bootstrap_unavailable",
    }, signal);
    if (settled !== true && settled !== false) fail();
    return settled ? "needs_review" : "lease_lost";
  }
}
export async function processEarlyAccessSetupMail(
  worker: string,
  settings: AccountSetupSettings,
  d: AccountSetupWorkerDependencies,
  signal: AbortSignal,
) {
  const job = claim(
    await d.rpc("claim_early_access_account_setup_deliveries", {
      target_worker_token: worker,
      target_batch_size: 1,
    }, signal),
    [
      "deliveryId",
      "binding",
      "envelope",
      "contentFingerprint",
      "idempotencyKey",
      "firstDispatchedAt",
    ],
  );
  if (!job) return "empty";
  if (typeof job.deliveryId !== "string" || !UUID.test(job.deliveryId)) fail();
  const common = {
    target_delivery_id: job.deliveryId,
    target_worker_token: worker,
  };
  let outcome: TransactionalEmailOutcome | {
    state: "needs_review";
    code: "worker_delivery_unavailable";
  };
  try {
    const binding = snapshot(job.binding, [
      "requestId",
      "generationId",
      "deliveryId",
      "reservedUserId",
      "recipient",
      "issuedAt",
      "expiresAt",
      "from",
    ]);
    if (
      binding.deliveryId !== job.deliveryId ||
      binding.from !== settings.sender ||
      !(job.firstDispatchedAt === null || timestamp(job.firstDispatchedAt)) ||
      !timestamp(binding.expiresAt) ||
      Date.parse(binding.expiresAt) <= clock(d.now)
    ) fail();
    const content = await openEarlyAccessRecoveryMail(
      job.envelope as EarlyAccessInvitationEnvelope,
      binding as EarlyAccessRecoveryBinding,
      settings.invitationKey,
      {
        contentFingerprint: job.contentFingerprint as string,
        idempotencyKey: job.idempotencyKey as string,
      },
    );
    outcome = await deliverTransactionalEmail({
      ...content,
      bindingFingerprint: job.contentFingerprint as string,
      firstDispatchedAt: job.firstDispatchedAt as string | null,
    }, {
      apiKey: settings.apiKey,
      fetcher: d.fetcher,
      now: d.now,
      signal,
      timeoutMs: d.emailTimeoutMs,
      markDispatched: async (_binding, dispatchSignal) =>
        await d.rpc("mark_early_access_account_setup_dispatched", {
          ...common,
          target_content_fingerprint: job.contentFingerprint,
        }, dispatchSignal) as TransactionalEmailDispatchReceipt | null,
    });
  } catch {
    outcome = { state: "needs_review", code: "worker_delivery_unavailable" };
  }
  const settled = await d.rpc("settle_early_access_account_setup_delivery", {
    ...common,
    target_outcome: outcome.state,
    target_code: "code" in outcome ? outcome.code : null,
    target_receipt_id: "emailId" in outcome ? outcome.emailId : null,
  }, signal);
  if (settled !== true && settled !== false) fail();
  return settled ? outcome.state : "lease_lost";
}
