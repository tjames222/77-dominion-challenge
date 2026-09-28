import { createClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  type EnvReader,
  HttpError,
  isAllowedOrigin,
  jsonResponse,
  optionsResponse,
  readEnv,
} from "../_shared/http.ts";
import {
  createEarlyAccessInvitation,
  EARLY_ACCESS_INVITATION_LIFETIME_MS,
  type EarlyAccessInvitationKey,
} from "../_shared/early_access_invitation.ts";

type Rpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
type Intent = Readonly<{
  action: "approve" | "resend" | "revoke";
  expectedActorId: string;
  requestId: string;
  expectedRevision: string;
  operationId: string;
  correlationId: string;
}>;
type Dependencies = {
  env: EnvReader;
  createRpc: (req: Request, env: EnvReader) => Rpc;
  now: () => number;
  randomUuid: () => string;
  bodyTimeoutMs: number;
  rpcTimeoutMs: number;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTENT_KEYS = [
  "action",
  "expectedActorId",
  "requestId",
  "expectedRevision",
  "operationId",
  "correlationId",
];
const FAILURE_CODES = new Set([
  "invalid_input",
  "revision_conflict",
  "target_unavailable",
  "invalid_state",
  "rate_limited",
  "account_unavailable",
  "account_recovery_required",
  "program_unavailable",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dataRecord(value: unknown): Record<string, unknown> | null {
  if (
    !record(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100) return null;
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function revision(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;
}
function invalid(): never {
  throw new HttpError("Invalid invitation request.", 400);
}
function unavailable(): never {
  throw new HttpError(
    "Invitation service is unavailable. Retry the same operation.",
    503,
  );
}

// The original user's bearer AND Origin reach PostgREST. SQL independently
// checks native Auth session/MFA/admin authority under its lifecycle locks.
// Never replace this with a service-role client plus caller-supplied actor IDs.
export function createInvitationUserRpc(
  req: Request,
  env: EnvReader,
  fetcher: typeof fetch = fetch,
): Rpc {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_ANON_KEY");
  if (!url || !key) unavailable();
  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: req.headers.get("authorization") || "",
        Origin: req.headers.get("origin") || "",
      },
      fetch: fetcher,
    },
  });
  return async (name, args, signal) => {
    const { data, error } = await client.rpc(name, args).abortSignal(signal);
    if (error) {
      if (error.code === "PT401" || error.code === "PGRST301") {
        throw new HttpError("Sign in again before managing invitations.", 401);
      }
      if (error.code === "PT403" || error.code === "42501") {
        throw new HttpError(
          "Admin permission and recent MFA are required.",
          403,
        );
      }
      if (error.code === "PT404") {
        throw new HttpError("Request not found.", 404);
      }
      if (
        error.code === "22023" && error.message === "admin_idempotency_conflict"
      ) {
        throw new HttpError(
          "This operation ID was already used for different input.",
          409,
        );
      }
      if (error.code === "22023") invalid();
      unavailable();
    }
    return data;
  };
}

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  req: Request,
  milliseconds: number,
  status = 503,
): Promise<T> {
  const controller = new AbortController();
  const fail = () =>
    new HttpError(
      "The request did not complete. Retry the same operation.",
      status,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(fail());
    };
    timer = setTimeout(onAbort, milliseconds);
    req.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (req.signal.aborted) throw fail();
    return await Promise.race([work(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function readIntent(req: Request, timeoutMs: number): Promise<Intent> {
  if (
    req.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
  ) {
    throw new HttpError("Use a JSON request.", 415);
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && !/^[0-9]+$/.test(declared)) invalid();
  if (Number(declared || 0) > 2048) {
    throw new HttpError("Request too large.", 413);
  }
  const reader = req.body?.getReader();
  if (!reader) invalid();
  const bytes = new Uint8Array(2048);
  let size = 0;
  try {
    await bounded(
      async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (size + value.byteLength > bytes.byteLength) {
            throw new HttpError("Request too large.", 413);
          }
          bytes.set(value, size);
          size += value.byteLength;
        }
      },
      req,
      timeoutMs,
      408,
    );
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } catch {
    invalid();
  }
  if (
    !exact(body, INTENT_KEYS) ||
    !["approve", "resend", "revoke"].includes(String(body.action)) ||
    ![
      body.expectedActorId,
      body.requestId,
      body.operationId,
      body.correlationId,
    ].every(
      (id) => typeof id === "string" && UUID.test(id),
    ) || !revision(body.expectedRevision)
  ) invalid();
  return Object.freeze(body) as Intent;
}

function invitationKey(env: EnvReader): EarlyAccessInvitationKey {
  const encoded = env("EARLY_ACCESS_INVITATION_KEY");
  const version = env("EARLY_ACCESS_INVITATION_KEY_VERSION");
  if (
    !encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded) ||
    !version || !/^[1-9][0-9]{0,9}$/.test(version) ||
    Number(version) > 2147483647
  ) unavailable();
  const bytes = Uint8Array.from(
    atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/, "");
  if (bytes.length !== 32 || canonical !== encoded) unavailable();
  return { keyVersion: Number(version), key: bytes };
}

function recipientFromDetail(value: unknown, intent: Intent): string {
  value = dataRecord(value);
  const item = record(value) ? dataRecord(value.item) : null;
  if (
    !record(value) || value.schemaVersion !== 1 ||
    value.actorId !== intent.expectedActorId ||
    !item || item.id !== intent.requestId ||
    typeof item.email !== "string" || !revision(item.revision)
  ) unavailable();
  // The mail helper validates the canonical mailbox. SQL rechecks it under lock.
  return item.email;
}

function safeReceipt(value: unknown, intent: Intent) {
  value = dataRecord(value);
  if (
    exact(value, ["ok", "errorCode"]) && value.ok === false &&
    typeof value.errorCode === "string" && FAILURE_CODES.has(value.errorCode)
  ) {
    return { ok: false, errorCode: value.errorCode };
  }
  if (
    !exact(value, ["ok", "requestId", "status", "revision"]) ||
    value.ok !== true ||
    value.requestId !== intent.requestId || !revision(value.revision) ||
    BigInt(value.revision) !== BigInt(intent.expectedRevision) + 1n ||
    value.status !== (intent.action === "revoke" ? "revoked" : "approved")
  ) unavailable();
  return {
    ok: true,
    requestId: value.requestId,
    status: value.status,
    revision: value.revision,
  };
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    env: readEnv,
    createRpc: createInvitationUserRpc,
    now: Date.now,
    randomUuid: () => crypto.randomUUID(),
    bodyTimeoutMs: 5000,
    rpcTimeoutMs: 10000,
    ...overrides,
  };
  return async (req: Request) => {
    let response: Response;
    try {
      const origin = req.headers.get("origin");
      if (
        !origin || !isAllowedOrigin(origin, deps.env) ||
        new URL(origin).origin !== origin
      ) {
        throw new HttpError("Request origin is not allowed.", 403);
      }
      if (req.method === "OPTIONS") response = optionsResponse(req, deps.env);
      else {
        if (req.method !== "POST") {
          throw new HttpError("Method not allowed.", 405);
        }
        const bearer = req.headers.get("authorization") || "";
        if (bearer.length > 8192 || !/^Bearer [^\s,]+$/i.test(bearer)) {
          throw new HttpError("Sign in before managing invitations.", 401);
        }
        const intent = await readIntent(req, deps.bodyTimeoutMs);
        const rpc = deps.createRpc(req, deps.env);
        const args: Record<string, unknown> = {
          target_expected_actor_id: intent.expectedActorId,
          target_action: intent.action,
          target_request_id: intent.requestId,
          target_expected_revision: intent.expectedRevision,
          target_operation_id: intent.operationId,
          target_correlation_id: intent.correlationId,
          target_binding: null,
          target_token_digest: null,
          target_content_fingerprint: null,
          target_idempotency_key: null,
          target_envelope: null,
        };
        if (intent.action !== "revoke") {
          const detail = await bounded(
            (signal) =>
              rpc("site_admin_get_early_access_request", {
                target_expected_actor_id: intent.expectedActorId,
                target_request_id: intent.requestId,
              }, signal),
            req,
            deps.rpcTimeoutMs,
          );
          const recipient = recipientFromDetail(detail, intent);
          const issued = deps.now();
          const binding = Object.freeze({
            requestId: intent.requestId,
            generationId: deps.randomUuid(),
            deliveryId: deps.randomUuid(),
            recipient,
            issuedAt: new Date(issued).toISOString(),
            expiresAt: new Date(issued + EARLY_ACCESS_INVITATION_LIFETIME_MS)
              .toISOString(),
            from: deps.env("TRANSACTIONAL_EMAIL_FROM") || "",
          });
          const sealed = await createEarlyAccessInvitation(
            binding,
            invitationKey(deps.env),
          );
          Object.assign(args, {
            target_binding: binding,
            target_token_digest: sealed.tokenDigest,
            target_content_fingerprint: sealed.contentFingerprint,
            target_idempotency_key: sealed.idempotencyKey,
            target_envelope: sealed.envelope,
          });
        }
        const result = await bounded(
          (signal) =>
            rpc("site_admin_write_early_access_invitation", args, signal),
          req,
          deps.rpcTimeoutMs,
        );
        response = jsonResponse(
          safeReceipt(result, intent),
          200,
          req,
          deps.env,
        );
      }
    } catch (error) {
      const known = error instanceof HttpError;
      response = jsonResponse(
        {
          error: known
            ? error.message
            : "Invitation service is unavailable. Retry the same operation.",
        },
        known ? error.status : 503,
        req,
        deps.env,
      );
    }
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  };
}

if (import.meta.main) Deno.serve(createHandler());
