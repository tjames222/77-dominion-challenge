import {
  type EnvReader,
  errorResponse,
  HttpError,
  isAllowedOrigin,
  jsonResponse,
  optionsResponse,
  readEnv,
} from "../_shared/http.ts";
import { createAdminClient, requireUser } from "../_shared/supabase.ts";

type Dependencies = {
  env: EnvReader;
  requireUser: typeof requireUser;
  createAdminClient: typeof createAdminClient;
  bodyTimeoutMs: number;
};

const defaults: Dependencies = {
  env: readEnv,
  requireUser,
  createAdminClient,
  bodyTimeoutMs: 5000,
};
const MAX_BODY_BYTES = 2048;

async function readInput(req: Request, timeoutMs: number) {
  if (
    req.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
  ) {
    throw new HttpError("Use a JSON request.", 415);
  }
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    throw new HttpError("The request is too large.", 413);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError("A request is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(new HttpError("The request timed out. Please try again.", 408)),
      timeoutMs,
    );
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new HttpError("The request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError("Enter a valid name and email.", 400);
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => !["name", "email", "website"].includes(key))
  ) {
    throw new HttpError("Enter a valid name and email.", 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  if (
    !name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name) ||
    email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    /[\u0000-\u001f\u007f]/u.test(email)
  ) {
    throw new HttpError("Enter a valid name and email.", 400);
  }
  if (body.website !== undefined && typeof body.website !== "string") {
    throw new HttpError("Enter a valid name and email.", 400);
  }
  return { name, email, honeypot: Boolean(body.website) };
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async (req: Request): Promise<Response> => {
    let response;
    try {
      if (!isAllowedOrigin(req.headers.get("origin"), deps.env)) {
        throw new HttpError("Request origin is not allowed.", 403);
      }
      if (req.method === "OPTIONS") {
        const options = optionsResponse(req, deps.env);
        options.headers.set("Cache-Control", "private, no-store");
        return options;
      }
      if (req.method !== "POST") {
        throw new HttpError("Method not allowed.", 405);
      }
      const input = await readInput(req, deps.bodyTimeoutMs);
      let userId = null;
      const authorization = req.headers.get("authorization");
      if (authorization) {
        const user = await deps.requireUser(req, { env: deps.env });
        if (
          !user.email_confirmed_at || user.is_anonymous ||
          user.email?.toLowerCase() !== input.email
        ) {
          throw new HttpError(
            "Use the verified email for your signed-in account.",
            403,
          );
        }
        userId = user.id;
      }
      if (!input.honeypot) {
        const client = deps.createAdminClient({ env: deps.env });
        const { data, error } = await client.rpc(
          "submit_early_access_request_service",
          {
            p_name: input.name,
            p_email: input.email,
            p_user_id: userId,
          },
        );
        if (
          (error?.code === "P0001" &&
            error.message === "EARLY_ACCESS_RATE_LIMIT") ||
          error?.code === "55P03"
        ) {
          throw new HttpError(
            "Requests are busy right now. Please try again in an hour.",
            429,
          );
        }
        if (error?.code === "42501") {
          throw new HttpError(
            "Please sign in again and use your verified account email.",
            403,
          );
        }
        if (error || data?.received !== true) {
          throw new Error("Early-access intake failed.");
        }
      }
      response = jsonResponse({ received: true }, 200, req, deps.env);
    } catch (error) {
      response = errorResponse(
        error,
        "We couldn’t save your request. Please try again.",
        req,
        deps.env,
      );
    }
    response.headers.set("Cache-Control", "private, no-store");
    if (response.status === 429) response.headers.set("Retry-After", "3600");
    return response;
  };
}

if (import.meta.main) Deno.serve(createHandler());
