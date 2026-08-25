import { createAdminClient } from "../_shared/supabase.ts";
import { type EnvReader, readEnv } from "../_shared/http.ts";

type AdminClient = ReturnType<typeof createAdminClient>;
type StorageFile = { id?: string | null; name?: string | null };
type CleanupClaim = {
  job_id: string;
  user_id: string;
  storage_path: string;
  storage_object_id: string | null;
  claim_token: string;
};
type Dependencies = {
  createAdminClient: typeof createAdminClient;
  env: EnvReader;
  delay: (milliseconds: number) => Promise<void>;
  logger: Pick<Console, "info" | "error">;
};

const defaultDependencies: Dependencies = {
  createAdminClient,
  env: readEnv,
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger: console,
};

const bucket = "profile-photos";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pathPattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/avatar-[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|heic|heif)$/i;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function validWorkerSecret(req: Request, env: EnvReader) {
  const expected = env("PROFILE_PHOTO_WORKER_SECRET") || "";
  const provided = req.headers.get("x-dominion-worker-key") || "";
  if (expected.length < 32 || !provided) return false;
  const [left, right] = await Promise.all([digest(expected), digest(provided)]);
  return constantTimeEqual(left, right);
}

async function rpc<T>(
  admin: AdminClient,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`Profile-photo cleanup RPC failed: ${name}.`);
  return data as T;
}

function safeClaim(value: unknown): CleanupClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid cleanup claim.");
  }
  const claim = value as Record<string, unknown>;
  const pathMatch = typeof claim.storage_path === "string"
    ? claim.storage_path.match(pathPattern)
    : null;
  if (
    typeof claim.job_id !== "string" || !uuidPattern.test(claim.job_id) ||
    typeof claim.user_id !== "string" || !uuidPattern.test(claim.user_id) ||
    !pathMatch || pathMatch[1].toLowerCase() !== claim.user_id.toLowerCase() ||
    (claim.storage_object_id !== null &&
      (typeof claim.storage_object_id !== "string" ||
        !uuidPattern.test(claim.storage_object_id))) ||
    typeof claim.claim_token !== "string" ||
    !uuidPattern.test(claim.claim_token)
  ) throw new Error("Invalid cleanup claim.");
  return claim as CleanupClaim;
}

function splitObjectPath(objectName: string) {
  const parts = objectName.split("/");
  const name = parts.pop()!;
  return { folder: parts.join("/"), name };
}

async function findExactObject(
  admin: AdminClient,
  objectName: string,
) {
  const { folder, name } = splitObjectPath(objectName);
  let offset = 0;
  let exact: StorageFile | null = null;
  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(folder, {
      limit: 100,
      offset,
      search: name,
      sortBy: { column: "name", order: "asc" },
    });
    if (error || !Array.isArray(data)) {
      throw new Error("Profile-photo Storage inventory could not be read.");
    }
    for (const file of data as StorageFile[]) {
      if (file.id && file.name === name) {
        if (exact) {
          throw new Error("Profile-photo Storage identity is ambiguous.");
        }
        exact = file;
      }
    }
    if (data.length < 100) return exact;
    offset += data.length;
  }
}

async function processClaim(
  admin: AdminClient,
  claim: CleanupClaim,
) {
  const verified = await rpc<boolean>(
    admin,
    "verify_profile_photo_cleanup_service",
    {
      target_job_id: claim.job_id,
      target_claim_token: claim.claim_token,
    },
  );
  if (verified !== true) throw new Error("Cleanup claim no longer verifies.");

  const current = await findExactObject(admin, claim.storage_path);
  if (current) {
    if (!claim.storage_object_id || current.id !== claim.storage_object_id) {
      throw new Error("Profile-photo Storage object identity changed.");
    }
    const { error } = await admin.storage.from(bucket).remove([
      claim.storage_path,
    ]);
    if (error && await findExactObject(admin, claim.storage_path)) {
      throw new Error("Profile-photo Storage deletion failed.");
    }
  }
  if (await findExactObject(admin, claim.storage_path)) {
    throw new Error("Profile-photo object remains after deletion.");
  }
  const confirmed = await rpc<boolean>(
    admin,
    "confirm_profile_photo_cleanup_service",
    {
      target_job_id: claim.job_id,
      target_claim_token: claim.claim_token,
    },
  );
  if (confirmed !== true) throw new Error("Cleanup claim was not confirmed.");
}

async function withRetries(
  operation: () => Promise<void>,
  dependencies: Dependencies,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await dependencies.delay(100);
    }
  }
  throw lastError;
}

function boundedLimit(value: unknown) {
  const parsed = Number(value ?? 25);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Invalid cleanup batch limit.");
  }
  return parsed;
}

async function body(req: Request) {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async (req: Request) => {
    if (req.method !== "POST") {
      return response({ error: "Method not allowed." }, 405);
    }
    if (!await validWorkerSecret(req, dependencies.env)) {
      return response({ error: "Not authorized." }, 401);
    }

    try {
      const requestBody = await body(req);
      const admin = dependencies.createAdminClient();
      if (requestBody.mode === "health") {
        const health = await rpc(admin, "profile_photo_cleanup_health");
        return response({ status: "ok", health });
      }

      const limit = boundedLimit(requestBody.limit);
      const claims = (await rpc<unknown[]>(
        admin,
        "claim_profile_photo_cleanup_service",
        { target_limit: limit },
      ) || []).map(safeClaim);
      const counts = { claimed: claims.length, confirmed: 0, failed: 0 };
      for (const claim of claims) {
        try {
          await withRetries(() => processClaim(admin, claim), dependencies);
          counts.confirmed += 1;
        } catch {
          counts.failed += 1;
          try {
            await rpc(admin, "fail_profile_photo_cleanup_service", {
              target_job_id: claim.job_id,
              target_claim_token: claim.claim_token,
              target_error_code: "storage_retry_exhausted",
            });
          } catch {
            dependencies.logger.error(JSON.stringify({
              event: "profile-photo.cleanup.failure-telemetry.failed",
              jobId: claim.job_id,
            }));
          }
          dependencies.logger.error(JSON.stringify({
            event: "profile-photo.cleanup.failed",
            jobId: claim.job_id,
          }));
        }
      }
      const health = await rpc(admin, "profile_photo_cleanup_health");
      dependencies.logger.info(JSON.stringify({
        event: "profile-photo.cleanup.processed",
        counts,
        health,
      }));
      return response({ status: "processed", counts, health });
    } catch {
      dependencies.logger.error(JSON.stringify({
        event: "profile-photo.cleanup.worker-failed",
      }));
      return response(
        { error: "Unable to process profile-photo cleanup." },
        500,
      );
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
