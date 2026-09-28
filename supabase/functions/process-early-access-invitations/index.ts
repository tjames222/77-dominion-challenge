import { createAdminClient } from "../_shared/supabase.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.110.7";
import { type EarlyAccessAuthBootstrapDependencies } from "../_shared/early_access_auth_bootstrap.ts";
import {
  processEarlyAccessBootstrap,
  processEarlyAccessSetupMail,
} from "../_shared/early_access_account_setup_worker.ts";
import {
  EARLY_ACCESS_AUTH_ORIGIN,
  EARLY_ACCESS_AUTH_TTL_SECONDS,
} from "../_shared/early_access_recovery_mail.ts";
import { type EnvReader, readEnv } from "../_shared/http.ts";
import {
  type EarlyAccessInvitationBinding,
  type EarlyAccessInvitationEnvelope,
  type EarlyAccessInvitationKey,
  openEarlyAccessInvitation,
} from "../_shared/early_access_invitation.ts";
import {
  deliverTransactionalEmail,
  type TransactionalEmailDispatchReceipt,
  type TransactionalEmailOutcome,
} from "../_shared/transactional_email.ts";

type Rpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
type Dependencies = {
  env: EnvReader;
  rpc: Rpc;
  fetcher: typeof fetch;
  randomUuid: () => string;
  rpcTimeoutMs: number;
  emailTimeoutMs: number;
  now: () => number;
  auth: (signal: AbortSignal) => EarlyAccessAuthBootstrapDependencies;
  authTimeoutMs: number;
};
type Settings = Readonly<{
  apiKey: string;
  sender: string;
  invitationKey: EarlyAccessInvitationKey;
  bootstrapEnabled: boolean;
}>;
type RecordValue = Record<string, unknown>;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLAIM_KEYS = [
  "deliveryId",
  "binding",
  "envelope",
  "tokenDigest",
  "contentFingerprint",
  "idempotencyKey",
  "firstDispatchedAt",
];
const BINDING_KEYS = [
  "requestId",
  "generationId",
  "deliveryId",
  "recipient",
  "issuedAt",
  "expiresAt",
  "from",
];
class DatabaseUnavailable extends Error {
  constructor() {
    super("Invitation database request unavailable.");
  }
}
function snapshot(value: unknown, keys: readonly string[]) {
  if (
    value === null || typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  ) throw new Error("Invalid invitation claim.");
  const result: RecordValue = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Error("Invalid invitation claim.");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
function configuredSender(value: string) {
  if (value.length > 322) return false;
  const named = /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}) <([^<>]+)>$/.exec(value);
  const mailbox = named ? named[2] : value;
  return mailbox.length <= 254 && mailbox.endsWith("@mail.77dominion.com") &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
      .test(mailbox);
}
function settings(env: EnvReader): Settings {
  const apiKey = env("RESEND_API_KEY") || "";
  const sender = env("TRANSACTIONAL_EMAIL_FROM") || "";
  const encoded = env("EARLY_ACCESS_INVITATION_KEY") || "";
  const version = env("EARLY_ACCESS_INVITATION_KEY_VERSION") || "";
  const bootstrap = env("EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED") || "false";
  if (
    !/^re_[A-Za-z0-9_-]{1,250}$/.test(apiKey) || !configuredSender(sender) ||
    !/^[A-Za-z0-9_-]{43}$/.test(encoded) ||
    !/^[1-9][0-9]{0,9}$/.test(version) ||
    Number(version) > 2147483647 || !["true", "false"].includes(bootstrap) ||
    (bootstrap === "true" &&
      (env("SUPABASE_URL") !== EARLY_ACCESS_AUTH_ORIGIN ||
        env("EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS") !==
          String(EARLY_ACCESS_AUTH_TTL_SECONDS)))
  ) throw new Error("Invitation delivery is not configured.");
  const key = Uint8Array.from(
    atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
  const canonical = btoa(String.fromCharCode(...key)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/, "");
  if (key.byteLength !== 32 || canonical !== encoded) {
    throw new Error("Invitation delivery is not configured.");
  }
  return Object.freeze({
    apiKey,
    sender,
    invitationKey: Object.freeze({ keyVersion: Number(version), key }),
    bootstrapEnabled: bootstrap === "true",
  });
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
async function equalSecret(expected: string, actual: string) {
  if (
    expected.length < 32 || expected.length > 512 || !actual ||
    actual.length > 512
  ) return false;
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [left, right] = (await Promise.all([digest(expected), digest(actual)]))
    .map((value) => new Uint8Array(value));
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
async function boundedRpc(
  dependencies: Dependencies,
  name: string,
  args: RecordValue,
  parent: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new DatabaseUnavailable());
  });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(abort, dependencies.rpcTimeoutMs);
  try {
    if (controller.signal.aborted) throw new DatabaseUnavailable();
    return await Promise.race([
      dependencies.rpc(name, args, controller.signal),
      cancelled,
    ]);
  } catch {
    throw new DatabaseUnavailable();
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}
function claim(value: unknown) {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Invalid invitation claim.");
  }
  if (!value.length) return null;
  const job = snapshot(value[0], CLAIM_KEYS);
  if (typeof job.deliveryId !== "string" || !UUID.test(job.deliveryId)) {
    throw new Error("Invalid invitation claim.");
  }
  return job;
}
function timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/
      .test(value)
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
async function processInvitation(
  worker: string,
  configured: Settings,
  dependencies: Dependencies,
  signal: AbortSignal,
) {
  const job = claim(
    await boundedRpc(
      dependencies,
      "claim_early_access_invitation_deliveries",
      {
        target_worker_token: worker,
        target_batch_size: 1,
      },
      signal,
    ),
  );
  if (!job) return "empty";
  const common = Object.freeze({
    target_delivery_id: job.deliveryId,
    target_worker_token: worker,
  });
  let outcome: TransactionalEmailOutcome | {
    state: "needs_review" | "uncertain";
    code: "worker_database_unavailable" | "worker_delivery_unavailable";
  };
  try {
    const binding = snapshot(job.binding, BINDING_KEYS);
    const envelope = snapshot(job.envelope, [
      "version",
      "keyVersion",
      "nonce",
      "ciphertext",
    ]);
    if (
      binding.deliveryId !== job.deliveryId ||
      binding.from !== configured.sender ||
      !(job.firstDispatchedAt === null || timestamp(job.firstDispatchedAt))
    ) throw new Error("Invalid invitation binding.");
    const content = await openEarlyAccessInvitation(
      envelope as EarlyAccessInvitationEnvelope,
      binding as EarlyAccessInvitationBinding,
      configured.invitationKey,
      {
        tokenDigest: job.tokenDigest as string,
        contentFingerprint: job.contentFingerprint as string,
        idempotencyKey: job.idempotencyKey as string,
      },
    );
    outcome = await deliverTransactionalEmail({
      ...content,
      bindingFingerprint: job.contentFingerprint as string,
      firstDispatchedAt: job.firstDispatchedAt as string | null,
    }, {
      apiKey: configured.apiKey,
      fetcher: dependencies.fetcher,
      now: dependencies.now,
      signal,
      timeoutMs: dependencies.emailTimeoutMs,
      // SQL atomically fences the current lease/generation/expiry/revocation
      // and free quota, persisting the original first-dispatch time BEFORE POST.
      markDispatched: async (_binding, dispatchSignal) =>
        await boundedRpc(
          dependencies,
          "mark_early_access_invitation_dispatched",
          {
            ...common,
            target_content_fingerprint: job.contentFingerprint,
            target_token_digest: job.tokenDigest,
          },
          dispatchSignal,
        ) as TransactionalEmailDispatchReceipt | null,
    });
  } catch (error) {
    // Never log/reflect decrypted content, tokens, identities, ciphertext,
    // provider response bodies, secret configuration or underlying errors.
    outcome = error instanceof DatabaseUnavailable
      ? { state: "uncertain", code: "worker_database_unavailable" }
      : { state: "needs_review", code: "worker_delivery_unavailable" };
  }
  const settled = await boundedRpc(
    dependencies,
    "settle_early_access_invitation_delivery",
    {
      ...common,
      target_outcome: outcome.state,
      target_code: "code" in outcome ? outcome.code : null,
      target_receipt_id: "emailId" in outcome ? outcome.emailId : null,
    },
    signal,
  );
  if (settled !== true && settled !== false) throw new DatabaseUnavailable();
  return settled ? outcome.state : "lease_lost";
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: readEnv,
    fetcher: fetch,
    randomUuid: () => crypto.randomUUID(),
    rpcTimeoutMs: 10000,
    emailTimeoutMs: 10000,
    authTimeoutMs: 10000,
    now: Date.now,
    auth: (signal) => {
      const key = dependencies.env("SUPABASE_SERVICE_ROLE_KEY");
      if (!key) throw new Error("Account setup is not configured.");
      const client = createClient(EARLY_ACCESS_AUTH_ORIGIN, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: (input, init) =>
            dependencies.fetcher(input, {
              ...init,
              signal,
              redirect: "error",
              cache: "no-store",
            }),
        },
      });
      return {
        createUser: (attributes) => client.auth.admin.createUser(attributes),
        getUserById: (id) => client.auth.admin.getUserById(id),
        generateLink: (parameters) =>
          client.auth.admin.generateLink(parameters),
      };
    },
    rpc: async (name, args, signal) => {
      const { data, error } = await createAdminClient({ env: dependencies.env })
        .rpc(name, args).abortSignal(signal);
      if (error) throw new DatabaseUnavailable();
      return data;
    },
    ...overrides,
  };
  for (
    const timeout of [
      dependencies.rpcTimeoutMs,
      dependencies.emailTimeoutMs,
      dependencies.authTimeoutMs,
    ]
  ) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) {
      throw new TypeError("Invalid invitation worker configuration.");
    }
  }
  return async (request: Request) => {
    if (request.method !== "POST") {
      return response({ error: "Method not allowed." }, 405);
    }
    try {
      if (
        !await equalSecret(
          dependencies.env("EARLY_ACCESS_INVITATION_WORKER_SECRET") || "",
          request.headers.get("x-dominion-worker-key") || "",
        )
      ) return response({ error: "Unauthorized." }, 401);
      // The body is intentionally not consumed: no user-selected IDs, tokens,
      // recipients, payloads or redrive can influence a service-only claim.
      const configured = settings(dependencies.env);
      const worker = dependencies.randomUuid();
      if (typeof worker !== "string" || !UUID.test(worker)) {
        throw new Error("Worker identity unavailable.");
      }
      const setupResults: Record<string, string> = {};
      if (configured.bootstrapEnabled) {
        const setupDependencies = {
          ...dependencies,
          rpc: (name: string, args: RecordValue, signal: AbortSignal) =>
            boundedRpc(dependencies, name, args, signal),
        };
        setupResults.bootstrap = await processEarlyAccessBootstrap(
          worker,
          configured,
          setupDependencies,
          request.signal,
        );
        setupResults.setupEmail = await processEarlyAccessSetupMail(
          worker,
          configured,
          setupDependencies,
          request.signal,
        );
      }
      return response({
        ...setupResults,
        email: await processInvitation(
          worker,
          configured,
          dependencies,
          request.signal,
        ),
      });
    } catch {
      return response({ email: "unavailable" }, 503);
    }
  };
}
export const handler = createHandler();
if (import.meta.main) Deno.serve(handler);
